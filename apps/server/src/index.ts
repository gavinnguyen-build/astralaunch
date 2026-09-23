/**
 * Revpad server — Hono on Node.js
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
import { PORT } from './env.js';
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

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Revpad server listening on http://0.0.0.0:${PORT}`);
});

export default app;
