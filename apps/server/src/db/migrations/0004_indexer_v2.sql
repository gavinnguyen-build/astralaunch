-- Migration 0004: indexer v2 event fields
-- Adds numeraire/initializer to registrations; WMON amounts to fee/escrow/PFR tables;
-- ClaimedWmon fields to escrow claims.
-- Idempotent: uses ADD COLUMN IF NOT EXISTS (Postgres 9.6+).

ALTER TABLE idx_registrations
  ADD COLUMN IF NOT EXISTS numeraire   TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS initializer TEXT NOT NULL DEFAULT '';

ALTER TABLE idx_fee_collections
  ADD COLUMN IF NOT EXISTS wmon_delta      NUMERIC(78) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS numeraire_delta NUMERIC(78) NOT NULL DEFAULT '0';

ALTER TABLE idx_escrow_forfeits
  ADD COLUMN IF NOT EXISTS wmon_moved NUMERIC(78) NOT NULL DEFAULT '0';

ALTER TABLE idx_pfr_collections
  ADD COLUMN IF NOT EXISTS numeraire_forwarded NUMERIC(78) NOT NULL DEFAULT '0';

ALTER TABLE idx_escrow_claims
  ADD COLUMN IF NOT EXISTS wmon_amount NUMERIC(78) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS usd_value  NUMERIC(78) NOT NULL DEFAULT '0';
