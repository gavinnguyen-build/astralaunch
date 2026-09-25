-- Migration 0006: tokens rows are created by the indexer from on-chain data
-- (Registered event + ERC-20 reads); POST /api/tokens only edits metadata.
-- Idempotent. See docs/decisions.md D-TK1..D-TK3.

ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS launcher           TEXT    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pool_id            TEXT    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS numeraire          TEXT    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS initializer        TEXT    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS decimals           INTEGER NOT NULL DEFAULT 18,
  ADD COLUMN IF NOT EXISTS registered_tx      TEXT,
  ADD COLUMN IF NOT EXISTS registered_block   BIGINT,
  ADD COLUMN IF NOT EXISTS registered_at      BIGINT,
  ADD COLUMN IF NOT EXISTS x_handle           TEXT,
  ADD COLUMN IF NOT EXISTS metadata_signed_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_tokens_launcher ON tokens (launcher);
