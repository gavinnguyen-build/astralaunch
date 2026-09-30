/**
 * Encryption at rest for creator API keys (services.api_key_enc). AES-256-GCM, random 96-bit nonce per value,
 * key = HKDF-SHA256(GATEWAY_HMAC_MASTER_KEY, info "astralaunch/service-api-key/v1"). The service id is the
 * additional authenticated data, so a ciphertext copied to another service's row does not decrypt.
 * Format: "v1:" + base64url(nonce ‖ tag ‖ ciphertext). Values are never returned by any endpoint.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const INFO = 'astralaunch/service-api-key/v1';

/** 32-byte key derived from the master key (hex or any string). */
export function deriveKey(masterKey: string): Buffer {
  if (!masterKey) throw new Error('GATEWAY_HMAC_MASTER_KEY is required to store API keys');
  const ikm = /^[0-9a-f]{64}$/i.test(masterKey) ? Buffer.from(masterKey, 'hex') : Buffer.from(masterKey, 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), INFO, 32));
}

const defaultKey = () => deriveKey(process.env.GATEWAY_HMAC_MASTER_KEY ?? '');

export function encryptSecret(plain: string, serviceId: string, key: Buffer = defaultKey()): string {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(serviceId));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([nonce, c.getAuthTag(), ct]).toString('base64url')}`;
}

/** Throws if the value was tampered with, belongs to another service, or the master key changed. */
export function decryptSecret(box: string, serviceId: string, key: Buffer = defaultKey()): string {
  if (!box.startsWith('v1:')) throw new Error('unknown secret format');
  const raw = Buffer.from(box.slice(3), 'base64url');
  if (raw.length < 12 + 16) throw new Error('secret too short');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(serviceId));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
