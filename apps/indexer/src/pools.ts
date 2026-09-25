import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { NUMERAIRE_DECIMALS, isCurrency0 } from '@astralaunch/shared';
import { idxRegistrations } from '../../server/src/db/schema.js';

/** Doppler-launched tokens are 18 decimals (DopplerERC20). */
export const ASSET_DECIMALS = 18;

export interface PoolMeta {
  poolId:            string;   // lowercase bytes32
  asset:             string;   // lowercase
  numeraire:         string;   // lowercase
  assetIsCurrency0:  boolean;
  numeraireDecimals: number;
}

const NUM_DEC = new Map(Object.entries(NUMERAIRE_DECIMALS).map(([k, v]) => [k.toLowerCase(), v]));

export function poolMeta(poolId: string, asset: string, numeraire: string): PoolMeta {
  const n = numeraire.toLowerCase();
  const dec = NUM_DEC.get(n);
  if (dec === undefined) throw new Error(`Unknown numeraire ${numeraire} for pool ${poolId}`);
  return { poolId: poolId.toLowerCase(), asset: asset.toLowerCase(), numeraire: n, assetIsCurrency0: isCurrency0(asset, numeraire), numeraireDecimals: dec };
}

/** Registered pools (poolId → meta), from idx_registrations + new Registered events. */
export class PoolRegistry {
  private pools = new Map<string, PoolMeta>();

  async load(db: PostgresJsDatabase<any>): Promise<void> {
    const rows = await db.select({ poolId: idxRegistrations.poolId, asset: idxRegistrations.asset, numeraire: idxRegistrations.numeraire })
      .from(idxRegistrations);
    for (const r of rows) if (r.numeraire) this.add(r.poolId, r.asset, r.numeraire);
  }

  add(poolId: string, asset: string, numeraire: string): boolean {
    const key = poolId.toLowerCase();
    if (this.pools.has(key)) return false;
    this.pools.set(key, poolMeta(poolId, asset, numeraire));
    return true;
  }

  get(poolId: string): PoolMeta | undefined { return this.pools.get(poolId.toLowerCase()); }
  poolIds(): `0x${string}`[] { return [...this.pools.keys()] as `0x${string}`[]; }
  assets(): `0x${string}`[] { return [...new Set([...this.pools.values()].map(p => p.asset))] as `0x${string}`[]; }
  get size(): number { return this.pools.size; }
}
