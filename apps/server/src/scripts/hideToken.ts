/**
 * Admin: hide (or unhide) a token from every public endpoint via the server's admin API.
 *   pnpm exec tsx --env-file=.env.mainnet src/scripts/hideToken.ts --asset 0x… --reason "…" [--unhide] [--server http://localhost:3001] [--yes]
 * Needs ADMIN_API_KEY (same value the server runs with). Dry run unless --yes.
 */
import { need, run } from './common.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

run(async () => {
  const server = (arg('--server') ?? 'http://localhost:3001').replace(/\/$/, '');
  const asset = arg('--asset') ?? '';
  const unhide = process.argv.includes('--unhide');
  const reason = arg('--reason') ?? '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) throw new Error('--asset 0x… is required');
  if (!unhide && reason.trim().length < 3) throw new Error('--reason "…" is required (≥3 chars)');
  const key = need('ADMIN_API_KEY');
  const path = `/api/admin/tokens/${asset}/${unhide ? 'unhide' : 'hide'}`;
  console.log(`${unhide ? 'UNHIDE' : 'HIDE'} ${asset} on ${server}${unhide ? '' : ` — reason: ${reason}`}`);
  if (!process.argv.includes('--yes')) { console.log('Dry run. Re-run with --yes to apply.'); return; }
  const res = await fetch(`${server}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: unhide ? undefined : JSON.stringify({ reason }),
  });
  console.log(`→ ${res.status} ${await res.text()}`);
  if (!res.ok) process.exit(1);
  const check = await fetch(`${server}/api/tokens/${asset}`);
  console.log(`public GET /api/tokens/${asset} → ${check.status}${check.status === 404 ? ' (hidden)' : ''}`);
});
