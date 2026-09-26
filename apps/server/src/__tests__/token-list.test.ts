/** GET /api/tokens list logic (services/tokenList.ts): filters, counts, search, sort, paging, query parsing. */
import { describe, it, expect } from 'vitest';
import {
  listTokens, tokenListQuerySchema, compareRows, NEW_TOKEN_WINDOW_MS, type ListRow, type TokenListQuery,
} from '../services/tokenList.js';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const DAY = 86_400_000;

let n = 0;
function row(o: Partial<ListRow> & { rev?: string; ucr?: string | null; calls?: number; price?: string | null; chg?: number | null; mcap?: string | null; ageDays?: number } = {}): ListRow {
  n += 1;
  const { rev = '0', ucr = null, calls = 0, price = null, chg = null, mcap = null, ageDays = 30, ...rest } = o;
  return {
    asset: `0x${n.toString(16).padStart(40, '0')}`, name: `Token ${n}`, symbol: `T${n}`, creator: `0x${'c'.repeat(40)}`,
    xHandle: null, launchedAt: new Date(NOW - ageDays * DAY), verified: false, service: { name: `svc ${n}` },
    market: { priceUsd: price, change24hBps: chg, mcapUsd: mcap },
    usage30d: { cleanRevenueUsdc: rev, ucr, paidCalls: calls },
    ...rest,
  };
}
const q = (o: Partial<TokenListQuery> = {}) => tokenListQuerySchema.parse(o);

describe('listTokens', () => {
  const rows = [
    row({ symbol: 'AAA', rev: '12.5', ucr: '1.4', calls: 30, price: '0.0000025', chg: 120, mcap: '2500', verified: true }),
    row({ symbol: 'BBB', rev: '300', ucr: '0.2', calls: 900, price: '0.01', chg: -50, mcap: '10000', ageDays: 2 }),
    row({ symbol: 'CCC', rev: '0', ucr: null, calls: 0, price: null, chg: null, mcap: null, service: null, ageDays: 1 }),
    row({ symbol: 'DDD', rev: '0.02', ucr: '1', calls: 1, price: '0.5', chg: 0, mcap: '500000', xHandle: 'dddlabs' }),
  ];

  it('counts every filter (after search) and the total of the active one', () => {
    const r = listTokens(rows, q({ filter: 'with-revenue' }), NOW);
    expect(r.counts).toEqual({ all: 4, 'with-revenue': 3, verified: 1, new: 2, 'high-ucr': 2, 'no-service': 1 });
    expect(r.total).toBe(3);
    expect(r.tokens.map((t) => t.symbol)).toEqual(['BBB', 'AAA', 'DDD']);   // revenue desc by default
  });

  it('filters: new (< 7 days), high UCR (>= 1), no service, verified', () => {
    expect(listTokens(rows, q({ filter: 'new' }), NOW).tokens.map((t) => t.symbol).sort()).toEqual(['BBB', 'CCC']);
    expect(listTokens(rows, q({ filter: 'high-ucr' }), NOW).tokens.map((t) => t.symbol).sort()).toEqual(['AAA', 'DDD']);
    expect(listTokens(rows, q({ filter: 'no-service' }), NOW).tokens.map((t) => t.symbol)).toEqual(['CCC']);
    expect(listTokens(rows, q({ filter: 'verified' }), NOW).tokens.map((t) => t.symbol)).toEqual(['AAA']);
    const edge = row({ launchedAt: new Date(NOW - NEW_TOKEN_WINDOW_MS) });
    expect(listTokens([edge], q({ filter: 'new' }), NOW).total).toBe(0);
  });

  it('search matches symbol, name, service, creator and X handle, case-insensitive; counts follow the search', () => {
    expect(listTokens(rows, q({ q: 'bbb' }), NOW).tokens.map((t) => t.symbol)).toEqual(['BBB']);
    expect(listTokens(rows, q({ q: 'DDDLABS' }), NOW).tokens.map((t) => t.symbol)).toEqual(['DDD']);
    const r = listTokens(rows, q({ q: 'aaa', filter: 'with-revenue' }), NOW);
    expect(r.counts.all).toBe(1);
    expect(r.counts['with-revenue']).toBe(1);
    expect(r.counts['no-service']).toBe(0);
  });

  it('sorts each column both ways; missing values always last', () => {
    const syms = (s: TokenListQuery['sort'], dir: 'asc' | 'desc') => listTokens(rows, q({ sort: s, dir }), NOW).tokens.map((t) => t.symbol);
    expect(syms('price', 'asc')).toEqual(['AAA', 'BBB', 'DDD', 'CCC']);
    expect(syms('price', 'desc')).toEqual(['DDD', 'BBB', 'AAA', 'CCC']);
    expect(syms('change24h', 'desc')).toEqual(['AAA', 'DDD', 'BBB', 'CCC']);
    expect(syms('mcap', 'desc')).toEqual(['DDD', 'BBB', 'AAA', 'CCC']);
    expect(syms('ucr', 'desc')).toEqual(['AAA', 'DDD', 'BBB', 'CCC']);
    expect(syms('ucr', 'asc')).toEqual(['BBB', 'DDD', 'AAA', 'CCC']);
    expect(syms('calls', 'asc')).toEqual(['CCC', 'DDD', 'AAA', 'BBB']);
    expect(syms('revenue', 'asc')).toEqual(['CCC', 'DDD', 'AAA', 'BBB']);
    expect(syms('new', 'desc')).toEqual(['CCC', 'BBB', 'AAA', 'DDD']);   // AAA/DDD same age: tie broken by asset
  });

  it('ties are stable (newest first, then asset), so pages never overlap', () => {
    const many = Array.from({ length: 60 }, (_, i) => row({ rev: String(i % 3), ageDays: i % 5 }));
    const all = listTokens(many, q({ limit: 100 }), NOW).tokens.map((t) => t.asset);
    const paged = [0, 25, 50].flatMap((offset) => listTokens(many, q({ limit: 25, offset }), NOW).tokens.map((t) => t.asset));
    expect(paged).toEqual(all);
    expect(new Set(paged).size).toBe(60);
  });

  it('pages over the whole ranking with the right total', () => {
    const many = Array.from({ length: 100 }, (_, i) => row({ rev: String(i + 1) }));
    const p2 = listTokens(many, q({ limit: 25, offset: 25 }), NOW);
    expect(p2.total).toBe(100);
    expect(p2.tokens).toHaveLength(25);
    expect(p2.tokens[0]!.usage30d!.cleanRevenueUsdc).toBe('75');   // rank 26 of revenue desc
    expect(listTokens(many, q({ limit: 25, offset: 100 }), NOW).tokens).toHaveLength(0);
  });

  it('compareRows orders nulls last in both directions', () => {
    const a = row({ price: null }), b = row({ price: '1' });
    expect(compareRows(a, b, 'price', 'asc')).toBeGreaterThan(0);
    expect(compareRows(a, b, 'price', 'desc')).toBeGreaterThan(0);
  });
});

describe('tokenListQuerySchema', () => {
  it('defaults: all tokens, revenue desc, 50 per page, 30 days', () => {
    expect(q()).toEqual({ filter: 'all', sort: 'revenue', dir: 'desc', q: '', limit: 50, offset: 0, days: 30 });
  });
  it('accepts the legacy sort=clean_revenue_30d as revenue', () => {
    expect(tokenListQuerySchema.parse({ sort: 'clean_revenue_30d' }).sort).toBe('revenue');
  });
  it('coerces query strings and rejects bad values', () => {
    expect(tokenListQuerySchema.parse({ limit: '25', offset: '50', days: '7' })).toMatchObject({ limit: 25, offset: 50, days: 7 });
    for (const bad of [{ limit: '0' }, { limit: '101' }, { offset: '-1' }, { days: '14' }, { sort: 'hype' }, { dir: 'up' }, { filter: 'hot' }, { q: 'x'.repeat(65) }]) {
      expect(tokenListQuerySchema.safeParse(bad).success).toBe(false);
    }
  });
});
