/**
 * Real data from the public arXiv API (export.arxiv.org, Atom feed). No key needed.
 * arXiv can take ~16 s to answer, so results are served stale-while-revalidate (see createFeed).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { FALLBACK_FETCHED_AT, FALLBACK_PAPERS } from './fallback.js';

export interface Paper {
  title:     string;
  authors:   string[];
  link:      string;
  summary:   string;   // first sentence, ≤ 240 chars
  published: string;   // ISO date-time
}

export const LIVE_SOURCE = 'arXiv API (export.arxiv.org)';
export const FALLBACK_SOURCE = 'fallback sample';

export interface Digest {
  topic:     string;
  source:    typeof LIVE_SOURCE | typeof FALLBACK_SOURCE;
  fetchedAt: string;
  cached:    boolean;
  papers:    Paper[];
}

export const ARXIV_ENDPOINT = 'https://export.arxiv.org/api/query';
/** At most one arXiv request per topic in this window (arXiv asks clients not to hammer the API). */
export const REFRESH_EVERY_MS = 10 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 30_000;
export const USER_AGENT = 'Astralaunch-demo-services/1.0 (+https://astralaunch.xyz; arXiv feed digest demo)';
const CACHE_MAX = 200;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
                   : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]!) : undefined;
}

/** First sentence of an abstract, capped at 240 chars. */
export function oneLine(abstract: string): string {
  const first = abstract.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? abstract;
  return first.length <= 240 ? first : `${first.slice(0, 237).trimEnd()}...`;
}

/** Parse an arXiv Atom feed into at most `max` papers. */
export function parseArxivAtom(xml: string, max = 5): Paper[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return entries.slice(0, max).flatMap((e) => {
    const title = tag(e, 'title');
    const id = tag(e, 'id');
    if (!title || !id) return [];
    const authors = [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) => decode(m[1]!));
    const published = new Date(tag(e, 'published') ?? 0).toISOString();
    return [{ title, authors, link: id.replace(/^http:/, 'https:'), summary: oneLine(tag(e, 'summary') ?? ''), published }];
  });
}

type Fetch = typeof fetch;

/** One arXiv query: the latest 5 papers for `topic`. Throws on a non-2xx, a network error or the timeout. */
export async function fetchPapers(topic: string, fetchImpl: Fetch = fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<Paper[]> {
  const url = `${ARXIV_ENDPOINT}?search_query=${encodeURIComponent(`all:"${topic}"`)}` +
    '&sortBy=submittedDate&sortOrder=descending&start=0&max_results=5';
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`arXiv API returned ${res.status}`);
  return parseArxivAtom(await res.text());
}

interface Entry { topic: string; at: number; papers: Paper[] }

const paperSchema = z.object({
  title: z.string().min(1), authors: z.array(z.string().min(1)), link: z.string().regex(/^https?:\/\/arxiv\.org\//),
  summary: z.string().max(240), published: z.string(),
}).strict();
const fileSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({ key: z.string(), topic: z.string(), at: z.number(), papers: z.array(paperSchema).max(5) })),
});

export interface FeedOptions {
  fetchImpl?: Fetch;
  now?: () => number;
  /** JSON file the cache is persisted to (survives restarts). null = memory only. */
  cacheFile?: string | null;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export type Feed = ReturnType<typeof createFeed>;

/**
 * Stale-while-revalidate cache per topic (case-insensitive):
 * - a cached result is returned at once ("cached": true, its "fetchedAt"); if it is 10 min old or more, one background
 *   refresh starts (one in flight per topic, at most one attempt per topic every 10 min, failed ones included);
 * - no cached result: wait for arXiv (up to the 30 s timeout); if that fails, the bundled fallback sample.
 * digest() never throws: arXiv problems never become a 5xx.
 */
export function createFeed(opts: FeedOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const log = opts.log ?? ((m: string) => console.log(`[feed] ${m}`));
  const cache = new Map<string, Entry>();
  const lastAttempt = new Map<string, number>();
  const inflight = new Map<string, Promise<Entry | null>>();
  let writing: Promise<void> = Promise.resolve();

  const keyOf = (topic: string) => topic.trim().toLowerCase();
  const due = (key: string) => now() - Math.max(cache.get(key)?.at ?? -Infinity, lastAttempt.get(key) ?? -Infinity) >= REFRESH_EVERY_MS;

  function persist(): Promise<void> {
    const file = opts.cacheFile;
    if (!file) return Promise.resolve();
    const data = JSON.stringify({ version: 1, entries: [...cache].map(([key, e]) => ({ key, ...e })) });
    writing = writing.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, data);
        await rename(`${file}.tmp`, file);   // atomic: a crash never leaves a half-written cache
      } catch (e) { log(`cache write failed: ${(e as Error).message}`); }
    });
    return writing;
  }

  /** Fetch `topic` from arXiv once; joins the refresh already in flight. Resolves null on failure. */
  function refresh(topic: string): Promise<Entry | null> {
    const key = keyOf(topic);
    const running = inflight.get(key);
    if (running) return running;
    lastAttempt.set(key, now());
    const p = Promise.resolve().then(async () => {
      try {
        const entry = { topic: topic.trim(), at: now(), papers: await fetchPapers(topic, fetchImpl, timeoutMs) };
        cache.delete(key);
        cache.set(key, entry);
        if (cache.size > CACHE_MAX) cache.delete([...cache].sort((a, b) => a[1].at - b[1].at)[0]![0]);
        await persist();
        return entry;
      } catch (e) {
        log(`arXiv refresh for "${topic}" failed: ${(e as Error).message}`);
        return null;
      }
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  const live = (topic: string, e: Entry, cached: boolean): Digest =>
    ({ topic, source: LIVE_SOURCE, fetchedAt: new Date(e.at).toISOString(), cached, papers: e.papers });

  return {
    async digest(topic: string): Promise<Digest> {
      const key = keyOf(topic);
      const hit = cache.get(key);
      if (hit) {
        if (due(key)) void refresh(topic);
        return live(topic, hit, true);
      }
      if (inflight.has(key) || due(key)) {
        const e = await refresh(topic);
        if (e) return live(topic, e, false);
      }
      return fallbackDigest(topic);
    },
    /** Start a refresh if one is due (e.g. on startup); resolves when it is done. */
    async warm(topic: string): Promise<void> {
      if (due(keyOf(topic))) await refresh(topic);
    },
    /** Load the persisted cache. A missing or unreadable file starts empty. */
    async load(): Promise<number> {
      if (!opts.cacheFile) return 0;
      let raw: string;
      try { raw = await readFile(opts.cacheFile, 'utf8'); } catch { return 0; }
      const parsed = fileSchema.safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
      if (!parsed.success) { log(`ignoring unreadable cache file ${opts.cacheFile}`); return 0; }
      for (const { key, ...e } of parsed.data.entries.slice(-CACHE_MAX)) cache.set(key, e);
      return cache.size;
    },
    /** Resolves when every refresh in flight and every cache write has finished (tests, shutdown). */
    async idle(): Promise<void> {
      await Promise.all([...inflight.values()]);
      await writing;
    },
  };
}

/** The bundled sample: real arXiv papers on agent payments, clearly labelled. */
export function fallbackDigest(topic: string): Digest {
  return { topic, source: FALLBACK_SOURCE, fetchedAt: FALLBACK_FETCHED_AT, cached: true, papers: FALLBACK_PAPERS.map((p) => ({ ...p })) };
}
