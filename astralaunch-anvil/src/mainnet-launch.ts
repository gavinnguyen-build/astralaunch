// Mainnet launch + register — v2 CLI for launching tokens on Monad mainnet.
// Supports both USDC and MON (WMON) pairing. MON price from Chainlink oracle.
//
//   read -s CREATOR_PRIVATE_KEY && export CREATOR_PRIVATE_KEY
//   CONTRACTS_JSON_PATH=../packages/contracts/deployments/monad-mainnet.json \
//   MONAD_RPC_URL=https://rpc.monad.xyz \
//   PAIRING=usdc \
//   TOKEN_NAME="MyToken" TOKEN_SYMBOL="MTK" \
//     npx tsx src/mainnet-launch.ts
//
// Env vars:
//   TOKEN_NAME            (required)
//   TOKEN_SYMBOL          (required)
//   PAIRING               (required: usdc | mon)
//   CREATOR_PRIVATE_KEY   (required)
//   CONTRACTS_JSON_PATH   (required — points to monad-mainnet.json)
//   MONAD_RPC_URL         (required)
//   TOKEN_URI             (optional)
//
// Flags:
//   --yes                 Skip interactive confirmation (for CI / Anvil scripting)
//
// Safety:
//   - Refuses Anvil dev accounts on non-localhost RPC
//   - Refuses dryRun:true contracts or missing bytecode
//   - Recomputes startTime from latest block after confirmation (not wall-clock)
//   - Estimates register() gas on-chain after launch (no hardcoded guess)
//   - If register fails, prints instructions to retry with mainnet-register.ts

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
  type PublicClient,
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
const INITIAL_MCAP_USD = 2_500; // $2,500 initial FDV — fixed, not user-visible (O1 closed)
const GAS_BUFFER_BPS = 11_000n;
const MAX_ORACLE_STALENESS_S = 3_600; // 1 hour

// Known Monad mainnet addresses
const USDC_ADDR: Address = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const WMON_ADDR: Address = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';
const MON_USD_ORACLE: Address = '0xBcD78f76005B7515837af6b50c7C52BCf73822fb';

// Balance cap window bounds (from AstralaunchConstants.sol)
const CAP_WINDOW_MIN = 600;  // 10 minutes
const CAP_WINDOW_MAX = 900;  // 15 minutes

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

const autoConfirm = process.argv.includes('--yes');

export const registryAbi = [
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

const tokenCapAbi = [
  { type: 'function' as const, name: 'vestingStart' as const, stateMutability: 'view' as const, inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function' as const, name: 'balanceLimitEnd' as const, stateMutability: 'view' as const, inputs: [], outputs: [{ type: 'uint48' }] },
] as const;

const latestRoundDataAbi = [
  {
    type: 'function' as const, name: 'latestRoundData' as const, stateMutability: 'view' as const,
    inputs: [],
    outputs: [
      { type: 'uint80' },  // roundId
      { type: 'int256' },  // answer
      { type: 'uint256' }, // startedAt
      { type: 'uint256' }, // updatedAt
      { type: 'uint80' },  // answeredInRound
    ],
  },
] as const;

type Pairing = 'usdc' | 'mon';

/** Read Chainlink MON/USD price. Rejects if stale. Returns price as a number (e.g. 0.38). */
async function readOraclePrice(client: PublicClient): Promise<{ priceUsd: number; updatedAt: number }> {
  const [, answer, , updatedAt] = await client.readContract({
    address: MON_USD_ORACLE,
    abi: latestRoundDataAbi,
    functionName: 'latestRoundData',
  });

  const block = await client.getBlock();
  const blockTs = Number(block.timestamp);
  const oracleUpdatedAt = Number(updatedAt);

  if (blockTs - oracleUpdatedAt > MAX_ORACLE_STALENESS_S) {
    throw new Error(
      `Chainlink MON/USD oracle stale: updatedAt=${oracleUpdatedAt}, blockTs=${blockTs}, ` +
      `delta=${blockTs - oracleUpdatedAt}s > ${MAX_ORACLE_STALENESS_S}s max.`
    );
  }

  // Chainlink MON/USD has 8 decimals.
  const priceUsd = Number(answer) / 1e8;
  if (priceUsd <= 0) throw new Error(`Oracle returned non-positive price: ${priceUsd}`);
  return { priceUsd, updatedAt: oracleUpdatedAt };
}

/** Build SDK launch params for a given startTime. */
function buildParams(
  sdk: DopplerSDK,
  opts: {
    tokenName: string; tokenSymbol: string; tokenURI: string;
    startTime: number; beneficiaries: Array<{ beneficiary: Address; shares: bigint }>;
    creator: Address; pfrAddr: Address;
    numeraire: Address; numerairePrice: number; numeraireDecimals: number;
    excludedFromBalanceLimit: Address[];
  },
) {
  return sdk
    .buildMulticurveAuction()
    .tokenConfig({
      name: opts.tokenName,
      symbol: opts.tokenSymbol,
      tokenURI: opts.tokenURI,
      maxBalanceLimit: SUPPLY / 100n,
      balanceLimitEnd: opts.startTime + 720,
      excludedFromBalanceLimit: opts.excludedFromBalanceLimit,
    })
    .saleConfig({ initialSupply: SUPPLY, numTokensToSell: POOL_TOKENS, numeraire: opts.numeraire })
    .withCurves({
      numerairePrice: opts.numerairePrice,
      numeraireDecimals: opts.numeraireDecimals,
      tokenDecimals: 18,
      fee: POOL_FEE,
      tickSpacing: TICK_SPACING,
      beneficiaries: opts.beneficiaries,
      curves: [
        { marketCap: { start: INITIAL_MCAP_USD, end: INITIAL_MCAP_USD * 20 }, numPositions: 10, shares: 400_000_000_000_000_000n },
        { marketCap: { start: INITIAL_MCAP_USD * 20, end: 'max' }, numPositions: 10, shares: 600_000_000_000_000_000n },
      ],
    })
    .withSchedule({ startTime: opts.startTime })
    .withVesting({
      duration: BigInt(365 * DAY),
      cliffDuration: 30 * DAY,
      recipients: [opts.creator],
      amounts: [VESTED_TOKENS],
    })
    .withGovernance({ type: 'noOp' })
    .withMigration({ type: 'noOp' })
    .withUserAddress(opts.creator)
    .withIntegrator(opts.pfrAddr)
    .build();
}

/** Read on-chain balance cap window and validate it is within [600, 900] s. */
export async function checkCapWindow(
  publicClient: PublicClient,
  asset: Address,
): Promise<{ vestingStart: bigint; balanceLimitEnd: bigint; window: bigint }> {
  const vestStart = await publicClient.readContract({
    address: asset, abi: tokenCapAbi, functionName: 'vestingStart',
  });
  const capEnd = await publicClient.readContract({
    address: asset, abi: tokenCapAbi, functionName: 'balanceLimitEnd',
  });
  const capEndBig = BigInt(capEnd);
  const window = capEndBig > vestStart ? capEndBig - vestStart : 0n;

  if (window < BigInt(CAP_WINDOW_MIN) || window > BigInt(CAP_WINDOW_MAX)) {
    throw new Error(
      `Balance cap window ${window}s is outside [${CAP_WINDOW_MIN}, ${CAP_WINDOW_MAX}].\n` +
      `vestingStart=${vestStart}, balanceLimitEnd=${capEndBig}.\n` +
      `register() will revert with WrongBalanceCap. Do NOT retry without fixing the window.`
    );
  }

  return { vestingStart: vestStart, balanceLimitEnd: capEndBig, window };
}

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

  // ── 4. Determine numeraire ────────────────────────────────────────────────────
  const pairingEnv = (process.env.PAIRING ?? 'usdc').toLowerCase();
  if (pairingEnv !== 'usdc' && pairingEnv !== 'mon') {
    throw new Error(`PAIRING must be "usdc" or "mon", got "${pairingEnv}"`);
  }
  const pairing: Pairing = pairingEnv;

  // ── 5. Chain client ─────────────────────────────────────────────────────────
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
    ['AstralaunchRegistry', registryAddr],
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

  // ── 6. Numeraire config ───────────────────────────────────────────────────────
  let numeraire: Address;
  let numerairePrice: number;
  let numeraireDecimals: number;
  let numeraireSymbol: string;
  let oraclePriceStr: string;

  if (pairing === 'usdc') {
    numeraire = USDC_ADDR;
    numerairePrice = 1;
    numeraireDecimals = 6;
    numeraireSymbol = 'USDC';
    oraclePriceStr = '$1.00 (stablecoin)';
  } else {
    numeraire = WMON_ADDR;
    numeraireDecimals = 18;
    numeraireSymbol = 'MON';
    console.log('Reading Chainlink MON/USD oracle...');
    const oracle = await readOraclePrice(publicClient);
    numerairePrice = oracle.priceUsd;
    oraclePriceStr = `$${numerairePrice.toFixed(4)} (Chainlink, updated ${new Date(oracle.updatedAt * 1000).toISOString()})`;
    console.log(`  MON/USD: ${oraclePriceStr}`);
  }

  // ── 7. Token config ──────────────────────────────────────────────────────────
  const tokenName   = need('TOKEN_NAME');
  const tokenSymbol = need('TOKEN_SYMBOL');
  const tokenURI    = process.env.TOKEN_URI ?? '';

  // ── 8. Build preview params (preliminary startTime for gas estimate) ────────
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

  const pfrBen = beneficiaries.find(
    (b) => getAddress(b.beneficiary) === getAddress(pfrAddr)
  );
  if (!pfrBen || pfrBen.shares !== SHARES.treasury) {
    throw new Error(`PlatformFeeReceiver must have 30% share`);
  }

  const excludedFromBalanceLimit = [escrowAddr, buybackAddr, pfrAddr];

  const buildOpts = {
    tokenName, tokenSymbol, tokenURI, beneficiaries, creator, pfrAddr,
    numeraire, numerairePrice, numeraireDecimals, excludedFromBalanceLimit,
  };

  // Preliminary simulation for gas preview
  const previewBlock = await publicClient.getBlock();
  const previewStart = Number(previewBlock.timestamp) + 60;
  const previewParams = buildParams(sdk, { ...buildOpts, startTime: previewStart });

  console.log('Simulating launch (preview)...');
  const previewSim = await sdk.factory.simulateCreateMulticurve(previewParams);
  const launchGas = previewSim.gasEstimate ?? 0n;

  const gasPrice = await publicClient.getGasPrice();
  const launchCost = withBuffer(launchGas) * gasPrice;
  const monBalance = await publicClient.getBalance({ address: creator });

  // ── 9. Display summary ───────────────────────────────────────────────────────
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
  console.log(`  Pairing     : ${numeraireSymbol} (${numeraire})`);
  console.log(`  Supply      : 1,000,000,000 (1e9)`);
  console.log(`  Pool        : 85% (${formatEther(POOL_TOKENS)})`);
  console.log(`  Vested      : 15% (${formatEther(VESTED_TOKENS)}) -- 30d cliff, 365d duration`);
  console.log(`  Initial FDV : $${INITIAL_MCAP_USD.toLocaleString()}`);
  console.log(`  Numeraire $ : ${oraclePriceStr}`);
  console.log(`  Balance cap : 1% of supply, 720s target window`);
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
  console.log(`  Excluded from balance limit: ${excludedFromBalanceLimit.join(', ')}`);
  console.log(`╠${sep}╣`);
  console.log(`  Curves:`);
  console.log(`    [1] $${INITIAL_MCAP_USD} → $${INITIAL_MCAP_USD * 20}  (10 positions, 40% liquidity)`);
  console.log(`    [2] $${INITIAL_MCAP_USD * 20} → max  (10 positions, 60% liquidity)`);
  console.log(`╠${sep}╣`);
  console.log(`  Launch gas  : ${launchGas} (limit ${withBuffer(launchGas)})`);
  console.log(`  Register gas: estimated after launch (not hardcoded)`);
  console.log(`  Gas price   : ${gasPrice} wei (${Number(gasPrice) / 1e9} gwei)`);
  console.log(`  Launch cost : ${formatEther(launchCost)} MON`);
  console.log(`  NOTE: startTime will be recomputed from latest block after you confirm`);
  console.log(`╚${sep}╝`);

  if (monBalance < launchCost * 3n) {
    console.warn(
      `\nWARNING: MON balance (${formatEther(monBalance)}) may be tight.` +
      ` Recommended: ${formatEther(launchCost * 3n)} MON (launch + register + buffer)`
    );
  }

  // ── 10. Confirm ──────────────────────────────────────────────────────────────
  if (autoConfirm) {
    console.log('\n--yes flag set, skipping confirmation.');
  } else {
    const ok = await askYes('\nType "yes" to proceed with mainnet launch: ');
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // ── 11. Recompute startTime from latest block (not wall-clock) ──────────────
  const freshBlock = await publicClient.getBlock();
  const startTime = Number(freshBlock.timestamp) + 60;
  const balanceLimitEnd = startTime + 720;
  console.log(`\nRecomputed: startTime=${startTime}, balanceLimitEnd=${balanceLimitEnd} (block ${freshBlock.number}, ts ${freshBlock.timestamp})`);

  const params = buildParams(sdk, { ...buildOpts, startTime });

  console.log('Re-simulating with final startTime...');
  const sim = await sdk.factory.simulateCreateMulticurve(params);
  console.log(`  predicted token: ${sim.tokenAddress}, gas: ${sim.gasEstimate ?? 'n/a'}`);

  // ── 12. Launch ───────────────────────────────────────────────────────────────
  console.log('\nSending createMulticurve...');
  const finalGas = sim.gasEstimate ?? launchGas;
  const res = await sdk.factory.createMulticurve({
    ...params,
    gas: withBuffer(finalGas),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: res.transactionHash });
  if (receipt.status !== 'success') throw new Error(`Launch tx reverted: ${res.transactionHash}`);
  console.log(`  token   : ${res.tokenAddress}`);
  console.log(`  poolId  : ${res.poolId}`);
  console.log(`  tx      : ${res.transactionHash}`);
  console.log(`  gasUsed : ${receipt.gasUsed}`);

  // ── 13. Validate balance cap window on-chain before register ───────────────
  console.log('\nChecking on-chain balance cap window...');
  const { vestingStart, balanceLimitEnd: capEnd, window: capWindow } =
    await checkCapWindow(publicClient, res.tokenAddress as Address);
  console.log(`  vestingStart=${vestingStart}, balanceLimitEnd=${capEnd}, window=${capWindow}s -- OK`);

  // ── 14. Register with on-chain gas estimate ────────────────────────────────
  console.log('\nEstimating register() gas...');
  let regGas: bigint;
  try {
    regGas = await publicClient.estimateContractGas({
      account: creatorAccount,
      address: registryAddr,
      abi: registryAbi,
      functionName: 'register',
      args: [res.tokenAddress as Address, creator],
    });
  } catch (err: any) {
    console.error('\nERROR: register() gas estimation failed. The token is launched but NOT registered.');
    console.error(`  Revert reason: ${err.shortMessage ?? err.message}`);
    console.error(`\n  Token address: ${res.tokenAddress}`);
    console.error(`  Launch tx:     ${res.transactionHash}`);
    console.error(`\n  To retry registration:\n`);
    console.error(`    ASSET_ADDRESS=${res.tokenAddress} \\`);
    console.error(`    CONTRACTS_JSON_PATH=${contractsPath} \\`);
    console.error(`    MONAD_RPC_URL=${rpcUrl} \\`);
    console.error(`      npx tsx src/mainnet-register.ts`);
    process.exit(1);
  }
  console.log(`  register gas estimate: ${regGas} (limit ${withBuffer(regGas)})`);

  console.log('Sending register()...');
  const registerHash = await walletClient.writeContract({
    address: registryAddr,
    abi: registryAbi,
    functionName: 'register',
    args: [res.tokenAddress as Address, creator],
    gas: withBuffer(regGas),
  });
  const regReceipt = await publicClient.waitForTransactionReceipt({ hash: registerHash });
  if (regReceipt.status !== 'success') throw new Error(`register() reverted: ${registerHash}`);

  const routerAddr = await publicClient.readContract({
    address: registryAddr,
    abi: registryAbi,
    functionName: 'routers',
    args: [res.tokenAddress as Address],
  });

  // ── 15. Results ──────────────────────────────────────────────────────────────
  console.log('\n=== MAINNET LAUNCH + REGISTER COMPLETE ===');
  console.log(`  asset    : ${res.tokenAddress}`);
  console.log(`  poolId   : ${res.poolId}`);
  console.log(`  router   : ${routerAddr}`);
  console.log(`  pairing  : ${numeraireSymbol}`);
  console.log(`  launch tx: ${res.transactionHash}  (gas ${receipt.gasUsed})`);
  console.log(`  register : ${registerHash}  (gas ${regReceipt.gasUsed})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
