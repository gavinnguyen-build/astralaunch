-- Migration 0008: every timestamp column is TIMESTAMPTZ (D-TS1).
-- idx_checkpoints.updated_at was the only TIMESTAMP (without time zone) column. Values were written
-- as UTC ISO strings, so reinterpret the stored wall time as UTC. Idempotent: no-op once converted.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'idx_checkpoints' AND column_name = 'updated_at') = 'timestamp without time zone' THEN
    ALTER TABLE idx_checkpoints
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
  END IF;
END $$;
