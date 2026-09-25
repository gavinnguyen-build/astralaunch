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
import { isAddress, zeroAddress, type Address } from 'viem';
import { chainClient, connectGuarded, need, run } from './common.js';
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

const registryAbi = [{ type: 'function', name: 'routers', stateMutability: 'view',
  inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'address' }] }] as const;

async function main() {
  const opts = args();
  if (opts.assets.length === 0) throw new Error('Pass at least one --asset 0x…');
  for (const a of opts.assets) if (!isAddress(a)) throw new Error(`Invalid address: ${a}`);

  const chainId = Number(process.env.MONAD_CHAIN_ID ?? 143);
  const registry = need('ASTRALAUNCH_REGISTRY_ADDRESS') as Address;
  const client = chainClient();
  const { sql, db } = await connectGuarded(opts.expectDb);
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

run(main);
