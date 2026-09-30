-- Migration 0012: "one API link" service model (docs/decisions.md D-SL1..).
-- api_link is the creator's pasted link (private: only returned by the signed settings endpoint).
-- upstream_url keeps its meaning (origin + allowed prefix) and is derived from api_link for new services.
ALTER TABLE services ADD COLUMN IF NOT EXISTS api_link              TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS whole_domain          BOOLEAN NOT NULL DEFAULT false;
-- Optional API key the gateway adds to every forwarded call. Value is AES-256-GCM encrypted (lib/secretBox.ts).
ALTER TABLE services ADD COLUMN IF NOT EXISTS api_key_header        TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS api_key_enc           TEXT;
-- "Protect your API": shared secret sent as X-Astralaunch-Secret on every forwarded call (generated lazily).
ALTER TABLE services ADD COLUMN IF NOT EXISTS protect_secret        TEXT;
-- Link check at attach time: what the API returns (json | stream | file) and a small JSON sample.
ALTER TABLE services ADD COLUMN IF NOT EXISTS response_kind         TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS response_content_type TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS response_sample       TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS link_checked_at       TIMESTAMPTZ;
-- Protection probe: a direct call without the secret; 'unprotected' when it answered 2xx (creator-only).
ALTER TABLE services ADD COLUMN IF NOT EXISTS protection_status     TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS protection_checked_at TIMESTAMPTZ;
