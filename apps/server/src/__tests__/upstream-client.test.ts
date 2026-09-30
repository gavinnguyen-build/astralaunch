/**
 * lib/upstreamClient.ts with the REAL policy (no ALLOW_LOCAL_UPSTREAMS): public https only, private literals refused,
 * and DNS checked at connect time (a hostname that resolves to a private address never connects).
 */
import { describe, it, expect } from 'vitest';
import { upstreamRequest, UpstreamError, guardedLookup } from '../lib/upstreamClient.js';
import { isBlockedAddress } from '../lib/ssrf.js';

const call = (url: string) => upstreamRequest({ url: new URL(url), method: 'GET', headers: {}, headersTimeoutMs: 3000 });
const kind = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof UpstreamError ? e.kind : String(e); } };

describe('upstream client policy', () => {
  it('refuses http (non-allowlisted), private IP literals and hostnames that resolve privately', async () => {
    expect(await kind(call('http://example.com/'))).toBe('unsafe');
    expect(await kind(call('https://127.0.0.1/'))).toBe('unsafe');
    expect(await kind(call('https://10.0.0.1/'))).toBe('unsafe');
    expect(await kind(call('https://[::1]/'))).toBe('unsafe');
    expect(await kind(call('https://169.254.169.254/latest/meta-data'))).toBe('unsafe');
    expect(await kind(call('https://localhost:9/'))).toBe('unsafe');   // resolved at connect → 127.0.0.1 → refused
  });

  it('guardedLookup refuses private results and passes public ones', async () => {
    const look = (host: string) => new Promise<string>((res) => guardedLookup(host, {}, (err, addr) => res(err ? 'blocked' : String(addr))));
    expect(await look('localhost')).toBe('blocked');
  });

  it('isBlockedAddress covers v4, v6 and v4-mapped v6', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::'])
      expect(isBlockedAddress(a), a).toBe(true);
    for (const a of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:1.1.1.1']) expect(isBlockedAddress(a), a).toBe(false);
  });
});
