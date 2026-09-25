import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseEther } from 'viem';

// chain.ts / jobs.ts need RPC + keys at import; the monitors only use these bits.
vi.mock('../chain.js', () => ({
  REGISTRY: '0x6B3A79C723AB69f8938C87209E1D9730c739e00c',
  getPendingInitializerProposal: vi.fn(async () => null),
}));
vi.mock('../jobs.js', () => ({ pfrAbi: [], registryAdminAbi: [] }));

const { html, escapeHtml, htmlToPlain, sendTelegramAlert, monitorTreasuryProposal } = await import('../telegram.js');
const { assertCanSpend, alertIfExpensive, SpendGuardError, _resetForTest } = await import('../spend.js');

const ADDR = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
// Every character that broke Markdown mode, plus HTML specials.
const NASTY = `MAX_MON_PER_DAY exceeded by ${ADDR}: 0.000320298002242086 MON *bold* _x_ [link](y) \`tick\` a<b & c>d`;

type Sent = { chat_id: string; text: string; parse_mode?: string };

/** Minimal check of Telegram HTML: only <b>/<code> tags, balanced, no bare & or <. */
function assertValidTelegramHtml(text: string) {
  const tags = [...text.matchAll(/<(\/?)([a-z]+)>/g)];
  const stack: string[] = [];
  for (const [, close, name] of tags) {
    expect(['b', 'code']).toContain(name);
    if (close) expect(stack.pop()).toBe(name);
    else stack.push(name!);
  }
  expect(stack).toEqual([]);
  const withoutTags = text.replace(/<\/?(b|code)>/g, '');
  expect(withoutTags).not.toMatch(/[<>]/);
  expect(withoutTags).not.toMatch(/&(?!(amp|lt|gt);)/);
}

describe('telegram alerts', () => {
  const sent: Sent[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sent.length = 0;
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.stubEnv('TELEGRAM_CHAT_ID', '42');
    fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    _resetForTest();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('escapes addresses, underscores, decimals and HTML specials in HTML mode', async () => {
    await sendTelegramAlert(html`⚠️ <b>Keeper Spend Guard Blocked</b>\n${NASTY}\nContract: <code>${ADDR}</code>`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.parse_mode).toBe('HTML');
    assertValidTelegramHtml(sent[0]!.text);
    expect(sent[0]!.text).toContain('MAX_MON_PER_DAY exceeded by ' + ADDR + ': 0.000320298002242086 MON *bold* _x_ [link](y) `tick`');
    expect(sent[0]!.text).toContain('a&lt;b &amp; c&gt;d');
    expect(sent[0]!.text).toContain(`<code>${ADDR}</code>`);
    expect(htmlToPlain(html`<b>x</b> ${'a<b & c'}`)).toBe('x a<b & c');
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });

  it('monitor messages are valid HTML with escaped values', async () => {
    const client = { readContract: vi.fn(async () => [ADDR, 1_790_000_000n]) };
    await monitorTreasuryProposal('0x10bC2220716738E8Aef57b9CC72101c190acf240', client as any);
    expect(sent[0]!.parse_mode).toBe('HTML');
    assertValidTelegramHtml(sent[0]!.text);
    expect(sent[0]!.text).toContain(`Proposed: <code>${ADDR}</code>`);
  });

  it('spend-guard and expensive-tx alerts (underscores, decimals) are valid HTML', async () => {
    await expect(assertCanSpend(parseEther('10'), parseEther('0.01'))).rejects.toBeInstanceOf(SpendGuardError);
    await alertIfExpensive(parseEther('0.123456789'), `collect:escrow:${ADDR}`);
    expect(sent).toHaveLength(2);
    for (const m of sent) { expect(m.parse_mode).toBe('HTML'); assertValidTelegramHtml(m.text); }
    expect(sent[1]!.text).toContain(`collect:escrow:${ADDR}: 0.123456789 MON`);
  });

  it('falls back to plain text when Telegram rejects the entities', async () => {
    fetchMock.mockImplementationOnce(async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }), { status: 400 });
    });
    await sendTelegramAlert(html`<b>Alert</b> ${NASTY}`);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.parse_mode).toBeUndefined();
    expect(sent[1]!.text).toBe(`Alert ${NASTY}`);
  });

  it('plain strings are sent without a parse mode', async () => {
    await sendTelegramAlert(`dry run ${NASTY}`);
    expect(sent[0]).toMatchObject({ text: `dry run ${NASTY}` });
    expect(sent[0]!.parse_mode).toBeUndefined();
  });

  it('never throws: network error, API 500, hang (timeout)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(sendTelegramAlert(html`x ${ADDR}`)).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(sendTelegramAlert(html`x`)).resolves.toBeUndefined();

    fetchMock.mockImplementationOnce((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(init.signal!.reason));
    }));
    const t0 = Date.now();
    await expect(sendTelegramAlert(html`x`, 50)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('alert failures never change keeper job outcomes', async () => {
    fetchMock.mockRejectedValue(new Error('telegram down'));
    // The guard still raises its own SpendGuardError (not a Telegram error)...
    await expect(assertCanSpend(parseEther('10'), parseEther('0.01'))).rejects.toBeInstanceOf(SpendGuardError);
    // ...and an alert-only path completes normally.
    await expect(alertIfExpensive(parseEther('1'), 'buyback:x')).resolves.toBeUndefined();
  });

  it('no credentials: logs, sends nothing', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendTelegramAlert(html`<b>x</b> ${'a_b'}`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[telegram] (no credentials) x a_b');
  });
});
