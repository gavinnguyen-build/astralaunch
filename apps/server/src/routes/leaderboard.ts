/**
 * GET /api/leaderboard?group=creators|traders&period=7d|30d|all
 * Creators ranked by clean revenue (D-MK1). Traders: coming soon.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../db/client.js';
import { platformAddrs } from '../lib/platform.js';
import { usdResolver } from '../lib/chain.js';
import { PERIODS, creatorLeaderboard, type Period } from '../services/leaderboard.js';

const app = new Hono();

app.get('/', zValidator('query', z.object({
  group: z.enum(['creators', 'traders']).default('creators'),
  period: z.enum(Object.keys(PERIODS) as [Period, ...Period[]]).default('30d'),
})), async (c) => {
  const { group, period } = c.req.valid('query');
  if (group === 'traders') return c.json({ group, period, comingSoon: true, traders: [] });
  return c.json(await creatorLeaderboard(db, period, BigInt(Math.floor(Date.now() / 1000)), platformAddrs(), 100, usdResolver));
});

export default app;
