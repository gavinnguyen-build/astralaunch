/**
 * "One API link" service model. The creator pastes the link they already use to call their API
 * (e.g. https://myagent.ai/v1/ask?q=hello); everything else is derived:
 *   upstream origin  https://myagent.ai
 *   allowed prefix   /v1/            (the directory of the pasted path; "/" with "Open the whole domain")
 *   examplePath      /ask?q=hello    (the rest of the path + query, relative to the agent link)
 *   agent link       https://api.astralaunch.xyz/s/<slug>/   (+ examplePath for the sample call)
 * The gateway stores upstreamUrl = origin + prefix (without the trailing slash) and confines every call to it.
 */

export interface ParsedApiLink {
  origin: string;
  /** Allowed path prefix, always ending in "/" ("/" = whole domain). */
  prefix: string;
  /** Gateway upstream base: origin + prefix without the trailing slash (e.g. https://myagent.ai/v1). */
  upstreamUrl: string;
  /** Sample call relative to the agent link, starting with "/" (e.g. "/ask?q=hello"). */
  examplePath: string;
}

export type ParseApiLinkResult = { ok: true; link: ParsedApiLink } | { ok: false; error: string };

export const MAX_API_LINK_LENGTH = 2000;

/** Parse a pasted API link. Human-readable errors. Scheme policy (https / allowlist) is enforced by the server. */
export function parseApiLink(raw: string, opts: { wholeDomain?: boolean } = {}): ParseApiLinkResult {
  const s = raw.trim();
  if (!s) return { ok: false, error: 'Paste the link you use to call your API.' };
  if (s.length > MAX_API_LINK_LENGTH) return { ok: false, error: `The link is too long (max ${MAX_API_LINK_LENGTH} characters).` };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, error: 'This is not a valid link. It should start with https://' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'The link must start with https://' };
  if (u.username || u.password) return { ok: false, error: 'Remove the user name / password from the link. Use the API key option instead.' };
  if (u.hash) return { ok: false, error: 'Remove the "#…" part from the link.' };
  if (/%2f|%5c|\\/i.test(u.pathname)) return { ok: false, error: 'The link path must not contain encoded slashes or backslashes.' };
  const segs = u.pathname.split('/');
  let decoded: string[];
  try { decoded = segs.map((x) => decodeURIComponent(x)); } catch { return { ok: false, error: 'The link has invalid percent-encoding.' }; }
  if (decoded.some((x) => x === '.' || x === '..')) return { ok: false, error: 'The link must not contain "." or ".." segments.' };

  const path = u.pathname || '/';
  const dir = opts.wholeDomain ? '/' : path.slice(0, path.lastIndexOf('/') + 1) || '/';
  const rest = path.slice(dir.length);
  return {
    ok: true,
    link: {
      origin: u.origin,
      prefix: dir,
      upstreamUrl: u.origin + dir.replace(/\/+$/, ''),
      examplePath: `/${rest}${u.search}`,
    },
  };
}

/** Agent link for a service: `${apiBase}/s/${slug}/` (apiBase without a trailing slash). */
export const agentLink = (apiBase: string, slug: string) => `${apiBase.replace(/\/+$/, '')}/s/${slug}/`;

/** Full sample request URL: agent link + examplePath (without its leading "/"). */
export const agentExampleUrl = (apiBase: string, slug: string, examplePath: string | null | undefined) =>
  agentLink(apiBase, slug) + (examplePath ?? '/').replace(/^\//, '');

// ── Protect your API ──────────────────────────────────────────────────────────

/** Header the gateway sends on every forwarded call, with the service's shared secret as its value. */
export const PROTECT_HEADER = 'X-Astralaunch-Secret';
/** HMAC signature header (t={ts};v1={hmac(secret, ts.bodyHex)}), still sent for existing integrations. */
export const SIGNATURE_HEADER = 'X-Astralaunch-Signature';

/** Copy-paste snippets that reject calls without the gateway's secret header. */
export function protectSnippets(secret: string, header = PROTECT_HEADER): { label: string; lang: string; code: string }[] {
  const h = header.toLowerCase();
  return [
    {
      label: 'Node / Express', lang: 'js',
      code: [
        `// Only Astralaunch may call this API: reject requests without the secret header.`,
        `const ASTRALAUNCH_SECRET = process.env.ASTRALAUNCH_SECRET; // ${secret}`,
        `app.use((req, res, next) => {`,
        `  if (req.get('${header}') !== ASTRALAUNCH_SECRET) return res.status(401).json({ error: 'unauthorized' });`,
        `  next();`,
        `});`,
      ].join('\n'),
    },
    {
      label: 'Python / FastAPI', lang: 'python',
      code: [
        `# Only Astralaunch may call this API: reject requests without the secret header.`,
        `import os, hmac`,
        `from fastapi import Request`,
        `from fastapi.responses import JSONResponse`,
        ``,
        `ASTRALAUNCH_SECRET = os.environ["ASTRALAUNCH_SECRET"]  # ${secret}`,
        ``,
        `@app.middleware("http")`,
        `async def require_astralaunch(request: Request, call_next):`,
        `    if not hmac.compare_digest(request.headers.get("${h}", ""), ASTRALAUNCH_SECRET):`,
        `        return JSONResponse({"error": "unauthorized"}, status_code=401)`,
        `    return await call_next(request)`,
      ].join('\n'),
    },
    {
      label: 'Cloudflare Worker', lang: 'js',
      code: [
        `// Only Astralaunch may call this API: reject requests without the secret header.`,
        `// Set the secret with: wrangler secret put ASTRALAUNCH_SECRET  (value: ${secret})`,
        `export default {`,
        `  async fetch(request, env) {`,
        `    if (request.headers.get('${header}') !== env.ASTRALAUNCH_SECRET) {`,
        `      return Response.json({ error: 'unauthorized' }, { status: 401 });`,
        `    }`,
        `    return handle(request, env); // your API`,
        `  },`,
        `};`,
      ].join('\n'),
    },
  ];
}
