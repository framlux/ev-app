-- Up Migration

-- Spec §3.7. `NominalFullPackEnergyKwh` is the pack's full energy as the CAR
-- computes it, and we now capture it on every sample. That is a measurement,
-- not an inference, and it belongs beside the estimate rather than instead of
-- it: the estimate is derivable from history we already have, the two disagree
-- in ways worth seeing, and overwriting one with the other would throw away the
-- only cross-check either has.
--
-- One row per vehicle per day still, because the primary key is
-- (vehicle_id, observed_on) and both series are daily. Two columns, one row.
-- No `source` column: which value is present says which it is, and a source
-- discriminator on a row that can legitimately carry BOTH would have to lie
-- about one of them.
ALTER TABLE battery_health_sample
  ADD COLUMN measured_capacity_kwh REAL;

-- Most days now have a measurement (the car reports pack energy whenever it is
-- awake) and no estimate (the estimator needs a charge spanning at least 20
-- points of SoC, which is a small minority of days). Those two NOT NULLs were
-- written when an estimate was the only thing this table could hold; keeping
-- them would make the common case unwritable and put the measurement back where
-- it started, which is nowhere.
ALTER TABLE battery_health_sample
  ALTER COLUMN estimated_capacity_kwh DROP NOT NULL,
  ALTER COLUMN sample_confidence      DROP NOT NULL;

-- Down Migration

-- The DELETE is not tidiness, it is the only way down is possible: rows that
-- carry a measurement and no estimate cannot be represented under the restored
-- NOT NULL, and SET NOT NULL against them fails outright, leaving the database
-- half-migrated. They are re-derivable — every one of them comes from a sample
-- row that is still there — so `reprocess` rebuilds them after a re-up.
DELETE FROM battery_health_sample
 WHERE estimated_capacity_kwh IS NULL OR sample_confidence IS NULL;

ALTER TABLE battery_health_sample
  ALTER COLUMN estimated_capacity_kwh SET NOT NULL,
  ALTER COLUMN sample_confidence      SET NOT NULL;

ALTER TABLE battery_health_sample
  DROP COLUMN measured_capacity_kwh;
