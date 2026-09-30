import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import feedDigestSchema from '../../schemas/feed-digest.json' with { type: 'json' };
import sightSignalsSchema from '../../schemas/sight-signals.json' with { type: 'json' };
import { createApp } from '../app.js';
import {
  createFeed, fetchPapers, oneLine, parseArxivAtom, FALLBACK_SOURCE, FETCH_TIMEOUT_MS, LIVE_SOURCE, REFRESH_EVERY_MS, USER_AGENT,
} from '../arxiv.js';
import { FALLBACK_FETCHED_AT, FALLBACK_PAPERS } from '../fallback.js';
import { signalsFor } from '../signals.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);
const validFeed = ajv.compile(feedDigestSchema);
const validSignals = ajv.compile(sightSignalsSchema);

const entry = (n: number) => `
  <entry>
    <id>http://arxiv.org/abs/2609.0${n}123v1</id>
    <updated>2026-09-2${n}T10:00:00Z</updated>
    <published>2026-09-2${n}T10:00:00Z</published>
    <title>Agent Payments &amp; Micro-Fees,
      Part ${n}</title>
    <summary>  We study pay-per-call APIs for agents. Second sentence is dropped.
    </summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <link href="http://arxiv.org/abs/2609.0${n}123v1" rel="alternate" type="text/html"/>
  </entry>`;
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>ArXiv Query</title>${[1, 2, 3, 4, 5, 6].map(entry).join('')}</feed>`;

function fakeFetch(body = ATOM, status = 200) {
  return vi.fn(async (_url: string | URL | Request) => new Response(body, { status }));
}

describe('arXiv feed digest', () => {

  it('parses title, authors, https link, one-line summary; max 5', () => {
    const papers = parseArxivAtom(ATOM);
    expect(papers).toHaveLength(5);
    expect(papers[0]).toEqual({
      title: 'Agent Payments & Micro-Fees, Part 1',
      authors: ['Ada Lovelace', 'Alan Turing'],
      link: 'https://arxiv.org/abs/2609.01123v1',
      summary: 'We study pay-per-call APIs for agents.',
      published: '2026-09-21T10:00:00.000Z',
    });
    expect(oneLine('x'.repeat(500))).toHaveLength(240);
  });

  it('queries arXiv for the latest 5 by submission date, with a descriptive User-Agent and a 30 s timeout', async () => {
    const f = fakeFetch();
    const papers = await fetchPapers('llm agents', f as unknown as typeof fetch);
    const [u, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    const url = new URL(u);
    expect(url.origin + url.pathname).toBe('https://export.arxiv.org/api/query');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      search_query: 'all:"llm agents"', sortBy: 'submittedDate', sortOrder: 'descending', max_results: '5',
    });
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^Astralaunch-demo-services\/1\.0 \(\+https:\/\/astralaunch\.xyz/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(FETCH_TIMEOUT_MS).toBe(30_000);
    expect(papers).toHaveLength(5);
  });
});

/** A fetch that never answers until its signal aborts (the timeout), like arXiv on a bad day. */
const hangingFetch = () => vi.fn((_u: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason))));
const quiet = () => {};

describe('feed digest cache (stale-while-revalidate)', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'feed-cache-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('cache hit returns immediately with cached: true and its fetchedAt, while arXiv hangs', async () => {
    let t = 1_800_000_000_000;
    const f = vi.fn(fakeFetch());
    const feed = createFeed({ fetchImpl: f as unknown as typeof fetch, now: () => t, log: quiet });
    const first = await feed.digest('Agent Payments');
    expect(first).toMatchObject({ source: LIVE_SOURCE, cached: false, fetchedAt: new Date(t).toISOString() });

    t += REFRESH_EVERY_MS + 1;   // stale: a background refresh starts, but the answer does not wait for it
    f.mockImplementation(hangingFetch());
    const started = performance.now();
    const res = await createApp(feed).request('/feed/digest?topic=agent%20payments');
    expect(performance.now() - started).toBeLessThan(200);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ cached: true, source: LIVE_SOURCE, fetchedAt: first.fetchedAt, papers: first.papers });
    expect(validFeed(body), JSON.stringify(validFeed.errors)).toBe(true);
  });

  it('timeout with a cached result → the cached result (200), cache unchanged', async () => {
    let t = 1_800_000_000_000;
    const f = vi.fn(fakeFetch());
    const feed = createFeed({ fetchImpl: f as unknown as typeof fetch, now: () => t, timeoutMs: 30, log: quiet });
    const first = await feed.digest('monad');
    t += REFRESH_EVERY_MS;
    f.mockImplementation(hangingFetch());
    const res = await createApp(feed).request('/feed/digest?topic=monad');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cached: true, fetchedAt: first.fetchedAt, source: LIVE_SOURCE });
    await feed.idle();                                            // the background refresh timed out
    expect(f).toHaveBeenCalledTimes(2);
    expect(await feed.digest('monad')).toMatchObject({ cached: true, fetchedAt: first.fetchedAt });
    expect(f).toHaveBeenCalledTimes(2);                           // failed attempt counts: no retry within 10 min
  });

  it('timeout without a cached result → the labelled fallback sample (200, schema-valid, 5 real arXiv papers)', async () => {
    const f = hangingFetch();
    const feed = createFeed({ fetchImpl: f as unknown as typeof fetch, timeoutMs: 30, log: quiet });
    const res = await createApp(feed).request('/feed/digest?topic=zk%20rollups');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ topic: 'zk rollups', source: FALLBACK_SOURCE, fetchedAt: FALLBACK_FETCHED_AT });
    expect(body.papers).toEqual(FALLBACK_PAPERS);
    expect(FALLBACK_PAPERS).toHaveLength(5);
    expect(FALLBACK_FETCHED_AT).toBe('2026-09-30T17:26:57.000Z');   // real capture time of the bundled set
    for (const p of FALLBACK_PAPERS) expect(p.link).toMatch(/^https:\/\/arxiv\.org\/abs\/\d{4}\.\d{5}v\d$/);
    expect(validFeed(body), JSON.stringify(validFeed.errors)).toBe(true);

    // arXiv errors (non-2xx, network) are never a 5xx either; invalid requests still are a 400.
    for (const bad of [fakeFetch('down', 503), vi.fn(async () => { throw new TypeError('fetch failed'); })]) {
      const r = await createApp(createFeed({ fetchImpl: bad as unknown as typeof fetch, log: quiet })).request('/feed/digest?topic=monad');
      expect(r.status).toBe(200);
      expect((await r.json()).source).toBe(FALLBACK_SOURCE);
    }
    expect((await createApp(feed).request('/feed/digest')).status).toBe(400);
  });

  it('background refresh updates the cache and the file; the file survives a restart', async () => {
    let t = 1_800_000_000_000;
    const file = join(dir, 'sub', 'feed-cache.json');
    const f = vi.fn(fakeFetch());
    const feed = createFeed({ fetchImpl: f as unknown as typeof fetch, now: () => t, cacheFile: file, log: quiet });
    const old = await feed.digest('agent payments');

    t += REFRESH_EVERY_MS;
    const NEW = ATOM.replaceAll('Agent Payments &amp; Micro-Fees', 'Refreshed Paper');
    f.mockImplementation(fakeFetch(NEW));
    expect((await feed.digest('agent payments')).papers).toEqual(old.papers);   // stale answer first
    await feed.idle();
    const fresh = await feed.digest('agent payments');
    expect(fresh).toMatchObject({ cached: true, fetchedAt: new Date(t).toISOString() });
    expect(fresh.papers[0]!.title).toBe('Refreshed Paper, Part 1');

    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.entries[0].papers[0].title).toBe('Refreshed Paper, Part 1');
    const restarted = createFeed({ fetchImpl: hangingFetch() as unknown as typeof fetch, now: () => t, cacheFile: file, log: quiet });
    expect(await restarted.load()).toBe(1);
    expect(await restarted.digest('Agent Payments')).toMatchObject({ cached: true, papers: fresh.papers });
  });

  it('one refresh in flight per topic; a broken cache file is ignored; warm() fills the cache', async () => {
    const f = vi.fn(fakeFetch());
    const feed = createFeed({ fetchImpl: f as unknown as typeof fetch, log: quiet });
    const [a, b] = await Promise.all([feed.digest('monad'), feed.digest('MONAD')]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a.papers).toEqual(b.papers);

    const file = join(dir, 'feed-cache.json');
    writeFileSync(file, '{not json');
    const warmFeed = createFeed({ fetchImpl: f as unknown as typeof fetch, cacheFile: file, log: quiet });
    expect(await warmFeed.load()).toBe(0);
    await warmFeed.warm('agent payments');
    expect(await warmFeed.digest('agent payments')).toMatchObject({ cached: true, source: LIVE_SOURCE });
  });

  it('GET /feed/digest: 400 on a bad topic', async () => {
    expect((await createApp().request('/feed/digest')).status).toBe(400);
    expect((await createApp().request('/feed/digest?topic=' + encodeURIComponent('<script>'))).status).toBe(400);
  });
});

describe('sight signals (sample data)', () => {
  it('is labeled sample data, deterministic per handle, and matches the schema', async () => {
    const app = createApp();
    const a1 = await (await app.request('/sight/signals?handle=nullsight')).json();
    const a2 = await (await app.request('/sight/signals?handle=@NullSight')).json();
    const b  = await (await app.request('/sight/signals?handle=someone_else')).json();
    expect(a1.source).toBe('sample data');
    expect(a1.notice).toMatch(/Sample data/);
    expect(a1.signals.map((s: { id: string }) => s.id)).toEqual(a2.signals.map((s: { id: string }) => s.id)); // case-insensitive seed
    expect(a1.signals.map((s: { id: string }) => s.id)).not.toEqual(b.signals.map((s: { id: string }) => s.id));
    expect(a1.signals.map((s: { rank: number }) => s.rank)).toEqual([1, 2, 3, 4, 5]);
    const scores = a1.signals.map((s: { score: number }) => s.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    for (const r of [a1, a2, b]) expect(validSignals(r), JSON.stringify(validSignals.errors)).toBe(true);
    expect(signalsFor('nullsight')).toEqual(signalsFor('nullsight'));
  });

  it('rejects invalid handles', async () => {
    expect((await createApp().request('/sight/signals')).status).toBe(400);
    expect((await createApp().request('/sight/signals?handle=way_too_long_handle_x')).status).toBe(400);
  });

  it('serves both JSON schemas', async () => {
    const r = await createApp().request('/schemas/sight-signals.json');
    expect((await r.json()).properties.source.const).toBe('sample data');
  });

  it('health is served at the root and under each service prefix (gateway probes {upstreamUrl}/health)', async () => {
    const app = createApp(createFeed({ fetchImpl: fakeFetch() as unknown as typeof fetch }));
    for (const p of ['/health', '/sight/health', '/feed/health']) expect((await app.request(p)).status).toBe(200);
  });
});
