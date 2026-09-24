/** Typed API client for the Astralaunch server. */
import { API_BASE } from '../env.js';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as any).error ?? `API ${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TokenSummary {
  asset:      string;
  name:       string;
  symbol:     string;
  creator:    string;
  router:     string;
  imageUrl:   string | null;
  launchedAt: string;
  service: { slug: string; name: string; description: string | null; priceUsdc: string } | null;
  metrics: { cleanRevenue30d: string; calls30d: number };
}

export interface TokenDetail {
  asset:       string;
  name:        string;
  symbol:      string;
  creator:     string;
  router:      string;
  imageUrl:    string | null;
  launchedAt:  string;
  description: string | null;
  website:     string | null;
  twitter:     string | null;
  service: {
    id:             string;
    slug:           string;
    name:           string;
    description:    string | null;
    priceUsdc:      string;
    requestSchema:  string | null;
    responseSchema: string | null;
  } | null;
  metrics: {
    cleanRevenue24h:  string;
    cleanRevenue7d:   string;
    cleanRevenue30d:  string;
    cleanPayers30d:   number;
  };
  onChain: {
    escrow: {
      usdcAccrued:     string;
      usdcClaimed:     string;
      recordedRevenue: string;
      forfeited:       boolean;
      launchTime:      number;
      forfeitAt:       number;
    } | null;
    buyback: {
      balanceUsdc:        string;
      buybackFromRevenue: string;
      buybackFromTrading: string;
      lastExecuteTime:    number;
    } | null;
    balanceLimitEnd: number | null;
  };
}

export interface Payment {
  id:         string;
  payer:      string;
  amountUsdc: string;
  txHash:     string | null;
  latencyMs:  number | null;
  createdAt:  string;
}

export interface HealthData {
  uptime:       number | null;
  totalChecks:  number;
  windowHours:  number;
  recentProbes: Array<{ ok: boolean; latencyMs: number | null; status: number | null; checkedAt: string }>;
}

export interface ExplorerData {
  services: Array<{
    id:          string;
    slug:        string;
    name:        string;
    description: string | null;
    asset:       string;
    router:      string;
    priceUsdc:   string;
    endpoint:    string;
    token:       { name: string; symbol: string; imageUrl: string | null } | null;
    stats30d:    { calls: number; settled: number; revenue: string; payers: number };
  }>;
  totals30d: { calls: number; revenue: string; payers: number };
  recentPayments: Array<{ asset: string; payer: string; amount: string; txHash: string | null; createdAt: string }>;
}

export interface CreatorData {
  creator: string;
  tokens: Array<{
    asset:       string;
    name:        string;
    symbol:      string;
    router:      string;
    imageUrl:    string | null;
    launchedAt:  string;
    service:     { id: string; slug: string; name: string; priceUsdc: string; active: boolean } | null;
    metrics30d:  { revenue: string; calls: number };
    escrow:      {
      claimableUsdc:   string;
      usdcAccrued:     string;
      usdcClaimed:     string;
      recordedRevenue: string;
      forfeited:       boolean;
      launchTime:      number;
      forfeitAt:       number;
    } | null;
    vesting: {
      totalAllocated: string;
      vestedNow:      string;
      vestingStart:   number;
      cliffEnd:       number;
      vestingEnd:     number;
    } | null;
  }>;
}

// ── API calls ─────────────────────────────────────────────────────────────────

export const api = {
  tokens: {
    list: (sort?: string)        => get<{ tokens: TokenSummary[] }>(`/api/tokens${sort ? `?sort=${sort}` : ''}`),
    get:  (asset: string)        => get<TokenDetail>(`/api/tokens/${asset}`),
    payments: (asset: string)    => get<{ payments: Payment[] }>(`/api/tokens/${asset}/payments`),
    health:   (asset: string)    => get<HealthData>(`/api/tokens/${asset}/health`),
    register: (body: {
      asset: string; name: string; symbol: string;
      imageUrl?: string; description?: string; website?: string; twitter?: string;
    }) => post<{ asset: string; router: string }>('/api/tokens', body),
  },
  services: {
    register: (body: object) => post<{ id: string; slug: string; router: string }>('/api/services', body),
    manifest: (slug: string) => get<object>(`/api/services/${slug}/manifest`),
  },
  explorer: () => get<ExplorerData>('/api/explorer'),
  // Creator requires X-Creator-Address header — use raw fetch
  creatorData: async (address: string): Promise<CreatorData> => {
    const res = await fetch(`${API_BASE}/api/creator/me`, {
      headers: { 'X-Creator-Address': address },
    });
    if (!res.ok) throw new Error(`API /api/creator/me → ${res.status}`);
    return res.json();
  },
};
