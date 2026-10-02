/**
 * Brief token description: ≤ 200 characters after cleaning, plain text (HTML stripped), part of the signed token
 * details (POST /api/tokens and /launch-details), only the on-chain creator can set it, old messages unchanged, and
 * lists/pages fall back to the service description when it is empty (`brief`).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db/client.js', () => ({ get db() { return h.db; } }));
vi.mock('../env.js', () => ({
  RPC_URL: 'http://127.0.0.1:1', CHAIN_ID: 143, REGISTRY_ADDR: '0x0000000000000000000000000000000000000001', SUBMITTERS: [],
  ESCROW_ADDR: '0x0000000000000000000000000000000000000002', VAULT_ADDR: '0x0000000000000000000000000000000000000003',
  USDC_ADDR: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', PAYMENT_TIMEOUT_S: 60,
}));

const { services, tokens, idxRegistrations } = await import('../db/schema.js');
const { upsertTokenFromRegistration } = await import('../services/tokenSync.js');
const { adminListAsset } = await import('../services/launchFee.js');
const shared = await import('@astralaunch/shared');
const { privateKeyToAccount } = await import('viem/accounts');
const { eq } = await import('drizzle-orm');
const tokensRouter = (await import('../routes/tokens.js')).default;

// Anvil dev keys, tests only.
const creator  = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const stranger = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const ASSET = '0x' + 'd'.repeat(40);

const app = new Hono();
app.route('/api/tokens', tokensRouter);
const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let clock = Math.floor(Date.now() / 1000);
const setDescription = async (description: string, signer = creator) => {
  const m = { asset: ASSET, description, issuedAt: ++clock };
  return post('/api/tokens', { ...m, signature: await signer.signMessage({ message: shared.tokenMetadataMessage(m) }) });
};

describe('shared: brief description rules', () => {
  it('200 characters after cleaning; tags, comments and control characters removed; a lone "<" kept', () => {
    const parse = (description: string) => shared.tokenMetadataSchema.safeParse({ asset: ASSET, description, issuedAt: 1, signature: '0x00' }).success;
    expect(parse('x'.repeat(200))).toBe(true);
    expect(parse('x'.repeat(201))).toBe(false);
    expect(parse(`<b>${'x'.repeat(200)}</b>`)).toBe(true);   // the limit counts the stored (clean) text
    expect(shared.launchDetailsSchema.safeParse({ asset: ASSET, description: 'y'.repeat(201), issuedAt: 1, signature: '0x00' }).success).toBe(false);
    expect(shared.cleanTokenDescription('<b>Fast</b> arXiv\n\ndigest<!-- x --> <script>alert(1)</script>')).toBe('Fast arXiv digest alert(1)');
    expect(shared.cleanTokenDescription('<img src=x onerror=alert(1)>Costs < $1 per call')).toBe('Costs < $1 per call');
  });

  it('old signed messages are unchanged (description was already a signed field)', () => {
    expect(shared.tokenMetadataMessage({ asset: ASSET, description: 'Hi', issuedAt: 1 }))
      .toBe(`Astralaunch: update token metadata\n{"asset":"${ASSET}","description":"Hi","issuedAt":1}`);
  });

  it('tokenBrief: the token description, else the service description, else null', () => {
    expect(shared.tokenBrief('Mine', 'Service')).toBe('Mine');
    expect(shared.tokenBrief('', 'Service')).toBe('Service');
    expect(shared.tokenBrief('<p> </p>', 'Service')).toBe('Service');
    expect(shared.tokenBrief(null, null)).toBeNull();
  });
});

describe('POST /api/tokens: brief description', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    const reg = {
      chainId: 143, txHash: '0x' + '4'.repeat(64), logIndex: 0, asset: ASSET, creator: creator.address.toLowerCase(), router: '0x' + '5'.repeat(40),
      poolId: '0x00', numeraire: '', initializer: '', launcher: '0x' + '9'.repeat(40), blockNumber: 10n, timestamp: 1_800_000_000n,
    };
    await db.insert(idxRegistrations).values(reg);
    await upsertTokenFromRegistration(db, reg, { name: 'Feed', symbol: 'FEED', decimals: 18 });
    await adminListAsset(db, ASSET, 143, 'test');
    await db.insert(services).values({
      slug: 'feedy', name: 'feedy', asset: ASSET, router: '0x' + '5'.repeat(40), creator: creator.address.toLowerCase(),
      upstreamUrl: 'https://api.example.com', priceUsdc: '10000', upstreamSecret: 's', description: 'Latest 5 arXiv papers for a topic',
    });
  });
  afterAll(async () => { await close(); });
  const stored = async () => (await db.select().from(tokens).where(eq(tokens.asset, ASSET)))[0]!.description;
  const listBrief = async () => {
    const r = await (await app.request('/api/tokens?filter=all')).json() as { tokens: { asset: string; brief: string | null }[] };
    return r.tokens.find((t) => t.asset === ASSET)?.brief;
  };

  it('fallback: with no token description, lists show the service description', async () => {
    expect(await stored()).toBeNull();
    expect(await listBrief()).toBe('Latest 5 arXiv papers for a topic');
  });

  it('the creator sets it: stored as plain text (HTML stripped, trimmed) and shown instead of the service description', async () => {
    const res = await setDescription('  <b>Five</b> new arXiv papers on any topic, <i>paid per call</i>.  ');
    expect(res.status).toBe(200);
    expect(await stored()).toBe('Five new arXiv papers on any topic, paid per call.');
    expect(await listBrief()).toBe('Five new arXiv papers on any topic, paid per call.');
  });

  it('over 200 characters is refused (400) and nothing changes', async () => {
    const res = await setDescription('z'.repeat(201));
    expect(res.status).toBe(400);
    expect(await stored()).toBe('Five new arXiv papers on any topic, paid per call.');
  });

  it('only the on-chain creator can change it', async () => {
    const res = await setDescription('Hijacked', stranger);
    expect(res.status).toBe(403);
    expect(await stored()).toBe('Five new arXiv papers on any topic, paid per call.');
  });

  it('"" clears it: back to the service description; the token detail carries the same brief', async () => {
    expect((await setDescription('')).status).toBe(200);
    expect(await stored()).toBeNull();
    expect(await listBrief()).toBe('Latest 5 arXiv papers for a topic');
    const detail = await (await app.request(`/api/tokens/${ASSET}`)).json() as { brief: string | null; description: string | null };
    expect(detail).toMatchObject({ brief: 'Latest 5 arXiv papers for a topic', description: null });
  }, 120_000);   // the detail also tries on-chain reads against the test RPC (refused, retried)
});
