import { createHmac, randomBytes } from 'node:crypto';

/** Generate a random 32-byte hex secret for a service. */
export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Compute X-Revpad-Signature header value.
 * Format: `t={timestamp};v1={hex_mac}`
 * MAC = HMAC-SHA256(secret, `{timestamp}.{bodyHex}`)
 *
 * Provider verifies by recomputing with the pre-shared secret.
 */
export function signRequest(secret: string, body: Buffer | string): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHex = Buffer.isBuffer(body) ? body.toString('hex') : Buffer.from(body).toString('hex');
  const mac = createHmac('sha256', secret).update(`${ts}.${bodyHex}`).digest('hex');
  return `t=${ts};v1=${mac}`;
}
