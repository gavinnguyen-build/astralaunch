// Mainnet launch + register — interactive CLI for first token on Monad mainnet.
//
//   read -s CREATOR_PRIVATE_KEY && export CREATOR_PRIVATE_KEY
//   CONTRACTS_JSON_PATH=../packages/contracts/deployments/monad-mainnet.json \
//   MONAD_RPC_URL=https://rpc.monad.xyz \
//   TOKEN_NAME="MyToken" TOKEN_SYMBOL="MTK" \
//     npx tsx src/mainnet-launch.ts
//
// Safety:
//   - Refuses Anvil dev accounts on non-localhost RPC
//   - Refuses dryRun:true contracts or missing bytecode
//   - Prints full parameter summary and waits for "yes" before sending

import { DopplerSDK, getAirlockOwner, sortBeneficiaries } from '@whetstone-research/doppler-sdk/evm';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  parseEther,
  type Address,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

// ── Economics (must match SPEC §4 and packages/shared/src/constants.ts) ───────
const WAD = 10n ** 18n;
const POOL_FEE = 20_000;
const TICK_SPACING = 200;
const SHARES = {
  doppler: parseEther('0.05'),
  creator: parseEther('0.35'),
  escrow: parseEther('0.20'),
  buyback: parseEther('0.10'),
  treasury: parseEther('0.30'),
};
const SUPPLY = 1_000_000_000n * WAD;
const POOL_TOKENS = (SUPPLY * 85n) / 100n;
const VESTED_TOKENS = SUPPLY - POOL_TOKENS;
const DAY = 86_400;
const START_MCAP_USD = 10_000;
const GAS_BUFFER_BPS = 11_000n;
const USDC: Address = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'; // Monad mainnet USDC

function withBuffer(gas: bigint): bigint {
  return (gas * GAS_BUFFER_BPS) / 10_000n;
}

// ── Anvil dev accounts (never use on mainnet) ────────────────────────────────
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const ANVIL_ADDRESSES = new Set(
  Array.from({ length: 10 }, (_, i) =>
    getAddress(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).address)
  )
);

function need(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

function askYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

const registryAbi = [
  {
    type: 'function' as const, name: 'register' as const, stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'asset', type: 'address' }, { name: 'creator', type: 'address' }],
    outputs: [{ name: 'router', type: 'address' }],
  },
  {
    type: 'function' as const, name: 'routers' as const, stateMutability: 'view' as const,
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

async function main() {
  // ── 1. Signer ────────────────────────────────────────────────────────────────
  const privateKey = need('CREATOR_PRIVATE_KEY') as `0x${string}`;
  const creatorAccount = privateKeyToAccount(privateKey);
  const creator = creatorAccount.address;

  // ── 2. RPC + dev-account guard ───────────────────────────────────────────────
  const rpcUrl = need('MONAD_RPC_URL');
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(rpcUrl);

  if (!isLocalhost && ANVIL_ADDRESSES.has(getAddress(creator))) {
    throw new Error(
      `CREATOR_PRIVATE_KEY resolves to Anvil dev account ${creator}.\n` +
      `Refusing to use a dev account on non-localhost RPC (${rpcUrl}).`
    );
  }

  // ── 3. Contracts JSON ────────────────────────────────────────────────────────
  const contractsPath = need('CONTRACTS_JSON_PATH');
  if (!existsSync(contractsPath)) {
    throw new Error(`Contracts file not found: ${contractsPath}`);
  }
  const contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));

  if (contracts.dryRun === true) {
    throw new Error(
      `${contractsPath} has "dryRun": true -- these addresses are from a simulation.\n` +
      `Re-run Deploy.s.sol with --broadcast first.`
    );
  }

  const registryAddr = contracts.registry as Address;
  const escrowAddr   = contracts.escrow as Address;
  const buybackAddr  = contracts.vault as Address;
  const pfrAddr      = contracts.platformFeeReceiver as Address;

  for (const [name, addr] of Object.entries({
    registry: registryAddr, escrow: escrowAddr,
    vault: buybackAddr, platformFeeReceiver: pfrAddr,
  })) {
    if (!addr) throw new Error(`contracts.json missing "${name}"`);
  }

  // ── 4. Chain client ─────────────────────────────────────────────────────────
  const chainId = contracts.chainId ?? 143;
  const monad = defineChain({
    id: chainId,
    name: 'Monad',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  });
  const publicClient = createPublicClient({ chain: monad, transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account: creatorAccount, chain: monad, transport: http(rpcUrl),
  });

  // Verify all contract addresses have bytecode
  for (const [name, addr] of [
    ['RevpadRegistry', registryAddr],
    ['FeeEscrow', escrowAddr],
    ['BuybackVault', buybackAddr],
    ['PlatformFeeReceiver', pfrAddr],
  ] as const) {
    const code = await publicClient.getCode({ address: addr });
    if (!code || code === '0x') {
      throw new Error(`${name} (${addr}) has no bytecode on chain ${chainId}.`);
    }
  }
  console.log(`All contract addresses verified on chain ${chainId}.`);

  // ── 5. Token config ──────────────────────────────────────────────────────────
  const tokenName   = need('TOKEN_NAME');
  const tokenSymbol = need('TOKEN_SYMBOL');
  const tokenURI    = process.env.TOKEN_URI ?? '';

  // ── 6. Build launch params ───────────────────────────────────────────────────
  const sdk = new DopplerSDK({ publicClient, walletClient, chainId });
  const airlockOwner = (await getAirlockOwner(publicClient)) as Address;

  const beneficiaries = sortBeneficiaries([
    { beneficiary: airlockOwner, shares: SHARES.doppler },
    { beneficiary: creator,     shares: SHARES.creator },
    { beneficiary: escrowAddr,  shares: SHARES.escrow },
    { beneficiary: buybackAddr, shares: SHARES.buyback },
    { beneficiary: pfrAddr,     shares: SHARES.treasury },
  ]);

  const shareSum = beneficiaries.reduce((s, b) => s + b.shares, 0n);
  if (shareSum !== WAD) throw new Error(`Shares sum ${shareSum} != ${WAD}`);
  if (POOL_TOKENS + VESTED_TOKENS !== SUPPLY) throw new Error('pool + vested != supply');

  // Verify PlatformFeeReceiver has the 30% share
  const pfrBen = beneficiaries.find(
    (b) => getAddress(b.beneficiary) === getAddress(pfrAddr)
  );
  if (!pfrBen || pfrBen.shares !== SHARES.treasury) {
    throw new Error(`PlatformFeeReceiver must have 30% share`);
  }

  const now = Math.floor(Date.now() / 1000);
  const startTime = now + 60; // 1 min from now so the tx lands before start

  const params = sdk
    .buildMulticurveAuction()
    .tokenConfig({
      name: tokenName,
      symbol: tokenSymbol,
      tokenURI,
      maxBalanceLimit: SUPPLY / 100n,
      balanceLimitEnd: startTime + 720,
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
    .withIntegrator(pfrAddr)
    .build();

  // ── 7. Simulate + gas estimate ───────────────────────────────────────────────
  console.log('Simulating launch...');
  const sim = await sdk.factory.simulateCreateMulticurve(params);
  const launchGas = sim.gasEstimate ?? 0n;

  // register() gas: can't estimate before the token exists; use known upper bound
  const registerGasEst = 500_000n;

  const gasPrice = await publicClient.getGasPrice();
  const launchCost  = withBuffer(launchGas) * gasPrice;
  const registerCost = withBuffer(registerGasEst) * gasPrice;
  const totalCost   = launchCost + registerCost;
  const monBalance  = await publicClient.getBalance({ address: creator });

  // ── 8. Display summary ───────────────────────────────────────────────────────
  const sep = '══════════════════════════════════════════════════════════════';
  console.log(`\n╔${sep}╗`);
  console.log( '║             MAINNET LAUNCH CONFIRMATION                     ║');
  console.log(`╠${sep}╣`);
  console.log(`  Chain       : ${chainId} (Monad)`);
  console.log(`  RPC         : ${rpcUrl}`);
  console.log(`  Creator     : ${creator}`);
  console.log(`  MON balance : ${formatEther(monBalance)} MON`);
  console.log(`╠${sep}╣`);
  console.log(`  Token       : ${tokenName} (${tokenSymbol})`);
  console.log(`  Supply      : 1,000,000,000 (1e9)`);
  console.log(`  Pool        : 85% (${formatEther(POOL_TOKENS)})`);
  console.log(`  Vested      : 15% (${formatEther(VESTED_TOKENS)}) -- 30d cliff, 365d duration`);
  console.log(`  Start FDV   : $${START_MCAP_USD.toLocaleString()}`);
  console.log(`  Balance cap : 1% of supply, ${720}s window`);
  console.log(`  Start time  : ${new Date(startTime * 1000).toISOString()} (${startTime})`);
  console.log(`╠${sep}╣`);
  console.log(`  Beneficiaries (trading fee split):`);
  for (const b of beneficiaries) {
    const pct = (Number(b.shares) / 1e18 * 100).toFixed(0);
    let label = '';
    const addr = getAddress(b.beneficiary);
    if (addr === getAddress(airlockOwner))  label = 'Doppler/Airlock';
    else if (addr === getAddress(creator))  label = 'Creator';
    else if (addr === getAddress(escrowAddr))  label = 'FeeEscrow';
    else if (addr === getAddress(buybackAddr)) label = 'BuybackVault';
    else if (addr === getAddress(pfrAddr))     label = 'PlatformFeeReceiver';
    console.log(`    ${pct.padStart(2)}%  ${b.beneficiary}  ${label}`);
  }
  console.log(`╠${sep}╣`);
  console.log(`  Launch gas    : ${launchGas} (limit ${withBuffer(launchGas)})`);
  console.log(`  Register gas  : ~${registerGasEst} (limit ${withBuffer(registerGasEst)})`);
  console.log(`  Gas price     : ${gasPrice} wei (${Number(gasPrice) / 1e9} gwei)`);
  console.log(`  Launch cost   : ${formatEther(launchCost)} MON`);
  console.log(`  Register cost : ~${formatEther(registerCost)} MON`);
  console.log(`  Total         : ~${formatEther(totalCost)} MON`);
  console.log(`╚${sep}╝`);

  if (monBalance < totalCost * 2n) {
    console.warn(
      `\nWARNING: MON balance (${formatEther(monBalance)}) may be tight.` +
      ` Recommended: ${formatEther(totalCost * 2n)} MON`
    );
  }

  // ── 9. Confirm ───────────────────────────────────────────────────────────────
  const ok = await askYes('\nType "yes" to proceed with mainnet launch: ');
  if (!ok) {
    console.log('Aborted.');
    process.exit(0);
  }

  // ── 10. Launch ───────────────────────────────────────────────────────────────
  console.log('\nSending createMulticurve...');
  const res = await sdk.factory.createMulticurve(params);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: res.transactionHash });
  if (receipt.status !== 'success') throw new Error(`Launch tx reverted: ${res.transactionHash}`);
  console.log(`  token   : ${res.tokenAddress}`);
  console.log(`  poolId  : ${res.poolId}`);
  console.log(`  tx      : ${res.transactionHash}`);
  console.log(`  gasUsed : ${receipt.gasUsed}`);

  // ── 11. Register ─────────────────────────────────────────────────────────────
  console.log('\nSending register()...');
  const regGas = await publicClient.estimateContractGas({
    account: creatorAccount,
    address: registryAddr,
    abi: registryAbi,
    functionName: 'register',
    args: [res.tokenAddress, creator],
  });
  const registerHash = await walletClient.writeContract({
    address: registryAddr,
    abi: registryAbi,
    functionName: 'register',
    args: [res.tokenAddress, creator],
    gas: withBuffer(regGas),
  });
  const regReceipt = await publicClient.waitForTransactionReceipt({ hash: registerHash });
  if (regReceipt.status !== 'success') throw new Error(`register() reverted: ${registerHash}`);

  const routerAddr = await publicClient.readContract({
    address: registryAddr,
    abi: registryAbi,
    functionName: 'routers',
    args: [res.tokenAddress],
  });

  // ── 12. Results ──────────────────────────────────────────────────────────────
  console.log('\n=== MAINNET LAUNCH + REGISTER COMPLETE ===');
  console.log(`  asset    : ${res.tokenAddress}`);
  console.log(`  poolId   : ${res.poolId}`);
  console.log(`  router   : ${routerAddr}`);
  console.log(`  launch tx: ${res.transactionHash}  (gas ${receipt.gasUsed})`);
  console.log(`  register : ${registerHash}  (gas ${regReceipt.gasUsed})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
