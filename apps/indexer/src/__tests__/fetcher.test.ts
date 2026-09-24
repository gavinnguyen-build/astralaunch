import { describe, it, expect, vi } from 'vitest';
import { ChunkManager, RateLimiter } from '../fetcher.js';
import type { PublicClient, Log } from 'viem';
import { transferEvent } from '../abis.js';

function makeMockClient(
  getLogsImpl: (...args: any[]) => Promise<Log[]>,
): PublicClient {
  return {
    getLogs: getLogsImpl,
  } as unknown as PublicClient;
}

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
      address: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
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
      address: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
      events: [transferEvent],
    });

    expect(callCount).toBe(2);
    expect(mgr.getChunkSize()).toBe(5000);
    expect(result.toBlock).toBe(4999n);
  });

  it('floors chunk size at MIN_CHUNK_SIZE (100)', async () => {
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
      address: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
      events: [transferEvent],
    });

    expect(mgr.getChunkSize()).toBe(100);
  });

  it('retries with exponential backoff on transient errors', async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount <= 2) {
        throw new Error('rate limit exceeded 429');
      }
      return [];
    });

    const mgr = new ChunkManager(client, 1000, 1000);

    const result = await mgr.getLogs({
      fromBlock: 0n,
      toBlock: 100n,
      address: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
      events: [transferEvent],
    });

    expect(callCount).toBe(3); // 2 retries + 1 success
    expect(result.logs).toEqual([]);
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
        address: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
        events: [transferEvent],
      }),
    ).rejects.toThrow('invalid argument');
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
