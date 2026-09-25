/**
 * Demo x402 upstream services (no secrets). Served behind the Astralaunch gateway:
 *   GET /feed/digest?topic=…     latest 5 arXiv papers (real data, cached 10 min)
 *   GET /sight/signals?handle=…  ranked X-style signals (SAMPLE DATA, deterministic per handle)
 *   GET /schemas/feed-digest.json, /schemas/sight-signals.json   response JSON schemas
 *   GET /health
 * The gateway's X-Astralaunch-Signature is not verified: these endpoints hold no secrets and
 * are free to call directly; payment is enforced by the gateway in front of them.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import feedDigestSchema from '../schemas/feed-digest.json' with { type: 'json' };
import sightSignalsSchema from '../schemas/sight-signals.json' with { type: 'json' };
import { digest } from './arxiv.js';
import { signalsFor } from './signals.js';

const topicSchema  = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9 .+_-]+$/, 'letters, digits, space . + _ -');
const handleSchema = z.string().regex(/^@?[A-Za-z0-9_]{1,15}$/, 'X handle: 1-15 letters, digits or _');

export function createApp(fetchImpl: typeof fetch = fetch) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/schemas/feed-digest.json', (c) => c.json(feedDigestSchema));
  app.get('/schemas/sight-signals.json', (c) => c.json(sightSignalsSchema));

  app.get('/feed/digest', async (c) => {
    const topic = topicSchema.safeParse(c.req.query('topic') ?? '');
    if (!topic.success) return c.json({ error: `invalid topic: ${topic.error.issues[0]!.message}` }, 400);
    try {
      return c.json(await digest(topic.data, fetchImpl));
    } catch (e) {
      // Non-2xx: the gateway will not settle, so the caller is not charged.
      return c.json({ error: 'arXiv unavailable', detail: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  app.get('/sight/signals', (c) => {
    const handle = handleSchema.safeParse(c.req.query('handle') ?? '');
    if (!handle.success) return c.json({ error: `invalid handle: ${handle.error.issues[0]!.message}` }, 400);
    return c.json(signalsFor(handle.data));
  });

  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  return app;
}
