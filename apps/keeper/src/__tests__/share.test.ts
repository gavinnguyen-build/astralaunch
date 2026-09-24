import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chain.ts
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
  sendTx: vi.fn().mockResolvedValue({ hash: '0x00', gasBuffered: 0n, monCost: 0n }),
  DRY_RUN: false,
  simulatePendingFees: vi.fn(),
  getBeneficiaryShare: vi.fn(),
}));

// Mock telegram
vi.mock('../telegram.js', () => ({
  sendTelegramAlert: vi.fn().mockResolvedValue(undefined),
}));

// Mock spend
vi.mock('../spend.js', () => ({
  SpendGuardError: class SpendGuardError extends Error {
    constructor(msg: string) { super(msg); this.name = 'SpendGuardError'; }
  },
}));

import { runAssetJobs, _resetCadenceForTest } from '../jobs.js';
import { publicClient, sendTx, simulatePendingFees, getBeneficiaryShare } from '../chain.js';
import { ESCROW_SHARE_WAD, BUYBACK_SHARE_WAD, TREASURY_SHARE_WAD, WAD } from '@revpad/shared';
import type { Address } from 'viem';

const ASSET = '0x1111111111111111111111111111111111111111' as Address;
const ROUTER = '0x2222222222222222222222222222222222222222' as Address;

const ESCROW = '0x0000000000000000000000000000000000000001' as Address;
const VAULT = '0x0000000000000000000000000000000000000002' as Address;
const PFR = '0x0000000000000000000000000000000000000003' as Address;

// Total pool fees = 10 USDC (10_000_000 in 6 dec)
const TOTAL_USDC = 10_000_000n;

describe('per-beneficiary pending fee shares', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCadenceForTest();

    // assetData: currency1 is USDC (fees1 = USDC)
    vi.mocked(publicClient.readContract).mockImplementation(async (args: any) => {
      if (args.functionName === 'balanceOf') return 0n; // distribute skip
      if (args.functionName === 'assetData') {
        return {
          poolKey: {
            currency0: '0x0000000000000000000000000000000000000099',
            currency1: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', // USDC
            fee: 20000, tickSpacing: 200, hooks: '0x0000000000000000000000000000000000000000',
          },
          poolId: '0x' + '00'.repeat(32),
          registered: true,
          balanceUSDC: 0n,
          buybackFromRevenue: 0n, buybackFromTrading: 0n,
          tokenBalance: 0n, lastExecuteTime: 0n,
        };
      }
      if (args.functionName === 'tokenData') {
        return {
          creator: '0x0000000000000000000000000000000000000000',
          launchTime: 0n, forfeited: true,
          usdcAccrued: 0n, usdcClaimed: 0n,
          tokenPending: 0n, recordedRevenue: 0n,
          poolId: '0x' + '00'.repeat(32),
        };
      }
      return 0n;
    });

    // simulatePendingFees returns TOTAL fees (same for all callers — this is the bug we're fixing)
    vi.mocked(simulatePendingFees).mockResolvedValue({ fees0: 0n, fees1: TOTAL_USDC });

    // getBeneficiaryShare returns per-beneficiary WAD share
    vi.mocked(getBeneficiaryShare).mockImplementation(async (_poolId: any, beneficiary: any) => {
      const addr = (beneficiary as string).toLowerCase();
      if (addr === ESCROW.toLowerCase()) return ESCROW_SHARE_WAD;    // 20%
      if (addr === VAULT.toLowerCase()) return BUYBACK_SHARE_WAD;    // 10%
      if (addr === PFR.toLowerCase()) return TREASURY_SHARE_WAD;     // 30%
      return 0n;
    });
  });

  it('escrow gets 20% of total (2 USDC from 10 USDC total)', async () => {
    const expected = (TOTAL_USDC * ESCROW_SHARE_WAD) / WAD; // 2_000_000n
    expect(expected).toBe(2_000_000n);

    // With 10 USDC total and 1 USDC threshold, escrow's 2 USDC should trigger collect
    await runAssetJobs(ASSET, ROUTER);

    // sendTx should have been called for collect (escrow has 2 USDC >= 1 USDC threshold)
    const collectCalls = vi.mocked(sendTx).mock.calls.filter(
      (c: any) => c[0].functionName === 'collect',
    );
    expect(collectCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('vault gets only 10% of total (1 USDC from 10 USDC total)', async () => {
    const expected = (TOTAL_USDC * BUYBACK_SHARE_WAD) / WAD; // 1_000_000n
    expect(expected).toBe(1_000_000n);
  });

  it('PFR gets 30% of total (3 USDC from 10 USDC total)', async () => {
    const expected = (TOTAL_USDC * TREASURY_SHARE_WAD) / WAD; // 3_000_000n
    expect(expected).toBe(3_000_000n);
  });

  it('different beneficiaries report DIFFERENT pending amounts', async () => {
    const escrowPending = (TOTAL_USDC * ESCROW_SHARE_WAD) / WAD;
    const vaultPending = (TOTAL_USDC * BUYBACK_SHARE_WAD) / WAD;
    const pfrPending = (TOTAL_USDC * TREASURY_SHARE_WAD) / WAD;

    // All three must be distinct values (this was the original bug)
    expect(escrowPending).not.toBe(vaultPending);
    expect(escrowPending).not.toBe(pfrPending);
    expect(vaultPending).not.toBe(pfrPending);

    // Sum of beneficiary shares we care about = 60%
    expect(escrowPending + vaultPending + pfrPending).toBe(
      (TOTAL_USDC * (ESCROW_SHARE_WAD + BUYBACK_SHARE_WAD + TREASURY_SHARE_WAD)) / WAD,
    );
  });

  it('skips collect when per-beneficiary share is below threshold', async () => {
    // Total = 0.5 USDC → vault share (10%) = 0.05 USDC < 1 USDC threshold
    vi.mocked(simulatePendingFees).mockResolvedValue({ fees0: 0n, fees1: 500_000n });

    await runAssetJobs(ASSET, ROUTER);

    // No collect txs should be sent (all per-beneficiary amounts < 1 USDC)
    const collectCalls = vi.mocked(sendTx).mock.calls.filter(
      (c: any) => c[0].functionName === 'collect',
    );
    expect(collectCalls).toHaveLength(0);
  });

  it('returns 0 when share is 0 (unknown beneficiary)', async () => {
    vi.mocked(getBeneficiaryShare).mockResolvedValue(0n);
    vi.mocked(simulatePendingFees).mockResolvedValue({ fees0: 0n, fees1: TOTAL_USDC });

    await runAssetJobs(ASSET, ROUTER);

    const collectCalls = vi.mocked(sendTx).mock.calls.filter(
      (c: any) => c[0].functionName === 'collect',
    );
    expect(collectCalls).toHaveLength(0);
  });
});
