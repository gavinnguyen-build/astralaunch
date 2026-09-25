import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const PORT = Number(process.env.DEMO_SERVICES_PORT ?? 4001);
const HOST = process.env.DEMO_SERVICES_HOST ?? '127.0.0.1';

serve({ fetch: createApp().fetch, port: PORT, hostname: HOST }, () => {
  console.log(`Astralaunch demo-services on http://${HOST}:${PORT}  (/feed/digest, /sight/signals)`);
});
