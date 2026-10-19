/**
 * Rebuild the derived tables from the tape.
 *
 *   node dist/reprocess.js --from 2026-09-01 --to 2026-10-01
 *
 * This is the payoff of keeping `raw_message`: a segmenter change is a rerun,
 * not a loss. Everything happens in ONE transaction — the delete and the whole
 * replay — so an interrupted run leaves the old derived rows intact rather than
 * a half-rebuilt history that looks real.
 */
import { pathToFileURL } from 'node:url'
import {
  closePool,
  deleteDerived,
  ensurePartitions,
  findOpenSessions,
  getPool,
  streamRaw,
  withTransaction,
  type DbClient,
  type OpenSessionRow,
} from '@ev/db'
import { loadConfig, type Config } from './config.js'
import { profileFor } from './deps.js'
import { Pipeline } from './pipeline.js'
import { replayStoreOn } from './store.js'
import { assertVehicleMatchesConfig } from './vehicle-guard.js'

export interface Window { from: Date; to: Date }

export function parseArgs(argv: string[]): Window {
  const from = valueOf(argv, '--from')
  const to = valueOf(argv, '--to')
  if (!from || !to) throw new Error('usage: reprocess --from <date> --to <date>')
  const window = { from: new Date(from), to: new Date(to) }
  if (Number.isNaN(window.from.getTime()) || Number.isNaN(window.to.getTime())) {
    throw new Error(`unparseable date in --from ${from} --to ${to}`)
  }
  // An inverted window silently deletes nothing and replays nothing, which
  // looks exactly like a successful run over a quiet period.
  if (window.to.getTime() <= window.from.getTime()) {
    throw new Error('--to must be after --from')
  }
  return window
}

/**
 * The open sessions a replay of `w` would wrongly adopt.
 *
 * The replay deletes and rebuilds the sessions that START inside its window,
 * but `openSession` adopts whatever row of that kind is already open, so one
 * left open outside the window swallows the first rebuilt session of its kind.
 * A Sep 12 charge was once written onto a Sep 26 row exactly this way.
 */
export function openOutsideWindow(open: OpenSessionRow[], w: Window): OpenSessionRow[] {
  return open.filter((s) =>
    s.startedAt.getTime() < w.from.getTime() || s.startedAt.getTime() >= w.to.getTime())
}

function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

/** What a replay needs of the worker's configuration: the car, its vendor and how it prices. */
export type ReplayConfig =
  Pick<Config, 'vendor' | 'vehicle' | 'cursorSource' | 'usableCapacityKwh' | 'home'>

/**
 * Delete and rebuild one vehicle's derived rows over `w`, on `client`, and
 * return how many taped messages were replayed. The caller owns the
 * transaction: it is what makes an interrupted run leave the old rows intact.
 */
export async function replayWindow(
  client: DbClient,
  config: ReplayConfig,
  w: Window,
): Promise<number> {
  const { from, to } = w
  // FIRST, before anything is read or deleted. `deleteDerived` below clears this
  // vehicle's rows in the window and the replay decodes the tape with this
  // vendor's profile, so run under the wrong EV_VENDOR (or the wrong
  // EV_VEHICLE_ID) it would erase one car's history and rebuild nothing, or
  // rebuild it from another vendor's decoder. A row that disagrees with the
  // configuration stops the run here; no row at all is fine, there is nothing
  // for a mismatch to damage.
  await assertVehicleMatchesConfig(client, config)
  const adoptable = openOutsideWindow(await findOpenSessions(client, config.vehicle.id), w)
  if (adoptable.length > 0) {
    const names = adoptable.map((s) => `${s.kind} ${s.id} (started ${s.startedAt.toISOString()})`)
    throw new Error(
      `open outside the window, so the replay would adopt it: ${names.join(', ')}. ` +
        'Widen the window to cover it.')
  }
  await ensurePartitions(client, from)
  await deleteDerived(client, config.vehicle.id, from, to)

  // One client, so every write joins the enclosing transaction rather than
  // committing message by message.
  //
  // `replayStoreOn`, not `storeOn`: a replay must be able to write onto a
  // sample row that already exists, and the live path's insert does nothing
  // on conflict by design (spec §4's last row). Without it, backfilling a
  // signal we taped but never had a column for (`gear`, `charge_amps`) can
  // run to completion, print a count, and change nothing.
  //
  // `deleteDerived` above clears this vehicle's rows in the window first, so
  // the conflict is not the common case, and the replay below streams only this
  // vehicle's tape, so another vehicle's surviving rows are never replayed into
  // the DO NOTHING. The replay store is for whatever conflict is left: a
  // backfill that silently skips a row is exactly the failure it is here to
  // remove.
  const pipeline = new Pipeline(
    // The worker's own vendor: a replay decodes the tape with the same profile
    // the live worker did, or it would rebuild a different history from the
    // same messages.
    profileFor(config.vendor),
    { run: (fn) => fn(replayStoreOn(client, config.cursorSource)) },
    { usableCapacityKwh: config.usableCapacityKwh },
    // The same home the live worker prices with, and not optional here. A
    // replay re-derives every session and re-prices it through the same
    // `finish()`, so a replay without this would rewrite `cost_basis` from
    // 'home' to 'unknown' on every charge whose home-ness came from the
    // coordinate fallback rather than from Tesla's own `locatedAtHome`.
    config.home,
  )

  let count = 0
  // This vehicle's tape and no other. `deleteDerived` clears ONE vehicle's rows
  // while the tape holds every vehicle's, and the pipeline is built for one:
  // its segmenter holds a single car's sessions and its profile is a single
  // vendor's. Streaming the whole tape (as this once did, harmlessly only
  // because every vehicle was a Tesla and the table held one) would push another
  // car's messages through this car's segmenter, and another vendor's through
  // this vendor's decoder. The page size is `streamRaw`'s default.
  for await (const row of streamRaw(client, from, to, undefined, config.vehicle.id)) {
    await pipeline.handle({
      vehicleId: row.vehicleId,
      vendor: row.vendor,
      receivedAt: row.receivedAt,
      source: row.source,
      payload: row.payload,
    })
    count++
  }

  // Flush what is still accumulating, or the tail of every replay is lost.
  //
  // Emission is arrival-triggered: a pending burst is written when the NEXT
  // message shows it is complete. The final burst has no next message, so
  // without this it is discarded along with the Pipeline object - silently,
  // and only at the end of the window, which is the hardest place to notice.
  //
  // force=true because the quiet period cannot have elapsed: there is no
  // later arrival to measure it against.
  await pipeline.flush(new Date(), true)

  return count
}

async function main(): Promise<void> {
  const config = loadConfig()
  const window = parseArgs(process.argv.slice(2))
  const pool = getPool()

  const replayed = await withTransaction(pool, (client: DbClient) =>
    replayWindow(client, config, window))

  console.log(
    `reprocessed ${replayed} raw messages from ${window.from.toISOString()} to ${window.to.toISOString()}`)
  await closePool()
}

// Only run when executed directly: `parseArgs` is imported by tests, and a
// top-level main() would open a database connection just to read the flags.
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error('reprocess failed', err)
    process.exit(1)
  })
}
