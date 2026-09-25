/**
 * Read-only DB status: applied migrations, indexer checkpoints, registrations, buybacks, swaps.
 *   pnpm exec tsx --env-file=.env.mainnet src/scripts/dbStatus.ts --expect-db astralaunch_mainnet
 */
import { connectGuarded, run } from './common.js';

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
}

run(async () => {
  const { sql } = await connectGuarded(arg('--expect-db'));
  try {
    const mig = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`.catch(() => [{ n: 'none (no drizzle table)' }]);
    console.log('drizzle migrations applied:', mig[0]!.n);
    const cols = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`;
    console.log('tables:', cols.map(r => r.table_name).join(' '));
    console.table(await sql`SELECT contract_set, block_number FROM idx_checkpoints ORDER BY 1`);
    console.table(await sql`SELECT asset, pool_id, numeraire, block_number FROM idx_registrations ORDER BY block_number`);
    console.table(await sql`SELECT asset, usdc_in, tokens_burned, tx_hash, block_number FROM idx_buybacks ORDER BY block_number`);
    const hasSwaps = await sql`SELECT to_regclass('public.idx_swaps') IS NOT NULL AS ok`;
    if (hasSwaps[0]!.ok) {
      console.table(await sql`SELECT asset, pool_id, price_wad, block_number FROM idx_pool_inits ORDER BY block_number`);
      console.table(await sql`SELECT asset, count(*)::int AS transfers FROM idx_asset_transfers GROUP BY asset ORDER BY asset`);
      console.table(await sql`SELECT asset, count(*)::int AS swaps, count(*) FILTER (WHERE is_buyback)::int AS buybacks,
        min(block_number) AS first_block, max(block_number) AS last_block FROM idx_swaps GROUP BY asset ORDER BY asset`);
    }
  } finally {
    await sql.end();
  }
});
