// AUTO-GENERATED from forge artifacts — do not edit by hand.
// Regenerate: pnpm -F @astralaunch/indexer gen-abis
//
// Generated: 2026-09-25

// ── AstralaunchRegistry ────────────────────────────────────────────────
export const registeredEvent = {
  type: 'event',
  name: 'Registered',
  inputs: [
    { name: 'asset', type: 'address', indexed: true },
    { name: 'creator', type: 'address', indexed: true },
    { name: 'router', type: 'address', indexed: true },
    { name: 'poolId', type: 'bytes32', indexed: false },
    { name: 'numeraire', type: 'address', indexed: false },
    { name: 'initializer', type: 'address', indexed: false },
    { name: 'timestamp', type: 'uint256', indexed: false },
  ],
} as const;

// ── RevenueRouter ──────────────────────────────────────────────────────
export const distributedEvent = {
  type: 'event',
  name: 'Distributed',
  inputs: [
    { name: 'asset', type: 'address', indexed: true },
    { name: 'total', type: 'uint256', indexed: false },
    { name: 'providerAmt', type: 'uint256', indexed: false },
    { name: 'costAmt', type: 'uint256', indexed: false },
    { name: 'buybackAmt', type: 'uint256', indexed: false },
    { name: 'treasuryAmt', type: 'uint256', indexed: false },
  ],
} as const;

// ── FeeEscrow ──────────────────────────────────────────────────────────
export const escrowFeeCollectedEvent = {
  type: 'event',
  name: 'FeeCollected',
  inputs: [
    { name: 'asset', type: 'address', indexed: true },
    { name: 'usdcDelta', type: 'uint256', indexed: false },
    { name: 'tokenDelta', type: 'uint256', indexed: false },
    { name: 'wmonDelta', type: 'uint256', indexed: false },
  ],
} as const;

export const revenueRecordedEvent = {
  type: 'event',
  name: 'RevenueRecorded',
  inputs: [
    { name: 'asset', type: 'address', indexed: true },
    { name: 'amt', type: 'uint256', indexed: false },
    { name: 'newTotal', type: 'uint256', indexed: false },
  ],
} as const;

export const claimedEvent = {
  type: 'event',
  name: 'Claimed',
  inputs: [
    { name: 'asset', type: 'address', indexed: true },
    { name: 'creator', type: 'address', indexed: true },
    { name: 'amt', type: 'uint256', indexed: false },
  ],
} as const;

export const claimedWmonEvent = {
  type: 'event',
  name: 'ClaimedWmon',
  inputs: [
    { name: 'asset', type: 'address', indexed: true },
    { name: 'creator', type: 'address', indexed: true },
    { name: 'wmonAmt', type: 'uint256', indexed: false },
    { name: 'usdValue', type: 'uint256', indexed: false },
  ],
} as const;

export const forfeitedEvent = {
  type: 'event',
  name: 'Forfeited',
  inputs: [
    { name: 'asset', type: 'address', indexed: true },
    { name: 'usdcMoved', type: 'uint256', indexed: false },
    { name: 'tokenMoved', type: 'uint256', indexed: false },
    { name: 'wmonMoved', type: 'uint256', indexed: false },
  ],
} as const;

// ── BuybackVault ───────────────────────────────────────────────────────
export const vaultFeeCollectedEvent = {
  type: 'event',
  name: 'FeeCollected',
  inputs: [
    { name: 'asset', type: 'address', indexed: true },
    { name: 'numeraireDelta', type: 'uint256', indexed: false },
    { name: 'tokenDelta', type: 'uint256', indexed: false },
  ],
} as const;

export const buybackExecutedEvent = {
  type: 'event',
  name: 'BuybackExecuted',
  inputs: [
    { name: 'asset', type: 'address', indexed: true },
    { name: 'usdcIn', type: 'uint256', indexed: false },
    { name: 'tokensBurned', type: 'uint256', indexed: false },
    { name: 'sourceTag', type: 'uint8', indexed: false },
  ],
} as const;

export const tokensBurnedEvent = {
  type: 'event',
  name: 'TokensBurned',
  inputs: [
    { name: 'asset', type: 'address', indexed: true },
    { name: 'amt', type: 'uint256', indexed: false },
  ],
} as const;

// ── PlatformFeeReceiver ────────────────────────────────────────────────
export const pfrCollectedEvent = {
  type: 'event',
  name: 'Collected',
  inputs: [
    { name: 'asset', type: 'address', indexed: true },
    { name: 'usdcForwarded', type: 'uint256', indexed: false },
    { name: 'tokenForwarded', type: 'uint256', indexed: false },
    { name: 'numeraireForwarded', type: 'uint256', indexed: false },
  ],
} as const;

// ── USDC (ERC-20 Transfer) ───────────────────────────────────────────────────
export const transferEvent = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const;

// ── Grouped ABIs per contract set ────────────────────────────────────────────

/** Static contract set: Registry + Escrow + Vault + PFR */
export const staticEvents = [
  registeredEvent,
  escrowFeeCollectedEvent,
  revenueRecordedEvent,
  claimedEvent,
  claimedWmonEvent,
  forfeitedEvent,
  vaultFeeCollectedEvent,
  buybackExecutedEvent,
  tokensBurnedEvent,
  pfrCollectedEvent,
] as const;

/** Router contract set: RevenueRouter instances */
export const routerEvents = [distributedEvent] as const;

/** USDC transfer contract set */
export const usdcEvents = [transferEvent] as const;
