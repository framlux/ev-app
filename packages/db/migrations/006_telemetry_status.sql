-- Up Migration

-- Spec §3.7. The last known answer to "has the car applied its telemetry
-- configuration", cached so the settings page can answer it with NO TESLA
-- SESSION AT ALL. That is the whole point of the table rather than a nicety:
-- consent is interactive and lasts hours (§3.2), so for most of the day the
-- only thing the page can show is what we last saw, and without this row the
-- page would be empty exactly when someone is glancing at it to check nothing
-- has broken. It also gives the ingest-side stall alert something to read —
-- an unsynced config is one of the causes of a silent stall.
--
-- One row per vehicle, so the primary key IS the foreign key. There is no
-- history here on purpose: the page shows the current state and its age, and a
-- log of every check would grow without bound in service of a question nobody
-- asks. The raw tape is where history lives.
CREATE TABLE telemetry_status (
  vehicle_id        TEXT PRIMARY KEY REFERENCES vehicle(id),

  -- What the car reports about the config it has applied, plus the shape of
  -- that config. `ca_present` is a boolean and not the PEM: §3.6 compares the
  -- CA on presence only, and storing the certificate would put a copy of the
  -- car's pinned trust anchor in a table read by an internet-facing pod for no
  -- gain.
  synced            BOOLEAN,
  field_count       INT,
  ca_present        BOOLEAN,

  -- The last preflight (§3.6). These are the reasons a push gets refused, and
  -- keeping them means the page can say WHY it will not push before anyone
  -- consents to Tesla again.
  firmware          TEXT,
  key_paired        BOOLEAN,
  streaming_enabled BOOLEAN,

  -- Ages, not flags. "synced: false" means nothing without "as of when": the
  -- car applies on its own schedule and hours of false is the normal case
  -- (§5), so the page renders the gap between these and now.
  checked_at        TIMESTAMPTZ,
  pushed_at         TIMESTAMPTZ
);

-- Every column but the key is NULLABLE, and that is a decision rather than
-- laziness. Two different callers create this row — a check, which knows what
-- the car has applied and nothing about pushes, and a push, which knows only
-- that it sent something — and either can be the first. A `synced BOOLEAN NOT
-- NULL DEFAULT false` would make a row created by a push report "the car says
-- no" when the truth is "nobody has asked the car yet", and the page cannot
-- tell those apart after the fact. NULL means unknown, and the page renders
-- unknown as an em dash rather than as an answer.

-- Down Migration

DROP TABLE telemetry_status;
