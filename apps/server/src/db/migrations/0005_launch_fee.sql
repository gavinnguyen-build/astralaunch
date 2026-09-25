-- Migration 0005: off-chain launch fee receipts + launcher on registrations.
-- Idempotent (IF NOT EXISTS). See docs/decisions.md D-LF1..D-LF6.

CREATE TABLE IF NOT EXISTS fee_receipts (
  id               SERIAL PRIMARY KEY,
  chain_id         INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL,
  launcher         TEXT NOT NULL,
  amount_wei       NUMERIC(78) NOT NULL,
  block_number     BIGINT NOT NULL,
  paid_at          BIGINT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'fee',
  verified_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_asset   TEXT,
  consumed_tx_hash TEXT,
  consumed_reg_ts  BIGINT,
  consumed_at      TIMESTAMPTZ,
  note             TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS fee_receipts_tx_hash_unique        ON fee_receipts (tx_hash);
CREATE UNIQUE INDEX IF NOT EXISTS fee_receipts_consumed_asset_unique ON fee_receipts (consumed_asset);
CREATE INDEX        IF NOT EXISTS fee_receipts_launcher_idx          ON fee_receipts (launcher, consumed_asset);

ALTER TABLE idx_registrations
  ADD COLUMN IF NOT EXISTS launcher TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_registrations_launcher_idx ON idx_registrations (launcher);
