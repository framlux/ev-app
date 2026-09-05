import { SAMPLE_COLUMNS, type VehicleSample } from '@ev/core'
import type { DbClient } from './types.js'

/**
 * The insert, built once at module load from @ev/core's column catalogue rather
 * than written out.
 *
 * WHY GENERATED. Two hundred columns, their placeholders and their bindings all
 * have to stay in the same order, and a hand-written list of three parallel
 * sequences is one rebase away from binding `inside_temp_c` to the outside
 * temperature — a mistake nothing would report, because both are REAL and both
 * accept the value. Deriving all three from one array makes the order
 * unstatable-wrongly rather than merely checked.
 *
 * It is also the third leg of §3.1's agreement: the pushed config asks the car
 * for what the field catalogue names, the normaliser fills the columns the
 * column catalogue declares, and this writes exactly those columns. A signal
 * added to the catalogue is stored without anyone remembering to come here.
 *
 * Exported so the drift test can read it. It is one statement — no semicolon,
 * no second INSERT — because `pipeline.ts` runs it inside the per-message
 * transaction and a value the schema rejects must fail that one statement, not
 * leave half a sample behind.
 */
const BOUND_COLUMNS = ['vehicle_id', 'ts', ...SAMPLE_COLUMNS.map((c) => c.column)]

const HEAD =
  `INSERT INTO sample (${BOUND_COLUMNS.join(', ')})\n` +
  `VALUES (${BOUND_COLUMNS.map((_, i) => `$${i + 1}`).join(',')})\n`

export const SAMPLE_INSERT_SQL = HEAD + 'ON CONFLICT (vehicle_id, ts) DO NOTHING'

/**
 * The same insert, but writing onto a row that already exists. `reprocess`
 * only — see `upsertSample`.
 *
 * COALESCE, not a plain `EXCLUDED.<col>` assignment, and that is the whole of
 * what distinguishes it from the insert: the replayed value wins only when
 * there IS one. A replay starting mid-history begins with a cold accumulator,
 * so its first samples know strictly less than the rows already on disk, and
 * assigning EXCLUDED outright would blank real values with the nulls of a
 * warm-up — silently, since a null column is indistinguishable from a signal
 * the car never sent. Neither key column is assigned: `ts` is the partition
 * key, and updating either would make the conflict target a lie.
 */
export const SAMPLE_UPSERT_SQL =
  HEAD +
  'ON CONFLICT (vehicle_id, ts) DO UPDATE SET\n' +
  SAMPLE_COLUMNS
    .map((c) => `  ${c.column} = COALESCE(EXCLUDED.${c.column}, sample.${c.column})`)
    .join(',\n')

/**
 * ON CONFLICT DO NOTHING makes replay idempotent: the primary key is
 * (vehicle_id, ts), so reprocessing the same raw tape cannot duplicate rows.
 *
 * DO NOTHING rather than an upsert on purpose. Two records with the same
 * timestamp are the same observation redelivered, and the first write already
 * holds it; an upsert would let a later, sparser redelivery of the same instant
 * overwrite populated columns with nulls.
 *
 * This is the LIVE path and it does not change. MQTT redelivers until it is
 * acked, and "the second delivery writes nothing" is what makes acking after
 * COMMIT safe. The backfill's need to write existing rows is answered by a
 * separate statement below, not by relaxing this one.
 */
export async function insertSample(c: DbClient, s: VehicleSample): Promise<void> {
  await c.query(SAMPLE_INSERT_SQL, bindingsFor(s))
}

/**
 * Write a replayed sample onto a row that may already exist (spec §4's last
 * row, §6 step 4).
 *
 * `gear` and `charge_amps` have been on the tape since day one and had no
 * column to go to, so the rows they belong on were written long before those
 * columns existed. `reprocess` rebuilds the derived tables from the tape, and
 * under DO NOTHING every one of those writes would be discarded without a word
 * — the backfill would report success and change nothing.
 *
 * `reprocess` ONLY. It is safe there for a reason that does not hold live: a
 * replay is an authoritative rebuild of a window, run deliberately, whereas a
 * live redelivery is the same observation arriving twice and the row we already
 * have is the better copy of it.
 */
export async function upsertSample(c: DbClient, s: VehicleSample): Promise<void> {
  await c.query(SAMPLE_UPSERT_SQL, bindingsFor(s))
}

/** Shared so the two statements cannot bind the same catalogue differently. */
function bindingsFor(s: VehicleSample): unknown[] {
  const row = s as unknown as Record<string, unknown>
  return [
    s.vehicleId,
    s.ts,
    // JSONB is the one type that is not already what pg wants to bind: the
    // driver would stringify a plain object for us, but doing it here keeps the
    // binding a function of the catalogue's declared SQL type rather than of
    // what the value happens to look like at runtime.
    ...SAMPLE_COLUMNS.map((col) => {
      const v = row[col.key]
      return col.sql === 'JSONB' && v != null ? JSON.stringify(v) : v
    }),
  ]
}

/**
 * `sample` and `raw_message` are range-partitioned by month, and an INSERT for
 * a month with no partition fails outright ("no partition of relation ... found
 * for row"). The migration pre-creates this month and the next; a worker that
 * outlives that window, or a reprocess run over older data, must create its own.
 */
export async function ensurePartitions(c: DbClient, when: Date): Promise<void> {
  await c.query('SELECT ensure_month_partitions($1::date)', [when])
}
