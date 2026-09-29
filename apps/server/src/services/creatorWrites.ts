/**
 * Writes authorized by a creator signature: service registration, token metadata, and the
 * combined launch-details request (one signature for both, used by the one-transaction launch).
 * The routes only parse and map errors; the checks live here so every entry point applies the same ones.
 */
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import {
  hasLaunchMetadata, launchDetailsMessage,
  type CreateServiceInput, type LaunchDetailsInput, type TokenMetadataInput,
} from '@astralaunch/shared';
import { services, tokens, type Service, type Token } from '../db/schema.js';
import { assertSafeUpstream } from '../lib/ssrf.js';
import { upstreamBaseError } from '../lib/upstream.js';
import { compileResponseSchema } from '../lib/responseSchema.js';
import { generateSecret } from '../lib/hmac.js';
import { authorizeTokenCreator, consumeSignedMessage, ServiceAuthError } from './serviceAuth.js';
import type { Db } from './launchFee.js';

export type ServiceFields = Omit<CreateServiceInput, 'asset' | 'issuedAt' | 'signature'>;
export type MetadataFields = Pick<TokenMetadataInput, 'imageUrl' | 'xHandle' | 'website' | 'description'>;

/** Static checks on a service definition (no network): upstream base URL and response schema. */
export function serviceInputError(s: Pick<ServiceFields, 'upstreamUrl' | 'responseSchema'>): string | null {
  const bad = upstreamBaseError(s.upstreamUrl);
  if (bad) return bad;
  if (s.responseSchema) {
    try { compileResponseSchema(s.responseSchema); } catch (e) { return (e as Error).message; }
  }
  return null;
}

/** Insert a service for `token` (router and creator from the chain-indexed row, never the client). 409 on a taken slug. */
export async function insertService(tx: Db, token: Token, s: ServiceFields, issuedAt: number): Promise<Service> {
  const existing = await tx.select({ id: services.id }).from(services).where(eq(services.slug, s.slug)).limit(1);
  if (existing[0]) throw new ServiceAuthError(409, 'Slug already taken');
  const [row] = await tx.insert(services).values({
    slug:           s.slug,
    name:           s.name,
    asset:          token.asset,
    router:         token.router,
    creator:        token.creator,
    upstreamUrl:    s.upstreamUrl,
    priceUsdc:      s.priceUsdc,
    upstreamSecret: generateSecret(),
    timeoutSeconds: s.timeoutSeconds ?? 20,
    requestSchema:  s.requestSchema,
    responseSchema: s.responseSchema,
    description:    s.description,
    examplePath:    s.examplePath,
    authSignedAt:   BigInt(issuedAt),
  }).returning();
  return row!;
}

/** Update display metadata; monotonic in issuedAt (a concurrent older signed update loses with 409). */
export async function applyTokenMetadata(tx: Db, asset: string, m: MetadataFields, issuedAt: number): Promise<void> {
  const [row] = await tx.update(tokens).set({
    ...(m.imageUrl    !== undefined && { imageUrl:    m.imageUrl }),
    ...(m.xHandle     !== undefined && { xHandle:     m.xHandle.replace(/^@/, '') }),
    ...(m.website     !== undefined && { website:     m.website }),
    ...(m.description !== undefined && { description: m.description }),
    metadataSignedAt: BigInt(issuedAt),
  })
    .where(and(eq(tokens.asset, asset),
      or(isNull(tokens.metadataSignedAt), lt(tokens.metadataSignedAt, BigInt(issuedAt)))))
    .returning({ asset: tokens.asset });
  if (!row) throw new ServiceAuthError(409, 'A newer signed request was already accepted (issuedAt too old)');
}

export class LaunchDetailsInputError extends Error {}

export interface LaunchDetailsResult {
  asset: string;
  metadataUpdated: boolean;
  service: { id: string; slug: string; router: string } | null;
}

/**
 * POST /api/tokens/launch-details: one creator signature over metadata + service.
 * Same rules as the two separate requests: signer = on-chain creator, fresh issuedAt, no replay,
 * a service needs a listed token and a safe upstream, metadata is monotonic in issuedAt.
 * All-or-nothing: both writes and the replay record commit in one transaction.
 */
export async function applyLaunchDetails(db: Db, body: LaunchDetailsInput, nowS: number): Promise<LaunchDetailsResult> {
  const asset = body.asset.toLowerCase();
  const { signature, ...signed } = body;
  const message = launchDetailsMessage(signed);
  const withMetadata = hasLaunchMetadata(body);

  if (body.service) {
    const bad = serviceInputError(body.service);
    if (bad) throw new LaunchDetailsInputError(bad);
  }

  const [existing] = await db.select({ metadataSignedAt: tokens.metadataSignedAt }).from(tokens).where(eq(tokens.asset, asset)).limit(1);
  const token = await authorizeTokenCreator(db, {
    asset, message, signature, issuedAt: body.issuedAt, nowS,
    lastIssuedAt: withMetadata ? existing?.metadataSignedAt ?? null : null,
    requireListed: body.service !== undefined,
  });
  if (body.service) await assertSafeUpstream(body.service.upstreamUrl);

  return db.transaction(async (tx) => {
    await consumeSignedMessage(tx, message, token.creator, 'launch_details', body.issuedAt);
    if (withMetadata) await applyTokenMetadata(tx, asset, body, body.issuedAt);
    const svc = body.service ? await insertService(tx, token, body.service, body.issuedAt) : null;
    return {
      asset,
      metadataUpdated: withMetadata,
      service: svc ? { id: svc.id, slug: svc.slug, router: svc.router } : null,
    };
  });
}
