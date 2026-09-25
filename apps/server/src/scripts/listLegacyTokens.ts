/**
 * One-off admin script: mark tokens launched before the launch fee existed
 * (SIGHT, FEED) as listed. Writes a source='admin' fee receipt per asset, which
 * lists the token without counting toward any launcher's rate limit. Idempotent.
 * See docs/decisions.md D-LF6 and docs/MAINNET-RUNBOOK.md.
 *
 * Usage (env from a file, e.g. .env.mainnet; dry run unless --yes):
 *   pnpm exec tsx --env-file=.env.mainnet src/scripts/listLegacyTokens.ts \
 *     --expect-db astralaunch_mainnet --asset 0x… [--asset 0x…] [--note "…"] [--yes]
 *
 * Needs DATABASE_URL, MONAD_RPC_URL, ASTRALAUNCH_REGISTRY_ADDRESS, MONAD_CHAIN_ID (default 143).
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createPublicClient, http, isAddress, zeroAddress, type Address } from 'viem';
import * as schema from '../db/schema.js';
import { adminListAsset, isAssetListed } from '../services/launchFee.js';

function args() {
  const argv = process.argv.slice(2).filter(a => a !== '--');
  const out = { assets: [] as string[], expectDb: '', note: 'launched before launch fee (legacy listing)', yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--asset') out.assets.push(argv[++i] ?? '');
    else if (a === '--expect-db') out.expectDb = argv[++i] ?? '';
    else if (a === '--note') out.note = argv[++i] ?? '';
    else if (a === '--yes') out.yes = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
}

const registryAbi = [{ type: 'function', name: 'routers', stateMutability: 'view',
  inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'address' }] }] as const;

async function main() {
  const opts = args();
  if (opts.assets.length === 0) throw new Error('Pass at least one --asset 0x…');
  for (const a of opts.assets) if (!isAddress(a)) throw new Error(`Invalid address: ${a}`);
  if (!opts.expectDb) throw new Error('Pass --expect-db <database name> to guard against the wrong DB');

  const dbUrl = new URL(need('DATABASE_URL'));
  const dbName = dbUrl.pathname.replace(/^\//, '');
  console.log(`Target database: ${dbName} @ ${dbUrl.hostname}`);
  if (dbName !== opts.expectDb) throw new Error(`DATABASE_URL points at "${dbName}", expected "${opts.expectDb}". Aborting.`);

  const chainId = Number(process.env.MONAD_CHAIN_ID ?? 143);
  const registry = need('ASTRALAUNCH_REGISTRY_ADDRESS') as Address;
  const client = createPublicClient({ transport: http(need('MONAD_RPC_URL')) });

  const sql = postgres(dbUrl.toString(), { max: 1 });
  const db = drizzle(sql, { schema });
  try {
    const [{ exists }] = await sql`SELECT to_regclass('public.fee_receipts') IS NOT NULL AS exists`;
    if (!exists) throw new Error('fee_receipts table missing: run migrations first (src/db/migrate.ts).');

    for (const raw of opts.assets) {
      const asset = raw.toLowerCase();
      const router = await client.readContract({ address: registry, abi: registryAbi, functionName: 'routers', args: [asset as Address] });
      if (router === zeroAddress) throw new Error(`${raw} is not registered in AstralaunchRegistry ${registry}. Aborting.`);

      if (await isAssetListed(db, asset)) {
        console.log(`${raw}: already listed, nothing to do`);
        continue;
      }
      if (!opts.yes) {
        console.log(`${raw}: registered (router ${router}); would mark listed [dry run, pass --yes to apply]`);
        continue;
      }
      const r = await adminListAsset(db, asset, chainId, opts.note);
      console.log(`${raw}: ${r.inserted ? 'marked listed' : 'already listed'}` +
        (r.indexed ? '' : ' (warning: not in idx_registrations yet; indexer backfill will add it)'));
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
