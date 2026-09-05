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
  getPool,
  streamRaw,
  withTransaction,
  type DbClient,
} from '@ev/db'
import { loadConfig } from './config.js'
import { Pipeline } from './pipeline.js'
import { storeOn } from './store.js'

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

function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

async function main(): Promise<void> {
  const config = loadConfig()
  const { from, to } = parseArgs(process.argv.slice(2))
  const pool = getPool()

  const replayed = await withTransaction(pool, async (client: DbClient) => {
    await ensurePartitions(client, from)
    await deleteDerived(client, config.vehicle.id, from, to)

    // One client, so every write joins the enclosing transaction rather than
    // committing message by message.
    const pipeline = new Pipeline(
      { run: (fn) => fn(storeOn(client, config.cursorSource)) },
      { usableCapacityKwh: config.usableCapacityKwh },
    )

    let count = 0
    for await (const row of streamRaw(client, from, to)) {
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
  })

  console.log(`reprocessed ${replayed} raw messages from ${from.toISOString()} to ${to.toISOString()}`)
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
