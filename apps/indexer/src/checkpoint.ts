import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { idxCheckpoints } from '../../server/src/db/schema.js';

/**
 * Read the last indexed block for a contract set.
 * Returns null if no checkpoint exists (first run).
 */
export async function readCheckpoint(
  db: PostgresJsDatabase<any>,
  contractSet: string,
): Promise<bigint | null> {
  const row = await db
    .select({ blockNumber: idxCheckpoints.blockNumber })
    .from(idxCheckpoints)
    .where(eq(idxCheckpoints.contractSet, contractSet))
    .limit(1);

  return row.length > 0 ? row[0]!.blockNumber : null;
}

/**
 * Write (upsert) the checkpoint for a contract set.
 * Called within the same transaction as row inserts for atomicity.
 */
export async function writeCheckpoint(
  tx: PostgresJsDatabase<any>,
  contractSet: string,
  blockNumber: bigint,
): Promise<void> {
  await tx
    .insert(idxCheckpoints)
    .values({
      contractSet,
      blockNumber,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: idxCheckpoints.contractSet,
      set: {
        blockNumber,
        updatedAt: new Date(),
      },
    });
}
