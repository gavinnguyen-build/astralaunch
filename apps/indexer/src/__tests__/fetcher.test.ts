import { describe, it, expect, vi } from 'vitest';
import { ChunkManager, RateLimiter, MIN_CHUNK_SIZE, isRangeError, isTransientError } from '../fetcher.js';
import type { PublicClient, Log } from 'viem';
import { transferEvent } from '../abis.js';

function makeMockClient(
  getLogsImpl: (...args: any[]) => Promise<Log[]>,
): PublicClient {
  return {
    getLogs: getLogsImpl,
  } as unknown as PublicClient;
}

const ADDR = '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`;

// ── isRangeError ────────────────────────────────────────────────────────────

describe('isRangeError', () => {
  it('detects Monad RPC -32614 code (viem-wrapped)', () => {
    const viemErr = new Error(
      'RPC Request failed.\n\nURL: https://rpc.monad.xyz\nRequest body: ...',
    );
    (viemErr as any).cause = new Error('eth_getLogs is limited to a 100 range');
    (viemErr as any).cause.code = -32614;
    expect(isRangeError(viemErr)).toBe(true);
  });

  it('detects -32005 error code', () => {
    const err = new Error('Server error');
    (err as any).code = -32005;
    expect(isRangeError(err)).toBe(true);
  });

  it('detects "limited to" in cause details', () => {
    const err = new Error('RPC Request failed.');
    (err as any).details = 'eth_getLogs is limited to a 100 range';
    expect(isRangeError(err)).toBe(true);
  });

  it('detects "block range" in message', () => {
    expect(isRangeError(new Error('block range too wide'))).toBe(true);
  });

  it('detects "query returned more than" in message', () => {
    expect(isRangeError(new Error('query returned more than 10000 results'))).toBe(true);
  });

  it('detects "range too large" (case-insensitive)', () => {
    expect(isRangeError(new Error('Range Too Large for eth_getLogs'))).toBe(true);
  });

  it('returns false for non-range errors', () => {
    expect(isRangeError(new Error('invalid argument'))).toBe(false);
    expect(isRangeError(new Error('timeout'))).toBe(false);
  });
});

// ── isTransientError ────────────────────────────────────────────────────────

describe('isTransientError', () => {
  it('detects viem TimeoutError (name contains "timeout")', () => {
    const err = new Error('The request took too long to respond.');
    err.name = 'TimeoutError';
    (err as any).details = 'The request timed out.';
    expect(isTransientError(err)).toBe(true);
  });

  it('detects "timed out" in details', () => {
    const err = new Error('Request failed');
    (err as any).details = 'The request timed out.';
    expect(isTransientError(err)).toBe(true);
  });

  it('detects 429 in message', () => {
    expect(isTransientError(new Error('rate limit exceeded 429'))).toBe(true);
  });

  it('detects HTTP 502/503/504', () => {
    expect(isTransientError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransientError(new Error('504 Gateway Timeout'))).toBe(true);
  });

  it('detects ECONNRESET / ECONNREFUSED / ENOTFOUND', () => {
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isTransientError(new Error('ENOTFOUND'))).toBe(true);
  });

  it('detects "fetch failed"', () => {
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
  });

  it('detects "socket hang up"', () => {
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientError(new Error('invalid argument'))).toBe(false);
    expect(isTransientError(new Error('block range too wide'))).toBe(false);
  });
});

// ── ChunkManager ────────────────────────────────────────────────────────────

describe('ChunkManager', () => {
  it('returns logs for a normal chunk', async () => {
    const mockLogs: Log[] = [
      { blockNumber: 100n, logIndex: 0, transactionHash: '0xabc', data: '0x', topics: [], address: '0x0', removed: false } as unknown as Log,
    ];

    const client = makeMockClient(async () => mockLogs);
    const mgr = new ChunkManager(client, 1000, 1000);

    const result = await mgr.getLogs({
      fromBlock: 100n,
      toBlock: 200n,
      address: ADDR,
      events: [transferEvent],
    });

    expect(result.logs).toEqual(mockLogs);
    expect(result.fromBlock).toBe(100n);
    expect(result.toBlock).toBe(200n);
  });

  it('halves chunk size on RPC block range error', async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('query returned more than 10000 results');
      }
      return [];
    });

    const mgr = new ChunkManager(client, 10000, 1000);

    const result = await mgr.getLogs({
      fromBlock: 0n,
      toBlock: 20000n,
      address: ADDR,
      events: [transferEvent],
    });

    expect(callCount).toBe(2);
    expect(mgr.getChunkSize()).toBe(5000);
    expect(result.toBlock).toBe(4999n);
  });

  it('halves on Monad -32614 viem-wrapped error', async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('RPC Request failed.');
        (err as any).cause = new Error('eth_getLogs is limited to a 100 range');
        (err as any).cause.code = -32614;
        throw err;
      }
      return [];
    });

    const mgr = new ChunkManager(client, 200, 1000);

    await mgr.getLogs({
      fromBlock: 0n,
      toBlock: 500n,
      address: ADDR,
      events: [transferEvent],
    });

    expect(callCount).toBe(2);
    expect(mgr.getChunkSize()).toBe(100);
  });

  it('halves on -32005 error code', async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('Server error');
        (err as any).code = -32005;
        throw err;
      }
      return [];
    });

    const mgr = new ChunkManager(client, 500, 1000);

    await mgr.getLogs({
      fromBlock: 0n,
      toBlock: 1000n,
      address: ADDR,
      events: [transferEvent],
    });

    expect(callCount).toBe(2);
    expect(mgr.getChunkSize()).toBe(250);
  });

  it('floors chunk size at MIN_CHUNK_SIZE (10)', async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount <= 5) {
        throw new Error('block range too wide');
      }
      return [];
    });

    const mgr = new ChunkManager(client, 200, 1000);

    await mgr.getLogs({
      fromBlock: 0n,
      toBlock: 500n,
      address: ADDR,
      events: [transferEvent],
    });

    expect(mgr.getChunkSize()).toBe(MIN_CHUNK_SIZE);
    expect(mgr.getChunkSize()).toBe(10);
  });

  it('grows chunk size back after consecutive successes', async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('block range too wide');
      }
      return [];
    });

    // Start at 100, will halve to 50 on first call, then grow back
    const mgr = new ChunkManager(client, 100, 1000);

    // First call halves from 100 to 50
    await mgr.getLogs({ fromBlock: 0n, toBlock: 500n, address: ADDR, events: [transferEvent] });
    expect(mgr.getChunkSize()).toBe(50);

    // 3 more successes → should grow
    await mgr.getLogs({ fromBlock: 0n, toBlock: 500n, address: ADDR, events: [transferEvent] });
    await mgr.getLogs({ fromBlock: 0n, toBlock: 500n, address: ADDR, events: [transferEvent] });
    // After the 2nd success above (3rd consecutive), growth triggers
    expect(mgr.getChunkSize()).toBe(75); // 50 * 1.5
  });

  it('retries with exponential backoff on transient errors', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount <= 2) {
        throw new Error('rate limit exceeded 429');
      }
      return [];
    });

    const mgr = new ChunkManager(client, 1000, 1000);

    const promise = mgr.getLogs({
      fromBlock: 0n,
      toBlock: 100n,
      address: ADDR,
      events: [transferEvent],
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callCount).toBe(3); // 2 retries + 1 success
    expect(result.logs).toEqual([]);
    vi.useRealTimers();
  });

  it('rethrows non-retriable errors', async () => {
    const client = makeMockClient(async () => {
      throw new Error('invalid argument');
    });

    const mgr = new ChunkManager(client, 1000, 1000);

    await expect(
      mgr.getLogs({
        fromBlock: 0n,
        toBlock: 100n,
        address: ADDR,
        events: [transferEvent],
      }),
    ).rejects.toThrow('invalid argument');
  });

  // ── New tests for enhanced retry logic ──────────────────────────────────

  it('timeout then success — recovers without crashing', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount === 1) {
        // Simulate viem TimeoutError shape
        const err = new Error('The request took too long to respond.');
        err.name = 'TimeoutError';
        (err as any).details = 'The request timed out.';
        throw err;
      }
      return [{ blockNumber: 100n, logIndex: 0, data: '0x', topics: [], address: '0x0', removed: false } as unknown as Log];
    });

    const mgr = new ChunkManager(client, 1000, 1000);
    const promise = mgr.getLogs({
      fromBlock: 100n,
      toBlock: 200n,
      address: ADDR,
      events: [transferEvent],
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callCount).toBe(2);
    expect(result.logs).toHaveLength(1);
    vi.useRealTimers();
  });

  it('HTTP 429 then success — recovers without crashing', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('HTTP request failed.');
        err.name = 'HttpRequestError';
        (err as any).details = '429 Too Many Requests';
        throw err;
      }
      return [];
    });

    const mgr = new ChunkManager(client, 1000, 1000);
    const promise = mgr.getLogs({
      fromBlock: 0n,
      toBlock: 100n,
      address: ADDR,
      events: [transferEvent],
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callCount).toBe(2);
    expect(result.logs).toEqual([]);
    vi.useRealTimers();
  });

  it('persistent transient failure halves chunk after ~10 retries', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      // Fail 10 times (triggers halve), then succeed on attempt 11
      if (callCount <= 10) {
        throw new Error('503 Service Unavailable');
      }
      return [];
    });

    const mgr = new ChunkManager(client, 200, 1000);
    const promise = mgr.getLogs({
      fromBlock: 0n,
      toBlock: 500n,
      address: ADDR,
      events: [transferEvent],
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    // 10 retries → halve (200→100) → 1 success
    expect(callCount).toBe(11);
    expect(mgr.getChunkSize()).toBe(100);
    expect(result.toBlock).toBe(99n); // clamped to halved chunk
    vi.useRealTimers();
  });

  it('at MIN_CHUNK_SIZE, transient errors keep retrying (never throws)', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      // Fail 15 times then succeed — at MIN_CHUNK_SIZE the whole time
      if (callCount <= 15) {
        throw new Error('ECONNRESET');
      }
      return [];
    });

    const mgr = new ChunkManager(client, MIN_CHUNK_SIZE, 1000);
    const promise = mgr.getLogs({
      fromBlock: 0n,
      toBlock: 100n,
      address: ADDR,
      events: [transferEvent],
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    // Should succeed after 15 failures — never throws
    expect(callCount).toBe(16);
    expect(result.logs).toEqual([]);
    expect(mgr.getChunkSize()).toBe(MIN_CHUNK_SIZE);
    vi.useRealTimers();
  });

  it('transient errors do not affect range-error halving', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount === 1) throw new Error('ECONNRESET');
      if (callCount === 2) throw new Error('block range too wide');
      return [];
    });

    const mgr = new ChunkManager(client, 1000, 1000);
    const promise = mgr.getLogs({
      fromBlock: 0n,
      toBlock: 2000n,
      address: ADDR,
      events: [transferEvent],
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callCount).toBe(3);
    expect(mgr.getChunkSize()).toBe(500); // halved from 1000
    vi.useRealTimers();
  });
});

describe('RateLimiter', () => {
  it('acquires immediately when tokens available', async () => {
    const limiter = new RateLimiter(100);
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });
});
