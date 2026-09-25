import { describe, it, expect } from 'vitest';
import { serviceCreateMessage, serviceUpdateMessage, createServiceSchema } from '@astralaunch/shared';

const BASE = {
  asset: '0xABCD1234567890ABCDEF1234567890ABCDEF1234', slug: 'my-service', name: 'My service',
  upstreamUrl: 'https://api.example.com', priceUsdc: '1000', issuedAt: 1_800_000_000,
};

describe('service auth messages', () => {
  it('binds every field: changing any one changes the message', () => {
    const msg = serviceCreateMessage(BASE);
    const variants: Record<string, unknown>[] = [
      { slug: 'other-slug' }, { name: 'x' }, { upstreamUrl: 'https://evil.example.com' }, { priceUsdc: '1' },
      { issuedAt: 1_800_000_001 }, { description: 'd' }, { timeoutSeconds: 5 }, { requestSchema: '{}' },
      { responseSchema: '{}' }, { asset: '0x2222222222222222222222222222222222222222' },
    ];
    for (const v of variants) expect(serviceCreateMessage({ ...BASE, ...v })).not.toBe(msg);
  });

  it('asset is case-insensitive; key order of the input does not matter', () => {
    const reordered = { issuedAt: BASE.issuedAt, priceUsdc: BASE.priceUsdc, upstreamUrl: BASE.upstreamUrl,
      name: BASE.name, slug: BASE.slug, asset: BASE.asset.toLowerCase() };
    expect(serviceCreateMessage(reordered)).toBe(serviceCreateMessage(BASE));
  });

  it('multi-line field values cannot forge other fields (canonical JSON)', () => {
    const a = serviceCreateMessage({ ...BASE, description: 'hi"\n,"priceUsdc":"1' });
    expect(a.split('\n')).toHaveLength(2);
    expect(JSON.parse(a.split('\n')[1]!).priceUsdc).toBe('1000');
  });

  it('update message binds service id and asset', () => {
    const m = { priceUsdc: '5', issuedAt: 1_800_000_000 };
    const msg = serviceUpdateMessage('svc-1', BASE.asset, m);
    expect(serviceUpdateMessage('svc-2', BASE.asset, m)).not.toBe(msg);
    expect(serviceUpdateMessage('svc-1', '0x2222222222222222222222222222222222222222', m)).not.toBe(msg);
    expect(serviceCreateMessage(BASE).startsWith('Astralaunch: register service')).toBe(true);
    expect(msg.startsWith('Astralaunch: update service')).toBe(true);
  });

  it('client-supplied creator is not part of the schema', () => {
    const parsed = createServiceSchema.parse({ ...BASE, creator: '0x2222222222222222222222222222222222222222', signature: '0x00' });
    expect('creator' in parsed).toBe(false);
  });
});
