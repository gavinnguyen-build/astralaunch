/**
 * Admin routes — /api/admin (Bearer ADMIN_API_KEY; disabled when unset)
 *
 * GET /api/admin/tokens/unlisted — tokens registered on-chain without a consumed launch fee
 */
import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { db } from '../db/client.js';
import { ADMIN_API_KEY } from '../env.js';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hideToken, listHiddenTokens, listUnlistedRegistrations, unhideToken } from '../services/launchFee.js';

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

// POST /api/admin/tokens/:asset/hide { reason } — hide from every public endpoint (D-AD1)
app.post('/tokens/:asset/hide', zValidator('json', z.object({ reason: z.string().trim().min(3).max(300) })), async (c) => {
  const asset = c.req.param('asset');
  if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) return c.json({ error: 'asset must be an address' }, 400);
  const row = await hideToken(db, asset, c.req.valid('json').reason);
  console.log(`[admin] hid ${row.asset}: ${row.reason}`);
  return c.json({ hidden: true, asset: row.asset, reason: row.reason, hiddenAt: row.hiddenAt });
});

// POST /api/admin/tokens/:asset/unhide
app.post('/tokens/:asset/unhide', async (c) => {
  const asset = c.req.param('asset');
  if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) return c.json({ error: 'asset must be an address' }, 400);
  const removed = await unhideToken(db, asset);
  console.log(`[admin] unhid ${asset.toLowerCase()} (was hidden: ${removed})`);
  return c.json({ hidden: false, asset: asset.toLowerCase(), wasHidden: removed });
});

// GET /api/admin/tokens/hidden
app.get('/tokens/hidden', async (c) => c.json({ tokens: await listHiddenTokens(db) }));

export default app;
