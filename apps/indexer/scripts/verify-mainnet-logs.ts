#!/usr/bin/env npx tsx
/**
 * Verify v2 event decoding against real mainnet transaction logs.
 * Decodes the Registered event from two known txs (SIGHT and FEED).
 *
 * Usage: MONAD_RPC_URL=https://rpc.monad.xyz npx tsx apps/indexer/scripts/verify-mainnet-logs.ts
 */
import { createPublicClient, http, decodeEventLog, type Hex } from 'viem';
import { monad } from 'viem/chains';
import { registeredEvent, staticEvents } from '../src/abis.js';

const RPC = process.env.MONAD_RPC_URL ?? 'https://rpc.monad.xyz';

const client = createPublicClient({
  chain: monad,
  transport: http(RPC),
});

const TXS = [
  {
    label: 'SIGHT register',
    hash: '0xd88f895e0136111f30353ca2a50c92e15c39da6fba4a51a77aaeae089cb9cec8' as Hex,
    expectedRouter: '0x10bC',
    expectedNumeraire: 'USDC',
  },
  {
    label: 'FEED register',
    hash: '0xbcba31a69aa7f6c92b961bfdb69e0d3700eeff5875418431c20347bc7c31ccb8' as Hex,
    expectedRouter: '0xdBa0',
    expectedNumeraire: 'WMON',
  },
];

const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'.toLowerCase();
const WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A'.toLowerCase();

for (const tx of TXS) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${tx.label}: ${tx.hash}`);
  console.log('='.repeat(60));

  const receipt = await client.getTransactionReceipt({ hash: tx.hash });
  console.log(`Block: ${receipt.blockNumber}, status: ${receipt.status}`);
  console.log(`Logs: ${receipt.logs.length}`);

  // Find and decode the Registered event
  let found = false;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: [registeredEvent],
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });

      if (decoded.eventName === 'Registered') {
        found = true;
        const args = decoded.args as any;
        const numeraireLabel = args.numeraire.toLowerCase() === USDC ? 'USDC'
          : args.numeraire.toLowerCase() === WMON ? 'WMON'
          : 'UNKNOWN';

        console.log(`\nRegistered event decoded:`);
        console.log(`  asset:       ${args.asset}`);
        console.log(`  creator:     ${args.creator}`);
        console.log(`  router:      ${args.router}`);
        console.log(`  poolId:      ${args.poolId}`);
        console.log(`  numeraire:   ${args.numeraire} (${numeraireLabel})`);
        console.log(`  initializer: ${args.initializer}`);
        console.log(`  timestamp:   ${args.timestamp}`);

        // Verify expectations
        const routerPrefix = args.router.slice(0, 6);
        const numeraireMatch = numeraireLabel === tx.expectedNumeraire;
        const routerMatch = routerPrefix.toLowerCase() === tx.expectedRouter.toLowerCase();

        console.log(`\nVerification:`);
        console.log(`  Router prefix matches ${tx.expectedRouter}: ${routerMatch ? 'PASS' : 'FAIL'}`);
        console.log(`  Numeraire is ${tx.expectedNumeraire}: ${numeraireMatch ? 'PASS' : 'FAIL'}`);

        if (!routerMatch || !numeraireMatch) {
          console.error(`  VERIFICATION FAILED`);
          process.exit(1);
        }
      }
    } catch {
      // Not a Registered event, skip
    }
  }

  if (!found) {
    console.error(`  FAIL: No Registered event found in tx ${tx.hash}`);
    process.exit(1);
  }
}

console.log('\n' + '='.repeat(60));
console.log('All mainnet log verifications PASSED');
console.log('='.repeat(60));
