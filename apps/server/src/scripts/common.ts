/** Shared helpers for one-off admin scripts (env, DB guard, chain client). */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createPublicClient, http } from 'viem';
import * as schema from '../db/schema.js';

export function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
}

/** Connect to DATABASE_URL, refusing unless its database name equals `expectDb`. */
export async function connectGuarded(expectDb: string) {
  if (!expectDb) throw new Error('Pass --expect-db <database name> to guard against the wrong DB');
  const dbUrl = new URL(need('DATABASE_URL'));
  const dbName = dbUrl.pathname.replace(/^\//, '');
  console.log(`Target database: ${dbName} @ ${dbUrl.hostname}`);
  if (dbName !== expectDb) throw new Error(`DATABASE_URL points at "${dbName}", expected "${expectDb}". Aborting.`);
  const sql = postgres(dbUrl.toString(), { max: 1 });
  return { sql, db: drizzle(sql, { schema }) };
}

export const chainClient = () => createPublicClient({ transport: http(need('MONAD_RPC_URL')) });

export function run(main: () => Promise<void>) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
