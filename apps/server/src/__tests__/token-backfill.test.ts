import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';
import { idxRegistrations, tokens } from '../db/schema.js';
import { backfillTokensFromRegistrations } from '../services/tokenSync.js';

const SIGHT = '0x30ae380593a04c14abfa994969b718a78a6105ad';
const FEED  = '0x2686619d5569aebcdfec774e8a2167de78376ddf';
const DEPLOYER = '0x4444444444444444444444444444444444444444';
const META: Record<string, Record<string, unknown>> = {
  [SIGHT]: { name: 'nullsight', symbol: 'SIGHT', decimals: 18 },
  [FEED]:  { name: 'nullfeed',  symbol: 'FEED',  decimals: 18 },
};
const client = {
  readContract: async ({ address, functionName }: { address: string; functionName: string }) => META[address]![functionName],
  getTransaction: async () => ({ from: DEPLOYER }),
};

describe('tokens backfill from idx_registrations', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    // Pre-0005 rows: launcher unknown ('').
    for (const [i, asset] of [SIGHT, FEED].entries()) {
      await db.insert(idxRegistrations).values({
        chainId: 143, txHash: '0x' + String(i + 1).repeat(64), logIndex: 0, asset, creator: '0x' + '2'.repeat(40),
        router: '0x' + String(i + 5).repeat(40), poolId: '0x' + 'a'.repeat(64), numeraire: '', initializer: '',
        blockNumber: 100n + BigInt(i), timestamp: 1_800_000_000n + BigInt(i),
      });
    }
  });
  afterEach(async () => { await close(); });

  it('dry run writes nothing', async () => {
    const lines = await backfillTokensFromRegistrations(db, client, false);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/SIGHT.*would create/);
    expect(await db.select().from(tokens)).toHaveLength(0);
  });

  it('--yes creates rows for every registration, fills launcher, and is idempotent', async () => {
    await backfillTokensFromRegistrations(db, client, true);
    await db.update(tokens).set({ description: 'kept' });
    const again = await backfillTokensFromRegistrations(db, client, true);
    expect(again.every(l => l.endsWith('refreshed'))).toBe(true);

    const rows = await db.select().from(tokens).orderBy(tokens.registeredBlock);
    expect(rows.map(r => [r.asset, r.symbol, r.launcher, r.description])).toEqual([
      [SIGHT, 'SIGHT', DEPLOYER, 'kept'],
      [FEED,  'FEED',  DEPLOYER, 'kept'],
    ]);
    const regs = await db.select().from(idxRegistrations);
    expect(regs.every(r => r.launcher === DEPLOYER)).toBe(true);
  });
});
