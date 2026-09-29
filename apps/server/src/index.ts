/**
 * Astralaunch server — Hono on Node.js
 *
 * Routes:
 *   GET  /health                              — liveness + DB check
 *   GET  /ready                               — readiness probe
 *   POST /api/services                        — register BYO service (signed by on-chain creator)
 *   PATCH /api/services/:id                   — update price/upstream (signed by on-chain creator)
 *   GET  /api/services/:slug/manifest         — machine-readable service manifest
 *   POST /api/launch-fee/verify               — verify 10 MON launch fee tx
 *   GET  /api/launch-fee/status               — launcher receipts + 24h limit
 *   GET  /api/admin/tokens/unlisted           — registered tokens without a fee (admin)
 *   GET  /api/leaderboard                     — creators by clean revenue (7d/30d/all)
 *   GET  /api/creator/:wallet                 — creator dashboard (claims, vesting, services)
 *   GET  /api/tokens/:asset/candles|trades|holders — market data
 *   ALL  /s/:slug/*                           — x402 gateway
 *
 * CORS: /api/* and /s/* allow only the origins in CORS_ORIGINS (lib/cors.ts).
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { PORT, RPC_URL, PAYMENT_TIMEOUT_S, CORS_ORIGINS, FACILITATOR_URL, verifyContracts } from './env.js';
import { corsFor } from './lib/cors.js';
import { forkFacilitatorError, isLocalUrl } from './lib/forkGuard.js';

// Refuse to start with a dangerously wide payment window on a non-local RPC.
// PAYMENT_TIMEOUT_SECONDS > 300 is only safe on a local Anvil fork where block
// time may have been warped past wall-clock time.  On mainnet it would allow
// replay of stale authorizations.
{
  const isLocalRpc = isLocalUrl(RPC_URL);
  if (PAYMENT_TIMEOUT_S > 300 && !isLocalRpc) {
    console.error(
      `FATAL: PAYMENT_TIMEOUT_SECONDS=${PAYMENT_TIMEOUT_S} exceeds 300 s but ` +
      `MONAD_RPC_URL is not localhost (${RPC_URL}). ` +
      `This setting is only permitted on a local Anvil fork.`
    );
    process.exit(1);
  }
  // A local fork must never reach the real facilitator (lib/forkGuard.ts).
  const forkErr = forkFacilitatorError(RPC_URL, FACILITATOR_URL);
  if (forkErr) {
    console.error(`FATAL: ${forkErr}`);
    process.exit(1);
  }
}
import health from './routes/health.js';
import servicesRouter from './routes/services.js';
import tokensRouter from './routes/tokens.js';
import explorerRouter from './routes/explorer.js';
import creatorRouter from './routes/creator.js';
import gateway from './routes/gateway.js';
import pricesRouter from './routes/prices.js';
import launchFeeRouter from './routes/launchFee.js';
import adminRouter from './routes/admin.js';
import leaderboardRouter from './routes/leaderboard.js';
import statsRouter from './routes/stats.js';
import configRouter from './routes/config.js';
import { startProbeWorker } from './lib/probes.js';

const app = new Hono();

app.use('*', logger());
// Before the routes: preflights for /api/* and the /s/* gateway are answered here (lib/cors.ts).
const corsMw = corsFor(CORS_ORIGINS);
app.use('/api/*', corsMw);
app.use('/s/*', corsMw);

app.route('/', health);
app.route('/api/tokens',   tokensRouter);
app.route('/api/services', servicesRouter);
app.route('/api/explorer', explorerRouter);
app.route('/api/creator',  creatorRouter);
app.route('/api/prices',  pricesRouter);
app.route('/api/launch-fee', launchFeeRouter);
app.route('/api/admin',  adminRouter);
app.route('/api/leaderboard', leaderboardRouter);
app.route('/api/stats', statsRouter);
app.route('/api/config', configRouter);
app.route('/s', gateway);

startProbeWorker();

app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

// Verify contract addresses before accepting traffic.
verifyContracts().then(() => {
  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`Astralaunch server listening on http://0.0.0.0:${PORT}`);
  });
}).catch((e) => {
  console.error(e.message);
  process.exit(1);
});

export default app;
