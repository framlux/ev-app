-- Up Migration

-- Spec §4.1 lists a cost on a charge session, but 001_initial.sql never created
-- the column and there was no currency anywhere. The read API contract exposes
-- `cost`/`costCurrency` on every session because the charges page renders the
-- column conditionally on `costCurrency` and needs the key to exist from day
-- one; a UI that has to grow a new field later grows a new empty state too.
--
-- Both are nullable and nothing writes them yet: tariffs are deferred (spec
-- §11). The currency is stored per row rather than as one global setting
-- because a charge abroad is priced in the local currency, and a single app
-- setting would silently relabel historical rows when the owner changes it.
ALTER TABLE session
  ADD COLUMN cost          NUMERIC(10,2),
  ADD COLUMN cost_currency TEXT;

-- Down Migration

ALTER TABLE session
  DROP COLUMN cost,
  DROP COLUMN cost_currency;
