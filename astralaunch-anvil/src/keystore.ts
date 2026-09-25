// Decrypt an Ethereum V3 keystore (Web3 Secret Storage: scrypt or pbkdf2, aes-128-ctr, keccak MAC),
// the format Foundry writes to ~/.foundry/keystores/<name>. The private key stays in memory only.

import { createDecipheriv, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { scrypt } from '@noble/hashes/scrypt.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { keccak256, type Hex } from 'viem';

interface KeystoreV3 {
  crypto?: KeystoreCrypto;
  Crypto?: KeystoreCrypto;
}
interface KeystoreCrypto {
  cipher: string;
  cipherparams: { iv: string };
  ciphertext: string;
  kdf: 'scrypt' | 'pbkdf2';
  kdfparams: { dklen: number; salt: string; n?: number; r?: number; p?: number; c?: number; prf?: string };
  mac: string;
}

/** Resolve a Foundry account name (~/.foundry/keystores/<name>) or an explicit file path. */
export function keystorePath(nameOrPath: string): string {
  if (existsSync(nameOrPath)) return nameOrPath;
  const p = join(homedir(), '.foundry', 'keystores', nameOrPath);
  if (!existsSync(p)) throw new Error(`Keystore not found: ${nameOrPath} (also looked in ${p})`);
  return p;
}

export function decryptKeystore(json: string, password: string): Hex {
  const ks = JSON.parse(json) as KeystoreV3;
  const c = ks.crypto ?? ks.Crypto;
  if (!c) throw new Error('Not a V3 keystore (no crypto section)');
  if (c.cipher !== 'aes-128-ctr') throw new Error(`Unsupported cipher ${c.cipher}`);
  const kp = c.kdfparams;
  const salt = Buffer.from(kp.salt, 'hex');
  let dk: Buffer;
  if (c.kdf === 'scrypt') {
    const { n = 0, r = 0, p = 0 } = kp;
    // Pure-JS scrypt: OpenSSL (node:crypto) rejects valid params such as N=2^18 with r=1.
    dk = Buffer.from(scrypt(Buffer.from(password, 'utf8'), salt, { N: n, r, p, dkLen: kp.dklen, maxmem: 2 ** 31 }));
  } else if (c.kdf === 'pbkdf2') {
    if (kp.prf !== 'hmac-sha256') throw new Error(`Unsupported prf ${kp.prf}`);
    dk = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, kp.c ?? 0, kp.dklen, 'sha256');
  } else {
    throw new Error(`Unsupported kdf ${(c as { kdf: string }).kdf}`);
  }
  const ciphertext = Buffer.from(c.ciphertext, 'hex');
  const mac = Buffer.from(keccak256(Buffer.concat([dk.subarray(16, 32), ciphertext])).slice(2), 'hex');
  const expected = Buffer.from(c.mac, 'hex');
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new Error('Wrong keystore password (MAC mismatch)');
  }
  const decipher = createDecipheriv('aes-128-ctr', dk.subarray(0, 16), Buffer.from(c.cipherparams.iv, 'hex'));
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (key.length !== 32) throw new Error('Decrypted key has wrong length');
  return `0x${key.toString('hex')}`;
}

export function readKeystore(nameOrPath: string): string {
  return readFileSync(keystorePath(nameOrPath), 'utf8');
}
