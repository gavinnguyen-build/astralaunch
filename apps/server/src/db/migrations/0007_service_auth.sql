-- Migration 0007: creator-signed service create/update (docs/decisions.md D-SV1).
-- signed_requests: every accepted signed message, so it can never be replayed.
-- services.auth_signed_at: issuedAt of the last accepted signed request (monotonic).

CREATE TABLE IF NOT EXISTS signed_requests (
  message_hash TEXT PRIMARY KEY,           -- keccak256 of the signed message
  signer       TEXT NOT NULL,
  purpose      TEXT NOT NULL,              -- 'service_create' | 'service_update'
  issued_at    BIGINT NOT NULL,
  used_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS auth_signed_at BIGINT;
