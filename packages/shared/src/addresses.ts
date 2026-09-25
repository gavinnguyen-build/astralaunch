// Verified Monad mainnet addresses.
// Source: docs/VERIFICATION-anvil.md, docs/VERIFICATION-real.md, Doppler SDK, on-chain checks.
// All addresses must have a source comment. Never add unverified addresses for mainnet use.

/** Monad mainnet chain ID. */
export const MONAD_CHAIN_ID = 143;
/** EIP-155 network string used in x402 PaymentRequirements. */
export const MONAD_NETWORK = 'eip155:143' as const;

// ── Doppler protocol (Monad mainnet) ──────────────────────────────────────────
/** Airlock: verified 2026-09-23 via Doppler SDK ADDRESSES[143].airlock */
export const AIRLOCK = '0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12';
/** V4ScheduledMulticurveInitializer: SDK ADDRESSES[143].v4ScheduledMulticurveInitializer */
export const INITIALIZER = '0xCe3099B2F07029b086E5e92a1573C5f5A3071783';
/** Uniswap v4 PoolManager on Monad: SDK ADDRESSES[143].poolManager */
export const POOL_MANAGER = '0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e';
/**
 * Universal Router (Uniswap v4) on Monad: Doppler SDK 1.0.43 ADDRESSES[143].universalRouter.
 * Verified on-chain 2026-09-26: 19,499 bytes of code, poolManager() == POOL_MANAGER.
 * (The previous value 0xf70536B6BfFeF1f8a48A09AC86E92AEb15dBD6A7 has no code on Monad.)
 */
export const UNIVERSAL_ROUTER = '0x0D97Dc33264bfC1c226207428A79b26757fb9dc3';
/** Uniswap v4 Quoter on Monad: Doppler SDK 1.0.43 ADDRESSES[143].uniswapV4Quoter; poolManager() verified 2026-09-26. */
export const V4_QUOTER = '0xa222Dd357A9076d1091Ed6Aa2e16C9742dD26891';
/** Permit2 on Monad: SDK ADDRESSES[143].permit2 */
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/** DopplerHook (constant across V4ScheduledMulticurveInitializer launches): verified D16 */
export const DOPPLER_HOOK = '0x580ca49389d83b019d07E17e99454f2F218e2dc0';
/** NoOp migrator: SDK ADDRESSES[143].noOpMigrator */
export const NOMIG = '0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731';
/** Dead address — used as governance for noOp tokens (decisions.md D1) */
export const NOGOV = '0x000000000000000000000000000000000000dEaD';

// ── Airlock owner ─────────────────────────────────────────────────────────────
/** Airlock owner: SDK ADDRESSES[143] — must be a beneficiary with >= 5% share */
export const AIRLOCK_OWNER = '0x21E2ce70511e4FE542a97708e89520471DAa7A66';

// ── Tokens ────────────────────────────────────────────────────────────────────
/** USDC on Monad mainnet: verified via on-chain name()="USD Coin", decimals()=6 */
export const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
/** WMON (Wrapped MON) on Monad mainnet: from Doppler SDK weth field for chain 143 */
export const WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';


// ── Chainlink oracles ─────────────────────────────────────────────────────────
/** Chainlink MON/USD price feed on Monad mainnet, 8 decimals — AstralaunchConstants.sol */
export const MON_USD_ORACLE = '0xBcD78f76005B7515837af6b50c7C52BCf73822fb';

/** Supported numeraire addresses for Astralaunch launches. */
export const SUPPORTED_NUMERAIRES = [USDC, WMON] as const;

/** Numeraire decimals lookup. */
export const NUMERAIRE_DECIMALS: Record<string, number> = {
  [USDC]: 6,
  [WMON]: 18,
};

// ── x402 facilitator ──────────────────────────────────────────────────────────
/**
 * Official Monad x402 facilitator URL.
 * Fallback to env var X402_FACILITATOR_URL.
 */
export const X402_FACILITATOR_URL_DEFAULT = 'https://x402-facilitator.molandak.org';
/**
 * Known facilitator submitter addresses (clean-revenue signal, O8).
 * Maintain this list; alert on settlements from unknown addresses.
 * Source: observed facilitator settlement txs.
 */
export const FACILITATOR_SUBMITTERS: ReadonlyArray<string> = [
  '0x7f6a2850669202519f0FE8aa912451238820Db86',
];

// ── Launch fee (off-chain enforced) ───────────────────────────────────────────
/**
 * Treasury wallet that receives the native-MON launch fee (checked off-chain by
 * POST /api/launch-fee/verify). Source: provided by Tun in the launch-fee spec,
 * 2026-09-25 (docs/decisions.md D-LF1). Receives plain MON transfers only.
 */
export const LAUNCH_FEE_TREASURY = '0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C';

// ── Block explorer ─────────────────────────────────────────────────────────────
/** Monad mainnet explorer (paths: /address/<addr>, /tx/<hash>, /token/<asset>). Source: Tun, 2026-09-26. */
export const MONAD_EXPLORER_URL = 'https://monadscan.com';
