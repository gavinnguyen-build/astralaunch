/**
 * Market indexing (D-MK1): v4 Swap / Initialize of registered pools, asset Transfers.
 * Decoder vectors are the real mainnet SIGHT / FEED buyback swaps (docs/VERIFICATION-market.md).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, toHex, type Hex, type Log, type PublicClient } from 'viem';
import { formatUnits } from 'viem';
import { decodePoolManagerLog } from '../decoder.js';
import { poolMeta } from '../pools.js';
import { v4SwapEvent, v4InitializeEvent } from '../v4abis.js';
import { registeredEvent, transferEvent } from '../abis.js';
import { Indexer, type IndexerConfig } from '../indexer.js';
import { createTestDb, type TestDb } from '../../../server/src/__tests__/helpers/pgliteDb.js';
import { idxSwaps, idxPoolInits, idxAssetTransfers } from '../../../server/src/db/schema.js';

const USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
const WMON = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a';
const VAULT = '0x394f1dca6011c16bc6e70ca13f6f29767d92171e';
const PM = '0x188d586ddcf52439676ca21a244753fa19f9ea8e';
const SIGHT = '0x30ae380593a04c14abfa994969b718a78a6105ad';
const SIGHT_POOL = '0xf5bfc441bd39a161b95c586e4d18f70be2d47d51b336a6cfce7856b69a6aafef';
const FEED = '0x2686619d5569aebcdfec774e8a2167de78376ddf';
const FEED_POOL = '0xd29e4604b4489a6be4d0b655089d4ca7c9852da4f11461ad3cbd73f4af34b816';

function swapLog(o: { pool: string; sender: string; a0: bigint; a1: bigint; sqrt: bigint; fee: number; block?: bigint; tx?: string; logIndex?: number }): Log {
  return {
    address: PM, blockNumber: o.block ?? 107924726n, logIndex: o.logIndex ?? 3, removed: false, transactionIndex: 0,
    transactionHash: (o.tx ?? `0x${'4c'.repeat(32)}`) as Hex, blockHash: `0x${'0'.repeat(64)}` as Hex,
    topics: encodeEventTopics({ abi: [v4SwapEvent], eventName: 'Swap', args: { id: o.pool as Hex, sender: o.sender as Hex } }),
    data: encodeAbiParameters(
      [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
      [o.a0, o.a1, o.sqrt, 10n ** 20n, -100, o.fee]),
  } as unknown as Log;
}

describe('decodePoolManagerLog (mainnet vectors)', () => {
  const pools = new Map([[SIGHT_POOL, poolMeta(SIGHT_POOL, SIGHT, USDC)], [FEED_POOL, poolMeta(FEED_POOL, FEED, WMON)]]);
  const lookup = (id: string) => pools.get(id.toLowerCase());

  it('SIGHT buyback 0x4cc6c725…: vault received SIGHT, paid 0.15 USDC; price ≈ 2.5376e-6 USDC', () => {
    const row = decodePoolManagerLog(swapLog({ pool: SIGHT_POOL, sender: VAULT, a0: 58006136615143254089104n, a1: -150000n,
      sqrt: 126208693145960762050n, fee: 20000 }), 143, 1n, lookup, VAULT, '0xkeeper');
    expect(row).toMatchObject({ type: 'swap', asset: SIGHT, numeraire: USDC, assetDelta: '58006136615143254089104',
      numeraireDelta: '-150000', isBuyback: true, fee: 20000, txFrom: '0xkeeper' });
    const price = Number(formatUnits(BigInt((row as { priceWad: string }).priceWad), 18));
    expect(price).toBeGreaterThan(2.53e-6);
    expect(price).toBeLessThan(2.54e-6);
  });

  it('FEED buyback 0x1e98eb5d… WMON hop: received FEED, paid 5.803 WMON; price ≈ 9.74e-5 WMON', () => {
    const row = decodePoolManagerLog(swapLog({ pool: FEED_POOL, sender: VAULT, a0: 58477659309040316579974n, a1: -5803155213300925504n,
      sqrt: 781843907451419845563008899n, fee: 20000 }), 143, 1n, lookup, VAULT);
    expect(row).toMatchObject({ assetDelta: '58477659309040316579974', numeraireDelta: '-5803155213300925504', isBuyback: true });
    const price = Number(formatUnits(BigInt((row as { priceWad: string }).priceWad), 18));
    expect(price).toBeGreaterThan(9.7e-5);
    expect(price).toBeLessThan(9.8e-5);
  });

  it('non-vault sender is a trade, not a buyback; unregistered pool is ignored', () => {
    const trade = decodePoolManagerLog(swapLog({ pool: SIGHT_POOL, sender: '0x' + '9'.repeat(40), a0: -(10n ** 21n), a1: 2000n,
      sqrt: 126208693145960762050n, fee: 20000 }), 143, 1n, lookup, VAULT);
    expect(trade).toMatchObject({ isBuyback: false, assetDelta: '-1000000000000000000000', numeraireDelta: '2000' });
    // the MON/USDC hop of the FEED buyback is not a registered pool
    expect(decodePoolManagerLog(swapLog({ pool: '0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954', sender: VAULT,
      a0: 5803155213300925504n, a1: -150000n, sqrt: 12734577146150252234676n, fee: 500 }), 143, 1n, lookup, VAULT)).toBeNull();
  });
});

// ── End-to-end (PGlite) ──────────────────────────────────────────────────────

const REGISTRY = '0x6b3a79c723ab69f8938c87209e1d9730c739e00c';
const config: IndexerConfig = {
  chainId: 143, startBlock: 100n, chunkSize: 10_000, finalityLag: 0, maxRps: 1000,
  registryAddr: REGISTRY, escrowAddr: '0x22523feea974939fd6c94daf7f9d112d667dec3b', vaultAddr: VAULT,
  pfrAddr: '0x510cb102906a4be9193b025620f6824ee8b4ec21', usdcAddr: USDC, facilitatorAddrs: new Set(),
  poolManagerAddr: PM, swapLookbackBlocks: 1000,
};

function registeredLog(block: bigint): Log {
  return {
    address: REGISTRY, blockNumber: block, logIndex: 0, transactionHash: `0x${'aa'.repeat(32)}`, transactionIndex: 0,
    removed: false, blockHash: `0x${'0'.repeat(64)}`,
    topics: encodeEventTopics({ abi: [registeredEvent], eventName: 'Registered', args: { asset: SIGHT, creator: `0x${'1'.repeat(40)}`, router: `0x${'2'.repeat(40)}` } }),
    data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [SIGHT_POOL as Hex, USDC, '0x0000000000000000000000000000000000000001', 1n]),
  } as unknown as Log;
}
const initLog = (block: bigint): Log => ({
  address: PM, blockNumber: block, logIndex: 1, transactionHash: `0x${'bb'.repeat(32)}`, transactionIndex: 0, removed: false,
  blockHash: `0x${'0'.repeat(64)}`,
  topics: encodeEventTopics({ abi: [v4InitializeEvent], eventName: 'Initialize', args: { id: SIGHT_POOL as Hex, currency0: SIGHT, currency1: USDC } }),
  data: encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }],
    [20000, 200, '0x580ca49389d83b019d07E17e99454f2F218e2dc0', 126208693145960762050n, -300000]),
} as unknown as Log);
const mintLog = (block: bigint): Log => ({
  address: SIGHT, blockNumber: block, logIndex: 2, transactionHash: `0x${'bb'.repeat(32)}`, transactionIndex: 0, removed: false,
  blockHash: `0x${'0'.repeat(64)}`,
  topics: encodeEventTopics({ abi: [transferEvent], eventName: 'Transfer', args: { from: '0x0000000000000000000000000000000000000000', to: PM } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [10n ** 27n]),
} as unknown as Log);

/** RPC-shaped log for client.request('eth_getLogs'). */
const rpc = (l: Log) => ({ ...l, blockNumber: toHex(l.blockNumber!), logIndex: toHex(l.logIndex!), transactionIndex: toHex(0) });

function mockClient(head: bigint, logs: { reg: Log[]; pm: Log[]; asset: Log[] }): PublicClient {
  const inRange = (l: Log, f: bigint, t: bigint) => l.blockNumber! >= f && l.blockNumber! <= t;
  return {
    getBlock: vi.fn(async (p?: { blockNumber?: bigint }) => ({ number: p?.blockNumber ?? head, timestamp: 1_800_000_000n + (p?.blockNumber ?? 0n) })),
    getBlockNumber: vi.fn(async () => head),
    getLogs: vi.fn(async (p: { address: string | string[]; fromBlock: bigint; toBlock: bigint }) => {
      const addrs = [p.address].flat().map(a => a.toLowerCase());
      if (addrs.includes(REGISTRY)) return logs.reg.filter(l => inRange(l, p.fromBlock, p.toBlock));
      if (addrs.includes(SIGHT)) return logs.asset.filter(l => inRange(l, p.fromBlock, p.toBlock));
      return [];
    }),
    request: vi.fn(async ({ params: [f] }: { params: [{ fromBlock: Hex; toBlock: Hex; topics: (Hex | Hex[])[] }] }) => {
      const ids = (f.topics[1] as Hex[]).map(x => x.toLowerCase());
      return logs.pm.filter(l => ids.includes(l.topics[1]!.toLowerCase()) && inRange(l, BigInt(f.fromBlock), BigInt(f.toBlock))).map(rpc);
    }),
    getTransaction: vi.fn(async () => ({ from: '0x' + '7'.repeat(40) })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      ({ name: 'nullsight', symbol: 'SIGHT', decimals: 18 } as Record<string, unknown>)[functionName]),
  } as unknown as PublicClient;
}

describe('indexer market sets (PGlite)', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeEach(async () => { ({ db, close } = await createTestDb()); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(async () => { vi.restoreAllMocks(); await close(); });

  const logs = {
    reg: [registeredLog(150n)],
    pm: [initLog(140n), swapLog({ pool: SIGHT_POOL, sender: '0x' + '5'.repeat(40), a0: 10n ** 21n, a1: -2600n, sqrt: 126208693145960762050n, fee: 20000, block: 145n, tx: `0x${'c1'.repeat(32)}` }),
         swapLog({ pool: SIGHT_POOL, sender: VAULT, a0: 58006136615143254089104n, a1: -150000n, sqrt: 126208693145960762050n, fee: 20000, block: 170n, tx: `0x${'c2'.repeat(32)}` })],
    asset: [mintLog(140n)],
  };

  it('backfill from start: pool init, trade before register, buyback after, launch mint', async () => {
    const ix = new Indexer(mockClient(200n, logs), db as any, config);
    await ix.init();
    await ix.processAll();
    const swaps = await db.select().from(idxSwaps).orderBy(idxSwaps.blockNumber);
    expect(swaps.map(s => [s.blockNumber, s.isBuyback, s.txFrom])).toEqual([[145n, false, '0x' + '7'.repeat(40)], [170n, true, '0x' + '7'.repeat(40)]]);
    expect(await db.select().from(idxPoolInits)).toHaveLength(1);
    expect((await db.select().from(idxAssetTransfers))[0]).toMatchObject({ toAddr: PM, value: (10n ** 27n).toString() });
  });

  it('pool discovered after the swaps set passed its launch → look-back backfill picks up init, trade and mint', async () => {
    // First run: no registration yet, so the pool is unknown while the sets advance to 160.
    const early = mockClient(160n, { reg: [], pm: logs.pm, asset: logs.asset });
    const ix1 = new Indexer(early, db as any, config);
    await ix1.init();
    await ix1.processAll();
    // Simulate the swaps / asset sets having already passed block 160 (e.g. other pools exist).
    await db.execute(`INSERT INTO idx_checkpoints (contract_set, block_number) VALUES ('swaps', 160), ('asset_transfers', 160)
      ON CONFLICT (contract_set) DO UPDATE SET block_number = 160` as any);
    // register() lands at 180, after every set passed 160; launch (140) and a trade (145) were before.
    const late = { ...logs, reg: [registeredLog(180n)] };
    const ix2 = new Indexer(mockClient(200n, late), db as any, config);
    await ix2.init();
    await ix2.processAll();
    const swaps = await db.select().from(idxSwaps).orderBy(idxSwaps.blockNumber);
    expect(swaps.map(s => s.blockNumber)).toEqual([145n, 170n]);   // 145 via look-back, 170 via the set
    expect(await db.select().from(idxPoolInits)).toHaveLength(1);
    expect(await db.select().from(idxAssetTransfers)).toHaveLength(1);
  });
});
