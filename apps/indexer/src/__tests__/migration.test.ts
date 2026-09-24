/**
 * Migration 0003 test — runs on a scratch database.
 * Requires POSTGRES_URL env var pointing to a Postgres instance with createdb/dropdb permissions.
 * Skipped if POSTGRES_URL is not set.
 *
 * Usage: POSTGRES_URL=postgres://user:pass@localhost:5432 pnpm -F @revpad/indexer test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const POSTGRES_URL = process.env.POSTGRES_URL;
const DB_NAME = `revpad_migration_test_${Date.now()}`;

// Skip entirely if no Postgres connection available
const describeWithDb = POSTGRES_URL ? describe : describe.skip;

describeWithDb('Migration 0003 — scratch database', () => {
  let scratchUrl: string;

  beforeAll(() => {
    // Parse the base URL and construct scratch DB URL
    const base = new URL(POSTGRES_URL!);
    const baseNoDb = `${base.protocol}//${base.username}:${base.password}@${base.host}`;
    scratchUrl = `${baseNoDb}/${DB_NAME}`;

    // Create scratch database
    execSync(`createdb -h ${base.hostname} -p ${base.port || 5432} -U ${base.username} ${DB_NAME}`, {
      env: { ...process.env, PGPASSWORD: base.password },
      stdio: 'pipe',
    });
  });

  afterAll(() => {
    try {
      const base = new URL(POSTGRES_URL!);
      execSync(`dropdb -h ${base.hostname} -p ${base.port || 5432} -U ${base.username} --if-exists ${DB_NAME}`, {
        env: { ...process.env, PGPASSWORD: base.password },
        stdio: 'pipe',
      });
    } catch {
      // Best-effort cleanup
    }
  });

  it('applies migration 0003 and creates all idx_* tables', async () => {
    // Dynamically import postgres to run raw SQL
    const { default: pgClient } = await import('postgres');
    const sql = pgClient(scratchUrl, { max: 1 });

    try {
      // Read and apply migration SQL
      const migrationPath = path.resolve(
        import.meta.dirname!,
        '../../../../apps/server/src/db/migrations/0003_indexer_tables.sql',
      );
      const migrationSql = readFileSync(migrationPath, 'utf8');
      await sql.unsafe(migrationSql);

      // Verify all 11 tables exist
      const tables = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'idx_%'
        ORDER BY table_name
      `;

      const tableNames = tables.map((r: any) => r.table_name);
      expect(tableNames).toContain('idx_checkpoints');
      expect(tableNames).toContain('idx_registrations');
      expect(tableNames).toContain('idx_usdc_transfers');
      expect(tableNames).toContain('idx_distributions');
      expect(tableNames).toContain('idx_fee_collections');
      expect(tableNames).toContain('idx_revenue_recorded');
      expect(tableNames).toContain('idx_escrow_claims');
      expect(tableNames).toContain('idx_escrow_forfeits');
      expect(tableNames).toContain('idx_buybacks');
      expect(tableNames).toContain('idx_burns');
      expect(tableNames).toContain('idx_pfr_collections');
      expect(tableNames).toHaveLength(11);

      // Verify idx_usdc_transfers has tx_from and is_facilitator_settled columns
      const usdcCols = await sql`
        SELECT column_name, data_type, column_default
        FROM information_schema.columns
        WHERE table_name = 'idx_usdc_transfers'
        ORDER BY ordinal_position
      `;
      const colNames = usdcCols.map((r: any) => r.column_name);
      expect(colNames).toContain('tx_from');
      expect(colNames).toContain('is_facilitator_settled');

      // Verify unique constraints exist
      const constraints = await sql`
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema = 'public' AND constraint_type = 'UNIQUE'
        AND table_name LIKE 'idx_%'
      `;
      expect(constraints.length).toBeGreaterThanOrEqual(10); // one per event table

      // Verify idempotency: run migration again — IF NOT EXISTS should make it safe
      await sql.unsafe(migrationSql);
      const tablesAgain = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'idx_%'
      `;
      expect(tablesAgain).toHaveLength(11);
    } finally {
      await sql.end();
    }
  });
});
