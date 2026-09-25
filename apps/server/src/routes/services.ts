import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { services } from '../db/schema.js';
import { createServiceSchema, updateServiceSchema, serviceRegistrationMessage } from '@astralaunch/shared';
import { MONAD_NETWORK, USDC } from '@astralaunch/shared';
import { assertSafeUpstream, SsrfError } from '../lib/ssrf.js';
import { generateSecret } from '../lib/hmac.js';
import { REGISTRY_ADDR, RPC_URL, CHAIN_ID, USDC_ADDR, PAYMENT_TIMEOUT_S } from '../env.js';
import { createPublicClient, http, verifyMessage, getAddress, type Address } from 'viem';
import { defineChain } from 'viem';

const monad = defineChain({
  id: CHAIN_ID,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const publicClient = createPublicClient({ chain: monad, transport: http(RPC_URL) });

/** Minimal ABI to read router address from registry. */
const registryAbi = [
  { type: 'function', name: 'routers', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'isRegistered', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

const app = new Hono();

// POST /api/services — register a BYO service
app.post('/', zValidator('json', createServiceSchema), async (c) => {
  const body = c.req.valid('json');

  // 1. SSRF check on upstream URL
  try {
    await assertSafeUpstream(body.upstreamUrl);
  } catch (e) {
    if (e instanceof SsrfError) return c.json({ error: e.message }, 422);
    throw e;
  }

  // 2. Verify creator signature (personal_sign)
  const message = serviceRegistrationMessage(body.slug, body.asset);
  let sigValid: boolean;
  try {
    sigValid = await verifyMessage({
      address: getAddress(body.creator) as Address,
      message,
      signature: body.signature as `0x${string}`,
    });
  } catch {
    sigValid = false;
  }
  if (!sigValid) {
    return c.json({ error: 'Invalid creator signature' }, 401);
  }

  // 3. Verify token is registered in AstralaunchRegistry on-chain
  let router: Address;
  try {
    router = await publicClient.readContract({
      address: REGISTRY_ADDR,
      abi: registryAbi,
      functionName: 'routers',
      args: [body.asset as Address],
    });
    if (router === '0x0000000000000000000000000000000000000000') {
      return c.json({ error: 'Token not registered in AstralaunchRegistry' }, 400);
    }
  } catch {
    return c.json({ error: 'Failed to read AstralaunchRegistry' }, 502);
  }

  // 4. Check slug uniqueness
  const existing = await db.query.services.findFirst({ where: eq(services.slug, body.slug) });
  if (existing) return c.json({ error: 'Slug already taken' }, 409);

  // 5. Persist
  const secret = generateSecret();
  const [svc] = await db.insert(services).values({
    slug:           body.slug,
    name:           body.name,
    asset:          body.asset.toLowerCase(),
    router:         router.toLowerCase(),
    creator:        body.creator.toLowerCase(),
    upstreamUrl:    body.upstreamUrl,
    priceUsdc:      body.priceUsdc,
    upstreamSecret: secret,
    timeoutSeconds: body.timeoutSeconds ?? 20,
    requestSchema:  body.requestSchema,
    responseSchema: body.responseSchema,
    description:    body.description,
  }).returning();

  return c.json({ id: svc.id, slug: svc.slug, router: svc.router }, 201);
});

// PATCH /api/services/:id — update price/upstream (creator auth skipped for hackathon)
app.patch('/:id', zValidator('json', updateServiceSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');

  if (body.upstreamUrl) {
    try { await assertSafeUpstream(body.upstreamUrl); }
    catch (e) { if (e instanceof SsrfError) return c.json({ error: e.message }, 422); throw e; }
  }

  const [updated] = await db.update(services)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(services.id, id))
    .returning();

  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json(updated);
});

// GET /api/services/:slug/manifest — machine-readable service description for agents
app.get('/:slug/manifest', async (c) => {
  const slug = c.req.param('slug');
  const svc = await db.query.services.findFirst({ where: eq(services.slug, slug) });
  if (!svc || !svc.active) return c.json({ error: 'Not found' }, 404);

  return c.json({
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
