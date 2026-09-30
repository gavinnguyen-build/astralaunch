/**
 * Responses that failed a service's response schema (D-SV4). The gateway records each one (not charged); the creator
 * sees a 7-day count and the latest error on the Creator page, through the signed settings read only.
 */
import { and, count, desc, eq, gte, lt } from 'drizzle-orm';
import { schemaMismatches } from '../db/schema.js';
import type { Db } from './launchFee.js';

export const SCHEMA_MISMATCH_WINDOW_MS = 7 * 24 * 3600 * 1000;
const PATH_MAX = 200;

export interface SchemaMismatchSummary {
  /** Responses that did not match the schema in the last 7 days. */
  count7d: number;
  latest: { at: string; path: string | null; code: string; detail: string | null } | null;
}

/** Record one failed check. `path` is the request path under /s/{slug}; the query string is never stored. Never throws. */
export async function recordSchemaMismatch(db: Db, serviceId: string, code: string, detail: string | null, path: string, now = new Date()): Promise<void> {
  try {
    await db.insert(schemaMismatches).values({
      serviceId, code, detail: detail?.slice(0, 300) ?? null, path: (path.split('?')[0] || '/').slice(0, PATH_MAX), createdAt: now,
    });
    await db.delete(schemaMismatches).where(and(
      eq(schemaMismatches.serviceId, serviceId), lt(schemaMismatches.createdAt, new Date(now.getTime() - SCHEMA_MISMATCH_WINDOW_MS)),
    ));
  } catch (e) {
    console.error('[gateway] schema mismatch not recorded:', (e as Error).message);
  }
}

export async function schemaMismatchSummary(db: Db, serviceId: string, now = new Date()): Promise<SchemaMismatchSummary> {
  const since = new Date(now.getTime() - SCHEMA_MISMATCH_WINDOW_MS);
  const where = and(eq(schemaMismatches.serviceId, serviceId), gte(schemaMismatches.createdAt, since));
  const [{ n }] = await db.select({ n: count() }).from(schemaMismatches).where(where);
  const [last] = await db.select().from(schemaMismatches).where(where).orderBy(desc(schemaMismatches.createdAt)).limit(1);
  return {
    count7d: Number(n),
    latest: last ? { at: last.createdAt.toISOString(), path: last.path, code: last.code, detail: last.detail } : null,
  };
}

/** A new or removed schema: earlier mismatches were against the old one. */
export async function clearSchemaMismatches(db: Db, serviceId: string): Promise<void> {
  await db.delete(schemaMismatches).where(eq(schemaMismatches.serviceId, serviceId));
}
