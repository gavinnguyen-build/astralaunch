import { describe, it, expect } from 'vitest';
import {
  BUYBACK_MIN_INTERVAL_S,
  KEEPER_MIN_COLLECT_USDC,
  KEEPER_MIN_DISTRIBUTE_USDC,
  KEEPER_MIN_BUYBACK_USDC,
  COLLECT_INTERVAL_S,
  MAX_MON_PER_DAY_WEI,
  MIN_MON_BALANCE_WEI,
  SINGLE_TX_ALERT_WEI,
} from '@astralaunch/shared';

describe('keeper-related constants', () => {
  it('BUYBACK_MIN_INTERVAL_S is 600 (matches Solidity)', () => {
    expect(BUYBACK_MIN_INTERVAL_S).toBe(600);
  });

  it('economic thresholds default to 1 USDC (1_000_000)', () => {
    // Origin: chosen so gas cost (~0.1 MON ≈ $0.03) is a small fraction
    // of the USDC value processed. 1 USDC ≈ 33× the gas cost.
    expect(KEEPER_MIN_COLLECT_USDC).toBe(1_000_000n);
    expect(KEEPER_MIN_DISTRIBUTE_USDC).toBe(1_000_000n);
    expect(KEEPER_MIN_BUYBACK_USDC).toBe(1_000_000n);
  });

  it('collect cadence default is 6 hours', () => {
    expect(COLLECT_INTERVAL_S).toBe(21_600);
  });

  it('spend guard defaults are 0.2 MON and 0.05 MON', () => {
    const MON = 10n ** 18n;
    expect(MAX_MON_PER_DAY_WEI).toBe((MON * 2n) / 10n);
    expect(MIN_MON_BALANCE_WEI).toBe((MON * 2n) / 10n);
    expect(SINGLE_TX_ALERT_WEI).toBe((MON * 5n) / 100n);
  });
});
