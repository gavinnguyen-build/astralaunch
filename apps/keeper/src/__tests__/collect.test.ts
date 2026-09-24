import { describe, it, expect } from 'vitest';
import { shouldCollect } from '../jobs.js';

const USDC_1 = 1_000_000n;   // 1 USDC
const USDC_05 = 500_000n;    // 0.5 USDC
const USDC_2 = 2_000_000n;   // 2 USDC
const SIX_HOURS = 21_600;    // default COLLECT_INTERVAL_S
const NOW = 1_700_000_000;   // arbitrary "now" in seconds

describe('shouldCollect — threshold checks', () => {
  it('SEND when pending >= threshold and no prior collect', () => {
    const result = shouldCollect(USDC_1, 0, NOW, USDC_1, SIX_HOURS);
    expect(result.send).toBe(true);
  });

  it('SEND when pending well above threshold', () => {
    const result = shouldCollect(USDC_2, 0, NOW, USDC_1, SIX_HOURS);
    expect(result.send).toBe(true);
    expect(result.reason).toContain('2');
  });

  it('SKIP when pending < threshold', () => {
    const result = shouldCollect(USDC_05, 0, NOW, USDC_1, SIX_HOURS);
    expect(result.send).toBe(false);
    expect(result.reason).toContain('pending');
    expect(result.reason).toContain('< min');
  });

  it('SKIP when pending is 0', () => {
    const result = shouldCollect(0n, 0, NOW, USDC_1, SIX_HOURS);
    expect(result.send).toBe(false);
  });

  it('SEND when pending exactly equals threshold', () => {
    const result = shouldCollect(USDC_1, 0, NOW, USDC_1, SIX_HOURS);
    expect(result.send).toBe(true);
  });
});

describe('shouldCollect — cadence checks', () => {
  it('SKIP when last collect was too recent', () => {
    const lastTs = NOW - 3600; // 1 hour ago (< 6 hours)
    const result = shouldCollect(USDC_2, lastTs, NOW, USDC_1, SIX_HOURS);
    expect(result.send).toBe(false);
    expect(result.reason).toContain('cadence');
    expect(result.reason).toContain('3600s');
  });

  it('SEND when cadence period has elapsed', () => {
    const lastTs = NOW - SIX_HOURS; // exactly 6 hours ago
    const result = shouldCollect(USDC_2, lastTs, NOW, USDC_1, SIX_HOURS);
    expect(result.send).toBe(true);
  });

  it('SEND when cadence period exceeded', () => {
    const lastTs = NOW - SIX_HOURS - 1; // 6h + 1s ago
    const result = shouldCollect(USDC_2, lastTs, NOW, USDC_1, SIX_HOURS);
    expect(result.send).toBe(true);
  });

  it('SKIP cadence even with high pending (cadence checked first)', () => {
    const lastTs = NOW - 100; // 100 seconds ago
    const result = shouldCollect(100_000_000n, lastTs, NOW, USDC_1, SIX_HOURS);
    expect(result.send).toBe(false);
    expect(result.reason).toContain('cadence');
  });

  it('cadence not applied on first-ever collect (lastTs = 0)', () => {
    const result = shouldCollect(USDC_2, 0, NOW, USDC_1, SIX_HOURS);
    expect(result.send).toBe(true);
  });
});

describe('shouldCollect — custom thresholds', () => {
  it('respects custom threshold (0.5 USDC)', () => {
    const result = shouldCollect(USDC_05, 0, NOW, USDC_05, SIX_HOURS);
    expect(result.send).toBe(true);
  });

  it('respects custom interval (1 hour)', () => {
    const lastTs = NOW - 3601; // 1h + 1s ago
    const result = shouldCollect(USDC_2, lastTs, NOW, USDC_1, 3600);
    expect(result.send).toBe(true);
  });

  it('blocks with custom interval (1 hour) when too recent', () => {
    const lastTs = NOW - 3599; // 59m59s ago
    const result = shouldCollect(USDC_2, lastTs, NOW, USDC_1, 3600);
    expect(result.send).toBe(false);
  });
});
