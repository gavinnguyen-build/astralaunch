import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { LAUNCH_FEE_TREASURY, LAUNCH_FEE_WEI, LAUNCH_RATE_WINDOW_S } from '@astralaunch/shared';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';
import { feeReceipts, idxRegistrations } from '../db/schema.js';
import {
  verifyLaunchFee, consumeForRegistration, launchStatus, adminListAsset,
  listUnlistedRegistrations, isAssetListed, LaunchFeeError, type FeeChainReader,
} from '../services/launchFee.js';

const CHAIN_ID = 143;
const LAUNCHER = '0x1111111111111111111111111111111111111111';
const CREATOR  = '0x2222222222222222222222222222222222222222'; // fee recipient ≠ launcher
const NOW = 1_800_000_000n;

type FakeTx = { from: string; to: string | null; value: bigint; blockNumber: bigint | null; status: 'success' | 'reverted' };

function hash(n: number) { return `0x${n.toString(16).padStart(64, '0')}`; }
function asset(n: number) { return `0x${n.toString(16).padStart(40, 'a')}`; }

function fakeChain(txs: Record<string, FakeTx>, finalized = 1_000n): FeeChainReader {
  return {
    async getTx(h) { const t = txs[h]; return t ? { from: t.from, to: t.to, value: t.value, blockNumber: t.blockNumber } : null; },
    async getReceipt(h) { const t = txs[h]; return t && t.blockNumber !== null ? { status: t.status, blockNumber: t.blockNumber } : null; },
    async getFinalizedBlockNumber() { return finalized; },
    async getBlockTimestamp(n) { return NOW - 10_000n + n; },
  };
}

const goodTx = (over: Partial<FakeTx> = {}): FakeTx => ({
  // Checksummed-style casing on purpose: launcher must be stored lowercase.
  from: LAUNCHER.toUpperCase().replace('0X', '0x'), to: LAUNCH_FEE_TREASURY, value: LAUNCH_FEE_WEI, blockNumber: 100n, status: 'success', ...over,
});

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof LaunchFeeError && e.code === code);
}

/** Simulate the indexer: insert a Registered row + consume, in one transaction. */
async function register(db: TestDb, n: number, opts: { launcher?: string; block?: bigint; ts?: bigint } = {}) {
  const row = {
    chainId: CHAIN_ID, txHash: hash(10_000 + n), logIndex: 0, asset: asset(n), creator: CREATOR,
    router: asset(900 + n), poolId: hash(n), numeraire: '', initializer: '',
    launcher: opts.launcher ?? LAUNCHER, blockNumber: opts.block ?? 200n, timestamp: opts.ts ?? NOW,
  };
  return db.transaction(async (tx) => {
    await tx.insert(idxRegistrations).values(row).onConflictDoNothing();
    return consumeForRegistration(tx, row);
  });
}

describe('launch fee', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeEach(async () => { ({ db, close } = await createTestDb()); });
  afterEach(async () => { await close(); });

  const verify = (chain: FeeChainReader, h: string, nowS = NOW) =>
    verifyLaunchFee(db, chain, h, { chainId: CHAIN_ID, nowS });

  describe('verify', () => {
    it('stores an unused receipt keyed by tx hash, launcher = tx.from', async () => {
      const { receipt, consumedAsset } = await verify(fakeChain({ [hash(1)]: goodTx() }), hash(1));
      expect(receipt.launcher).toBe(LAUNCHER);
      expect(receipt.amountWei).toBe(LAUNCH_FEE_WEI.toString());
      expect(receipt.consumedAsset).toBeNull();
      expect(consumedAsset).toBeNull();
    });

    it('rejects reuse of the same tx hash', async () => {
      const chain = fakeChain({ [hash(1)]: goodTx() });
      await verify(chain, hash(1));
      await expectCode(verify(chain, hash(1)), 'already_used');
      await expectCode(verify(chain, hash(1).toUpperCase().replace('0X', '0x')), 'already_used');
      expect(await db.select().from(feeReceipts)).toHaveLength(1);
    });

    it('rejects wrong recipient', async () => {
      await expectCode(verify(fakeChain({ [hash(1)]: goodTx({ to: CREATOR }) }), hash(1)), 'wrong_recipient');
      await expectCode(verify(fakeChain({ [hash(2)]: goodTx({ to: null }) }), hash(2)), 'wrong_recipient');
    });

    it('rejects underpaid', async () => {
      await expectCode(verify(fakeChain({ [hash(1)]: goodTx({ value: LAUNCH_FEE_WEI - 1n }) }), hash(1)), 'underpaid');
    });

    it('accepts overpayment', async () => {
      const { receipt } = await verify(fakeChain({ [hash(1)]: goodTx({ value: LAUNCH_FEE_WEI * 2n }) }), hash(1));
      expect(receipt.amountWei).toBe((LAUNCH_FEE_WEI * 2n).toString());
    });

    it('rejects a failed (reverted) tx', async () => {
      await expectCode(verify(fakeChain({ [hash(1)]: goodTx({ status: 'reverted' }) }), hash(1)), 'tx_failed');
    });

    it('rejects a tx not finalized yet, and accepts it once finalized', async () => {
      const txs = { [hash(1)]: goodTx({ blockNumber: 1_001n }) };
      await expectCode(verify(fakeChain(txs, 1_000n), hash(1)), 'not_finalized');
      await expectCode(verify(fakeChain({ [hash(2)]: goodTx({ blockNumber: null }) }), hash(2)), 'not_finalized');
      expect(await db.select().from(feeReceipts)).toHaveLength(0);
      const { receipt } = await verify(fakeChain(txs, 1_001n), hash(1));
      expect(receipt.blockNumber).toBe(1_001n);
    });

    it('rejects unknown tx and malformed hash', async () => {
      await expectCode(verify(fakeChain({}), hash(1)), 'tx_not_found');
      await expectCode(verify(fakeChain({}), '0x1234'), 'invalid_tx_hash');
    });
  });

  describe('consume + rate limit', () => {
    it('receipt survives a failed launch and is consumed by the retry', async () => {
      await verify(fakeChain({ [hash(1)]: goodTx() }), hash(1));
      // Failed launch: register() reverted, so no Registered event, nothing consumed.
      let status = await launchStatus(db, LAUNCHER, NOW);
      expect(status.unusedReceipts).toHaveLength(1);
      expect(status.canLaunch).toBe(true);

      expect(await register(db, 1)).toMatchObject({ status: 'consumed' });
      status = await launchStatus(db, LAUNCHER, NOW);
      expect(status.unusedReceipts).toHaveLength(0);
      expect(status.launchesLast24h).toBe(1);
      expect(status.canLaunch).toBe(false); // no unused receipt left
    });

    it('one receipt = one token; second launch without a new fee stays unlisted', async () => {
      await verify(fakeChain({ [hash(1)]: goodTx() }), hash(1));
      expect(await register(db, 1)).toMatchObject({ status: 'consumed' });
      expect(await register(db, 2)).toEqual({ status: 'no_receipt' });
      expect(await isAssetListed(db, asset(1))).toBe(true);
      expect(await isAssetListed(db, asset(2))).toBe(false);
    });

    it('re-indexing the same Registered event is idempotent', async () => {
      await verify(fakeChain({ [hash(1)]: goodTx() }), hash(1));
      await verify(fakeChain({ [hash(2)]: goodTx() }), hash(2));
      await register(db, 1);
      expect(await register(db, 1)).toEqual({ status: 'already_listed' });
      expect((await launchStatus(db, LAUNCHER, NOW)).unusedReceipts).toHaveLength(1);
    });

    it('consumes the oldest unused receipt, only if paid at or before the register block', async () => {
      await verify(fakeChain({ [hash(2)]: goodTx({ blockNumber: 150n }) }), hash(2));
      await verify(fakeChain({ [hash(1)]: goodTx({ blockNumber: 120n }) }), hash(1));
      expect(await register(db, 9, { block: 110n })).toEqual({ status: 'no_receipt' });
      await register(db, 1, { block: 200n });
      const [r] = await db.select().from(feeReceipts).where(eq(feeReceipts.consumedAsset, asset(1)));
      expect(r!.txHash).toBe(hash(1));
    });

    it('matches by launcher (register tx sender), not by Registered creator / fee recipient', async () => {
      await verify(fakeChain({ [hash(1)]: goodTx() }), hash(1));
      // Registered.creator = CREATOR (fee recipient), tx.from = LAUNCHER.
      expect(await register(db, 1)).toMatchObject({ status: 'consumed' });
      const [reg] = await db.select().from(idxRegistrations).where(eq(idxRegistrations.asset, asset(1)));
      expect(reg!.creator).toBe(CREATOR);
      expect(await isAssetListed(db, asset(1))).toBe(true);

      // A registration sent by the creator wallet does NOT use the launcher's receipt.
      await verify(fakeChain({ [hash(2)]: goodTx() }), hash(2));
      expect(await register(db, 2, { launcher: CREATOR })).toEqual({ status: 'no_receipt' });
      expect(await register(db, 3, { launcher: '' })).toEqual({ status: 'no_launcher' });
    });

    it('4th launch in 24h is rejected at consume time; receipt stays unused; allowed after window', async () => {
      for (let i = 1; i <= 4; i++) await verify(fakeChain({ [hash(i)]: goodTx() }), hash(i));
      for (let i = 1; i <= 3; i++) {
        expect(await register(db, i, { ts: NOW + BigInt(i) })).toMatchObject({ status: 'consumed' });
      }
      const fourth = await register(db, 4, { ts: NOW + 10n });
      expect(fourth).toMatchObject({ status: 'rate_limited', nextSlotAt: Number(NOW + 1n) + LAUNCH_RATE_WINDOW_S });
      expect(await isAssetListed(db, asset(4))).toBe(false);
      expect((await launchStatus(db, LAUNCHER, NOW + 10n)).unusedReceipts).toHaveLength(1);

      // A new token after the window has rolled consumes the surviving receipt.
      const later = NOW + 1n + BigInt(LAUNCH_RATE_WINDOW_S);
      expect(await register(db, 5, { ts: later })).toMatchObject({ status: 'consumed' });
    });

    it('4th launch in 24h is rejected at verify time with a clear error', async () => {
      for (let i = 1; i <= 3; i++) {
        await verify(fakeChain({ [hash(i)]: goodTx() }), hash(i));
        await register(db, i, { ts: NOW - 100n });
      }
      const status = await launchStatus(db, LAUNCHER, NOW);
      expect(status).toMatchObject({ launchesLast24h: 3, slotsLeft: 0, canLaunch: false });

      const err = await verify(fakeChain({ [hash(4)]: goodTx() }), hash(4)).catch(e => e);
      expect(err).toBeInstanceOf(LaunchFeeError);
      expect(err.code).toBe('rate_limited');
      expect(err.status).toBe(429);
      expect(err.message).toMatch(/3 launches per 24h/);
      expect(err.extra.nextSlotAt).toBe(Number(NOW - 100n) + LAUNCH_RATE_WINDOW_S);
      // Not stored, so the same payment can be submitted again after the window.
      const { receipt } = await verify(fakeChain({ [hash(4)]: goodTx() }), hash(4), NOW + BigInt(LAUNCH_RATE_WINDOW_S));
      expect(receipt.txHash).toBe(hash(4));
    });

    it('late verify matches a registration indexed before the receipt existed', async () => {
      expect(await register(db, 1, { block: 200n })).toEqual({ status: 'no_receipt' });
      const { consumedAsset } = await verify(fakeChain({ [hash(1)]: goodTx({ blockNumber: 150n }) }), hash(1));
      expect(consumedAsset).toBe(asset(1));
      expect(await isAssetListed(db, asset(1))).toBe(true);
    });

    it('late verify does not match a registration older than the fee', async () => {
      await register(db, 1, { block: 100n });
      const { consumedAsset } = await verify(fakeChain({ [hash(1)]: goodTx({ blockNumber: 150n }) }), hash(1));
      expect(consumedAsset).toBeNull();
    });
  });

  describe('admin listing', () => {
    it('unlisted registrations are visible to admin; admin override lists them without counting', async () => {
      await register(db, 1);
      expect((await listUnlistedRegistrations(db)).map(r => r.asset)).toEqual([asset(1)]);
      expect(await adminListAsset(db, asset(1), CHAIN_ID, 'legacy')).toEqual({ inserted: true, indexed: true });
      expect(await adminListAsset(db, asset(1), CHAIN_ID, 'legacy')).toEqual({ inserted: false, indexed: true });
      expect(await listUnlistedRegistrations(db)).toHaveLength(0);
      expect(await isAssetListed(db, asset(1))).toBe(true);
      expect((await launchStatus(db, 'admin', NOW)).launchesLast24h).toBe(0);
    });
  });
});
