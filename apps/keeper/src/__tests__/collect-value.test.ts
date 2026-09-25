/**
 * Value-aware collect (value.ts + jobs.ts): skip unless pending fees in MON (USDC via Chainlink MON/USD,
 * WMON 1:1) ≥ COLLECT_MIN_VALUE_MULTIPLE (default 5) × the collect's estimated gas cost.
 * Regression: on mainnet one collect spent 0.141 MON gas to move 0.106 WMON.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseEther } from 'viem';

vi.mock('../chain.js', () => ({
  publicClient: {
    readContract: vi.fn(),
    simulateContract: vi.fn(),
    getBlock: vi.fn().mockResolvedValue({ timestamp: 999_999_999n }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({}),
  },
  ESCROW: '0x0000000000000000000000000000000000000001',
  VAULT: '0x0000000000000000000000000000000000000002',
  PLATFORM_FEE_RECEIVER: '0x0000000000000000000000000000000000000003',
  WMON: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
  sendTx: vi.fn().mockResolvedValue({ hash: '0x00', gasBuffered: 0n, monCost: 0n }),
  DRY_RUN: false,
  simulatePendingFees: vi.fn(),
  getBeneficiaryShare: vi.fn(),
  getAssetNumeraire: vi.fn(),
  estimateTxCost: vi.fn(),
  readMonUsd: vi.fn(),
}));
vi.mock('../telegram.js', () => ({ sendTelegramAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../spend.js', () => ({
  SpendGuardError: class SpendGuardError extends Error { constructor(m: string) { super(m); this.name = 'SpendGuardError'; } },
}));

import { jobCollectAll, _resetCadenceForTest } from '../jobs.js';
import { publicClient, sendTx, simulatePendingFees, getBeneficiaryShare, getAssetNumeraire, estimateTxCost, readMonUsd } from '../chain.js';
import { collectValueGate, parseValueMultipleBps, pendingValueMon } from '../value.js';
import { WAD } from '@astralaunch/shared';
import type { Address } from 'viem';

const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';
const ASSET = '0x1111111111111111111111111111111111111111' as Address;
const NOW = BigInt(Math.floor(Date.now() / 1000));
const FRESH = { price: 50_000_000n, updatedAt: NOW };        // $0.50
const X5 = parseValueMultipleBps(undefined);

describe('collectValueGate (pure)', () => {
  const gate = (o: Partial<Parameters<typeof collectValueGate>[0]>) => collectValueGate({
    pending: 0n, isWmonPair: true, monUsd: null, nowS: NOW, maxStalenessS: 3600n, gasCostWei: 0n, multipleBps: X5, ...o,
  });

  it('mainnet case: 0.106 WMON pending vs 0.141 MON gas → skip, comparison logged', () => {
    const r = gate({ pending: parseEther('0.106'), gasCostWei: parseEther('0.141') });
    expect(r.send).toBe(false);
    expect(r.reason).toBe('value: pending 0.106 WMON ≈ 0.106 MON (WMON 1:1) vs 5× gas 0.141 MON = 0.705 MON');
  });

  it('WMON: sends at exactly 5× gas, skips just below', () => {
    expect(gate({ pending: parseEther('0.705'), gasCostWei: parseEther('0.141') }).send).toBe(true);
    expect(gate({ pending: parseEther('0.705') - 1n, gasCostWei: parseEther('0.141') }).send).toBe(false);
  });

  it('USDC converted with the MON/USD feed (8 decimals)', () => {
    // 1 USDC at $0.50/MON = 2 MON; gas 0.4 MON × 5 = 2 MON → send; gas 0.41 → skip
    expect(pendingValueMon(1_000_000n, false, FRESH, NOW, 3600n).wei).toBe(parseEther('2'));
    expect(gate({ pending: 1_000_000n, isWmonPair: false, monUsd: FRESH, gasCostWei: parseEther('0.4') }).send).toBe(true);
    const r = gate({ pending: 1_000_000n, isWmonPair: false, monUsd: FRESH, gasCostWei: parseEther('0.41') });
    expect(r.send).toBe(false);
    expect(r.reason).toContain('pending 1 USDC ≈ 2 MON (MON/USD $0.5) vs 5× gas 0.41 MON = 2.05 MON');
  });

  it('USDC without a usable price is skipped (stale, missing, non-positive)', () => {
    const base = { pending: 100_000_000n, isWmonPair: false, gasCostWei: 1n };
    expect(gate({ ...base, monUsd: { price: 50_000_000n, updatedAt: NOW - 3601n } }).reason).toMatch(/stale/);
    expect(gate({ ...base, monUsd: null }).reason).toMatch(/unavailable/);
    expect(gate({ ...base, monUsd: { price: 0n, updatedAt: NOW } }).reason).toMatch(/invalid/);
    for (const monUsd of [null, { price: 50_000_000n, updatedAt: NOW - 4000n }]) expect(gate({ ...base, monUsd }).send).toBe(false);
  });

  it('COLLECT_MIN_VALUE_MULTIPLE parsing', () => {
    expect(parseValueMultipleBps(undefined)).toBe(50_000n);
    expect(parseValueMultipleBps('')).toBe(50_000n);
    expect(parseValueMultipleBps('2.5')).toBe(25_000n);
    for (const bad of ['0', '-1', 'abc']) expect(() => parseValueMultipleBps(bad)).toThrow(/COLLECT_MIN_VALUE_MULTIPLE/);
  });
});

describe('jobCollectAll with the value gate', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const collects = () => vi.mocked(sendTx).mock.calls.filter((c: any) => c[0].functionName === 'collect');
  function pool(numeraire: string, total: bigint) {
    vi.mocked(getAssetNumeraire).mockResolvedValue(numeraire as Address);
    vi.mocked(publicClient.readContract).mockImplementation(async (args: any) => {
      if (args.functionName === 'assetData') return { poolId: '0x' + '00'.repeat(32), registered: true, numeraire, balanceUSDC: 0n, lastExecuteTime: 0n };
      if (args.functionName === 'getPoolKey') return { currency0: '0x0000000000000000000000000000000000000099', currency1: numeraire, fee: 20000, tickSpacing: 200, hooks: '0x0000000000000000000000000000000000000000' };
      return 0n;
    });
    vi.mocked(simulatePendingFees).mockResolvedValue({ fees0: 0n, fees1: total });
    vi.mocked(getBeneficiaryShare).mockResolvedValue(WAD);   // each beneficiary sees the whole amount
  }
  beforeEach(() => { vi.clearAllMocks(); _resetCadenceForTest(); vi.mocked(readMonUsd).mockResolvedValue(FRESH); });

  it('WMON pair, 0.106 WMON vs 0.141 MON gas → no collect sent, comparison logged', async () => {
    pool(WMON, parseEther('0.106'));
    vi.mocked(estimateTxCost).mockResolvedValue({ gas: 0n, gasBuffered: 0n, monCost: parseEther('0.141') });
    await jobCollectAll(ASSET);
    expect(collects()).toHaveLength(0);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('SKIP — value'));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('0.106 WMON ≈ 0.106 MON (WMON 1:1) vs 5× gas 0.141 MON = 0.705 MON');
  });

  it('WMON pair worth > 5× gas → collects', async () => {
    pool(WMON, parseEther('1'));
    vi.mocked(estimateTxCost).mockResolvedValue({ gas: 0n, gasBuffered: 0n, monCost: parseEther('0.141') });
    await jobCollectAll(ASSET);
    expect(collects()).toHaveLength(3);
  });

  it('USDC pair with a stale price → skipped; with a fresh price → collected', async () => {
    pool(USDC, 5_000_000n);   // 5 USDC = 10 MON at $0.50
    vi.mocked(estimateTxCost).mockResolvedValue({ gas: 0n, gasBuffered: 0n, monCost: parseEther('0.1') });
    vi.mocked(readMonUsd).mockResolvedValue({ price: 50_000_000n, updatedAt: NOW - 7200n });
    await jobCollectAll(ASSET);
    expect(collects()).toHaveLength(0);
    vi.mocked(readMonUsd).mockResolvedValue(FRESH);
    await jobCollectAll(ASSET);
    expect(collects()).toHaveLength(3);
  });

  it('gas estimate failure → skipped, no send', async () => {
    pool(WMON, parseEther('10'));
    vi.mocked(estimateTxCost).mockRejectedValue(new Error('execution reverted'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await jobCollectAll(ASSET);
    expect(collects()).toHaveLength(0);
  });
});
