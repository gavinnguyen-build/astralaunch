/**
 * x402 gateway — route group /s/:slug/*
 *
 * Flow (SPEC §9):
 *  1. No payment header (PAYMENT-SIGNATURE, or legacy X-PAYMENT) → 402 with PaymentRequired.
 *  2. X-PAYMENT present → verify via facilitator.
 *  0. The request path is mapped inside the service's upstream path prefix (lib/upstream.ts);
 *     a path that would leave it is refused with 400 before any payment.
 *  3. Verified → forward to upstream with HMAC signature + timeout.
 *  4. Upstream 2xx and the body passes the service's responseSchema (lib/responseSchema.ts)
 *     → settle → log settled=true → return upstream body + PAYMENT-RESPONSE.
 *  5. Upstream non-2xx, unreadable body, non-JSON or schema mismatch → log error, do NOT settle → 502.
 *  6. Settle fails → log settle_failed → return 402 to agent with receipt context.
 *
 * CLAUDE.md rules obeyed:
 *  - Facilitator calls via HTTPFacilitatorClient (@x402/core/server), never hand-written HTTP.
 *  - Header names from SDK encode/decode functions, not hardcoded strings.
 *  - Never log full payment payloads.
 *  - Body size cap 10 MB; upstream timeout configurable per service.
 */
import { Hono, type Context } from 'hono';
import { eq } from 'drizzle-orm';
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
import { signRequest } from '../lib/hmac.js';
import { FACILITATOR_URL, USDC_ADDR, CHAIN_ID, PAYMENT_TIMEOUT_S } from '../env.js';
import { MONAD_NETWORK } from '@astralaunch/shared';
import { PAYMENT_HEADERS, PAYMENT_REQUIRED_HEADERS, PAYMENT_RESPONSE_HEADER } from '../lib/x402Headers.js';
import { buildUpstreamUrl } from '../lib/upstream.js';
import { checkResponse } from '../lib/responseSchema.js';

const MAX_BODY_BYTES          = 10 * 1024 * 1024; // 10 MB
const MAX_RESPONSE_BYTES      = 10 * 1024 * 1024; // 10 MB, read in full before settle (schema check)

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const app = new Hono();

app.all('/:slug/*', async (c) => {
  const slug       = c.req.param('slug');
  const subpath    = c.req.param('slug') + c.req.path.replace(`/s/${slug}`, '') || '/';
  const method     = c.req.method;
  const startMs    = Date.now();

  // Load service
  const svc = await db.query.services.findFirst({ where: eq(services.slug, slug) });
  if (!svc || !svc.active) return c.json({ error: 'Service not found' }, 404);

  // Target inside the service's upstream path prefix (lib/upstream.ts); refused before any payment.
  const reqUrl = new URL(c.req.url);
  const target = buildUpstreamUrl(svc.upstreamUrl, reqUrl.pathname.slice(`/s/${slug}`.length), reqUrl.search);
  if (!target) return c.json({ error: 'Invalid request path' }, 400);

  // Build PaymentRequired (used for 402 response and verification)
  const requirements: PaymentRequirements = {
    scheme:            'exact',
    network:           MONAD_NETWORK,
    asset:             USDC_ADDR,
    amount:            svc.priceUsdc,
    payTo:             svc.router as `0x${string}`,
    maxTimeoutSeconds: PAYMENT_TIMEOUT_S,
    extra: { name: 'USDC', version: '2' },
  };

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url:         `${c.req.url}`,
      description: svc.description ?? svc.name,
      mimeType:    'application/json',
    },
    accepts: [requirements],
  };

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
    // Unverified: the claimed signer is only informative here.
    await logRequest(svc, payerFromPayload(payload) ?? 'unknown', false, false, null, 'verify_failed', startMs, c);
    return c.json({ error: 'Payment verification failed', reason: verifyResult.invalidReason }, 402);
  }
  // Payer = the address the facilitator verified, else the verified authorization's `from` (D-GW2).
  const payer = verifyResult.payer ?? payerFromPayload(payload) ?? 'unknown';

  // ── 3. Forward to upstream ──────────────────────────────────────────────────
  const upstreamUrl = target.toString();

  let bodyBytes: Buffer | null = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const ab = await c.req.arrayBuffer();
    if (ab.byteLength > MAX_BODY_BYTES) return c.json({ error: 'Request body too large' }, 413);
    bodyBytes = Buffer.from(ab);
  }

  const fwdHeaders: Record<string, string> = {
    'Content-Type':      c.req.header('Content-Type') ?? 'application/json',
    'X-Astralaunch-Signature': signRequest(svc.upstreamSecret, bodyBytes ?? Buffer.alloc(0)),
  };

  let upstreamRes: Response;
  let upstreamStatus: number;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (svc.timeoutSeconds) * 1000);
    upstreamRes = await fetch(upstreamUrl, {
      method,
      headers: fwdHeaders,
      body:    bodyBytes ? new Uint8Array(bodyBytes) : undefined,
      signal:  controller.signal,
    });
    clearTimeout(timer);
    upstreamStatus = upstreamRes.status;
  } catch (e) {
    await logRequest(svc, payer, true, false, null, 'upstream_error', startMs, c);
    return c.json({ error: 'Upstream unreachable' }, 502);
  }

  // ── 4. Non-2xx → do NOT settle ─────────────────────────────────────────────
  if (upstreamStatus < 200 || upstreamStatus >= 300) {
    await logRequest(svc, payer, true, false, upstreamStatus, 'upstream_error', startMs, c);
    return c.json({ error: 'Upstream returned non-2xx', upstreamStatus }, 502);
  }

  // ── 5. Read the body and check the service's responseSchema → on failure do NOT settle ──
  let responseBodyBuf: Buffer;
  try {
    const len = Number(upstreamRes.headers.get('Content-Length') ?? 0);
    if (len > MAX_RESPONSE_BYTES) throw new Error('too large');
    responseBodyBuf = Buffer.from(await upstreamRes.arrayBuffer());
    if (responseBodyBuf.byteLength > MAX_RESPONSE_BYTES) throw new Error('too large');
  } catch {
    await logRequest(svc, payer, true, false, upstreamStatus, 'upstream_error', startMs, c);
    return c.json({ error: 'Upstream response unreadable or too large' }, 502);
  }
  const check = checkResponse(svc.responseSchema, responseBodyBuf);
  if (!check.ok) {
    await logRequest(svc, payer, true, false, upstreamStatus, check.code, startMs, c);
    return c.json({ error: 'Upstream response failed the service response schema; you were not charged', reason: check.code, detail: check.detail }, 502);
  }

  // ── 6. Settle (only on upstream success + schema pass) ─────────────────────
  const settleResult = await facilitator.settle(payload, requirements);
  const settleTxHash: string | null = settleResult.success ? (settleResult.transaction ?? null) : null;

  if (!settleResult.success) {
    // Settle failed AFTER upstream already processed the request.
    // Log settle_failed; agent should retry (their payment auth likely expired).
    await logRequest(svc, payer, true, false, upstreamStatus, 'settle_failed', startMs, c, settleTxHash);
    return c.json({ error: 'Payment settlement failed', reason: settleResult.errorReason }, 402);
  }

  // ── 7. Return upstream response ────────────────────────────────────────────
  await logRequest(svc, payer, true, true, upstreamStatus, null, startMs, c, settleTxHash, bodyBytes, responseBodyBuf);

  return new Response(new Uint8Array(responseBodyBuf), {
    status:  upstreamStatus,
    headers: {
      'Content-Type': upstreamRes.headers.get('Content-Type') ?? 'application/json',
      [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settleResult),
    },
  });
});

/** EIP-3009 `authorization.from` of an exact-scheme payload (v2: payload.payload.authorization). */
function payerFromPayload(payload: ReturnType<typeof decodePaymentSignatureHeader>): string | undefined {
  const from = (payload.payload as { authorization?: { from?: unknown } } | undefined)?.authorization?.from;
  return typeof from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(from) ? from : undefined;
}

async function logRequest(
  svc:           Service,
  payer:         string,
  verified:      boolean,
  settled:       boolean,
  upstreamStatus: number | null,
  errorCode:     string | null,
  startMs:       number,
  c:             Context,
  settleTxHash?: string | null,
  reqBody?:      Buffer | null,
  resBody?:      Buffer | null,
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
    responseBytes:  resBody?.byteLength ?? 0,
  }).catch(() => { /* non-fatal logging failure */ });
}

export default app;
