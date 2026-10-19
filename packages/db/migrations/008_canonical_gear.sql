-- Up Migration

-- Spec §7.5. `gear` becomes canonical (P/R/N/D) because the segmenter reasons
-- about it and must not know a vendor's words. New samples already arrive
-- canonical; this rewrites history so it agrees with what a reprocess of the
-- tape would now produce. Unmatched values (ShiftStateSNA, ShiftStateInvalid)
-- become NULL, which is exactly what the decoder now writes for them.
--
-- ROLLOUT: the previous ingest image writes ShiftState* strings. Stop it before
-- this runs (the broker queues the backlog) - see the spec §11.
UPDATE sample SET gear = CASE gear
    WHEN 'ShiftStateP' THEN 'P'
    WHEN 'ShiftStateR' THEN 'R'
    WHEN 'ShiftStateN' THEN 'N'
    WHEN 'ShiftStateD' THEN 'D'
  END
WHERE gear LIKE 'ShiftState%';

-- Down Migration

-- Lossy for ShiftStateSNA/Invalid, which became NULL and stay NULL. Tesla rows
-- only: a Rivian sample's 'D' was never a ShiftState string.
UPDATE sample s SET gear = 'ShiftState' || s.gear
FROM vehicle v
WHERE v.id = s.vehicle_id AND v.vendor = 'tesla' AND s.gear IN ('P', 'R', 'N', 'D');
