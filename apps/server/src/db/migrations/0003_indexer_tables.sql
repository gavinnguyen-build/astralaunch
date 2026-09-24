-- Migration 0003: Indexer tables (D24 — custom indexer replaces Envio)
-- All tables prefixed idx_, amount columns NUMERIC(78) for uint256 range.
-- Unique constraint (chain_id, tx_hash, log_index) ensures idempotent upserts.

-- ── idx_checkpoints ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "idx_checkpoints" (
  "contract_set"  TEXT NOT NULL PRIMARY KEY,
  "block_number"  BIGINT NOT NULL,
  "updated_at"    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ── idx_registrations ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "idx_registrations" (
  "id"            SERIAL PRIMARY KEY,
  "chain_id"      INTEGER NOT NULL,
  "tx_hash"       TEXT NOT NULL,
  "log_index"     INTEGER NOT NULL,
  "asset"         TEXT NOT NULL,
  "creator"       TEXT NOT NULL,
  "router"        TEXT NOT NULL,
  "pool_id"       TEXT NOT NULL,
  "block_number"  BIGINT NOT NULL,
  "timestamp"     BIGINT NOT NULL,
  UNIQUE ("chain_id", "tx_hash", "log_index")
);
CREATE INDEX IF NOT EXISTS "idx_registrations_block" ON "idx_registrations" ("block_number");
CREATE INDEX IF NOT EXISTS "idx_registrations_asset" ON "idx_registrations" ("asset");

-- ── idx_usdc_transfers ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "idx_usdc_transfers" (
  "id"                      SERIAL PRIMARY KEY,
  "chain_id"                INTEGER NOT NULL,
  "tx_hash"                 TEXT NOT NULL,
  "log_index"               INTEGER NOT NULL,
  "from_addr"               TEXT NOT NULL,
  "to_addr"                 TEXT NOT NULL,
  "value"                   NUMERIC(78) NOT NULL,
  "tx_from"                 TEXT NOT NULL DEFAULT '',
  "is_facilitator_settled"  BOOLEAN NOT NULL DEFAULT false,
  "block_number"            BIGINT NOT NULL,
  "timestamp"               BIGINT NOT NULL,
  UNIQUE ("chain_id", "tx_hash", "log_index")
);
CREATE INDEX IF NOT EXISTS "idx_usdc_transfers_block" ON "idx_usdc_transfers" ("block_number");
CREATE INDEX IF NOT EXISTS "idx_usdc_transfers_to" ON "idx_usdc_transfers" ("to_addr");

-- ── idx_distributions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "idx_distributions" (
  "id"            SERIAL PRIMARY KEY,
  "chain_id"      INTEGER NOT NULL,
  "tx_hash"       TEXT NOT NULL,
  "log_index"     INTEGER NOT NULL,
  "asset"         TEXT NOT NULL,
  "total"         NUMERIC(78) NOT NULL,
  "provider_amt"  NUMERIC(78) NOT NULL,
  "cost_amt"      NUMERIC(78) NOT NULL,
  "buyback_amt"   NUMERIC(78) NOT NULL,
  "treasury_amt"  NUMERIC(78) NOT NULL,
  "block_number"  BIGINT NOT NULL,
  "timestamp"     BIGINT NOT NULL,
  UNIQUE ("chain_id", "tx_hash", "log_index")
);
CREATE INDEX IF NOT EXISTS "idx_distributions_block" ON "idx_distributions" ("block_number");
CREATE INDEX IF NOT EXISTS "idx_distributions_asset" ON "idx_distributions" ("asset");

-- ── idx_fee_collections ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "idx_fee_collections" (
  "id"            SERIAL PRIMARY KEY,
  "chain_id"      INTEGER NOT NULL,
  "tx_hash"       TEXT NOT NULL,
  "log_index"     INTEGER NOT NULL,
  "contract"      TEXT NOT NULL,
  "asset"         TEXT NOT NULL,
  "usdc_delta"    NUMERIC(78) NOT NULL,
  "token_delta"   NUMERIC(78) NOT NULL,
  "block_number"  BIGINT NOT NULL,
  "timestamp"     BIGINT NOT NULL,
  UNIQUE ("chain_id", "tx_hash", "log_index")
);
CREATE INDEX IF NOT EXISTS "idx_fee_collections_block" ON "idx_fee_collections" ("block_number");

-- ── idx_revenue_recorded ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "idx_revenue_recorded" (
  "id"            SERIAL PRIMARY KEY,
  "chain_id"      INTEGER NOT NULL,
  "tx_hash"       TEXT NOT NULL,
  "log_index"     INTEGER NOT NULL,
  "asset"         TEXT NOT NULL,
  "amount"        NUMERIC(78) NOT NULL,
  "new_total"     NUMERIC(78) NOT NULL,
  "block_number"  BIGINT NOT NULL,
  "timestamp"     BIGINT NOT NULL,
  UNIQUE ("chain_id", "tx_hash", "log_index")
);
CREATE INDEX IF NOT EXISTS "idx_revenue_recorded_block" ON "idx_revenue_recorded" ("block_number");

-- ── idx_escrow_claims ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "idx_escrow_claims" (
  "id"            SERIAL PRIMARY KEY,
  "chain_id"      INTEGER NOT NULL,
  "tx_hash"       TEXT NOT NULL,
  "log_index"     INTEGER NOT NULL,
  "asset"         TEXT NOT NULL,
  "creator"       TEXT NOT NULL,
  "amount"        NUMERIC(78) NOT NULL,
  "block_number"  BIGINT NOT NULL,
  "timestamp"     BIGINT NOT NULL,
  UNIQUE ("chain_id", "tx_hash", "log_index")
);
CREATE INDEX IF NOT EXISTS "idx_escrow_claims_block" ON "idx_escrow_claims" ("block_number");

-- ── idx_escrow_forfeits ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "idx_escrow_forfeits" (
  "id"            SERIAL PRIMARY KEY,
  "chain_id"      INTEGER NOT NULL,
  "tx_hash"       TEXT NOT NULL,
  "log_index"     INTEGER NOT NULL,
  "asset"         TEXT NOT NULL,
  "usdc_moved"    NUMERIC(78) NOT NULL,
  "token_moved"   NUMERIC(78) NOT NULL,
  "block_number"  BIGINT NOT NULL,
  "timestamp"     BIGINT NOT NULL,
  UNIQUE ("chain_id", "tx_hash", "log_index")
);
CREATE INDEX IF NOT EXISTS "idx_escrow_forfeits_block" ON "idx_escrow_forfeits" ("block_number");

-- ── idx_buybacks ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "idx_buybacks" (
  "id"            SERIAL PRIMARY KEY,
  "chain_id"      INTEGER NOT NULL,
  "tx_hash"       TEXT NOT NULL,
  "log_index"     INTEGER NOT NULL,
  "asset"         TEXT NOT NULL,
  "usdc_in"       NUMERIC(78) NOT NULL,
  "tokens_burned" NUMERIC(78) NOT NULL,
  "source_tag"    INTEGER NOT NULL,
  "block_number"  BIGINT NOT NULL,
  "timestamp"     BIGINT NOT NULL,
  UNIQUE ("chain_id", "tx_hash", "log_index")
);
CREATE INDEX IF NOT EXISTS "idx_buybacks_block" ON "idx_buybacks" ("block_number");
CREATE INDEX IF NOT EXISTS "idx_buybacks_asset" ON "idx_buybacks" ("asset");

-- ── idx_burns ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "idx_burns" (
  "id"            SERIAL PRIMARY KEY,
  "chain_id"      INTEGER NOT NULL,
  "tx_hash"       TEXT NOT NULL,
  "log_index"     INTEGER NOT NULL,
  "asset"         TEXT NOT NULL,
  "amount"        NUMERIC(78) NOT NULL,
  "block_number"  BIGINT NOT NULL,
  "timestamp"     BIGINT NOT NULL,
  UNIQUE ("chain_id", "tx_hash", "log_index")
);
CREATE INDEX IF NOT EXISTS "idx_burns_block" ON "idx_burns" ("block_number");

-- ── idx_pfr_collections ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "idx_pfr_collections" (
  "id"            SERIAL PRIMARY KEY,
  "chain_id"      INTEGER NOT NULL,
  "tx_hash"       TEXT NOT NULL,
  "log_index"     INTEGER NOT NULL,
  "asset"         TEXT NOT NULL,
  "usdc_forwarded" NUMERIC(78) NOT NULL,
  "token_forwarded" NUMERIC(78) NOT NULL,
  "block_number"  BIGINT NOT NULL,
  "timestamp"     BIGINT NOT NULL,
  UNIQUE ("chain_id", "tx_hash", "log_index")
);
CREATE INDEX IF NOT EXISTS "idx_pfr_collections_block" ON "idx_pfr_collections" ("block_number");
