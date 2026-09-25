/**
 * Prep for keeper test run.
 * 1. Pre-funds router with 3.5 USDC so distribute() sends ≥ 1 USDC (30%) to vault.
 * 2. Advances Anvil block time by 11 min to clear the 10-min buyback cooldown.
 * Run: npx tsx src/keeper-prep.ts
 */
import { keccak256, encodeAbiParameters, parseUnits, type Address } from 'viem';
import { account, assertFork, balanceOf, loadContracts, loadState, publicClient, testClient, USDC } from './env.js';

const USDC_SLOT = 9n;

async function dealUsdc(addr: Address, amount: bigint) {
  const current = await balanceOf(USDC, addr);
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, USDC_SLOT]));
  await testClient.setStorageAt({
    address: USDC,
    index: slot,
    value: `0x${(current + amount).toString(16).padStart(64, '0')}` as `0x${string}`,
  });
  console.log(`  +${amount} μUSDC → ${addr} (new: ${current + amount})`);
}

async function main() {
  await assertFork();
  const contracts = loadContracts();
  const state = loadState();
  if (!state.token || !contracts.registry) throw new Error('Missing state — run npm run launch first');

  const registryAbi = [{
    type: 'function', name: 'routers', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'address' }],
  }] as const;
  const router: Address = await publicClient.readContract({
    address: contracts.registry as Address,
    abi: registryAbi,
    functionName: 'routers',
    args: [state.token as Address],
  });

  console.log('=== Keeper pre-run prep ===');

  // Fund router with 3.5 USDC (30% = 1.05 USDC goes to vault, above MIN_BUYBACK_USDC = 1 USDC)
  const routerTarget = parseUnits('3.5', 6);
  const routerBal = await balanceOf(USDC, router);
  if (routerBal < routerTarget) {
    await dealUsdc(router, routerTarget - routerBal);
  } else {
    console.log(`  Router already has ${routerBal} μUSDC — skipping`);
  }

  // Advance time by 11 minutes to clear the 10-min buyback cooldown and cap window
  const block = await publicClient.getBlock();
  const newTime = block.timestamp + 660n; // 11 min
  await testClient.setNextBlockTimestamp({ timestamp: newTime });
  await testClient.mine({ blocks: 1 });
  const newBlock = await publicClient.getBlock();
  console.log(`  Block time advanced to ${newBlock.timestamp} (+660s)`);
  console.log(`  Router USDC: ${await balanceOf(USDC, router)} μUSDC`);
  console.log('=== Done ===');
}

main().catch(e => { console.error(e); process.exit(1); });
