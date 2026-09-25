/**
 * Clean-revenue classification (SPEC §13, display only; contracts count all inflows).
 * A USDC transfer into a token's router is clean when it was settled by a known facilitator
 * submitter and the payer is neither the token's creator nor a router / platform contract.
 * Shared by /api/tokens/:asset/metrics and /api/leaderboard.
 */
export type CleanClass = 'clean' | 'not_facilitator' | 'creator' | 'contract';

export interface PlatformAddrs {
  escrow: string; vault: string; registry: string; pfr?: string; treasury?: string;
}

/** Addresses whose payments are never clean for a token (its router + platform contracts). */
export function excludedPayers(router: string, p: PlatformAddrs): Set<string> {
  return new Set([router, p.escrow, p.vault, p.registry, p.pfr, p.treasury]
    .filter((a): a is string => !!a).map((a) => a.toLowerCase()));
}

export function classifyTransfer(
  t: { fromAddr: string; isFacilitatorSettled: boolean },
  creator: string,
  excluded: Set<string>,
): CleanClass {
  const payer = t.fromAddr.toLowerCase();
  if (!t.isFacilitatorSettled) return 'not_facilitator';
  if (payer === creator.toLowerCase()) return 'creator';
  if (excluded.has(payer)) return 'contract';
  return 'clean';
}
