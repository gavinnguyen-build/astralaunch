import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeChunk } from '../writer.js';
import type { DecodedRow, RegistrationRow, UsdcTransferRow } from '../decoder.js';

// Mock the schema imports and checkpoint
vi.mock('../../../server/src/db/schema.js', () => ({
  idxRegistrations:   { _: 'idxRegistrations' },
  idxUsdcTransfers:   { _: 'idxUsdcTransfers' },
  idxDistributions:   { _: 'idxDistributions' },
  idxFeeCollections:  { _: 'idxFeeCollections' },
  idxRevenueRecorded: { _: 'idxRevenueRecorded' },
  idxEscrowClaims:    { _: 'idxEscrowClaims' },
  idxEscrowForfeits:  { _: 'idxEscrowForfeits' },
  idxBuybacks:        { _: 'idxBuybacks' },
  idxBurns:           { _: 'idxBurns' },
  idxPfrCollections:  { _: 'idxPfrCollections' },
  idxCheckpoints:     { _: 'idxCheckpoints', contractSet: 'contract_set' },
}));

vi.mock('../checkpoint.js', () => ({
  writeCheckpoint: vi.fn(),
}));

function makeMockDb() {
  const insertedRows: any[] = [];
  const conflictHandler = { onConflictDoNothing: vi.fn() };
  const insertObj = {
    values: vi.fn((...args: any[]) => {
      insertedRows.push(args);
      return conflictHandler;
    }),
  };
  const txFn = {
    insert: vi.fn(() => insertObj),
  };

  const db = {
    transaction: vi.fn(async (fn: any) => fn(txFn)),
    _txFn: txFn,
    _insertedRows: insertedRows,
    _conflictHandler: conflictHandler,
  };

  return db;
}

describe('writeChunk', () => {
  it('inserts a registration row and calls checkpoint', async () => {
    const db = makeMockDb();
    const { writeCheckpoint } = await import('../checkpoint.js');

    const row: RegistrationRow = {
      type: 'registration',
      chainId: 143,
      txHash: '0xabc',
      logIndex: 0,
      blockNumber: 100n,
      timestamp: 1727000000n,
      asset: '0xasset',
      creator: '0xcreator',
      router: '0xrouter',
      poolId: '0xpoolid',
    };

    await writeChunk(db as any, [row], 'static', 100n);

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db._txFn.insert).toHaveBeenCalled();
    expect(db._conflictHandler.onConflictDoNothing).toHaveBeenCalled();
    expect(writeCheckpoint).toHaveBeenCalledWith(db._txFn, 'static', 100n);
  });

  it('handles empty rows (checkpoint only)', async () => {
    const db = makeMockDb();
    const { writeCheckpoint } = await import('../checkpoint.js');

    await writeChunk(db as any, [], 'static', 200n);

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db._txFn.insert).not.toHaveBeenCalled();
    expect(writeCheckpoint).toHaveBeenCalledWith(db._txFn, 'static', 200n);
  });

  it('handles multiple row types in one chunk', async () => {
    const db = makeMockDb();

    const rows: DecodedRow[] = [
      {
        type: 'registration',
        chainId: 143, txHash: '0xa', logIndex: 0,
        blockNumber: 100n, timestamp: 1n,
        asset: '0x1', creator: '0x2', router: '0x3', poolId: '0x4',
      },
      {
        type: 'fee_collection',
        chainId: 143, txHash: '0xb', logIndex: 1,
        blockNumber: 100n, timestamp: 1n,
        contract: 'escrow', asset: '0x1', usdcDelta: '500', tokenDelta: '0',
      },
      {
        type: 'buyback',
        chainId: 143, txHash: '0xc', logIndex: 2,
        blockNumber: 100n, timestamp: 1n,
        asset: '0x1', usdcIn: '150', tokensBurned: '999', sourceTag: 1,
      },
    ];

    await writeChunk(db as any, rows, 'static', 100n);

    expect(db._txFn.insert).toHaveBeenCalledTimes(3);
  });

  it('inserts usdc_transfer row with txFrom and isFacilitatorSettled', async () => {
    const db = makeMockDb();
    const { writeCheckpoint } = await import('../checkpoint.js');

    const row: UsdcTransferRow = {
      type: 'usdc_transfer',
      chainId: 143,
      txHash: '0xdef',
      logIndex: 0,
      blockNumber: 200n,
      timestamp: 1727000000n,
      fromAddr: '0xfrom',
      toAddr: '0xto',
      value: '500000',
      txFrom: '0xfacilitator',
      isFacilitatorSettled: true,
    };

    await writeChunk(db as any, [row], 'usdc_transfers', 200n);

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db._txFn.insert).toHaveBeenCalled();
    // Verify the values passed to insert include txFrom and isFacilitatorSettled
    const insertedValues = db._insertedRows[0]![0];
    expect(insertedValues.txFrom).toBe('0xfacilitator');
    expect(insertedValues.isFacilitatorSettled).toBe(true);
    expect(db._conflictHandler.onConflictDoNothing).toHaveBeenCalled();
    expect(writeCheckpoint).toHaveBeenCalledWith(db._txFn, 'usdc_transfers', 200n);
  });
});
