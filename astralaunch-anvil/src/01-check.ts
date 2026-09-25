// Test 01 — environment check (SPEC §17: addresses, USDC/EIP-3009, Doppler modules on Monad)
import { ADDRESSES, getAirlockOwner } from '@whetstone-research/doppler-sdk/evm';
import { formatGwei, pad, type Address } from 'viem';
import { CHAIN_ID, USDC, assertFork, erc20Abi, pass, publicClient } from './env.js';

const eip3009Abi = [
  { type: 'function', name: 'authorizationState', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }, { name: 'n', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

async function hasCode(addr?: Address) {
  if (!addr || /^0x0{40}$/i.test(addr)) return false;
  const code = await publicClient.getCode({ address: addr });
  return !!code && code !== '0x';
}

async function main() {
  await assertFork();
  const block = await publicClient.getBlock();
  console.log(`Fork OK: chainId ${CHAIN_ID}, block ${block.number}, timestamp ${new Date(Number(block.timestamp) * 1000).toISOString()}`);
  console.log(`Gas price on fork: ${formatGwei(await publicClient.getGasPrice())} gwei (Anvil value; real Monad bills the gas LIMIT)\n`);

  const a = (ADDRESSES as unknown as Record<number, Record<string, Address | undefined>>)[CHAIN_ID];
  if (!a) throw new Error(`Doppler SDK has no addresses for chain ${CHAIN_ID}`);

  console.log('Doppler modules (from SDK) — deployed on fork?');
  const modules = [
    'airlock',
    'dopplerERC20V1Factory',
    'v4ScheduledMulticurveInitializer',
    'v4MulticurveInitializer',
    'v4DecayMulticurveInitializer',
    'dopplerHookInitializer',
    'noOpMigrator',
    'noOpGovernanceFactory',
    'poolManager',
    'universalRouter',
    'permit2',
  ];
  for (const k of modules) {
    const addr = a[k];
    const ok = await hasCode(addr);
    console.log(`  ${ok ? 'yes' : 'NO '}  ${k.padEnd(34)} ${addr ?? '(not in SDK for this chain)'}`);
  }
  console.log('  note: multicurve on Monad must use the SCHEDULED initializer if the standard/decay ones are missing.\n');

  const owner = await getAirlockOwner(publicClient);
  console.log(`Airlock owner (must be a beneficiary with >= 5%): ${owner}\n`);

  console.log('USDC');
  pass(await hasCode(USDC), 'USDC has code', USDC);
  const [name, symbol, decimals] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'name' }),
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  console.log(`  ${name} (${symbol}), ${decimals} decimals`);
  pass(decimals === 6, 'USDC decimals == 6');
  try {
    const version = await publicClient.readContract({ address: USDC, abi: eip3009Abi, functionName: 'version' });
    console.log(`  EIP-712 version: ${version}  -> use as x402 extra.version`);
  } catch {
    console.log('  version() not available');
  }
  try {
    await publicClient.readContract({ address: USDC, abi: eip3009Abi, functionName: 'authorizationState', args: [USDC, pad('0x01')] });
    pass(true, 'EIP-3009 authorizationState() callable (transferWithAuthorization supported)');
  } catch {
    pass(false, 'EIP-3009 authorizationState() callable', 'x402 exact would need the Permit2 path');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
