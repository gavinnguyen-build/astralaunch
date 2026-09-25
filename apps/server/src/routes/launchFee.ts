/**
 * Launch fee routes — /api/launch-fee (docs/decisions.md D-LF1..D-LF6)
 *
 * POST /api/launch-fee/verify   { txHash }  — verify a 10 MON fee tx on Monad (direct transfer to the treasury,
 *                                            or a LaunchHelper launch via its LaunchFeePaid event), store a receipt
 * GET  /api/launch-fee/status?wallet=0x…    — unused receipts, launches in last 24h, canLaunch
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createPublicClient, defineChain, http } from 'viem';
import { addressSchema } from '@astralaunch/shared';
import { db } from '../db/client.js';
import { RPC_URL, CHAIN_ID, LAUNCH_HELPER_ADDR } from '../env.js';
import {
  LaunchFeeError, launchStatus, verifyLaunchFee, viemFeeChainReader,
} from '../services/launchFee.js';

const monad = defineChain({
  id: CHAIN_ID,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const chain = viemFeeChainReader(createPublicClient({ chain: monad, transport: http(RPC_URL) }));

const nowS = () => BigInt(Math.floor(Date.now() / 1000));

const app = new Hono();

app.post('/verify', zValidator('json', z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'txHash must be a 0x-prefixed 32-byte hex string'),
})), async (c) => {
  const { txHash } = c.req.valid('json');
  try {
    const { receipt, consumedAsset } = await verifyLaunchFee(db, chain, txHash, { chainId: CHAIN_ID, nowS: nowS(), launchHelper: LAUNCH_HELPER_ADDR });
    return c.json({
      txHash:      receipt.txHash,
      launcher:    receipt.launcher,
      amountWei:   receipt.amountWei,
      blockNumber: receipt.blockNumber.toString(),
      paidAt:      Number(receipt.paidAt),
      status:      consumedAsset ? 'consumed' : 'unused',
      consumedAsset,
    }, 201);
  } catch (e) {
    if (e instanceof LaunchFeeError) {
      return c.json({ error: e.code, message: e.message, ...e.extra }, e.status);
    }
    throw e;
  }
});

app.get('/status', zValidator('query', z.object({ wallet: addressSchema })), async (c) => {
  const { wallet } = c.req.valid('query');
  return c.json(await launchStatus(db, wallet, nowS()));
});

export default app;
