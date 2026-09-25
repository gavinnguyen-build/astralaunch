import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../../../server/src/__tests__/helpers/pgliteDb.js';
import { tokens, feeReceipts, hiddenTokens } from '../../../server/src/db/schema.js';
import { loadTargets, loadListedTargets, targetSource } from '../targets.js';

const USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
const POOL = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');

let db: TestDb;
let close: () => Promise<void>;
let receiptSeq = 0;

async function register(n: number) {
  await db.insert(tokens).values({
    asset: addr(0xa00 + n), name: `T${n}`, symbol: `T${n}`, creator: addr(0xc00 + n),
    router: addr(0xb00 + n), numeraire: USDC, poolId: POOL(n),
    launchedAt: new Date(1_700_000_000_000 + n * 1000),
  });
}

/** Consume a launch-fee receipt for token n (what the indexer does on Registered). */
async function list(n: number) {
  receiptSeq += 1;
  await db.insert(feeReceipts).values({
    chainId: 143, txHash: `0x${receiptSeq.toString(16).padStart(64, '0')}`, launcher: addr(0xd00 + n),
    amountWei: '10000000000000000000', blockNumber: 1n, paidAt: 1n, consumedAsset: addr(0xa00 + n),
  });
}

async function hide(n: number) {
  await db.insert(hiddenTokens).values({ asset: addr(0xa00 + n), reason: 'spam' });
}

const env = (e: Record<string, string> = {}) => e as NodeJS.ProcessEnv;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

describe('loadListedTargets', () => {
  it('returns only listed tokens, with router, numeraire and pool id', async () => {
    await register(1); await list(1);
    await register(2);                      // registered on-chain, launch fee never paid → unlisted
    const targets = await loadListedTargets(db);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.asset.toLowerCase()).toBe(addr(0xa01));
    expect(targets[0]!.router.toLowerCase()).toBe(addr(0xb01));
    expect(targets[0]!.numeraire).toBe('0x754704Bc059F8C67012fEd69BC8A327a5aafb603');   // checksummed
    expect(targets[0]!.poolId).toBe(POOL(1));
  });

  it('skips a hidden token even though its launch fee was consumed', async () => {
    await register(1); await list(1);
    await register(2); await list(2); await hide(2);
    const targets = await loadListedTargets(db);
    expect(targets.map(t => t.asset.toLowerCase())).toEqual([addr(0xa01)]);
  });

  it('picks up a newly listed token on the next load (no restart, no cache)', async () => {
    await register(1); await list(1);
    await register(2);
    expect((await loadTargets(env(), db)).map(t => t.asset.toLowerCase())).toEqual([addr(0xa01)]);

    await list(2);                          // listed between ticks
    expect((await loadTargets(env(), db)).map(t => t.asset.toLowerCase())).toEqual([addr(0xa01), addr(0xa02)]);

    await hide(1);                          // hidden between ticks
    expect((await loadTargets(env(), db)).map(t => t.asset.toLowerCase())).toEqual([addr(0xa02)]);

    await db.delete(hiddenTokens).where(eq(hiddenTokens.asset, addr(0xa01)));   // unhidden
    expect((await loadTargets(env(), db)).map(t => t.asset.toLowerCase())).toEqual([addr(0xa01), addr(0xa02)]);
  });

  it('leaves numeraire / poolId undefined for legacy rows without on-chain fields', async () => {
    await db.insert(tokens).values({
      asset: addr(0xa09), name: 'L', symbol: 'L', creator: addr(0xc09), router: addr(0xb09),
    });
    await list(9);
    const [t] = await loadListedTargets(db);
    expect(t!.numeraire).toBeUndefined();
    expect(t!.poolId).toBeUndefined();
  });
});

describe('ASSETS override', () => {
  it('ASSETS + ROUTERS: explicit pairs, no database', async () => {
    const targets = await loadTargets(env({ ASSETS: addr(0xa05), ROUTERS: addr(0xb05) }), null);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.asset.toLowerCase()).toBe(addr(0xa05));
    expect(targets[0]!.router.toLowerCase()).toBe(addr(0xb05));
    expect(targets[0]!.numeraire).toBeUndefined();
  });

  it('ASSETS alone: looks the rows up in the database, listed or not (debugging)', async () => {
    await register(1); await list(1);
    await register(2);                      // unlisted, but explicitly requested
    const targets = await loadTargets(env({ ASSETS: addr(0xa02).toUpperCase().replace('0X', '0x') }), db);
    expect(targets.map(t => t.asset.toLowerCase())).toEqual([addr(0xa02)]);
    expect(targets[0]!.router.toLowerCase()).toBe(addr(0xb02));
  });
});

describe('targetSource', () => {
  it('requires DATABASE_URL when there is no override', () => {
    expect(() => targetSource(env(), false)).toThrow(/DATABASE_URL is required/);
    expect(targetSource(env(), true).kind).toBe('db');
  });

  it('rejects malformed overrides', () => {
    expect(() => targetSource(env({ ASSETS: '0xnope' }), true)).toThrow(/Invalid address/);
    expect(() => targetSource(env({ ASSETS: addr(1), ROUTERS: `${addr(2)},${addr(3)}` }), true)).toThrow(/equal length/);
    expect(() => targetSource(env({ ROUTERS: addr(2) }), true)).toThrow(/without ASSETS/);
    expect(() => targetSource(env({ ASSETS: addr(1) }), false)).toThrow(/needs DATABASE_URL/);
  });

  it('selects the override kind', () => {
    expect(targetSource(env({ ASSETS: addr(1), ROUTERS: addr(2) }), false).kind).toBe('env-pairs');
    expect(targetSource(env({ ASSETS: addr(1) }), true).kind).toBe('env-assets');
  });
});
