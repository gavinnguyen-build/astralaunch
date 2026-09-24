import type { PublicClient, Hex } from 'viem';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ChunkManager } from './fetcher.js';
import { readCheckpoint } from './checkpoint.js';
import { writeChunk } from './writer.js';
import { RouterRegistry } from './discovery.js';
import {
  decodeStaticLog,
  decodeRouterLog,
  decodeTransferLog,
  type DecodedRow,
} from './decoder.js';
import { staticEvents, routerEvents, usdcEvents } from './abis.js';
import type { Log } from 'viem';

export interface IndexerConfig {
  chainId:         number;
  startBlock:      bigint;
  chunkSize:       number;
  finalityLag:     number;
  maxRps:          number;
  registryAddr:    `0x${string}`;
  escrowAddr:      `0x${string}`;
  vaultAddr:       `0x${string}`;
  pfrAddr:         `0x${string}`;
  usdcAddr:        `0x${string}`;
  facilitatorAddrs: ReadonlySet<string>;
}

/**
 * Orchestrator: processes chunks for each contract set, manages discovery.
 */
export class Indexer {
  private fetcher: ChunkManager;
  private registry: RouterRegistry;
  private blockTimestampCache = new Map<bigint, bigint>();

  constructor(
    private client: PublicClient,
    private db: PostgresJsDatabase<any>,
    private config: IndexerConfig,
  ) {
    this.fetcher = new ChunkManager(client, config.chunkSize, config.maxRps);
    this.registry = new RouterRegistry();
  }

  /** Initialize: load known routers from DB. */
  async init(): Promise<void> {
    await this.registry.load(this.db);
    console.log(`[indexer] Loaded ${this.registry.size} known router(s)`);
  }

  /**
   * Get the latest safe block to index up to.
   * Tries the 'finalized' block tag first (EIP-4895).
   * Fallback: latest block number minus FINALITY_LAG.
   */
  private async getLatestBlock(): Promise<bigint> {
    // ← Fix 1: use 'finalized' block tag, fallback to latest - lag
    try {
      const finalized = await this.client.getBlock({ blockTag: 'finalized' });
      return finalized.number;
    } catch {
      // RPC doesn't support 'finalized' tag — fallback
      const head = await this.client.getBlockNumber();
      return head - BigInt(this.config.finalityLag);
    }
  }

  /** Get block timestamp, cached. */
  private async getBlockTimestamp(blockNumber: bigint): Promise<bigint> {
    const cached = this.blockTimestampCache.get(blockNumber);
    if (cached !== undefined) return cached;

    const block = await this.client.getBlock({ blockNumber });
    const ts = block.timestamp;
    this.blockTimestampCache.set(blockNumber, ts);

    // Evict old entries to prevent memory leak
    if (this.blockTimestampCache.size > 1000) {
      const first = this.blockTimestampCache.keys().next().value!;
      this.blockTimestampCache.delete(first);
    }

    return ts;
  }

  /** Get timestamps for all unique block numbers in a set of logs. */
  private async getBlockTimestamps(logs: Log[]): Promise<Map<bigint, bigint>> {
    const blocks = new Set(logs.map(l => l.blockNumber!));
    const result = new Map<bigint, bigint>();
    for (const bn of blocks) {
      result.set(bn, await this.getBlockTimestamp(bn));
    }
    return result;
  }

  /**
   * For a set of logs, fetch their transaction senders (tx.from).
   * Returns map of txHash → sender address (lowercase).
   */
  private async getTxSenders(logs: Log[]): Promise<Map<string, string>> {
    const txHashes = new Set(logs.map(l => l.transactionHash!));
    const result = new Map<string, string>();
    for (const hash of txHashes) {
      const tx = await this.client.getTransaction({ hash: hash as Hex });
      result.set(hash, tx.from.toLowerCase());
    }
    return result;
  }

  /**
   * Process a single chunk for the static contract set.
   * Returns true if there are more blocks to process.
   */
  async processStaticChunk(): Promise<boolean> {
    const latestBlock = await this.getLatestBlock();
    const checkpoint = await readCheckpoint(this.db, 'static');
    const fromBlock = checkpoint !== null ? checkpoint + 1n : this.config.startBlock;

    if (fromBlock > latestBlock) return false;

    const addresses = [
      this.config.registryAddr,
      this.config.escrowAddr,
      this.config.vaultAddr,
      this.config.pfrAddr,
    ];

    const { logs, toBlock } = await this.fetcher.getLogs({
      fromBlock,
      toBlock: latestBlock,
      address: addresses,
      events: staticEvents,
    });

    const timestamps = await this.getBlockTimestamps(logs);
    const rows: DecodedRow[] = [];

    for (const log of logs) {
      const ts = timestamps.get(log.blockNumber!)!;
      const row = decodeStaticLog(
        log,
        this.config.chainId,
        ts,
        this.config.escrowAddr,
        this.config.vaultAddr,
      );
      if (row) {
        rows.push(row);
        if (row.type === 'registration') {
          const isNew = this.registry.add(row.router, row.asset);
          if (isNew) {
            console.log(`[indexer] New router discovered: ${row.router} (asset: ${row.asset})`);
          }
        }
      }
    }

    await writeChunk(this.db, rows, 'static', toBlock);

    if (rows.length > 0) {
      console.log(`[indexer] static ${fromBlock}→${toBlock}: ${rows.length} event(s)`);
    }

    return toBlock < latestBlock;
  }

  /**
   * Process a single chunk for the routers contract set.
   * Returns true if there are more blocks to process.
   */
  async processRoutersChunk(): Promise<boolean> {
    const routers = this.registry.getRouterAddresses();
    if (routers.length === 0) return false;

    const latestBlock = await this.getLatestBlock();
    const checkpoint = await readCheckpoint(this.db, 'routers');
    const fromBlock = checkpoint !== null ? checkpoint + 1n : this.config.startBlock;

    if (fromBlock > latestBlock) return false;

    const { logs, toBlock } = await this.fetcher.getLogs({
      fromBlock,
      toBlock: latestBlock,
      address: routers,
      events: routerEvents,
    });

    const timestamps = await this.getBlockTimestamps(logs);
    const rows: DecodedRow[] = [];

    for (const log of logs) {
      const ts = timestamps.get(log.blockNumber!)!;
      const row = decodeRouterLog(log, this.config.chainId, ts);
      if (row) rows.push(row);
    }

    await writeChunk(this.db, rows, 'routers', toBlock);

    if (rows.length > 0) {
      console.log(`[indexer] routers ${fromBlock}→${toBlock}: ${rows.length} event(s)`);
    }

    return toBlock < latestBlock;
  }

  /**
   * Process a single chunk for the USDC transfers contract set.
   * Enriches each transfer with tx.from and is_facilitator_settled.
   * Returns true if there are more blocks to process.
   */
  async processUsdcChunk(): Promise<boolean> {
    const routers = this.registry.getRouterAddresses();
    if (routers.length === 0) return false;

    const latestBlock = await this.getLatestBlock();
    const checkpoint = await readCheckpoint(this.db, 'usdc_transfers');
    const fromBlock = checkpoint !== null ? checkpoint + 1n : this.config.startBlock;

    if (fromBlock > latestBlock) return false;

    const { logs, toBlock } = await this.fetcher.getLogs({
      fromBlock,
      toBlock: latestBlock,
      address: [this.config.usdcAddr],
      events: usdcEvents,
      topics: [null, null, routers],
    });

    const timestamps = await this.getBlockTimestamps(logs);
    // ← Fix 4: fetch tx senders for facilitator flag
    const txSenders = logs.length > 0 ? await this.getTxSenders(logs) : new Map<string, string>();
    const rows: DecodedRow[] = [];

    for (const log of logs) {
      const ts = timestamps.get(log.blockNumber!)!;
      const txFrom = txSenders.get(log.transactionHash!) ?? '';
      const isFacilitator = this.config.facilitatorAddrs.has(txFrom);
      const row = decodeTransferLog(log, this.config.chainId, ts, txFrom, isFacilitator);
      if (row) rows.push(row);
    }

    await writeChunk(this.db, rows, 'usdc_transfers', toBlock);

    if (rows.length > 0) {
      console.log(`[indexer] usdc_transfers ${fromBlock}→${toBlock}: ${rows.length} event(s)`);
    }

    return toBlock < latestBlock;
  }

  /**
   * Run one full cycle: process all contract sets until caught up.
   * Returns true if any work was done.
   */
  async processAll(): Promise<boolean> {
    let didWork = false;

    // Process static first (may discover new routers)
    while (await this.processStaticChunk()) {
      didWork = true;
    }

    // Process router events
    while (await this.processRoutersChunk()) {
      didWork = true;
    }

    // Process USDC transfers
    while (await this.processUsdcChunk()) {
      didWork = true;
    }

    return didWork;
  }

  /**
   * Backfill mode: run processAll to completion, then exit.
   */
  async backfill(): Promise<void> {
    console.log(`[indexer] Backfill starting from block ${this.config.startBlock}`);
    const start = Date.now();

    await this.processAll();

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[indexer] Backfill complete in ${elapsed}s`);
  }

  /**
   * Follow mode: poll for new blocks every intervalMs.
   */
  async follow(intervalMs: number): Promise<never> {
    console.log(`[indexer] Follow mode — polling every ${intervalMs / 1000}s`);

    while (true) {
      try {
        await this.processAll();
      } catch (err) {
        console.error('[indexer] Error in follow loop:', err);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
}
