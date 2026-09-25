/**
 * X-style "signals" for a handle, from BUNDLED SAMPLE DATA (no X API, no live data).
 * Deterministic per handle: the ranking is seeded by sha256(lowercase handle).
 */
import { createHash } from 'node:crypto';

export type SignalKind = 'mention' | 'reply' | 'quote' | 'trend' | 'follow';

interface SampleSignal { id: string; kind: SignalKind; text: string; weight: number }

// Sample data. `{h}` is replaced by the handle.
const SAMPLE: SampleSignal[] = [
  { id: 's01', kind: 'mention', text: '@{h} mentioned alongside x402 pay-per-call APIs', weight: 0.92 },
  { id: 's02', kind: 'quote',   text: 'A thread on agent payments quoted @{h}', weight: 0.88 },
  { id: 's03', kind: 'reply',   text: 'Builders replying to @{h} about Monad latency', weight: 0.81 },
  { id: 's04', kind: 'trend',   text: '"usage-backed tokens" trending near @{h}\'s followers', weight: 0.77 },
  { id: 's05', kind: 'follow',  text: 'Three infra accounts started following @{h}', weight: 0.74 },
  { id: 's06', kind: 'mention', text: '@{h} tagged in a USDC settlement demo', weight: 0.70 },
  { id: 's07', kind: 'quote',   text: 'Research account quoted @{h} on onchain revenue', weight: 0.68 },
  { id: 's08', kind: 'reply',   text: 'Question for @{h}: how are service fees split?', weight: 0.65 },
  { id: 's09', kind: 'trend',   text: '"buyback and burn" discussion overlapping @{h}', weight: 0.61 },
  { id: 's10', kind: 'mention', text: '@{h} listed in a weekly roundup of agent tooling', weight: 0.58 },
  { id: 's11', kind: 'follow',  text: 'A developer-relations account followed @{h}', weight: 0.55 },
  { id: 's12', kind: 'reply',   text: 'Feature request sent to @{h}: JSON schema for responses', weight: 0.52 },
  { id: 's13', kind: 'quote',   text: '@{h}\'s post on rate limits was quoted twice', weight: 0.49 },
  { id: 's14', kind: 'trend',   text: '"pay per request" rising in @{h}\'s network', weight: 0.46 },
  { id: 's15', kind: 'mention', text: '@{h} credited in an open-source changelog', weight: 0.43 },
  { id: 's16', kind: 'reply',   text: 'Benchmark shared in reply to @{h}', weight: 0.40 },
];

export const SAMPLE_NOTICE =
  'Sample data bundled with Astralaunch demo-services. Not live X data; ranking is deterministic per handle.';

export function signalsFor(handleRaw: string) {
  const handle = handleRaw.replace(/^@/, '');
  const seed = createHash('sha256').update(handle.toLowerCase()).digest();
  const ranked = SAMPLE
    .map((s, i) => ({ s, score: Math.round(s.weight * (40 + (seed[i]! / 255) * 60) * 100) / 100 }))
    .sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id))
    .slice(0, 5);
  return {
    handle,
    source: 'sample data' as const,
    notice: SAMPLE_NOTICE,
    signals: ranked.map(({ s, score }, i) => ({
      rank: i + 1, id: s.id, kind: s.kind, text: s.text.replaceAll('{h}', handle), score,
    })),
  };
}
