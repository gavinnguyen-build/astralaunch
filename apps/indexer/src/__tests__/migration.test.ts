/**
 * Migration test — runs on a scratch database.
 * Requires POSTGRES_URL env var pointing to a Postgres instance with createdb/dropdb permissions.
 * Skipped if POSTGRES_URL is not set.
 *
 * Usage: POSTGRES_URL=postgres://user:pass@localhost:5432 pnpm -F @astralaunch/indexer test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const POSTGRES_URL = process.env.POSTGRES_URL;
const DB_NAME = `astralaunch_migration_test_${Date.now()}`;

// Skip entirely if no Postgres connection available
const describeWithDb = POSTGRES_URL ? describe : describe.skip;

describeWithDb('Migrations 0003 + 0004 — scratch database', () => {
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
    const { default: pgClient } = await import('postgres');
    const sql = pgClient(scratchUrl, { max: 1 });

    try {
      const migrationPath = path.resolve(
        import.meta.dirname!,
        '../../../../apps/server/src/db/migrations/0003_indexer_tables.sql',
      );
      const migrationSql = readFileSync(migrationPath, 'utf8');
      await sql.unsafe(migrationSql);

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
      expect(constraints.length).toBeGreaterThanOrEqual(10);

      // Verify idempotency: run migration again
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

  it('applies migration 0004 and adds v2 columns', async () => {
    const { default: pgClient } = await import('postgres');
    const sql = pgClient(scratchUrl, { max: 1 });

    try {
      const migrationPath = path.resolve(
        import.meta.dirname!,
        '../../../../apps/server/src/db/migrations/0004_indexer_v2.sql',
      );
      const migrationSql = readFileSync(migrationPath, 'utf8');
      await sql.unsafe(migrationSql);

      // idx_registrations: numeraire + initializer
      const regCols = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'idx_registrations' ORDER BY ordinal_position
      `;
      const regNames = regCols.map((r: any) => r.column_name);
      expect(regNames).toContain('numeraire');
      expect(regNames).toContain('initializer');

      // idx_fee_collections: wmon_delta + numeraire_delta
      const feeCols = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'idx_fee_collections' ORDER BY ordinal_position
      `;
      const feeNames = feeCols.map((r: any) => r.column_name);
      expect(feeNames).toContain('wmon_delta');
      expect(feeNames).toContain('numeraire_delta');

      // idx_escrow_forfeits: wmon_moved
      const forfeitCols = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'idx_escrow_forfeits' ORDER BY ordinal_position
      `;
      expect(forfeitCols.map((r: any) => r.column_name)).toContain('wmon_moved');

      // idx_pfr_collections: numeraire_forwarded
      const pfrCols = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'idx_pfr_collections' ORDER BY ordinal_position
      `;
      expect(pfrCols.map((r: any) => r.column_name)).toContain('numeraire_forwarded');

      // idx_escrow_claims: wmon_amount + usd_value
      const claimCols = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'idx_escrow_claims' ORDER BY ordinal_position
      `;
      const claimNames = claimCols.map((r: any) => r.column_name);
      expect(claimNames).toContain('wmon_amount');
      expect(claimNames).toContain('usd_value');

      // Idempotency: run again
      await sql.unsafe(migrationSql);
      const regCols2 = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'idx_registrations' ORDER BY ordinal_position
      `;
      expect(regCols2.map((r: any) => r.column_name)).toContain('numeraire');
    } finally {
      await sql.end();
    }
  });
});
