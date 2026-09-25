// real-01-gas.ts — Gas estimation on real Monad mainnet (chainId 143). NO transactions sent.
// Requires .env.real with REAL_PRIVATE_KEY (must NOT be an Anvil dev account).
// Builds the same launch params as 02-launch.ts and calls simulateCreateMulticurve
// against the live chain. Compares against Anvil-measured 4,547,173 gas.
// NOTE: Foundry 1.8.3 with --network monad already uses Monad opcode pricing on Anvil,
// so the ratio between simulated and Anvil-measured values is expected to be ~1.0.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.real' });

import { DopplerSDK, getAirlockOwner, sortBeneficiaries } from '@whetstone-research/doppler-sdk/evm';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatGwei,
  formatUnits,
  http,
  parseEther,
  publicActions,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---- Anvil dev account addresses (mnemonic indices 0–9, m/44'/60'/0'/0/N) ----
// Refuse to proceed if REAL_PRIVATE_KEY resolves to any of these.
const ANVIL_DEV = new Set([
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
  '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
  '0x976ea74026e726554db657fa54763abd0c3a0aa9',
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f',
  '0xa0ee7a142d267c1f36714e4a8f75612f20a79720',
]);

// ---- Astralaunch SPEC §4 constants — must match env.ts ----
const CHAIN_ID = 143;
const MONAD_RPC = process.env.REAL_RPC_URL ?? 'https://rpc.monad.xyz';
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address;
const POOL_FEE = Number(process.env.POOL_FEE ?? 20_000);
const TICK_SPACING = Number(process.env.TICK_SPACING ?? 200);
const START_MCAP_USD = Number(process.env.START_MCAP_USD ?? 10_000);
const WAD = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WAD;
const POOL_TOKENS = (SUPPLY * 85n) / 100n;
const VESTED_TOKENS = SUPPLY - POOL_TOKENS;
const DAY = 86_400;
const SHARES = {
  doppler: parseEther('0.05'),
  creator: parseEther('0.35'),
  escrow:  parseEther('0.20'),
  buyback: parseEther('0.10'),
  treasury: parseEther('0.30'),
};

// Anvil measured gasUsed for createMulticurve (docs/VERIFICATION-anvil.md).
// Foundry 1.8.3 --network monad already uses Monad opcode pricing, so ratio ≈ 1.0.
const ANVIL_GAS_USED = 4_547_173n;

// Placeholder beneficiary addresses (unique; irrelevant to gas estimation)
const PH1 = '0x0000000000000000000000000000000000000001' as Address;
const PH2 = '0x0000000000000000000000000000000000000002' as Address;
const PH3 = '0x0000000000000000000000000000000000000003' as Address;

const erc20Abi = [
  { type: 'function', name: 'balanceOf',  stateMutability: 'view',        inputs: [{ name: 'a', type: 'address' }],                                         outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve',    stateMutability: 'nonpayable',   inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }],         outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transfer',   stateMutability: 'nonpayable',   inputs: [{ name: 't', type: 'address' }, { name: 'v', type: 'uint256' }],         outputs: [{ type: 'bool' }] },
] as const;

async function main() {
  // ---- Key validation ----
  const rawKey = process.env.REAL_PRIVATE_KEY;
  if (!rawKey) throw new Error('REAL_PRIVATE_KEY not set in .env.real. Copy .env.real.example and fill it in.');
  const key = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`;
  const acct = privateKeyToAccount(key);

  if (ANVIL_DEV.has(acct.address.toLowerCase())) {
    throw new Error(
      `REAL_PRIVATE_KEY resolves to ${acct.address}, which is an Anvil dev account.\n` +
      'Set a real private key in .env.real that you control on Monad mainnet.',
    );
  }
  console.log(`Sender (real wallet): ${acct.address}`);

  // ---- Clients ----
  const monadChain = defineChain({
    id: CHAIN_ID,
    name: 'Monad Mainnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [MONAD_RPC] } },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  });

  const publicClient = createPublicClient({ chain: monadChain, transport: http(MONAD_RPC) });
  const walletClient = createWalletClient({ account: acct, chain: monadChain, transport: http(MONAD_RPC) })
    .extend(publicActions);

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}, expected ${CHAIN_ID} (Monad mainnet). Check REAL_RPC_URL.`);

  const block = await publicClient.getBlock();
  console.log(`Monad OK: block ${block.number}  ${new Date(Number(block.timestamp) * 1000).toISOString()}\n`);

  // ---- Balances (informational, not required) ----
  const usdcBal = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [acct.address] });
  const monBal  = await publicClient.getBalance({ address: acct.address });
  console.log(`Wallet USDC balance: ${formatUnits(usdcBal, 6)} USDC`);
  console.log(`Wallet MON balance:  ${formatUnits(monBal, 18)} MON\n`);

  // ---- Doppler SDK launch simulation (read-only — no tx) ----
  console.log('Building launch params (identical to 02-launch.ts)...');
  const sdk = new DopplerSDK({ publicClient, walletClient: walletClient as any, chainId: CHAIN_ID });
  const airlockOwner = (await getAirlockOwner(publicClient)) as Address;

  const beneficiaries = sortBeneficiaries([
    { beneficiary: airlockOwner, shares: SHARES.doppler  },
    { beneficiary: acct.address, shares: SHARES.creator  },
    { beneficiary: PH1,          shares: SHARES.escrow   },
    { beneficiary: PH2,          shares: SHARES.buyback  },
    { beneficiary: PH3,          shares: SHARES.treasury },
  ]);

  const now = Math.floor(Date.now() / 1000);
  const startTime = now + 2;

  const params = sdk
    .buildMulticurveAuction()
    .tokenConfig({
      name: 'Astralaunch Test',
      symbol: 'ASLT',
      tokenURI: 'ipfs://astralaunch-test',
      maxBalanceLimit: SUPPLY / 100n,
      balanceLimitEnd: startTime + 600,
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
        { marketCap: { start: START_MCAP_USD * 20, end: 'max' },          numPositions: 10, shares: 600_000_000_000_000_000n },
      ],
    })
    .withSchedule({ startTime })
    .withVesting({
      duration:      BigInt(365 * DAY),
      cliffDuration: 30 * DAY,
      recipients:    [acct.address],
      amounts:       [VESTED_TOKENS],
    })
    .withGovernance({ type: 'noOp' })
    .withMigration({ type: 'noOp' })
    .withUserAddress(acct.address)
    .withIntegrator(PH3)
    .build();

  console.log('Calling simulateCreateMulticurve on real Monad (no tx)...');
  let launchGas: bigint | undefined;
  try {
    const sim = await sdk.factory.simulateCreateMulticurve(params);
    launchGas = sim.gasEstimate;
    console.log(`  predicted token:  ${sim.tokenAddress}`);
    console.log(`  predicted poolId: ${sim.poolId}`);
    console.log(`  gasEstimate:      ${sim.gasEstimate?.toLocaleString() ?? 'n/a'}`);
  } catch (e: any) {
    const msg = e?.shortMessage ?? e?.message ?? String(e);
    console.warn(`  simulateCreateMulticurve FAILED: ${msg}`);
    if (usdcBal === 0n) {
      console.warn('  (wallet has 0 USDC — the Doppler simulation likely reverted on insufficient numeraire balance)');
    }
  }

  // ---- USDC gas estimates (read-only eth_estimateGas calls) ----
  console.log('\nEstimating USDC approve gas...');
  let approveGas: bigint | undefined;
  try {
    approveGas = await publicClient.estimateContractGas({
      address: USDC, abi: erc20Abi, functionName: 'approve',
      args: ['0xcA11bde05977b3631167028862bE2a173976CA11' as Address, SUPPLY],
      account: acct.address,
    });
    console.log(`  ${approveGas.toLocaleString()} gas units`);
  } catch (e: any) {
    console.warn(`  FAILED: ${e?.shortMessage ?? e?.message ?? e}`);
  }

  console.log('Estimating USDC transfer gas...');
  let transferGas: bigint | undefined;
  if (usdcBal > 0n) {
    try {
      transferGas = await publicClient.estimateContractGas({
        address: USDC, abi: erc20Abi, functionName: 'transfer',
        args: [PH1, 1n],
        account: acct.address,
      });
      console.log(`  ${transferGas.toLocaleString()} gas units`);
    } catch (e: any) {
      console.warn(`  FAILED: ${e?.shortMessage ?? e?.message ?? e}`);
    }
  } else {
    console.log('  skipped (wallet USDC balance is 0)');
  }

  // ---- Gas prices ----
  console.log('\nGas prices (latest Monad block):');
  const gasPrice = await publicClient.getGasPrice();
  console.log(`  getGasPrice():       ${formatGwei(gasPrice)} gwei`);
  if (block.baseFeePerGas !== null && block.baseFeePerGas !== undefined) {
    console.log(`  baseFeePerGas:       ${formatGwei(block.baseFeePerGas)} gwei`);
  }
  try {
    const fh = await publicClient.getFeeHistory({ blockCount: 1, rewardPercentiles: [50] });
    const prio = fh.reward?.[0]?.[0];
    if (prio !== undefined) console.log(`  maxPriorityFee p50:  ${formatGwei(prio)} gwei`);
  } catch { /* some RPC endpoints do not support eth_feeHistory */ }

  // ---- Comparison table ----
  const col = (n: bigint | undefined) => (n !== undefined ? n.toLocaleString() : '(n/a)').padStart(16);
  console.log('\n--- Gas comparison: Monad (simulated) vs Anvil (measured with --network monad) ---');
  console.log('Operation                      Monad (simulated)  Anvil (--network monad, measured)');
  console.log('-'.repeat(74));
  console.log(`createMulticurve (launch)   ${col(launchGas)}  ${ANVIL_GAS_USED.toLocaleString().padStart(16)}`);
  console.log(`USDC approve                ${col(approveGas)}  ${'(not measured)'.padStart(16)}`);
  console.log(`USDC transfer               ${col(transferGas)}  ${'(not measured)'.padStart(16)}`);
  console.log('-'.repeat(74));

  if (launchGas !== undefined) {
    const ratio = Number(launchGas) / Number(ANVIL_GAS_USED);
    const buffered = (launchGas * 11_000n) / 10_000n;
    console.log(`\nMonad / Anvil gas ratio (launch): ${ratio.toFixed(3)}x`);
    console.log(`Recommended gasLimit on real Monad (×1.1 buffer): ${buffered.toLocaleString()}`);
  }
  console.log('\nNote: Monad bills the gas LIMIT, not gas used.');
  console.log('Foundry 1.8.3 --network monad uses Monad opcode pricing on Anvil, so Monad/Anvil ratio ≈ 1.0.');
  console.log('\nPart 1 complete — zero transactions were submitted to the network.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
