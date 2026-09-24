// Register an already-launched token on RevpadRegistry (mainnet).
// Use this to retry registration after mainnet-launch.ts launched the token
// but register() failed or was skipped.
//
//   read -s CREATOR_PRIVATE_KEY && export CREATOR_PRIVATE_KEY
//   ASSET_ADDRESS=0x... \
//   CONTRACTS_JSON_PATH=../packages/contracts/deployments/monad-mainnet.json \
//   MONAD_RPC_URL=https://rpc.monad.xyz \
//     npx tsx src/mainnet-register.ts

import { existsSync, readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Address,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { registryAbi, checkCapWindow } from './mainnet-launch.js';

const GAS_BUFFER_BPS = 11_000n;
function withBuffer(gas: bigint): bigint {
  return (gas * GAS_BUFFER_BPS) / 10_000n;
}

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

async function main() {
  const privateKey = need('CREATOR_PRIVATE_KEY') as `0x${string}`;
  const creatorAccount = privateKeyToAccount(privateKey);
  const creator = creatorAccount.address;
  const asset = need('ASSET_ADDRESS') as Address;

  const rpcUrl = need('MONAD_RPC_URL');
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(rpcUrl);
  if (!isLocalhost && ANVIL_ADDRESSES.has(getAddress(creator))) {
    throw new Error(`Refusing Anvil dev account ${creator} on non-localhost RPC.`);
  }

  const contractsPath = need('CONTRACTS_JSON_PATH');
  if (!existsSync(contractsPath)) throw new Error(`Not found: ${contractsPath}`);
  const contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
  if (contracts.dryRun === true) {
    throw new Error(`${contractsPath} has "dryRun": true. Re-deploy with --broadcast.`);
  }

  const registryAddr = contracts.registry as Address;
  if (!registryAddr) throw new Error('contracts.json missing "registry"');

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

  // Verify registry has bytecode
  const code = await publicClient.getCode({ address: registryAddr });
  if (!code || code === '0x') throw new Error(`Registry (${registryAddr}) has no bytecode.`);

  // Verify token has bytecode
  const tokenCode = await publicClient.getCode({ address: asset });
  if (!tokenCode || tokenCode === '0x') throw new Error(`Asset (${asset}) has no bytecode.`);

  // Check already registered
  const existingRouter = await publicClient.readContract({
    address: registryAddr, abi: registryAbi, functionName: 'routers', args: [asset],
  });
  if (existingRouter !== '0x0000000000000000000000000000000000000000') {
    console.log(`Asset ${asset} is already registered. Router: ${existingRouter}`);
    return;
  }

  // Validate balance cap window on-chain
  console.log('Checking on-chain balance cap window...');
  const { vestingStart, balanceLimitEnd, window: capWindow } =
    await checkCapWindow(publicClient, asset);
  console.log(`  vestingStart=${vestingStart}, balanceLimitEnd=${balanceLimitEnd}, window=${capWindow}s -- OK`);

  // Estimate gas
  console.log('Estimating register() gas...');
  const regGas = await publicClient.estimateContractGas({
    account: creatorAccount,
    address: registryAddr,
    abi: registryAbi,
    functionName: 'register',
    args: [asset, creator],
  });
  console.log(`  estimate: ${regGas}, limit: ${withBuffer(regGas)}`);

  console.log('Sending register()...');
  const hash = await walletClient.writeContract({
    address: registryAddr,
    abi: registryAbi,
    functionName: 'register',
    args: [asset, creator],
    gas: withBuffer(regGas),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`register() reverted: ${hash}`);

  const routerAddr = await publicClient.readContract({
    address: registryAddr, abi: registryAbi, functionName: 'routers', args: [asset],
  });

  console.log('\n=== REGISTER COMPLETE ===');
  console.log(`  asset  : ${asset}`);
  console.log(`  router : ${routerAddr}`);
  console.log(`  tx     : ${hash}  (gas ${receipt.gasUsed})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
