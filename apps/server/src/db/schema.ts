import { pgTable, text, integer, boolean, timestamp, uuid, serial, bigint, numeric, uniqueIndex, index } from 'drizzle-orm/pg-core';

// ── tokens ────────────────────────────────────────────────────────────────────
export const tokens = pgTable('tokens', {
  asset:       text('asset').primaryKey(),          // ERC-20 address (lowercase)
  name:        text('name').notNull(),
  symbol:      text('symbol').notNull(),
  creator:     text('creator').notNull(),            // wallet that launched
  router:      text('router').notNull(),             // RevenueRouter address
  imageUrl:    text('image_url'),
  description: text('description'),
  website:     text('website'),
  twitter:     text('twitter'),                      // legacy (pre-0006) URL field
  launchedAt:  timestamp('launched_at', { withTimezone: true }).notNull().defaultNow(), // TIMESTAMPTZ; = registration time for indexed tokens
  // On-chain fields written by the indexer (migration 0006)
  launcher:         text('launcher').notNull().default(''),   // register() tx sender
  poolId:           text('pool_id').notNull().default(''),
  numeraire:        text('numeraire').notNull().default(''),
  initializer:      text('initializer').notNull().default(''),
  decimals:         integer('decimals').notNull().default(18),
  registeredTx:     text('registered_tx'),
  registeredBlock:  bigint('registered_block', { mode: 'bigint' }),
  registeredAt:     bigint('registered_at', { mode: 'bigint' }),  // block timestamp (s)
  // Creator-signed metadata (POST /api/tokens)
  xHandle:          text('x_handle'),
  metadataSignedAt: bigint('metadata_signed_at', { mode: 'bigint' }),
});

export type Token = typeof tokens.$inferSelect;
export type NewToken = typeof tokens.$inferInsert;

// ── services ──────────────────────────────────────────────────────────────────
export const services = pgTable('services', {
  id:             uuid('id').primaryKey().defaultRandom(),
  slug:           text('slug').notNull().unique(),
  name:           text('name').notNull(),
  asset:          text('asset').notNull(),        // token address
  router:         text('router').notNull(),        // RevenueRouter address (payTo)
  creator:        text('creator').notNull(),       // wallet that registered
  upstreamUrl:    text('upstream_url').notNull(),
  priceUsdc:      text('price_usdc').notNull(),    // raw bigint string (6 dec)
  upstreamSecret: text('upstream_secret').notNull(), // HMAC key for X-Astralaunch-Signature
  timeoutSeconds: integer('timeout_seconds').notNull().default(20),
  requestSchema:  text('request_schema'),
  responseSchema: text('response_schema'),
  description:    text('description'),
  active:         boolean('active').notNull().default(true),
  authSignedAt:   bigint('auth_signed_at', { mode: 'bigint' }), // issuedAt of last accepted signed request (0007)
  createdAt:      timestamp('created_at').notNull().defaultNow(),
  updatedAt:      timestamp('updated_at').notNull().defaultNow(),
});

export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;

// ── gateway_requests (SPEC §9.3) ──────────────────────────────────────────────
export const gatewayRequests = pgTable('gateway_requests', {
  id:             uuid('id').primaryKey().defaultRandom(),
  serviceId:      uuid('service_id').notNull().references(() => services.id),
  asset:          text('asset').notNull(),
  payer:          text('payer').notNull(),        // wallet address
  amountUsdc:     text('amount_usdc').notNull(),  // raw bigint string
  statusCode:     integer('status_code'),         // HTTP status returned to agent
  upstreamStatus: integer('upstream_status'),     // upstream HTTP status
  latencyMs:      integer('latency_ms'),
  verified:       boolean('verified').notNull().default(false),
  settled:        boolean('settled').notNull().default(false),
  settleTxHash:   text('settle_tx_hash'),
  errorCode:      text('error_code'),             // 'upstream_error'|'settle_failed'|'verify_failed'
  requestBytes:   integer('request_bytes'),
  responseBytes:  integer('response_bytes'),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
});

export type GatewayRequest = typeof gatewayRequests.$inferSelect;
export type NewGatewayRequest = typeof gatewayRequests.$inferInsert;

// ── service_probes (SPEC §9.4) ─────────────────────────────────────────────
export const serviceProbes = pgTable('service_probes', {
  id:         uuid('id').primaryKey().defaultRandom(),
  serviceId:  uuid('service_id').notNull().references(() => services.id),
  ok:         boolean('ok').notNull(),
  latencyMs:  integer('latency_ms'),
  statusCode: integer('status_code'),
  checkedAt:  timestamp('checked_at').notNull().defaultNow(),
});

export type ServiceProbe = typeof serviceProbes.$inferSelect;

// ── Indexer tables (migration 0003, D24) ─────────────────────────────────────

export const idxCheckpoints = pgTable('idx_checkpoints', {
  contractSet: text('contract_set').primaryKey(),
  blockNumber:  bigint('block_number', { mode: 'bigint' }).notNull(),
  updatedAt:    timestamp('updated_at').notNull().defaultNow(),
});

export const idxRegistrations = pgTable('idx_registrations', {
  id:          serial('id').primaryKey(),
  chainId:     integer('chain_id').notNull(),
  txHash:      text('tx_hash').notNull(),
  logIndex:    integer('log_index').notNull(),
  asset:       text('asset').notNull(),
  creator:     text('creator').notNull(),
  router:      text('router').notNull(),
  poolId:      text('pool_id').notNull(),
  numeraire:   text('numeraire').notNull().default(''),
  initializer: text('initializer').notNull().default(''),
  launcher:    text('launcher').notNull().default(''),   // register() tx sender (migration 0005)
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  timestamp:   bigint('timestamp', { mode: 'bigint' }).notNull(),
}, (t) => [
  uniqueIndex('idx_registrations_unique').on(t.chainId, t.txHash, t.logIndex),
]);

export const idxUsdcTransfers = pgTable('idx_usdc_transfers', {
  id:                    serial('id').primaryKey(),
  chainId:               integer('chain_id').notNull(),
  txHash:                text('tx_hash').notNull(),
  logIndex:              integer('log_index').notNull(),
  fromAddr:              text('from_addr').notNull(),
  toAddr:                text('to_addr').notNull(),
  value:                 numeric('value', { precision: 78 }).notNull(),
  txFrom:                text('tx_from').notNull().default(''),
  isFacilitatorSettled:  boolean('is_facilitator_settled').notNull().default(false),
  blockNumber:           bigint('block_number', { mode: 'bigint' }).notNull(),
  timestamp:             bigint('timestamp', { mode: 'bigint' }).notNull(),
}, (t) => [
  uniqueIndex('idx_usdc_transfers_unique').on(t.chainId, t.txHash, t.logIndex),
]);

export const idxDistributions = pgTable('idx_distributions', {
  id:          serial('id').primaryKey(),
  chainId:     integer('chain_id').notNull(),
  txHash:      text('tx_hash').notNull(),
  logIndex:    integer('log_index').notNull(),
  asset:       text('asset').notNull(),
  total:       numeric('total', { precision: 78 }).notNull(),
  providerAmt: numeric('provider_amt', { precision: 78 }).notNull(),
  costAmt:     numeric('cost_amt', { precision: 78 }).notNull(),
  buybackAmt:  numeric('buyback_amt', { precision: 78 }).notNull(),
  treasuryAmt: numeric('treasury_amt', { precision: 78 }).notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  timestamp:   bigint('timestamp', { mode: 'bigint' }).notNull(),
}, (t) => [
  uniqueIndex('idx_distributions_unique').on(t.chainId, t.txHash, t.logIndex),
]);

export const idxFeeCollections = pgTable('idx_fee_collections', {
  id:             serial('id').primaryKey(),
  chainId:        integer('chain_id').notNull(),
  txHash:         text('tx_hash').notNull(),
  logIndex:       integer('log_index').notNull(),
  contract:       text('contract').notNull(),
  asset:          text('asset').notNull(),
  usdcDelta:      numeric('usdc_delta', { precision: 78 }).notNull(),
  tokenDelta:     numeric('token_delta', { precision: 78 }).notNull(),
  wmonDelta:      numeric('wmon_delta', { precision: 78 }).notNull().default('0'),
  numeraireDelta: numeric('numeraire_delta', { precision: 78 }).notNull().default('0'),
  blockNumber:    bigint('block_number', { mode: 'bigint' }).notNull(),
  timestamp:      bigint('timestamp', { mode: 'bigint' }).notNull(),
}, (t) => [
  uniqueIndex('idx_fee_collections_unique').on(t.chainId, t.txHash, t.logIndex),
]);

export const idxRevenueRecorded = pgTable('idx_revenue_recorded', {
  id:          serial('id').primaryKey(),
  chainId:     integer('chain_id').notNull(),
  txHash:      text('tx_hash').notNull(),
  logIndex:    integer('log_index').notNull(),
  asset:       text('asset').notNull(),
  amount:      numeric('amount', { precision: 78 }).notNull(),
  newTotal:    numeric('new_total', { precision: 78 }).notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  timestamp:   bigint('timestamp', { mode: 'bigint' }).notNull(),
}, (t) => [
  uniqueIndex('idx_revenue_recorded_unique').on(t.chainId, t.txHash, t.logIndex),
]);

export const idxEscrowClaims = pgTable('idx_escrow_claims', {
  id:          serial('id').primaryKey(),
  chainId:     integer('chain_id').notNull(),
  txHash:      text('tx_hash').notNull(),
  logIndex:    integer('log_index').notNull(),
  asset:       text('asset').notNull(),
  creator:     text('creator').notNull(),
  amount:      numeric('amount', { precision: 78 }).notNull(),
  wmonAmount:  numeric('wmon_amount', { precision: 78 }).notNull().default('0'),
  usdValue:    numeric('usd_value', { precision: 78 }).notNull().default('0'),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  timestamp:   bigint('timestamp', { mode: 'bigint' }).notNull(),
}, (t) => [
  uniqueIndex('idx_escrow_claims_unique').on(t.chainId, t.txHash, t.logIndex),
]);

export const idxEscrowForfeits = pgTable('idx_escrow_forfeits', {
  id:          serial('id').primaryKey(),
  chainId:     integer('chain_id').notNull(),
  txHash:      text('tx_hash').notNull(),
  logIndex:    integer('log_index').notNull(),
  asset:       text('asset').notNull(),
  usdcMoved:   numeric('usdc_moved', { precision: 78 }).notNull(),
  tokenMoved:  numeric('token_moved', { precision: 78 }).notNull(),
  wmonMoved:   numeric('wmon_moved', { precision: 78 }).notNull().default('0'),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  timestamp:   bigint('timestamp', { mode: 'bigint' }).notNull(),
}, (t) => [
  uniqueIndex('idx_escrow_forfeits_unique').on(t.chainId, t.txHash, t.logIndex),
]);

export const idxBuybacks = pgTable('idx_buybacks', {
  id:          serial('id').primaryKey(),
  chainId:     integer('chain_id').notNull(),
  txHash:      text('tx_hash').notNull(),
  logIndex:    integer('log_index').notNull(),
  asset:       text('asset').notNull(),
  usdcIn:      numeric('usdc_in', { precision: 78 }).notNull(),
  tokensBurned: numeric('tokens_burned', { precision: 78 }).notNull(),
  sourceTag:   integer('source_tag').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  timestamp:   bigint('timestamp', { mode: 'bigint' }).notNull(),
}, (t) => [
  uniqueIndex('idx_buybacks_unique').on(t.chainId, t.txHash, t.logIndex),
]);

export const idxBurns = pgTable('idx_burns', {
  id:          serial('id').primaryKey(),
  chainId:     integer('chain_id').notNull(),
  txHash:      text('tx_hash').notNull(),
  logIndex:    integer('log_index').notNull(),
  asset:       text('asset').notNull(),
  amount:      numeric('amount', { precision: 78 }).notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  timestamp:   bigint('timestamp', { mode: 'bigint' }).notNull(),
}, (t) => [
  uniqueIndex('idx_burns_unique').on(t.chainId, t.txHash, t.logIndex),
]);

export const idxPfrCollections = pgTable('idx_pfr_collections', {
  id:                  serial('id').primaryKey(),
  chainId:             integer('chain_id').notNull(),
  txHash:              text('tx_hash').notNull(),
  logIndex:            integer('log_index').notNull(),
  asset:               text('asset').notNull(),
  usdcForwarded:       numeric('usdc_forwarded', { precision: 78 }).notNull(),
  tokenForwarded:      numeric('token_forwarded', { precision: 78 }).notNull(),
  numeraireForwarded:  numeric('numeraire_forwarded', { precision: 78 }).notNull().default('0'),
  blockNumber:         bigint('block_number', { mode: 'bigint' }).notNull(),
  timestamp:           bigint('timestamp', { mode: 'bigint' }).notNull(),
}, (t) => [
  uniqueIndex('idx_pfr_collections_unique').on(t.chainId, t.txHash, t.logIndex),
]);

// ── fee_receipts (migration 0005) — off-chain launch fee + rate limit ────────
// One row per verified 10 MON payment to LAUNCH_FEE_TREASURY. A receipt is
// "unused" until the indexer consumes it with a Registered event whose register()
// tx was sent by the same launcher. One receipt = one token; a token is publicly
// listed iff some receipt has consumed_asset = token.
export const feeReceipts = pgTable('fee_receipts', {
  id:             serial('id').primaryKey(),
  chainId:        integer('chain_id').notNull(),
  txHash:         text('tx_hash').notNull(),                     // fee tx (lowercase); 'admin:<asset>' for admin listings
  launcher:       text('launcher').notNull(),                    // fee tx.from (lowercase)
  amountWei:      numeric('amount_wei', { precision: 78 }).notNull(),
  blockNumber:    bigint('block_number', { mode: 'bigint' }).notNull(),
  paidAt:         bigint('paid_at', { mode: 'bigint' }).notNull(), // fee block timestamp (s)
  source:         text('source').notNull().default('fee'),       // 'fee' | 'admin'
  verifiedAt:     timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
  consumedAsset:  text('consumed_asset'),                        // null = unused
  consumedTxHash: text('consumed_tx_hash'),                      // register() tx
  consumedRegTs:  bigint('consumed_reg_ts', { mode: 'bigint' }), // register block timestamp (s)
  consumedAt:     timestamp('consumed_at', { withTimezone: true }),
  note:           text('note'),
}, (t) => [
  uniqueIndex('fee_receipts_tx_hash_unique').on(t.txHash),
  uniqueIndex('fee_receipts_consumed_asset_unique').on(t.consumedAsset),
  index('fee_receipts_launcher_idx').on(t.launcher, t.consumedAsset),
]);

export type FeeReceipt = typeof feeReceipts.$inferSelect;
export type NewFeeReceipt = typeof feeReceipts.$inferInsert;

// ── signed_requests (migration 0007) — replay protection for creator-signed requests ──
export const signedRequests = pgTable('signed_requests', {
  messageHash: text('message_hash').primaryKey(),   // keccak256 of the signed message
  signer:      text('signer').notNull(),
  purpose:     text('purpose').notNull(),           // 'service_create' | 'service_update'
  issuedAt:    bigint('issued_at', { mode: 'bigint' }).notNull(),
  usedAt:      timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
});
