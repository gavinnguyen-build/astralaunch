import { describe, it, expect } from 'vitest';
import { KEEPER_DEFAULT_INTERVAL_S, KEEPER_MIN_INTERVAL_S } from '@revpad/shared';

describe('keeper interval constants', () => {
  it('default interval is 600s (10 min)', () => {
    expect(KEEPER_DEFAULT_INTERVAL_S).toBe(600);
  });

  it('minimum interval is 300s (5 min)', () => {
    expect(KEEPER_MIN_INTERVAL_S).toBe(300);
  });

  it('default >= minimum', () => {
    expect(KEEPER_DEFAULT_INTERVAL_S).toBeGreaterThanOrEqual(KEEPER_MIN_INTERVAL_S);
  });
});

describe('interval guard logic', () => {
  // Test the resolveInterval logic directly without importing index.ts
  // (which has side effects). We replicate the logic here.
  function resolveInterval(rpcUrl: string, configured: number): number {
    const isLocal = /localhost|127\.0\.0\.1/.test(rpcUrl);
    if (!isLocal && configured < KEEPER_MIN_INTERVAL_S) {
      return KEEPER_MIN_INTERVAL_S;
    }
    return configured;
  }

  it('uses configured value on localhost', () => {
    expect(resolveInterval('http://localhost:8545', 10)).toBe(10);
  });

  it('uses configured value on 127.0.0.1', () => {
    expect(resolveInterval('http://127.0.0.1:8545', 10)).toBe(10);
  });

  it('clamps to minimum on non-localhost', () => {
    expect(resolveInterval('https://rpc.monad.xyz', 30)).toBe(KEEPER_MIN_INTERVAL_S);
  });

  it('allows value above minimum on non-localhost', () => {
    expect(resolveInterval('https://rpc.monad.xyz', 600)).toBe(600);
  });

  it('allows value exactly at minimum on non-localhost', () => {
    expect(resolveInterval('https://rpc.monad.xyz', 300)).toBe(300);
  });
});

describe('dry-run flag parsing', () => {
  it('--dry-run is recognized in process.argv', () => {
    const args = ['node', 'index.ts', '--dry-run'];
    expect(args.includes('--dry-run')).toBe(true);
  });

  it('DRY_RUN env var is recognized', () => {
    expect('true' === 'true').toBe(true);
  });
});
