/**
 * x402 gateway — route group /s/:slug/*
 *
 * Flow (SPEC §9, "one API link" model D-SL1..):
 *  0. The request path is mapped inside the service's upstream prefix (lib/upstream.ts); a path that would leave
 *     it is refused with 400 before any payment.
 *  1. No payment header (PAYMENT-SIGNATURE, or legacy X-PAYMENT) → 402 with PaymentRequired.
 *  2. Verify via the facilitator.
 *  3. Forward any method, the path, query, body (≤ 25 MB) and the agent's safe headers, plus the creator's API key
 *     (decrypted), the protect-your-API secret and the HMAC signature (lib/proxy.ts, services/serviceLinks.ts).
 *     Public https only, DNS checked when connecting, redirects never followed (lib/upstreamClient.ts).
 *  4. Charge rule (lib/proxy.ts settlementFor): non-2xx or a connection error → never charged.
 *     Streamed 2xx (SSE, or chunked non-JSON) → settle when the headers arrive, then pass the bytes through
 *     unbuffered (60 s idle timeout). Buffered 2xx → read (≤ 25 MB, 120 s), schema check only if the service
 *     declared one, then settle.
 *  5. Settle fails → 402 (buffered: nothing returned; streamed: the upstream body is cancelled).
 *  The upstream is never revealed: fingerprint headers stripped, Location rewritten to the gateway, errors scrubbed.
 *
 * CLAUDE.md: facilitator via HTTPFacilitatorClient; SDK header helpers; payment payloads never logged.
 */
import { Hono, type Context } from 'hono';
import { eq } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import {
  HTTPFacilitatorClient,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  PAYMENT_REQUIRED_CACHE_CONTROL,
} from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { db } from '../db/client.js';
import { services, gatewayRequests } from '../db/schema.js';
import type { Service } from '../db/schema.js';
import { FACILITATOR_URL, USDC_ADDR, PAYMENT_TIMEOUT_S } from '../env.js';
import { MONAD_NETWORK } from '@astralaunch/shared';
import { PAYMENT_HEADERS, PAYMENT_REQUIRED_HEADERS, PAYMENT_RESPONSE_HEADER } from '../lib/x402Headers.js';
import { buildUpstreamUrl } from '../lib/upstream.js';
import { checkResponse } from '../lib/responseSchema.js';
import {
  forwardRequestHeaders, gatewayLimits, isStreamedResponse, paymentWindowS, responseHeaders, scrubUpstream, settlementFor,
} from '../lib/proxy.js';
import { readBody, upstreamRequest, UpstreamError } from '../lib/upstreamClient.js';
import { apiKeyFor, ensureProtectSecret, gatewayHeaders } from '../services/serviceLinks.js';

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const app = new Hono();

/** Public base of this service's agent link, from the incoming request (e.g. https://api.astralaunch.xyz/s/slug). */
function gatewayBase(c: Context, slug: string): string {
  const u = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto') ?? u.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? u.host;
  return `${proto}://${host}/s/${slug}`;
}

/** Decoded body for the schema check only (the agent receives the raw bytes). */
function decodedForCheck(buf: Buffer, encoding: string | null): Buffer {
  const e = (encoding ?? '').toLowerCase().trim();
  if (e === 'gzip' || e === 'x-gzip') return gunzipSync(buf);
  if (e === 'deflate') return inflateSync(buf);
  if (e === 'br') return brotliDecompressSync(buf);
  return buf;
}

app.all('/:slug/*', async (c) => {
  const slug    = c.req.param('slug');
  const method  = c.req.method;
  const startMs = Date.now();
  const limits  = gatewayLimits();

  const svc = await db.query.services.findFirst({ where: eq(services.slug, slug) });
  if (!svc || !svc.active) return c.json({ error: 'Service not found' }, 404);

  // Target inside the service's upstream path prefix (lib/upstream.ts); refused before any payment.
  const reqUrl = new URL(c.req.url);
  const target = buildUpstreamUrl(svc.upstreamUrl, reqUrl.pathname.slice(`/s/${slug}`.length), reqUrl.search);
  if (!target) return c.json({ error: 'Invalid request path' }, 400);

  const timeoutS = Math.min(svc.timeoutSeconds, limits.timeoutS);
  const requirements: PaymentRequirements = {
    scheme:            'exact',
    network:           MONAD_NETWORK,
    asset:             USDC_ADDR,
    amount:            svc.priceUsdc,
    payTo:             svc.router as `0x${string}`,
    maxTimeoutSeconds: paymentWindowS(PAYMENT_TIMEOUT_S, timeoutS),
    extra: { name: 'USDC', version: '2' },
  };
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url:         `${c.req.url}`,
      description: svc.description ?? svc.name,
      mimeType:    svc.responseContentType?.split(';')[0] ?? 'application/json',
    },
    accepts: [requirements],
  };

  // Body size before payment, from the declared length.
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > limits.maxRequestBytes) return c.json({ error: `Request body too large (max ${limits.maxRequestBytes} bytes)` }, 413);

  // ── 1. No payment header → 402 ─────────────────────────────────────────────
  const paymentHeader = PAYMENT_HEADERS.map(h => c.req.header(h)).find(Boolean);
  if (!paymentHeader) {
    const encoded = encodePaymentRequiredHeader(paymentRequired);
    return new Response(JSON.stringify({ error: 'Payment required', x402Version: 2 }), {
      status: 402,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': PAYMENT_REQUIRED_CACHE_CONTROL,
        ...Object.fromEntries(PAYMENT_REQUIRED_HEADERS.map(h => [h, encoded])),
      },
    });
  }

  // ── 2. Decode + verify ──────────────────────────────────────────────────────
  let payload: ReturnType<typeof decodePaymentSignatureHeader>;
  try {
    payload = decodePaymentSignatureHeader(paymentHeader);
  } catch {
    return c.json({ error: 'Malformed payment header' }, 400);
  }
  const verifyResult = await facilitator.verify(payload, requirements);
  if (!verifyResult.isValid) {
    await logRequest(svc, payerFromPayload(payload) ?? 'unknown', false, false, null, 'verify_failed', startMs);
    return c.json({ error: 'Payment verification failed', reason: verifyResult.invalidReason }, 402);
  }
  const payer = verifyResult.payer ?? payerFromPayload(payload) ?? 'unknown';

  // ── 3. Forward ──────────────────────────────────────────────────────────────
  let bodyBytes: Buffer | null = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const ab = await c.req.arrayBuffer();
    if (ab.byteLength > limits.maxRequestBytes) return c.json({ error: `Request body too large (max ${limits.maxRequestBytes} bytes)` }, 413);
    bodyBytes = Buffer.from(ab);
  }
  await ensureProtectSecret(db, svc);
  let apiKey: ReturnType<typeof apiKeyFor> = null;
  try { apiKey = apiKeyFor(svc); } catch {
    await logRequest(svc, payer, true, false, null, 'config_error', startMs, null, bodyBytes);
    return c.json({ error: 'Service misconfigured; you were not charged' }, 502);
  }
  const headers = forwardRequestHeaders(c.req.raw.headers, { apiKey, gateway: gatewayHeaders(svc, bodyBytes ?? Buffer.alloc(0)) });

  const deadline = startMs + timeoutS * 1000;
  let res;
  try {
    res = await upstreamRequest({ url: target, method, headers, body: bodyBytes, headersTimeoutMs: Math.max(1, deadline - Date.now()) });
  } catch (e) {
    const code = e instanceof UpstreamError && e.kind === 'timeout' ? 'upstream_timeout' : 'upstream_error';
    await logRequest(svc, payer, true, false, null, code, startMs, null, bodyBytes);
    return c.json({ error: code === 'upstream_timeout' ? `The service did not answer within ${timeoutS} s; you were not charged` : 'Upstream unreachable; you were not charged' }, code === 'upstream_timeout' ? 504 : 502);
  }

  const ctx = { upstreamBase: svc.upstreamUrl, gatewayBase: gatewayBase(c, slug) };
  const outHeaders = responseHeaders(res.headers, ctx, target);
  const streamed = method !== 'HEAD' && res.status !== 204 && isStreamedResponse(res.headers);
  const rule = settlementFor(res.status, streamed, !!svc.responseSchema);

  // ── 4a. Not charged: redirects (rewritten), upstream errors (scrubbed, ≤ 2 KB of text) ─────────────────────
  if (!rule.charge) {
    const isRedirect = res.status >= 300 && res.status < 400;
    let detail: string | undefined;
    if (!isRedirect && /json|text|xml/i.test(res.headers.get('content-type') ?? '') && !res.headers.get('content-encoding')) {
      try { detail = scrubUpstream((await readBody(res.body, 2048 * 4, Math.min(deadline, Date.now() + 5000))).toString('utf8').slice(0, 2048), svc.upstreamUrl); }
      catch { detail = undefined; }
    } else res.body.destroy();
    await logRequest(svc, payer, true, false, res.status, isRedirect ? 'upstream_redirect' : 'upstream_error', startMs, null, bodyBytes);
    if (isRedirect) {
      const loc = outHeaders.get('location');
      return c.json({ error: 'The service redirected; you were not charged', upstreamStatus: res.status, ...(loc ? { location: loc } : {}) },
        res.status as 301, loc ? { Location: loc } : undefined);
    }
    return c.json({ error: 'Upstream returned an error; you were not charged', upstreamStatus: res.status, ...(detail ? { upstreamBody: detail } : {}) }, 502);
  }

  // ── 4b. Streamed: settle on 2xx headers, then pass bytes through unbuffered ──────────────────────────────
  if (rule.when === 'before_body') {
    const settle = await facilitator.settle(payload, requirements);
    if (!settle.success) {
      res.body.destroy();
      await logRequest(svc, payer, true, false, res.status, 'settle_failed', startMs, null, bodyBytes);
      return c.json({ error: 'Payment settlement failed', reason: settle.errorReason }, 402);
    }
    const settleTx = settle.transaction ?? null;
    outHeaders.set(PAYMENT_RESPONSE_HEADER, encodePaymentResponseHeader(settle));
    outHeaders.set('cache-control', outHeaders.get('cache-control') ?? 'no-store');
    let sent = 0;
    let idle: NodeJS.Timeout | undefined;
    const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => res.body.destroy(new UpstreamError('timeout', 'stream idle')), limits.streamIdleS * 1000); };
    armIdle();
    res.body.on('data', (chunk: Buffer) => { sent += chunk.byteLength; armIdle(); });
    const done = (code: string | null) => { clearTimeout(idle); void logRequest(svc, payer, true, true, res.status, code, startMs, settleTx, bodyBytes, sent); };
    res.body.once('end', () => done(null));
    res.body.once('error', (e) => done(e instanceof UpstreamError && e.message === 'stream idle' ? 'stream_idle_timeout' : 'stream_interrupted'));
    res.body.once('close', () => clearTimeout(idle));
    return new Response(Readable.toWeb(res.body) as ReadableStream, { status: res.status, headers: outHeaders });
  }

  // ── 4c. Buffered: read in full, schema check if declared, then settle ────────────────────────────────────
  let responseBody: Buffer;
  try {
    responseBody = method === 'HEAD' ? Buffer.alloc(0) : await readBody(res.body, limits.maxResponseBytes, deadline);
  } catch (e) {
    const code = e instanceof UpstreamError && e.kind === 'timeout' ? 'upstream_timeout' : 'upstream_error';
    await logRequest(svc, payer, true, false, res.status, code, startMs, null, bodyBytes);
    return c.json({ error: code === 'upstream_timeout' ? `The service did not finish within ${timeoutS} s; you were not charged` : 'Upstream response unreadable or too large; you were not charged' }, 502);
  }
  if (rule.schemaCheck) {
    let forCheck: Buffer;
    try { forCheck = decodedForCheck(responseBody, res.headers.get('content-encoding')); } catch { forCheck = responseBody; }
    const check = checkResponse(svc.responseSchema, forCheck);
    if (!check.ok) {
      await logRequest(svc, payer, true, false, res.status, check.code, startMs, null, bodyBytes);
      return c.json({ error: 'Upstream response failed the service response schema; you were not charged', reason: check.code, detail: check.detail }, 502);
    }
  }
  const settle = await facilitator.settle(payload, requirements);
  const settleTx = settle.success ? (settle.transaction ?? null) : null;
  if (!settle.success) {
    await logRequest(svc, payer, true, false, res.status, 'settle_failed', startMs, settleTx, bodyBytes);
    return c.json({ error: 'Payment settlement failed', reason: settle.errorReason }, 402);
  }
  await logRequest(svc, payer, true, true, res.status, null, startMs, settleTx, bodyBytes, responseBody.byteLength);
  outHeaders.set(PAYMENT_RESPONSE_HEADER, encodePaymentResponseHeader(settle));
  return new Response(method === 'HEAD' || res.status === 204 ? null : new Uint8Array(responseBody), { status: res.status, headers: outHeaders });
});

/** EIP-3009 `authorization.from` of an exact-scheme payload (v2: payload.payload.authorization). */
function payerFromPayload(payload: ReturnType<typeof decodePaymentSignatureHeader>): string | undefined {
  const from = (payload.payload as { authorization?: { from?: unknown } } | undefined)?.authorization?.from;
  return typeof from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(from) ? from : undefined;
}

async function logRequest(
  svc: Service, payer: string, verified: boolean, settled: boolean, upstreamStatus: number | null, errorCode: string | null,
  startMs: number, settleTxHash?: string | null, reqBody?: Buffer | null, responseBytes = 0,
) {
  await db.insert(gatewayRequests).values({
    serviceId:      svc.id,
    asset:          svc.asset,
    payer:          payer.toLowerCase(),
    amountUsdc:     svc.priceUsdc,
    statusCode:     settled ? upstreamStatus ?? 200 : 402,
    upstreamStatus: upstreamStatus ?? undefined,
    latencyMs:      Date.now() - startMs,
    verified,
    settled,
    settleTxHash:   settleTxHash ?? undefined,
    errorCode:      errorCode ?? undefined,
    requestBytes:   reqBody?.byteLength ?? 0,
    responseBytes,
  }).catch(() => { /* non-fatal logging failure */ });
}

export default app;
