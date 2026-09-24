import { describe, it, expect, vi } from 'vitest';
import { RouterRegistry } from '../discovery.js';

// Mock the schema import
vi.mock('../../../server/src/db/schema.js', () => ({
  idxRegistrations: { _: 'idxRegistrations' },
}));

describe('RouterRegistry', () => {
  it('adds a new router and returns true', () => {
    const registry = new RouterRegistry();
    const isNew = registry.add('0xRouter1', '0xAsset1');
    expect(isNew).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.isRouter('0xrouter1')).toBe(true);
  });

  it('returns false for duplicate router', () => {
    const registry = new RouterRegistry();
    registry.add('0xRouter1', '0xAsset1');
    const isNew = registry.add('0xRouter1', '0xAsset1');
    expect(isNew).toBe(false);
    expect(registry.size).toBe(1);
  });

  it('is case-insensitive', () => {
    const registry = new RouterRegistry();
    registry.add('0xABCDEF', '0xAsset1');
    expect(registry.isRouter('0xabcdef')).toBe(true);
    expect(registry.isRouter('0xABCDEF')).toBe(true);
    expect(registry.getAsset('0xABCDEF')).toBe('0xasset1');
  });

  it('returns all router addresses', () => {
    const registry = new RouterRegistry();
    registry.add('0xRouter1', '0xAsset1');
    registry.add('0xRouter2', '0xAsset2');
    const addrs = registry.getRouterAddresses();
    expect(addrs).toHaveLength(2);
    expect(addrs).toContain('0xrouter1');
    expect(addrs).toContain('0xrouter2');
  });

  it('returns undefined for unknown router', () => {
    const registry = new RouterRegistry();
    expect(registry.getAsset('0xunknown')).toBeUndefined();
    expect(registry.isRouter('0xunknown')).toBe(false);
  });

  it('loads from database', async () => {
    const registry = new RouterRegistry();

    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => [
          { router: '0xRouter1', asset: '0xAsset1' },
          { router: '0xRouter2', asset: '0xAsset2' },
        ]),
      })),
    };

    await registry.load(mockDb as any);
    expect(registry.size).toBe(2);
    expect(registry.isRouter('0xrouter1')).toBe(true);
    expect(registry.isRouter('0xrouter2')).toBe(true);
  });
});
