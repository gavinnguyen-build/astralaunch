/**
 * Launch / attach check: call the creator's pasted link once (through the same guarded client as the gateway) and
 * report what it returns. Required to pass before a service is created or its link changes.
 */
import { isEventStream, isJsonType, isStreamedResponse } from '../lib/proxy.js';
import { readPrefix, upstreamRequest, UpstreamError } from '../lib/upstreamClient.js';

export type ResponseKind = 'json' | 'stream' | 'file';

export type LinkCheck =
  | {
      ok: true; status: number;
      /** What a call returns; null when there is no sample call (the link is reachable but needs a request we do not know). */
      kind: ResponseKind | null; contentType: string | null; sample: string | null; sampleTruncated: boolean; ms: number;
      /** Set when the link is reachable but did not answer the plain GET (e.g. a POST-only JSON endpoint). */
      noSample?: string;
    }
  | { ok: false; error: string; code: 'unsafe' | 'unreachable' | 'timeout' | 'status' | 'redirect'; status?: number };

/** Optional sample request (Advanced): method + JSON body for POST. */
export interface SampleRequest { method: 'GET' | 'POST'; body?: string | null }

/** Stored JSON sample size ("a few KB"). */
export const SAMPLE_BYTES = 4096;

export function kindOf(h: Headers): ResponseKind {
  const ct = h.get('content-type');
  if (isEventStream(ct)) return 'stream';
  if (isJsonType(ct)) return 'json';
  return isStreamedResponse(h) ? 'stream' : 'file';
}

const ACCEPT = 'application/json, text/event-stream, */*;q=0.8';

function failure(e: unknown, timeoutS: number): Extract<LinkCheck, { ok: false }> {
  const k = e instanceof UpstreamError ? e.kind : 'unreachable';
  if (k === 'timeout') return { ok: false, code: 'timeout', error: `It took longer than ${timeoutS} seconds to answer.` };
  if (k === 'unsafe') return { ok: false, code: 'unsafe', error: 'This link must be a public https address (private and local addresses are not allowed).' };
  return { ok: false, code: 'unreachable', error: 'We could not reach this link. Check the address and that your API is online.' };
}

/** One request; the status and headers, with the body left for the caller (destroy it when unused). */
function send(url: URL, headers: Record<string, string>, timeoutS: number, method: string, body?: string | null) {
  const bytes = body ? Buffer.from(body) : null;
  return upstreamRequest({
    url, method, body: bytes, headersTimeoutMs: timeoutS * 1000,
    headers: { accept: ACCEPT, 'accept-encoding': 'identity', ...(bytes ? { 'content-type': 'application/json' } : {}), ...headers },
  });
}

/**
 * Call the pasted link once with the gateway's headers (secret / API key), within `timeoutS`.
 * - With a sample request: exactly that request; a 2xx is required and its response is recorded.
 * - Without: a plain GET, and nothing else: the check never sends a request the creator did not write (a real API may
 *   act on it). A 2xx is recorded as the sample. 405 or 400 means the endpoint exists but needs another method or a
 *   body: the link is reachable, launch/attach is allowed, there is no sample call (kind null). 404 = nothing there.
 */
export async function checkLink(url: URL, headers: Record<string, string>, timeoutS: number, sample?: SampleRequest | null): Promise<LinkCheck> {
  const start = Date.now();
  const deadline = start + timeoutS * 1000;
  let res;
  try { res = await send(url, headers, timeoutS, sample?.method ?? 'GET', sample?.method === 'POST' ? sample.body ?? null : null); }
  catch (e) { return failure(e, timeoutS); }
  const { status, headers: h, body } = res;
  if (status >= 300 && status < 400) {
    body.destroy();
    return { ok: false, code: 'redirect', status, error: `It redirected to another address (${status}). Paste the final link your API answers on.` };
  }
  if (status < 200 || status >= 300) {
    body.destroy();
    if (!sample) {
      // 405 / 400 to a plain GET: the endpoint exists but wants another method or a body. Never guess that request.
      if (status === 405 || status === 400) {
        return {
          ok: true, status, kind: null, contentType: null, sample: null, sampleTruncated: false, ms: Date.now() - start,
          noSample: 'Your API is reachable. To show a sample call, add a Sample request under Advanced.',
        };
      }
      if (status === 404) return { ok: false, code: 'status', status, error: 'Nothing found at this link.' };
    }
    return { ok: false, code: 'status', status, error: sample ? `Your sample request got an error (${status}).` : `It answered with an error (${status}).` };
  }
  const kind = kindOf(h);
  const contentType = h.get('content-type');
  if (kind !== 'json') {
    body.destroy();
    return { ok: true, status, kind, contentType, sample: null, sampleTruncated: false, ms: Date.now() - start };
  }
  const { bytes, truncated } = await readPrefix(body, SAMPLE_BYTES, deadline);
  let text = bytes.toString('utf8');
  if (!truncated) {
    try { text = JSON.stringify(JSON.parse(text), null, 2); if (text.length > SAMPLE_BYTES) text = text.slice(0, SAMPLE_BYTES); } catch { /* keep raw */ }
  }
  return { ok: true, status, kind, contentType, sample: text, sampleTruncated: truncated || text.length >= SAMPLE_BYTES, ms: Date.now() - start };
}
