/**
 * Clean revenue filtering test (SPEC §13).
 *
 * Tests the logic applied in GET /api/tokens/:asset/metrics:
 * A payment is clean only if ALL hold:
 *   1. settled by a FACILITATOR_SUBMITTER (is_facilitator_settled)
 *   2. payer is not the token's creator
 *   3. payer is not the router or any Astralaunch contract
 */
import { describe, it, expect } from 'vitest';

// The filtering logic extracted for testability (mirrors tokens.ts metrics endpoint)
interface Transfer {
  fromAddr: string;
  value: string;
  isFacilitatorSettled: boolean;
}

interface Exclusion {
  payer: string;
  amount: string;
  reason: string;
}

function computeCleanRevenue(
  transfers: Transfer[],
  creatorAddr: string,
  excludedAddrs: Set<string>,
): { rawRevenue: bigint; cleanRevenue: bigint; exclusions: Exclusion[] } {
  let rawRevenue = 0n;
  let cleanRevenue = 0n;
  const exclusions: Exclusion[] = [];

  for (const t of transfers) {
    const val = BigInt(t.value);
    rawRevenue += val;
    const payer = t.fromAddr.toLowerCase();

    if (!t.isFacilitatorSettled) {
      exclusions.push({ payer: t.fromAddr, amount: t.value, reason: 'not_facilitator' });
      continue;
    }
    if (payer === creatorAddr.toLowerCase()) {
      exclusions.push({ payer: t.fromAddr, amount: t.value, reason: 'creator' });
      continue;
    }
    if (excludedAddrs.has(payer)) {
      exclusions.push({ payer: t.fromAddr, amount: t.value, reason: 'contract' });
      continue;
    }
    cleanRevenue += val;
  }

  return { rawRevenue, cleanRevenue, exclusions };
}

describe('clean revenue filtering', () => {
  // Known mainnet data: nullsight token
  const NULLSIGHT_ASSET   = '0x13db78bd3f92382306a17d50dac93af1904e171d';
  const NULLSIGHT_CREATOR = '0x11e2dd9a4b9062675fd89178a2c9778182dfcbc6';
  const NULLSIGHT_ROUTER  = '0x95d381aa54a2da62c835dd081d1d5a0f8700c722';

  // Astralaunch contract addresses
  const ESCROW   = '0x22523feea974939fd6c94daf7f9d112d667dec3b';
  const VAULT    = '0xcbe741362a59943174f028a44a1b82722c24e7e7';
  const REGISTRY = '0x25845cee2b0e6df0da40bb9b60a84d162eabd00b';
  const PFR      = '0x510cb102906a4be9193b025620f6824ee8b4ec21';
  const TREASURY = '0x888f0bdd45e460b4af4a4a58d183ea86ce9a351c';

  const excludedAddrs = new Set([
    NULLSIGHT_CREATOR,
    NULLSIGHT_ROUTER,
    ESCROW, VAULT, REGISTRY, PFR, TREASURY,
  ]);

  it('nullsight: rawRevenue 500000, cleanRevenue 0, one exclusion reason=creator', () => {
    // The single USDC transfer to the nullsight router: 0.5 USDC (500000)
    // from the creator (0x11e2...), settled by facilitator
    const transfers: Transfer[] = [
      {
        fromAddr: '0x11e2dd9a4b9062675fd89178a2c9778182dfcbc6',
        value: '500000',
        isFacilitatorSettled: true,
      },
    ];

    const result = computeCleanRevenue(transfers, NULLSIGHT_CREATOR, excludedAddrs);

    expect(result.rawRevenue.toString()).toBe('500000');
    expect(result.cleanRevenue.toString()).toBe('0');
    expect(result.exclusions).toHaveLength(1);
    expect(result.exclusions[0]!.reason).toBe('creator');
    expect(result.exclusions[0]!.payer).toBe('0x11e2dd9a4b9062675fd89178a2c9778182dfcbc6');
    expect(result.exclusions[0]!.amount).toBe('500000');
  });

  it('non-facilitator transfer is excluded with reason not_facilitator', () => {
    const transfers: Transfer[] = [
      {
        fromAddr: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        value: '1000000',
        isFacilitatorSettled: false,
      },
    ];

    const result = computeCleanRevenue(transfers, NULLSIGHT_CREATOR, excludedAddrs);

    expect(result.rawRevenue.toString()).toBe('1000000');
    expect(result.cleanRevenue.toString()).toBe('0');
    expect(result.exclusions[0]!.reason).toBe('not_facilitator');
  });

  it('contract address as payer is excluded with reason contract', () => {
    const transfers: Transfer[] = [
      {
        fromAddr: ESCROW,
        value: '250000',
        isFacilitatorSettled: true,
      },
    ];

    const result = computeCleanRevenue(transfers, NULLSIGHT_CREATOR, excludedAddrs);

    expect(result.rawRevenue.toString()).toBe('250000');
    expect(result.cleanRevenue.toString()).toBe('0');
    expect(result.exclusions[0]!.reason).toBe('contract');
  });

  it('legitimate third-party payment counts as clean', () => {
    const transfers: Transfer[] = [
      {
        fromAddr: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        value: '2000000',
        isFacilitatorSettled: true,
      },
    ];

    const result = computeCleanRevenue(transfers, NULLSIGHT_CREATOR, excludedAddrs);

    expect(result.rawRevenue.toString()).toBe('2000000');
    expect(result.cleanRevenue.toString()).toBe('2000000');
    expect(result.exclusions).toHaveLength(0);
  });

  it('mixed transfers: sums clean correctly, excludes others', () => {
    const transfers: Transfer[] = [
      // Clean
      { fromAddr: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', value: '1000000', isFacilitatorSettled: true },
      // Creator
      { fromAddr: NULLSIGHT_CREATOR, value: '500000', isFacilitatorSettled: true },
      // Not facilitator
      { fromAddr: '0xcccccccccccccccccccccccccccccccccccccccc', value: '300000', isFacilitatorSettled: false },
      // Clean
      { fromAddr: '0xdddddddddddddddddddddddddddddddddddddd', value: '2000000', isFacilitatorSettled: true },
    ];

    const result = computeCleanRevenue(transfers, NULLSIGHT_CREATOR, excludedAddrs);

    expect(result.rawRevenue.toString()).toBe('3800000');
    expect(result.cleanRevenue.toString()).toBe('3000000');
    expect(result.exclusions).toHaveLength(2);
    expect(result.exclusions.find(e => e.reason === 'creator')).toBeDefined();
    expect(result.exclusions.find(e => e.reason === 'not_facilitator')).toBeDefined();
  });
});
