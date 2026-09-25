import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chain.ts to avoid env var requirements and RPC calls
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
  simulatePendingFees: vi.fn().mockResolvedValue({ fees0: 0n, fees1: 0n }),
  getBeneficiaryShare: vi.fn().mockResolvedValue(0n),
  getAssetNumeraire: vi.fn().mockResolvedValue('0x754704Bc059F8C67012fEd69BC8A327a5aafb603'),
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
import { publicClient, sendTx, simulatePendingFees } from '../chain.js';
import type { Address } from 'viem';

const ASSET = '0x1111111111111111111111111111111111111111' as Address;
const ROUTER = '0x2222222222222222222222222222222222222222' as Address;

describe('job ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCadenceForTest();

    // vault assetData for metadata cache — currency0 < USDC so fees0 is NOT usdc
    vi.mocked(publicClient.readContract).mockImplementation(async (args: any) => {
      if (args.functionName === 'balanceOf') return 0n;
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
  });

  it('calls distribute and buyback BEFORE collect', async () => {
    const callOrder: string[] = [];
    const origReadContract = vi.mocked(publicClient.readContract);
    origReadContract.mockImplementation(async (args: any) => {
      if (args.functionName === 'balanceOf') {
        callOrder.push('distribute:balanceOf');
        return 0n; // below threshold → skip
      }
      if (args.functionName === 'assetData') {
        callOrder.push('buyback:assetData');
        return {
          poolKey: {
            currency0: '0x0000000000000000000000000000000000000099',
            currency1: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
            fee: 20000, tickSpacing: 200, hooks: '0x0000000000000000000000000000000000000000',
          },
          poolId: '0x' + '00'.repeat(32),
          registered: true,
          balanceUSDC: 0n, // below threshold → skip
          buybackFromRevenue: 0n, buybackFromTrading: 0n,
          tokenBalance: 0n, lastExecuteTime: 0n,
        };
      }
      if (args.functionName === 'tokenData') {
        callOrder.push('forfeit:tokenData');
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

    vi.mocked(simulatePendingFees).mockResolvedValue({ fees0: 0n, fees1: 0n });

    await runAssetJobs(ASSET, ROUTER);

    // distribute reads balanceOf first, then buyback reads assetData,
    // then collect reads assetData (cached) + simulatePendingFees,
    // then forfeit reads tokenData
    const distributeIdx = callOrder.indexOf('distribute:balanceOf');
    const buybackIdx = callOrder.indexOf('buyback:assetData');
    const forfeitIdx = callOrder.indexOf('forfeit:tokenData');

    expect(distributeIdx).toBeGreaterThanOrEqual(0);
    expect(buybackIdx).toBeGreaterThan(distributeIdx);
    expect(forfeitIdx).toBeGreaterThan(buybackIdx);
  });

  it('does not send collect tx when pending is 0', async () => {
    vi.mocked(simulatePendingFees).mockResolvedValue({ fees0: 0n, fees1: 0n });

    await runAssetJobs(ASSET, ROUTER);

    // sendTx should NOT have been called (all below threshold)
    expect(sendTx).not.toHaveBeenCalled();
  });
});
