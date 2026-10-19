import { describe, expect, it } from 'vitest'
import type { RawRow } from '@ev/db'
import { dumpRows, parseDumpArgs } from '../src/parallax-dump.js'

const RVM = 'charging.session.notification'
const VIN = 'VIN1'

/** [field 1, varint 150]: the smallest payload that proves the tree reached the line. */
const BYTES = [0x08, 0x96, 0x01]
const base64 = (bytes: readonly number[]) => Buffer.from(bytes).toString('base64')

/** A tape row holding a v1 envelope, as `streamRaw` yields it. */
function row(receivedAt: string, envelope: unknown): RawRow {
  return {
    id: receivedAt,
    vehicleId: 'r2',
    vendor: 'rivian',
    source: 'graphql_ws',
    receivedAt: new Date(receivedAt),
    payload: envelope,
  }
}

function parallaxRow(receivedAt: string, rvm: string, payload: unknown): RawRow {
  return row(receivedAt, {
    v: 1,
    stream: 'parallax',
    vin: VIN,
    receivedAt,
    body: { data: { parallaxMessages: { rvm, payload, timestamp: receivedAt } } },
  })
}

async function* tape(rows: readonly RawRow[]): AsyncGenerator<RawRow> {
  for (const r of rows) yield r
}

async function dump(rows: readonly RawRow[], opts: { rvm: string; limit?: number | null }) {
  const lines: string[] = []
  const written = await dumpRows(tape(rows), opts, (line) => lines.push(line))
  return { written, lines }
}

describe('parseDumpArgs', () => {
  it('reads --rvm and --limit, leaving the window open', () => {
    expect(parseDumpArgs(['--rvm', RVM, '--limit', '5'])).toEqual({
      rvm: RVM, from: null, to: null, limit: 5,
    })
  })

  it('reads --from and --to as dates', () => {
    const args = parseDumpArgs(['--rvm', RVM, '--from', '2026-10-01', '--to', '2026-10-02'])
    expect(args.from).toEqual(new Date('2026-10-01'))
    expect(args.to).toEqual(new Date('2026-10-02'))
    expect(args.limit).toBeNull()
  })

  it('is a usage error without --rvm, or with nothing after it', () => {
    expect(() => parseDumpArgs([])).toThrow(/usage: parallax-dump --rvm/)
    expect(() => parseDumpArgs(['--limit', '5'])).toThrow(/usage/)
    expect(() => parseDumpArgs(['--rvm'])).toThrow(/usage/)
    // The next flag is not a topic name.
    expect(() => parseDumpArgs(['--rvm', '--limit', '5'])).toThrow(/usage/)
  })

  it('refuses a limit that is not a positive whole number', () => {
    for (const bad of ['0', '-1', '2.5', 'many', '']) {
      expect(() => parseDumpArgs(['--rvm', RVM, '--limit', bad])).toThrow(/--limit/)
    }
  })

  it('refuses an unparseable or inverted window', () => {
    expect(() => parseDumpArgs(['--rvm', RVM, '--from', 'yesterday'])).toThrow(/--from/)
    expect(() => parseDumpArgs(['--rvm', RVM, '--to', 'tomorrow'])).toThrow(/--to/)
    expect(() => parseDumpArgs(['--rvm', RVM, '--from', '2026-10-02', '--to', '2026-10-01']))
      .toThrow(/--to must be after --from/)
  })

  it('ignores the bare -- that pnpm passes through', () => {
    expect(parseDumpArgs(['--', '--rvm', RVM]).rvm).toBe(RVM)
  })
})

describe('dumpRows', () => {
  it('decodes only the rows whose topic matches, one JSON line each', async () => {
    const { written, lines } = await dump(
      [
        parallaxRow('2026-10-19T10:00:00.000Z', RVM, base64(BYTES)),
        parallaxRow('2026-10-19T10:00:05.000Z', 'some.other.topic', base64([0x08, 0x01])),
      ],
      { rvm: RVM },
    )
    expect(written).toBe(1)
    expect(lines).toEqual([
      '{"receivedAt":"2026-10-19T10:00:00.000Z","rvm":"charging.session.notification",' +
        '"tree":[{"field":1,"wire":"varint","value":"150"}]}',
    ])
  })

  it('skips every row that is not a parallax envelope', async () => {
    const { written, lines } = await dump(
      [
        // Another stream, carrying the same sort of body.
        row('2026-10-19T10:00:00.000Z', {
          v: 1, stream: 'state', vin: VIN, receivedAt: '2026-10-19T10:00:00.000Z',
          body: { data: { parallaxMessages: { rvm: RVM, payload: base64(BYTES) } } },
        }),
        // Not an envelope at all: an unknown version, and a bare null.
        row('2026-10-19T10:00:01.000Z', {
          v: 2, stream: 'parallax', vin: VIN, receivedAt: '2026-10-19T10:00:01.000Z',
          body: { data: { parallaxMessages: { rvm: RVM, payload: base64(BYTES) } } },
        }),
        row('2026-10-19T10:00:02.000Z', null),
        // A parallax frame with no message in it (an errors-only frame).
        row('2026-10-19T10:00:03.000Z', {
          v: 1, stream: 'parallax', vin: VIN, receivedAt: '2026-10-19T10:00:03.000Z',
          body: { errors: [{ message: 'boom' }] },
        }),
      ],
      { rvm: RVM },
    )
    expect(written).toBe(0)
    expect(lines).toEqual([])
  })

  it('says so, with a null tree, when the payload is not a protobuf message', async () => {
    const { written, lines } = await dump(
      [
        // 0x0a 0x05 promises five bytes and supplies one.
        parallaxRow('2026-10-19T10:00:00.000Z', RVM, base64([0x0a, 0x05, 0x01])),
        // No payload to decode at all.
        parallaxRow('2026-10-19T10:00:01.000Z', RVM, null),
      ],
      { rvm: RVM },
    )
    expect(written).toBe(2)
    expect(lines.map((l) => (JSON.parse(l) as { tree: unknown }).tree)).toEqual([null, null])
  })

  it('stops reading at the limit, without pulling another row', async () => {
    let pulled = 0
    async function* counted(): AsyncGenerator<RawRow> {
      for (const at of ['10:00:00', '10:00:01', '10:00:02', '10:00:03']) {
        pulled++
        yield parallaxRow(`2026-10-19T${at}.000Z`, RVM, base64(BYTES))
      }
    }
    const lines: string[] = []
    const written = await dumpRows(counted(), { rvm: RVM, limit: 2 }, (l) => lines.push(l))
    expect(written).toBe(2)
    expect(lines).toHaveLength(2)
    expect(pulled).toBe(2)
  })

  it('writes nothing for an empty tape', async () => {
    expect(await dump([], { rvm: RVM })).toEqual({ written: 0, lines: [] })
  })
})
