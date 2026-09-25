/**
 * In-process Postgres (PGlite) with every committed migration applied in journal order.
 * Real SQL semantics (unique indexes, FOR UPDATE, advisory locks) without a server.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as schema from '../../db/schema.js';

const MIGRATIONS = path.resolve(import.meta.dirname!, '../../db/migrations');

export async function createTestDb() {
  const client = new PGlite();
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    const sqlText = readFileSync(path.join(MIGRATIONS, `${tag}.sql`), 'utf8')
      // gen_random_uuid() is core since PG13; PGlite ships pgcrypto separately.
      .replace(/CREATE EXTENSION[^;]*;/gi, '');
    await client.exec(sqlText);
  }
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.close() };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>['db'];
