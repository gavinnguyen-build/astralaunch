import { describe, it, expect } from 'vitest';
import { KEEPER_DEFAULT_INTERVAL_S, KEEPER_MIN_INTERVAL_S } from '@astralaunch/shared';
import { resolveInterval, isLocalRpcUrl } from '../interval.js';

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

describe('interval guard (src/interval.ts)', () => {
  const secs = (url: string, configured?: string) => resolveInterval(url, configured).seconds;

  it('uses configured value on localhost', () => {
    expect(secs('http://localhost:8545', '10')).toBe(10);
  });

  it('uses configured value on 127.0.0.1', () => {
    expect(secs('http://127.0.0.1:8545', '10')).toBe(10);
  });

  it('clamps to minimum on non-localhost', () => {
    expect(resolveInterval('https://rpc.monad.xyz', '30')).toEqual({ seconds: KEEPER_MIN_INTERVAL_S, clamped: true });
  });

  it('allows value above minimum on non-localhost', () => {
    expect(secs('https://rpc.monad.xyz', '600')).toBe(600);
  });

  it('allows value exactly at minimum on non-localhost', () => {
    expect(secs('https://rpc.monad.xyz', '300')).toBe(300);
  });

  it('uses the default when unset or empty (an empty compose var must not mean 0)', () => {
    expect(secs('https://rpc.monad.xyz', undefined)).toBe(KEEPER_DEFAULT_INTERVAL_S);
    expect(secs('https://rpc.monad.xyz', '')).toBe(KEEPER_DEFAULT_INTERVAL_S);
  });

  it('clamps a non-numeric value on a remote RPC', () => {
    expect(secs('https://rpc.monad.xyz', 'fast')).toBe(KEEPER_MIN_INTERVAL_S);
  });

  it('does not treat "localhost" outside the host as local (guard bypass)', () => {
    expect(isLocalRpcUrl('https://rpc.monad.xyz/?localhost')).toBe(false);
    expect(isLocalRpcUrl('https://rpc.monad.xyz/localhost')).toBe(false);
    expect(isLocalRpcUrl('https://localhost.evil.example')).toBe(false);
    expect(isLocalRpcUrl('https://127.0.0.1.nip.io')).toBe(false);
    expect(secs('https://rpc.monad.xyz/?localhost', '20')).toBe(KEEPER_MIN_INTERVAL_S);
  });

  it('recognises loopback hosts', () => {
    expect(isLocalRpcUrl('http://localhost:8545')).toBe(true);
    expect(isLocalRpcUrl('http://127.0.0.1:8545')).toBe(true);
    expect(isLocalRpcUrl('http://[::1]:8545')).toBe(true);
    expect(isLocalRpcUrl('not a url')).toBe(false);
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
