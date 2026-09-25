/**
 * Read-only preview of the Phase A API payloads, computed by the same service functions the
 * routes use (no server needed, no writes):
 *   pnpm exec tsx --env-file=.env.mainnet src/scripts/marketPreview.ts --expect-db astralaunch_mainnet 0x30Ae… 0x2686…
 */
import { tokens } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { connectGuarded, run } from './common.js';
import { candles, holders, marketSnapshot, trades } from '../services/market.js';
import { creatorLeaderboard } from '../services/leaderboard.js';
import { creatorDashboard } from '../services/creatorDashboard.js';

const argv = process.argv.slice(2);
const expectDb = argv[argv.indexOf('--expect-db') + 1] ?? '';
const assets = argv.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase());
const show = (label: string, v: unknown) => console.log(`\n### ${label}\n${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)}`);

run(async () => {
  const { sql, db } = await connectGuarded(expectDb);
  // lib/chain needs the server env (RPC, contract addresses); loaded lazily after the DB guard.
  const { usdResolver, holderLabels, creatorChain } = await import('../lib/chain.js');
  const { platformAddrs } = await import('../lib/platform.js');
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  try {
    const creators = new Set<string>();
    for (const a of assets) {
      const t = await db.query.tokens.findFirst({ where: eq(tokens.asset, a) });
      if (!t) { console.log(`\n${a}: no tokens row`); continue; }
      creators.add(t.creator);
      console.log(`\n================ ${t.symbol} (${t.name}) ${a} numeraire=${t.numeraire}`);
      show('market (in /api/tokens and /api/tokens/:asset)', await marketSnapshot(db, a, t.numeraire, usdResolver, nowS));
      const c = await candles(db, a, t.numeraire, '1h', usdResolver);
      show('GET /candles?tf=1h', { ...c, candles: c.candles.slice(-5) });
      show('GET /trades', await trades(db, a, t.numeraire, usdResolver, 10));
      show('GET /holders', await holders(db, a, holderLabels(t.creator), 10));
    }
    show('GET /api/leaderboard?group=creators&period=all', await creatorLeaderboard(db, 'all', nowS, platformAddrs()));
    for (const c of creators) show(`GET /api/creator/${c}`, await creatorDashboard(db, creatorChain, c));
  } finally {
    await sql.end();
  }
});
