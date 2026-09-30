/**
 * A real local HTTP upstream for gateway tests (the gateway calls upstreams with node:http, not fetch).
 * Records every request; tests swap the handler. Use with ALLOW_LOCAL_UPSTREAMS=true (set before importing ssrf).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedCall { method: string; path: string; headers: IncomingMessage['headers']; body: Buffer }
export type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => unknown;   // return value ignored

export async function startTestUpstream(initial: Handler) {
  let handler = initial;
  const calls: RecordedCall[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    calls.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
    try { await handler(req, res, body); } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, calls,
    set(h: Handler) { handler = h; },
    reset() { calls.length = 0; handler = initial; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Handler answering `status` with a JSON body. */
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
