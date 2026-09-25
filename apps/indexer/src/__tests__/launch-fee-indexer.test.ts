/**
 * End-to-end on real Postgres (PGlite): the indexer reads the register() tx sender
 * as the launcher and consumes that launcher's fee receipt, even when the
 * Registered event's creator (fee recipient) is a different wallet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex, type Log, type PublicClient } from 'viem';
import { eq } from 'drizzle-orm';
import { LAUNCH_FEE_WEI } from '@astralaunch/shared';
import { Indexer, type IndexerConfig } from '../indexer.js';
import { registeredEvent } from '../abis.js';
import { createTestDb, type TestDb } from '../../../server/src/__tests__/helpers/pgliteDb.js';
import { feeReceipts, idxRegistrations } from '../../../server/src/db/schema.js';

const REGISTRY = '0x25845cee2b0e6df0da40bb9b60a84d162eabd00b';
const ASSET    = '0x13db78bd3f92382306a17d50dac93af1904e171d';
const CREATOR  = '0x11e2dd9a4b9062675fd89178a2c9778182dfcbc6'; // Registered.creator = fee recipient
const LAUNCHER = '0x3333333333333333333333333333333333333333'; // pays fee + sends register()
const ROUTER   = '0x95d381aa54a2da62c835dd081d1d5a0f8700c722';
const REG_TX   = '0xabc0000000000000000000000000000000000000000000000000000000000001';

const config: IndexerConfig = {
  chainId: 143, startBlock: 100n, chunkSize: 10_000, finalityLag: 0, maxRps: 1000,
  registryAddr: REGISTRY, escrowAddr: '0x22523feea974939fd6c94daf7f9d112d667dec3b',
  vaultAddr: '0xcbe741362a59943174f028a44a1b82722c24e7e7', pfrAddr: '0x510cb102906a4be9193b025620f6824ee8b4ec21',
  usdcAddr: '0x754704bc059f8c67012fed69bc8a327a5aafb603', facilitatorAddrs: new Set(),
};

function registeredLog(blockNumber: bigint): Log {
  return {
    address: REGISTRY, blockNumber, logIndex: 0, transactionHash: REG_TX, transactionIndex: 0, removed: false,
    blockHash: `0x${'0'.repeat(64)}`,
    topics: encodeEventTopics({ abi: [registeredEvent], eventName: 'Registered',
      args: { asset: ASSET, creator: CREATOR, router: ROUTER } }),
    data: encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [`0x${'0'.repeat(63)}1` as Hex, config.usdcAddr, '0x0000000000000000000000000000000000000001', 1727000000n]),
  } as unknown as Log;
}

function mockClient(regBlock: bigint): PublicClient {
  return {
    getBlock: vi.fn(async (p?: { blockTag?: string; blockNumber?: bigint }) =>
      ({ number: p?.blockNumber ?? 150n, timestamp: 1_800_000_000n })),
    getBlockNumber: vi.fn(async () => 150n),
    getLogs: vi.fn(async (p: { address?: string[] }) =>
      (p.address ?? []).map(a => a.toLowerCase()).includes(REGISTRY) ? [registeredLog(regBlock)] : []),
    getTransaction: vi.fn(async ({ hash }: { hash: string }) =>
      ({ from: hash === REG_TX ? '0x3333333333333333333333333333333333333333' : '0xother' })),
  } as unknown as PublicClient;
}

async function seedReceipt(db: TestDb, blockNumber: bigint) {
  await db.insert(feeReceipts).values({
    chainId: 143, txHash: `0x${'f'.repeat(64)}`, launcher: LAUNCHER, amountWei: LAUNCH_FEE_WEI.toString(),
    blockNumber, paidAt: 1_799_999_000n,
  });
}

describe('indexer launch-fee consumption (PGlite)', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeEach(async () => { ({ db, close } = await createTestDb()); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(async () => { vi.restoreAllMocks(); await close(); });

  it('fee recipient ≠ launcher: matched by register() sender and listed', async () => {
    await seedReceipt(db, 110n);
    const indexer = new Indexer(mockClient(120n), db as any, config);
    await indexer.init();
    await indexer.processStaticChunk();

    const [reg] = await db.select().from(idxRegistrations);
    expect(reg).toMatchObject({ asset: ASSET, creator: CREATOR, launcher: LAUNCHER });
    const [r] = await db.select().from(feeReceipts);
    expect(r).toMatchObject({ consumedAsset: ASSET, consumedTxHash: REG_TX, consumedRegTs: 1_800_000_000n });
  });

  it('no receipt: registration indexed but token stays unlisted', async () => {
    const indexer = new Indexer(mockClient(120n), db as any, config);
    await indexer.processStaticChunk();
    expect(await db.select().from(idxRegistrations)).toHaveLength(1);
    expect(await db.select().from(feeReceipts).where(eq(feeReceipts.consumedAsset, ASSET))).toHaveLength(0);
  });

  it('receipt paid after the register block is not consumed and stays unused', async () => {
    await seedReceipt(db, 130n);
    const indexer = new Indexer(mockClient(120n), db as any, config);
    await indexer.processStaticChunk();
    const [r] = await db.select().from(feeReceipts);
    expect(r!.consumedAsset).toBeNull();
  });
});
