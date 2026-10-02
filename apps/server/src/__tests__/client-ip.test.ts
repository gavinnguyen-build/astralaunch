/**
 * Client IP for rate limits comes only from our trusted proxy (Traefik): the rightmost X-Forwarded-For
 * entry with TRUSTED_PROXY_HOPS=1, else the socket. CF-Connecting-IP / X-Real-IP / forged XFF prefixes
 * never change the bucket.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

process.env.TRUSTED_PROXY_HOPS = '1';
process.env.TRUSTED_PROXY_CIDRS = '10.0.0.0/8,172.16.0.0/12';
process.env.IMAGE_UPLOADS_PER_10MIN = '2';

vi.mock('../db/client.js', () => ({ db: {} }));
const { parseTrustedProxy, resolveClientIp } = await import('../lib/rateLimit.js');
const uploads = (await import('../routes/uploads.js')).default;

describe('resolveClientIp', () => {
  const one = parseTrustedProxy({ TRUSTED_PROXY_HOPS: '1' });
  const none = parseTrustedProxy({});
  it('no proxy: always the socket address, headers ignored', () => {
    expect(resolveClientIp('198.51.100.9', '1.2.3.4', none)).toBe('198.51.100.9');
    expect(resolveClientIp('::ffff:198.51.100.9', undefined, none)).toBe('198.51.100.9');
  });
  it('one trusted proxy: the rightmost X-Forwarded-For entry; forged prefixes ignored', () => {
    expect(resolveClientIp('10.0.1.2', '203.0.113.7', one)).toBe('203.0.113.7');
    expect(resolveClientIp('10.0.1.2', '1.1.1.1, 9.9.9.9, 203.0.113.7', one)).toBe('203.0.113.7');
    expect(resolveClientIp('10.0.1.2', 'garbage, 203.0.113.7', one)).toBe('203.0.113.7');
  });
  it('missing or malformed proxy entry falls back to the peer, never to a client header', () => {
    expect(resolveClientIp('10.0.1.2', undefined, one)).toBe('10.0.1.2');
    expect(resolveClientIp('10.0.1.2', '203.0.113.7, not-an-ip', one)).toBe('10.0.1.2');
  });
  it('TRUSTED_PROXY_CIDRS: X-Forwarded-For only from a peer inside the ranges', () => {
    const cfg = parseTrustedProxy({ TRUSTED_PROXY_HOPS: '1', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' });
    expect(resolveClientIp('10.0.1.2', '203.0.113.7', cfg)).toBe('203.0.113.7');
    expect(resolveClientIp('198.51.100.9', '203.0.113.7', cfg)).toBe('198.51.100.9');   // direct client: XFF ignored
  });
  it('config validation', () => {
    for (const bad of [{ TRUSTED_PROXY_HOPS: '-1' }, { TRUSTED_PROXY_HOPS: 'x' }, { TRUSTED_PROXY_CIDRS: '10.0.0.0/99' }, { TRUSTED_PROXY_CIDRS: 'nope' }]) {
      expect(() => parseTrustedProxy(bad)).toThrow(/TRUSTED_PROXY/);
    }
  });
});

describe('upload rate limit buckets (max 2 per window)', () => {
  const app = new Hono();
  app.route('/api/uploads', uploads);
  const via = (peer: string, headers: Record<string, string>) => app.request('/api/uploads/token-image',
    { method: 'POST', headers, body: '<svg/>' }, { incoming: { socket: { remoteAddress: peer } } });

  it('forged CF-Connecting-IP / X-Real-IP / X-Forwarded-For prefixes stay in the real client bucket', async () => {
    const real = '203.0.113.7';
    const statuses = [];
    for (const forged of [
      { 'x-forwarded-for': real },
      { 'x-forwarded-for': `1.1.1.1, ${real}`, 'cf-connecting-ip': '5.5.5.5' },
      { 'x-forwarded-for': `2.2.2.2, 3.3.3.3, ${real}`, 'x-real-ip': '6.6.6.6', 'true-client-ip': '7.7.7.7' },
    ]) statuses.push((await via('10.0.1.2', forged)).status);
    expect(statuses).toEqual([415, 415, 429]);   // 2 allowed (rejected as SVG), the 3rd is limited
    // a different real client still has its own bucket
    expect((await via('10.0.1.2', { 'x-forwarded-for': '1.1.1.1, 198.51.100.20' })).status).toBe(415);
  });
});
