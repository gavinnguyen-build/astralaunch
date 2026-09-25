/**
 * Keeper token discovery: which assets to service each tick.
 *
 * Default source is the server database, read fresh every tick so a token listed
 * after the keeper started is picked up on the next tick without a restart. Only
 * *listed* tokens qualify (launch fee consumed AND not admin-hidden), using the
 * server's own `isListedSql` so there is one definition of "listed". Unlisted spam
 * registrations therefore cannot make the keeper spend gas on them.
 *
 * ASSETS (optional, debugging) overrides discovery:
 *   - ASSETS + ROUTERS: explicit pairs, no database needed (fork / local usage).
 *   - ASSETS alone: those assets' rows from the tokens table, listed or not.
 *
 * The DB is a discovery hint, not an authority: jobs.ts cross-checks every target
 * against the chain before sending any transaction.
 *
 * No imports from chain.ts (it reads env at import time), so this is testable in isolation.
 */
import { inArray, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { getAddress, isAddress, type Address } from 'viem';
import { tokens } from '../../server/src/db/schema.js';
import { isListedSql } from '../../server/src/services/launchFee.js';

// Any drizzle Postgres database (postgres-js in prod, PGlite in tests).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, any, any>;

export interface KeeperTarget {
  asset: Address;
  router: Address;
  /** Numeraire recorded by the indexer (USDC or WMON). Undefined if unknown (env pairs, legacy rows). */
  numeraire?: Address;
  /** Doppler pool id recorded by the indexer. Undefined if unknown. */
  poolId?: `0x${string}`;
}

type TokenRow = { asset: string; router: string; numeraire: string; poolId: string };

/** Case-insensitive: env input and DB rows need not carry an EIP-55 checksum. */
const isAddr = (a: string) => isAddress(a, { strict: false });

function toTarget(row: TokenRow): KeeperTarget | null {
  if (!isAddr(row.asset) || !isAddr(row.router)) return null;
  return {
    asset: getAddress(row.asset),
    router: getAddress(row.router),
    numeraire: isAddr(row.numeraire) ? getAddress(row.numeraire) : undefined,
    poolId: /^0x[0-9a-fA-F]{64}$/.test(row.poolId) ? (row.poolId as `0x${string}`) : undefined,
  };
}

const columns = {
  asset: tokens.asset,
  router: tokens.router,
  numeraire: tokens.numeraire,
  poolId: tokens.poolId,
};

/** Listed tokens (fee consumed, not hidden), oldest first for a stable job order. */
export async function loadListedTargets(db: Db): Promise<KeeperTarget[]> {
  const rows = await db.select(columns).from(tokens)
    .where(isListedSql(tokens.asset))
    .orderBy(tokens.launchedAt, tokens.asset);
  return rows.map(toTarget).filter((t): t is KeeperTarget => t !== null);
}

/** Debug override: the given assets' rows, regardless of listing. */
async function loadAssetsFromDb(db: Db, assets: Address[]): Promise<KeeperTarget[]> {
  const rows = await db.select(columns).from(tokens)
    .where(inArray(sql`lower(${tokens.asset})`, assets.map(a => a.toLowerCase())));
  return rows.map(toTarget).filter((t): t is KeeperTarget => t !== null);
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

export interface TargetSource {
  kind: 'db' | 'env-pairs' | 'env-assets';
  describe: string;
}

/** Which source this env selects. Throws on a malformed override (fail fast at startup). */
export function targetSource(env: NodeJS.ProcessEnv, hasDb: boolean): TargetSource {
  const assets = parseList(env.ASSETS);
  const routers = parseList(env.ROUTERS);
  const bad = [...assets, ...routers].filter(a => !isAddr(a));
  if (bad.length) throw new Error(`Invalid address in ASSETS/ROUTERS: ${bad.join(', ')}`);

  if (assets.length === 0) {
    if (routers.length) throw new Error('ROUTERS is set without ASSETS');
    if (!hasDb) throw new Error('DATABASE_URL is required for token discovery (or set ASSETS for a debug override)');
    return { kind: 'db', describe: 'database (listed tokens)' };
  }
  if (routers.length) {
    if (routers.length !== assets.length) throw new Error('ASSETS and ROUTERS must have equal length');
    return { kind: 'env-pairs', describe: `ASSETS/ROUTERS override (${assets.length})` };
  }
  if (!hasDb) throw new Error('ASSETS without ROUTERS needs DATABASE_URL to look up routers');
  return { kind: 'env-assets', describe: `ASSETS override via database (${assets.length})` };
}

/** Resolve this tick's targets. Called every tick; never cached. */
export async function loadTargets(env: NodeJS.ProcessEnv, db: Db | null): Promise<KeeperTarget[]> {
  const source = targetSource(env, db !== null);
  const assets = parseList(env.ASSETS).map(a => getAddress(a));
  switch (source.kind) {
    case 'db':
      return loadListedTargets(db!);
    case 'env-pairs': {
      const routers = parseList(env.ROUTERS).map(r => getAddress(r));
      return assets.map((asset, i) => ({ asset, router: routers[i]! }));
    }
    case 'env-assets':
      return loadAssetsFromDb(db!, assets);
  }
}
