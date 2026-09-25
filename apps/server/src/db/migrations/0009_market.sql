-- Migration 0009: market data for the web app (D-MK1).
-- idx_swaps: Uniswap v4 PoolManager Swap events for registered pools only (amounts from the
--            swapper's side: positive = received). is_buyback = sender is the BuybackVault.
-- idx_pool_inits: PoolManager Initialize for registered pools (launch price).
-- idx_asset_transfers: ERC-20 Transfer events of registered assets (holders).

CREATE TABLE IF NOT EXISTS idx_swaps (
  id               SERIAL PRIMARY KEY,
  chain_id         INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL,
  log_index        INTEGER NOT NULL,
  pool_id          TEXT NOT NULL,
  asset            TEXT NOT NULL,
  numeraire        TEXT NOT NULL,
  sender           TEXT NOT NULL,
  tx_from          TEXT NOT NULL DEFAULT '',
  asset_delta      NUMERIC(78) NOT NULL,
  numeraire_delta  NUMERIC(78) NOT NULL,
  sqrt_price_x96   NUMERIC(78) NOT NULL,
  liquidity        NUMERIC(78) NOT NULL,
  tick             INTEGER NOT NULL,
  fee              INTEGER NOT NULL,
  price_wad        NUMERIC(78) NOT NULL,
  is_buyback       BOOLEAN NOT NULL DEFAULT FALSE,
  block_number     BIGINT NOT NULL,
  timestamp        BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_swaps_unique ON idx_swaps (chain_id, tx_hash, log_index);
CREATE INDEX IF NOT EXISTS idx_swaps_asset_time ON idx_swaps (asset, timestamp);

CREATE TABLE IF NOT EXISTS idx_pool_inits (
  id               SERIAL PRIMARY KEY,
  chain_id         INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL,
  log_index        INTEGER NOT NULL,
  pool_id          TEXT NOT NULL,
  asset            TEXT NOT NULL,
  sqrt_price_x96   NUMERIC(78) NOT NULL,
  price_wad        NUMERIC(78) NOT NULL,
  block_number     BIGINT NOT NULL,
  timestamp        BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_inits_unique ON idx_pool_inits (chain_id, tx_hash, log_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_inits_pool ON idx_pool_inits (pool_id);

CREATE TABLE IF NOT EXISTS idx_asset_transfers (
  id               SERIAL PRIMARY KEY,
  chain_id         INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL,
  log_index        INTEGER NOT NULL,
  asset            TEXT NOT NULL,
  from_addr        TEXT NOT NULL,
  to_addr          TEXT NOT NULL,
  value            NUMERIC(78) NOT NULL,
  block_number     BIGINT NOT NULL,
  timestamp        BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_transfers_unique ON idx_asset_transfers (chain_id, tx_hash, log_index);
CREATE INDEX IF NOT EXISTS idx_asset_transfers_asset ON idx_asset_transfers (asset);
