import type { PublicClient, Log, Hex } from 'viem';

/** Minimum chunk size — floor for auto-halving on RPC errors. */
export const MIN_CHUNK_SIZE = 10;

/** After N consecutive successes at the current chunk size, grow by 50%. */
const GROW_AFTER = 3;
const GROW_FACTOR = 1.5;

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

/**
 * Extract all relevant text from a (possibly viem-wrapped) error.
 * Checks `.message`, `.cause.message`, `.details`, `.cause.details`.
 */
function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
    const cause = (err as any).cause;
    if (cause instanceof Error) parts.push(cause.message);
    if (typeof cause === 'string') parts.push(cause);
  }
  const details = (err as any)?.details;
  if (typeof details === 'string') parts.push(details);
  const causeDetails = (err as any)?.cause?.details;
  if (typeof causeDetails === 'string') parts.push(causeDetails);
  return parts.join(' ').toLowerCase();
}

/** Extract RPC error code from a (possibly viem-wrapped) error. */
function extractErrorCode(err: unknown): number | undefined {
  const code = (err as any)?.code ?? (err as any)?.cause?.code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Detect RPC "block range too wide" errors.
 * Matches: error codes -32614 / -32005, and various message patterns.
 */
export function isRangeError(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (code === -32614 || code === -32005) return true;

  const text = collectErrorText(err);
  return (
    text.includes('limited to') ||
    text.includes('block range') ||
    text.includes('range too large') ||
    text.includes('too many results') ||
    text.includes('query returned more than')
  );
}

function isTransientError(err: unknown): boolean {
  const text = collectErrorText(err);
  return (
    text.includes('rate limit') ||
    text.includes('429') ||
    text.includes('timeout') ||
    text.includes('econnreset') ||
    text.includes('econnrefused') ||
    text.includes('socket hang up') ||
    text.includes('network') ||
    text.includes('502') ||
    text.includes('503') ||
    text.includes('504')
  );
}

/**
 * ChunkManager: fetches logs in configurable chunks.
 * - Auto-halves chunk size on RPC "block range too wide" errors (floor: 10).
 * - Grows chunk size back gradually after consecutive successes.
 * - Exponential backoff with jitter on transient errors.
 * - Token-bucket rate limiter for max RPS.
 */
export class ChunkManager {
  private chunkSize: number;
  private maxChunkSize: number;
  private limiter: RateLimiter;
  private consecutiveSuccesses = 0;

  constructor(
    private client: PublicClient,
    initialChunkSize: number,
    maxRps: number = 25,
  ) {
    this.chunkSize = initialChunkSize;
    this.maxChunkSize = initialChunkSize;
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

        // Success — persist chunk size and try to grow
        if (currentChunk !== this.chunkSize) {
          console.log(`[fetcher] Chunk size now ${currentChunk}`);
        }
        this.chunkSize = currentChunk;
        retries = 0;

        this.consecutiveSuccesses++;
        if (this.consecutiveSuccesses >= GROW_AFTER && this.chunkSize < this.maxChunkSize) {
          const grown = Math.min(
            Math.floor(this.chunkSize * GROW_FACTOR),
            this.maxChunkSize,
          );
          if (grown !== this.chunkSize) {
            this.chunkSize = grown;
            console.log(`[fetcher] Growing chunk size to ${this.chunkSize}`);
          }
          this.consecutiveSuccesses = 0;
        }

        return { logs, fromBlock, toBlock: effectiveTo };

      } catch (err) {
        // Block range too wide → halve chunk and retry immediately
        if (isRangeError(err)) {
          this.consecutiveSuccesses = 0;
          const prev = currentChunk;
          currentChunk = Math.max(Math.floor(currentChunk / 2), MIN_CHUNK_SIZE);
          console.log(`[fetcher] Range error, halving chunk ${prev} → ${currentChunk}`);
          if (currentChunk <= MIN_CHUNK_SIZE && prev <= MIN_CHUNK_SIZE) {
            throw err;
          }
          retries = 0;
          continue;
        }

        // Transient error → exponential backoff with jitter
        if (isTransientError(err) && retries < MAX_RETRIES) {
          retries++;
          const msg = collectErrorText(err);
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
