import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { services, type Service } from '../db/schema.js';
import {
  createServiceSchema, updateServiceSchema, serviceCreateMessage, serviceUpdateMessage,
  linkCheckSchema, serviceSettingsSchema, serviceSettingsMessage, PROTECT_HEADER,
} from '@astralaunch/shared';
import { MONAD_NETWORK } from '@astralaunch/shared';
import { assertSafeUpstream, SsrfError } from '../lib/ssrf.js';
import { clientIp, fixedWindowLimiter } from '../lib/rateLimit.js';
import { upstreamBaseError } from '../lib/upstream.js';
import { gatewayLimits, paymentWindowS } from '../lib/proxy.js';
import { authorizeTokenCreator, consumeSignedMessage, ServiceAuthError } from '../services/serviceAuth.js';
import { insertService, serviceInputError } from '../services/creatorWrites.js';
import { checkLink } from '../services/linkCheck.js';
import {
  ensureProtectSecret, exampleTarget, parseLinkOrThrow, prepareServiceLink, publicSample, ServiceLinkError, type PreparedLink,
} from '../services/serviceLinks.js';
import { encryptSecret } from '../lib/secretBox.js';
import { compileResponseSchema } from '../lib/responseSchema.js';
import { clearSchemaMismatches, schemaMismatchSummary } from '../services/schemaMismatches.js';
import { USDC_ADDR, PAYMENT_TIMEOUT_S } from '../env.js';

const app = new Hono();

const nowS = () => Math.floor(Date.now() / 1000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authError(c: Context, e: unknown) {
  if (e instanceof ServiceAuthError) return c.json({ error: e.message }, e.status);
  if (e instanceof ServiceLinkError) return c.json({ error: e.message, check: e.check ?? null }, e.status);
  if (e instanceof SsrfError) return c.json({ error: 'This link must be a public https address.' }, 422);
  throw e;
}

/** Service fields that may be returned to anyone: never the link, the upstream, the key or a secret. */
export function publicService(s: Service) {
  return {
    id: s.id, asset: s.asset, slug: s.slug, name: s.name, router: s.router, creator: s.creator, priceUsdc: s.priceUsdc,
    description: s.description, examplePath: s.examplePath, timeoutSeconds: s.timeoutSeconds, active: s.active,
    responseKind: s.responseKind, responseContentType: s.responseContentType, updatedAt: s.updatedAt,
    sample: publicSample(s),
  };
}

const linkInput = (b: { apiLink?: string; wholeDomain?: boolean; apiKeyHeader?: string; apiKeyValue?: string; sampleMethod?: 'GET' | 'POST'; sampleBody?: string }) =>
  ({ apiLink: b.apiLink!, wholeDomain: b.wholeDomain, apiKeyHeader: b.apiKeyHeader || undefined, apiKeyValue: b.apiKeyValue, sampleMethod: b.sampleMethod, sampleBody: b.sampleBody });

// POST /api/services — register a service. Signed by the token's on-chain creator (D-SV1).
// New model: `apiLink` (+ optional key); the link must answer 2xx once before anything is stored.
app.post('/', zValidator('json', createServiceSchema), async (c) => {
  const body = c.req.valid('json');
  const bad = serviceInputError(body);
  if (bad) return c.json({ error: bad }, 400);
  const { signature, ...signed } = body;
  const message = serviceCreateMessage(signed);

  try {
    const token = await authorizeTokenCreator(db, {
      asset: body.asset, message, signature, issuedAt: body.issuedAt, nowS: nowS(),
    });
    const link = body.apiLink ? await prepareServiceLink(linkInput(body)) : null;
    if (!link) await assertSafeUpstream(body.upstreamUrl!);

    const svc = await db.transaction(async (tx) => {
      await consumeSignedMessage(tx, message, token.creator, 'service_create', body.issuedAt);
      return insertService(tx, token, body, body.issuedAt, link);   // router + creator from chain, not the client
    });
    return c.json({ id: svc.id, slug: svc.slug, router: svc.router, responseKind: svc.responseKind }, 201);
  } catch (e) {
    return authError(c, e);
  }
});

// POST /api/services/check — call a pasted link once and report what it returns (used before launching / attaching).
// Public (no token exists yet before a launch), so it is rate-limited per client address.
// Client IP only from our trusted proxy (lib/rateLimit.ts clientIp), never from client-set headers.
const CHECKS_PER_MINUTE = 10;
const checkLimiter = fixedWindowLimiter({ max: CHECKS_PER_MINUTE, windowMs: 60_000 });
const allowCheck = (c: Context): boolean => checkLimiter(clientIp(c));

app.post('/check', zValidator('json', linkCheckSchema), async (c) => {
  if (!allowCheck(c)) return c.json({ ok: false, error: 'Too many checks. Try again in a minute.' }, 429);
  const body = c.req.valid('json');
  try {
    const link = parseLinkOrThrow(body);
    const target = exampleTarget(link.upstreamUrl, link.examplePath);
    if (!target) return c.json({ ok: false, error: 'The link path is not usable.' }, 400);
    const headers = body.apiKeyHeader && body.apiKeyValue ? { [body.apiKeyHeader.toLowerCase()]: body.apiKeyValue } : {};
    const sample = body.sampleMethod ? { method: body.sampleMethod, body: body.sampleMethod === 'POST' ? body.sampleBody ?? null : null } : null;
    const check = await checkLink(target, headers, gatewayLimits().timeoutS, sample);
    const derived = { prefix: link.prefix, examplePath: link.examplePath };
    if (!check.ok) return c.json({ ...derived, ...check }, 422);
    return c.json({ ...derived, ...check });
  } catch (e) {
    if (e instanceof ServiceLinkError) return c.json({ ok: false, error: e.message }, e.status);
    throw e;
  }
});

// POST /api/services/:id/settings — the creator's private view (signed): the pasted link, the key header (never the
// value), the protect-your-API secret and the protection probe result. The only endpoint that returns them.
app.post('/:id/settings', zValidator('json', serviceSettingsSchema), async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404);
  const svc = await db.query.services.findFirst({ where: eq(services.id, id) });
  if (!svc) return c.json({ error: 'Not found' }, 404);
  const { signature, issuedAt } = c.req.valid('json');
  try {
    await authorizeTokenCreator(db, {
      asset: svc.asset, message: serviceSettingsMessage(svc.id, svc.asset, issuedAt), signature, issuedAt, nowS: nowS(), requireListed: false,
    });
    const secret = await ensureProtectSecret(db, svc);
    return c.json({
      ...publicService(svc),
      apiLink: svc.apiLink,
      wholeDomain: svc.wholeDomain,
      apiKey: svc.apiKeyHeader && svc.apiKeyEnc ? { header: svc.apiKeyHeader, set: true } : null,
      protect: { header: PROTECT_HEADER, secret },
      protection: { status: svc.protectionStatus, checkedAt: svc.protectionCheckedAt },
      responseSample: svc.responseSample,
      linkCheckedAt: svc.linkCheckedAt,
      sampleRequest: svc.sampleMethod ? { method: svc.sampleMethod, body: svc.sampleBody } : null,
      legacyUpstream: !svc.apiLink,
      // Response schema and the responses that failed it (D-SV4): creator-only, like everything above.
      responseSchema: svc.responseSchema,
      schemaMismatches: await schemaMismatchSummary(db, svc.id),
    });
  } catch (e) {
    return authError(c, e);
  }
});

// PATCH /api/services/:id — update price / link / key / timeout / description / response schema. Signed by the on-chain creator (D-SV1).
app.patch('/:id', zValidator('json', updateServiceSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404);

  const svc = await db.query.services.findFirst({ where: eq(services.id, id) });
  if (!svc) return c.json({ error: 'Not found' }, 404);
  const bad = body.upstreamUrl ? upstreamBaseError(body.upstreamUrl) : null;
  if (bad) return c.json({ error: bad }, 400);
  if (body.responseSchema) {
    try { compileResponseSchema(body.responseSchema); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  }

  const { signature, ...signed } = body;
  const message = serviceUpdateMessage(svc.id, svc.asset, signed);

  try {
    const token = await authorizeTokenCreator(db, {
      asset: svc.asset, message, signature, issuedAt: body.issuedAt, nowS: nowS(), lastIssuedAt: svc.authSignedAt,
    });
    if (body.upstreamUrl) await assertSafeUpstream(body.upstreamUrl);

    // A new link, key or sample request on a link-based service: re-run the check (with the service's own headers).
    // Sample: sent → use it; "" → remove it (plain GET); absent → keep the stored one.
    const newKey = body.apiKeyHeader && body.apiKeyValue ? { apiKeyHeader: body.apiKeyHeader, apiKeyValue: body.apiKeyValue } : null;
    const sampleChanged = body.sampleMethod !== undefined;
    const sample = body.sampleMethod === '' ? {} : body.sampleMethod ? { sampleMethod: body.sampleMethod, sampleBody: body.sampleBody }
      : svc.sampleMethod ? { sampleMethod: svc.sampleMethod as 'GET' | 'POST', sampleBody: svc.sampleBody ?? undefined } : {};
    if (sampleChanged && !body.apiLink && !svc.apiLink) throw new ServiceLinkError(400, 'A sample request needs an API link. Paste your API link first.');
    let link: PreparedLink | null = null;
    if (body.apiLink || ((newKey || sampleChanged) && svc.apiLink)) {
      link = await prepareServiceLink({
        apiLink: body.apiLink ?? svc.apiLink!, wholeDomain: body.apiLink ? body.wholeDomain : svc.wholeDomain, ...(newKey ?? {}), ...sample,
      }, body.apiKeyHeader === '' ? { ...svc, apiKeyHeader: null, apiKeyEnc: null } : svc);
    }

    const updated = await db.transaction(async (tx) => {
      await consumeSignedMessage(tx, message, token.creator, 'service_update', body.issuedAt);
      const [row] = await tx.update(services).set({
        ...(body.priceUsdc      !== undefined && { priceUsdc:      body.priceUsdc }),
        ...(body.upstreamUrl    !== undefined && { upstreamUrl:    body.upstreamUrl }),
        ...(body.timeoutSeconds !== undefined && { timeoutSeconds: body.timeoutSeconds }),
        ...(body.description    !== undefined && { description:    body.description }),
        ...(body.examplePath    !== undefined && { examplePath:    body.examplePath || null }),   // "" removes it
        ...(link && {
          apiLink: link.apiLink, wholeDomain: link.wholeDomain, upstreamUrl: link.upstreamUrl, examplePath: link.examplePath,
          responseKind: link.responseKind, responseContentType: link.responseContentType, responseSample: link.responseSample,
          linkCheckedAt: link.linkCheckedAt, apiKeyHeader: link.apiKeyHeader, apiKeyEnc: link.apiKeyEnc,
          sampleMethod: link.sampleMethod, sampleBody: link.sampleBody,
          ...(svc.apiLink ? {} : { timeoutSeconds: body.timeoutSeconds ?? 120 }),   // moving to the new model
          protectionStatus: null, protectionCheckedAt: null,
        }),
        // Key on a legacy (upstreamUrl) service: stored without a link check.
        ...(!link && newKey && { apiKeyHeader: newKey.apiKeyHeader, apiKeyEnc: encryptSecret(newKey.apiKeyValue, svc.id) }),
        ...(body.apiKeyHeader === '' && !link && { apiKeyHeader: null, apiKeyEnc: null }),
        ...(body.responseSchema !== undefined && { responseSchema: body.responseSchema || null }),   // "" removes it
        authSignedAt: BigInt(body.issuedAt),
        updatedAt:    new Date(),
      })
        // Monotonic guard against a concurrent, older signed update.
        .where(and(eq(services.id, id), or(isNull(services.authSignedAt), lt(services.authSignedAt, BigInt(body.issuedAt)))))
        .returning();
      if (!row) throw new ServiceAuthError(409, 'A newer signed request for this service was already accepted');
      if (body.responseSchema !== undefined) await clearSchemaMismatches(tx, svc.id);   // they were against the old schema
      return row;
    });

    return c.json({ ...publicService(updated), authSignedAt: updated.authSignedAt?.toString() ?? null });
  } catch (e) {
    return authError(c, e);
  }
});

// GET /api/services/:slug/manifest — machine-readable service description for agents
app.get('/:slug/manifest', async (c) => {
  const slug = c.req.param('slug');
  const svc = await db.query.services.findFirst({ where: eq(services.slug, slug) });
  if (!svc || !svc.active) return c.json({ error: 'Not found' }, 404);

  return c.json({
    id:          svc.id,
    asset:       svc.asset,
    slug:        svc.slug,
    name:        svc.name,
    description: svc.description,
    payment: {
      scheme:            'exact',
      network:           MONAD_NETWORK,
      asset:             USDC_ADDR,
      amount:            svc.priceUsdc,
      payTo:             svc.router,
      maxTimeoutSeconds: paymentWindowS(PAYMENT_TIMEOUT_S, Math.min(svc.timeoutSeconds, gatewayLimits().timeoutS)),
      extra: { name: 'USDC', version: '2' },
    },
    endpoint: `/s/${svc.slug}`,
    examplePath: svc.examplePath,
    sample: publicSample(svc),
    response: svc.responseKind ? { kind: svc.responseKind, contentType: svc.responseContentType } : null,
  });
});

export default app;
