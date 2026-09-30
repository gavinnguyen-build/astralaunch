import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createFeed } from './arxiv.js';

const PORT = Number(process.env.DEMO_SERVICES_PORT ?? 4001);
const HOST = process.env.DEMO_SERVICES_HOST ?? '127.0.0.1';

// FEED_CACHE_FILE: where the arXiv cache is kept across restarts (a Docker volume in production). Unset = memory only.
const feed = createFeed({ cacheFile: process.env.FEED_CACHE_FILE || null });
const loaded = await feed.load();
console.log(`[feed] cache: ${process.env.FEED_CACHE_FILE || 'memory only'} (${loaded} topics loaded)`);
void feed.warm('agent payments');   // in the background; the server starts at once

serve({ fetch: createApp(feed).fetch, port: PORT, hostname: HOST }, () => {
  console.log(`Astralaunch demo-services on http://${HOST}:${PORT}  (/feed/digest, /sight/signals)`);
});
