import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseEther } from 'viem';
import { canSpend, recordSpend, _resetForTest, _spendLogSize, SpendGuardError, alertIfExpensive } from '../spend.js';

// Mock telegram to avoid side effects
vi.mock('../telegram.js', () => ({
  sendTelegramAlert: vi.fn().mockResolvedValue(undefined),
}));

// Override env-based spend limits for deterministic tests
vi.stubEnv('MAX_MON_PER_DAY', undefined as any);
vi.stubEnv('MIN_MON_BALANCE', undefined as any);
vi.stubEnv('SINGLE_TX_ALERT', undefined as any);

const MON_02 = parseEther('0.2');  // 0.2 MON = default MAX_MON_PER_DAY and MIN_MON_BALANCE
const MON_01 = parseEther('0.1');
const MON_005 = parseEther('0.05');
const MON_1 = parseEther('1');

describe('spend guard', () => {
  beforeEach(() => {
    _resetForTest();
  });

  describe('canSpend', () => {
    it('returns ok when under all limits', () => {
      const result = canSpend(MON_01, MON_1);
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('rejects when wallet balance < MIN_MON_BALANCE + cost', () => {
      // Balance = 0.25, MIN = 0.2, cost = 0.1 → 0.25 < 0.2 + 0.1 = 0.3
      const result = canSpend(MON_01, parseEther('0.25'));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('wallet balance');
    });

    it('rejects when 24h spend exceeds MAX_MON_PER_DAY', () => {
      // Record 0.15 already spent
      recordSpend(parseEther('0.15'));
      // Try to spend 0.1 more → 0.15 + 0.1 = 0.25 > 0.2 MAX
      const result = canSpend(MON_01, MON_1);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('24h spend');
    });

    it('allows spend when exactly at MAX_MON_PER_DAY', () => {
      recordSpend(MON_01);
      // 0.1 + 0.1 = 0.2 = MAX (not over)
      const result = canSpend(MON_01, MON_1);
      expect(result.ok).toBe(true);
    });

    it('rejects when spend would exceed MAX_MON_PER_DAY by 1 wei', () => {
      recordSpend(MON_01);
      const result = canSpend(MON_01 + 1n, MON_1);
      expect(result.ok).toBe(false);
    });
  });

  describe('rolling window prune', () => {
    it('prunes entries older than 24h', () => {
      // Manually insert old entries by mocking Date.now
      const realNow = Date.now;
      const baseTime = realNow.call(Date);

      // Record spend "25 hours ago"
      vi.spyOn(Date, 'now').mockReturnValue(baseTime - 25 * 60 * 60 * 1000);
      recordSpend(MON_01);
      expect(_spendLogSize()).toBe(1);

      // Now check canSpend at current time — old entry should be pruned
      vi.spyOn(Date, 'now').mockReturnValue(baseTime);
      const result = canSpend(MON_01, MON_1);
      expect(result.ok).toBe(true);
      expect(_spendLogSize()).toBe(0); // old entry pruned
    });
  });

  describe('SpendGuardError', () => {
    it('is an instance of Error', () => {
      const err = new SpendGuardError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('SpendGuardError');
      expect(err.message).toBe('test');
    });
  });

  describe('alertIfExpensive', () => {
    it('calls sendTelegramAlert when cost > threshold', async () => {
      const { sendTelegramAlert } = await import('../telegram.js');
      await alertIfExpensive(parseEther('0.06'), 'test@0x1234');
      expect(sendTelegramAlert).toHaveBeenCalledWith(
        expect.stringContaining('Expensive Keeper TX'),
      );
    });

    it('does not alert when cost <= threshold', async () => {
      const { sendTelegramAlert } = await import('../telegram.js');
      vi.mocked(sendTelegramAlert).mockClear();
      await alertIfExpensive(parseEther('0.04'), 'test@0x1234');
      expect(sendTelegramAlert).not.toHaveBeenCalled();
    });
  });
});
