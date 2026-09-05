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

export const SAMPLE_INSERT_SQL =
  `INSERT INTO sample (${BOUND_COLUMNS.join(', ')})\n` +
  `VALUES (${BOUND_COLUMNS.map((_, i) => `$${i + 1}`).join(',')})\n` +
  'ON CONFLICT (vehicle_id, ts) DO NOTHING'

/**
 * ON CONFLICT DO NOTHING makes replay idempotent: the primary key is
 * (vehicle_id, ts), so reprocessing the same raw tape cannot duplicate rows.
 *
 * DO NOTHING rather than an upsert on purpose. Two records with the same
 * timestamp are the same observation redelivered, and the first write already
 * holds it; an upsert would let a later, sparser redelivery of the same instant
 * overwrite populated columns with nulls.
 */
export async function insertSample(c: DbClient, s: VehicleSample): Promise<void> {
  const row = s as unknown as Record<string, unknown>
  await c.query(SAMPLE_INSERT_SQL, [
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
  ])
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
