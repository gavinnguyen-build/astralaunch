import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage, getAddress } from 'viem';
import { serviceRegistrationMessage } from '@astralaunch/shared';

// Deterministic test wallet (Anvil dev key #0 — never used on mainnet)
const CREATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const WRONG_KEY   = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

const creator = privateKeyToAccount(CREATOR_KEY);
const wrongSigner = privateKeyToAccount(WRONG_KEY);

const SLUG = 'my-service';
const ASSET = '0x1111111111111111111111111111111111111111';

describe('service registration auth', () => {
  it('message includes slug and lowercase asset', () => {
    const msg = serviceRegistrationMessage(SLUG, ASSET);
    expect(msg).toContain(SLUG);
    expect(msg).toContain(ASSET.toLowerCase());
  });

  it('valid signature passes verification', async () => {
    const msg = serviceRegistrationMessage(SLUG, ASSET);
    const sig = await creator.signMessage({ message: msg });

    const valid = await verifyMessage({
      address: getAddress(creator.address),
      message: msg,
      signature: sig,
    });
    expect(valid).toBe(true);
  });

  it('wrong signer is rejected', async () => {
    const msg = serviceRegistrationMessage(SLUG, ASSET);
    const sig = await wrongSigner.signMessage({ message: msg });

    const valid = await verifyMessage({
      address: getAddress(creator.address),
      message: msg,
      signature: sig,
    });
    expect(valid).toBe(false);
  });

  it('tampered message is rejected', async () => {
    const msg = serviceRegistrationMessage(SLUG, ASSET);
    const sig = await creator.signMessage({ message: msg });

    // Verify against a different message (different slug)
    const tamperedMsg = serviceRegistrationMessage('other-slug', ASSET);
    const valid = await verifyMessage({
      address: getAddress(creator.address),
      message: tamperedMsg,
      signature: sig,
    });
    expect(valid).toBe(false);
  });

  it('different asset produces different message', () => {
    const msg1 = serviceRegistrationMessage(SLUG, ASSET);
    const msg2 = serviceRegistrationMessage(SLUG, '0x2222222222222222222222222222222222222222');
    expect(msg1).not.toBe(msg2);
  });

  it('asset is lowercased in message for case-insensitive matching', () => {
    const msg1 = serviceRegistrationMessage(SLUG, '0xABCD1234567890ABCDEF1234567890ABCDEF1234');
    const msg2 = serviceRegistrationMessage(SLUG, '0xabcd1234567890abcdef1234567890abcdef1234');
    expect(msg1).toBe(msg2);
  });
});
