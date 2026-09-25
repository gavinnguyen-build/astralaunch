/** GET /api/stats — platform totals for the home hero (listed tokens only). */
import { Hono } from 'hono';
import { db } from '../db/client.js';
import { platformStats } from '../services/usage.js';

const app = new Hono();
app.get('/', async (c) => c.json(await platformStats(db)));
export default app;
