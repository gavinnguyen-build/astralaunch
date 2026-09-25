/**
 * Keeper liveness: tick bookkeeping, a GET /health endpoint, and tick-failure alerts.
 *
 * Healthy = a tick succeeded within HEALTH_STALE_FACTOR × poll interval. Before the
 * first success the process start time is the baseline, so a fresh keeper is not
 * reported unhealthy while its first tick is still running.
 *
 * A tick "succeeds" when it runs to the end, including when the spend guard stops
 * jobs early: that is the keeper protecting its wallet, not a fault. It "fails"
 * when it throws (DB or RPC down, bad config) and then an alert is sent.
 */
import { createServer, type Server } from 'node:http';
import { formatEther } from 'viem';
import { html, sendTelegramAlert } from './telegram.js';

export const HEALTH_STALE_FACTOR = 3;
/** Identical failure alerts are sent at most once per this window. */
export const FAILURE_ALERT_REPEAT_MS = 60 * 60 * 1000;

export interface HealthReport {
  ok: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  secondsSinceSuccess: number | null;
  staleAfterSeconds: number;
  targets: number | null;
  walletMon: string | null;
}

export class KeeperHealth {
  private readonly startedAt: number;
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastError: string | null = null;
  private consecutiveFailures = 0;
  private targets: number | null = null;
  private balanceWei: bigint | null = null;
  private lastAlert: { message: string; at: number } | null = null;

  constructor(
    private readonly pollIntervalS: number,
    now: number = Date.now(),
    private readonly alert: (msg: ReturnType<typeof html>) => Promise<void> = sendTelegramAlert,
  ) {
    this.startedAt = now;
  }

  get staleAfterMs(): number {
    return HEALTH_STALE_FACTOR * this.pollIntervalS * 1000;
  }

  recordBalance(balanceWei: bigint): void {
    this.balanceWei = balanceWei;
  }

  async recordSuccess(targets: number, now: number = Date.now()): Promise<void> {
    const recovered = this.consecutiveFailures > 0;
    const failures = this.consecutiveFailures;
    this.lastSuccessAt = now;
    this.targets = targets;
    this.consecutiveFailures = 0;
    this.lastAlert = null;
    if (recovered) {
      await this.alert(html`✅ <b>Keeper recovered</b> after ${failures} failed tick(s).`);
    }
  }

  async recordFailure(err: unknown, now: number = Date.now()): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.lastFailureAt = now;
    this.lastError = message;
    this.consecutiveFailures += 1;

    const repeat = this.lastAlert?.message === message && now - this.lastAlert.at < FAILURE_ALERT_REPEAT_MS;
    if (repeat) return;
    this.lastAlert = { message, at: now };
    await this.alert(
      html`🚨 <b>Keeper tick failed</b> (${this.consecutiveFailures} in a row)\n<code>${message.slice(0, 500)}</code>`,
    );
  }

  report(now: number = Date.now()): HealthReport {
    const baseline = this.lastSuccessAt ?? this.startedAt;
    return {
      ok: now - baseline <= this.staleAfterMs,
      lastSuccessAt: this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt).toISOString(),
      lastFailureAt: this.lastFailureAt === null ? null : new Date(this.lastFailureAt).toISOString(),
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      secondsSinceSuccess: this.lastSuccessAt === null ? null : Math.floor((now - this.lastSuccessAt) / 1000),
      staleAfterSeconds: this.staleAfterMs / 1000,
      targets: this.targets,
      walletMon: this.balanceWei === null ? null : formatEther(this.balanceWei),
    };
  }
}

/** GET /health → 200 when healthy, 503 when stale. Everything else → 404. */
export function startHealthServer(health: KeeperHealth, port: number, host = '0.0.0.0'): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.split('?')[0] === '/health') {
      const report = health.report();
      res.writeHead(report.ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(report));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  server.listen(port, host, () => console.log(`[keeper] health on http://${host}:${port}/health`));
  return server;
}
