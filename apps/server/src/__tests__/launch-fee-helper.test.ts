/**
 * Launch fees paid through LaunchHelper (one-transaction launch): the fee is read from the
 * helper's own LaunchFeePaid event, the launcher is tx.from, the direct-transfer path is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { LAUNCH_FEE_TREASURY, LAUNCH_FEE_WEI } from '@astralaunch/shared';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';
import { feeReceipts, idxRegistrations } from '../db/schema.js';
import {
  verifyLaunchFee, consumeForRegistration, isAssetListed, findLaunchFeePaid, LaunchFeeError,
  LAUNCH_FEE_PAID_TOPIC, type FeeChainReader, type ReceiptLog,
} from '../services/launchFee.js';

const CHAIN_ID = 143;
const HELPER   = '0x4444444444444444444444444444444444444444';
const OTHER    = '0x5555555555555555555555555555555555555555';
const LAUNCHER = '0x1111111111111111111111111111111111111111';
const CREATOR  = '0x2222222222222222222222222222222222222222';
const NOW = 1_800_000_000n;

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const asset = (n: number) => `0x${n.toString(16).padStart(40, 'a')}`;
const topicAddr = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;

type FakeTx = { from: string; to: string | null; value: bigint; blockNumber: bigint; status: 'success' | 'reverted'; logs: ReceiptLog[] };

function feeLog(a: string, amount = LAUNCH_FEE_WEI, emitter = HELPER, launcher = LAUNCHER): ReceiptLog {
  return { address: emitter, topics: [LAUNCH_FEE_PAID_TOPIC, topicAddr(launcher), topicAddr(a)], data: `0x${amount.toString(16).padStart(64, '0')}` };
}

function fakeChain(txs: Record<string, FakeTx>): FeeChainReader {
  return {
    async getTx(h) { const t = txs[h]; return t ? { from: t.from, to: t.to, value: t.value, blockNumber: t.blockNumber } : null; },
    async getReceipt(h) { const t = txs[h]; return t ? { status: t.status, blockNumber: t.blockNumber, logs: t.logs } : null; },
    async getFinalizedBlockNumber() { return 1_000n; },
    async getBlockTimestamp(n) { return NOW - 10_000n + n; },
  };
}

/** A LaunchHelper.launch tx: value = fee, LaunchFeePaid for asset(n), register in the same block. */
const helperTx = (n: number, over: Partial<FakeTx> = {}): FakeTx => ({
  from: LAUNCHER, to: HELPER, value: LAUNCH_FEE_WEI, blockNumber: 100n, status: 'success', logs: [feeLog(asset(n))], ...over,
});

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof LaunchFeeError && e.code === code);
}

/** Indexer: Registered row (+ consume) for asset(n), launched in tx `txHash` at `block`. */
async function index(db: TestDb, n: number, block = 100n, logIndex = 3, txHash = hash(n)) {
  const row = {
    chainId: CHAIN_ID, txHash, logIndex, asset: asset(n), creator: CREATOR, router: asset(900 + n),
    poolId: hash(500 + n), numeraire: '', initializer: '', launcher: LAUNCHER, blockNumber: block, timestamp: NOW - 10_000n + block,
  };
  return db.transaction(async (tx) => {
    await tx.insert(idxRegistrations).values(row).onConflictDoNothing();
    return consumeForRegistration(tx, row);
  });
}

describe('launch fee via LaunchHelper', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeEach(async () => { ({ db, close } = await createTestDb()); });
  afterEach(async () => { await close(); });

  const verify = (chain: FeeChainReader, h: string, launchHelper: string | null = HELPER) =>
    verifyLaunchFee(db, chain, h, { chainId: CHAIN_ID, nowS: NOW, launchHelper });

  it('findLaunchFeePaid decodes only the helper\'s own event', () => {
    expect(findLaunchFeePaid([feeLog(asset(1))], HELPER)).toEqual({ launcher: LAUNCHER, asset: asset(1), amount: LAUNCH_FEE_WEI });
    expect(findLaunchFeePaid([feeLog(asset(1), LAUNCH_FEE_WEI, OTHER)], HELPER)).toBeNull();
    expect(findLaunchFeePaid([], HELPER)).toBeNull();
  });

  it('verify first, then the indexer consumes it for the token of the same transaction', async () => {
    const chain = fakeChain({ [hash(1)]: helperTx(1) });
    const r = await verify(chain, hash(1));
    expect(r.receipt).toMatchObject({ launcher: LAUNCHER, amountWei: LAUNCH_FEE_WEI.toString(), consumedAsset: null });
    expect(await index(db, 1)).toMatchObject({ status: 'consumed' });
    expect(await isAssetListed(db, asset(1))).toBe(true);
  });

  it('indexer first, then verify lists the token launched in that transaction', async () => {
    expect(await index(db, 1)).toEqual({ status: 'no_receipt' });
    const r = await verify(fakeChain({ [hash(1)]: helperTx(1) }), hash(1));
    expect(r.consumedAsset).toBe(asset(1));
    expect(await isAssetListed(db, asset(1))).toBe(true);
  });

  it('late verify matches the event\'s asset even if another pending launch sorts first', async () => {
    await index(db, 7, 100n, 0, hash(70));   // same launcher, same block, earlier log, no fee
    await index(db, 1, 100n, 3);             // the helper launch
    const r = await verify(fakeChain({ [hash(1)]: helperTx(1) }), hash(1));
    expect(r.consumedAsset).toBe(asset(1));
    expect(await isAssetListed(db, asset(7))).toBe(false);
  });

  it('launcher is tx.from, not the event\'s launcher field', async () => {
    const tx = helperTx(1, { logs: [feeLog(asset(1), LAUNCH_FEE_WEI, HELPER, OTHER)] });
    const r = await verify(fakeChain({ [hash(1)]: tx }), hash(1));
    expect(r.receipt.launcher).toBe(LAUNCHER);
  });

  it('rejects a spoofed LaunchFeePaid emitted by another contract', async () => {
    const tx = helperTx(1, { logs: [feeLog(asset(1), LAUNCH_FEE_WEI, OTHER)] });
    await expectCode(verify(fakeChain({ [hash(1)]: tx }), hash(1)), 'no_fee_paid');
  });

  it('rejects a helper launch that paid no fee (value 0, used an existing receipt)', async () => {
    const tx = helperTx(1, { value: 0n, logs: [] });
    await expectCode(verify(fakeChain({ [hash(1)]: tx }), hash(1)), 'no_fee_paid');
  });

  it('rejects an underpaid event amount', async () => {
    const tx = helperTx(1, { logs: [feeLog(asset(1), LAUNCH_FEE_WEI - 1n)] });
    await expectCode(verify(fakeChain({ [hash(1)]: tx }), hash(1)), 'underpaid');
  });

  it('rejects a reverted helper transaction', async () => {
    await expectCode(verify(fakeChain({ [hash(1)]: helperTx(1, { status: 'reverted', logs: [] }) }), hash(1)), 'tx_failed');
  });

  it('a helper tx is a wrong recipient when no helper is configured', async () => {
    await expectCode(verify(fakeChain({ [hash(1)]: helperTx(1) }), hash(1), null), 'wrong_recipient');
  });

  it('a tx to an unknown contract is still a wrong recipient', async () => {
    await expectCode(verify(fakeChain({ [hash(1)]: helperTx(1, { to: OTHER }) }), hash(1)), 'wrong_recipient');
  });

  it('the direct transfer path is unchanged with a helper configured', async () => {
    const direct: FakeTx = { from: LAUNCHER, to: LAUNCH_FEE_TREASURY, value: LAUNCH_FEE_WEI, blockNumber: 90n, status: 'success', logs: [] };
    const r = await verify(fakeChain({ [hash(2)]: direct }), hash(2));
    expect(r.receipt.amountWei).toBe(LAUNCH_FEE_WEI.toString());
  });

  it('one helper transaction is one receipt (resubmitting is rejected)', async () => {
    const chain = fakeChain({ [hash(1)]: helperTx(1) });
    await verify(chain, hash(1));
    await expectCode(verify(chain, hash(1)), 'already_used');
    expect((await db.select().from(feeReceipts).where(eq(feeReceipts.txHash, hash(1)))).length).toBe(1);
  });
});
