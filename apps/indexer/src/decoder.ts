import { decodeEventLog, type Log, type Hex } from 'viem';
import {
  registeredEvent,
  distributedEvent,
  escrowFeeCollectedEvent,
  revenueRecordedEvent,
  claimedEvent,
  claimedWmonEvent,
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
import { poolManagerEvents } from './v4abis.js';
import { priceWadFromSqrtX96 } from '@astralaunch/shared';
import { ASSET_DECIMALS, type PoolMeta } from './pools.js';

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
  asset:       string;
  creator:     string;
  router:      string;
  poolId:      string;
  numeraire:   string;
  initializer: string;
  /** register() tx sender — filled by the indexer, '' from the decoder. Launch-fee identity (D-LF3). */
  launcher:    string;
  /** ERC-20 name/symbol/decimals — filled by the indexer before writing (D-TK1). */
  token?:      { name: string; symbol: string; decimals: number };
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
  contract:       string;
  asset:          string;
  usdcDelta:      string;
  tokenDelta:     string;
  wmonDelta:      string;   // escrow: wmonDelta from event; vault: '0'
  numeraireDelta: string;   // vault: numeraireDelta from event; escrow: '0'
}

export interface RevenueRecordedRow extends BaseRow {
  type: 'revenue_recorded';
  asset:    string;
  amount:   string;
  newTotal: string;
}

export interface EscrowClaimRow extends BaseRow {
  type: 'escrow_claim';
  asset:      string;
  creator:    string;
  amount:     string;   // Claimed: USDC amount; ClaimedWmon: '0'
  wmonAmount: string;   // ClaimedWmon: WMON amount; Claimed: '0'
  usdValue:   string;   // ClaimedWmon: USD equivalent; Claimed: '0'
}

export interface EscrowForfeitRow extends BaseRow {
  type: 'escrow_forfeit';
  asset:      string;
  usdcMoved:  string;
  tokenMoved: string;
  wmonMoved:  string;
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
  asset:              string;
  usdcForwarded:      string;
  tokenForwarded:     string;
  numeraireForwarded: string;
}

export interface SwapRow extends BaseRow {
  type: 'swap';
  poolId:         string;
  asset:          string;
  numeraire:      string;
  sender:         string;
  txFrom:         string;
  assetDelta:     string;   // swapper's side: + received, - paid
  numeraireDelta: string;
  sqrtPriceX96:   string;
  liquidity:      string;
  tick:           number;
  fee:            number;
  priceWad:       string;   // asset price in numeraire × 1e18
  isBuyback:      boolean;
}

export interface PoolInitRow extends BaseRow {
  type: 'pool_init';
  poolId:       string;
  asset:        string;
  sqrtPriceX96: string;
  priceWad:     string;
}

export interface AssetTransferRow extends BaseRow {
  type: 'asset_transfer';
  asset:    string;
  fromAddr: string;
  toAddr:   string;
  value:    string;
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
  | PfrCollectionRow
  | SwapRow
  | PoolInitRow
  | AssetTransferRow;

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
          asset:       (decoded.args as any).asset.toLowerCase(),
          creator:     (decoded.args as any).creator.toLowerCase(),
          router:      (decoded.args as any).router.toLowerCase(),
          poolId:      (decoded.args as any).poolId,
          numeraire:   (decoded.args as any).numeraire.toLowerCase(),
          initializer: (decoded.args as any).initializer.toLowerCase(),
          launcher:    '',
        };

      case 'FeeCollected': {
        const isEscrow = addr === escrowAddr.toLowerCase();
        if (isEscrow) {
          // Escrow FeeCollected: (asset, usdcDelta, tokenDelta, wmonDelta)
          return {
            ...b,
            type: 'fee_collection',
            contract: 'escrow',
            asset:          (decoded.args as any).asset.toLowerCase(),
            usdcDelta:      (decoded.args as any).usdcDelta.toString(),
            tokenDelta:     (decoded.args as any).tokenDelta.toString(),
            wmonDelta:      (decoded.args as any).wmonDelta.toString(),
            numeraireDelta: '0',
          };
        } else {
          // Vault FeeCollected: (asset, numeraireDelta, tokenDelta)
          return {
            ...b,
            type: 'fee_collection',
            contract: 'vault',
            asset:          (decoded.args as any).asset.toLowerCase(),
            usdcDelta:      '0',
            tokenDelta:     (decoded.args as any).tokenDelta.toString(),
            wmonDelta:      '0',
            numeraireDelta: (decoded.args as any).numeraireDelta.toString(),
          };
        }
      }

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
          asset:      (decoded.args as any).asset.toLowerCase(),
          creator:    (decoded.args as any).creator.toLowerCase(),
          amount:     (decoded.args as any).amt.toString(),
          wmonAmount: '0',
          usdValue:   '0',
        };

      case 'ClaimedWmon':
        return {
          ...b,
          type: 'escrow_claim',
          asset:      (decoded.args as any).asset.toLowerCase(),
          creator:    (decoded.args as any).creator.toLowerCase(),
          amount:     '0',
          wmonAmount: (decoded.args as any).wmonAmt.toString(),
          usdValue:   (decoded.args as any).usdValue.toString(),
        };

      case 'Forfeited':
        return {
          ...b,
          type: 'escrow_forfeit',
          asset:      (decoded.args as any).asset.toLowerCase(),
          usdcMoved:  (decoded.args as any).usdcMoved.toString(),
          tokenMoved: (decoded.args as any).tokenMoved.toString(),
          wmonMoved:  (decoded.args as any).wmonMoved.toString(),
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
          asset:              (decoded.args as any).asset.toLowerCase(),
          usdcForwarded:      (decoded.args as any).usdcForwarded.toString(),
          tokenForwarded:     (decoded.args as any).tokenForwarded.toString(),
          numeraireForwarded: (decoded.args as any).numeraireForwarded.toString(),
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

/**
 * Decode a PoolManager Swap / Initialize log for a registered pool.
 * `pool` resolves the pool id; unknown pools return null.
 */
export function decodePoolManagerLog(
  log: Log,
  chainId: number,
  blockTimestamp: bigint,
  pool: (poolId: string) => PoolMeta | undefined,
  vaultAddr: string,
  txFrom = '',
): SwapRow | PoolInitRow | null {
  try {
    const decoded = decodeEventLog({ abi: poolManagerEvents, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
    const a = decoded.args as any;
    const meta = pool(a.id);
    if (!meta) return null;
    const sqrt = BigInt(a.sqrtPriceX96);
    const priceWad = priceWadFromSqrtX96(sqrt, meta.assetIsCurrency0, ASSET_DECIMALS, meta.numeraireDecimals).toString();
    const b = base(log, chainId, blockTimestamp);
    if (decoded.eventName === 'Initialize') {
      return { ...b, type: 'pool_init', poolId: meta.poolId, asset: meta.asset, sqrtPriceX96: sqrt.toString(), priceWad };
    }
    const amount0 = BigInt(a.amount0), amount1 = BigInt(a.amount1);
    const sender = String(a.sender).toLowerCase();
    return {
      ...b, type: 'swap', poolId: meta.poolId, asset: meta.asset, numeraire: meta.numeraire, sender, txFrom,
      assetDelta:     (meta.assetIsCurrency0 ? amount0 : amount1).toString(),
      numeraireDelta: (meta.assetIsCurrency0 ? amount1 : amount0).toString(),
      sqrtPriceX96: sqrt.toString(), liquidity: BigInt(a.liquidity).toString(),
      tick: Number(a.tick), fee: Number(a.fee), priceWad,
      isBuyback: sender === vaultAddr.toLowerCase(),
    };
  } catch {
    return null;
  }
}

/** Decode an ERC-20 Transfer of a registered asset (the emitting contract is the asset). */
export function decodeAssetTransferLog(log: Log, chainId: number, blockTimestamp: bigint): AssetTransferRow | null {
  try {
    const decoded = decodeEventLog({ abi: usdcEvents, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
    if (decoded.eventName !== 'Transfer') return null;
    const a = decoded.args as any;
    return {
      ...base(log, chainId, blockTimestamp), type: 'asset_transfer', asset: log.address.toLowerCase(),
      fromAddr: a.from.toLowerCase(), toAddr: a.to.toLowerCase(), value: a.value.toString(),
    };
  } catch {
    return null;
  }
}
