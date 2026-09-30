/**
 * The only way the server calls a creator's API (gateway, link check, probes).
 * - Public https only, unless the origin is trusted (UPSTREAM_ALLOWLIST / ALLOW_LOCAL_UPSTREAMS; lib/ssrf.ts).
 * - DNS is checked at CONNECT time inside the socket's own lookup, so the address that was checked is the
 *   address that is used (no DNS-rebinding window); private IP literals are refused before connecting.
 * - Redirects are never followed (the gateway rewrites or refuses them); bodies are not decompressed, so bytes
 *   pass through exactly as the upstream sent them.
 * - Connecting to the checked address never changes who we talk to: Host and the TLS servername (SNI) stay the link's
 *   hostname, and the certificate is verified against that hostname.
 * - A default User-Agent / Accept is sent when the caller did not send one (some APIs, e.g. behind Cloudflare, refuse
 *   requests without a User-Agent).
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { blockIpLiteral, isBlockedAddress, SsrfError, upstreamPolicy } from './ssrf.js';

export interface UpstreamRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer | null;
  /** Time allowed until the response headers arrive. */
  headersTimeoutMs: number;
  signal?: AbortSignal;
}

export interface UpstreamResponse {
  status: number;
  headers: Headers;
  body: Readable;
}

export const DEFAULT_USER_AGENT = 'Astralaunch-Gateway/1.0 (+https://astralaunch.xyz)';
export const DEFAULT_ACCEPT = 'application/json, */*';

/** The caller's headers plus a User-Agent / Accept when missing (names compared case-insensitively). */
export function withDefaultHeaders(headers: Record<string, string>): Record<string, string> {
  const has = (name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name);
  return { ...(has('user-agent') ? {} : { 'user-agent': DEFAULT_USER_AGENT }), ...(has('accept') ? {} : { accept: DEFAULT_ACCEPT }), ...headers };
}

export type UpstreamErrorKind = 'unsafe' | 'timeout' | 'unreachable' | 'aborted';
export class UpstreamError extends Error {
  constructor(readonly kind: UpstreamErrorKind, message: string) { super(message); this.name = 'UpstreamError'; }
}

/** net lookup that refuses private/loopback/link-local results (all records must be public). */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs: LookupAddress[]) => {
    if (err) return callback(err, '', 0);
    const bad = addrs.find((a) => isBlockedAddress(a.address));
    if (bad) return callback(new SsrfError(`resolves to a private address`), '', 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addrs);
    callback(null, addrs[0]!.address, addrs[0]!.family);
  });
};

function toHeaders(res: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
  }
  return h;
}

export function upstreamRequest(req: UpstreamRequest): Promise<UpstreamResponse> {
  const { url } = req;
  const policy = upstreamPolicy(url.origin);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !policy.httpsRequired)) {
    return Promise.reject(new UpstreamError('unsafe', 'only public https links are allowed'));
  }
  if (!policy.allowPrivate) {
    try { blockIpLiteral(url.hostname.replace(/^\[|\]$/g, '')); } catch { return Promise.reject(new UpstreamError('unsafe', 'private address')); }
  }
  return new Promise((resolve, reject) => {
    const https = url.protocol === 'https:';
    const send = https ? httpsRequest : httpRequest;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const r = send(url, {
      method: req.method,
      // Host: from the URL (callers never pass one; the gateway strips the agent's). SNI: the hostname, not the IP
      // we connect to (an IP literal gets none, as TLS requires); the certificate is checked against it.
      headers: { ...withDefaultHeaders(req.headers), host: url.host, ...(req.body ? { 'content-length': String(req.body.byteLength) } : {}) },
      ...(https ? { rejectUnauthorized: true, ...(isIP(hostname) ? {} : { servername: hostname }) } : {}),
      ...(policy.allowPrivate ? {} : { lookup: guardedLookup }),
      signal: req.signal,
    }, (res) => {
      clearTimeout(timer);
      resolve({ status: res.statusCode ?? 0, headers: toHeaders(res), body: res });
    });
    const timer = setTimeout(() => r.destroy(new UpstreamError('timeout', 'upstream timed out')), req.headersTimeoutMs);
    r.on('error', (e: Error) => {
      clearTimeout(timer);
      if (e instanceof UpstreamError) return reject(e);
      if (e instanceof SsrfError) return reject(new UpstreamError('unsafe', 'private address'));
      if (e.name === 'AbortError') return reject(new UpstreamError('aborted', 'aborted'));
      reject(new UpstreamError('unreachable', (e as NodeJS.ErrnoException).code ?? 'network error'));
    });
    if (req.body && req.body.byteLength) r.end(req.body); else r.end();
  });
}

/** Read a body fully, up to `maxBytes` and until `deadline` (ms epoch). Throws on either limit. */
export async function readBody(body: Readable, maxBytes: number, deadlineMs: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  const left = deadlineMs - Date.now();
  if (left <= 0) { body.destroy(); throw new UpstreamError('timeout', 'upstream timed out'); }
  const timer = setTimeout(() => body.destroy(new UpstreamError('timeout', 'upstream timed out')), left);
  try {
    for await (const chunk of body) {
      n += (chunk as Buffer).byteLength;
      if (n > maxBytes) { body.destroy(); throw new UpstreamError('unreachable', 'response too large'); }
      chunks.push(chunk as Buffer);
    }
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError('unreachable', 'response interrupted');
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

/** Read at most `maxBytes` (then stop); for samples. */
export async function readPrefix(body: Readable, maxBytes: number, deadlineMs: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let n = 0;
  const timer = setTimeout(() => body.destroy(), Math.max(1, deadlineMs - Date.now()));
  try {
    for await (const chunk of body) {
      chunks.push(chunk as Buffer);
      n += (chunk as Buffer).byteLength;
      if (n > maxBytes) { body.destroy(); return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), truncated: true }; }
    }
  } catch { /* partial read is fine for a sample */ } finally {
    clearTimeout(timer);
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}
