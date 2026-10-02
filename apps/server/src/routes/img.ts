/** GET /img/<hash>-<64|256|512>.webp: stored token image renditions (immutable, content-addressed). */
import { Hono } from 'hono';
import { readTokenImage } from '../services/tokenImages.js';

const app = new Hono();

app.get('/:name', async (c) => {
  const file = await readTokenImage(c.req.param('name'));
  if (!file) return c.json({ error: 'Not found' }, 404);
  return c.body(new Uint8Array(file), 200, {
    'Content-Type': 'image/webp',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
});

export default app;
