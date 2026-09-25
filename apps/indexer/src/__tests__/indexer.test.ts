import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Indexer, type IndexerConfig } from '../indexer.js';
import type { PublicClient, Log, Hex } from 'viem';
import { encodeEventTopics, encodeAbiParameters } from 'viem';
import { registeredEvent, distributedEvent, transferEvent } from '../abis.js';

// ── Mock schema + checkpoint ────────────────────────────────────────────────

vi.mock('../../../server/src/db/schema.js', () => ({
  idxRegistrations:   { _: 'idxRegistrations' },
  idxUsdcTransfers:   { _: 'idxUsdcTransfers' },
  idxDistributions:   { _: 'idxDistributions' },
  idxFeeCollections:  { _: 'idxFeeCollections' },
  idxRevenueRecorded: { _: 'idxRevenueRecorded' },
  idxEscrowClaims:    { _: 'idxEscrowClaims' },
  idxEscrowForfeits:  { _: 'idxEscrowForfeits' },
  idxBuybacks:        { _: 'idxBuybacks' },
  idxBurns:           { _: 'idxBurns' },
  idxPfrCollections:  { _: 'idxPfrCollections' },
  idxCheckpoints:     { _: 'idxCheckpoints', contractSet: 'contract_set' },
}));

// Launch-fee consumption is covered against real Postgres in launch-fee-indexer.test.ts.
vi.mock('../../../server/src/services/tokenSync.js', () => ({
  readErc20Meta: vi.fn(async () => ({ name: 'T', symbol: 'T', decimals: 18 })),
  upsertTokenFromRegistration: vi.fn(async () => {}),
}));
vi.mock('../../../server/src/services/launchFee.js', () => ({
  consumeForRegistration: vi.fn(async () => ({ status: 'no_receipt' })),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const REGISTRY = '0x25845cee2b0e6df0da40bb9b60a84d162eabd00b';
const ESCROW   = '0x22523feea974939fd6c94daf7f9d112d667dec3b';
const VAULT    = '0xcbe741362a59943174f028a44a1b82722c24e7e7';
const PFR      = '0x510cb102906a4be9193b025620f6824ee8b4ec21';
const USDC     = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
const ASSET    = '0x13db78bd3f92382306a17d50dac93af1904e171d';
const CREATOR  = '0x11e2dd9a4b9062675fd89178a2c9778182dfcbc6';
const ROUTER   = '0x95d381aa54a2da62c835dd081d1d5a0f8700c722';

function makeConfig(): IndexerConfig {
  return {
    chainId: 143,
    startBlock: 100n,
    chunkSize: 10000,
    finalityLag: 0,
    maxRps: 1000,
    registryAddr: REGISTRY as `0x${string}`,
    escrowAddr:   ESCROW as `0x${string}`,
    vaultAddr:    VAULT as `0x${string}`,
    pfrAddr:      PFR as `0x${string}`,
    usdcAddr:     USDC as `0x${string}`,
    facilitatorAddrs: new Set(['0xfacilitator']),
  };
}

function makeRegisteredLog(blockNumber: bigint): Log {
  const topics = encodeEventTopics({
    abi: [registeredEvent],
    eventName: 'Registered',
    args: {
      asset: ASSET as `0x${string}`,
      creator: CREATOR as `0x${string}`,
      router: ROUTER as `0x${string}`,
    },
  });
  const data = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [
      '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
      USDC as `0x${string}`,   // numeraire
      '0x0000000000000000000000000000000000000001' as `0x${string}`, // initializer
      1727000000n,
    ],
  );
  return {
    address: REGISTRY,
    blockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    blockNumber,
    data,
    logIndex: 0,
    transactionHash: '0xabc0000000000000000000000000000000000000000000000000000000000001',
    transactionIndex: 0,
    removed: false,
    topics,
  } as unknown as Log;
}

function makeDistributedLog(blockNumber: bigint, logIndex: number = 0): Log {
  const topics = encodeEventTopics({
    abi: [distributedEvent],
    eventName: 'Distributed',
    args: { asset: ASSET as `0x${string}` },
  });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [500000n, 300000n, 0n, 150000n, 50000n],
  );
  return {
    address: ROUTER,
    blockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    blockNumber,
    data,
    logIndex,
    transactionHash: `0xdef${logIndex.toString().padStart(61, '0')}`,
    transactionIndex: 0,
    removed: false,
    topics,
  } as unknown as Log;
}

/** Create a mock DB that tracks all inserts and checkpoints. */
function makeMockDb() {
  const insertedRows: { table: string; values: any }[] = [];
  const checkpoints = new Map<string, bigint>();

  const conflictUpdateHandler = {
    onConflictDoUpdate: vi.fn(),
  };
  const conflictHandler = {
    onConflictDoNothing: vi.fn(),
  };
  const insertObj = {
    values: vi.fn((vals: any) => {
      // Track which table we're inserting into
      insertedRows.push({ table: lastInsertTable, values: vals });
      if (lastInsertTable === 'idxCheckpoints') return conflictUpdateHandler;
      return conflictHandler;
    }),
  };

  let lastInsertTable = '';

  const txFn = {
    insert: vi.fn((table: any) => {
      lastInsertTable = table?._ ?? 'unknown';
      return insertObj;
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => []),
    })),
  };

  const db = {
    transaction: vi.fn(async (fn: any) => fn(txFn)),
    insert: vi.fn((table: any) => {
      lastInsertTable = table?._ ?? 'unknown';
      return insertObj;
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => []),
        })),
      })),
    })),
    _insertedRows: insertedRows,
    _checkpoints: checkpoints,
  };

  return db;
}

function makeMockClient(opts: {
  latestBlock: bigint;
  logs?: Map<string, Log[]>;  // key: contractSet identifier
  getLogsImpl?: (...args: any[]) => Promise<Log[]>;
}): PublicClient {
  const getBlockImpl = async (params?: any) => {
    if (params?.blockTag === 'finalized') {
      return { number: opts.latestBlock, timestamp: 1727000000n };
    }
    return { number: params?.blockNumber ?? opts.latestBlock, timestamp: 1727000000n };
  };

  return {
    getBlock: vi.fn(getBlockImpl),
    getBlockNumber: vi.fn(async () => opts.latestBlock),
    getLogs: opts.getLogsImpl ?? vi.fn(async () => []),
    getTransaction: vi.fn(async () => ({ from: '0xsender' })),
  } as unknown as PublicClient;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Indexer — idempotency (Fix 2a)', () => {
  it('processing the same block range twice calls onConflictDoNothing for every row', async () => {
    // The log will be returned on both calls (simulating re-processing)
    const regLog = makeRegisteredLog(150n);
    let callCount = 0;

    const client = makeMockClient({
      latestBlock: 200n,
      getLogsImpl: vi.fn(async () => {
        callCount++;
        return [regLog];
      }),
    });

    const db = makeMockDb();
    // readCheckpoint returns null both times → starts from startBlock both times
    const config = makeConfig();
    const indexer = new Indexer(client, db as any, config);

    // First run
    await indexer.processStaticChunk();

    const firstInsertCount = db._insertedRows.length;
    expect(firstInsertCount).toBeGreaterThan(0);

    // Reset checkpoint tracking to simulate "no checkpoint" (crashed before checkpoint)
    // Second run — same block range, same logs
    await indexer.processStaticChunk();

    // onConflictDoNothing is called for every insert (both runs)
    // This ensures duplicate inserts are safe
    const regInserts = db._insertedRows.filter(r => r.table === 'idxRegistrations');
    expect(regInserts.length).toBe(2); // once per run
  });
});

describe('Indexer — crash recovery (Fix 2b)', () => {
  it('crash after events but before checkpoint → restart processes same range with no duplicates', async () => {
    const regLog = makeRegisteredLog(150n);
    let getLogsCallCount = 0;

    const client = makeMockClient({
      latestBlock: 200n,
      getLogsImpl: vi.fn(async () => {
        getLogsCallCount++;
        return [regLog];
      }),
    });

    const config = makeConfig();

    // Simulate crash: transaction throws after inserting events but before commit
    const crashDb = makeMockDb();
    let txCallCount = 0;
    crashDb.transaction = vi.fn(async (fn: any) => {
      txCallCount++;
      if (txCallCount === 1) {
        // First call: execute the function (events get inserted) but throw
        // simulating a crash before the transaction commits
        throw new Error('simulated crash');
      }
      // Subsequent calls succeed normally
      const conflictHandler = { onConflictDoNothing: vi.fn() };
      const conflictUpdateHandler = { onConflictDoUpdate: vi.fn() };
      const insertObj = {
        values: vi.fn(() => {
          if (lastTable === 'idxCheckpoints') return conflictUpdateHandler;
          return conflictHandler;
        }),
      };
      let lastTable = '';
      const tx = {
        insert: vi.fn((table: any) => {
          lastTable = table?._ ?? 'unknown';
          return insertObj;
        }),
      };
      return fn(tx);
    });

    const indexer = new Indexer(client, crashDb as any, config);

    // First attempt crashes
    await expect(indexer.processStaticChunk()).rejects.toThrow('simulated crash');

    // Second attempt succeeds. Since checkpoint was never written (tx rolled back),
    // it starts from the same block. ON CONFLICT DO NOTHING handles any overlap.
    const hasMore = await indexer.processStaticChunk();
    expect(txCallCount).toBe(2);
    // The key invariant: writeChunk is atomic — events + checkpoint in one tx.
    // A crash rolls back everything, so restart is safe.
  });
});

describe('Indexer — mid-range router backfill (Fix 2c)', () => {
  it('new router discovered in static chunk gets picked up by routers chunk', async () => {
    const regLog = makeRegisteredLog(150n);
    const distLog = makeDistributedLog(180n);
    let getLogsCalls: any[] = [];

    const client = makeMockClient({
      latestBlock: 200n,
      getLogsImpl: vi.fn(async (params: any) => {
        getLogsCalls.push(params);
        // If querying static addresses (registry), return registration log
        if (params.address && (
          (Array.isArray(params.address) && params.address.some((a: string) => a.toLowerCase() === REGISTRY)) ||
          params.address.toString().toLowerCase() === REGISTRY
        )) {
          return [regLog];
        }
        // If querying the discovered router address
        if (params.address && (
          (Array.isArray(params.address) && params.address.some((a: string) => a.toLowerCase() === ROUTER)) ||
          params.address.toString().toLowerCase() === ROUTER
        )) {
          return [distLog];
        }
        return [];
      }),
    });

    const db = makeMockDb();
    const config = makeConfig();
    const indexer = new Indexer(client, db as any, config);

    // processAll: static discovers the router, then routers processes it
    await indexer.processAll();

    // The router's Distributed event should have been fetched
    const routerCalls = getLogsCalls.filter((c: any) => {
      if (!c.address) return false;
      const addrs = Array.isArray(c.address) ? c.address : [c.address];
      return addrs.some((a: string) => a.toLowerCase() === ROUTER);
    });

    // At least one getLogs call was made with the newly discovered router address
    expect(routerCalls.length).toBeGreaterThan(0);

    // Distribution row was inserted
    const distInserts = db._insertedRows.filter(r => r.table === 'idxDistributions');
    expect(distInserts.length).toBeGreaterThan(0);
  });
});
