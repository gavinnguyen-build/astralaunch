/**
 * Optimistic trade rows. The indexer shows a swap after its next market poll; until then the page
 * shows the user's own trade decoded from the swap receipt's PoolManager Swap event, labelled
 * "confirming", and drops it as soon as the API returns a trade with the same tx hash.
 * Mapping mirrors the server (services/market.ts trades): side from the asset delta, price from the
 * post-swap sqrtPriceX96, value = |numeraire delta| × USD rate. Display only.
 */
import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, parseEventLogs, type Address, type TransactionReceipt } from 'viem';
import { POOL_MANAGER } from '@astralaunch/shared';
import type { Trade } from './api.js';
import type { PoolKey } from './trade.js';

export type ShownTrade = Trade & { pending?: boolean };

/** After a trade: poll every 2 s for 30 s, then back to the normal interval. */
export const BURST_MS = 30_000;
export const BURST_EVERY_MS = 2_000;
export const burstInterval = (burstUntil: number, normal: number | false, now = Date.now()) => (now < burstUntil ? BURST_EVERY_MS : normal);

const swapEvent = [{
  type: 'event', name: 'Swap', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true },
    { name: 'amount0', type: 'int128', indexed: false }, { name: 'amount1', type: 'int128', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false }, { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'tick', type: 'int24', indexed: false }, { name: 'fee', type: 'uint24', indexed: false },
  ],
}] as const;

export const poolIdOf = (k: PoolKey) => keccak256(encodeAbiParameters(
  parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'), [k as never]));

const units = (v: bigint, dec: number) => Number(v < 0n ? -v : v) / 10 ** dec;

/** The trade this receipt made in `key`'s pool, or null if it has no matching Swap event. */
export function tradeFromReceipt(a: {
  receipt: Pick<TransactionReceipt, 'logs' | 'transactionHash' | 'blockNumber'>; key: PoolKey; asset: Address;
  numeraireDecimals: number; trader: Address; usdPerNumeraire: number | null; nowS?: number;
}): ShownTrade | null {
  const id = poolIdOf(a.key).toLowerCase();
  const pm = getAddress(POOL_MANAGER);
  const ev = parseEventLogs({ abi: swapEvent, logs: a.receipt.logs as never, strict: true })
    .find((l) => getAddress(l.address) === pm && l.args.id.toLowerCase() === id);
  if (!ev) return null;
  const assetIs0 = getAddress(a.key.currency0) === getAddress(a.asset);
  const assetDelta = assetIs0 ? ev.args.amount0 : ev.args.amount1;
  const numDelta = assetIs0 ? ev.args.amount1 : ev.args.amount0;
  const p = (Number(ev.args.sqrtPriceX96) / 2 ** 96) ** 2;              // raw currency1 per raw currency0
  const price = (assetIs0 ? p : 1 / p) * 10 ** (18 - a.numeraireDecimals); // numeraire per asset (asset has 18 dp)
  const numAmt = units(numDelta, a.numeraireDecimals);
  const usd = a.usdPerNumeraire;
  return {
    id: -Number(a.receipt.blockNumber), side: assetDelta > 0n ? 'buy' : 'sell', isBuyback: false,
    assetAmount: String(units(assetDelta, 18)), numeraireAmount: String(numAmt),
    price: String(price), priceUsd: usd != null ? String(price * usd) : null, valueUsd: usd != null ? String(numAmt * usd) : null,
    trader: a.trader.toLowerCase(), sender: ev.args.sender.toLowerCase(), txHash: a.receipt.transactionHash,
    blockNumber: Number(a.receipt.blockNumber), timestamp: a.nowS ?? Math.floor(Date.now() / 1000), pending: true,
  };
}

/** Indexed trades first-class; pending rows only until the API returns the same tx hash (max 10 min). */
export function mergeTrades(indexed: Trade[], pending: ShownTrade[], nowS = Math.floor(Date.now() / 1000)): { list: ShownTrade[]; stillPending: ShownTrade[] } {
  const seen = new Set(indexed.map((t) => t.txHash.toLowerCase()));
  const stillPending = pending.filter((t) => !seen.has(t.txHash.toLowerCase()) && nowS - t.timestamp < 600);
  return { list: [...stillPending, ...indexed], stillPending };
}
