/**
 * Launch / attach check: call the creator's pasted link once (through the same guarded client as the gateway) and
 * report what it returns. Required to pass before a service is created or its link changes.
 */
import { isEventStream, isJsonType, isStreamedResponse } from '../lib/proxy.js';
import { readPrefix, upstreamRequest, UpstreamError } from '../lib/upstreamClient.js';

export type ResponseKind = 'json' | 'stream' | 'file';

export type LinkCheck =
  | { ok: true; status: number; kind: ResponseKind; contentType: string | null; sample: string | null; sampleTruncated: boolean; ms: number }
  | { ok: false; error: string; code: 'unsafe' | 'unreachable' | 'timeout' | 'status' | 'redirect'; status?: number };

/** Stored JSON sample size ("a few KB"). */
export const SAMPLE_BYTES = 4096;

export function kindOf(h: Headers): ResponseKind {
  const ct = h.get('content-type');
  if (isEventStream(ct)) return 'stream';
  if (isJsonType(ct)) return 'json';
  return isStreamedResponse(h) ? 'stream' : 'file';
}

/** GET `url` once with the gateway's headers (secret / API key), within `timeoutS`. */
export async function checkLink(url: URL, headers: Record<string, string>, timeoutS: number): Promise<LinkCheck> {
  const start = Date.now();
  const deadline = start + timeoutS * 1000;
  let res;
  try {
    res = await upstreamRequest({
      url, method: 'GET', headersTimeoutMs: timeoutS * 1000,
      headers: { accept: 'application/json, text/event-stream, */*;q=0.8', 'accept-encoding': 'identity', ...headers },
    });
  } catch (e) {
    const k = e instanceof UpstreamError ? e.kind : 'unreachable';
    if (k === 'timeout') return { ok: false, code: 'timeout', error: `It took longer than ${timeoutS} seconds to answer.` };
    if (k === 'unsafe') return { ok: false, code: 'unsafe', error: 'This link must be a public https address (private and local addresses are not allowed).' };
    return { ok: false, code: 'unreachable', error: 'We could not reach this link. Check the address and that your API is online.' };
  }
  const { status, headers: h, body } = res;
  if (status >= 300 && status < 400) {
    body.destroy();
    return { ok: false, code: 'redirect', status, error: `It redirected to another address (${status}). Paste the final link your API answers on.` };
  }
  if (status < 200 || status >= 300) {
    body.destroy();
    return { ok: false, code: 'status', status, error: `It answered with an error (${status}).` };
  }
  const kind = kindOf(h);
  const contentType = h.get('content-type');
  if (kind !== 'json') {
    body.destroy();
    return { ok: true, status, kind, contentType, sample: null, sampleTruncated: false, ms: Date.now() - start };
  }
  const { bytes, truncated } = await readPrefix(body, SAMPLE_BYTES, deadline);
  let sample = bytes.toString('utf8');
  if (!truncated) {
    try { sample = JSON.stringify(JSON.parse(sample), null, 2); if (sample.length > SAMPLE_BYTES) sample = sample.slice(0, SAMPLE_BYTES); } catch { /* keep raw */ }
  }
  return { ok: true, status, kind, contentType, sample, sampleTruncated: truncated || sample.length >= SAMPLE_BYTES, ms: Date.now() - start };
}
