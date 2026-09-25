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
vi.mock('../telegram.js', () => ({ sendTelegramAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../spend.js', () => ({
  SpendGuardError: class SpendGuardError extends Error {},
}));

import { verifyTarget, runTargetJobs, _resetCadenceForTest } from '../jobs.js';
import { publicClient, sendTx } from '../chain.js';
import type { Address } from 'viem';

const ASSET = '0x1111111111111111111111111111111111111111' as Address;
const ROUTER = '0x2222222222222222222222222222222222222222' as Address;
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address;
const WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A' as Address;
const POOL = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

let routerAsset: Address = ASSET;

beforeEach(() => {
  vi.clearAllMocks();
  _resetCadenceForTest();
  routerAsset = ASSET;
  vi.mocked(publicClient.readContract).mockImplementation(async (args: any) => {
    switch (args.functionName) {
      case 'asset': return routerAsset;
      case 'assetData': return { poolId: POOL, registered: true, numeraire: USDC, balanceUSDC: 0n,
        buybackFromRevenue: 0n, buybackFromTrading: 0n, tokenBalance: 0n, lastExecuteTime: 0n };
      case 'getPoolKey': return { currency0: '0x0000000000000000000000000000000000000099', currency1: USDC,
        fee: 20000, tickSpacing: 200, hooks: '0x0000000000000000000000000000000000000000' };
      case 'tokenData': return { creator: '0x0000000000000000000000000000000000000000', launchTime: 0n, forfeited: true,
        usdcAccrued: 0n, usdcClaimed: 0n, tokenPending: 0n, recordedRevenue: 0n, poolId: POOL, numeraire: USDC };
      default: return 0n;
    }
  });
});

describe('verifyTarget', () => {
  it('accepts a target whose router, numeraire and pool match the chain', async () => {
    expect(await verifyTarget({ asset: ASSET, router: ROUTER, numeraire: USDC, poolId: POOL })).toBeNull();
  });

  it('accepts env targets without numeraire / pool data', async () => {
    expect(await verifyTarget({ asset: ASSET, router: ROUTER })).toBeNull();
  });

  it('rejects a router that belongs to another asset', async () => {
    routerAsset = '0x9999999999999999999999999999999999999999';
    expect(await verifyTarget({ asset: ASSET, router: ROUTER })).toMatch(/reports asset/);
  });

  it('rejects a numeraire that disagrees with the registry', async () => {
    expect(await verifyTarget({ asset: ASSET, router: ROUTER, numeraire: WMON })).toMatch(/numeraire mismatch/);
  });

  it('rejects a pool id that disagrees with the vault', async () => {
    const other = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
    expect(await verifyTarget({ asset: ASSET, router: ROUTER, poolId: other })).toMatch(/poolId mismatch/);
  });

  it('caches a verified target (router wiring is immutable)', async () => {
    await verifyTarget({ asset: ASSET, router: ROUTER });
    const calls = vi.mocked(publicClient.readContract).mock.calls.length;
    await verifyTarget({ asset: ASSET, router: ROUTER });
    expect(vi.mocked(publicClient.readContract).mock.calls.length).toBe(calls);
  });
});

describe('runTargetJobs', () => {
  it('sends no transaction for a mismatched target', async () => {
    routerAsset = '0x9999999999999999999999999999999999999999';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runTargetJobs({ asset: ASSET, router: ROUTER });
    expect(sendTx).not.toHaveBeenCalled();
    expect(vi.mocked(publicClient.readContract).mock.calls.map((c: any) => c[0].functionName)).toEqual(['asset']);
  });

  it('runs the jobs for a verified target', async () => {
    await runTargetJobs({ asset: ASSET, router: ROUTER, numeraire: USDC, poolId: POOL });
    const fns = vi.mocked(publicClient.readContract).mock.calls.map((c: any) => c[0].functionName);
    expect(fns).toContain('balanceOf');   // distribute pre-check on the router ran
  });
});
