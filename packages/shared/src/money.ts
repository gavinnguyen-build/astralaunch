// Money helpers — bigint only, no floats in USDC math (CLAUDE.md rule 9).

const USDC_DECIMALS = 6n;
const TOKEN_DECIMALS = 18n;
const USDC_UNIT = 10n ** USDC_DECIMALS;
const TOKEN_UNIT = 10n ** TOKEN_DECIMALS;

/** Parse human-readable USDC string to raw bigint (6 dec). */
export function parseUsdc(human: string): bigint {
  const [int, frac = ''] = human.split('.');
  const fracPadded = frac.slice(0, 6).padEnd(6, '0');
  return BigInt(int) * USDC_UNIT + BigInt(fracPadded);
}

/** Format raw USDC bigint (6 dec) to human-readable string. */
export function formatUsdc(raw: bigint): string {
  const whole = raw / USDC_UNIT;
  const frac  = (raw % USDC_UNIT).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

/** Parse human-readable token string to raw bigint (18 dec). */
export function parseToken(human: string): bigint {
  const [int, frac = ''] = human.split('.');
  const fracPadded = frac.slice(0, 18).padEnd(18, '0');
  return BigInt(int) * TOKEN_UNIT + BigInt(fracPadded);
}

/** Format raw token bigint (18 dec) to human-readable string (up to 6 decimal places). */
export function formatToken(raw: bigint, places = 6): string {
  const whole = raw / TOKEN_UNIT;
  const frac  = (raw % TOKEN_UNIT).toString().padStart(18, '0').slice(0, places);
  return `${whole}.${frac}`;
}

/** Apply bps split and return [recipient, remainder]. */
export function applyBps(total: bigint, bps: bigint): [bigint, bigint] {
  const share = (total * bps) / 10_000n;
  return [share, total - share];
}
