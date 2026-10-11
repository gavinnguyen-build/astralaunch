/**
 * distribute() job (D-KP1): never below the router's own minimum, and a call the router ignores (no Distributed
 * event) is not repeated until the router's balance changes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../chain.js', () => ({
  publicClient: { readContract: vi.fn(), waitForTransactionReceipt: vi.fn() },
  ESCROW: '0x0000000000000000000000000000000000000001',
  VAULT: '0x0000000000000000000000000000000000000002',
  PLATFORM_FEE_RECEIVER: '0x0000000000000000000000000000000000000003',
  WMON: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
  sendTx: vi.fn().mockResolvedValue({ hash: '0xabc', gasBuffered: 0n, monCost: 0n }),
  DRY_RUN: false,
  simulatePendingFees: vi.fn(), getBeneficiaryShare: vi.fn(), getAssetNumeraire: vi.fn(), estimateTxCost: vi.fn(), readMonUsd: vi.fn(),
}));
vi.mock('../telegram.js', () => ({ sendTelegramAlert: vi.fn().mockResolvedValue(undefined), html: (s: TemplateStringsArray, ...v: unknown[]) => s.reduce((a, b, i) => a + b + (v[i] ?? ''), '') }));
vi.mock('../spend.js', () => ({ SpendGuardError: class SpendGuardError extends Error {} }));

import { jobDistribute, effectiveMinDistribute, _resetCadenceForTest } from '../jobs.js';
import { publicClient, sendTx } from '../chain.js';
import { sendTelegramAlert } from '../telegram.js';
import { ROUTER_MIN_DISTRIBUTE_USDC } from '@astralaunch/shared';
import type { Address } from 'viem';

const ROUTER = '0x10bC2220716738E8Aef57b9CC72101c190acf240' as Address;
const OTHER = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
let balance = 0n;
const ignored = { status: 'success', logs: [] };                                         // the incident: no event
const realDistribute = { status: 'success', logs: [{ address: OTHER }, { address: ROUTER.toLowerCase() }] };

describe('keeper distribute job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCadenceForTest();
    vi.mocked(publicClient.readContract).mockImplementation(async () => balance);
  });

  it('a configured threshold below the router minimum is raised to it', () => {
    expect(effectiveMinDistribute(100_000n)).toBe(ROUTER_MIN_DISTRIBUTE_USDC);   // the old 0.1 USDC default
    expect(effectiveMinDistribute(ROUTER_MIN_DISTRIBUTE_USDC)).toBe(ROUTER_MIN_DISTRIBUTE_USDC);
    expect(effectiveMinDistribute(1_000_000n)).toBe(1_000_000n);
  });

  it('the incident balances (0.25 and 0.10 USDC) send nothing', async () => {
    for (const b of [250_000n, 100_000n, 999_999n]) {
      balance = b;
      await jobDistribute(ROUTER);
    }
    expect(sendTx).not.toHaveBeenCalled();
  });

  it('a distribute that emits nothing is not repeated until the balance changes; one alert', async () => {
    balance = 1_500_000n;
    vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue(ignored as never);
    await jobDistribute(ROUTER);
    await jobDistribute(ROUTER);
    await jobDistribute(ROUTER);
    expect(sendTx).toHaveBeenCalledTimes(1);
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);

    balance = 2_000_000n;                                  // new revenue arrived: try again
    vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue(realDistribute as never);
    await jobDistribute(ROUTER);
    expect(sendTx).toHaveBeenCalledTimes(2);
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('a real distribute (event from the router) raises no alert and does not block the next one', async () => {
    balance = 3_000_000n;
    vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue(realDistribute as never);
    await jobDistribute(ROUTER);
    await jobDistribute(ROUTER);
    expect(sendTx).toHaveBeenCalledTimes(2);
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });
});
