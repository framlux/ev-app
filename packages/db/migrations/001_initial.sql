-- Up Migration

CREATE TYPE vendor AS ENUM ('tesla', 'rivian');
CREATE TYPE raw_source AS ENUM ('telemetry', 'fleet_api', 'graphql_ws');
CREATE TYPE session_kind AS ENUM ('drive', 'charge', 'idle');

CREATE TABLE vehicle (
  id                TEXT PRIMARY KEY,
  vendor            vendor NOT NULL,
  vendor_vehicle_id TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  model             TEXT,
  model_year        INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor, vendor_vehicle_id)
);

-- The replay tape. Every derived table below is rebuildable from this one,
-- which is what makes the engine safe to change after data has accumulated.
-- Partitioned monthly; BRIN suits an append-only, time-ordered table and costs
-- a fraction of a btree.
CREATE TABLE raw_message (
  id          BIGINT GENERATED ALWAYS AS IDENTITY,
  vehicle_id  TEXT NOT NULL REFERENCES vehicle(id),
  received_at TIMESTAMPTZ NOT NULL,
  vendor      vendor NOT NULL,
  source      raw_source NOT NULL,
  payload     JSONB NOT NULL
) PARTITION BY RANGE (received_at);

CREATE INDEX raw_message_received_at_brin
  ON raw_message USING BRIN (received_at);

CREATE TABLE sample (
  vehicle_id              TEXT NOT NULL REFERENCES vehicle(id),
  ts                      TIMESTAMPTZ NOT NULL,
  soc_pct                 REAL,
  range_km                REAL,
  odometer_km             DOUBLE PRECISION,
  lat                     DOUBLE PRECISION,
  lon                     DOUBLE PRECISION,
  speed_kph               REAL,
  power_state             TEXT,
  charge_state            TEXT,
  charge_power_kw         REAL,
  charge_energy_added_kwh REAL,
  inside_temp_c           REAL,
  outside_temp_c          REAL,
  locked                  BOOLEAN,
  doors_open              BOOLEAN,
  tpms                    JSONB,
  PRIMARY KEY (vehicle_id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX sample_ts_brin ON sample USING BRIN (ts);

CREATE TABLE session (
  id                  TEXT PRIMARY KEY,
  vehicle_id          TEXT NOT NULL REFERENCES vehicle(id),
  kind                session_kind NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  start_odometer_km   DOUBLE PRECISION,
  end_odometer_km     DOUBLE PRECISION,
  start_soc_pct       REAL,
  end_soc_pct         REAL,
  energy_kwh          REAL,
  distance_km         DOUBLE PRECISION,
  efficiency_wh_per_km REAL,
  avg_speed_kph       REAL,
  max_charge_power_kw REAL,
  start_lat           DOUBLE PRECISION,
  start_lon           DOUBLE PRECISION,
  end_lat             DOUBLE PRECISION,
  end_lon             DOUBLE PRECISION,
  is_open             BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX session_vehicle_started ON session (vehicle_id, kind, started_at DESC);
-- At most one open session per vehicle per kind. This is what makes restart
-- recovery deterministic rather than a source of duplicates.
CREATE UNIQUE INDEX session_one_open_per_kind
  ON session (vehicle_id, kind) WHERE is_open;

CREATE TABLE session_point (
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ NOT NULL,
  lat        DOUBLE PRECISION,
  lon        DOUBLE PRECISION,
  soc_pct    REAL,
  speed_kph  REAL,
  power_kw   REAL,
  PRIMARY KEY (session_id, ts)
);

CREATE TABLE battery_health_sample (
  vehicle_id             TEXT NOT NULL REFERENCES vehicle(id),
  observed_on            DATE NOT NULL,
  estimated_capacity_kwh REAL NOT NULL,
  rated_range_at_100_km  REAL,
  sample_confidence      REAL NOT NULL,
  PRIMARY KEY (vehicle_id, observed_on)
);

-- Not written by anything in this plan. Tesla ingestion gets its at-least-once
-- guarantee from the MQTT durable session plus ON CONFLICT DO NOTHING on
-- (vehicle_id, ts), so no cursor is needed. It exists for the Rivian adapter,
-- whose GraphQL websocket has no broker behind it and must therefore remember
-- where it got to itself. Created now because adding a table to a live
-- migration chain later is more disruptive than an unused one.
CREATE TABLE ingest_cursor (
  source            TEXT PRIMARY KEY,
  last_processed_at TIMESTAMPTZ NOT NULL,
  last_message_id   TEXT
);

-- Down Migration

DROP TABLE ingest_cursor, battery_health_sample, session_point, session, sample, raw_message, vehicle;
DROP TYPE session_kind, raw_source, vendor;
