-- Revpad initial schema
-- Generated 2026-09-23

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS services (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  asset           TEXT NOT NULL,
  router          TEXT NOT NULL,
  creator         TEXT NOT NULL,
  upstream_url    TEXT NOT NULL,
  price_usdc      TEXT NOT NULL,
  upstream_secret TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL DEFAULT 20,
  request_schema  TEXT,
  response_schema TEXT,
  description     TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_services_asset   ON services (asset);
CREATE INDEX IF NOT EXISTS idx_services_creator ON services (creator);
CREATE INDEX IF NOT EXISTS idx_services_slug    ON services (slug) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS gateway_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id      UUID NOT NULL REFERENCES services(id),
  asset           TEXT NOT NULL,
  payer           TEXT NOT NULL,
  amount_usdc     TEXT NOT NULL,
  status_code     INTEGER,
  upstream_status INTEGER,
  latency_ms      INTEGER,
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  settled         BOOLEAN NOT NULL DEFAULT FALSE,
  settle_tx_hash  TEXT,
  error_code      TEXT,
  request_bytes   INTEGER,
  response_bytes  INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gw_service  ON gateway_requests (service_id);
CREATE INDEX IF NOT EXISTS idx_gw_payer    ON gateway_requests (payer);
CREATE INDEX IF NOT EXISTS idx_gw_asset    ON gateway_requests (asset);
CREATE INDEX IF NOT EXISTS idx_gw_settled  ON gateway_requests (settled, created_at DESC);
