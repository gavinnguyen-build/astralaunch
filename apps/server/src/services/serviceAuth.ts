/**
 * Creator-signed requests: service create/update and token metadata (docs/decisions.md D-SV1).
 *
 * The signer must be the token's ON-CHAIN creator, taken from the tokens row the
 * indexer writes from the Registered event, never from the request body.
 * Checks, in order: token registered (404), token listed (403), issuedAt fresh
 * and newer than the last accepted request (400/409), signer == creator (403).
 * Each accepted message is recorded in signed_requests so it can't be replayed (409).
 */
import { eq } from 'drizzle-orm';
import { getAddress, keccak256, toHex, verifyMessage, type Hex } from 'viem';
import { SERVICE_AUTH_MAX_AGE_S } from '@astralaunch/shared';
import { signedRequests, tokens, type Token } from '../db/schema.js';
import { isAssetListed, type Db } from './launchFee.js';

export class ServiceAuthError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

export interface CreatorAuthInput {
  asset:     string;
  message:   string;
  signature: string;
  issuedAt:  number;
  nowS:      number;
  /** issuedAt of the last accepted request for the target (updates only). */
  lastIssuedAt?: bigint | null;
  /** Services require a listed token; token metadata may be prepared while unlisted. Default true. */
  requireListed?: boolean;
}

/** Returns the token row if the request is signed by its on-chain creator; throws ServiceAuthError otherwise. */
export async function authorizeTokenCreator(db: Db, a: CreatorAuthInput): Promise<Token> {
  const asset = a.asset.toLowerCase();
  const [token] = await db.select().from(tokens).where(eq(tokens.asset, asset)).limit(1);
  if (!token) throw new ServiceAuthError(404, 'Token is not registered on-chain (or not indexed yet).');
  if ((a.requireListed ?? true) && !(await isAssetListed(db, asset))) {
    throw new ServiceAuthError(403, 'Token is not listed: its launch fee has not been paid and consumed. Services can only be registered for listed tokens.');
  }
  if (Math.abs(a.nowS - a.issuedAt) > SERVICE_AUTH_MAX_AGE_S) {
    throw new ServiceAuthError(400, `issuedAt must be within ${SERVICE_AUTH_MAX_AGE_S}s of server time`);
  }
  if (a.lastIssuedAt != null && BigInt(a.issuedAt) <= a.lastIssuedAt) {
    throw new ServiceAuthError(409, 'A newer signed request was already accepted (issuedAt too old)');
  }

  let valid = false;
  try {
    valid = await verifyMessage({ address: getAddress(token.creator), message: a.message, signature: a.signature as Hex });
  } catch { /* malformed signature */ }
  if (!valid) throw new ServiceAuthError(403, 'Request must be signed by the token\'s on-chain creator');
  return token;
}

/**
 * Record a signed message as used. Call inside the same transaction as the write it
 * authorizes; throws 409 if the exact message was already accepted (replay).
 */
export async function consumeSignedMessage(
  tx: Db, message: string, signer: string, purpose: 'service_create' | 'service_update' | 'token_metadata' | 'launch_details', issuedAt: number,
): Promise<void> {
  const [row] = await tx.insert(signedRequests).values({
    messageHash: keccak256(toHex(message)),
    signer:      signer.toLowerCase(),
    purpose,
    issuedAt:    BigInt(issuedAt),
  }).onConflictDoNothing().returning({ h: signedRequests.messageHash });
  if (!row) throw new ServiceAuthError(409, 'This signed request was already used (replay rejected). Sign a new request.');
}
