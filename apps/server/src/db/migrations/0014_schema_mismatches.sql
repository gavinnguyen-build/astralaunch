-- Migration 0014: responses that failed a service's response schema (docs/decisions.md D-SV4). Shown to the service's
-- creator only (signed settings read), as a 7-day count plus the latest error. path = the request path under
-- /s/{slug}, without the query string (agent data); detail = the validator's first error (<= 300 chars).
-- Rows older than 7 days are pruned when new ones are written; a schema change clears the service's rows.
CREATE TABLE IF NOT EXISTS schema_mismatches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id  UUID NOT NULL REFERENCES services(id),
  code        TEXT NOT NULL,
  detail      TEXT,
  path        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schema_mismatches_service_time ON schema_mismatches (service_id, created_at);
