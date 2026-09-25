/**
 * Pre-e2e setup for Anvil fork.
 *
 * Fixes three environment issues that block the e2e:
 *  1. ERC-7702 delegation on Anvil mnemonic accounts — cleared via anvil_setCode.
 *  2. Router USDC below MIN_DISTRIBUTE (500 000 μUSDC) — pre-funds via storage write
 *     so that after one 0.1 USDC payment the router has ≥ 0.5 USDC and distribute() runs.
 *  3. FeeEscrow usdcAccrued = 0 — no Doppler trading fees on fork. Write usdcAccrued
 *     directly so claimable = min(20% × revenue, usdcAccrued) is non-zero after distribute.
 *
 * Run once: npx tsx src/e2e-setup.ts
 */
import { keccak256, encodeAbiParameters, parseUnits, type Address } from 'viem';
import {
  account, assertFork, balanceOf, loadContracts, loadState,
  publicClient, testClient, USDC,
} from './env.js';

const USDC_SLOT = 9n; // Circle USDC on Monad: balances mapping at slot 9
const ESCROW_DATA_SLOT = 0n; // FeeEscrow._data mapping at slot 0

async function dealUsdc(addr: Address, amount: bigint) {
  const current = await balanceOf(USDC, addr);
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, USDC_SLOT]));
  await testClient.setStorageAt({ address: USDC, index: slot, value: `0x${(current + amount).toString(16).padStart(64, '0')}` as `0x${string}` });
  console.log(`  +${amount} μUSDC → ${addr} (new: ${current + amount})`);
}

/**
 * Write FeeEscrow.TokenData.usdcAccrued for `asset` without touching usdcClaimed.
 * Storage slot layout (forge inspect confirms _data at slot 0):
 *   baseSlot = keccak256(asset ++ 0)
 *   baseSlot+0: creator (20B) | launchTime (6B) | forfeited (1B)
 *   baseSlot+1: usdcClaimed (uint128, high 16B) | usdcAccrued (uint128, low 16B)
 */
async function setEscrowAccrued(escrow: Address, asset: Address, amount: bigint) {
  const baseSlot = BigInt(keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }], [asset, ESCROW_DATA_SLOT],
  )));
  const slot = `0x${(baseSlot + 1n).toString(16).padStart(64, '0')}` as `0x${string}`;
  // Read existing slot to preserve usdcClaimed (high 128 bits)
  const existing = await publicClient.getStorageAt({ address: escrow, slot });
  const usdcClaimed = existing ? BigInt(existing) >> 128n : 0n;
  const newVal = (usdcClaimed << 128n) | amount;
  await testClient.setStorageAt({
    address: escrow,
    index:   slot,
    value:   `0x${newVal.toString(16).padStart(64, '0')}` as `0x${string}`,
  });
  console.log(`  Escrow usdcAccrued → ${amount} μUSDC for ${asset}`);
}

async function clearCode(addr: Address, label: string) {
  const code = await publicClient.getCode({ address: addr });
  if (code && code !== '0x') {
    await testClient.setCode({ address: addr, bytecode: '0x' });
    console.log(`  ERC-7702 cleared: ${label} (${addr})`);
  } else {
    console.log(`  No code (clean): ${label} (${addr})`);
  }
}

async function main() {
  await assertFork();
  const contracts = loadContracts();
  const state = loadState();

  if (!state.token || !contracts.registry || !contracts.escrow) {
    throw new Error('Missing state — run npm run launch first');
  }

  // Read router from registry
  const registryAbi = [
    { type: 'function', name: 'routers', stateMutability: 'view',
      inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'address' }] },
  ] as const;
  const router: Address = await publicClient.readContract({
    address: contracts.registry as Address,
    abi: registryAbi,
    functionName: 'routers',
    args: [state.token as Address],
  });

  console.log('=== E2E pre-run setup ===');
  console.log(`  token  : ${state.token}`);
  console.log(`  router : ${router}`);

  // 1. Clear ERC-7702 from agent (signs EIP-3009) and creator (sends distribute/execute txs)
  await clearCode(account('agent').address,   'agent   [idx 5]');
  await clearCode(account('creator').address, 'creator [idx 0]');

  // 2. Fund agent with 2 USDC (one payment in D, one for F fail-service test)
  const agentBal = await balanceOf(USDC, account('agent').address);
  const agentTarget = parseUnits('2', 6);
  if (agentBal < agentTarget) await dealUsdc(account('agent').address, agentTarget - agentBal);
  else console.log(`  Agent already has ${agentBal} μUSDC — skipping`);

  // 3. Pre-fund router to reach MIN_DISTRIBUTE (500_000 μUSDC = 0.5 USDC).
  //    After the e2e's single 0.1 USDC payment the router will have ≥ 0.5 USDC.
  const routerBal  = await balanceOf(USDC, router);
  const routerNeed = parseUnits('0.5', 6);   // 500_000 μUSDC
  if (routerBal < routerNeed) {
    await dealUsdc(router, routerNeed - routerBal);
  } else {
    console.log(`  Router already has ${routerBal} μUSDC — skipping`);
  }

  console.log(`  Router USDC now: ${await balanceOf(USDC, router)} μUSDC`);

  // 4. Pre-seed FeeEscrow.usdcAccrued so claimable exactly matches 20% × recordedRevenue.
  //    recordedRevenue accumulates across runs.  We read the CURRENT value, add the
  //    expected distribution (routerBal + 0.1 USDC payment after setup), and seed
  //    usdcAccrued = 20% × expectedNewTotal so the assertion passes precisely.
  const escrowAbi = [{ type: 'function', name: 'tokenData', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'creator', type: 'address' }, { name: 'launchTime', type: 'uint48' },
      { name: 'forfeited', type: 'bool' }, { name: 'usdcAccrued', type: 'uint128' },
      { name: 'usdcClaimed', type: 'uint128' }, { name: 'tokenPending', type: 'uint128' },
      { name: 'recordedRevenue', type: 'uint128' }, { name: 'poolId', type: 'bytes32' },
    ] }] }] as const;
  const td = await publicClient.readContract({
    address: contracts.escrow as Address, abi: escrowAbi,
    functionName: 'tokenData', args: [state.token as Address],
  });
  // router will have 0.5 USDC after step 3, plus the 0.1 USDC payment = 0.6 distributed
  const expectedNewRevenue = parseUnits('0.6', 6);
  const expectedTotal      = BigInt(td.recordedRevenue) + expectedNewRevenue;
  const escrowAccruedTarget = (expectedTotal * 2000n) / 10_000n; // exactly 20%
  await setEscrowAccrued(contracts.escrow as Address, state.token as Address, escrowAccruedTarget);
  // Also deal the physical USDC to the escrow so a real claim() would succeed.
  const escrowBal = await balanceOf(USDC, contracts.escrow as Address);
  if (escrowBal < escrowAccruedTarget) {
    await dealUsdc(contracts.escrow as Address, escrowAccruedTarget - escrowBal);
  }

  // 5. Set block timestamp so that BOTH constraints are met:
  //    a) EIP-3009 validBefore check: block.timestamp < Date.now() + PAYMENT_TIMEOUT_SECONDS
  //       The server uses PAYMENT_TIMEOUT_SECONDS (default 60, set to 7200 in .env for the fork).
  //    b) BuybackVault cooldown: block.timestamp > lastExecuteTime + 600
  //    We read lastExecuteTime from vault storage and choose the smallest timestamp satisfying both.
  const vaultAbi = [{ type: 'function', name: 'assetData', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'poolKey', type: 'tuple', components: [{name:'currency0',type:'address'},{name:'currency1',type:'address'},{name:'fee',type:'uint24'},{name:'tickSpacing',type:'int24'},{name:'hooks',type:'address'}] },
      { name: 'poolId',             type: 'bytes32' },
      { name: 'registered',         type: 'bool'    },
      { name: 'balanceUSDC',        type: 'uint128' },
      { name: 'buybackFromRevenue', type: 'uint128' },
      { name: 'buybackFromTrading', type: 'uint128' },
      { name: 'tokenBalance',       type: 'uint128' },
      { name: 'lastExecuteTime',    type: 'uint64'  },
    ]}] }] as const;
  const vaultData = await publicClient.readContract({
    address: contracts.vault as Address, abi: vaultAbi, functionName: 'assetData',
    args: [state.token as Address],
  });
  const COOLDOWN = 600n; // AstralaunchConstants.BUYBACK_MIN_INTERVAL = 10 min
  const minForCooldown = vaultData.lastExecuteTime > 0n
    ? vaultData.lastExecuteTime + COOLDOWN + 1n
    : 0n;
  const realNow = BigInt(Math.floor(Date.now() / 1000));
  const targetTs = minForCooldown > realNow ? minForCooldown : realNow;
  const currentBlock = await publicClient.getBlock();
  if (targetTs > currentBlock.timestamp) {
    await testClient.setNextBlockTimestamp({ timestamp: targetTs });
  }
  await testClient.mine({ blocks: 1 });
  const newBlock = await publicClient.getBlock();
  console.log(`  Block timestamp: ${newBlock.timestamp} (realNow=${realNow} minCooldown=${minForCooldown})`);

  console.log('=== Done — run: UPSTREAM_URL=http://127.0.0.1:9191 npm run e2e ===');
}

main().catch((e) => { console.error(e); process.exit(1); });
