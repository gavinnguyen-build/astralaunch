import { decodeEventLog, type Log, type Hex } from 'viem';
import {
  registeredEvent,
  distributedEvent,
  escrowFeeCollectedEvent,
  revenueRecordedEvent,
  claimedEvent,
  forfeitedEvent,
  vaultFeeCollectedEvent,
  buybackExecutedEvent,
  tokensBurnedEvent,
  pfrCollectedEvent,
  transferEvent,
  staticEvents,
  routerEvents,
  usdcEvents,
} from './abis.js';

// ── Row types (match Drizzle insert shapes) ──────────────────────────────────

export interface BaseRow {
  chainId:     number;
  txHash:      string;
  logIndex:    number;
  blockNumber: bigint;
  timestamp:   bigint;
}

export interface RegistrationRow extends BaseRow {
  type: 'registration';
  asset:   string;
  creator: string;
  router:  string;
  poolId:  string;
}

export interface UsdcTransferRow extends BaseRow {
  type: 'usdc_transfer';
  fromAddr:             string;
  toAddr:               string;
  value:                string;
  txFrom:               string;   // transaction sender (facilitator or EOA)
  isFacilitatorSettled: boolean;  // true if txFrom ∈ FACILITATOR_SUBMITTERS
}

export interface DistributionRow extends BaseRow {
  type: 'distribution';
  asset:       string;
  total:       string;
  providerAmt: string;
  costAmt:     string;
  buybackAmt:  string;
  treasuryAmt: string;
}

export interface FeeCollectionRow extends BaseRow {
  type: 'fee_collection';
  contract:   string;
  asset:      string;
  usdcDelta:  string;
  tokenDelta: string;
}

export interface RevenueRecordedRow extends BaseRow {
  type: 'revenue_recorded';
  asset:    string;
  amount:   string;
  newTotal: string;
}

export interface EscrowClaimRow extends BaseRow {
  type: 'escrow_claim';
  asset:   string;
  creator: string;
  amount:  string;
}

export interface EscrowForfeitRow extends BaseRow {
  type: 'escrow_forfeit';
  asset:      string;
  usdcMoved:  string;
  tokenMoved: string;
}

export interface BuybackRow extends BaseRow {
  type: 'buyback';
  asset:        string;
  usdcIn:       string;
  tokensBurned: string;
  sourceTag:    number;
}

export interface BurnRow extends BaseRow {
  type: 'burn';
  asset:  string;
  amount: string;
}

export interface PfrCollectionRow extends BaseRow {
  type: 'pfr_collection';
  asset:          string;
  usdcForwarded:  string;
  tokenForwarded: string;
}

export type DecodedRow =
  | RegistrationRow
  | UsdcTransferRow
  | DistributionRow
  | FeeCollectionRow
  | RevenueRecordedRow
  | EscrowClaimRow
  | EscrowForfeitRow
  | BuybackRow
  | BurnRow
  | PfrCollectionRow;

// ── Decoder ──────────────────────────────────────────────────────────────────

function base(log: Log, chainId: number, blockTimestamp: bigint): BaseRow {
  return {
    chainId,
    txHash:      log.transactionHash!,
    logIndex:    log.logIndex!,
    blockNumber: log.blockNumber!,
    timestamp:   blockTimestamp,
  };
}

/**
 * Decode a static contract set log (Registry, Escrow, Vault, PFR).
 * The emitting address determines which contract's FeeCollected is which.
 */
export function decodeStaticLog(
  log: Log,
  chainId: number,
  blockTimestamp: bigint,
  escrowAddr: string,
  vaultAddr: string,
): DecodedRow | null {
  try {
    const decoded = decodeEventLog({
      abi: staticEvents,
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
    });

    const b = base(log, chainId, blockTimestamp);
    const addr = log.address.toLowerCase();

    switch (decoded.eventName) {
      case 'Registered':
        return {
          ...b,
          type: 'registration',
          asset:   (decoded.args as any).asset.toLowerCase(),
          creator: (decoded.args as any).creator.toLowerCase(),
          router:  (decoded.args as any).router.toLowerCase(),
          poolId:  (decoded.args as any).poolId,
        };

      case 'FeeCollected':
        return {
          ...b,
          type: 'fee_collection',
          contract: addr === escrowAddr.toLowerCase() ? 'escrow' : 'vault',
          asset:      (decoded.args as any).asset.toLowerCase(),
          usdcDelta:  (decoded.args as any).usdcDelta.toString(),
          tokenDelta: (decoded.args as any).tokenDelta.toString(),
        };

      case 'RevenueRecorded':
        return {
          ...b,
          type: 'revenue_recorded',
          asset:    (decoded.args as any).asset.toLowerCase(),
          amount:   (decoded.args as any).amt.toString(),
          newTotal: (decoded.args as any).newTotal.toString(),
        };

      case 'Claimed':
        return {
          ...b,
          type: 'escrow_claim',
          asset:   (decoded.args as any).asset.toLowerCase(),
          creator: (decoded.args as any).creator.toLowerCase(),
          amount:  (decoded.args as any).amt.toString(),
        };

      case 'Forfeited':
        return {
          ...b,
          type: 'escrow_forfeit',
          asset:      (decoded.args as any).asset.toLowerCase(),
          usdcMoved:  (decoded.args as any).usdcMoved.toString(),
          tokenMoved: (decoded.args as any).tokenMoved.toString(),
        };

      case 'BuybackExecuted':
        return {
          ...b,
          type: 'buyback',
          asset:        (decoded.args as any).asset.toLowerCase(),
          usdcIn:       (decoded.args as any).usdcIn.toString(),
          tokensBurned: (decoded.args as any).tokensBurned.toString(),
          sourceTag:    Number((decoded.args as any).sourceTag),
        };

      case 'TokensBurned':
        return {
          ...b,
          type: 'burn',
          asset:  (decoded.args as any).asset.toLowerCase(),
          amount: (decoded.args as any).amt.toString(),
        };

      case 'Collected':
        return {
          ...b,
          type: 'pfr_collection',
          asset:          (decoded.args as any).asset.toLowerCase(),
          usdcForwarded:  (decoded.args as any).usdcForwarded.toString(),
          tokenForwarded: (decoded.args as any).tokenForwarded.toString(),
        };

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Decode a router log (Distributed). */
export function decodeRouterLog(
  log: Log,
  chainId: number,
  blockTimestamp: bigint,
): DistributionRow | null {
  try {
    const decoded = decodeEventLog({
      abi: routerEvents,
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
    });

    if (decoded.eventName !== 'Distributed') return null;

    return {
      ...base(log, chainId, blockTimestamp),
      type: 'distribution',
      asset:       (decoded.args as any).asset.toLowerCase(),
      total:       (decoded.args as any).total.toString(),
      providerAmt: (decoded.args as any).providerAmt.toString(),
      costAmt:     (decoded.args as any).costAmt.toString(),
      buybackAmt:  (decoded.args as any).buybackAmt.toString(),
      treasuryAmt: (decoded.args as any).treasuryAmt.toString(),
    };
  } catch {
    return null;
  }
}

/** Decode a USDC Transfer log. Enriched with tx sender + facilitator flag. */
export function decodeTransferLog(
  log: Log,
  chainId: number,
  blockTimestamp: bigint,
  txFrom: string = '',
  isFacilitatorSettled: boolean = false,
): UsdcTransferRow | null {
  try {
    const decoded = decodeEventLog({
      abi: usdcEvents,
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
    });

    if (decoded.eventName !== 'Transfer') return null;

    return {
      ...base(log, chainId, blockTimestamp),
      type: 'usdc_transfer',
      fromAddr: (decoded.args as any).from.toLowerCase(),
      toAddr:   (decoded.args as any).to.toLowerCase(),
      value:    (decoded.args as any).value.toString(),
      txFrom,
      isFacilitatorSettled,
    };
  } catch {
    return null;
  }
}
