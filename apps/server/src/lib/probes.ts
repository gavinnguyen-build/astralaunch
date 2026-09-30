/**
 * Service probes (SPEC §9.4), every 5 minutes for each active service:
 * - Health: legacy services GET {upstreamUrl}/health (signed); "one API link" services make their example call with
 *   the gateway's headers (secret + API key). Latency and status go to service_probes.
 * - Protection ("Protect your API"): link services only. The example call is made DIRECTLY, without the secret and
 *   without the API key, like a stranger would. A 2xx means anyone can bypass the gateway → 'unprotected'
 *   (shown to the creator only). A network error leaves the previous status unchanged.
 * Both go through lib/upstreamClient.ts (public https, DNS checked on connect).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { services, serviceProbes, type Service } from '../db/schema.js';
import { signRequest } from './hmac.js';
import { upstreamRequest } from './upstreamClient.js';
import { apiKeyFor, ensureProtectSecret, exampleTarget, gatewayHeaders } from '../services/serviceLinks.js';
import type { Db } from '../services/launchFee.js';

const PROBE_INTERVAL_MS = 5 * 60_000; // 5 minutes
const PROBE_TIMEOUT_MS = 10_000;

export function startProbeWorker(): void {
  // Read-only preview instances (e.g. a second local server on mainnet data) must not write probes.
  if (process.env.PROBES_DISABLED === 'true') { console.log('[probes] disabled (PROBES_DISABLED=true)'); return; }
  runProbes().catch(console.error);
  setInterval(() => runProbes().catch(console.error), PROBE_INTERVAL_MS);
  console.log('[probes] worker started — interval 5 min');
}

async function runProbes(): Promise<void> {
  const active = await db.select().from(services).where(eq(services.active, true));
  await Promise.allSettled(active.map((svc) => probeService(db, svc)));
}

/** One request (GET, or the service's sample request); returns the status, or null on a network error. Never throws. */
async function get(url: URL, headers: Record<string, string>, sample?: { method: string; body: string | null } | null): Promise<{ status: number | null; ms: number }> {
  const start = Date.now();
  try {
    const body = sample?.method === 'POST' && sample.body ? Buffer.from(sample.body) : null;
    const res = await upstreamRequest({
      url, method: sample?.method ?? 'GET', body, headersTimeoutMs: PROBE_TIMEOUT_MS,
      headers: { accept: '*/*', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    });
    res.body.destroy();
    return { status: res.status, ms: Date.now() - start };
  } catch {
    return { status: null, ms: Date.now() - start };
  }
}

/**
 * Probe one service (health + protection). Exported for tests.
 * With a sample call (a checked response): the sample request is used; healthy = 2xx; direct 2xx = unprotected,
 * direct non-2xx = protected. Without one (e.g. a POST-only API): a plain GET; healthy = any answer below 500;
 * direct 401/403 = protected, direct 2xx = unprotected, anything else leaves the status unchanged.
 */
export async function probeService(dbc: Db, svc: Service): Promise<{ health: number | null; direct?: number | null }> {
  if (!svc.apiLink) {
    const url = new URL(svc.upstreamUrl.replace(/\/$/, '') + '/health');
    const r = await get(url, { 'X-Astralaunch-Signature': signRequest(svc.upstreamSecret, Buffer.alloc(0)) });
    await recordHealth(dbc, svc, r);
    return { health: r.status };
  }
  const target = exampleTarget(svc.upstreamUrl, svc.examplePath);
  if (!target) return { health: null };
  await ensureProtectSecret(dbc, svc);
  let key: ReturnType<typeof apiKeyFor> = null;
  try { key = apiKeyFor(svc); } catch { /* undecryptable key: health fails below */ }
  const hasSample = !!svc.responseKind;
  const sample = svc.sampleMethod ? { method: svc.sampleMethod, body: svc.sampleBody } : null;
  const h = await get(target, { ...gatewayHeaders(svc, Buffer.from(sample?.body ?? '')), ...(key ? { [key.header.toLowerCase()]: key.value } : {}) }, sample);
  await recordHealth(dbc, svc, h, hasSample ? (s) => s >= 200 && s < 300 : (s) => s < 500);

  const direct = await get(target, {}, sample);   // no secret, no key: what anyone on the internet gets
  if (direct.status !== null) {
    const s = direct.status;
    const status = s >= 200 && s < 300 ? 'unprotected' : hasSample || s === 401 || s === 403 ? 'protected' : null;
    if (status) await dbc.update(services).set({ protectionStatus: status, protectionCheckedAt: new Date() }).where(eq(services.id, svc.id));
  }
  return { health: h.status, direct: direct.status };
}

async function recordHealth(dbc: Db, svc: Service, r: { status: number | null; ms: number }, healthy: (s: number) => boolean = (s) => s >= 200 && s < 300) {
  await dbc.insert(serviceProbes).values({
    serviceId:  svc.id,
    ok:         r.status !== null && healthy(r.status),
    latencyMs:  r.ms,
    statusCode: r.status,
  }).catch((e) => console.error('[probes] db insert failed:', e));
}
