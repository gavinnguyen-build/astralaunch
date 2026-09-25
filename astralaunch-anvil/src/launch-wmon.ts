// Launch a WMON-paired token for fork testing.
// Mirrors 02-launch.ts but uses WMON as numeraire (numerairePrice: 0.38, 18 decimals).
// Saves state to .anvil-state/state-wmon.json.
import { DopplerSDK, getAirlockOwner, sortBeneficiaries } from '@whetstone-research/doppler-sdk/evm';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Address } from 'viem';
import {
  DAY,
  POOL_FEE,
  POOL_TOKENS,
  SHARES,
  INITIAL_MCAP_USD,
  SUPPLY,
  TICK_SPACING,
  VESTED_TOKENS,
  account,
  assertFork,
  loadContracts,
  pass,
  publicClient,
  testClient,
  wallet,
  withBuffer,
  erc20Abi,
} from './env.js';

const WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A' as Address;
const STATE_DIR = '.anvil-state';
const STATE_FILE = `${STATE_DIR}/state-wmon.json`;

async function main() {
  await assertFork();
  const creator = account('creator').address;
  const creatorWallet = wallet('creator');
  const sdk = new DopplerSDK({ publicClient, walletClient: creatorWallet, chainId: 143 });

  const airlockOwner = (await getAirlockOwner(publicClient)) as Address;

  const contracts = loadContracts();
  if (!contracts.escrow || !contracts.vault || !contracts.platformFeeReceiver) {
    throw new Error('contracts.json is missing escrow/vault/platformFeeReceiver. Deploy first.');
  }
  const escrowAddr   = contracts.escrow              as Address;
  const buybackAddr  = contracts.vault               as Address;
  const treasuryAddr = contracts.platformFeeReceiver as Address;

  const beneficiaries = sortBeneficiaries([
    { beneficiary: airlockOwner, shares: SHARES.doppler },
    { beneficiary: creator, shares: SHARES.creator },
    { beneficiary: escrowAddr, shares: SHARES.escrow },
    { beneficiary: buybackAddr, shares: SHARES.buyback },
    { beneficiary: treasuryAddr, shares: SHARES.treasury },
  ]);
  pass(beneficiaries.reduce((s, b) => s + b.shares, 0n) === 10n ** 18n, 'shares sum to 1e18');

  // Sync Anvil timestamp
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
      name: 'Astralaunch WMON Test',
      symbol: 'ALWT',
      tokenURI: 'ipfs://astralaunch-wmon-test',
      maxBalanceLimit: SUPPLY / 100n,
      balanceLimitEnd: startTime + 720,
      excludedFromBalanceLimit: [escrowAddr, buybackAddr, treasuryAddr],
    })
    .saleConfig({ initialSupply: SUPPLY, numTokensToSell: POOL_TOKENS, numeraire: WMON })
    .withCurves({
      numerairePrice: 0.38, // WMON price in USD
      numeraireDecimals: 18,
      tokenDecimals: 18,
      fee: POOL_FEE,
      tickSpacing: TICK_SPACING,
      beneficiaries,
      curves: [
        { marketCap: { start: INITIAL_MCAP_USD, end: INITIAL_MCAP_USD * 20 }, numPositions: 10, shares: 400_000_000_000_000_000n },
        { marketCap: { start: INITIAL_MCAP_USD * 20, end: 'max' }, numPositions: 10, shares: 600_000_000_000_000_000n },
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

  console.log('Simulating WMON-paired create...');
  const sim = await sdk.factory.simulateCreateMulticurve(params);
  console.log(`  predicted token ${sim.tokenAddress}, poolId ${sim.poolId}`);

  console.log('Creating...');
  const miner = setInterval(() => testClient.mine({ blocks: 1 }).catch(() => {}), 1000);
  const res = await sdk.factory.createMulticurve(params).finally(() => clearInterval(miner));
  const receipt = await publicClient.waitForTransactionReceipt({ hash: res.transactionHash });
  console.log(`  token ${res.tokenAddress}\n  tx ${res.transactionHash}\n  gasUsed ${receipt.gasUsed}`);

  // Let scheduled start pass
  await testClient.increaseTime({ seconds: 5 });
  await testClient.mine({ blocks: 1 });

  const pool = await sdk.getMulticurvePool(res.tokenAddress);
  const state = await pool.getState();
  pass(state.fee === POOL_FEE, 'pool fee is 2%', `${state.fee}`);

  const total = await publicClient.readContract({ address: res.tokenAddress, abi: erc20Abi, functionName: 'totalSupply' });
  pass(total === SUPPLY, 'total supply 1e9');

  const savedPoolKey = {
    currency0: state.poolKey.currency0 as Address,
    currency1: state.poolKey.currency1 as Address,
    fee: Number(state.poolKey.fee),
    tickSpacing: Number(state.poolKey.tickSpacing),
    hooks: state.poolKey.hooks as Address,
  };

  // Register on AstralaunchRegistry
  console.log('\nRegistering on AstralaunchRegistry...');
  if (!contracts.registry) throw new Error('contracts.json is missing registry address.');
  const registryAddr = contracts.registry as Address;
  const registryAbi = [
    {
      type: 'function', name: 'register', stateMutability: 'nonpayable',
      inputs: [{ name: 'asset', type: 'address' }, { name: 'creator', type: 'address' }],
      outputs: [{ name: 'router', type: 'address' }],
    },
    {
      type: 'function', name: 'routers', stateMutability: 'view',
      inputs: [{ name: '', type: 'address' }],
      outputs: [{ name: '', type: 'address' }],
    },
  ] as const;

  const gasEst = await publicClient.estimateContractGas({
    account: creatorWallet.account,
    address: registryAddr,
    abi: registryAbi,
    functionName: 'register',
    args: [res.tokenAddress, creator],
  });
  const registerHash = await creatorWallet.writeContract({
    address: registryAddr,
    abi: registryAbi,
    functionName: 'register',
    args: [res.tokenAddress, creator],
    gas: withBuffer(gasEst),
  });
  const registerReceipt = await publicClient.waitForTransactionReceipt({ hash: registerHash });
  if (registerReceipt.status !== 'success') throw new Error(`register reverted: ${registerHash}`);

  const routerAddr = await publicClient.readContract({
    address: registryAddr,
    abi: registryAbi,
    functionName: 'routers',
    args: [res.tokenAddress],
  });
  pass(routerAddr !== '0x0000000000000000000000000000000000000000', 'registry.register succeeded', routerAddr);

  // Save state
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({
    token: res.tokenAddress,
    poolId: res.poolId,
    poolKey: savedPoolKey,
    router: routerAddr,
    launchTx: res.transactionHash,
    launchGasUsed: receipt.gasUsed.toString(),
    numeraire: 'WMON',
  }, null, 2));

  console.log('\n=== WMON Launch + Register complete ===');
  console.log(`  asset  : ${res.tokenAddress}`);
  console.log(`  poolId : ${res.poolId}`);
  console.log(`  router : ${routerAddr}`);
  console.log(`  saved  : ${STATE_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
