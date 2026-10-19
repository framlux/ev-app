/**
 * Read the taped Parallax messages of one topic as protobuf trees.
 *
 *   node dist/parallax-dump.js --rvm charging.session.notification --limit 20
 *   pnpm --filter @ev/ingest parallax-dump -- --rvm <topic> [--from <date>] [--to <date>] [--limit <n>]
 *
 * Parallax is Rivian's opaque channel: each message is a base64 protobuf for a
 * topic (`rvm`), with no published schema. Ingest does not decode it, only
 * tapes it (`state`, `charging` and `cloud` are the streams it reads), so what
 * is in it is a question the tape has to answer. This is how to ask: it walks
 * the taped rows for the configured vehicle, keeps the parallax envelopes whose
 * topic matches, and prints one JSON line each (`receivedAt`, `rvm`, `tree`),
 * the tree being `decodeWire`'s schema-less reading of the bytes. Which field
 * number is the charge power, and in what unit, is then a matter of diffing
 * lines across a charge, and decides which topics earn a proper decoder
 * (spec §9, §8.4).
 *
 * READ-ONLY. It issues the same SELECT `reprocess` streams the tape with, opens
 * no transaction, and writes nothing, so it is safe to run in the ingest pod
 * beside the live worker.
 */
import { pathToFileURL } from 'node:url'
import { closePool, getPool, streamRaw, type RawRow } from '@ev/db'
import { decodeWire, readRivianEnvelope, type WireNode } from '@ev/rivian'
import { loadConfig } from './config.js'

export interface DumpArgs {
  rvm: string
  /** Inclusive; null is the start of the tape. */
  from: Date | null
  /** Exclusive, as `streamRaw`'s is; null is the end of the tape. */
  to: Date | null
  /** Stop after this many lines; null reads on to the end of the window. */
  limit: number | null
}

const USAGE = 'usage: parallax-dump --rvm <topic> [--from <date>] [--to <date>] [--limit <n>]'

/**
 * A command line that cannot be run, as opposed to a run that failed.
 *
 * Its message is the whole of what should be printed: the usage line, with the
 * reason above it. It is its own type so that `reportFailure` can print that
 * and exit, where an unexpected error (a database that is down) still gets
 * logged with its stack: a stack trace under a mistyped flag reads as a bug in
 * the tool and sends the operator looking in the wrong place.
 */
export class UsageError extends Error {
  constructor(reason?: string) {
    super(reason === undefined ? USAGE : `${reason}\n${USAGE}`)
    this.name = 'UsageError'
  }
}

const FLAGS: ReadonlySet<string> = new Set(['--rvm', '--from', '--to', '--limit'])

/**
 * Every flag's value, refusing anything else on the command line.
 *
 * Each token is a known flag followed by its value, or a bare `--` (pnpm passes
 * the one in `pnpm parallax-dump -- --rvm x` through to the script). Anything
 * else is an error and not something to skip: `--limit=5` read as an unknown
 * word would be dropped, the limit left off, and a command meant to read five
 * rows would stream the whole tape. A flag with nothing after it, or with
 * another flag after it, is the same mistake (`--from` as the last word would
 * otherwise read as "no lower bound"), and so is a flag given twice, where the
 * one that wins is a guess.
 */
function flagValues(argv: string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') continue
    if (!FLAGS.has(arg)) throw new UsageError(`unknown argument ${JSON.stringify(arg)}`)
    if (values.has(arg)) throw new UsageError(`${arg} given more than once`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    values.set(arg, value)
    i++
  }
  return values
}

function dateOf(values: Map<string, string>, flag: string): Date | null {
  const raw = values.get(flag)
  if (raw === undefined) return null
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) throw new UsageError(`unparseable date in ${flag} ${raw}`)
  return date
}

export function parseDumpArgs(argv: string[]): DumpArgs {
  const values = flagValues(argv)
  const rvm = values.get('--rvm')
  if (rvm === undefined || rvm === '') throw new UsageError()

  const from = dateOf(values, '--from')
  const to = dateOf(values, '--to')
  // As in `reprocess`: an inverted window reads nothing, which looks exactly
  // like a topic that was never taped.
  if (from !== null && to !== null && to.getTime() <= from.getTime()) {
    throw new UsageError('--to must be after --from')
  }

  let limit: number | null = null
  const rawLimit = values.get('--limit')
  if (rawLimit !== undefined) {
    // Digits only, and not zero: `Number('')` is 0 and `Number('2.5')` is not a
    // count, and a limit that reads as "stop at once" is a silent empty run.
    if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit))) {
      throw new UsageError(`--limit must be a positive whole number, got ${JSON.stringify(rawLimit)}`)
    }
    limit = Number(rawLimit)
  }
  return { rvm, from, to, limit }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/**
 * The `{rvm, payload}` of a taped row, or null if the row is not a parallax
 * frame with a message in it.
 *
 * `readRivianEnvelope` is what says it is a parallax envelope: another stream's
 * frame, an unknown version and a payload that is not an envelope at all are
 * all null, and the dump skips them. So does a parallax frame with no message
 * (an errors-only body), since there is no topic to match it against.
 */
function parallaxMessageOf(payload: unknown): { rvm: string; payload: unknown } | null {
  const envelope = readRivianEnvelope(payload)
  if (envelope?.stream !== 'parallax') return null
  const message = asRecord(asRecord(asRecord(envelope.body)?.['data'])?.['parallaxMessages'])
  const rvm = message?.['rvm']
  return message !== null && typeof rvm === 'string' ? { rvm, payload: message['payload'] } : null
}

/**
 * The tree for a message's base64 payload, or null if there is nothing to read.
 *
 * Null is printed, not skipped: a line saying "this frame was taped and is not
 * a protobuf message" (a truncated payload, a missing one) is exactly the
 * finding a reader of the tape is after, and dropping it would make the topic
 * look quieter than it is. `Buffer`'s base64 reader is deliberately forgiving
 * about characters outside the alphabet, which is the right amount of care for
 * a tool that looks at the tape rather than vouches for it.
 */
function treeOf(payload: unknown): WireNode[] | null {
  return typeof payload === 'string' ? decodeWire(Buffer.from(payload, 'base64')) : null
}

/**
 * Write one line per matching row, and return how many were written.
 *
 * `rows` is consumed lazily and the loop stops at the limit WITHOUT pulling
 * another, so `--limit 5` over a year of tape reads one page of it, and breaking
 * out of the `for await` is what closes the underlying cursor. The limit counts
 * lines written, not rows seen: most of the tape is other streams.
 */
export async function dumpRows(
  rows: AsyncIterable<RawRow>,
  opts: { rvm: string; limit?: number | null },
  write: (line: string) => void,
): Promise<number> {
  const limit = opts.limit ?? null
  if (limit !== null && limit < 1) return 0
  let written = 0
  for await (const row of rows) {
    const message = parallaxMessageOf(row.payload)
    if (message === null || message.rvm !== opts.rvm) continue
    write(JSON.stringify({
      receivedAt: row.receivedAt,
      rvm: message.rvm,
      tree: treeOf(message.payload),
    }))
    written++
    if (limit !== null && written >= limit) break
  }
  return written
}

/** "The whole tape": before any row could exist, and past any that will. `to` is exclusive. */
const TAPE_START = new Date(0)
const TAPE_END = new Date('9999-12-31T23:59:59.999Z')

async function main(): Promise<void> {
  const args = parseDumpArgs(process.argv.slice(2))
  const config = loadConfig()
  if (config.vendor !== 'rivian') {
    // A Tesla tape has no parallax rows, so this would print nothing and look
    // like a topic that was never taped.
    console.error(`parallax-dump reads a Rivian tape, and this worker's EV_VENDOR is '${config.vendor}'`)
    process.exit(1)
  }

  const pool = getPool()
  const client = await pool.connect()
  try {
    // This vehicle's rows and no other's, as the replay narrows its stream.
    const tape = streamRaw(
      client, args.from ?? TAPE_START, args.to ?? TAPE_END, undefined, config.vehicle.id)
    await dumpRows(tape, args, (line) => console.log(line))
  } finally {
    client.release()
    await closePool()
  }
}

/**
 * Say why a run ended badly, and return the exit code.
 *
 * A usage error prints its message alone and exits 2, the conventional code for
 * a command line that could not be run. Anything else is unexpected and keeps
 * the logging `reprocess` gives it, the error and its stack, with exit 1.
 */
export function reportFailure(err: unknown, log: (...args: unknown[]) => void): number {
  if (err instanceof UsageError) {
    log(err.message)
    return 2
  }
  log('parallax-dump failed', err)
  return 1
}

// Only run when executed directly: `parseDumpArgs` and `dumpRows` are imported by
// tests, and a top-level main() would open a database connection just to read
// the flags.
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.exit(reportFailure(err, console.error))
  })
}
