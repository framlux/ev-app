-- Up Migration

-- Spec §3.1. The tariff 003_session_cost.sql deferred. `session.cost` has
-- existed since 003 with nothing to write it, because a figure needs a price
-- and there was nowhere to keep one.
--
-- This is a HISTORY of prices, not a setting. One current rate in a config
-- table would silently re-price every charge ever taken the day PSE raises a
-- rate, and the whole point of §3.2 is that what a charge cost is a fact about
-- the charge rather than a fact about today. So rows accumulate, are never
-- edited, and a lookup asks which one was in force at an instant.
--
-- There is no `effective_to`. A rate's window ends where the next row's begins,
-- and a stored end date is a second copy of that fact that can disagree with
-- it — leaving a gap that prices nothing or an overlap that prices twice.
CREATE TABLE energy_rate (
  -- `gen_random_uuid()` appears nowhere else in this repo: every other primary
  -- key is TEXT minted in Node (`sessions.ts`, `randomUUID()`) or a natural
  -- key, so a reader has no local evidence that this works. It does — it is a
  -- core builtin from PG 13 onward, needing no `CREATE EXTENSION pgcrypto`,
  -- and both CI and the documented throwaway are postgres:17-alpine.
  --
  -- It is used here because nothing in Node inserts these rows on a path where
  -- it already holds an id: a URDB fetch and a typed-in override both know only
  -- a price and an instant. `energy_rate.id` being a UUID where `session.id` is
  -- TEXT is therefore a deliberate inconsistency and not an oversight — the two
  -- tables never join, and no code ever holds one of these ids expecting the
  -- other's shape.
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- When this price started applying, NOT when we learned it. §3.3 inserts with
  -- `effective_from = now()` rather than URDB's own `startdate`, because
  -- back-dating would re-price sessions that were already closed at the old
  -- number and make history move under a page someone had already read.
  effective_from  TIMESTAMPTZ NOT NULL,

  -- Five decimal places because the unit is dollars per kWh and a US
  -- residential rate is around $0.199 — NUMERIC(10,2) would round the tariff
  -- itself to $0.20, a 0.5% error applied to every charge forever.
  price_per_kwh   NUMERIC(10,5) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',

  -- 'urdb' | 'manual'. Not an enum: §3.3's source list is expected to grow (a
  -- second utility, an imported bill), and `session_kind` already shows what an
  -- enum costs — every new member is its own migration.
  source          TEXT NOT NULL,
  -- The URDB page label the value came from, so a wrong rate is traceable back
  -- to the tariff that was misread. Null on a manual row: a human is the label.
  urdb_label      TEXT,
  -- Distinct from `effective_from` on purpose. The gap between the two IS
  -- URDB's lag (§6), and collapsing them would hide the one number that says
  -- whether the override is needed.
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Idempotency for a fetch that runs daily and finds the same answer nearly
  -- every time. Keyed on the source too, so a manual override can sit at the
  -- same instant as the URDB row it corrects rather than being refused by it —
  -- which is exactly the collision §3.2's tiebreak exists to resolve.
  UNIQUE (effective_from, source)
);

-- Two columns because §3.2's tiebreak is part of the lookup's ORDER BY, not
-- prose: `ORDER BY effective_from DESC, (source = 'manual') DESC LIMIT 1`. A
-- single-column index would still answer the query, but by sorting the ties —
-- and the tie is the case a manual override was written to win.
CREATE INDEX energy_rate_effective_from_idx
  ON energy_rate (effective_from DESC, (source = 'manual') DESC);

-- Two columns, because they answer two questions and one column answering both
-- would have to drop an answer.
--
-- `cost_basis` says WHY this charge is priced the way it is — where the energy
-- came from — and it is the field that SURVIVES a null cost: it is what §3.7
-- renders instead of a number, so a blank cell reads as "awaiting Tesla
-- invoice" rather than as free. `cost_source` says where the figure came from,
-- and is what marks a §5 backfill as an estimate rather than a measurement.
--
-- `cost_rate_per_kwh` is stored rather than recomputed so the charge page can
-- show its own arithmetic, and so a later re-pricing is distinguishable from
-- the original. It carries NUMERIC(10,5) to match `energy_rate.price_per_kwh`
-- exactly — storing the rate at less precision than the table it was read from
-- would make `energy_kwh × rate` fail to reproduce the stored `cost`.
--
-- All three are null on drives and idles: only charges have a price.
ALTER TABLE session
  ADD COLUMN cost_rate_per_kwh NUMERIC(10,5),
  ADD COLUMN cost_basis        TEXT,
  ADD COLUMN cost_source       TEXT;

-- What makes §3.5's month-end gate free in a month with no Supercharging. The
-- guard is `EXISTS (… kind='charge' AND cost IS NULL AND cost_basis='pending')`
-- and it runs before any Tesla call is made; without an index it is a
-- sequential scan of every session ever recorded to discover there is nothing
-- to do. Partial, so it holds only the handful of rows genuinely awaiting an
-- invoice rather than a copy of the whole table.
CREATE INDEX session_pending_cost_idx
  ON session (ended_at)
  WHERE kind = 'charge' AND cost IS NULL AND cost_basis = 'pending';

-- Down Migration

DROP INDEX session_pending_cost_idx;

ALTER TABLE session
  DROP COLUMN cost_rate_per_kwh,
  DROP COLUMN cost_basis,
  DROP COLUMN cost_source;

-- The index goes with the table it is on; naming it here would be an error.
DROP TABLE energy_rate;
