/**
 * Off-chain launch fee + launch rate limit (docs/decisions.md D-LF1..D-LF6).
 *
 * - A launcher pays LAUNCH_FEE_WEI (native MON) to LAUNCH_FEE_TREASURY, then calls
 *   POST /api/launch-fee/verify. We read the tx from Monad ourselves and store an
 *   unused receipt keyed by tx hash.
 * - The indexer, on each Registered event, reads the register() tx sender (the
 *   launcher, NOT the event's creator field) and consumes that launcher's oldest
 *   unused receipt. One receipt = one token. Consumed = publicly listed.
 * - Max LAUNCH_RATE_LIMIT consumed launches per launcher per rolling window,
 *   checked at verify time (wall clock) and at consume time (register block time).
 *
 * Pure DB + chain-reader logic: no env imports, so the indexer can share it.
 */
import { and, asc, eq, gt, gte, isNull, lte, sql, type SQL, type Column } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { Hex } from 'viem';
import {
  LAUNCH_FEE_MON,
  LAUNCH_FEE_WEI,
  LAUNCH_FEE_TREASURY,
  LAUNCH_RATE_LIMIT,
  LAUNCH_RATE_WINDOW_S,
} from '@astralaunch/shared';
import { feeReceipts, hiddenTokens, idxRegistrations, tokens, type FeeReceipt } from '../db/schema.js';

// Any drizzle Postgres database or transaction (postgres-js in prod, PGlite in tests).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, any, any>;

// ── Errors ───────────────────────────────────────────────────────────────────

export type LaunchFeeErrorCode =
  | 'invalid_tx_hash'
  | 'tx_not_found'
  | 'wrong_recipient'
  | 'underpaid'
  | 'tx_failed'
  | 'not_finalized'
  | 'already_used'
  | 'rate_limited';

const STATUS: Record<LaunchFeeErrorCode, 400 | 404 | 409 | 422 | 429> = {
  invalid_tx_hash: 400,
  tx_not_found:    404,
  wrong_recipient: 422,
  underpaid:       422,
  tx_failed:       422,
  not_finalized:   409,
  already_used:    409,
  rate_limited:    429,
};

export class LaunchFeeError extends Error {
  readonly status: 400 | 404 | 409 | 422 | 429;
  constructor(
    readonly code: LaunchFeeErrorCode,
    message: string,
    readonly extra: Record<string, string | number | boolean> = {},
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

// ── Chain reader (thin, mockable) ────────────────────────────────────────────

export interface FeeChainReader {
  /** null if the tx is unknown to the node. blockNumber null = still pending. */
  getTx(hash: Hex): Promise<{ from: string; to: string | null; value: bigint; blockNumber: bigint | null } | null>;
  /** null if no receipt yet. */
  getReceipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint } | null>;
  getFinalizedBlockNumber(): Promise<bigint>;
  getBlockTimestamp(blockNumber: bigint): Promise<bigint>;
}

/** Minimal structural subset of viem's PublicClient used by viemFeeChainReader. */
interface ViemLike {
  getTransaction(a: { hash: Hex }): Promise<{ from: string; to: string | null; value: bigint; blockNumber: bigint | null }>;
  getTransactionReceipt(a: { hash: Hex }): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint }>;
  getBlock(a: { blockTag: 'finalized' }): Promise<{ number: bigint | null }>;
  getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

function isNotFound(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  return name === 'TransactionNotFoundError' || name === 'TransactionReceiptNotFoundError';
}

export function viemFeeChainReader(client: ViemLike): FeeChainReader {
  return {
    async getTx(hash) {
      try { return await client.getTransaction({ hash }); }
      catch (e) { if (isNotFound(e)) return null; throw e; }
    },
    async getReceipt(hash) {
      try { return await client.getTransactionReceipt({ hash }); }
      catch (e) { if (isNotFound(e)) return null; throw e; }
    },
    async getFinalizedBlockNumber() {
      const b = await client.getBlock({ blockTag: 'finalized' });
      if (b.number === null) throw new Error('finalized block has no number');
      return b.number;
    },
    async getBlockTimestamp(blockNumber) {
      return (await client.getBlock({ blockNumber })).timestamp;
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TX_HASH_RE = /^0x[0-9a-f]{64}$/;

/** Serialize all fee/consume work for one launcher (rate-limit check + write). */
async function lockLauncher(tx: Db, launcher: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'launch-fee:' + launcher}))`);
}

/** Consumed (counted) fee launches by `launcher` with register time in (fromS, toS]. */
async function countedLaunches(db: Db, launcher: string, fromS: bigint, toS: bigint) {
  return db.select({ asset: feeReceipts.consumedAsset, regTs: feeReceipts.consumedRegTs })
    .from(feeReceipts)
    .where(and(
      eq(feeReceipts.launcher, launcher),
      eq(feeReceipts.source, 'fee'),
      gt(feeReceipts.consumedRegTs, fromS),
      lte(feeReceipts.consumedRegTs, toS),
    ))
    .orderBy(asc(feeReceipts.consumedRegTs));
}

/** Earliest unix second at which a rate-limited launcher gets a slot back. */
function nextSlotAt(used: { regTs: bigint | null }[]): number | null {
  if (used.length < LAUNCH_RATE_LIMIT) return null;
  const oldest = used[used.length - LAUNCH_RATE_LIMIT]!.regTs!;
  return Number(oldest) + LAUNCH_RATE_WINDOW_S;
}

// ── Verify (POST /api/launch-fee/verify) ─────────────────────────────────────

export interface VerifyOptions {
  chainId: number;
  nowS: bigint;
  treasury?: string;
}

export interface VerifyResult {
  receipt: FeeReceipt;
  /** Set when the receipt was immediately matched to an already-indexed registration. */
  consumedAsset: string | null;
}

export async function verifyLaunchFee(
  db: Db,
  chain: FeeChainReader,
  rawHash: string,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const hash = rawHash.toLowerCase();
  if (!TX_HASH_RE.test(hash)) {
    throw new LaunchFeeError('invalid_tx_hash', 'txHash must be a 0x-prefixed 32-byte hex string.');
  }
  const treasury = (opts.treasury ?? LAUNCH_FEE_TREASURY).toLowerCase();

  const [existing] = await db.select({ id: feeReceipts.id }).from(feeReceipts)
    .where(eq(feeReceipts.txHash, hash)).limit(1);
  if (existing) {
    throw new LaunchFeeError('already_used', 'This fee transaction has already been submitted. Each payment covers one launch.');
  }

  const tx = await chain.getTx(hash as Hex);
  if (!tx) throw new LaunchFeeError('tx_not_found', 'Transaction not found on Monad.');
  if (tx.blockNumber === null) {
    throw new LaunchFeeError('not_finalized', 'Transaction is still pending. Retry once it is finalized.', { retryable: true });
  }
  if ((tx.to ?? '').toLowerCase() !== treasury) {
    throw new LaunchFeeError('wrong_recipient', `Launch fee must be sent directly to the treasury ${LAUNCH_FEE_TREASURY}.`);
  }
  if (tx.value < LAUNCH_FEE_WEI) {
    throw new LaunchFeeError('underpaid', `Launch fee is ${LAUNCH_FEE_MON} MON; this transaction sent less.`, {
      requiredWei: LAUNCH_FEE_WEI.toString(), paidWei: tx.value.toString(),
    });
  }

  const receipt = await chain.getReceipt(hash as Hex);
  if (!receipt) {
    throw new LaunchFeeError('not_finalized', 'Transaction receipt not available yet. Retry shortly.', { retryable: true });
  }
  if (receipt.status !== 'success') {
    throw new LaunchFeeError('tx_failed', 'Fee transaction reverted on-chain; no fee was paid.');
  }
  const finalized = await chain.getFinalizedBlockNumber();
  if (receipt.blockNumber > finalized) {
    throw new LaunchFeeError('not_finalized', 'Transaction is not finalized yet. Retry in a few seconds.', {
      retryable: true, txBlock: receipt.blockNumber.toString(), finalizedBlock: finalized.toString(),
    });
  }

  const launcher = tx.from.toLowerCase();
  const paidAt = await chain.getBlockTimestamp(receipt.blockNumber);

  return db.transaction(async (t) => {
    await lockLauncher(t, launcher);

    const used = await countedLaunches(t, launcher, opts.nowS - BigInt(LAUNCH_RATE_WINDOW_S), opts.nowS);
    if (used.length >= LAUNCH_RATE_LIMIT) {
      const at = nextSlotAt(used)!;
      throw new LaunchFeeError('rate_limited',
        `Launch limit reached: ${LAUNCH_RATE_LIMIT} launches per 24h per wallet. ` +
        `Your payment is safe on-chain; submit it again after ${new Date(at * 1000).toISOString()}.`,
        { nextSlotAt: at, retryAfterS: Math.max(0, at - Number(opts.nowS)) });
    }

    const [row] = await t.insert(feeReceipts).values({
      chainId:     opts.chainId,
      txHash:      hash,
      launcher,
      amountWei:   tx.value.toString(),
      blockNumber: receipt.blockNumber,
      paidAt,
      source:      'fee',
    }).onConflictDoNothing().returning();
    if (!row) {
      throw new LaunchFeeError('already_used', 'This fee transaction has already been submitted. Each payment covers one launch.');
    }

    // Late match: register() may have been indexed before the launcher called verify.
    // Only registrations at or after the fee block count (fee must precede launch).
    const pending = await t.select({
      asset: idxRegistrations.asset, txHash: idxRegistrations.txHash,
      blockNumber: idxRegistrations.blockNumber, timestamp: idxRegistrations.timestamp,
    })
      .from(idxRegistrations)
      .leftJoin(feeReceipts, eq(feeReceipts.consumedAsset, idxRegistrations.asset))
      .where(and(
        eq(idxRegistrations.launcher, launcher),
        gte(idxRegistrations.blockNumber, receipt.blockNumber),
        isNull(feeReceipts.id),
      ))
      .orderBy(asc(idxRegistrations.blockNumber), asc(idxRegistrations.logIndex))
      .limit(1);

    let consumedAsset: string | null = null;
    if (pending[0]) {
      const r = await consumeLocked(t, { ...pending[0], launcher });
      if (r.status === 'consumed') consumedAsset = pending[0].asset;
    }

    const [fresh] = await t.select().from(feeReceipts).where(eq(feeReceipts.id, row.id));
    return { receipt: fresh!, consumedAsset };
  });
}

// ── Consume (indexer, on Registered) ─────────────────────────────────────────

export interface RegistrationForConsume {
  asset:       string;  // lowercase
  launcher:    string;  // register() tx.from, lowercase — never the event's creator
  txHash:      string;
  blockNumber: bigint;
  timestamp:   bigint;  // register block timestamp (s)
}

export type ConsumeResult =
  | { status: 'consumed'; receiptId: number }
  | { status: 'already_listed' }
  | { status: 'no_launcher' }
  | { status: 'rate_limited'; nextSlotAt: number }
  | { status: 'no_receipt' };

/**
 * Match the launcher's oldest unused receipt (paid at or before the register
 * block) to `reg.asset`. Idempotent: re-indexing an already-listed asset is a no-op.
 * Call inside the indexer's chunk transaction so it commits atomically with the row.
 */
export async function consumeForRegistration(tx: Db, reg: RegistrationForConsume): Promise<ConsumeResult> {
  if (!reg.launcher) return { status: 'no_launcher' };
  await lockLauncher(tx, reg.launcher);
  return consumeLocked(tx, reg);
}

async function consumeLocked(tx: Db, reg: RegistrationForConsume): Promise<ConsumeResult> {
  const [listed] = await tx.select({ id: feeReceipts.id }).from(feeReceipts)
    .where(eq(feeReceipts.consumedAsset, reg.asset)).limit(1);
  if (listed) return { status: 'already_listed' };

  const used = await countedLaunches(tx, reg.launcher, reg.timestamp - BigInt(LAUNCH_RATE_WINDOW_S), reg.timestamp);
  if (used.length >= LAUNCH_RATE_LIMIT) return { status: 'rate_limited', nextSlotAt: nextSlotAt(used)! };

  const [candidate] = await tx.select({ id: feeReceipts.id }).from(feeReceipts)
    .where(and(
      eq(feeReceipts.launcher, reg.launcher),
      eq(feeReceipts.source, 'fee'),
      isNull(feeReceipts.consumedAsset),
      lte(feeReceipts.blockNumber, reg.blockNumber),
    ))
    .orderBy(asc(feeReceipts.blockNumber), asc(feeReceipts.id))
    .limit(1)
    .for('update');
  if (!candidate) return { status: 'no_receipt' };

  const [updated] = await tx.update(feeReceipts).set({
    consumedAsset:  reg.asset,
    consumedTxHash: reg.txHash,
    consumedRegTs:  reg.timestamp,
    consumedAt:     new Date(),
  }).where(and(eq(feeReceipts.id, candidate.id), isNull(feeReceipts.consumedAsset)))
    .returning({ id: feeReceipts.id });
  return updated ? { status: 'consumed', receiptId: updated.id } : { status: 'no_receipt' };
}

// ── Status (GET /api/launch-fee/status) ──────────────────────────────────────

export async function launchStatus(db: Db, wallet: string, nowS: bigint) {
  const launcher = wallet.toLowerCase();
  const unused = await db.select({
    txHash: feeReceipts.txHash, amountWei: feeReceipts.amountWei,
    blockNumber: feeReceipts.blockNumber, paidAt: feeReceipts.paidAt,
  })
    .from(feeReceipts)
    .where(and(eq(feeReceipts.launcher, launcher), eq(feeReceipts.source, 'fee'), isNull(feeReceipts.consumedAsset)))
    .orderBy(asc(feeReceipts.blockNumber), asc(feeReceipts.id));

  const used = await countedLaunches(db, launcher, nowS - BigInt(LAUNCH_RATE_WINDOW_S), nowS);
  const slotsLeft = Math.max(0, LAUNCH_RATE_LIMIT - used.length);

  return {
    wallet: launcher,
    fee: { mon: LAUNCH_FEE_MON, wei: LAUNCH_FEE_WEI.toString(), treasury: LAUNCH_FEE_TREASURY },
    limit: { max: LAUNCH_RATE_LIMIT, windowSeconds: LAUNCH_RATE_WINDOW_S },
    unusedReceipts: unused.map(r => ({
      txHash: r.txHash, amountWei: r.amountWei,
      blockNumber: r.blockNumber.toString(), paidAt: Number(r.paidAt),
    })),
    launchesLast24h: used.length,
    launchesLast24hAssets: used.map(u => u.asset),
    slotsLeft,
    canLaunch: unused.length > 0 && slotsLeft > 0,
    nextSlotAt: nextSlotAt(used),
  };
}

// ── Visibility ───────────────────────────────────────────────────────────────

/** SQL predicate: the asset in `assetCol` has a consumed fee receipt (is listed). */
export function isListedSql(assetCol: Column | SQL): SQL {
  // Listed = launch fee consumed AND not hidden by an admin (D-AD1).
  return sql`(EXISTS (SELECT 1 FROM ${feeReceipts} WHERE ${feeReceipts.consumedAsset} = ${assetCol})
    AND NOT EXISTS (SELECT 1 FROM ${hiddenTokens} WHERE ${hiddenTokens.asset} = ${assetCol}))`;
}

export async function isAssetListed(db: Db, asset: string): Promise<boolean> {
  const a = asset.toLowerCase();
  const [row] = await db.select({ id: feeReceipts.id }).from(feeReceipts).where(eq(feeReceipts.consumedAsset, a)).limit(1);
  if (!row) return false;
  const [hidden] = await db.select({ asset: hiddenTokens.asset }).from(hiddenTokens).where(eq(hiddenTokens.asset, a)).limit(1);
  return !hidden;
}

/** Admin: hide / unhide a token from every public endpoint (D-AD1). Idempotent. */
export async function hideToken(db: Db, asset: string, reason: string) {
  const [row] = await db.insert(hiddenTokens).values({ asset: asset.toLowerCase(), reason })
    .onConflictDoUpdate({ target: hiddenTokens.asset, set: { reason } }).returning();
  return row!;
}
export async function unhideToken(db: Db, asset: string): Promise<boolean> {
  const rows = await db.delete(hiddenTokens).where(eq(hiddenTokens.asset, asset.toLowerCase())).returning();
  return rows.length > 0;
}
export async function listHiddenTokens(db: Db) {
  return db.select().from(hiddenTokens);
}

/** Registered on-chain but never listed (no consumed receipt). Admin-only view. */
export async function listUnlistedRegistrations(db: Db) {
  return db.select({
    asset:       idxRegistrations.asset,
    creator:     idxRegistrations.creator,
    launcher:    idxRegistrations.launcher,
    router:      idxRegistrations.router,
    numeraire:   idxRegistrations.numeraire,
    txHash:      idxRegistrations.txHash,
    blockNumber: idxRegistrations.blockNumber,
    timestamp:   idxRegistrations.timestamp,
    name:        tokens.name,
    symbol:      tokens.symbol,
  })
    .from(idxRegistrations)
    .leftJoin(tokens, eq(tokens.asset, idxRegistrations.asset))
    .where(sql`NOT ${isListedSql(idxRegistrations.asset)}`)
    .orderBy(asc(idxRegistrations.blockNumber));
}

/**
 * Admin override: mark `asset` listed without a fee (tokens launched before the
 * fee existed). Writes a synthetic source='admin' receipt that never counts toward
 * the rate limit. Idempotent.
 */
export async function adminListAsset(db: Db, asset: string, chainId: number, note: string) {
  const a = asset.toLowerCase();
  const [reg] = await db.select().from(idxRegistrations).where(eq(idxRegistrations.asset, a)).limit(1);
  const [row] = await db.insert(feeReceipts).values({
    chainId,
    txHash:         `admin:${a}`,
    launcher:       'admin',
    amountWei:      '0',
    blockNumber:    reg?.blockNumber ?? 0n,
    paidAt:         reg?.timestamp ?? 0n,
    source:         'admin',
    consumedAsset:  a,
    consumedTxHash: reg?.txHash ?? null,
    consumedRegTs:  reg?.timestamp ?? null,
    consumedAt:     new Date(),
    note,
  }).onConflictDoNothing().returning({ id: feeReceipts.id });
  return { inserted: !!row, indexed: !!reg };
}
