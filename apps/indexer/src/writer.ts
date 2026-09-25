import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  idxRegistrations,
  idxUsdcTransfers,
  idxDistributions,
  idxFeeCollections,
  idxRevenueRecorded,
  idxEscrowClaims,
  idxEscrowForfeits,
  idxBuybacks,
  idxBurns,
  idxPfrCollections,
} from '../../server/src/db/schema.js';
import type { DecodedRow } from './decoder.js';
import { writeCheckpoint } from './checkpoint.js';
import { consumeForRegistration } from '../../server/src/services/launchFee.js';
import { upsertTokenFromRegistration } from '../../server/src/services/tokenSync.js';

/**
 * Write decoded rows and update checkpoint in a single transaction.
 * Uses ON CONFLICT DO NOTHING for idempotency.
 */
export async function writeChunk(
  db: PostgresJsDatabase<any>,
  rows: DecodedRow[],
  contractSet: string,
  blockNumber: bigint,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const row of rows) {
      switch (row.type) {
        case 'registration':
          await tx.insert(idxRegistrations).values({
            chainId:     row.chainId,
            txHash:      row.txHash,
            logIndex:    row.logIndex,
            asset:       row.asset,
            creator:     row.creator,
            router:      row.router,
            poolId:      row.poolId,
            numeraire:   row.numeraire,
            initializer: row.initializer,
            launcher:    row.launcher,
            blockNumber: row.blockNumber,
            timestamp:   row.timestamp,
          }).onConflictDoNothing();
          if (row.token) await upsertTokenFromRegistration(tx, row, row.token);
          {
            // Match the launcher's oldest unused fee receipt, atomically with the row (D-LF3).
            const res = await consumeForRegistration(tx, {
              asset:       row.asset,
              launcher:    row.launcher,
              txHash:      row.txHash,
              blockNumber: row.blockNumber,
              timestamp:   row.timestamp,
            });
            if (res.status !== 'already_listed') {
              console.log(`[indexer] launch fee ${row.asset} launcher=${row.launcher || '?'}: ${res.status}` +
                (res.status === 'no_receipt' || res.status === 'rate_limited' ? ' (unlisted)' : ''));
            }
          }
          break;

        case 'usdc_transfer':
          await tx.insert(idxUsdcTransfers).values({
            chainId:              row.chainId,
            txHash:               row.txHash,
            logIndex:             row.logIndex,
            fromAddr:             row.fromAddr,
            toAddr:               row.toAddr,
            value:                row.value,
            txFrom:               row.txFrom,
            isFacilitatorSettled: row.isFacilitatorSettled,
            blockNumber:          row.blockNumber,
            timestamp:            row.timestamp,
          }).onConflictDoNothing();
          break;

        case 'distribution':
          await tx.insert(idxDistributions).values({
            chainId:     row.chainId,
            txHash:      row.txHash,
            logIndex:    row.logIndex,
            asset:       row.asset,
            total:       row.total,
            providerAmt: row.providerAmt,
            costAmt:     row.costAmt,
            buybackAmt:  row.buybackAmt,
            treasuryAmt: row.treasuryAmt,
            blockNumber: row.blockNumber,
            timestamp:   row.timestamp,
          }).onConflictDoNothing();
          break;

        case 'fee_collection':
          await tx.insert(idxFeeCollections).values({
            chainId:        row.chainId,
            txHash:         row.txHash,
            logIndex:       row.logIndex,
            contract:       row.contract,
            asset:          row.asset,
            usdcDelta:      row.usdcDelta,
            tokenDelta:     row.tokenDelta,
            wmonDelta:      row.wmonDelta,
            numeraireDelta: row.numeraireDelta,
            blockNumber:    row.blockNumber,
            timestamp:      row.timestamp,
          }).onConflictDoNothing();
          break;

        case 'revenue_recorded':
          await tx.insert(idxRevenueRecorded).values({
            chainId:     row.chainId,
            txHash:      row.txHash,
            logIndex:    row.logIndex,
            asset:       row.asset,
            amount:      row.amount,
            newTotal:    row.newTotal,
            blockNumber: row.blockNumber,
            timestamp:   row.timestamp,
          }).onConflictDoNothing();
          break;

        case 'escrow_claim':
          await tx.insert(idxEscrowClaims).values({
            chainId:     row.chainId,
            txHash:      row.txHash,
            logIndex:    row.logIndex,
            asset:       row.asset,
            creator:     row.creator,
            amount:      row.amount,
            wmonAmount:  row.wmonAmount,
            usdValue:    row.usdValue,
            blockNumber: row.blockNumber,
            timestamp:   row.timestamp,
          }).onConflictDoNothing();
          break;

        case 'escrow_forfeit':
          await tx.insert(idxEscrowForfeits).values({
            chainId:     row.chainId,
            txHash:      row.txHash,
            logIndex:    row.logIndex,
            asset:       row.asset,
            usdcMoved:   row.usdcMoved,
            tokenMoved:  row.tokenMoved,
            wmonMoved:   row.wmonMoved,
            blockNumber: row.blockNumber,
            timestamp:   row.timestamp,
          }).onConflictDoNothing();
          break;

        case 'buyback':
          await tx.insert(idxBuybacks).values({
            chainId:     row.chainId,
            txHash:      row.txHash,
            logIndex:    row.logIndex,
            asset:       row.asset,
            usdcIn:      row.usdcIn,
            tokensBurned: row.tokensBurned,
            sourceTag:   row.sourceTag,
            blockNumber: row.blockNumber,
            timestamp:   row.timestamp,
          }).onConflictDoNothing();
          break;

        case 'burn':
          await tx.insert(idxBurns).values({
            chainId:     row.chainId,
            txHash:      row.txHash,
            logIndex:    row.logIndex,
            asset:       row.asset,
            amount:      row.amount,
            blockNumber: row.blockNumber,
            timestamp:   row.timestamp,
          }).onConflictDoNothing();
          break;

        case 'pfr_collection':
          await tx.insert(idxPfrCollections).values({
            chainId:            row.chainId,
            txHash:             row.txHash,
            logIndex:           row.logIndex,
            asset:              row.asset,
            usdcForwarded:      row.usdcForwarded,
            tokenForwarded:     row.tokenForwarded,
            numeraireForwarded: row.numeraireForwarded,
            blockNumber:        row.blockNumber,
            timestamp:          row.timestamp,
          }).onConflictDoNothing();
          break;
      }
    }

    await writeCheckpoint(tx, contractSet, blockNumber);
  });
}
