/**
 * Fork end-to-end for "one API link" services with REAL x402 payments on a LOCAL Anvil fork, through the LOCAL SDK
 * facilitator only (the server's fork guard refuses a non-local facilitator on a fork RPC). Runs against a server
 * started with this scratch DB, ALLOW_LOCAL_UPSTREAMS=true and PROBES_DISABLED=true (the probe is run here).
 *
 * Scenarios: JSON GET, JSON POST, SSE stream, multipart upload with a binary response, a session header round-trip,
 * an upstream error that must not be charged, a direct call flagged by the protection probe, and a POST-only JSON API
 * (launch allowed without a sample; with a POST sample the check and the paid "Try a sample call" both work, using
 * the web's own x402 call code). Each paid call is
 * checked on-chain: the agent's USDC goes down by exactly the price and the token's router goes up by it (or neither).
 *
 *   ANVIL_RPC=http://127.0.0.1:8546 API=http://127.0.0.1:3103 FACILITATOR=http://127.0.0.1:4022 DATABASE_URL=… \
 *     node_modules/.bin/tsx scripts/fork-service-link-e2e.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createPublicClient, createTestClient, createWalletClient, defineChain, encodeAbiParameters, http, keccak256, parseUnits, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { toClientEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { eq } from 'drizzle-orm';
import { MONAD_NETWORK, USDC, serviceCreateMessage, serviceSettingsMessage, serviceUpdateMessage, PROTECT_HEADER } from '@astralaunch/shared';
import { prepareCall, payAndCall } from '../../web/src/lib/x402.js';

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
const seen: { method: string; path: string; headers: IncomingMessage['headers'] }[] = [];
async function upstream(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
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
  if (url.pathname === '/v1/needs-body') {   // answers a plain GET with 400 (wants a body)
    return req.method === 'POST' && body.length ? j(200, { ok: true }) : j(400, { error: 'body required' });
  }
  if (url.pathname === '/v1/complete') {   // POST-only JSON API
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' }, { allow: 'POST' });
    let m: { message?: string } = {};
    try { m = JSON.parse(body.toString() || '{}'); } catch { /* 422 */ }
    return m.message ? j(200, { reply: `you said ${m.message}` }) : j(422, { error: 'message required' });
  }
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
  // Scratch DB only: start clean (services from earlier runs of this script on these two tokens).
  const { gatewayRequests, serviceProbes } = await import('../src/db/schema.js');
  const { inArray } = await import('drizzle-orm');
  const TEST_ASSETS = [ASSET, '0x2686619d5569aebcdfec774e8a2167de78376ddf'];
  const old = await db.select({ id: services.id }).from(services).where(inArray(services.asset, TEST_ASSETS));
  if (old.length) {
    const ids = old.map((o) => o.id);
    await db.delete(gatewayRequests).where(inArray(gatewayRequests.serviceId, ids));
    await db.delete(serviceProbes).where(inArray(serviceProbes.serviceId, ids));
    await db.delete(services).where(inArray(services.id, ids));
  }
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

  // 8. POST-only JSON API (GET → 405) on a second real v2 token (FEED + its router)
  requireSecret = null;
  const FEED = '0x2686619d5569aebcdfec774e8a2167de78376ddf', FEED_ROUTER = '0xdba0705ce9217b9e3db296af6a1810eb0467fd3a' as Address;
  const reg2 = { ...reg, txHash: `0x${'e3'.repeat(32)}`, asset: FEED, router: FEED_ROUTER.toLowerCase() };
  await db.insert(idxRegistrations).values(reg2).onConflictDoNothing();
  await upsertTokenFromRegistration(db, reg2, { name: 'nullfeed', symbol: 'FEED', decimals: 18 });
  await adminListAsset(db, FEED, 143, 'fork e2e').catch(() => {});
  const CHAT = 'http://127.0.0.1:4031/v1/complete';
  const checkLink = async (apiLink: string) => (await fetch(`${API}/api/services/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiLink }) })).json() as Promise<{ ok: boolean; kind?: string | null; status?: number; noSample?: string; error?: string }>;
  const methodsTo = (p: string, from: number) => seen.slice(from).filter((x) => x.path.split('?')[0] === p).map((x) => x.method);
  let mark = seen.length;
  const chk = await checkLink(CHAT);
  check(chk.ok && chk.kind === null && chk.status === 405 && /add a Sample request/.test(chk.noSample ?? ''), `POST-only link: check passes without a sample (GET → ${chk.status}, launch allowed, hint shown)`);
  check(JSON.stringify(methodsTo('/v1/complete', mark)) === '["GET"]', `the check sent only the GET the link implies: ${JSON.stringify(methodsTo('/v1/complete', mark))} (no POST {} probe)`);
  mark = seen.length;
  const c400 = await checkLink('http://127.0.0.1:4031/v1/needs-body');
  check(c400.ok && c400.kind === null && c400.status === 400 && JSON.stringify(methodsTo('/v1/needs-body', mark)) === '["GET"]', `GET 400 → reachable, no sample call, only a GET sent`);
  mark = seen.length;
  const c404 = await checkLink('http://127.0.0.1:4031/v1/missing');
  check(!c404.ok && c404.error === 'Nothing found at this link.' && JSON.stringify(methodsTo('/v1/missing', mark)) === '["GET"]', `GET 404 → "${c404.error}"`);
  const CSLUG = `chat-${Date.now() % 1_000_000}`;
  const cm = { asset: FEED, slug: CSLUG, name: 'Chat', priceUsdc: PRICE.toString(), apiLink: CHAT, issuedAt: Math.floor(Date.now() / 1000) };
  const cr = await fetch(`${API}/api/services`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cm, signature: await creator.signMessage({ message: serviceCreateMessage(cm) }) }) });
  const cid = (await cr.json() as { id: string }).id;
  const d1 = await (await fetch(`${API}/api/tokens/${FEED}`)).json() as { service: { endpoint: string; sample: unknown } };
  check(cr.status === 201 && d1.service.sample === null && d1.service.endpoint === `/s/${CSLUG}`, `attached without a sample: token page sample ${JSON.stringify(d1.service.sample)} (Try hidden, agent link kept)`);
  const feedUsdc = () => usdc(FEED_ROUTER);
  const f0 = await feedUsdc();
  const cp = await paidCall(`/s/${CSLUG}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi agent' }) }, (r) => r.json());
  check(cp.res.status === 200 && JSON.stringify(cp.body) === '{"reply":"you said hi agent"}' && cp.charged === PRICE && (await feedUsdc()) - f0 === PRICE,
    `agent POST through the gateway → ${JSON.stringify(cp.body)}, charged ${cp.charged}`);
  const um = { sampleMethod: 'POST' as const, sampleBody: '{"message":"hello"}', issuedAt: Math.floor(Date.now() / 1000) + 1 };
  const ur = await fetch(`${API}/api/services/${cid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...um, signature: await creator.signMessage({ message: serviceUpdateMessage(cid, FEED, um) }) }) });
  const d2 = await (await fetch(`${API}/api/tokens/${FEED}`)).json() as { service: { sample: { method: 'GET' | 'POST'; path: string; body: string | null } | null; response: { kind: string; sample: string } | null } };
  check(ur.status === 200 && d2.service.sample?.method === 'POST' && d2.service.response?.kind === 'json' && JSON.parse(d2.service.response.sample).reply === 'you said hello',
    `POST sample added and checked with it: response ${d2.service.response?.sample.replace(/\s+/g, ' ')}`);
  // "Try a sample call": the web's own prepareCall / payAndCall with the service's sample.
  const wc = createWalletClient({ account: agent, chain, transport: http(RPC) });
  const s = d2.service.sample!;
  const a0 = await usdc(agent.address);
  const plan = await prepareCall(pc as never, agent.address, `${API}/s/${CSLUG}${s.path}`, FEED as Address, (await (await fetch(`${API}/api/config`)).json() as { contracts: { registry: Address } }).contracts.registry,
    USDC as Address, { method: s.method, body: s.body });
  if ('free' in plan) throw new Error('sample call was not a paid 402');
  const out = await payAndCall(pc as never, wc as never, agent.address, plan);
  check(out.status === 200 && JSON.parse(out.body).reply === 'you said hello' && !!out.settleTx && a0 - (await usdc(agent.address)) === PRICE,
    `paid sample call (web x402 code, POST body): ${out.status} ${out.body}, settle ${out.settleTx?.slice(0, 10)}…`);

  up.close();
  log(failures ? `${failures} check(s) FAILED` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
