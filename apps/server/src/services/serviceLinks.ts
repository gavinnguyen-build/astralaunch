/**
 * "One API link" service operations: derive upstream / prefix / examplePath from the pasted link, run the attach
 * check, build the headers the gateway adds on every forwarded call, and manage the per-service secrets.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { parseApiLink, PROTECT_HEADER, SIGNATURE_HEADER } from '@astralaunch/shared';
import { services, type Service } from '../db/schema.js';
import { signRequest } from '../lib/hmac.js';
import { buildUpstreamUrl } from '../lib/upstream.js';
import { gatewayLimits } from '../lib/proxy.js';
import { upstreamPolicy } from '../lib/ssrf.js';
import { decryptSecret, encryptSecret } from '../lib/secretBox.js';
import { checkLink, type LinkCheck, type SampleRequest } from './linkCheck.js';
import type { Db } from './launchFee.js';

/** A link or its check was refused: 400 = malformed input, 422 = the API did not pass the check. */
export class ServiceLinkError extends Error {
  constructor(readonly status: 400 | 422, message: string, readonly check?: LinkCheck) { super(message); }
}

export interface LinkInput {
  apiLink: string; wholeDomain?: boolean; apiKeyHeader?: string; apiKeyValue?: string;
  /** Sample request (Advanced); absent = plain GET on the link. */
  sampleMethod?: 'GET' | 'POST'; sampleBody?: string;
}

/** Columns written for a service whose link passed the check. `id` is fixed up front so the API key can be bound to it. */
export interface PreparedLink {
  id: string;
  upstreamUrl: string; examplePath: string; apiLink: string; wholeDomain: boolean;
  apiKeyHeader: string | null; apiKeyEnc: string | null;
  /** null = no sample call (the link is reachable but needs a request body we do not know). */
  responseKind: string | null; responseContentType: string | null; responseSample: string | null; linkCheckedAt: Date;
  sampleMethod: 'GET' | 'POST' | null; sampleBody: string | null;
  check: Extract<LinkCheck, { ok: true }>;
}

/** Parse + scheme policy only (no network). */
export function parseLinkOrThrow(input: Pick<LinkInput, 'apiLink' | 'wholeDomain'>) {
  const p = parseApiLink(input.apiLink, { wholeDomain: input.wholeDomain });
  if (!p.ok) throw new ServiceLinkError(400, p.error);
  const policy = upstreamPolicy(p.link.origin);
  if (policy.httpsRequired && !input.apiLink.trim().startsWith('https://')) {
    throw new ServiceLinkError(400, 'The link must start with https:// (public https addresses only).');
  }
  return p.link;
}

/** URL of a sample call: upstream base + examplePath, confined to the prefix. */
export function exampleTarget(upstreamUrl: string, examplePath: string | null): URL | null {
  const ep = examplePath ?? '/';
  const q = ep.indexOf('?');
  return buildUpstreamUrl(upstreamUrl, q >= 0 ? ep.slice(0, q) : ep, q >= 0 ? ep.slice(q) : '');
}

/**
 * Validate the link, call it once (with the gateway's headers when the service already exists), and return the
 * columns to store. Throws ServiceLinkError with a human-readable message when the link or the check fails.
 */
export async function prepareServiceLink(
  input: LinkInput,
  existing?: Pick<Service, 'id' | 'upstreamSecret' | 'protectSecret' | 'apiKeyHeader' | 'apiKeyEnc'> | null,
): Promise<PreparedLink> {
  const link = parseLinkOrThrow(input);
  const id = existing?.id ?? randomUUID();
  const target = exampleTarget(link.upstreamUrl, link.examplePath);
  if (!target) throw new ServiceLinkError(400, 'The link path is not usable.');

  // Key for the check: the new one if sent, else the stored one (update without a key change).
  let apiKey: { header: string; value: string } | null = null;
  if (input.apiKeyHeader && input.apiKeyValue) apiKey = { header: input.apiKeyHeader, value: input.apiKeyValue };
  else if (existing?.apiKeyHeader && existing.apiKeyEnc) apiKey = { header: existing.apiKeyHeader, value: decryptSecret(existing.apiKeyEnc, existing.id) };
  const headers: Record<string, string> = {};
  if (existing) Object.assign(headers, gatewayHeaders({ upstreamSecret: existing.upstreamSecret, protectSecret: existing.protectSecret }, Buffer.alloc(0)));
  if (apiKey) headers[apiKey.header.toLowerCase()] = apiKey.value;

  const sample: SampleRequest | null = input.sampleMethod ? { method: input.sampleMethod, body: input.sampleMethod === 'POST' ? input.sampleBody ?? null : null } : null;
  const check = await checkLink(target, headers, gatewayLimits().timeoutS, sample);
  if (!check.ok) throw new ServiceLinkError(422, check.error, check);

  const newKey = input.apiKeyHeader && input.apiKeyValue;
  return {
    id,
    upstreamUrl: link.upstreamUrl, examplePath: link.examplePath, apiLink: input.apiLink.trim(), wholeDomain: !!input.wholeDomain,
    apiKeyHeader: newKey ? input.apiKeyHeader! : existing?.apiKeyHeader ?? null,
    apiKeyEnc: newKey ? encryptSecret(input.apiKeyValue!, id) : existing?.apiKeyEnc ?? null,
    responseKind: check.kind, responseContentType: check.contentType, responseSample: check.sample, linkCheckedAt: new Date(),
    sampleMethod: sample?.method ?? null, sampleBody: sample?.body ?? null,
    check,
  };
}

/**
 * The public sample call for a service ("Try a sample call", manifest), or null when there is none:
 * link services need a checked response (null kind = reachable but no sample); legacy services keep a GET examplePath.
 */
export function publicSample(svc: Pick<Service, 'apiLink' | 'examplePath' | 'responseKind' | 'sampleMethod' | 'sampleBody'>):
  { method: 'GET' | 'POST'; path: string; body: string | null } | null {
  if (!svc.examplePath) return null;
  if (svc.apiLink && !svc.responseKind) return null;
  const method = svc.sampleMethod === 'POST' ? 'POST' : 'GET';
  return { method, path: svc.examplePath, body: method === 'POST' ? svc.sampleBody ?? null : null };
}

/** Headers the gateway adds on every forwarded call: the plain shared secret and the HMAC signature (legacy). */
export function gatewayHeaders(svc: Pick<Service, 'upstreamSecret' | 'protectSecret'>, body: Buffer): Record<string, string> {
  return {
    ...(svc.protectSecret ? { [PROTECT_HEADER]: svc.protectSecret } : {}),
    [SIGNATURE_HEADER]: signRequest(svc.upstreamSecret, body),
  };
}

export const newProtectSecret = () => `as_${randomBytes(24).toString('base64url')}`;

/** The service's protect secret, generated and stored on first use (services from before 0012 have none). */
export async function ensureProtectSecret(db: Db, svc: Service): Promise<string> {
  if (svc.protectSecret) return svc.protectSecret;
  const secret = newProtectSecret();
  const [row] = await db.update(services).set({ protectSecret: secret }).where(eq(services.id, svc.id)).returning({ s: services.protectSecret });
  svc.protectSecret = row?.s ?? secret;
  return svc.protectSecret;
}

/** Decrypted API key for forwarding, or null. */
export function apiKeyFor(svc: Pick<Service, 'id' | 'apiKeyHeader' | 'apiKeyEnc'>): { header: string; value: string } | null {
  if (!svc.apiKeyHeader || !svc.apiKeyEnc) return null;
  return { header: svc.apiKeyHeader, value: decryptSecret(svc.apiKeyEnc, svc.id) };
}
