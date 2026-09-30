/**
 * "One API link" model, pure parts: link parsing, prefix enforcement, header stripping, redirect rewriting,
 * streaming detection, the settlement rule, the payment window, encrypted API keys.
 */
import { describe, it, expect } from 'vitest';
import { parseApiLink, agentLink, agentExampleUrl, protectSnippets, PROTECT_HEADER } from '@astralaunch/shared';
import { buildUpstreamUrl } from '../lib/upstream.js';
import {
  forwardRequestHeaders, responseHeaders, rewriteLocation, isStreamedResponse, settlementFor, paymentWindowS, scrubUpstream,
} from '../lib/proxy.js';
import { encryptSecret, decryptSecret, deriveKey } from '../lib/secretBox.js';
import { exampleTarget } from '../services/serviceLinks.js';

const ok = (raw: string, wholeDomain = false) => {
  const r = parseApiLink(raw, { wholeDomain });
  if (!r.ok) throw new Error(r.error);
  return r.link;
};

describe('parseApiLink', () => {
  it('directory of the pasted path is the prefix; the rest + query is the example', () => {
    expect(ok('https://myagent.ai/v1/ask?q=hello')).toEqual({
      origin: 'https://myagent.ai', prefix: '/v1/', upstreamUrl: 'https://myagent.ai/v1', examplePath: '/ask?q=hello',
    });
    expect(ok('https://api.myagent.ai/ask')).toEqual({
      origin: 'https://api.myagent.ai', prefix: '/', upstreamUrl: 'https://api.myagent.ai', examplePath: '/ask',
    });
    expect(ok('https://x.ai/a/b/c/')).toMatchObject({ prefix: '/a/b/c/', examplePath: '/' });
    expect(ok('https://x.ai')).toMatchObject({ prefix: '/', upstreamUrl: 'https://x.ai', examplePath: '/' });
    expect(ok('https://x.ai:8443/v2/run?a=1&a=2')).toMatchObject({ origin: 'https://x.ai:8443', examplePath: '/run?a=1&a=2' });
  });

  it('"Open the whole domain" = prefix "/", the full path becomes the example', () => {
    expect(ok('https://myagent.ai/v1/ask?q=hello', true)).toEqual({
      origin: 'https://myagent.ai', prefix: '/', upstreamUrl: 'https://myagent.ai', examplePath: '/v1/ask?q=hello',
    });
  });

  it('human-readable errors for unusable links', () => {
    const err = (raw: string) => { const r = parseApiLink(raw); return r.ok ? null : r.error; };
    expect(err('')).toMatch(/Paste the link/);
    expect(err('myagent.ai/v1')).toMatch(/not a valid link/);
    expect(err('ftp://x.ai/a')).toMatch(/https/);
    expect(err('https://u:p@x.ai/a')).toMatch(/user name/);
    expect(err('https://x.ai/a#frag')).toMatch(/#/);
    expect(err('https://x.ai/a%2Fb')).toMatch(/encoded slashes/);
    expect(err(`https://x.ai/${'a'.repeat(2100)}`)).toMatch(/too long/);
  });

  it('agent links', () => {
    expect(agentLink('https://api.astralaunch.xyz/', 'myagent')).toBe('https://api.astralaunch.xyz/s/myagent/');
    expect(agentExampleUrl('https://api.astralaunch.xyz', 'myagent', '/ask?q=hello')).toBe('https://api.astralaunch.xyz/s/myagent/ask?q=hello');
  });
});

describe('prefix enforcement', () => {
  const link = ok('https://myagent.ai/v1/ask?q=hello');
  it('calls stay inside the prefix', () => {
    expect(buildUpstreamUrl(link.upstreamUrl, '/ask', '?q=1')?.toString()).toBe('https://myagent.ai/v1/ask?q=1');
    expect(buildUpstreamUrl(link.upstreamUrl, '/deep/path', '')?.toString()).toBe('https://myagent.ai/v1/deep/path');
    expect(buildUpstreamUrl(link.upstreamUrl, '/../admin', '')).toBeNull();
    expect(buildUpstreamUrl(link.upstreamUrl, '/%2e%2e/admin', '')).toBeNull();
    expect(buildUpstreamUrl(link.upstreamUrl, '/a%2F..%2F..%2Fadmin', '')).toBeNull();
    expect(buildUpstreamUrl(link.upstreamUrl, '/..\\admin', '')).toBeNull();
    expect(buildUpstreamUrl(link.upstreamUrl, '//evil.example/x', '')?.origin).toBe('https://myagent.ai');
  });
  it('the example target is the pasted link itself', () => {
    expect(exampleTarget(link.upstreamUrl, link.examplePath)?.toString()).toBe('https://myagent.ai/v1/ask?q=hello');
    const whole = ok('https://myagent.ai/v1/ask?q=hello', true);
    expect(exampleTarget(whole.upstreamUrl, whole.examplePath)?.toString()).toBe('https://myagent.ai/v1/ask?q=hello');
  });
});

describe('request headers', () => {
  const incoming = new Headers({
    'content-type': 'multipart/form-data; boundary=x', accept: 'text/event-stream', 'x-session-id': 'sess-1',
    authorization: 'Bearer agent-own', cookie: 'gw=1', host: 'api.astralaunch.xyz', 'x-forwarded-for': '1.2.3.4',
    'cf-connecting-ip': '1.2.3.4', 'payment-signature': 'p', 'x-payment': 'p', 'x-astralaunch-secret': 'forged',
    'content-length': '9', connection: 'keep-alive', 'x-api-key': 'agent-tries-to-set-it',
  });
  it('forwards safe agent headers (sessions, content type, their auth); drops payment, proxy, cookie, hop-by-hop', () => {
    const out = forwardRequestHeaders(incoming, { gateway: { [PROTECT_HEADER]: 'sec', 'X-Astralaunch-Signature': 'sig' } });
    expect(out).toMatchObject({ 'content-type': 'multipart/form-data; boundary=x', accept: 'text/event-stream', 'x-session-id': 'sess-1', authorization: 'Bearer agent-own' });
    for (const k of ['cookie', 'host', 'x-forwarded-for', 'cf-connecting-ip', 'payment-signature', 'x-payment', 'content-length', 'connection']) expect(out[k], k).toBeUndefined();
    expect(out['x-astralaunch-secret']).toBe('sec');   // the forged value is replaced by the gateway's
  });
  it('the creator API key wins over an agent header of the same name', () => {
    const out = forwardRequestHeaders(incoming, { apiKey: { header: 'X-Api-Key', value: 'creator-key' }, gateway: {} });
    expect(out['x-api-key']).toBe('creator-key');
  });
});

describe('response headers and redirects', () => {
  const ctx = { upstreamBase: 'https://myagent.ai/v1', gatewayBase: 'https://api.astralaunch.xyz/s/myagent' };
  const req = new URL('https://myagent.ai/v1/ask');
  it('strips fingerprinting, cookies, CORS and hop-by-hop; keeps content headers and custom session ids', () => {
    const h = responseHeaders(new Headers({
      server: 'nginx/1.2', 'x-powered-by': 'Express', via: '1.1 vegur', 'x-amz-request-id': 'r', 'cf-ray': 'c', 'set-cookie': 'a=b',
      'access-control-allow-origin': '*', 'transfer-encoding': 'chunked', 'x-vercel-id': 'v',
      'content-type': 'image/png', 'content-disposition': 'attachment; filename="a.png"', 'x-session-id': 'sess-2', etag: '"e"',
    }), ctx, req);
    expect([...h.keys()].sort()).toEqual(['content-disposition', 'content-type', 'etag', 'x-session-id']);
  });
  it('rewrites Location inside the prefix to the gateway; drops it outside; keeps a foreign https URL', () => {
    expect(rewriteLocation('/v1/jobs/42?x=1', ctx, req)).toBe('https://api.astralaunch.xyz/s/myagent/jobs/42?x=1');
    expect(rewriteLocation('https://myagent.ai/v1/next', ctx, req)).toBe('https://api.astralaunch.xyz/s/myagent/next');
    expect(rewriteLocation('other', ctx, req)).toBe('https://api.astralaunch.xyz/s/myagent/other');   // relative to /v1/ask
    expect(rewriteLocation('/admin', ctx, req)).toBeNull();
    expect(rewriteLocation('https://myagent.ai/internal', ctx, req)).toBeNull();
    expect(rewriteLocation('https://cdn.example.com/f.png?sig=1', ctx, req)).toBe('https://cdn.example.com/f.png?sig=1');
    expect(rewriteLocation('http://cdn.example.com/f.png', ctx, req)).toBeNull();
    const h = responseHeaders(new Headers({ location: '/v1/done' }), ctx, req);
    expect(h.get('location')).toBe('https://api.astralaunch.xyz/s/myagent/done');
  });
  it('errors never carry the upstream host', () => {
    expect(scrubUpstream('failed at https://myagent.ai/v1/x (myagent.ai)', 'https://myagent.ai/v1')).toBe('failed at <upstream>/v1/x (<upstream>)');
  });
});

describe('streaming and the settlement rule', () => {
  it('streamed = SSE, or chunked non-JSON; JSON and sized bodies are buffered', () => {
    expect(isStreamedResponse(new Headers({ 'content-type': 'text/event-stream' }))).toBe(true);
    expect(isStreamedResponse(new Headers({ 'content-type': 'text/event-stream', 'content-length': '10' }))).toBe(true);
    expect(isStreamedResponse(new Headers({ 'content-type': 'text/plain' }))).toBe(true);            // chunked
    expect(isStreamedResponse(new Headers({ 'content-type': 'application/json' }))).toBe(false);     // chunked JSON: buffered
    expect(isStreamedResponse(new Headers({ 'content-type': 'application/vnd.api+json' }))).toBe(false);
    expect(isStreamedResponse(new Headers({ 'content-type': 'image/png', 'content-length': '100' }))).toBe(false);
  });
  it('non-2xx is never charged; streams settle before the body; buffered after (schema only if declared)', () => {
    for (const s of [100, 204 - 5, 301, 302, 400, 404, 429, 500, 503]) expect(settlementFor(s, true, true).charge, String(s)).toBe(false);
    expect(settlementFor(200, true, true)).toEqual({ charge: true, when: 'before_body' });
    expect(settlementFor(200, false, true)).toEqual({ charge: true, when: 'after_body', schemaCheck: true });
    expect(settlementFor(201, false, false)).toEqual({ charge: true, when: 'after_body', schemaCheck: false });
  });
  it('payment window covers the upstream timeout, within [PAYMENT_TIMEOUT_SECONDS, 300]', () => {
    expect(paymentWindowS(60, 120)).toBe(150);
    expect(paymentWindowS(60, 20)).toBe(60);
    expect(paymentWindowS(200, 20)).toBe(200);
    expect(paymentWindowS(60, 600)).toBe(300);
  });
});

describe('encrypted API keys', () => {
  const key = deriveKey('11'.repeat(32));
  it('round-trips, never stores the plaintext, and uses a fresh nonce each time', () => {
    const a = encryptSecret('sk-live-123', 'svc-1', key);
    const b = encryptSecret('sk-live-123', 'svc-1', key);
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain('sk-live-123');
    expect(a).not.toBe(b);
    expect(decryptSecret(a, 'svc-1', key)).toBe('sk-live-123');
  });
  it('fails for another service, a tampered value, or another master key', () => {
    const a = encryptSecret('sk-live-123', 'svc-1', key);
    expect(() => decryptSecret(a, 'svc-2', key)).toThrow();
    const raw = Buffer.from(a.slice(3), 'base64url'); raw[raw.length - 1] ^= 1;
    expect(() => decryptSecret(`v1:${raw.toString('base64url')}`, 'svc-1', key)).toThrow();
    expect(() => decryptSecret(a, 'svc-1', deriveKey('22'.repeat(32)))).toThrow();
    expect(() => deriveKey('')).toThrow(/GATEWAY_HMAC_MASTER_KEY/);
  });
});

describe('protect-your-API snippets', () => {
  it('Node, Python and Cloudflare Worker snippets all check the secret header', () => {
    const s = protectSnippets('as_secret123');
    expect(s.map((x) => x.label)).toEqual(['Node / Express', 'Python / FastAPI', 'Cloudflare Worker']);
    for (const x of s) { expect(x.code.toLowerCase()).toContain('x-astralaunch-secret'); expect(x.code).toContain('401'); }
  });
});
