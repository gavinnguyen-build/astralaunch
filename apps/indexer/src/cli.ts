import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  DATABASE_URL,
  CHAIN_ID,
  START_BLOCK,
  CHUNK_SIZE,
  POLL_INTERVAL_S,
  FINALITY_LAG,
  MAX_RPS,
  REGISTRY_ADDR,
  ESCROW_ADDR,
  VAULT_ADDR,
  PFR_ADDR,
  USDC_ADDR,
  FACILITATOR_ADDRS,
  POOL_MANAGER_ADDR,
  SWAP_LOOKBACK_BLOCKS,
} from './config.js';
import { publicClient } from './chain.js';
import { Indexer } from './indexer.js';
import * as schema from '../../server/src/db/schema.js';

const args = process.argv.slice(2);
const mode = args.includes('--backfill') ? 'backfill'
           : args.includes('--follow')   ? 'follow'
           : 'backfill'; // default to backfill

console.log(`[indexer] mode=${mode} chain=${CHAIN_ID} start=${START_BLOCK} chunk=${CHUNK_SIZE}`);

const sql = postgres(DATABASE_URL, { max: 5 });
const db = drizzle(sql, { schema });

const indexer = new Indexer(publicClient, db, {
  chainId:         CHAIN_ID,
  startBlock:      START_BLOCK,
  chunkSize:       CHUNK_SIZE,
  finalityLag:     FINALITY_LAG,
  maxRps:          MAX_RPS,
  registryAddr:    REGISTRY_ADDR,
  escrowAddr:      ESCROW_ADDR,
  vaultAddr:       VAULT_ADDR,
  pfrAddr:         PFR_ADDR,
  usdcAddr:        USDC_ADDR,
  facilitatorAddrs: FACILITATOR_ADDRS,
  poolManagerAddr: POOL_MANAGER_ADDR,
  swapLookbackBlocks: SWAP_LOOKBACK_BLOCKS,
});

await indexer.init();

if (mode === 'backfill') {
  await indexer.backfill();
  await sql.end();
  process.exit(0);
} else {
  await indexer.follow(POLL_INTERVAL_S * 1000);
}
