/**
 * GET /api/config — public chain config for the web app (launch flow). Single source: the server's
 * deployment env + packages/shared, so the browser never hardcodes contract addresses.
 */
import { Hono } from 'hono';
import {
  LAUNCH_FEE_MON, LAUNCH_FEE_TREASURY, LAUNCH_FEE_WEI, LAUNCH_RATE_LIMIT, MON_USD_ORACLE, USDC, WMON,
} from '@astralaunch/shared';
import { CHAIN_ID, ESCROW_ADDR, REGISTRY_ADDR, VAULT_ADDR } from '../env.js';

const app = new Hono();

app.get('/', (c) => {
  const pfr = process.env.PLATFORM_FEE_RECEIVER_ADDRESS;
  if (!pfr) return c.json({ error: 'PLATFORM_FEE_RECEIVER_ADDRESS not configured' }, 503);
  return c.json({
    chainId: CHAIN_ID,
    contracts: { registry: REGISTRY_ADDR, escrow: ESCROW_ADDR, vault: VAULT_ADDR, platformFeeReceiver: pfr },
    tokens: { usdc: USDC, wmon: WMON },
    monUsdOracle: MON_USD_ORACLE,
    launchFee: { mon: LAUNCH_FEE_MON, wei: LAUNCH_FEE_WEI.toString(), treasury: LAUNCH_FEE_TREASURY, maxPer24h: LAUNCH_RATE_LIMIT },
  });
});

export default app;
