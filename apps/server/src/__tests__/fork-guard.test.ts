import { describe, it, expect } from 'vitest';
import { forkFacilitatorError } from '../lib/forkGuard.js';

describe('forkFacilitatorError', () => {
  it('refuses a local fork RPC with a non-local facilitator', () => {
    expect(forkFacilitatorError('http://127.0.0.1:8545', 'https://x402-facilitator.molandak.org')).toMatch(/local fork/);
    expect(forkFacilitatorError('http://localhost:8545', 'https://facilitator.example')).not.toBeNull();
  });
  it('allows a local facilitator on a fork, and anything on mainnet', () => {
    expect(forkFacilitatorError('http://127.0.0.1:8545', 'http://127.0.0.1:4021')).toBeNull();
    expect(forkFacilitatorError('https://rpc.monad.xyz', 'https://x402-facilitator.molandak.org')).toBeNull();
  });
});
