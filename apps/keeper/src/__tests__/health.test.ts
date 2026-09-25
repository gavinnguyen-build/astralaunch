import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';

vi.mock('../telegram.js', () => ({
  sendTelegramAlert: vi.fn().mockResolvedValue(undefined),
  html: (strings: TemplateStringsArray, ...values: unknown[]) =>
    ({ text: strings.reduce((o, s, i) => o + s + (i < values.length ? String(values[i]) : ''), '') }),
}));

import { KeeperHealth, startHealthServer, FAILURE_ALERT_REPEAT_MS } from '../health.js';

const POLL_S = 600;
const T0 = 1_800_000_000_000;
const MIN = 60_000;

function make() {
  const alert = vi.fn().mockResolvedValue(undefined);
  const health = new KeeperHealth(POLL_S, T0, alert);
  return { health, alert, text: (i: number) => (alert.mock.calls[i]![0] as { text: string }).text };
}

describe('KeeperHealth.report', () => {
  it('is healthy during startup, before the first tick, for 3× the poll interval', () => {
    const { health } = make();
    expect(health.report(T0 + 29 * MIN).ok).toBe(true);
    expect(health.report(T0 + 31 * MIN).ok).toBe(false);
  });

  it('fails when no tick succeeded within 3× the poll interval', async () => {
    const { health } = make();
    await health.recordSuccess(2, T0 + MIN);
    expect(health.report(T0 + MIN + 3 * POLL_S * 1000).ok).toBe(true);
    expect(health.report(T0 + MIN + 3 * POLL_S * 1000 + 1).ok).toBe(false);
  });

  it('failures do not reset the clock; only a success does', async () => {
    const { health } = make();
    await health.recordSuccess(1, T0);
    await health.recordFailure(new Error('rpc down'), T0 + 10 * MIN);
    await health.recordFailure(new Error('rpc down'), T0 + 20 * MIN);
    await health.recordFailure(new Error('rpc down'), T0 + 30 * MIN);
    const r = health.report(T0 + 31 * MIN);
    expect(r.ok).toBe(false);
    expect(r.consecutiveFailures).toBe(3);
    expect(r.lastError).toBe('rpc down');
  });

  it('reports last success time, target count and wallet MON balance', async () => {
    const { health } = make();
    health.recordBalance(1_500_000_000_000_000_000n);
    await health.recordSuccess(4, T0);
    const r = health.report(T0 + 5_000);
    expect(r).toMatchObject({
      ok: true, lastSuccessAt: new Date(T0).toISOString(), secondsSinceSuccess: 5,
      targets: 4, walletMon: '1.5', staleAfterSeconds: 1800,
    });
  });
});

describe('tick failure alerts', () => {
  it('alerts when a tick throws', async () => {
    const { health, alert, text } = make();
    await health.recordFailure(new Error('DATABASE_URL unreachable'), T0);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(text(0)).toMatch(/Keeper tick failed/);
    expect(text(0)).toMatch(/DATABASE_URL unreachable/);
  });

  it('throttles an identical error to once per hour, but alerts on a new error', async () => {
    const { health, alert } = make();
    await health.recordFailure(new Error('rpc down'), T0);
    await health.recordFailure(new Error('rpc down'), T0 + 10 * MIN);
    expect(alert).toHaveBeenCalledTimes(1);
    await health.recordFailure(new Error('db down'), T0 + 20 * MIN);
    expect(alert).toHaveBeenCalledTimes(2);
    await health.recordFailure(new Error('db down'), T0 + 20 * MIN + FAILURE_ALERT_REPEAT_MS);
    expect(alert).toHaveBeenCalledTimes(3);
  });

  it('sends one recovery alert after failures, none after a normal success', async () => {
    const { health, alert, text } = make();
    await health.recordSuccess(1, T0);
    expect(alert).not.toHaveBeenCalled();
    await health.recordFailure(new Error('x'), T0 + MIN);
    await health.recordSuccess(1, T0 + 2 * MIN);
    expect(alert).toHaveBeenCalledTimes(2);
    expect(text(1)).toMatch(/recovered<\/b> after 1 failed tick/);
  });
});

describe('GET /health', () => {
  it('returns 200 when healthy, 503 when stale, 404 elsewhere', async () => {
    const health = new KeeperHealth(POLL_S, Date.now(), vi.fn());
    const server = startHealthServer(health, 0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await health.recordSuccess(3);
      const ok = await fetch(`${base}/health`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, targets: 3 });

      const stale = new KeeperHealth(POLL_S, Date.now() - 4 * POLL_S * 1000, vi.fn());
      const server2 = startHealthServer(stale, 0, '127.0.0.1');
      await new Promise(r => server2.once('listening', r));
      const res = await fetch(`http://127.0.0.1:${(server2.address() as AddressInfo).port}/health`);
      expect(res.status).toBe(503);
      server2.close();

      expect((await fetch(`${base}/other`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
