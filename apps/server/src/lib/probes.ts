/**
 * Service health probe worker (SPEC §9.4)
 *
 * Every 5 minutes: for each active service that has a health_path,
 * send a signed GET to `{upstreamUrl}{health_path}`, record latency + status.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { services, serviceProbes } from '../db/schema.js';
import { signRequest } from './hmac.js';

const PROBE_INTERVAL_MS = 5 * 60_000; // 5 minutes

export function startProbeWorker(): void {
  // Run once on start, then on schedule
  runProbes().catch(console.error);
  setInterval(() => runProbes().catch(console.error), PROBE_INTERVAL_MS);
  console.log('[probes] worker started — interval 5 min');
}

async function runProbes(): Promise<void> {
  const active = await db.select().from(services).where(eq(services.active, true));
  const servicesToProbe = active.filter(s => !!s.upstreamUrl);

  await Promise.allSettled(servicesToProbe.map(svc => probe(svc)));
}

async function probe(svc: typeof services.$inferSelect): Promise<void> {
  // Health path: /health by convention; skip if upstream not set
  const healthPath = '/health';
  const url = svc.upstreamUrl.replace(/\/$/, '') + healthPath;

  const start = Date.now();
  let ok         = false;
  let statusCode: number | undefined;

  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 5_000);
    const sig        = signRequest(svc.upstreamSecret, Buffer.alloc(0));
    const res        = await fetch(url, {
      method: 'GET',
      headers: { 'X-Astralaunch-Signature': sig },
      signal:  controller.signal,
    });
    clearTimeout(timer);
    statusCode = res.status;
    ok         = res.status >= 200 && res.status < 300;
  } catch {
    ok = false;
  }

  const latencyMs = Date.now() - start;

  await db.insert(serviceProbes).values({
    serviceId:  svc.id,
    ok,
    latencyMs,
    statusCode: statusCode ?? null,
  }).catch(e => console.error('[probes] db insert failed:', e));
}
