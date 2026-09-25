import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import feedDigestSchema from '../../schemas/feed-digest.json' with { type: 'json' };
import sightSignalsSchema from '../../schemas/sight-signals.json' with { type: 'json' };
import { createApp } from '../app.js';
import { clearArxivCache, digest, oneLine, parseArxivAtom, CACHE_TTL_MS } from '../arxiv.js';
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
  beforeEach(() => clearArxivCache());

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

  it('queries arXiv for the latest 5 by submission date, then serves from cache for 10 min', async () => {
    const f = fakeFetch();
    const t0 = 1_800_000_000_000;
    const a = await digest('llm agents', f as unknown as typeof fetch, t0);
    const url = new URL(String(f.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://export.arxiv.org/api/query');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      search_query: 'all:"llm agents"', sortBy: 'submittedDate', sortOrder: 'descending', max_results: '5',
    });
    expect(a.cached).toBe(false);

    const b = await digest('LLM Agents', f as unknown as typeof fetch, t0 + CACHE_TTL_MS - 1);
    expect(b.cached).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);

    await digest('llm agents', f as unknown as typeof fetch, t0 + CACHE_TTL_MS);
    expect(f).toHaveBeenCalledTimes(2);
    expect(validFeed(a), JSON.stringify(validFeed.errors)).toBe(true);
    expect(validFeed(b), JSON.stringify(validFeed.errors)).toBe(true);
  });

  it('GET /feed/digest: 200 matches the schema; 400 on bad topic; 502 when arXiv fails', async () => {
    const ok = await createApp(fakeFetch() as unknown as typeof fetch).request('/feed/digest?topic=monad');
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(validFeed(body), JSON.stringify(validFeed.errors)).toBe(true);

    expect((await createApp().request('/feed/digest')).status).toBe(400);
    expect((await createApp().request('/feed/digest?topic=' + encodeURIComponent('<script>'))).status).toBe(400);
    clearArxivCache();
    expect((await createApp(fakeFetch('down', 503) as unknown as typeof fetch).request('/feed/digest?topic=monad')).status).toBe(502);
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
});
