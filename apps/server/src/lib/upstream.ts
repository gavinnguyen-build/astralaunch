/**
 * Upstream URL handling for the gateway. A service's upstreamUrl may carry a path prefix
 * (e.g. http://127.0.0.1:4001/sight); every call is confined to that prefix:
 *   upstreamUrl http://h:4001/sight + /s/{slug}/signals?x=1 → http://h:4001/sight/signals?x=1
 * The incoming URL is already dot-segment normalised by the URL parser; encoded slashes and
 * backslashes are refused so no upstream can decode its way out of the prefix.
 */

/** Why an upstreamUrl cannot be stored (null = ok). Query, fragment and credentials are refused. */
export function upstreamBaseError(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'upstreamUrl is not a URL'; }
  if (u.username || u.password) return 'upstreamUrl must not contain credentials';
  if (u.search || raw.includes('?')) return 'upstreamUrl must not contain a query string';
  if (u.hash || raw.includes('#')) return 'upstreamUrl must not contain a fragment';
  if (/%2f|%5c|\\/i.test(u.pathname)) return 'upstreamUrl path must not contain encoded slashes or backslashes';
  return null;
}

/** Path prefix of an upstreamUrl without a trailing slash ('' for a bare origin). */
export const upstreamPrefix = (base: string) => new URL(base).pathname.replace(/\/+$/, '');

/**
 * Target URL for a gateway call, or null when the request path is refused or would leave the
 * service's prefix. `rest` is the request path after /s/{slug} ('' or starting with '/').
 */
export function buildUpstreamUrl(base: string, rest: string, search: string): URL | null {
  if (rest !== '' && !rest.startsWith('/')) return null;
  if (/%2f|%5c|\\/i.test(rest)) return null;
  const b = new URL(base);
  const prefix = upstreamPrefix(base);
  const target = new URL(b.origin);
  target.pathname = `${prefix}${rest || '/'}`;
  target.search = search;
  if (target.origin !== b.origin) return null;
  if (prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) return null;
  return target;
}
