/**
 * POST /api/uploads/token-image: raw image bytes in the body (any Content-Type; the format is sniffed).
 * PNG / JPEG / WebP only, max 2 MB, rate limited per client IP. Returns the content hash and the
 * renditions' paths (relative to the API origin). The token references the hash through its signed details.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { TOKEN_IMAGE_SIZES, tokenImagePath } from '@astralaunch/shared';
import { db } from '../db/client.js';
import { clientIp, fixedWindowLimiter } from '../lib/rateLimit.js';
import { IMAGE_ERROR, ImageInputError, MAX_IMAGE_BYTES, processTokenImage, storeTokenImage } from '../services/tokenImages.js';

const app = new Hono();
const allow = fixedWindowLimiter({
  max: Number(process.env.IMAGE_UPLOADS_PER_10MIN || 20), windowMs: 10 * 60_000,
});

app.post('/token-image',
  bodyLimit({ maxSize: MAX_IMAGE_BYTES, onError: (c) => c.json({ error: IMAGE_ERROR }, 413) }),
  async (c) => {
    if (!allow(clientIp(c))) return c.json({ error: 'Too many uploads. Try again in a few minutes.' }, 429);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) return c.json({ error: IMAGE_ERROR }, 400);
    try {
      const { hash, files } = await processTokenImage(body);
      await storeTokenImage(db, hash, files, body.byteLength);
      return c.json({
        hash,
        urls: Object.fromEntries(TOKEN_IMAGE_SIZES.map((s) => [s, tokenImagePath(hash, s)])),
      }, 201);
    } catch (e) {
      if (e instanceof ImageInputError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

export default app;
