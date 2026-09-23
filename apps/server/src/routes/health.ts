import { Hono } from 'hono';
import { db } from '../db/client.js';
import { sql } from 'drizzle-orm';

const health = new Hono();

health.get('/health', async (c) => {
  // Verify DB connectivity
  try {
    await db.execute(sql`SELECT 1`);
    return c.json({ status: 'ok', db: 'ok', ts: new Date().toISOString() });
  } catch (e) {
    return c.json({ status: 'degraded', db: 'unreachable', ts: new Date().toISOString() }, 503);
  }
});

health.get('/ready', (c) => c.json({ ready: true }));

export default health;
