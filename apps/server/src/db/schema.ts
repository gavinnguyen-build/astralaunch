import { pgTable, text, integer, boolean, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  twitter:     text('twitter'),
  launchedAt:  timestamp('launched_at').notNull().defaultNow(),
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
  upstreamSecret: text('upstream_secret').notNull(), // HMAC key for X-Revpad-Signature
  timeoutSeconds: integer('timeout_seconds').notNull().default(20),
  requestSchema:  text('request_schema'),
  responseSchema: text('response_schema'),
  description:    text('description'),
  active:         boolean('active').notNull().default(true),
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
