/**
 * One-off backfill: create/refresh a `tokens` row for every idx_registrations row
 * (tokens registered before the indexer created them, e.g. SIGHT and FEED).
 * Same code path as the indexer (upsertTokenFromRegistration): on-chain fields
 * only, creator metadata untouched, idempotent. Also fills idx_registrations.launcher
 * (register() tx sender) where it is still ''. Does not change listing status.
 * See docs/decisions.md D-TK3 and docs/MAINNET-RUNBOOK.md.
 *
 * Usage (dry run unless --yes):
 *   pnpm exec tsx --env-file=.env.mainnet src/scripts/backfillTokens.ts --expect-db astralaunch_mainnet [--yes]
 *
 * Needs DATABASE_URL, MONAD_RPC_URL.
 */
import { backfillTokensFromRegistrations } from '../services/tokenSync.js';
import { chainClient, connectGuarded, run } from './common.js';

function args() {
  const argv = process.argv.slice(2).filter(a => a !== '--');
  const out = { expectDb: '', yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--expect-db') out.expectDb = argv[++i] ?? '';
    else if (a === '--yes') out.yes = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

async function main() {
  const opts = args();
  const client = chainClient();
  const { sql, db } = await connectGuarded(opts.expectDb);
  try {
    const [{ ok }] = await sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'tokens' AND column_name = 'registered_block') AS ok`;
    if (!ok) throw new Error('tokens.registered_block missing: run migrations first (src/db/migrate.ts).');

    for (const line of await backfillTokensFromRegistrations(db, client, opts.yes)) console.log(line);
  } finally {
    await sql.end();
  }
}

run(main);
