// Test 02 — launch with Revpad's fixed economics (SPEC §4, §6.1, §17)
// 2% fee, 5/35/20/10/30 beneficiaries, 85% pool / 15% vested (30d cliff, 1y), no migration.
import { DopplerSDK, getAirlockOwner, sortBeneficiaries } from '@whetstone-research/doppler-sdk/evm';
import type { Address } from 'viem';
import {
  DAY,
  POOL_FEE,
  POOL_TOKENS,
  SHARES,
  START_MCAP_USD,
  SUPPLY,
  TICK_SPACING,
  USDC,
  VESTED_TOKENS,
  account,
  assertFork,
  balanceOf,
  erc20Abi,
  pass,
  publicClient,
  saveState,
  testClient,
  wallet,
  withBuffer,
} from './env.js';

async function main() {
  await assertFork();
  const creator = account('creator').address;
  const creatorWallet = wallet('creator');
  const sdk = new DopplerSDK({ publicClient, walletClient: creatorWallet, chainId: 143 });

  const airlockOwner = (await getAirlockOwner(publicClient)) as Address;
  const beneficiaries = sortBeneficiaries([
    { beneficiary: airlockOwner, shares: SHARES.doppler },
    { beneficiary: creator, shares: SHARES.creator },
    { beneficiary: account('escrowStub').address, shares: SHARES.escrow },
    { beneficiary: account('buybackStub').address, shares: SHARES.buyback },
    { beneficiary: account('treasury').address, shares: SHARES.treasury },
  ]);
  const shareSum = beneficiaries.reduce((s, b) => s + b.shares, 0n);
  pass(shareSum === 10n ** 18n, 'beneficiary shares sum to 1e18');
  pass(POOL_TOKENS + VESTED_TOKENS === SUPPLY, 'pool + vested == supply (nothing leaks to timelock)');

  // Use wall clock for startTime: the SDK validates balanceLimitEnd > Date.now()/1000.
  // On a reverted fork the block timestamp can lag real time by minutes, causing the
  // SDK's client-side guard to throw even when startTime is future relative to the block.
  const now = Math.max(Number((await publicClient.getBlock()).timestamp), Math.floor(Date.now() / 1000));
  const startTime = now + 2;

  const params = sdk
    .buildMulticurveAuction()
    .tokenConfig({
      name: 'Revpad Test',
      symbol: 'RVPT',
      tokenURI: 'ipfs://revpad-test',
      // Per-wallet cap during the first 10 minutes (open decision O3): 1% of supply.
      maxBalanceLimit: SUPPLY / 100n,
      balanceLimitEnd: startTime + 600,
    })
    .saleConfig({ initialSupply: SUPPLY, numTokensToSell: POOL_TOKENS, numeraire: USDC })
    .withCurves({
      numerairePrice: 1, // USDC
      numeraireDecimals: 6,
      tokenDecimals: 18,
      fee: POOL_FEE,
      tickSpacing: TICK_SPACING,
      beneficiaries,
      curves: [
        { marketCap: { start: START_MCAP_USD, end: START_MCAP_USD * 20 }, numPositions: 10, shares: 400_000_000_000_000_000n },
        { marketCap: { start: START_MCAP_USD * 20, end: 'max' }, numPositions: 10, shares: 600_000_000_000_000_000n },
      ],
    })
    .withSchedule({ startTime })
    .withVesting({
      duration: BigInt(365 * DAY),
      cliffDuration: 30 * DAY,
      recipients: [creator],
      amounts: [VESTED_TOKENS],
    })
    .withGovernance({ type: 'noOp' })
    .withMigration({ type: 'noOp' })
    .withUserAddress(creator)
    .withIntegrator(account('treasury').address)
    .build();

  console.log('Simulating create...');
  const sim = await sdk.factory.simulateCreateMulticurve(params);
  console.log(`  predicted token ${sim.tokenAddress}, poolId ${sim.poolId}, gasEstimate ${sim.gasEstimate ?? 'n/a'}`);
  if (sim.gasEstimate) {
    pass(sim.gasEstimate < 30_000_000n, 'launch gas < Monad 30M per-tx limit', `${sim.gasEstimate}`);
    console.log(`  gasLimit to send on real Monad: ${withBuffer(sim.gasEstimate)} (Anvil uses Ethereum opcode pricing; re-measure on Monad)`);
  }

  console.log('Creating...');
  // Doppler SDK calls waitForTransactionReceipt({ confirmations: 2 }), which requires two
  // blocks to be mined after the tx block.  Anvil's --block-time does not mine empty
  // interval blocks on a fork, so we drive mining ourselves while awaiting the SDK call.
  const miner = setInterval(() => testClient.mine({ blocks: 1 }).catch(() => {}), 1000);
  const res = await sdk.factory.createMulticurve(params).finally(() => clearInterval(miner));
  const receipt = await publicClient.waitForTransactionReceipt({ hash: res.transactionHash });
  console.log(`  token ${res.tokenAddress}\n  tx ${res.transactionHash}\n  gasUsed ${receipt.gasUsed}`);

  // let the scheduled start pass
  await testClient.increaseTime({ seconds: 5 });
  await testClient.mine({ blocks: 1 });

  const pool = await sdk.getMulticurvePool(res.tokenAddress);
  const state = await pool.getState();
  console.log(`  pool fee ${state.fee}, tickSpacing ${state.tickSpacing}, status ${state.status}`);
  pass(state.fee === POOL_FEE, 'pool fee is 2%', `${state.fee}`);

  const total = await publicClient.readContract({ address: res.tokenAddress, abi: erc20Abi, functionName: 'totalSupply' });
  pass(total === SUPPLY, 'total supply 1e9');
  const creatorBal = await balanceOf(res.tokenAddress, creator);
  pass(creatorBal === 0n, 'creator holds 0 tokens at launch (allocation is vested)', `${creatorBal}`);

  saveState({
    token: res.tokenAddress,
    poolId: res.poolId,
    poolKey: {
      currency0: state.poolKey.currency0 as Address,
      currency1: state.poolKey.currency1 as Address,
      fee: Number(state.poolKey.fee),
      tickSpacing: Number(state.poolKey.tickSpacing),
      hooks: state.poolKey.hooks as Address,
    },
    launchTx: res.transactionHash,
    launchGasUsed: receipt.gasUsed.toString(),
    buyVolumeUsdc: '0',
    sellVolumeToken: '0',
  });
  console.log('\nSaved to .anvil-state/state.json. Next: npm run trade');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
