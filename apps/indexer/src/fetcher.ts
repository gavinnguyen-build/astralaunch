import type { PublicClient, Log, Hex } from 'viem';

/** Minimum chunk size — floor for auto-halving on RPC errors. */
export const MIN_CHUNK_SIZE = 100;

/** Default max retries with exponential backoff. */
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 500;

export interface ChunkResult {
  logs: Log[];
  fromBlock: bigint;
  toBlock: bigint;
}

/** Simple token-bucket rate limiter. */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(private maxRps: number) {
    this.tokens = maxRps;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxRps, this.tokens + elapsed * this.maxRps);
    this.lastRefill = now;

    if (this.tokens < 1) {
      const waitMs = ((1 - this.tokens) / this.maxRps) * 1000;
      await new Promise(r => setTimeout(r, waitMs));
      this.tokens = 1;
      this.lastRefill = Date.now();
    }
    this.tokens -= 1;
  }
}

function isRangeError(msg: string): boolean {
  return (
    msg.includes('block range') ||
    msg.includes('too many') ||
    msg.includes('limit exceeded') ||
    msg.includes('query returned more than')
  );
}

function isTransientError(msg: string): boolean {
  return (
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('timeout') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504')
  );
}

/**
 * ChunkManager: fetches logs in configurable chunks.
 * - Auto-halves chunk size on RPC "block range too wide" errors.
 * - Exponential backoff with jitter on transient errors.
 * - Token-bucket rate limiter for max RPS.
 */
export class ChunkManager {
  private chunkSize: number;
  private limiter: RateLimiter;

  constructor(
    private client: PublicClient,
    initialChunkSize: number,
    maxRps: number = 25,
  ) {
    this.chunkSize = initialChunkSize;
    this.limiter = new RateLimiter(maxRps);
  }

  getChunkSize(): number {
    return this.chunkSize;
  }

  async getLogs(params: {
    fromBlock: bigint;
    toBlock: bigint;
    address: `0x${string}` | `0x${string}`[];
    events: readonly { type: 'event'; name: string; inputs: readonly any[] }[];
    topics?: (Hex | Hex[] | null)[];
  }): Promise<ChunkResult> {
    const { fromBlock, address, events, topics } = params;
    let toBlock = params.toBlock;
    let currentChunk = this.chunkSize;

    // Clamp toBlock to fromBlock + chunkSize - 1
    const maxTo = fromBlock + BigInt(currentChunk) - 1n;
    if (toBlock > maxTo) toBlock = maxTo;

    let retries = 0;

    while (true) {
      await this.limiter.acquire();

      try {
        const effectiveTo = fromBlock + BigInt(currentChunk) - 1n < toBlock
          ? fromBlock + BigInt(currentChunk) - 1n
          : toBlock;

        let logs: Log[];

        if (topics) {
          // For USDC transfer filtering by topic (indexed `to` address)
          const rawParams: any = {
            fromBlock,
            toBlock: effectiveTo,
            address: Array.isArray(address) ? address[0] : address,
          };
          const eventAbi = events[0];
          if (eventAbi) {
            rawParams.event = eventAbi;
            if (topics.length > 1) {
              rawParams.args = {};
              if (topics[1]) rawParams.args.from = topics[1];
              if (topics[2]) rawParams.args.to = topics[2];
            }
          }
          logs = (await this.client.getLogs(rawParams)) as Log[];
        } else {
          logs = (await this.client.getLogs({
            fromBlock,
            toBlock: effectiveTo,
            address: address as any,
            events,
          })) as Log[];
        }

        this.chunkSize = currentChunk;
        retries = 0;
        return { logs, fromBlock, toBlock: effectiveTo };

      } catch (err) {
        const msg = (err as Error).message ?? '';

        // Block range too wide → halve chunk and retry immediately
        if (isRangeError(msg)) {
          currentChunk = Math.max(Math.floor(currentChunk / 2), MIN_CHUNK_SIZE);
          if (currentChunk <= MIN_CHUNK_SIZE && this.chunkSize <= MIN_CHUNK_SIZE) {
            throw err;
          }
          console.log(`[fetcher] Halving chunk size to ${currentChunk}`);
          retries = 0;
          continue;
        }

        // Transient error → exponential backoff with jitter
        if (isTransientError(msg) && retries < MAX_RETRIES) {
          retries++;
          const delayMs = BASE_DELAY_MS * 2 ** (retries - 1) + Math.random() * 200;
          console.log(`[fetcher] Transient error, retry ${retries}/${MAX_RETRIES} in ${Math.round(delayMs)}ms: ${msg}`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }

        throw err;
      }
    }
  }
}
