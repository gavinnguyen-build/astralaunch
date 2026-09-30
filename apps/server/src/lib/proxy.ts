/**
 * Gateway proxy rules (pure, unit-tested): which headers cross the gateway, how redirects are rewritten, whether a
 * response is streamed, and when a call is charged. The gateway route (routes/gateway.ts) only wires them up.
 */

// ── Limits (env-configurable) ─────────────────────────────────────────────────

const envNum = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
export const gatewayLimits = () => ({
  /** Max request body forwarded upstream. */
  maxRequestBytes:  envNum('GATEWAY_MAX_REQUEST_BYTES', 25 * 1024 * 1024),
  /** Max non-streamed response body (read in full before settling). */
  maxResponseBytes: envNum('GATEWAY_MAX_RESPONSE_BYTES', 25 * 1024 * 1024),
  /** Total time for a non-streamed call (and time to response headers for a stream). */
  timeoutS:         envNum('GATEWAY_TIMEOUT_S', 120),
  /** A stream is cut when no bytes arrive for this long. */
  streamIdleS:      envNum('GATEWAY_STREAM_IDLE_S', 60),
});

/**
 * Payment authorization window for a call: the agent's EIP-3009 authorization must still be valid when the gateway
 * settles, i.e. after the upstream answered (up to the timeout). Never below the configured PAYMENT_TIMEOUT_SECONDS,
 * capped at 300 s (the server's replay guard). Verified 2026-09-30: the official Monad facilitator accepts 150 s and 300 s.
 */
export const paymentWindowS = (baseS: number, upstreamTimeoutS: number) => Math.min(300, Math.max(baseS, upstreamTimeoutS + 30));

// ── Request headers ───────────────────────────────────────────────────────────

/** Never forwarded from the agent: hop-by-hop, payment, gateway-owned, proxy/CDN metadata, cookies for our domain. */
const DROP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'cookie', 'forwarded', 'x-real-ip', 'true-client-ip', 'via',
  'origin', 'referer',
]);
const DROP_REQUEST_PREFIX = ['x-forwarded-', 'cf-', 'x-payment', 'payment-', 'x-astralaunch-', 'sec-', 'cdn-'];

export interface ForwardAdds {
  /** Creator's API key (decrypted), added last so it wins over an agent header of the same name. */
  apiKey?: { header: string; value: string } | null;
  /** Protect-your-API secret and HMAC signature headers. */
  gateway: Record<string, string>;
}

/** Headers sent upstream: the agent's safe headers (incl. session ids, auth for their own session, content type). */
export function forwardRequestHeaders(incoming: Headers, adds: ForwardAdds): Record<string, string> {
  const out: Record<string, string> = {};
  incoming.forEach((v, k) => {
    const key = k.toLowerCase();
    if (DROP_REQUEST.has(key) || DROP_REQUEST_PREFIX.some((p) => key.startsWith(p))) return;
    out[key] = v;
  });
  if (adds.apiKey) {
    for (const k of Object.keys(out)) if (k === adds.apiKey.header.toLowerCase()) delete out[k];
    out[adds.apiKey.header.toLowerCase()] = adds.apiKey.value;
  }
  for (const [k, v] of Object.entries(adds.gateway)) out[k.toLowerCase()] = v;
  return out;
}

// ── Response headers ──────────────────────────────────────────────────────────

/** Never returned to the agent: hop-by-hop, server fingerprint, CDN/cloud metadata, cookies, CORS/security of theirs. */
const DROP_RESPONSE = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
  'server', 'x-powered-by', 'via', 'x-aspnet-version', 'x-aspnetmvc-version', 'x-runtime', 'x-served-by', 'x-backend-server',
  'x-server', 'x-host', 'x-upstream', 'x-envoy-upstream-service-time', 'x-kong-upstream-latency', 'x-kong-proxy-latency',
  'set-cookie', 'set-cookie2', 'alt-svc', 'nel', 'report-to', 'strict-transport-security', 'public-key-pins',
  'content-security-policy', 'x-request-id', 'x-trace-id', 'traceparent', 'tracestate', 'server-timing',
  'location', 'content-location', 'refresh',
]);
const DROP_RESPONSE_PREFIX = ['x-amz-', 'x-goog-', 'x-azure-', 'x-ms-', 'cf-', 'x-cache', 'x-vercel-', 'x-nf-', 'x-render-',
  'x-fly-', 'x-railway-', 'x-cloud-trace', 'access-control-', 'x-payment', 'payment-'];

export interface RewriteCtx {
  /** Service upstream base (origin + prefix, no trailing slash), e.g. https://myagent.ai/v1 */
  upstreamBase: string;
  /** Public gateway base for this service, e.g. https://api.astralaunch.xyz/s/myagent */
  gatewayBase: string;
}

/**
 * Location header for the agent. Inside the service's prefix → the matching gateway URL. Same upstream origin but
 * outside the prefix → null (dropped: it would reveal and target the upstream). Another origin (e.g. a signed file
 * URL on a CDN) → unchanged.
 */
export function rewriteLocation(location: string, ctx: RewriteCtx, requestUrl: URL): string | null {
  let target: URL;
  const base = new URL(ctx.upstreamBase);
  try { target = new URL(location, new URL(requestUrl.pathname, base.origin)); } catch { return null; }
  if (target.origin !== base.origin) return target.protocol === 'https:' ? target.toString() : null;
  const prefix = base.pathname.replace(/\/+$/, '');
  if (prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) return null;
  const rest = target.pathname.slice(prefix.length).replace(/^\//, '');
  return `${ctx.gatewayBase.replace(/\/+$/, '')}/${rest}${target.search}`;
}

export function responseHeaders(upstream: Headers, ctx: RewriteCtx, requestUrl: URL): Headers {
  const out = new Headers();
  upstream.forEach((v, k) => {
    const key = k.toLowerCase();
    if (DROP_RESPONSE.has(key) || DROP_RESPONSE_PREFIX.some((p) => key.startsWith(p))) return;
    out.append(key, v);
  });
  const loc = upstream.get('location');
  if (loc) {
    const rewritten = rewriteLocation(loc, ctx, requestUrl);
    if (rewritten) out.set('location', rewritten);
  }
  return out;
}

/** Replace every occurrence of the upstream host (and origin) in a text, for error bodies shown to agents. */
export function scrubUpstream(text: string, upstreamBase: string): string {
  const u = new URL(upstreamBase);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`${esc(u.origin)}|${esc(u.host)}|${esc(u.hostname)}`, 'gi'), '<upstream>');
}

// ── Streaming + settlement rule ───────────────────────────────────────────────

export const isJsonType = (ct: string | null) => !!ct && /(^application\/json|\+json)(;|$)/i.test(ct.split(';')[0]!.trim() + ';');
export const isEventStream = (ct: string | null) => !!ct && /^text\/event-stream/i.test(ct.trim());

/**
 * Streamed = passed through byte by byte without buffering: server-sent events, or a chunked (no content-length)
 * response that is not JSON. Everything else is read in full first (≤ maxResponseBytes).
 */
export function isStreamedResponse(h: Headers): boolean {
  const ct = h.get('content-type');
  if (isEventStream(ct)) return true;
  if (isJsonType(ct)) return false;
  return !h.has('content-length');
}

export type Settlement =
  | { charge: false; reason: 'upstream_status' }
  | { charge: true; when: 'before_body' }                       // streams: at 2xx headers
  | { charge: true; when: 'after_body'; schemaCheck: boolean }; // buffered: after a full 2xx body (+ schema if declared)

/**
 * When is a call charged? Non-2xx (incl. redirects) or a connection error: never. A 2xx stream: when its headers
 * arrive, before the body streams. A 2xx buffered response: after the body is read, and after the response schema
 * check only when the service declared one.
 */
export function settlementFor(status: number, streamed: boolean, hasSchema: boolean): Settlement {
  if (status < 200 || status >= 300) return { charge: false, reason: 'upstream_status' };
  if (streamed) return { charge: true, when: 'before_body' };
  return { charge: true, when: 'after_body', schemaCheck: hasSchema };
}
