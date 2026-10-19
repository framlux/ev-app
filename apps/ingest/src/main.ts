import { closePool, getPool, type DbPool } from '@ev/db'
import { loadConfig } from './config.js'
import { profileFor } from './deps.js'
import { flushClock } from './flush-clock.js'
import {
  handlerErrorsTotal,
  initialiseSeries,
  lastSampleTimestampSeconds,
  messagesTotal,
  mqttConnected,
  parseFailuresTotal,
  samplesWrittenTotal,
  sessionsClosedTotal,
  sessionsOpenedTotal,
  startMetricsServer,
  untimedValuesTotal,
} from './metrics.js'
import { subscribe } from './mqtt.js'
import {
  Pipeline,
  QUIET_PERIOD_MS,
  type OpenRow,
  type PipelineResult,
} from './pipeline.js'
import { pgRunner, registerVehicle, resumeFromTape, resumeOrStartCold } from './store.js'
import { pgRateStore, runRateRefresh } from './urdb.js'

/**
 * The worker entrypoint.
 *
 * Three things here are load-bearing and none of them is obvious from the
 * modules they wire together.
 */

/**
 * How often to ask the pipeline whether a pending burst is now old enough.
 *
 * Emission is ARRIVAL-triggered: a burst is written when the next message shows
 * it is complete. That is deliberate (it makes a replay through `reprocess`
 * produce the same samples as the live worker), but it has a blind spot - a car
 * that goes quiet sends no next message, so the final burst before it parks
 * would sit in memory forever. This timer is the other half.
 *
 * Comfortably under QUIET_PERIOD_MS so the quiet period is what decides the
 * timing, not the polling granularity.
 */
const FLUSH_INTERVAL_MS = Math.max(250, Math.floor(QUIET_PERIOD_MS / 2))

/**
 * How often to ask OpenEI what a kilowatt-hour costs (spec §3.3).
 *
 * A SECOND timer, and coarse, because the only other one in this file fires
 * roughly once a second - it is the accumulator flush, not a scheduler. Hanging
 * this on it would call a public API of NREL's about 86,400 times a day to
 * learn a number that changes roughly once a year, which is the kind of thing
 * that gets a key revoked.
 *
 * Daily is already far more often than the source moves. The point of the
 * interval is not freshness, it is that a rate change is noticed within a day
 * of NREL publishing it rather than whenever someone next looks.
 */
const RATE_FETCH_INTERVAL_MS = 24 * 60 * 60 * 1000

async function main(): Promise<void> {
  const config = loadConfig()

  // BEFORE anything else can fail, and before the first message.
  //
  // A Prometheus gauge that is only written on the success path does not exist
  // until the first success, and an alert reading an absent series evaluates an
  // empty vector and never fires. So a worker that starts, connects and then
  // ingests nothing at all - the exact outage the stall alert exists for - would
  // be invisible to it. Initialising the series at zero makes "never" a value
  // the alert can see.
  initialiseSeries(config.vehicle.id, config.vendor)

  const metricsServer = startMetricsServer(config.metricsPort)
  const pool = getPool()

  // BEFORE subscribing. Every table the pipeline writes references
  // vehicle(id), so without this row the first message fails its foreign key,
  // is rolled back, and — never having been acked — is redelivered forever:
  // a worker that appears healthy while recording nothing at all. Failing
  // startup here instead is the honest outcome, and the pod restarts.
  await registerVehicle(pool, config.vehicle, config.vendor)

  // Also BEFORE subscribing, and after the vehicle exists: carry on the session
  // and the field values the previous worker had, rebuilt from its tape. A
  // restart used to forget both, leaving a session open across a deploy to be
  // merged into the next one (see Pipeline.resume).
  const { pipeline, report } = await resumeOrStartCold(
    () => new Pipeline(
      // EV_VENDOR picks the profile: decode, staleness, the charge refresh and
      // the sample row are all the vendor's, and everything else is shared.
      profileFor(config.vendor),
      pgRunner(pool, config.cursorSource, config.vehicle.id),
      { usableCapacityKwh: config.usableCapacityKwh },
      // Where the car lives, for the charges its own `locatedAtHome` never
      // covers. Omitting it costs nothing visible: the signal still classifies
      // most charges, and the ones it misses simply read `unknown` weeks later.
      config.home,
    ),
    (p) => resumeFromTape(pool, p, config.vehicle.id),
    (err) => console.error('resume failed; starting cold', err),
  )

  const record = (result: PipelineResult): void => {
    if (result.samples > 0) {
      samplesWrittenTotal.inc({ vendor: config.vendor }, result.samples)
    }
    // Rivian values stamped with arrival because their own timestamp was missing
    // or unparseable (spec §6.4). Always 0 for Tesla, which supplies no stamps.
    if (result.untimed > 0) untimedValuesTotal.inc(result.untimed)
    if (result.sessionsOpened > 0) sessionsOpenedTotal.inc(result.sessionsOpened)
    if (result.sessionsClosed > 0) sessionsClosedTotal.inc(result.sessionsClosed)
    if (result.lastSampleTs) {
      lastSampleTimestampSeconds.set(
        { vehicle: config.vehicle.id },
        result.lastSampleTs.getTime() / 1000,
      )
    }
  }

  if (report) {
    // Counted as a live message's result would be, so a session closed at
    // startup is not missing from the dashboards.
    record(report)
    const row = (r: OpenRow) => `${r.kind} ${r.id} from ${r.startedAt.toISOString()}`
    console.log(
      `resumed from ${report.replayed} taped messages: ` +
        (report.resumed ? `carrying on ${row(report.resumed)}` : 'nothing open') +
        (report.closed.length ? `; closed ${report.closed.map(row).join(', ')}` : '') +
        (report.abandoned.length ? `; abandoned ${report.abandoned.map(row).join(', ')}` : '') +
        (report.discarded.length ? `; discarded ${report.discarded.map(row).join(', ')}` : ''))
  }

  // The clock the flush timer judges "is this burst due?" by.
  //
  // The connector's clock, not ours, stamps a Rivian message (spec §6.2): during
  // a backlog drain every pending burst would look overdue against our wall
  // clock and be written alone. So the timer asks "is it due?" in the stamp's
  // timeline, offset by how far behind the newest message we are. For Tesla the
  // stamp IS our arrival time and the skew is ~0, so nothing changes.
  const clock = flushClock()

  const client = subscribe(
    // vehicleId/vin come from the vehicle config rather than the mqtt block:
    // the VIN is how a message is attributed, and a shared broker carrying a
    // second car is exactly what the unknown-vehicle counter exists to report.
    // The vendor picks the topic parser and the body reader.
    {
      ...config.mqtt,
      vehicleId: config.vehicle.id,
      vin: config.vehicle.vin,
      vendor: config.vendor,
    },
    async (raw) => {
      // Throwing here is what stops the ack: makeMessageHandler only calls
      // done() after this resolves, and this resolves only after the
      // transaction commits. Swallowing an error here would ack a message whose
      // rows were rolled back, and reliable_ack_sources chains the CAR's ack to
      // ours - so the vehicle would drop it from its buffer too, and it would be
      // gone for good.
      //
      // Observed BEFORE the handle, so the timer is already in this message's
      // timeline while it is being written, and not only once it has finished.
      clock.observe(raw.receivedAt)
      record(await pipeline.handle(raw))
    },
    {
      // The Tesla record kind, or the Rivian stream.
      onRecord: (record) => messagesTotal.inc({ vendor: config.vendor, record }),
      onParseFailure: (reason) => parseFailuresTotal.inc({ reason }),
      onHandlerError: () => handlerErrorsTotal.inc(),
      onConnectionChange: (connected) => mqttConnected.set(connected ? 1 : 0),
    },
  )

  const timer = setInterval(() => {
    // Fire-and-forget with an explicit catch: an unhandled rejection from a
    // timer takes the process down, and a transient database blip must not
    // restart a worker whose MQTT session is healthy.
    pipeline.flush(clock.now()).then(record, (err: unknown) => {
      handlerErrorsTotal.inc()
      console.error('flush failed', err)
    })
  }, FLUSH_INTERVAL_MS)
  // Do not hold the event loop open on the timer alone.
  timer.unref?.()

  // The rate fetch (spec §3.3), on its own timer, or not at all.
  //
  // No key, no timer: the fetch is the convenience half of this feature and the
  // manual rate is the authoritative one, so an install without a key prices
  // home charging perfectly well off whatever the owner typed in. Said once at
  // startup because the alternative - silence - is indistinguishable from a
  // timer that is running and failing.
  let rateTimer: NodeJS.Timeout | null = null
  if (config.openEiApiKey === null) {
    console.log('OPENEI_API_KEY unset: energy rates come from manual entries only')
  } else {
    rateTimer = startRateFetch(pool, config.openEiApiKey)
  }

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    console.log(`${signal} received, draining`)
    clearInterval(timer)
    // Both timers, or SIGTERM does not drain: an unref'd interval does not hold
    // the loop open by itself, but a live one still fires during the drain and
    // can start work after the pool has closed.
    if (rateTimer) clearInterval(rateTimer)
    try {
      // force=true: the quiet period cannot elapse during shutdown because no
      // further message will arrive to measure it against. Without this, a
      // planned restart drops whatever the car reported in its last two seconds
      // - reliably, on every deploy.
      record(await pipeline.flush(new Date(), true))
    } catch (err) {
      console.error('final flush failed', err)
    }
    client.end()
    metricsServer.close()
    await closePool()
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  console.log(
    `ev-ingest (${config.vendor}) listening: broker=${config.mqtt.url} topic=${config.mqtt.topic} ` +
      `client=${config.mqtt.clientId} metrics=:${config.metricsPort}`,
  )
}

/**
 * The daily rate fetch, started once and then left alone.
 *
 * Fired immediately as well as on the interval. A pod that is restarted more
 * often than once a day - a deploy, a node drain, a crash loop - would
 * otherwise never reach the first tick, and the feature would look broken in
 * exactly the environments that restart most.
 *
 * Errors are logged and dropped. An unhandled rejection out of a timer ends the
 * process, and nothing about a tariff lookup justifies dropping an MQTT session
 * that is busy recording telemetry the car will not send twice.
 */
function startRateFetch(pool: DbPool, apiKey: string): NodeJS.Timeout {
  const store = pgRateStore(pool)
  const tick = (): void => {
    void runRateRefresh(store, {
      apiKey,
      onResult: (out) => {
        // Only the day it moves. `unchanged` is 364 days out of 365 and logging
        // it would bury the one line anyone would ever want to find.
        if (out.kind === 'inserted') {
          console.log(`energy rate updated from URDB: ${out.pricePerKwh}/kWh`)
        }
        // One line a day while an override stands, because the alternative is
        // an operator watching URDB's number move on the news and nothing move
        // here, with nothing anywhere saying why.
        if (out.kind === 'overridden') {
          console.log(
            `energy rate left alone: a manual override of ${out.pricePerKwh}/kWh is in force`,
          )
        }
      },
      onError: (err) => console.error('energy rate fetch failed', err),
    })
  }
  const timer = setInterval(tick, RATE_FETCH_INTERVAL_MS)
  // Do not hold the event loop open on the timer alone.
  timer.unref?.()
  tick()
  return timer
}

main().catch((err: unknown) => {
  console.error('ev-ingest failed to start', err)
  // exit(), not exitCode: by the time startup can fail the metrics server is
  // already listening, and an open server holds the process up indefinitely.
  // The liveness probe is a TCP check on that very port, so the pod stays
  // Running and is never restarted, while ingesting nothing. That is how a node
  // reboot that beat Postgres to readiness cost six days of telemetry.
  process.exit(1)
})
