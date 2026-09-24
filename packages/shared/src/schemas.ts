import { z } from 'zod';

/** Ethereum address (checksummed or lowercase, 42-char hex). */
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid Ethereum address');

/** 32-byte hex (pool ID, tx hash). */
export const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid bytes32');

// ── Service registration ───────────────────────────────────────────────────────

export const createServiceSchema = z.object({
  /** Token address (must be registered in RevpadRegistry). */
  asset:        addressSchema,
  /** Creator wallet — must match the vesting recipient of the token. */
  creator:      addressSchema,
  /** URL-safe slug (3–32 chars). Used as /s/{slug}/* base path. */
  slug:         z.string().min(3).max(32).regex(/^[a-z0-9-]+$/),
  /** Human-readable service name. */
  name:         z.string().min(1).max(80),
  /** Upstream base URL — SSRF checked at registration time. */
  upstreamUrl:  z.string().url().max(500),
  /** Default price per call in USDC (raw bigint string, 6 dec). */
  priceUsdc:    z.string().regex(/^\d+$/, 'must be a raw bigint string'),
  /** personal_sign signature from the creator wallet over the registration message. */
  signature:    z.string().regex(/^0x[0-9a-fA-F]+$/, 'hex signature'),
  /** Optional JSON schema for request body validation (stringified). */
  requestSchema:  z.string().optional(),
  /** Optional JSON schema for response body validation (stringified). */
  responseSchema: z.string().optional(),
  /** Optional gateway upstream timeout in seconds (1–60). */
  timeoutSeconds: z.number().int().min(1).max(60).optional(),
  /** Description shown to agents in the manifest. */
  description:  z.string().max(500).optional(),
});

/** Build the message that the creator must sign for service registration. */
export function serviceRegistrationMessage(slug: string, asset: string): string {
  return `Revpad: register service "${slug}" for token ${asset.toLowerCase()}`;
}

export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = z.object({
  priceUsdc:    z.string().regex(/^\d+$/).optional(),
  upstreamUrl:  z.string().url().max(500).optional(),
  timeoutSeconds: z.number().int().min(1).max(60).optional(),
  description:  z.string().max(500).optional(),
}).refine(d => Object.keys(d).length > 0, 'at least one field required');

export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
