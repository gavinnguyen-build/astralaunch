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

/**
 * Why a service's example call path is unusable (null = ok). It is one real request relative to the
 * gateway (/s/{slug}), e.g. "/signals?handle=monad": starts with "/", no whitespace, fragment, backslash,
 * encoded slash or dot segment, so it can only address the service's own endpoints.
 */
export function examplePathError(p: string): string | null {
  if (!/^\/[^\s#\\]*$/.test(p) || p.startsWith('//')) return 'examplePath must start with "/" and contain no spaces, "#" or "\\"';
  if (/%2f|%5c/i.test(p)) return 'examplePath must not contain encoded slashes';
  const segs = p.split('?')[0]!.split('/');
  let decoded: string[];
  try { decoded = segs.map((s) => decodeURIComponent(s)); } catch { return 'examplePath has invalid percent-encoding'; }
  if (decoded.some((s) => s === '.' || s === '..')) return 'examplePath must not contain "." or ".." segments';
  return null;
}
const examplePathSchema = z.string().max(300).superRefine((p, ctx) => {
  const e = examplePathError(p);
  if (e) ctx.addIssue({ code: z.ZodIssueCode.custom, message: e });
});

/** Header names the creator's API key may NOT use (the gateway owns them). */
const RESERVED_HEADER_RE = /^(host|content-length|content-type|transfer-encoding|connection|cookie|x-astralaunch-.*|payment-.*|x-payment.*|x-forwarded-.*|forwarded)$/i;
const apiKeyHeaderSchema = z.string().max(64).regex(/^[A-Za-z0-9-]+$/, 'header name: letters, digits and "-"')
  .refine((h) => !RESERVED_HEADER_RE.test(h), 'this header name is reserved by the gateway');

/** "One API link" fields (packages/shared/src/serviceLink.ts). The API key value is stored encrypted and never returned. */
/** Max size of a sample request's JSON body (UTF-8 bytes). */
export const SAMPLE_BODY_MAX_BYTES = 16 * 1024;

/** Why a sample request body is unusable (null = ok): valid JSON, at most 16 KB. */
export function sampleBodyError(body: string): string | null {
  if (new TextEncoder().encode(body).byteLength > SAMPLE_BODY_MAX_BYTES) return `The sample body is larger than ${SAMPLE_BODY_MAX_BYTES / 1024} KB.`;
  try { JSON.parse(body); } catch { return 'The sample body must be valid JSON.'; }
  return null;
}
const sampleBodySchema = z.string().min(1).superRefine((b, ctx) => {
  const e = sampleBodyError(b);
  if (e) ctx.addIssue({ code: z.ZodIssueCode.custom, message: e });
});

const linkFields = {
  /** The link the creator already uses to call their API; upstream origin, prefix and examplePath are derived from it. */
  apiLink:      z.string().url().max(2000).optional(),
  /** Allow every path of the link's domain (prefix "/") instead of the link's directory. */
  wholeDomain:  z.boolean().optional(),
  /** Optional API key the gateway adds to every forwarded call: header name + value. */
  apiKeyHeader: apiKeyHeaderSchema.optional(),
  apiKeyValue:  z.string().min(1).max(2000).optional(),
  /**
   * Optional sample request (Advanced): method and, for POST, a JSON body. Used by the link check and by the token
   * page's "Try a sample call" on the pasted link's path. Without it the link is checked with a plain GET.
   */
  sampleMethod: z.enum(['GET', 'POST']).optional(),
  sampleBody:   sampleBodySchema.optional(),
};

const serviceFields = {
  /** URL-safe slug (3–32 chars). Used as /s/{slug}/* base path. */
  slug:           z.string().min(3).max(32).regex(/^[a-z0-9-]+$/),
  /** Human-readable service name. */
  name:           z.string().min(1).max(80),
  /** Upstream base URL (legacy; new services send apiLink instead). SSRF checked at registration/update time. */
  upstreamUrl:    z.string().url().max(500).optional(),
  /** Price per call in USDC (raw bigint string, 6 dec). */
  priceUsdc:      z.string().regex(/^\d+$/, 'must be a raw bigint string'),
  /** Optional JSON schema for request body validation (stringified). */
  requestSchema:  z.string().max(20_000).optional(),
  /** Optional JSON schema for response body validation (stringified). */
  responseSchema: z.string().max(20_000).optional(),
  /** Optional gateway upstream timeout in seconds (1–120). */
  timeoutSeconds: z.number().int().min(1).max(120).optional(),
  /** Description shown to agents in the manifest. */
  description:    z.string().max(500).optional(),
  /** Optional sample request relative to /s/{slug}, e.g. "/signals?handle=monad" (the page's "Try a sample call"). */
  examplePath:    examplePathSchema.optional(),
  ...linkFields,
};

/** Create / launch-details service: exactly one of apiLink (new) or upstreamUrl (legacy); key header and value together. */
const serviceRefinements = <T extends z.ZodTypeAny>(schema: T) => schema
  .refine((d: { apiLink?: string; upstreamUrl?: string }) => (d.apiLink === undefined) !== (d.upstreamUrl === undefined),
    'send either apiLink or upstreamUrl')
  .refine((d: { apiLink?: string; examplePath?: string; wholeDomain?: boolean }) => d.apiLink !== undefined || d.wholeDomain === undefined,
    'wholeDomain needs apiLink')
  .refine((d: { apiLink?: string; examplePath?: string }) => d.apiLink === undefined || d.examplePath === undefined,
    'examplePath is derived from apiLink; do not send both')
  .refine((d: { apiKeyHeader?: string; apiKeyValue?: string }) => (d.apiKeyHeader === undefined) === (d.apiKeyValue === undefined),
    'apiKeyHeader and apiKeyValue go together')
  .refine((d: { apiLink?: string; sampleMethod?: string }) => d.sampleMethod === undefined || d.apiLink !== undefined,
    'a sample request needs apiLink')
  .refine((d: { sampleMethod?: string; sampleBody?: string }) => d.sampleBody === undefined || d.sampleMethod === 'POST',
    'a sample body needs sampleMethod POST');

const signedFields = {
  /** Unix seconds when signed; must be recent. Each signed message is accepted once. */
  issuedAt:  z.number().int().positive(),
  /** personal_sign by the token's on-chain creator over the service message. */
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'hex signature'),
};

export const createServiceSchema = serviceRefinements(z.object({
  /** Token address (must be registered on-chain, indexed, and listed). */
  asset: addressSchema,
  ...serviceFields,
  ...signedFields,
}));

export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = z.object({
  priceUsdc:      serviceFields.priceUsdc.optional(),
  upstreamUrl:    serviceFields.upstreamUrl.optional(),
  timeoutSeconds: serviceFields.timeoutSeconds,
  description:    serviceFields.description,
  /** New example call path; "" removes it. */
  examplePath:    z.union([z.literal(''), examplePathSchema]).optional(),
  /** New API link (re-derives upstream, prefix and examplePath; re-runs the link check). */
  apiLink:        linkFields.apiLink,
  wholeDomain:    linkFields.wholeDomain,
  /** New API key header + value; apiKeyHeader "" removes the key. */
  apiKeyHeader:   z.union([z.literal(''), apiKeyHeaderSchema]).optional(),
  apiKeyValue:    linkFields.apiKeyValue,
  /** New sample request; sampleMethod "" removes it (the link is checked with a plain GET again). */
  sampleMethod:   z.union([z.literal(''), z.enum(['GET', 'POST'])]).optional(),
  sampleBody:     linkFields.sampleBody,
  /** New response JSON schema (stringified); "" removes it (responses are no longer checked). */
  responseSchema: z.union([z.literal(''), z.string().min(1).max(20_000)]).optional(),
  ...signedFields,
}).refine(
  d => d.priceUsdc !== undefined || d.upstreamUrl !== undefined || d.timeoutSeconds !== undefined || d.description !== undefined
    || d.examplePath !== undefined || d.apiLink !== undefined || d.wholeDomain !== undefined || d.apiKeyHeader !== undefined
    || d.sampleMethod !== undefined || d.responseSchema !== undefined,
  'at least one field required',
).refine(d => !(d.apiLink !== undefined && d.upstreamUrl !== undefined), 'send either apiLink or upstreamUrl')
  .refine(d => !(d.apiLink !== undefined && d.examplePath !== undefined), 'examplePath is derived from apiLink; do not send both')
  .refine(d => d.wholeDomain === undefined || d.apiLink !== undefined, 'wholeDomain needs apiLink')
  .refine(d => (d.apiKeyHeader === undefined || d.apiKeyHeader === '') === (d.apiKeyValue === undefined),
    'apiKeyHeader and apiKeyValue go together ("" header removes the key)')
  .refine(d => d.sampleBody === undefined || d.sampleMethod === 'POST', 'a sample body needs sampleMethod POST');

export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

/** JSON with keys in the given order, undefined fields omitted. */
function canonical(obj: Record<string, unknown>, keys: readonly string[]): string {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return JSON.stringify(out);
}

// examplePath was added later: a message without it is byte-for-byte the same as before (canonical()
// omits undefined fields), so earlier signed messages stay valid.
// apiLink / wholeDomain / apiKeyHeader / apiKeyValue ("one API link" model) likewise: absent → identical message.
// responseSchema on an update (D-SV4) likewise.
const CREATE_KEYS = ['asset', 'slug', 'name', 'upstreamUrl', 'priceUsdc', 'requestSchema',
  'responseSchema', 'timeoutSeconds', 'description', 'examplePath', 'apiLink', 'wholeDomain', 'apiKeyHeader', 'apiKeyValue', 'sampleMethod', 'sampleBody', 'issuedAt'] as const;
const UPDATE_KEYS = ['serviceId', 'asset', 'priceUsdc', 'upstreamUrl', 'timeoutSeconds',
  'description', 'examplePath', 'apiLink', 'wholeDomain', 'apiKeyHeader', 'apiKeyValue', 'sampleMethod', 'sampleBody', 'responseSchema', 'issuedAt'] as const;

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

// ── Service settings (POST /api/services/:id/settings) ────────────────────────
// Creator-only READ of the private service settings (the pasted link, the protect secret, the protection status).
// Signed like the writes so that no public endpoint returns the upstream link or any secret. Not single-use:
// it may be re-sent within SERVICE_AUTH_MAX_AGE_S.

export const serviceSettingsSchema = z.object({ ...signedFields });
export type ServiceSettingsInput = z.infer<typeof serviceSettingsSchema>;

/** Message the token creator signs to view service `serviceId`'s private settings. */
export function serviceSettingsMessage(serviceId: string, asset: string, issuedAt: number): string {
  return `Astralaunch: view service settings\n${JSON.stringify({ serviceId, asset: asset.toLowerCase(), issuedAt })}`;
}

// ── Link check (POST /api/services/check) ────────────────────────────────────
export const linkCheckSchema = z.object({
  apiLink:      z.string().min(1).max(2000),
  wholeDomain:  z.boolean().optional(),
  apiKeyHeader: apiKeyHeaderSchema.optional(),
  apiKeyValue:  z.string().min(1).max(2000).optional(),
  sampleMethod: z.enum(['GET', 'POST']).optional(),
  sampleBody:   sampleBodySchema.optional(),
}).refine((d) => (d.apiKeyHeader === undefined) === (d.apiKeyValue === undefined), 'apiKeyHeader and apiKeyValue go together')
  .refine((d) => d.sampleBody === undefined || d.sampleMethod === 'POST', 'a sample body needs sampleMethod POST');

// ── Token metadata (POST /api/tokens) ──────────────────────────────────────────
// Tokens themselves come from the indexer (on-chain Registered event). This only
// updates off-chain display metadata, signed by the token's on-chain creator.

/** Max clock skew / age for a signed metadata update, in seconds (same window as services). */
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

const TOKEN_METADATA_KEYS = ['asset', 'imageUrl', 'xHandle', 'website', 'description', 'issuedAt'] as const;

/** Message the token creator signs: header + canonical JSON of every provided field and issuedAt. */
export function tokenMetadataMessage(m: Omit<TokenMetadataInput, 'signature'>): string {
  return `Astralaunch: update token metadata\n${canonical({
    ...m,
    asset:   m.asset.toLowerCase(),
    xHandle: m.xHandle?.replace(/^@/, ''),
  }, TOKEN_METADATA_KEYS)}`;
}

// ── Launch details (POST /api/tokens/launch-details) ──────────────────────────
// One creator signature for the token's display metadata AND its service, so the
// launch flow needs a single signature. The single-purpose messages above
// (tokenMetadataMessage, serviceCreateMessage) remain valid and unchanged.

const launchServiceSchema = serviceRefinements(z.object(serviceFields));

export const launchDetailsSchema = z.object({
  asset:       addressSchema,
  imageUrl:    z.string().url().max(500).optional(),
  xHandle:     z.string().regex(/^@?[A-Za-z0-9_]{1,15}$/, 'Invalid X handle').optional(),
  website:     z.string().url().max(500).optional(),
  description: z.string().max(500).optional(),
  /** Optional service to register for the token (same fields as POST /api/services). */
  service:     launchServiceSchema.optional(),
  ...signedFields,
}).refine(
  d => d.service !== undefined || d.imageUrl !== undefined || d.xHandle !== undefined
    || d.website !== undefined || d.description !== undefined,
  'metadata or service required',
);

export type LaunchDetailsInput = z.infer<typeof launchDetailsSchema>;

const LAUNCH_DETAILS_KEYS = ['asset', 'imageUrl', 'xHandle', 'website', 'description', 'service', 'issuedAt'] as const;
const LAUNCH_SERVICE_KEYS = ['slug', 'name', 'upstreamUrl', 'priceUsdc', 'requestSchema',
  'responseSchema', 'timeoutSeconds', 'description', 'examplePath', 'apiLink', 'wholeDomain', 'apiKeyHeader', 'apiKeyValue', 'sampleMethod', 'sampleBody'] as const;

/** Message the token creator signs once for metadata + service: header + canonical JSON (nested service canonical too). */
export function launchDetailsMessage(m: Omit<LaunchDetailsInput, 'signature'>): string {
  const service = m.service ? JSON.parse(canonical(m.service, LAUNCH_SERVICE_KEYS)) as Record<string, unknown> : undefined;
  return `Astralaunch: launch details\n${canonical({
    ...m,
    asset:   m.asset.toLowerCase(),
    xHandle: m.xHandle?.replace(/^@/, ''),
    service,
  }, LAUNCH_DETAILS_KEYS)}`;
}

/** True if the launch-details request carries any display metadata. */
export function hasLaunchMetadata(m: Pick<LaunchDetailsInput, 'imageUrl' | 'xHandle' | 'website' | 'description'>): boolean {
  return m.imageUrl !== undefined || m.xHandle !== undefined || m.website !== undefined || m.description !== undefined;
}
