-- Astralaunch migration 0002: tokens + service_probes
-- Generated 2026-09-23

CREATE TABLE IF NOT EXISTS tokens (
  asset           TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  creator         TEXT NOT NULL,
  router          TEXT NOT NULL,
  image_url       TEXT,
  description     TEXT,
  website         TEXT,
  twitter         TEXT,
  launched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens (creator);
CREATE INDEX IF NOT EXISTS idx_tokens_launched ON tokens (launched_at DESC);

CREATE TABLE IF NOT EXISTS service_probes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id  UUID NOT NULL REFERENCES services(id),
  ok          BOOLEAN NOT NULL,
  latency_ms  INTEGER,
  status_code INTEGER,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_probes_service  ON service_probes (service_id, checked_at DESC);
