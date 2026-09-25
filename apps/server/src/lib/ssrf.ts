import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** RFC1918/loopback/link-local CIDR ranges that must never be upstream targets. */
const BLOCKED_CIDRS: Array<[bigint, bigint, string]> = [
  // IPv4
  [ip4('127.0.0.0'),   ip4('127.255.255.255'), 'loopback'],
  [ip4('10.0.0.0'),    ip4('10.255.255.255'),  'RFC1918'],
  [ip4('172.16.0.0'),  ip4('172.31.255.255'),  'RFC1918'],
  [ip4('192.168.0.0'), ip4('192.168.255.255'), 'RFC1918'],
  [ip4('169.254.0.0'), ip4('169.254.255.255'), 'link-local'],
  [ip4('100.64.0.0'),  ip4('100.127.255.255'), 'CGNAT'],
  [ip4('0.0.0.0'),     ip4('0.255.255.255'),   'this-network'],
];

function ip4(s: string): bigint {
  return s.split('.').reduce((acc, n) => (acc << 8n) | BigInt(n), 0n);
}

function isBlockedIpv4(addr: string): boolean {
  const n = ip4(addr);
  return BLOCKED_CIDRS.some(([lo, hi]) => n >= lo && n <= hi);
}

function isBlockedIpv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  // ::1 loopback, link-local fe80::/10, site-local fc00::/7
  if (lower === '::1') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe81:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  return false;
}

/** Block plain IP literals that are private (before DNS resolution). */
function blockIpLiteral(hostname: string): void {
  const v4 = isIP(hostname);
  if (v4 === 4 && isBlockedIpv4(hostname)) throw new SsrfError(`Blocked IP: ${hostname}`);
  if (v4 === 6 && isBlockedIpv6(hostname)) throw new SsrfError(`Blocked IPv6: ${hostname}`);
}

/**
 * Validate `rawUrl` as a safe upstream target.
 * - Must use https: or http: scheme.
 * - Hostname must not be a private/loopback IP.
 * - Resolves DNS and checks all returned A/AAAA records.
 *
 * @throws SsrfError if the URL is unsafe.
 */
/**
 * ALLOW_LOCAL_UPSTREAMS=true bypasses SSRF for loopback/private IPs.
 * Only for testing against Anvil forks. Never set on mainnet/staging.
 */
const ALLOW_LOCAL = process.env.ALLOW_LOCAL_UPSTREAMS === 'true';

/**
 * UPSTREAM_ALLOWLIST: comma-separated exact origins (scheme://host:port) that skip the private-IP
 * check, e.g. "http://127.0.0.1:4001" for demo-services on the same host (D-DS1). Only these exact
 * origins; every other private/loopback target stays blocked. Empty by default.
 */
export function upstreamAllowlist(raw = process.env.UPSTREAM_ALLOWLIST ?? ''): Set<string> {
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean).map(s => new URL(s).origin));
}
const ALLOWLIST = upstreamAllowlist();

export async function assertSafeUpstream(rawUrl: string): Promise<void> {
  if (ALLOW_LOCAL) return; // bypass for local testing

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError('Invalid URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SsrfError(`Disallowed scheme: ${parsed.protocol}`);
  }

  if (ALLOWLIST.has(parsed.origin)) return; // operator-allowlisted exact origin

  const hostname = parsed.hostname;

  // Block IP literals immediately (no DNS needed)
  blockIpLiteral(hostname);

  // Resolve and block private addresses
  try {
    const records = await lookup(hostname, { all: true, family: 0 });
    for (const r of records) {
      if (r.family === 4 && isBlockedIpv4(r.address)) throw new SsrfError(`Resolved to private IPv4: ${r.address}`);
      if (r.family === 6 && isBlockedIpv6(r.address)) throw new SsrfError(`Resolved to private IPv6: ${r.address}`);
    }
  } catch (e) {
    if (e instanceof SsrfError) throw e;
    throw new SsrfError(`DNS resolution failed: ${(e as Error).message}`);
  }
}

export class SsrfError extends Error {
  constructor(msg: string) { super(msg); this.name = 'SsrfError'; }
}
