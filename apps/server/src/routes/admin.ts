/**
 * Admin routes — /api/admin (Bearer ADMIN_API_KEY; disabled when unset)
 *
 * GET /api/admin/tokens/unlisted — tokens registered on-chain without a consumed launch fee
 */
import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { db } from '../db/client.js';
import { ADMIN_API_KEY } from '../env.js';
import { listUnlistedRegistrations } from '../services/launchFee.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

const app = new Hono();

app.use('*', async (c, next) => {
  if (!ADMIN_API_KEY) return c.json({ error: 'Admin API disabled' }, 503);
  const auth = c.req.header('Authorization') ?? '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!given || !timingSafeEqual(digest(given), digest(ADMIN_API_KEY))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

app.get('/tokens/unlisted', async (c) => {
  const rows = await listUnlistedRegistrations(db);
  return c.json({
    tokens: rows.map(r => ({
      ...r,
      blockNumber: r.blockNumber.toString(),
      timestamp:   Number(r.timestamp),
    })),
  });
});

export default app;
