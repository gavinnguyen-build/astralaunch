/**
 * Every timestamp column is TIMESTAMPTZ in SQL and withTimezone in drizzle (D-TS1).
 * Runs in a non-UTC zone: the original bug only showed when the host was not UTC.
 */
process.env.TZ = 'Asia/Ho_Chi_Minh';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema.js';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';

const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => v instanceof PgTable);

describe('timestamps are timestamptz everywhere', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeAll(async () => { ({ db, close } = await createTestDb()); });
  afterAll(async () => { await close(); });

  it('host is not UTC during this test', () => {
    expect(new Date('2026-01-01T00:00:00Z').getTimezoneOffset()).toBe(-420);
  });

  it('drizzle: every timestamp column is declared withTimezone', () => {
    const bad = tables.flatMap(t => getTableConfig(t).columns
      .filter(c => c.columnType === 'PgTimestamp' && !(c as unknown as { withTimezone: boolean }).withTimezone)
      .map(c => `${getTableConfig(t).name}.${c.name}`));
    expect(bad).toEqual([]);
  });

  it('SQL after all migrations: no "timestamp without time zone" columns', async () => {
    const res = await db.execute(sql`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`);
    expect(res.rows).toEqual([]);
  });

  it('services / gateway_requests / idx_checkpoints round-trip the exact instant', async () => {
    const at = new Date('2026-09-25T13:08:32.431Z');
    const [svc] = await db.insert(schema.services).values({
      slug: 'ts', name: 'ts', asset: '0x' + 'a'.repeat(40), router: '0x' + 'b'.repeat(40), creator: '0x' + 'c'.repeat(40),
      upstreamUrl: 'https://x.example', priceUsdc: '1', upstreamSecret: 's', createdAt: at, updatedAt: at,
    }).returning();
    await db.insert(schema.gatewayRequests).values({
      serviceId: svc!.id, asset: svc!.asset, payer: '0x' + 'd'.repeat(40), amountUsdc: '1', createdAt: at,
    });
    await db.insert(schema.idxCheckpoints).values({ contractSet: 'static', blockNumber: 1n, updatedAt: at });

    const [s] = await db.select().from(schema.services).where(eq(schema.services.id, svc!.id));
    const [g] = await db.select().from(schema.gatewayRequests);
    const [c] = await db.select().from(schema.idxCheckpoints);
    expect([s!.createdAt, s!.updatedAt, g!.createdAt, c!.updatedAt].map(d => d.toISOString()))
      .toEqual(Array(4).fill(at.toISOString()));

    const raw = await db.execute(sql`SELECT to_char(created_at AT TIME ZONE 'UTC', 'HH24:MI') AS t FROM services`);
    expect(raw.rows[0]).toEqual({ t: '13:08' });
  });
});
