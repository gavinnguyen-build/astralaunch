// Launch tokens with dev buy for fork testing.
// Variant 1: dev buy WITH vesting (Bundler holds tokens, 365d vest / 30d cliff)
// Variant 2: dev buy WITHOUT vesting (direct delivery to recipient)
// Saves to .anvil-state/state-devbuy-vesting.json and .anvil-state/state-devbuy.json.
import { DopplerSDK, getAirlockOwner, sortBeneficiaries } from '@whetstone-research/doppler-sdk/evm';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseUnits, type Address } from 'viem';
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
  loadContracts,
  pass,
  publicClient,
  testClient,
  wallet,
  withBuffer,
  erc20Abi,
} from './env.js';

const STATE_DIR = '.anvil-state';

async function launchWithDevBuy(variant: 'vesting' | 'no-vesting') {
  const creator = account('creator').address;
  const creatorWallet = wallet('creator');
  const sdk = new DopplerSDK({ publicClient, walletClient: creatorWallet, chainId: 143 });
  const airlockOwner = (await getAirlockOwner(publicClient)) as Address;

  const contracts = loadContracts();
  if (!contracts.escrow || !contracts.vault || !contracts.platformFeeReceiver) {
    throw new Error('contracts.json is missing escrow/vault/platformFeeReceiver.');
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

  // Sync Anvil timestamp
  const realNow = Math.floor(Date.now() / 1000);
  const currentBlock = await publicClient.getBlock();
  if (Number(currentBlock.timestamp) < realNow) {
    await testClient.setNextBlockTimestamp({ timestamp: BigInt(realNow) });
    await testClient.mine({ blocks: 1 });
  }
  const now = Number((await publicClient.getBlock()).timestamp);
  const startTime = now + 2;

  const suffix = variant === 'vesting' ? 'DV' : 'DN';
  let builder = sdk
    .buildMulticurveAuction()
    .tokenConfig({
      name: `Astralaunch DevBuy ${suffix}`,
      symbol: `ALD${suffix}`,
      tokenURI: `ipfs://astralaunch-devbuy-${variant}`,
      maxBalanceLimit: SUPPLY / 100n,
      balanceLimitEnd: startTime + 720,
      excludedFromBalanceLimit: [escrowAddr, buybackAddr, treasuryAddr],
    })
    .saleConfig({ initialSupply: SUPPLY, numTokensToSell: POOL_TOKENS, numeraire: USDC })
    .withCurves({
      numerairePrice: 1,
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
    .withIntegrator(treasuryAddr);

  // Add dev buy: 100 USDC exact input
  const devBuyAmount = parseUnits('100', 6); // 100 USDC
  if (variant === 'vesting') {
    builder = builder.withDevBuy({
      exactAmountIn: devBuyAmount,
      recipient: creator,
      vesting: {
        vestingDuration: BigInt(365 * DAY),
        cliffDuration: BigInt(30 * DAY),
        permissionlessClaim: false,
      },
    });
  } else {
    builder = builder.withDevBuy({
      exactAmountIn: devBuyAmount,
      recipient: creator,
      // No vesting — tokens delivered directly
    });
  }

  const params = builder.build();

  console.log(`\nSimulating devBuy (${variant})...`);
  const sim = await sdk.factory.simulateCreateMulticurve(params);
  console.log(`  predicted token ${sim.tokenAddress}, poolId ${sim.poolId}`);

  // Mint USDC to creator for the dev buy
  // Use testClient to impersonate the USDC contract and mint
  await testClient.setBalance({ address: creator, value: parseUnits('100', 18) });
  // Approve USDC spending — creator needs USDC for the dev buy
  // The SDK's createMulticurve handles the USDC approval internally via Permit2

  console.log(`Creating (${variant})...`);
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
  console.log('Registering...');
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
  const stateFile = variant === 'vesting'
    ? `${STATE_DIR}/state-devbuy-vesting.json`
    : `${STATE_DIR}/state-devbuy.json`;
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({
    token: res.tokenAddress,
    poolId: res.poolId,
    poolKey: savedPoolKey,
    router: routerAddr,
    devBuyAmount: devBuyAmount.toString(),
    devBuyVesting: variant === 'vesting',
    devBuyResult: res.devBuy ?? null,
    launchTx: res.transactionHash,
    launchGasUsed: receipt.gasUsed.toString(),
  }, null, 2));

  console.log(`\n=== DevBuy (${variant}) Launch + Register complete ===`);
  console.log(`  asset  : ${res.tokenAddress}`);
  console.log(`  router : ${routerAddr}`);
  console.log(`  saved  : ${stateFile}`);
}

async function main() {
  await assertFork();

  // Launch both variants sequentially (each uses the same creator wallet)
  await launchWithDevBuy('vesting');
  await launchWithDevBuy('no-vesting');
}

main().catch((e) => { console.error(e); process.exit(1); });
