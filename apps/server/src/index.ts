/**
 * Astralaunch server — Hono on Node.js
 *
 * Routes:
 *   GET  /health                              — liveness + DB check
 *   GET  /ready                               — readiness probe
 *   POST /api/services                        — register BYO service
 *   PATCH /api/services/:id                   — update price/upstream
 *   GET  /api/services/:slug/manifest         — machine-readable service manifest
 *   ALL  /s/:slug/*                           — x402 gateway
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { PORT, RPC_URL, PAYMENT_TIMEOUT_S, verifyContracts } from './env.js';

// Refuse to start with a dangerously wide payment window on a non-local RPC.
// PAYMENT_TIMEOUT_SECONDS > 300 is only safe on a local Anvil fork where block
// time may have been warped past wall-clock time.  On mainnet it would allow
// replay of stale authorizations.
{
  const isLocalRpc = /^https?:\/\/(127\.|localhost|0\.0\.0\.0)/.test(RPC_URL);
  if (PAYMENT_TIMEOUT_S > 300 && !isLocalRpc) {
    console.error(
      `FATAL: PAYMENT_TIMEOUT_SECONDS=${PAYMENT_TIMEOUT_S} exceeds 300 s but ` +
      `MONAD_RPC_URL is not localhost (${RPC_URL}). ` +
      `This setting is only permitted on a local Anvil fork.`
    );
    process.exit(1);
  }
}
import health from './routes/health.js';
import servicesRouter from './routes/services.js';
import tokensRouter from './routes/tokens.js';
import explorerRouter from './routes/explorer.js';
import creatorRouter from './routes/creator.js';
import gateway from './routes/gateway.js';
import { startProbeWorker } from './lib/probes.js';

const app = new Hono();

app.use('*', logger());

app.route('/', health);
app.route('/api/tokens',   tokensRouter);
app.route('/api/services', servicesRouter);
app.route('/api/explorer', explorerRouter);
app.route('/api/creator',  creatorRouter);
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
