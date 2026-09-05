import type { DbClient } from './types.js'

/**
 * The cached telemetry status (spec §3.7), as the settings page reads it.
 *
 * Every observed field is nullable because the row can be created by either
 * half of the flow — see the comment on the NULLs in
 * `migrations/006_telemetry_status.sql`. A caller that renders `false` where
 * the column is NULL is claiming the car answered when it never did.
 */
export interface TelemetryStatus {
  vehicleId: string
  synced: boolean | null
  fieldCount: number | null
  caPresent: boolean | null
  firmware: string | null
  keyPaired: boolean | null
  streamingEnabled: boolean | null
  checkedAt: Date | null
  pushedAt: Date | null
}

/**
 * What one check observed.
 *
 * Every field is REQUIRED here even though the columns are nullable: a check
 * that could not determine the firmware passes `null` explicitly and says so,
 * rather than omitting the key and silently leaving whatever the last check
 * happened to see. The distinction matters because this is an upsert — an
 * omitted field would read as "unchanged", which is a claim about the car that
 * this check did not make.
 *
 * `synced` alone is non-null: a check that got an answer out of Tesla always
 * has one, and a check that did not is not a check and must not be recorded.
 */
export interface TelemetryCheck {
  vehicleId: string
  synced: boolean
  /** Fields in the config the car has applied; null before it has applied one. */
  fieldCount: number | null
  /** §3.6 compares the CA on presence, so presence is all that is stored. */
  caPresent: boolean | null
  firmware: string | null
  keyPaired: boolean | null
  streamingEnabled: boolean | null
  checkedAt: Date
}

/**
 * The last known status, or null on day one.
 *
 * NULL rather than a zero-valued row, because "never checked" and "checked and
 * the car said no" are different sentences and the page prints both. A vehicle
 * row exists from the moment ingestion starts (`ensureVehicle`), which is long
 * before anyone opens the settings page, so the absent case is not an edge —
 * it is what every deployment looks like until someone consents to Tesla.
 *
 * Takes a `DbClient` like every other repository function, so the web app
 * reaches it through `withTransaction(getPool(), …)`. One statement in a
 * transaction is a shade more ceremony than it needs, but a second convention
 * for who may call a repository is worse than a BEGIN.
 */
export async function readTelemetryStatus(
  c: DbClient, vehicleId: string,
): Promise<TelemetryStatus | null> {
  const { rows } = await c.query(
    `SELECT synced, field_count, ca_present, firmware, key_paired,
            streaming_enabled, checked_at, pushed_at
       FROM telemetry_status WHERE vehicle_id=$1`,
    [vehicleId])
  const r = rows[0]
  if (!r) return null
  return {
    vehicleId,
    synced: r.synced,
    fieldCount: r.field_count,
    caPresent: r.ca_present,
    firmware: r.firmware,
    keyPaired: r.key_paired,
    streamingEnabled: r.streaming_enabled,
    checkedAt: r.checked_at,
    pushedAt: r.pushed_at,
  }
}

/**
 * Record what a check saw, leaving `pushed_at` alone.
 *
 * The omission is the point: a check that overwrote `pushed_at` — or reset it
 * to NULL, which an unqualified upsert of the whole row would do — would erase
 * the one fact that explains a `synced: false`. "We pushed twenty minutes ago
 * and the car has not applied it yet" is the normal case (§5); "we have never
 * pushed" is a call to action. The page distinguishes them by `pushed_at`, so
 * the writer that knows nothing about pushes must not touch it.
 *
 * A plain assignment otherwise, with no guard on `checked_at` moving forwards:
 * unlike the ingest cursor there is no redelivery here. Every write is a fresh
 * observation made by an operator who just pressed a button, and the newest
 * one is the truth by construction.
 */
export async function recordTelemetryCheck(
  c: DbClient, r: TelemetryCheck,
): Promise<void> {
  await c.query(
    `INSERT INTO telemetry_status (
       vehicle_id, synced, field_count, ca_present, firmware, key_paired,
       streaming_enabled, checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (vehicle_id) DO UPDATE SET
       synced            = EXCLUDED.synced,
       field_count       = EXCLUDED.field_count,
       ca_present        = EXCLUDED.ca_present,
       firmware          = EXCLUDED.firmware,
       key_paired        = EXCLUDED.key_paired,
       streaming_enabled = EXCLUDED.streaming_enabled,
       checked_at        = EXCLUDED.checked_at`,
    [r.vehicleId, r.synced, r.fieldCount, r.caPresent, r.firmware,
      r.keyPaired, r.streamingEnabled, r.checkedAt],
  )
}

/**
 * Record that a configuration was pushed, and nothing else.
 *
 * A SEPARATE FUNCTION rather than an optional `pushedAt` on `TelemetryCheck`,
 * for the same reason `recordMeasuredCapacity` is separate from
 * `upsertBatteryHealth`: the two writers hold disjoint facts, and one function
 * taking both would have to decide what an absent half means — with "leave it"
 * and "clear it" both plausible and only one of them right.
 *
 * A push knows nothing about what the car has applied. It cannot: Tesla accepts
 * the configuration and applies it whenever the car next checks in, which can
 * be hours (§5). So this inserts NULLs for the observed columns on day one and
 * leaves them untouched afterwards, and the next check fills them in.
 *
 * It writes `pushed_at` unconditionally, including backwards. Nothing here
 * replays, and a second push is a second push whatever the clock did.
 */
export async function recordTelemetryPush(
  c: DbClient, vehicleId: string, pushedAt: Date,
): Promise<void> {
  await c.query(
    `INSERT INTO telemetry_status (vehicle_id, pushed_at)
     VALUES ($1,$2)
     ON CONFLICT (vehicle_id) DO UPDATE SET pushed_at = EXCLUDED.pushed_at`,
    [vehicleId, pushedAt],
  )
}
