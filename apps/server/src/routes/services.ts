import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { services } from '../db/schema.js';
import { createServiceSchema, updateServiceSchema, serviceCreateMessage, serviceUpdateMessage } from '@astralaunch/shared';
import { MONAD_NETWORK, USDC } from '@astralaunch/shared';
import { assertSafeUpstream, SsrfError } from '../lib/ssrf.js';
import { generateSecret } from '../lib/hmac.js';
import { authorizeTokenCreator, consumeSignedMessage, ServiceAuthError } from '../services/serviceAuth.js';
import { USDC_ADDR, PAYMENT_TIMEOUT_S } from '../env.js';

const app = new Hono();

const nowS = () => Math.floor(Date.now() / 1000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authError(c: Context, e: unknown) {
  if (e instanceof ServiceAuthError) return c.json({ error: e.message }, e.status);
  if (e instanceof SsrfError) return c.json({ error: e.message }, 422);
  throw e;
}

// POST /api/services — register a BYO service. Signed by the token's on-chain creator (D-SV1).
app.post('/', zValidator('json', createServiceSchema), async (c) => {
  const body = c.req.valid('json');
  const { signature, ...signed } = body;
  const message = serviceCreateMessage(signed);

  try {
    const token = await authorizeTokenCreator(db, {
      asset: body.asset, message, signature, issuedAt: body.issuedAt, nowS: nowS(),
    });
    await assertSafeUpstream(body.upstreamUrl);

    const svc = await db.transaction(async (tx) => {
      await consumeSignedMessage(tx, message, token.creator, 'service_create', body.issuedAt);
      const existing = await tx.query.services.findFirst({ where: eq(services.slug, body.slug) });
      if (existing) throw new ServiceAuthError(409, 'Slug already taken');
      const [row] = await tx.insert(services).values({
        slug:           body.slug,
        name:           body.name,
        asset:          token.asset,
        router:         token.router,       // from chain (Registered event), not the client
        creator:        token.creator,      // on-chain creator, not the client
        upstreamUrl:    body.upstreamUrl,
        priceUsdc:      body.priceUsdc,
        upstreamSecret: generateSecret(),
        timeoutSeconds: body.timeoutSeconds ?? 20,
        requestSchema:  body.requestSchema,
        responseSchema: body.responseSchema,
        description:    body.description,
        authSignedAt:   BigInt(body.issuedAt),
      }).returning();
      return row!;
    });
    return c.json({ id: svc.id, slug: svc.slug, router: svc.router }, 201);
  } catch (e) {
    return authError(c, e);
  }
});

// PATCH /api/services/:id — update price/upstream/timeout/description. Signed by the token's on-chain creator (D-SV1).
app.patch('/:id', zValidator('json', updateServiceSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404);

  const svc = await db.query.services.findFirst({ where: eq(services.id, id) });
  if (!svc) return c.json({ error: 'Not found' }, 404);

  const { signature, ...signed } = body;
  const message = serviceUpdateMessage(svc.id, svc.asset, signed);

  try {
    const token = await authorizeTokenCreator(db, {
      asset: svc.asset, message, signature, issuedAt: body.issuedAt, nowS: nowS(), lastIssuedAt: svc.authSignedAt,
    });
    if (body.upstreamUrl) await assertSafeUpstream(body.upstreamUrl);

    const updated = await db.transaction(async (tx) => {
      await consumeSignedMessage(tx, message, token.creator, 'service_update', body.issuedAt);
      const [row] = await tx.update(services).set({
        ...(body.priceUsdc      !== undefined && { priceUsdc:      body.priceUsdc }),
        ...(body.upstreamUrl    !== undefined && { upstreamUrl:    body.upstreamUrl }),
        ...(body.timeoutSeconds !== undefined && { timeoutSeconds: body.timeoutSeconds }),
        ...(body.description    !== undefined && { description:    body.description }),
        authSignedAt: BigInt(body.issuedAt),
        updatedAt:    new Date(),
      })
        // Monotonic guard against a concurrent, older signed update.
        .where(and(eq(services.id, id), or(isNull(services.authSignedAt), lt(services.authSignedAt, BigInt(body.issuedAt)))))
        .returning();
      if (!row) throw new ServiceAuthError(409, 'A newer signed request for this service was already accepted');
      return row;
    });

    const { upstreamSecret: _secret, authSignedAt, ...publicFields } = updated;
    return c.json({ ...publicFields, authSignedAt: authSignedAt?.toString() ?? null });
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
      maxTimeoutSeconds: PAYMENT_TIMEOUT_S,
      extra: { name: 'USDC', version: '2' },
    },
    endpoint: `/s/${svc.slug}`,
  });
});

export default app;
