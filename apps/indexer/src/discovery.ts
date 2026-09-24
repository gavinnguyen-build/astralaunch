import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { idxRegistrations } from '../../server/src/db/schema.js';

/**
 * RouterRegistry: maintains the set of discovered router addresses
 * from idx_registrations. Used to filter USDC transfers and router events.
 */
export class RouterRegistry {
  private routers = new Map<string, string>(); // router -> asset (lowercase)

  /** Load all known routers from the database. */
  async load(db: PostgresJsDatabase<any>): Promise<void> {
    const rows = await db
      .select({ router: idxRegistrations.router, asset: idxRegistrations.asset })
      .from(idxRegistrations);

    for (const row of rows) {
      this.routers.set(row.router.toLowerCase(), row.asset.toLowerCase());
    }
  }

  /** Add a newly discovered router. Returns true if it was new. */
  add(router: string, asset: string): boolean {
    const key = router.toLowerCase();
    if (this.routers.has(key)) return false;
    this.routers.set(key, asset.toLowerCase());
    return true;
  }

  /** Get all known router addresses. */
  getRouterAddresses(): `0x${string}`[] {
    return [...this.routers.keys()] as `0x${string}`[];
  }

  /** Check if an address is a known router. */
  isRouter(addr: string): boolean {
    return this.routers.has(addr.toLowerCase());
  }

  /** Get the asset for a router. */
  getAsset(router: string): string | undefined {
    return this.routers.get(router.toLowerCase());
  }

  /** Number of known routers. */
  get size(): number {
    return this.routers.size;
  }
}
