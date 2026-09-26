import type { PublicClient, Hex } from 'viem';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ChunkManager } from './fetcher.js';
import { readCheckpoint } from './checkpoint.js';
import { writeChunk } from './writer.js';
import { RouterRegistry } from './discovery.js';
import { PoolRegistry } from './pools.js';
import { poolManagerEvents, SWAP_TOPIC, INITIALIZE_TOPIC } from './v4abis.js';
import {
  decodeStaticLog,
  decodeRouterLog,
  decodeTransferLog,
  decodePoolManagerLog,
  decodeAssetTransferLog,
  type DecodedRow,
  type RegistrationRow,
} from './decoder.js';
import { staticEvents, routerEvents, usdcEvents } from './abis.js';
import type { Log } from 'viem';
import { readErc20Meta } from '../../server/src/services/tokenSync.js';

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
  /** Uniswap v4 PoolManager (swaps + pool inits of registered pools). */
  poolManagerAddr?: `0x${string}`;
  /** On new pool discovery, backfill its swaps/transfers from registration block minus this. */
  swapLookbackBlocks?: number;
}

/**
 * Orchestrator: processes chunks for each contract set, manages discovery.
 */
export class Indexer {
  private fetcher: ChunkManager;
  private registry: RouterRegistry;
  private pools = new PoolRegistry();
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
    await this.pools.load(this.db);
    console.log(`[indexer] Loaded ${this.registry.size} known router(s), ${this.pools.size} pool(s)`);
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
    const newPools: RegistrationRow[] = [];

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
          if (row.numeraire && this.pools.add(row.poolId, row.asset, row.numeraire)) newPools.push(row);
          const isNew = this.registry.add(row.router, row.asset);
          if (isNew) {
            console.log(`[indexer] New router discovered: ${row.router} (asset: ${row.asset})`);
          }
        }
      }
    }

    // Launcher = register() tx sender, never the event's creator field (D-LF3).
    const regRows = rows.filter((r): r is RegistrationRow => r.type === 'registration');
    if (regRows.length > 0) {
      const senders = await this.getTxSenders(regRows.map(r => ({ transactionHash: r.txHash }) as Log));
      for (const r of regRows) {
        r.launcher = senders.get(r.txHash) ?? '';
        // tokens row comes from chain, never from a client call (D-TK1).
        r.token = await readErc20Meta(this.client, r.asset);
      }
    }

    await writeChunk(this.db, rows, 'static', toBlock);

    if (rows.length > 0) {
      console.log(`[indexer] static ${fromBlock}→${toBlock}: ${rows.length} event(s)`);
    }

    // Trades (and the launch mint / pool init) can happen between launch and register():
    // backfill a newly discovered pool over the range the swaps/transfers sets already passed.
    for (const reg of newPools) await this.backfillNewPool(reg);

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

  private get swapsEnabled(): boolean { return !!this.config.poolManagerAddr; }

  /** Decode PoolManager logs (with trader = tx.from for swaps). */
  private async decodePoolLogs(logs: Log[]): Promise<DecodedRow[]> {
    const timestamps = await this.getBlockTimestamps(logs);
    const swapLogs = logs.filter(l => l.topics[0]?.toLowerCase() === SWAP_TOPIC.toLowerCase());
    const senders = swapLogs.length > 0 ? await this.getTxSenders(swapLogs) : new Map<string, string>();
    const rows: DecodedRow[] = [];
    for (const log of logs) {
      const row = decodePoolManagerLog(log, this.config.chainId, timestamps.get(log.blockNumber!)!,
        (id) => this.pools.get(id), this.config.vaultAddr, senders.get(log.transactionHash!) ?? '');
      if (row) rows.push(row);
    }
    return rows;
  }

  private async decodeAssetLogs(logs: Log[]): Promise<DecodedRow[]> {
    const timestamps = await this.getBlockTimestamps(logs);
    return logs.flatMap(l => decodeAssetTransferLog(l, this.config.chainId, timestamps.get(l.blockNumber!)!) ?? []);
  }

  /** Swap + Initialize events of registered pools only (filtered by pool id). */
  async processSwapsChunk(): Promise<boolean> {
    if (!this.swapsEnabled || this.pools.size === 0) return false;
    const latestBlock = await this.getLatestBlock();
    const checkpoint = await readCheckpoint(this.db, 'swaps');
    const fromBlock = checkpoint !== null ? checkpoint + 1n : this.config.startBlock;
    if (fromBlock > latestBlock) return false;

    const { logs, toBlock } = await this.fetcher.getLogs({
      fromBlock, toBlock: latestBlock, address: this.config.poolManagerAddr!, events: poolManagerEvents,
      rawTopics: [[SWAP_TOPIC, INITIALIZE_TOPIC], this.pools.poolIds()],
    });
    const rows = await this.decodePoolLogs(logs);
    await writeChunk(this.db, rows, 'swaps', toBlock);
    if (rows.length > 0) console.log(`[indexer] swaps ${fromBlock}→${toBlock}: ${rows.length} event(s)`);
    return toBlock < latestBlock;
  }

  /** ERC-20 Transfer events of registered assets (holders). */
  async processAssetTransfersChunk(): Promise<boolean> {
    if (!this.swapsEnabled || this.pools.size === 0) return false;
    const latestBlock = await this.getLatestBlock();
    const checkpoint = await readCheckpoint(this.db, 'asset_transfers');
    const fromBlock = checkpoint !== null ? checkpoint + 1n : this.config.startBlock;
    if (fromBlock > latestBlock) return false;

    const { logs, toBlock } = await this.fetcher.getLogs({
      fromBlock, toBlock: latestBlock, address: this.pools.assets(), events: usdcEvents,
    });
    const rows = await this.decodeAssetLogs(logs);
    await writeChunk(this.db, rows, 'asset_transfers', toBlock);
    if (rows.length > 0) console.log(`[indexer] asset_transfers ${fromBlock}→${toBlock}: ${rows.length} event(s)`);
    return toBlock < latestBlock;
  }

  /**
   * Targeted backfill for a pool discovered after the swaps / asset_transfers sets already
   * moved past its launch: [registration - lookback, checkpoint] for that pool / asset only.
   */
  async backfillNewPool(reg: RegistrationRow): Promise<void> {
    if (!this.swapsEnabled) return;
    const lookback = BigInt(this.config.swapLookbackBlocks ?? 20_000);
    let from = reg.blockNumber > lookback ? reg.blockNumber - lookback : 0n;
    if (from < this.config.startBlock) from = this.config.startBlock;

    const sets = [
      { set: 'swaps', fetch: (f: bigint, t: bigint) => this.fetcher.getLogs({ fromBlock: f, toBlock: t,
          address: this.config.poolManagerAddr!, events: poolManagerEvents, rawTopics: [[SWAP_TOPIC, INITIALIZE_TOPIC], [reg.poolId as Hex]] }),
        decode: (logs: Log[]) => this.decodePoolLogs(logs) },
      { set: 'asset_transfers', fetch: (f: bigint, t: bigint) => this.fetcher.getLogs({ fromBlock: f, toBlock: t,
          address: reg.asset as `0x${string}`, events: usdcEvents }),
        decode: (logs: Log[]) => this.decodeAssetLogs(logs) },
    ];
    for (const { set, fetch, decode } of sets) {
      const cp = await readCheckpoint(this.db, set);
      if (cp === null || cp < from) continue; // the set itself will reach this range
      let n = 0;
      for (let f = from; f <= cp;) {
        const { logs, toBlock } = await fetch(f, cp);
        const rows = await decode(logs);
        await writeChunk(this.db, rows, null, toBlock);
        n += rows.length;
        f = toBlock + 1n;
      }
      console.log(`[indexer] new pool ${reg.poolId.slice(0, 10)}… ${set} look-back ${from}→${cp}: ${n} event(s)`);
    }
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

    // Market data: swaps / pool inits of registered pools, asset transfers (holders)
    if (await this.processMarket()) didWork = true;

    return didWork;
  }

  /**
   * Market data only (swaps + pool inits, asset transfers): display data, nothing that moves money or
   * feeds the keeper. Same finality rule (getLatestBlock) as every other set.
   */
  async processMarket(): Promise<boolean> {
    let didWork = false;
    while (await this.processSwapsChunk()) didWork = true;
    while (await this.processAssetTransfersChunk()) didWork = true;
    return didWork;
  }

  private lastFullMs = -Infinity;

  /**
   * One follow-mode step: the full cycle (registry, routers, USDC, market) when `intervalMs` has passed
   * since the last one, otherwise market data only. Sequential, so two cycles never race on a checkpoint.
   */
  async tick(nowMs: number, intervalMs: number): Promise<'full' | 'market'> {
    if (nowMs - this.lastFullMs >= intervalMs) {
      this.lastFullMs = nowMs;
      await this.processAll();
      return 'full';
    }
    await this.processMarket();
    return 'market';
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
   * Follow mode: everything every intervalMs; market data (swaps, holders) every marketIntervalMs.
   */
  async follow(intervalMs: number, marketIntervalMs = intervalMs): Promise<never> {
    const step = Math.min(intervalMs, marketIntervalMs);
    console.log(`[indexer] Follow mode — polling every ${intervalMs / 1000}s, market data every ${step / 1000}s`);

    while (true) {
      try {
        await this.tick(Date.now(), intervalMs);
      } catch (err) {
        console.error('[indexer] Error in follow loop:', err);
      }
      await new Promise(r => setTimeout(r, step));
    }
  }
}
