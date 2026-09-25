/**
 * Real data from the public arXiv API (export.arxiv.org, Atom feed). No key needed.
 * Results cached 10 min per topic (arXiv asks clients not to hammer the API).
 */
export interface Paper {
  title:     string;
  authors:   string[];
  link:      string;
  summary:   string;   // first sentence, ≤ 240 chars
  published: string;   // ISO date-time
}

export interface Digest {
  topic:     string;
  source:    'arXiv API (export.arxiv.org)';
  fetchedAt: string;
  cached:    boolean;
  papers:    Paper[];
}

export const ARXIV_ENDPOINT = 'https://export.arxiv.org/api/query';
export const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const FETCH_TIMEOUT_MS = 8_000;

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
const cache = new Map<string, { at: number; papers: Paper[] }>();

export function clearArxivCache() { cache.clear(); }

export async function digest(topic: string, fetchImpl: Fetch = fetch, now = Date.now()): Promise<Digest> {
  const key = topic.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return { topic, source: 'arXiv API (export.arxiv.org)', fetchedAt: new Date(hit.at).toISOString(), cached: true, papers: hit.papers };
  }
  const url = `${ARXIV_ENDPOINT}?search_query=${encodeURIComponent(`all:"${topic}"`)}` +
    '&sortBy=submittedDate&sortOrder=descending&start=0&max_results=5';
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'astralaunch-demo-services/0.1' } });
  if (!res.ok) throw new Error(`arXiv API returned ${res.status}`);
  const papers = parseArxivAtom(await res.text());
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now, papers });
  return { topic, source: 'arXiv API (export.arxiv.org)', fetchedAt: new Date(now).toISOString(), cached: false, papers };
}
