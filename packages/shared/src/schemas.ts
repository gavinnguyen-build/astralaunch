import { z } from 'zod';

/** Ethereum address (checksummed or lowercase, 42-char hex). */
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid Ethereum address');

/** 32-byte hex (pool ID, tx hash). */
export const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid bytes32');

// ── Service registration / update (creator-signed, D-SV1) ─────────────────────
// Both requests are signed (personal_sign) by the token's ON-CHAIN creator, as
// recorded by the indexer. The message is a fixed header plus canonical JSON of
// every provided field and issuedAt, so no field can be changed after signing.

/** Max clock skew / age for a signed service request, in seconds. */
export const SERVICE_AUTH_MAX_AGE_S = 600;

const serviceFields = {
  /** URL-safe slug (3–32 chars). Used as /s/{slug}/* base path. */
  slug:           z.string().min(3).max(32).regex(/^[a-z0-9-]+$/),
  /** Human-readable service name. */
  name:           z.string().min(1).max(80),
  /** Upstream base URL — SSRF checked at registration/update time. */
  upstreamUrl:    z.string().url().max(500),
  /** Price per call in USDC (raw bigint string, 6 dec). */
  priceUsdc:      z.string().regex(/^\d+$/, 'must be a raw bigint string'),
  /** Optional JSON schema for request body validation (stringified). */
  requestSchema:  z.string().max(20_000).optional(),
  /** Optional JSON schema for response body validation (stringified). */
  responseSchema: z.string().max(20_000).optional(),
  /** Optional gateway upstream timeout in seconds (1–60). */
  timeoutSeconds: z.number().int().min(1).max(60).optional(),
  /** Description shown to agents in the manifest. */
  description:    z.string().max(500).optional(),
};

const signedFields = {
  /** Unix seconds when signed; must be recent. Each signed message is accepted once. */
  issuedAt:  z.number().int().positive(),
  /** personal_sign by the token's on-chain creator over the service message. */
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'hex signature'),
};

export const createServiceSchema = z.object({
  /** Token address (must be registered on-chain, indexed, and listed). */
  asset: addressSchema,
  ...serviceFields,
  ...signedFields,
});

export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = z.object({
  priceUsdc:      serviceFields.priceUsdc.optional(),
  upstreamUrl:    serviceFields.upstreamUrl.optional(),
  timeoutSeconds: serviceFields.timeoutSeconds,
  description:    serviceFields.description,
  ...signedFields,
}).refine(
  d => d.priceUsdc !== undefined || d.upstreamUrl !== undefined || d.timeoutSeconds !== undefined || d.description !== undefined,
  'at least one field required',
);

export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

/** JSON with keys in the given order, undefined fields omitted. */
function canonical(obj: Record<string, unknown>, keys: readonly string[]): string {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return JSON.stringify(out);
}

const CREATE_KEYS = ['asset', 'slug', 'name', 'upstreamUrl', 'priceUsdc', 'requestSchema',
  'responseSchema', 'timeoutSeconds', 'description', 'issuedAt'] as const;
const UPDATE_KEYS = ['serviceId', 'asset', 'priceUsdc', 'upstreamUrl', 'timeoutSeconds',
  'description', 'issuedAt'] as const;

/** Message the token creator signs to register a service. */
export function serviceCreateMessage(m: Omit<CreateServiceInput, 'signature'>): string {
  return `Astralaunch: register service\n${canonical({ ...m, asset: m.asset.toLowerCase() }, CREATE_KEYS)}`;
}

/** Message the token creator signs to update service `serviceId` of token `asset`. */
export function serviceUpdateMessage(
  serviceId: string, asset: string, m: Omit<UpdateServiceInput, 'signature'>,
): string {
  return `Astralaunch: update service\n${canonical({ ...m, serviceId, asset: asset.toLowerCase() }, UPDATE_KEYS)}`;
}

// ── Token metadata (POST /api/tokens) ──────────────────────────────────────────
// Tokens themselves come from the indexer (on-chain Registered event). This only
// updates off-chain display metadata, signed by the token's on-chain creator.

/** Max clock skew / age for a signed metadata update, in seconds. */
export const TOKEN_METADATA_MAX_AGE_S = 600;

export const tokenMetadataSchema = z.object({
  asset:       addressSchema,
  imageUrl:    z.string().url().max(500).optional(),
  /** X (Twitter) handle, with or without leading @. */
  xHandle:     z.string().regex(/^@?[A-Za-z0-9_]{1,15}$/, 'Invalid X handle').optional(),
  website:     z.string().url().max(500).optional(),
  description: z.string().max(500).optional(),
  /** Unix seconds when signed; must be recent and newer than the last accepted update. */
  issuedAt:    z.number().int().positive(),
  /** personal_sign by the token creator over tokenMetadataMessage(...). */
  signature:   z.string().regex(/^0x[0-9a-fA-F]+$/, 'hex signature'),
}).refine(
  d => d.imageUrl !== undefined || d.xHandle !== undefined || d.website !== undefined || d.description !== undefined,
  'at least one metadata field required',
);

export type TokenMetadataInput = z.infer<typeof tokenMetadataSchema>;

/** Message the creator signs; binds every provided field, the asset and issuedAt. */
export function tokenMetadataMessage(m: Omit<TokenMetadataInput, 'signature'>): string {
  const lines = [`Astralaunch: update metadata for token ${m.asset.toLowerCase()}`];
  if (m.imageUrl    !== undefined) lines.push(`image: ${m.imageUrl}`);
  if (m.xHandle     !== undefined) lines.push(`x: ${m.xHandle.replace(/^@/, '')}`);
  if (m.website     !== undefined) lines.push(`website: ${m.website}`);
  if (m.description !== undefined) lines.push(`description: ${m.description}`);
  lines.push(`issuedAt: ${m.issuedAt}`);
  return lines.join('\n');
}
