-- Migration 0011: optional example call per service (e.g. "/signals?handle=monad"), relative to /s/{slug}.
-- Set in the signed service create/update/launch-details messages; drives "Try a sample call" on the web.
ALTER TABLE services ADD COLUMN IF NOT EXISTS example_path TEXT;
