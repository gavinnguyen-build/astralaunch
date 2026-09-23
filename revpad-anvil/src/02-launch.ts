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
  loadContracts,
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

  // Require addresses from contracts.json (written by Deploy.s.sol).
  // Never silently fall back to stub addresses — a wrong beneficiary means trading fees
  // go to an uncontrolled wallet and can never be recovered.
  const contracts = loadContracts();
  if (!contracts.escrow || !contracts.vault) {
    throw new Error(
      `contracts.json is missing escrow and/or vault addresses.\n` +
      `Run: forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $PRIVATE_KEY\n` +
      `Expected file: .anvil-state/contracts.json`
    );
  }
  const escrowAddr   = contracts.escrow   as Address;
  const buybackAddr  = contracts.vault    as Address;
  const treasuryAddr = (contracts.treasury ?? process.env.TREASURY_ADDRESS ?? account('treasury').address) as Address;

  console.log('Beneficiary addresses (from contracts.json):');
  console.log(`  escrow   (FeeEscrow)    : ${escrowAddr}`);
  console.log(`  vault    (BuybackVault) : ${buybackAddr}`);
  console.log(`  treasury                : ${treasuryAddr}`);
  pass(escrowAddr  === contracts.escrow,   'escrow  matches contracts.json', escrowAddr);
  pass(buybackAddr === contracts.vault,    'vault   matches contracts.json', buybackAddr);
  const beneficiaries = sortBeneficiaries([
    { beneficiary: airlockOwner, shares: SHARES.doppler },
    { beneficiary: creator, shares: SHARES.creator },
    { beneficiary: escrowAddr, shares: SHARES.escrow },
    { beneficiary: buybackAddr, shares: SHARES.buyback },
    { beneficiary: treasuryAddr, shares: SHARES.treasury },
  ]);
  const shareSum = beneficiaries.reduce((s, b) => s + b.shares, 0n);
  pass(shareSum === 10n ** 18n, 'beneficiary shares sum to 1e18');
  pass(POOL_TOKENS + VESTED_TOKENS === SUPPLY, 'pool + vested == supply (nothing leaks to timelock)');

  // Sync Anvil's block timestamp to real time before deploying so that
  // vestingStart (= block.timestamp at deploy) ≈ startTime.  Without this,
  // a historical fork block causes balanceLimitEnd - vestingStart to be
  // hours wide instead of the intended 600 s (see docs/decisions.md D18).
  const realNow = Math.floor(Date.now() / 1000);
  const currentBlock = await publicClient.getBlock();
  if (Number(currentBlock.timestamp) < realNow) {
    await testClient.setNextBlockTimestamp({ timestamp: BigInt(realNow) });
    await testClient.mine({ blocks: 1 });
  }
  const now = Number((await publicClient.getBlock()).timestamp);
  const startTime = now + 2;

  const params = sdk
    .buildMulticurveAuction()
    .tokenConfig({
      name: 'Revpad Test',
      symbol: 'RVPT',
      tokenURI: 'ipfs://revpad-test',
      // Per-wallet cap window: 1% of supply, 15 min (900 s = spec max).
      // Use 900 s — not 600 s — so that block-mining lag between reading `now`
      // and the createMulticurve tx landing (~10-30 s on Anvil) does not push
      // vestingStart above balanceLimitEnd - 600, which would fail the registry
      // WrongBalanceCap check.  The registry allows [600, 900] s windows.
      // (decisions.md D20)
      maxBalanceLimit: SUPPLY / 100n,
      balanceLimitEnd: startTime + 900,
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
    .withIntegrator(treasuryAddr)
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
