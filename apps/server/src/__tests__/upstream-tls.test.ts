/**
 * lib/upstreamClient.ts on the connect-time DNS path (guardedLookup, the production path): connecting to the checked
 * IP must not change who we talk to. A local https upstream with a certificate for api.astra.test; DNS for
 * *.astra.test answers 127.0.0.1 and the private-address check is relaxed for that one address, so the real
 * guardedLookup → connect → TLS path runs. The upstream records the Host header and the SNI it received.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, globalAgent, type Server } from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { AddressInfo } from 'node:net';

vi.mock('node:dns', async (orig) => {
  const dns = await orig<typeof import('node:dns')>();
  const lookup = ((host: string, opts: object, cb: (e: Error | null, a: unknown, f?: number) => void) => {
    if (!host.endsWith('.astra.test')) return (dns.lookup as unknown as (...a: unknown[]) => void)(host, opts, cb);
    const a = { address: '127.0.0.1', family: 4 };
    (opts as { all?: boolean }).all ? cb(null, [a]) : cb(null, a.address, a.family);
  }) as unknown as typeof dns.lookup;
  return { ...dns, default: { ...dns, lookup }, lookup };
});
vi.mock('../lib/ssrf.js', async (orig) => {
  const m = await orig<typeof import('../lib/ssrf.js')>();
  return { ...m, isBlockedAddress: (a: string) => a !== '127.0.0.1' && m.isBlockedAddress(a) };
});

const { upstreamRequest, UpstreamError, DEFAULT_USER_AGENT, DEFAULT_ACCEPT } = await import('../lib/upstreamClient.js');

interface Seen { host?: string; sni: string | false | null; ua?: string; accept?: string }
const seen: Seen[] = [];
let server: Server;
let port = 0;
let dir = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'astra-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=api.astra.test',
    '-addext', 'subjectAltName=DNS:api.astra.test', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const cert = readFileSync(join(dir, 'cert.pem'));
  server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
    seen.push({ host: req.headers.host, sni: (req.socket as TLSSocket).servername, ua: req.headers['user-agent'], accept: req.headers.accept });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  globalAgent.options.ca = cert;   // trust this one self-signed certificate (verification itself stays on)
});

afterAll(async () => {
  delete globalAgent.options.ca;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const call = (host: string, headers: Record<string, string> = {}) =>
  upstreamRequest({ url: new URL(`https://${host}:${port}/v1/ping`), method: 'GET', headers, headersTimeoutMs: 5000 });

describe('upstream client: Host, SNI and certificate on the pinned connection', () => {
  it('connects to the resolved IP but sends the original Host and SNI; default User-Agent and Accept', async () => {
    seen.length = 0;
    const res = await call('api.astra.test');
    res.body.destroy();
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ host: `api.astra.test:${port}`, sni: 'api.astra.test', ua: DEFAULT_USER_AGENT, accept: DEFAULT_ACCEPT }]);
    expect(DEFAULT_USER_AGENT).toBe('Astralaunch-Gateway/1.0 (+https://astralaunch.xyz)');
    expect(DEFAULT_ACCEPT).toBe('application/json, */*');
  });

  it("the caller's User-Agent and Accept win (any letter case)", async () => {
    seen.length = 0;
    (await call('api.astra.test', { 'User-Agent': 'agent/2', Accept: 'text/plain' })).body.destroy();
    expect(seen[0]).toMatchObject({ ua: 'agent/2', accept: 'text/plain' });
  });

  it('the certificate is verified against the original hostname: a name it does not cover is refused', async () => {
    seen.length = 0;
    const err = await call('other.astra.test').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as InstanceType<typeof UpstreamError>).kind).toBe('unreachable');
    expect(seen).toEqual([]);   // no request was sent
  });
});
