/**
 * Keeper poll-interval guard (D23: a too-fast keeper drained 2.8 MON).
 * Below KEEPER_MIN_INTERVAL_S is allowed only against a local RPC (Anvil fork).
 * Pure module (no env reads at import), so tests exercise the real code.
 */
import { KEEPER_DEFAULT_INTERVAL_S, KEEPER_MIN_INTERVAL_S } from '@astralaunch/shared';

/** True only when the RPC URL's *host* is loopback. A "localhost" elsewhere in the URL does not count. */
export function isLocalRpcUrl(rpcUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rpcUrl).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Effective poll interval. `configured` is the raw env value; empty/unset → default. */
export function resolveInterval(rpcUrl: string, configured: string | undefined): { seconds: number; clamped: boolean } {
  const value = Number(configured || KEEPER_DEFAULT_INTERVAL_S);
  if (!isLocalRpcUrl(rpcUrl) && !(value >= KEEPER_MIN_INTERVAL_S)) {
    return { seconds: KEEPER_MIN_INTERVAL_S, clamped: true };
  }
  return { seconds: value, clamped: false };
}
