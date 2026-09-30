/**
 * Fork end-to-end for "one API link" services with REAL x402 payments on a LOCAL Anvil fork, through the LOCAL SDK
 * facilitator only (the server's fork guard refuses a non-local facilitator on a fork RPC). Runs against a server
 * started with this scratch DB, ALLOW_LOCAL_UPSTREAMS=true and PROBES_DISABLED=true (the probe is run here).
 *
 * Scenarios: JSON GET, JSON POST, SSE stream, multipart upload with a binary response, a session header round-trip,
 * an upstream error that must not be charged, and a direct call flagged by the protection probe. Each paid call is
 * checked on-chain: the agent's USDC goes down by exactly the price and the token's router goes up by it (or neither).
 *
 *   ANVIL_RPC=http://127.0.0.1:8546 API=http://127.0.0.1:3103 FACILITATOR=http://127.0.0.1:4022 DATABASE_URL=… \
 *     node_modules/.bin/tsx scripts/fork-service-link-e2e.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createPublicClient, createTestClient, defineChain, encodeAbiParameters, http, keccak256, parseUnits, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { toClientEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { eq } from 'drizzle-orm';
import { MONAD_NETWORK, USDC, serviceCreateMessage, serviceSettingsMessage, PROTECT_HEADER } from '@astralaunch/shared';

const RPC = process.env.ANVIL_RPC ?? 'http://127.0.0.1:8546';
const API = process.env.API ?? 'http://127.0.0.1:3103';
const FACILITATOR = process.env.FACILITATOR ?? 'http://127.0.0.1:4022';
const local = (u: string) => /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(u);
if (!local(RPC) || !local(FACILITATOR) || !local(API)) throw new Error('Fork only: RPC, facilitator and API must all be local.');
if (!process.env.DATABASE_URL || /mainnet/.test(process.env.DATABASE_URL)) throw new Error('DATABASE_URL must be a scratch database.');

// Public Anvil test mnemonic: fork only, never mainnet.
const MNEMONIC = 'test test test test test test test test test test test junk';
const creator = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const agent = mnemonicToAccount(MNEMONIC, { addressIndex: 5 });
const facilitatorAcct = mnemonicToAccount(MNEMONIC, { addressIndex: 6 });
// Real v2 token + router on the fork (SPEC §23): payTo is a real RevenueRouter.
const ASSET = '0x30ae380593a04c14abfa994969b718a78a6105ad';
const ROUTER = '0x10bc2220716738e8aef57b9cc72101c190acf240' as Address;
const PRICE = parseUnits('0.02', 6);

const chain = defineChain({ id: 143, name: 'Monad fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC) });
const tc = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const usdc = (a: Address) => pc.readContract({ address: USDC as Address, abi: erc20, functionName: 'balanceOf', args: [a] });

const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
let failures = 0;
const check = (ok: boolean, what: string) => { log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };

// ── Test upstream (the creator's API) ─────────────────────────────────────────
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 7, 7, 7]);
let requireSecret: string | null = null;
const seen: { path: string; headers: IncomingMessage['headers'] }[] = [];
async function upstream(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  seen.push({ path: req.url ?? '', headers: req.headers });
  if (requireSecret && req.headers[PROTECT_HEADER.toLowerCase()] !== requireSecret) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
  const url = new URL(req.url ?? '/', 'http://x');
  const j = (code: number, o: unknown, h: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': 'application/json', server: 'uvicorn', 'x-powered-by': 'FastAPI', ...h }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/v1/ask' && req.method === 'GET') return j(200, { answer: `hello ${url.searchParams.get('q')}` });
  if (url.pathname === '/v1/ask' && req.method === 'POST') return j(200, { echo: JSON.parse(body.toString() || 'null') });
  if (url.pathname === '/v1/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const [i, w] of ['one', 'two', 'three'].entries()) { res.write(`id: ${i}\ndata: ${w}\n\n`); await new Promise((r) => setTimeout(r, 300)); }
    return res.end();
  }
  if (url.pathname === '/v1/convert' && req.method === 'POST') {
    const ok = String(req.headers['content-type']).startsWith('multipart/form-data') && body.includes(Buffer.from('%%file-bytes%%'));
    res.writeHead(ok ? 200 : 400, { 'content-type': 'image/png', 'content-length': String(PNG.length) }); return res.end(PNG);
  }
  if (url.pathname === '/v1/chat') {
    const sid = String(req.headers['x-session-id'] ?? `s-${Date.now()}`);
    return j(200, { turn: req.headers['x-session-id'] ? 2 : 1, sid }, { 'x-session-id': sid });
  }
  if (url.pathname === '/v1/fail') return j(500, { error: 'model overloaded at http://127.0.0.1:4031/v1' });
  j(404, { error: 'not found' });
}

// ── Agent: x402 pay-and-call ──────────────────────────────────────────────────
const httpClient = new x402HTTPClient(new x402Client());
const payer = new x402Client();
registerExactEvmScheme(payer, { signer: toClientEvmSigner({ address: agent.address, signTypedData: (m) => agent.signTypedData(m as never) }, pc as never), networks: [MONAD_NETWORK] });

/** Balances before/after around a paid call (streams: after the body is fully read). */
async function paidCall(path: string, init: RequestInit = {}, read: (r: Response) => Promise<unknown> = (r) => r.arrayBuffer()) {
  const url = `${API}${path}`;
  const first = await fetch(url, { method: init.method ?? 'GET' });
  if (first.status !== 402) throw new Error(`${path}: expected 402, got ${first.status}`);
  const pr = httpClient.getPaymentRequiredResponse((n) => first.headers.get(n));
  const payload = await payer.createPaymentPayload(pr);
  const [a0, r0] = await Promise.all([usdc(agent.address), usdc(ROUTER)]);
  const res = await fetch(url, { ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), ...httpClient.encodePaymentSignatureHeader(payload) } });
  const body = await read(res);
  const [a1, r1] = await Promise.all([usdc(agent.address), usdc(ROUTER)]);
  return { res, body, charged: a0 - a1, routerGot: r1 - r0, window: pr.accepts[0]!.maxTimeoutSeconds };
}

async function main() {
  // Fork prep: plain EOAs (Monad mainnet has 7702 delegation code on the dev accounts) and 100 USDC for the agent.
  for (const a of [agent.address, facilitatorAcct.address, creator.address]) await tc.setCode({ address: a, bytecode: '0x' });
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [agent.address, 9n]));   // USDC balances slot 9 (fund.sh)
  await tc.setStorageAt({ address: USDC as Address, index: slot, value: `0x${(100_000_000n).toString(16).padStart(64, '0')}` as Hex });
  check((await usdc(agent.address)) === 100_000_000n, 'agent funded with 100 USDC on the fork');

  const up = createServer((q, r) => { void upstream(q, r); });
  await new Promise<void>((r) => up.listen(4031, '127.0.0.1', r));
  const LINK = 'http://127.0.0.1:4031/v1/ask?q=hello';

  // Listed token in the scratch DB (creator = Anvil #0), then the service through the real signed API.
  const { db } = await import('../src/db/client.js');
  const { services, idxRegistrations } = await import('../src/db/schema.js');
  const { upsertTokenFromRegistration } = await import('../src/services/tokenSync.js');
  const { adminListAsset } = await import('../src/services/launchFee.js');
  const { probeService } = await import('../src/lib/probes.js');
  const reg = { chainId: 143, txHash: `0x${'e2'.repeat(32)}`, logIndex: 0, asset: ASSET, creator: creator.address.toLowerCase(), router: ROUTER.toLowerCase(),
    poolId: '0x00', numeraire: USDC.toLowerCase(), initializer: '', launcher: creator.address.toLowerCase(), blockNumber: 1n, timestamp: BigInt(Math.floor(Date.now() / 1000)) };
  await db.insert(idxRegistrations).values(reg).onConflictDoNothing();
  await upsertTokenFromRegistration(db, reg, { name: 'nullsight', symbol: 'SIGHT', decimals: 18 });
  await adminListAsset(db, ASSET, 143, 'fork e2e').catch(() => { /* already listed on a rerun */ });

  const SLUG = `e2e-${Date.now() % 1_000_000}`;
  const m = { asset: ASSET, slug: SLUG, name: 'E2E agent', priceUsdc: PRICE.toString(), apiLink: LINK, apiKeyHeader: 'X-Api-Key', apiKeyValue: 'k-e2e-123', issuedAt: Math.floor(Date.now() / 1000) };
  const created = await fetch(`${API}/api/services`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...m, signature: await creator.signMessage({ message: serviceCreateMessage(m) }) }) });
  const cj = await created.json() as { id: string; responseKind: string; error?: string };
  check(created.status === 201 && cj.responseKind === 'json', `service created from the pasted link (${created.status}, kind ${cj.responseKind ?? cj.error})`);
  const S = `/s/${SLUG}`;

  // 1. JSON GET
  const g = await paidCall(`${S}/ask?q=monad`, {}, (r) => r.json());
  check(g.res.status === 200 && JSON.stringify(g.body) === '{"answer":"hello monad"}', `JSON GET → ${g.res.status} ${JSON.stringify(g.body)}`);
  check(g.charged === PRICE && g.routerGot === PRICE, `JSON GET charged ${g.charged} (router +${g.routerGot})`);
  check(g.window === 150, `payment window ${g.window}s covers the 120 s timeout`);
  const last = () => seen.at(-1)!.headers;
  check(last()['x-api-key'] === 'k-e2e-123' && typeof last()[PROTECT_HEADER.toLowerCase()] === 'string', 'upstream received the API key and the protect secret');
  check(g.res.headers.get('server') === null && g.res.headers.get('x-powered-by') === null, 'Server / X-Powered-By stripped');

  // 2. JSON POST
  const p = await paidCall(`${S}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'post', n: [1, 2] }) }, (r) => r.json());
  check(p.res.status === 200 && JSON.stringify(p.body) === '{"echo":{"q":"post","n":[1,2]}}', `JSON POST → ${JSON.stringify(p.body)}`);
  check(p.charged === PRICE && p.routerGot === PRICE, `JSON POST charged ${p.charged}`);

  // 3. SSE stream: settled when the headers arrive; events arrive over time
  const arrivals: number[] = [];
  const t0 = Date.now();
  const sse = await paidCall(`${S}/stream`, {}, async (r) => {
    let text = '';
    const reader = r.body!.getReader();
    for (let c = await reader.read(); !c.done; c = await reader.read()) { text += new TextDecoder().decode(c.value); arrivals.push(Date.now() - t0); }
    return text;
  });
  check(sse.res.status === 200 && sse.res.headers.get('content-type') === 'text/event-stream', 'SSE → 200 text/event-stream');
  check((sse.body as string).includes('data: one') && (sse.body as string).includes('data: three'), 'SSE: all events delivered');
  // The upstream writes an event every 300 ms: unbuffered = separate chunks ~300 ms apart (the first may wait for the settle).
  const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]!);
  check(arrivals.length >= 3 && gaps.at(-1)! >= 250, `SSE: ${arrivals.length} chunks, gaps ${gaps.join(' / ')} ms (streamed, not buffered)`);
  check(sse.charged === PRICE && sse.routerGot === PRICE, `SSE charged once: ${sse.charged}`);

  // 4. Multipart upload → binary (PNG) response
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('%%file-bytes%%')], { type: 'application/octet-stream' }), 'in.bin');
  const mp = await paidCall(`${S}/convert`, { method: 'POST', body: form }, async (r) => Buffer.from(await r.arrayBuffer()));
  check(mp.res.status === 200 && mp.res.headers.get('content-type') === 'image/png' && (mp.body as Buffer).equals(PNG), `multipart → ${mp.res.status} image/png, ${(mp.body as Buffer).length} bytes identical`);
  check(mp.charged === PRICE, `multipart charged ${mp.charged}`);

  // 5. Session header round-trip
  const s1 = await paidCall(`${S}/chat`, {}, (r) => r.json());
  const sid = s1.res.headers.get('x-session-id');
  const s2 = await paidCall(`${S}/chat`, { headers: { 'X-Session-Id': sid ?? '' } }, (r) => r.json());
  check(!!sid && (s2.body as { turn: number; sid: string }).turn === 2 && (s2.body as { sid: string }).sid === sid && s2.res.headers.get('x-session-id') === sid, `session ${sid} round-trip (turn 2)`);
  check(s1.charged === PRICE && s2.charged === PRICE, 'each session call charged once');

  // 6. Upstream error: never charged, no upstream host in the error
  const f = await paidCall(`${S}/fail`, {}, (r) => r.json());
  check(f.res.status === 502 && f.charged === 0n && f.routerGot === 0n, `upstream 500 → ${f.res.status}, charged ${f.charged}`);
  check(!JSON.stringify(f.body).includes('127.0.0.1:4031'), `error scrubbed: ${JSON.stringify(f.body)}`);

  // 7. Protection probe: a direct call (no secret) that answers → "unprotected"; after the API checks the secret → "protected"
  const [svc] = await db.select().from(services).where(eq(services.slug, SLUG));
  await probeService(db, svc!);
  const st = async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const r = await fetch(`${API}/api/services/${svc!.id}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issuedAt, signature: await creator.signMessage({ message: serviceSettingsMessage(svc!.id, ASSET, issuedAt) }) }) });
    return r.json() as Promise<{ protection: { status: string }; protect: { secret: string } }>;
  };
  const before = await st();
  check(before.protection.status === 'unprotected', `direct call without the secret answered → ${before.protection.status}`);
  requireSecret = before.protect.secret;        // the creator adds the snippet
  const [fresh] = await db.select().from(services).where(eq(services.slug, SLUG));
  await probeService(db, fresh!);
  check((await st()).protection.status === 'protected', 'after requiring the secret → protected');
  const again = await paidCall(`${S}/ask?q=still`, {}, (r) => r.json());
  check(again.res.status === 200 && again.charged === PRICE, 'paid calls through the gateway still work once protected');

  up.close();
  log(failures ? `${failures} check(s) FAILED` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
