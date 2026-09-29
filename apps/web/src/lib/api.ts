/** Typed client for the Astralaunch server (read-only endpoints used by Phase B pages). */
import { API_BASE } from '../env.js';

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface Market {
  numeraire: string; numeraireSymbol: 'USDC' | 'MON' | '?';
  price: string | null; priceUsd: string | null; change24hBps: number | null; change7dBps?: number | null;
  spark7d?: number[]; supply: string; mcapUsd: string | null;
  volume24h: string; volume24hUsd: string | null; trades24h: number; usdPerNumeraire: string | null;
}
export interface Usage {
  cleanRevenueUsdc: string; rawRevenueUsdc: string; cleanPayers: number; paidCalls: number;
  volume: string; volumeUsd: string | null; ucr: string | null;
}
export interface TokenListItem {
  asset: string; name: string; symbol: string; creator: string; router: string; imageUrl: string | null;
  launchedAt: string; xHandle: string | null; description: string | null; verified: boolean; holders: number;
  service: { slug: string; name: string; description: string | null; priceUsdc: string; endpoint: string; examplePath: string | null } | null;
  market: Market | null; usage30d: Usage | null;
}
export interface TokenDetail extends Omit<TokenListItem, 'service' | 'usage30d'> {
  website: string | null; twitter: string | null; launcher: string; poolId: string; numeraire: string; decimals: number;
  service: { id: string; slug: string; name: string; description: string | null; priceUsdc: string; requestSchema: string | null; responseSchema: string | null; endpoint: string; examplePath: string | null } | null;
  usage30d: Usage | null; usageAll: Usage | null;
  serviceHealth: { successRate: number | null; latencyP50Ms: number | null; latencyP95Ms: number | null; uptime7d: number | null; calls7d: number } | null;
  serviceUpdatedAt: string | null;
  creatorSummary: {
    escrow: { symbol: string; claimable: string | null; usdcAccrued: string; usdcClaimed: string; recordedRevenue: string; forfeitAt: number; forfeited: boolean } | null;
    vesting: { total: string; vested: string; start: number; cliffEnd: number; end: number } | null;
  };
  onChain: { buyback: { balanceUsdc: string; buybackFromRevenue: string; buybackFromTrading: string; lastExecuteTime: number } | null };
}
export interface Candle {
  time: number; open: string; high: string; low: string; close: string;
  openUsd: string | null; highUsd: string | null; lowUsd: string | null; closeUsd: string | null;
  volume: string; volumeUsd: string | null; trades: number; buybacks: number;
}
export interface Candles { tf: string; numeraireSymbol: string; usdPerNumeraire: string | null; supply: string; launchPrice: string | null; candles: Candle[] }
export interface Trade {
  id: number; side: 'buy' | 'sell' | 'buyback'; isBuyback: boolean; assetAmount: string; numeraireAmount: string;
  price: string | null; priceUsd: string | null; valueUsd: string | null; trader: string; sender: string; txHash: string;
  blockNumber: number; timestamp: number;
}
export interface Holders { holderCount: number; supply: string; holders: { address: string; label: string | null; balance: string; pctBps: number }[] }
export interface Payment { payer: string; amountUsdc: string; txHash: string; timestamp: number; class: 'clean' | 'not_facilitator' | 'creator' | 'contract'; payerServices: number }
export interface Stats { servicesLive: number; paidCalls: number; paidToProvidersUsdc: string; tokens: number }
export interface LeaderCreator {
  rank: number; creator: string; tokens: { asset: string; symbol: string; name: string }[];
  cleanRevenueUsdc: string; rawRevenueUsdc: string; paidCalls: number; holders: number; bestUcr: string | null;
}
export interface CreatorDash {
  wallet: string;
  tokens: {
    asset: string; name: string; symbol: string; imageUrl: string | null; numeraireSymbol: string; launchedAt: string; poolId: string;
    tradingFees: { estimated: boolean; numeraire: string; asset: string } | null;
    escrow: { claimable: string | null; claimableSymbol: string; usdcAccrued: string; usdcClaimed: string; recordedRevenue: string; forfeitAt: number; forfeited: boolean } | null;
    vesting: { total: string; released: string; releasable: string; locked: string; start: number; cliffEnd: number; end: number } | null;
  }[];
  services: { id: string; asset: string; slug: string; name: string; priceUsdc: string; upstreamUrl: string; active: boolean; updatedAt: string }[];
  recentRequests: { service: string | null; statusCode: number | null; upstreamStatus: number | null; latencyMs: number | null; charged: boolean; amountUsdc: string; errorCode: string | null; settleTxHash: string | null; createdAt: string }[];
}

/** GET /api/tokens filters (server: services/tokenList.ts) and their chip labels, in display order. */
export type TokenFilter = 'with-revenue' | 'verified' | 'new' | 'high-ucr' | 'no-service';
export const TOKEN_FILTERS: { slug: TokenFilter; label: string }[] = [
  { slug: 'with-revenue', label: 'With revenue' }, { slug: 'verified', label: 'Verified' }, { slug: 'new', label: 'New' },
  { slug: 'high-ucr', label: 'High UCR' }, { slug: 'no-service', label: 'No service yet' },
];
export type TokenSort = 'revenue' | 'price' | 'change24h' | 'mcap' | 'ucr' | 'calls';
export interface TokenListParams {
  filter?: TokenFilter | 'all'; sort?: TokenSort; dir?: 'asc' | 'desc'; q?: string; limit?: number; offset?: number; days?: 7 | 30 | 90;
}
export interface TokenListPage {
  tokens: TokenListItem[]; total: number; counts: Record<'all' | TokenFilter, number>; limit: number; offset: number;
}
function listQuery(p: TokenListParams): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') qs.set(k, String(v));
  return qs.toString();
}

export const api = {
  tokens:      (days = 30) => get<{ tokens: TokenListItem[] }>(`/api/tokens?sort=clean_revenue_30d&limit=100&days=${days}`),
  /** Filtered, sorted page of listed tokens with total and per-filter counts. */
  tokenList:   (p: TokenListParams) => get<TokenListPage>(`/api/tokens?${listQuery(p)}`),
  token:       (a: string) => get<TokenDetail>(`/api/tokens/${a}`),
  candles:     (a: string, tf: string) => get<Candles>(`/api/tokens/${a}/candles?tf=${tf}`),
  trades:      (a: string) => get<{ numeraireSymbol: string; trades: Trade[] }>(`/api/tokens/${a}/trades?limit=50`),
  holders:     (a: string) => get<Holders>(`/api/tokens/${a}/holders?limit=50`),
  payments:    (a: string) => get<{ payments: Payment[] }>(`/api/tokens/${a}/payments?source=classified&limit=20`),
  stats:       () => get<Stats>('/api/stats'),
  leaderboard: (period: string) => get<{ creators: LeaderCreator[] }>(`/api/leaderboard?group=creators&period=${period}`),
  creator:     (w: string) => get<CreatorDash>(`/api/creator/${w}`),
};
