/**
 * Topic0 verification: ensures every indexed event ABI matches the
 * canonical event signature from forge artifacts.
 *
 * If this test fails, run: pnpm -F @astralaunch/indexer gen-abis
 */
import { describe, it, expect } from 'vitest';
import { keccak256, toHex, encodeEventTopics } from 'viem';
import {
  registeredEvent,
  escrowFeeCollectedEvent,
  revenueRecordedEvent,
  claimedEvent,
  claimedWmonEvent,
  forfeitedEvent,
  vaultFeeCollectedEvent,
  buybackExecutedEvent,
  tokensBurnedEvent,
  pfrCollectedEvent,
  distributedEvent,
  transferEvent,
} from '../abis.js';

// ── Expected topic0 values ──────────────────────────────────────────────────
// Computed as keccak256 of the canonical event signature string.
// These are the ground-truth values from the Solidity compiler.

function eventTopic0(sig: string): string {
  return keccak256(toHex(sig));
}

const EXPECTED_TOPIC0: Record<string, { sig: string; topic0: string }> = {
  // AstralaunchRegistry
  'Registered (v2, 7 fields)': {
    sig: 'Registered(address,address,address,bytes32,address,address,uint256)',
    topic0: eventTopic0('Registered(address,address,address,bytes32,address,address,uint256)'),
  },

  // FeeEscrow
  'FeeCollected (escrow, 4 fields)': {
    sig: 'FeeCollected(address,uint256,uint256,uint256)',
    topic0: eventTopic0('FeeCollected(address,uint256,uint256,uint256)'),
  },
  'RevenueRecorded': {
    sig: 'RevenueRecorded(address,uint256,uint256)',
    topic0: eventTopic0('RevenueRecorded(address,uint256,uint256)'),
  },
  'Claimed': {
    sig: 'Claimed(address,address,uint256)',
    topic0: eventTopic0('Claimed(address,address,uint256)'),
  },
  'ClaimedWmon': {
    sig: 'ClaimedWmon(address,address,uint256,uint256)',
    topic0: eventTopic0('ClaimedWmon(address,address,uint256,uint256)'),
  },
  'Forfeited (4 fields)': {
    sig: 'Forfeited(address,uint256,uint256,uint256)',
    topic0: eventTopic0('Forfeited(address,uint256,uint256,uint256)'),
  },

  // BuybackVault — FeeCollected has 3 params (same topic0 as v1)
  'FeeCollected (vault, 3 fields)': {
    sig: 'FeeCollected(address,uint256,uint256)',
    topic0: eventTopic0('FeeCollected(address,uint256,uint256)'),
  },
  'BuybackExecuted': {
    sig: 'BuybackExecuted(address,uint256,uint256,uint8)',
    topic0: eventTopic0('BuybackExecuted(address,uint256,uint256,uint8)'),
  },
  'TokensBurned': {
    sig: 'TokensBurned(address,uint256)',
    topic0: eventTopic0('TokensBurned(address,uint256)'),
  },

  // PlatformFeeReceiver
  'Collected (4 fields)': {
    sig: 'Collected(address,uint256,uint256,uint256)',
    topic0: eventTopic0('Collected(address,uint256,uint256,uint256)'),
  },

  // RevenueRouter
  'Distributed': {
    sig: 'Distributed(address,uint256,uint256,uint256,uint256,uint256)',
    topic0: eventTopic0('Distributed(address,uint256,uint256,uint256,uint256,uint256)'),
  },

  // ERC-20 Transfer
  'Transfer': {
    sig: 'Transfer(address,address,uint256)',
    topic0: eventTopic0('Transfer(address,address,uint256)'),
  },
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Event ABI topic0 verification', () => {
  /** Helper: get topic0 from an ABI event definition via viem. */
  function getAbiTopic0(abi: any): string {
    const topics = encodeEventTopics({ abi: [abi] });
    return topics[0] as string;
  }

  it('Registered topic0 matches v2 (7-field) signature', () => {
    const actual = getAbiTopic0(registeredEvent);
    expect(actual).toBe(EXPECTED_TOPIC0['Registered (v2, 7 fields)'].topic0);
  });

  it('Registered topic0 does NOT match v1 (5-field) signature', () => {
    const actual = getAbiTopic0(registeredEvent);
    const v1Topic0 = eventTopic0('Registered(address,address,address,bytes32,uint256)');
    expect(actual).not.toBe(v1Topic0);
  });

  it('FeeCollected (escrow) topic0 matches 4-field signature', () => {
    const actual = getAbiTopic0(escrowFeeCollectedEvent);
    expect(actual).toBe(EXPECTED_TOPIC0['FeeCollected (escrow, 4 fields)'].topic0);
  });

  it('FeeCollected (vault) topic0 matches 3-field signature', () => {
    const actual = getAbiTopic0(vaultFeeCollectedEvent);
    expect(actual).toBe(EXPECTED_TOPIC0['FeeCollected (vault, 3 fields)'].topic0);
  });

  it('Escrow and Vault FeeCollected have DIFFERENT topic0 (v2 divergence)', () => {
    const escrowTopic = getAbiTopic0(escrowFeeCollectedEvent);
    const vaultTopic = getAbiTopic0(vaultFeeCollectedEvent);
    expect(escrowTopic).not.toBe(vaultTopic);
  });

  it('RevenueRecorded topic0 matches', () => {
    expect(getAbiTopic0(revenueRecordedEvent)).toBe(EXPECTED_TOPIC0['RevenueRecorded'].topic0);
  });

  it('Claimed topic0 matches', () => {
    expect(getAbiTopic0(claimedEvent)).toBe(EXPECTED_TOPIC0['Claimed'].topic0);
  });

  it('ClaimedWmon topic0 matches', () => {
    expect(getAbiTopic0(claimedWmonEvent)).toBe(EXPECTED_TOPIC0['ClaimedWmon'].topic0);
  });

  it('Forfeited topic0 matches 4-field signature', () => {
    expect(getAbiTopic0(forfeitedEvent)).toBe(EXPECTED_TOPIC0['Forfeited (4 fields)'].topic0);
  });

  it('BuybackExecuted topic0 matches', () => {
    expect(getAbiTopic0(buybackExecutedEvent)).toBe(EXPECTED_TOPIC0['BuybackExecuted'].topic0);
  });

  it('TokensBurned topic0 matches', () => {
    expect(getAbiTopic0(tokensBurnedEvent)).toBe(EXPECTED_TOPIC0['TokensBurned'].topic0);
  });

  it('Collected (PFR) topic0 matches 4-field signature', () => {
    expect(getAbiTopic0(pfrCollectedEvent)).toBe(EXPECTED_TOPIC0['Collected (4 fields)'].topic0);
  });

  it('Distributed topic0 matches', () => {
    expect(getAbiTopic0(distributedEvent)).toBe(EXPECTED_TOPIC0['Distributed'].topic0);
  });

  it('Transfer topic0 matches', () => {
    expect(getAbiTopic0(transferEvent)).toBe(EXPECTED_TOPIC0['Transfer'].topic0);
  });

  // ── Specific known topic0 values from mainnet ──────────────────────────
  // These are hardcoded values from the user's analysis of on-chain events.

  it('Registered v2 topic0 matches known mainnet value 0x1ffa2fcf...', () => {
    const actual = getAbiTopic0(registeredEvent);
    expect(actual).toBe('0x1ffa2fcf3357aa43ed63da11bf76f1a5a115370f3331d2ab35c6e27b7b298951');
  });
});
