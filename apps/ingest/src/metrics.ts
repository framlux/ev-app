import { createServer, type Server } from 'node:http'
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client'

/**
 * Instrumentation for the failure this worker exists to prevent: not crashing,
 * but quietly stopping. A crash restarts loudly; ingestion that stalls while
 * the car is awake is invisible, and every minute of it is history that cannot
 * be fetched from Tesla afterwards.
 */
export const registry = new Registry()
collectDefaultMetrics({ register: registry })

export const messagesTotal = new Counter({
  name: 'ev_ingest_messages_total',
  help: 'MQTT messages consumed, by vendor and record type.',
  labelNames: ['vendor', 'record'] as const,
  registers: [registry],
})

export const samplesWrittenTotal = new Counter({
  name: 'ev_ingest_samples_written_total',
  help: 'Normalised samples handed to the database.',
  labelNames: ['vendor'] as const,
  registers: [registry],
})

export const sessionsOpenedTotal = new Counter({
  name: 'ev_ingest_sessions_opened_total',
  help: 'Sessions opened by the segmenter.',
  registers: [registry],
})

export const sessionsClosedTotal = new Counter({
  name: 'ev_ingest_sessions_closed_total',
  help: 'Sessions closed and summarised.',
  registers: [registry],
})

/**
 * The gauge the EvIngestStalled alert reads. Seconds, not milliseconds: the
 * rule is `time() - max by (vehicle) (...)`, and time() is a UNIX second count.
 */
export const lastSampleTimestampSeconds = new Gauge({
  name: 'ev_ingest_last_sample_timestamp_seconds',
  help: 'UNIX timestamp of the most recent sample written, per vehicle.',
  labelNames: ['vehicle'] as const,
  registers: [registry],
})

export const mqttConnected = new Gauge({
  name: 'ev_ingest_mqtt_connected',
  help: 'Whether the MQTT client currently holds a connection (1) or not (0).',
  registers: [registry],
})

/**
 * Payloads that could not be turned into a message at all — bad JSON, a topic
 * that does not name a vehicle we know. Counted and dropped, never retried: a
 * poison message that is never acked is redelivered forever and blocks the
 * durable session behind it.
 */
export const parseFailuresTotal = new Counter({
  name: 'ev_ingest_parse_failures_total',
  help: 'Payloads discarded because they could not be parsed or attributed.',
  labelNames: ['reason'] as const,
  registers: [registry],
})

/** Messages whose handling threw. These are NOT acked and will be redelivered. */
export const handlerErrorsTotal = new Counter({
  name: 'ev_ingest_handler_errors_total',
  help: 'Message handler failures; the message is left unacknowledged.',
  registers: [registry],
})

/**
 * Create every labelled series at startup, before any message arrives.
 *
 * WHY THIS EXISTS. A Prometheus series does not exist until it is first written,
 * and `ev_ingest_last_sample_timestamp_seconds` carries a `vehicle` label, so
 * before the first successful sample it is an EMPTY VECTOR. The EvIngestStalled
 * rule is `time() - max by (vehicle) (ev_ingest_last_sample_timestamp_seconds)`,
 * and that expression over an empty vector yields no samples at all, so the rule
 * never fires. The worker that restarts and then ingests NOTHING - the exact
 * failure the alert was written to catch - is the one case the alert was blind
 * to.
 *
 * Initialising the gauge to 0 is not a lie: 0 is 1970, which reads as "no sample
 * ever", and `time() - 0` is enormous, so the alert fires immediately on a
 * worker that starts and stays silent. The counters are seeded for the same
 * reason: `rate()` and `increase()` over an absent series return nothing, so an
 * unseeded `ev_ingest_parse_failures_total` cannot be alerted on either.
 *
 * Call once, at startup, from the worker entrypoint.
 */
export function initialiseSeries(vehicleId: string, vendor = 'tesla'): void {
  lastSampleTimestampSeconds.set({ vehicle: vehicleId }, 0)
  mqttConnected.set(0)
  samplesWrittenTotal.inc({ vendor }, 0)
  sessionsOpenedTotal.inc(0)
  sessionsClosedTotal.inc(0)
  handlerErrorsTotal.inc(0)
  for (const record of RECORD_KINDS) messagesTotal.inc({ vendor, record }, 0)
  for (const reason of PARSE_FAILURE_REASONS) parseFailuresTotal.inc({ reason }, 0)
}

/** Every value `MqttHooks.onRecord` can report. Kept here so the series exist. */
const RECORD_KINDS = ['metrics', 'alert', 'error', 'connectivity'] as const

/** Every value `MqttHooks.onParseFailure` can report. */
const PARSE_FAILURE_REASONS = ['topic', 'json', 'empty', 'unknown-vehicle'] as const

export function startMetricsServer(port: number): Server {
  const server = createServer((req, res) => {
    if (req.url === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': registry.contentType })
          res.end(body)
        })
        .catch(() => {
          res.writeHead(500)
          res.end()
        })
      return
    }
    // Anything else is the kubelet's probe. 200 while the process is up is the
    // honest answer: liveness here means "the event loop still turns"; whether
    // data is flowing is what the staleness alert is for, and failing a probe
    // on a quiet, sleeping car would restart the worker for no reason.
    res.writeHead(req.url === '/healthz' ? 200 : 404)
    res.end()
  })
  server.listen(port)
  return server
}
