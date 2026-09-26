/**
 * Follow mode cadence: the full cycle (registry, routers, USDC transfers, market) every POLL_INTERVAL_S;
 * in between, market data only (swaps + asset transfers) every SWAP_POLL_INTERVAL_S. Sequential steps.
 */
import { describe, it, expect, vi } from 'vitest';
import { Indexer } from '../indexer.js';

function make() {
  const ix = new Indexer({} as never, {} as never, {
    chainId: 143, startBlock: 0n, chunkSize: 100, finalityLag: 0, maxRps: 25,
    registryAddr: '0x1', escrowAddr: '0x2', vaultAddr: '0x3', pfrAddr: '0x4', usdcAddr: '0x5',
    facilitatorAddrs: new Set(),
  } as never);
  const full = vi.spyOn(ix, 'processAll').mockResolvedValue(false);
  const market = vi.spyOn(ix, 'processMarket').mockResolvedValue(false);
  return { ix, full, market };
}

describe('Indexer.tick (follow cadence)', () => {
  it('10 s full cycle with a 3 s market tick: full at 0 s, market at 3/6/9 s, full again at 12 s', async () => {
    const { ix, full, market } = make();
    const kinds: string[] = [];
    for (const t of [0, 3, 6, 9, 12, 15]) kinds.push(await ix.tick(t * 1000, 10_000));
    expect(kinds).toEqual(['full', 'market', 'market', 'market', 'full', 'market']);
    expect(full).toHaveBeenCalledTimes(2);
    expect(market).toHaveBeenCalledTimes(4);
  });

  it('equal intervals (swap interval unset) behave like before: every step is a full cycle', async () => {
    const { ix, full, market } = make();
    for (const t of [0, 10, 20]) expect(await ix.tick(t * 1000, 10_000)).toBe('full');
    expect(full).toHaveBeenCalledTimes(3);
    expect(market).not.toHaveBeenCalled();
  });

  it('processMarket runs only the swap and asset-transfer sets, never the money sets', async () => {
    const ix = new Indexer({} as never, {} as never, { chainId: 143 } as never);
    const swaps = vi.spyOn(ix, 'processSwapsChunk').mockResolvedValueOnce(true).mockResolvedValue(false);
    const assets = vi.spyOn(ix, 'processAssetTransfersChunk').mockResolvedValue(false);
    const moneySets = [vi.spyOn(ix, 'processStaticChunk'), vi.spyOn(ix, 'processRoutersChunk'), vi.spyOn(ix, 'processUsdcChunk')];
    expect(await ix.processMarket()).toBe(true);
    expect(swaps).toHaveBeenCalledTimes(2);
    expect(assets).toHaveBeenCalledTimes(1);
    for (const s of moneySets) expect(s).not.toHaveBeenCalled();
  });
});
