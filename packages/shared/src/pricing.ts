// Pool price math (display values; exact bigint, no floats). Verified against mainnet
// SIGHT buyback tx 0x4cc6c725…: sqrtPriceX96 126208693145960762050 → 2.5376e-6 USDC/SIGHT
// (≈ $2,537 market cap at 1e9 supply, the fixed $2,500 launch cap). See docs/VERIFICATION-market.md.

export const Q192 = 2n ** 192n;
export const PRICE_WAD = 10n ** 18n;

function pow10(n: number): bigint { return 10n ** BigInt(n); }

/**
 * Price of `asset` in human numeraire units, scaled by 1e18, from a v4 sqrtPriceX96.
 * sqrtPriceX96² / 2^192 is the raw price of currency0 in currency1 units.
 */
export function priceWadFromSqrtX96(
  sqrtPriceX96: bigint,
  assetIsCurrency0: boolean,
  assetDecimals: number,
  numeraireDecimals: number,
): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  if (assetIsCurrency0) {
    // human(c0 in c1) = sq/2^192 * 10^(dec0 - dec1)
    const e = 18 + assetDecimals - numeraireDecimals;
    return e >= 0 ? (sq * pow10(e)) / Q192 : sq / (Q192 * pow10(-e));
  }
  // asset is currency1: human(c1 in c0) = 2^192/sq * 10^(dec1 - dec0)
  const e = 18 + assetDecimals - numeraireDecimals;
  return e >= 0 ? (Q192 * pow10(e)) / sq : Q192 / (sq * pow10(-e));
}

/** v4 pools sort currencies by address. */
export function isCurrency0(token: string, other: string): boolean {
  return BigInt(token) < BigInt(other);
}

/** Multiply a 1e18-scaled value by a price with `decimals` decimals (e.g. Chainlink 1e8). */
export function mulPrice(wad: bigint, price: bigint, decimals: number): bigint {
  return (wad * price) / pow10(decimals);
}

/** Change between two 1e18 prices in basis points (null if no base). */
export function changeBps(now: bigint, base: bigint | null): number | null {
  if (base === null || base === 0n) return null;
  return Number(((now - base) * 10_000n) / base);
}
