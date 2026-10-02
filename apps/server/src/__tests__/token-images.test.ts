/**
 * Token images: upload (PNG / JPEG / WebP by magic bytes, ≤ 2 MB, never SVG), 64/256/512 WebP renditions
 * with metadata stripped, served from /img with long cache headers; referenced by hash in the creator-signed
 * token details; unreferenced uploads deleted after 24 h. Old signed messages stay valid.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import sharp from 'sharp';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';

const STORE = mkdtempSync(path.join(tmpdir(), 'astra-img-'));
process.env.IMAGE_STORE_DIR = STORE;
process.env.IMAGE_UPLOADS_PER_10MIN = '1000';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db/client.js', () => ({ get db() { return h.db; } }));
vi.mock('../env.js', () => ({
  RPC_URL: 'http://127.0.0.1:8545', CHAIN_ID: 143, REGISTRY_ADDR: '0x0000000000000000000000000000000000000001', SUBMITTERS: [],
  USDC_ADDR: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', PAYMENT_TIMEOUT_S: 60,
}));
vi.mock('../lib/ssrf.js', () => ({ assertSafeUpstream: vi.fn(async () => {}), SsrfError: class extends Error {} }));

const { tokens, tokenImages, idxRegistrations } = await import('../db/schema.js');
const { upsertTokenFromRegistration } = await import('../services/tokenSync.js');
const { adminListAsset } = await import('../services/launchFee.js');
const { tokenMetadataMessage, launchDetailsMessage } = await import('@astralaunch/shared');
const { sniffImage, processTokenImage, cleanupUnreferencedImages } = await import('../services/tokenImages.js');
const { fixedWindowLimiter } = await import('../lib/rateLimit.js');
const { privateKeyToAccount } = await import('viem/accounts');
const { eq, sql } = await import('drizzle-orm');
const uploads = (await import('../routes/uploads.js')).default;
const img = (await import('../routes/img.js')).default;
const tokensRouter = (await import('../routes/tokens.js')).default;

// Anvil dev keys, tests only.
const creator  = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const attacker = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const ASSET = '0x' + 'a'.repeat(40);

const app = new Hono();
app.route('/api/uploads', uploads);
app.route('/img', img);
app.route('/api/tokens', tokensRouter);
const upload = (body: Uint8Array | string) => app.request('/api/uploads/token-image', { method: 'POST', body: body as never, headers: { 'Content-Type': 'application/octet-stream' } });
const now = () => Math.floor(Date.now() / 1000);

const png = (w = 300, hgt = 200) => sharp({ create: { width: w, height: hgt, channels: 3, background: { r: 139, g: 92, b: 246 } } }).png().toBuffer();
const jpegWithExif = () => sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 52, g: 211, b: 153 } } })
  .withExif({ IFD0: { Copyright: 'secret owner', Artist: 'gps-tester' } }).jpeg().toBuffer();
const webp = () => sharp({ create: { width: 120, height: 240, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).webp().toBuffer();

describe('image type checks', () => {
  it('sniffs PNG, JPEG and WebP by magic bytes; rejects SVG, GIF, text', async () => {
    expect(sniffImage(await png())).toBe('png');
    expect(sniffImage(await jpegWithExif())).toBe('jpeg');
    expect(sniffImage(await webp())).toBe('webp');
    for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', '<?xml version="1.0"?><svg/>', 'GIF89a......', 'hello']) {
      expect(sniffImage(new TextEncoder().encode(bad))).toBeNull();
    }
  });

  it('renders square 64 / 256 / 512 WebP with no metadata (EXIF stripped)', async () => {
    const src = await jpegWithExif();
    expect((await sharp(src).metadata()).exif).toBeDefined();   // the input really has EXIF
    const { hash, files } = await processTokenImage(src);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    for (const size of [64, 256, 512] as const) {
      const m = await sharp(files[size]).metadata();
      expect(m).toMatchObject({ format: 'webp', width: size, height: size });
      expect(m.exif).toBeUndefined(); expect(m.xmp).toBeUndefined(); expect(m.icc).toBeUndefined();
    }
  });

  it('a PNG header on non-PNG data is refused (decoder must agree)', async () => {
    const fake = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode('<svg/>not a png')]);
    await expect(processTokenImage(fake)).rejects.toThrow(/PNG, JPG or WebP/);
  });

  it('rate limiter: max per window per key', () => {
    let t = 0;
    const allow = fixedWindowLimiter({ max: 2, windowMs: 1000, now: () => t });
    expect([allow('a'), allow('a'), allow('a'), allow('b')]).toEqual([true, true, false, true]);
    t = 1000;
    expect(allow('a')).toBe(true);
  });
});

describe('upload, serve, reference, cleanup', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    const reg = {
      chainId: 143, txHash: '0x' + '1'.repeat(64), logIndex: 0, asset: ASSET, creator: creator.address.toLowerCase(),
      router: '0x' + '5'.repeat(40), poolId: '0x00', numeraire: '', initializer: '', launcher: '0x' + '9'.repeat(40),
      blockNumber: 10n, timestamp: 1_800_000_000n,
    };
    await db.insert(idxRegistrations).values(reg);
    await upsertTokenFromRegistration(db, reg, { name: 'T', symbol: 'T', decimals: 18 });
    await adminListAsset(db, ASSET, 143, 'test');
  });
  afterEach(async () => { await close(); });

  it('upload → 201 with hash and paths; /img serves image/webp with long cache headers', async () => {
    const res = await upload(await png());
    expect(res.status).toBe(201);
    const { hash, urls } = await res.json() as { hash: string; urls: Record<string, string> };
    expect(urls).toEqual({ 64: `/img/${hash}-64.webp`, 256: `/img/${hash}-256.webp`, 512: `/img/${hash}-512.webp` });
    for (const s of [64, 256, 512]) expect(existsSync(path.join(STORE, `${hash}-${s}.webp`))).toBe(true);
    const got = await app.request(urls[256]!);
    expect(got.status).toBe(200);
    expect(got.headers.get('Content-Type')).toBe('image/webp');
    expect(got.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect((await sharp(Buffer.from(await got.arrayBuffer())).metadata()).width).toBe(256);
    for (const bad of [`/img/${hash}-100.webp`, '/img/..%2F..%2Fetc%2Fpasswd', `/img/${hash}-64.png`]) expect((await app.request(bad)).status).toBe(404);
  });

  it('size limit: over 2 MB → 413 with the plain sentence', async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1); big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await upload(big);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Use a PNG, JPG or WebP under 2 MB' });
  });

  it('SVG (and other types) rejected → 415', async () => {
    const res = await upload('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'Use a PNG, JPG or WebP under 2 MB' });
    expect(await db.select().from(tokenImages)).toHaveLength(0);
  });

  it('only the on-chain creator can set or change the image; unknown hashes refused', async () => {
    const { hash } = await (await upload(await png())).json() as { hash: string };
    const send = async (signer: typeof creator, imageHash: string, issuedAt: number) => {
      const m = { asset: ASSET, imageHash, issuedAt };
      return app.request('/api/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...m, signature: await signer.signMessage({ message: tokenMetadataMessage(m) }) }) });
    };
    const t = now();
    expect((await send(attacker, hash, t)).status).toBe(403);
    expect((await send(creator, 'f'.repeat(40), t + 1)).status).toBe(400);
    expect((await send(creator, hash, t + 2)).status).toBe(200);
    const [row] = await db.select({ imageHash: tokens.imageHash }).from(tokens).where(eq(tokens.asset, ASSET));
    expect(row!.imageHash).toBe(hash);
    // change it
    const { hash: h2 } = await (await upload(await webp())).json() as { hash: string };
    expect((await send(creator, h2, t + 3)).status).toBe(200);
    expect((await db.select({ imageHash: tokens.imageHash }).from(tokens).where(eq(tokens.asset, ASSET)))[0]!.imageHash).toBe(h2);
  }, 60_000);

  it('launch-details carries imageHash; messages without it are unchanged', () => {
    const base = { asset: ASSET, description: 'x', issuedAt: 1 };
    expect(launchDetailsMessage(base as never)).toBe(`Astralaunch: launch details\n{"asset":"${ASSET}","description":"x","issuedAt":1}`);
    expect(tokenMetadataMessage({ asset: ASSET, website: 'https://a.b', issuedAt: 1 } as never)).toBe(`Astralaunch: update token metadata\n{"asset":"${ASSET}","website":"https://a.b","issuedAt":1}`);
    expect(launchDetailsMessage({ ...base, imageHash: 'a'.repeat(40) } as never)).toContain(`"imageHash":"${'a'.repeat(40)}","description":"x"`);
  });

  it('cleanup: uploads unreferenced for 24 h are deleted with their files; referenced ones stay', async () => {
    const { hash: used } = await (await upload(await png(50, 50))).json() as { hash: string };
    const { hash: orphan } = await (await upload(await png(60, 60))).json() as { hash: string };
    const { hash: fresh } = await (await upload(await png(70, 70))).json() as { hash: string };
    await db.update(tokens).set({ imageHash: used }).where(eq(tokens.asset, ASSET));
    await db.update(tokenImages).set({ createdAt: sql`NOW() - INTERVAL '25 hours'` }).where(sql`${tokenImages.hash} IN (${used}, ${orphan})`);
    const deleted = await cleanupUnreferencedImages(db as never);
    expect(deleted).toEqual([orphan]);
    expect(existsSync(path.join(STORE, `${orphan}-512.webp`))).toBe(false);
    for (const keep of [used, fresh]) expect(existsSync(path.join(STORE, `${keep}-512.webp`))).toBe(true);
    expect((await db.select().from(tokenImages)).map((r) => r.hash).sort()).toEqual([used, fresh].sort());
  });
});

process.on('exit', () => rmSync(STORE, { recursive: true, force: true }));
