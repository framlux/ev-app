-- Up Migration

CREATE OR REPLACE FUNCTION ensure_month_partitions(target DATE)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t   TEXT;
  lo  DATE := date_trunc('month', target)::date;
  hi  DATE := (date_trunc('month', target) + INTERVAL '1 month')::date;
  nm  TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['raw_message', 'sample'] LOOP
    nm := format('%s_%s', t, to_char(lo, 'YYYY_MM'));
    IF to_regclass(nm) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        nm, t, lo, hi);
    END IF;
  END LOOP;
END $$;

SELECT ensure_month_partitions(CURRENT_DATE);
SELECT ensure_month_partitions((CURRENT_DATE + INTERVAL '1 month')::date);

-- Down Migration

DROP FUNCTION IF EXISTS ensure_month_partitions(DATE);
