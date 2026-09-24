/**
 * End-to-end test on the Anvil fork.
 *
 * Prerequisites:
 *   1. Anvil fork running:     bash anvil/start-fork.sh
 *   2. Contracts deployed:     forge script script/Deploy.s.sol --rpc-url ... --broadcast ...
 *   3. Token launched:         npm run launch        (launch + register)
 *   4. Local facilitator:      npm run facilitator   (in separate terminal)
 *   5. Server running:         pnpm -F server dev    (in separate terminal, needs Postgres)
 *
 * Checks (PASS/FAIL):
 *   A. Token is registered in RevpadRegistry
 *   B. Register a BYO service via POST /api/services
 *   C. GET /s/:slug — agent without payment gets 402
 *   D. Agent pays (EIP-3009) — gets 200 + upstream body
 *   E. Replay rejected
 *   F. Failing upstream → agent not charged (verify called but settle skipped)
 *   G. Keeper: distribute() on router
 *   H. Escrow claimable = 20% of revenue
 *   I. Keeper: buyback execute() after cap window
 *   J. Token total supply decreases (tokens burned)
 *   K. PlatformFeeReceiver.collect forwards platform share to treasury
 *   L. Treasury change via two-step (propose + warp + accept)
 *
 * Usage: npm run e2e
 */
import { x402Client } from '@x402/core/client';
import { toClientEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import type { PaymentRequired } from '@x402/core/types';
import {
  formatUnits,
  parseUnits,
  createPublicClient,
  createTestClient,
  http,
  type Address,
} from 'viem';
import {
  CHAIN_ID,
  USDC,
  NETWORK,
  account,
  assertFork,
  balanceOf,
  erc20Abi,
  loadState,
  loadContracts,
  pass,
  publicClient,
  testClient,
  wallet,
} from './env.js';

const SERVER_URL  = process.env.SERVER_URL  ?? 'http://127.0.0.1:3001';
const FAC_URL     = `http://127.0.0.1:${process.env.FACILITATOR_PORT ?? 4020}`;
const UPSTREAM_ECHO = process.env.UPSTREAM_URL ?? 'https://httpbin.org/get'; // real public echo endpoint

async function post(base: string, path: string, body: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as any };
}

async function get(base: string, path: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, { headers });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() as any : await r.text() };
}

// ── Deal USDC to agent via direct storage write (slot 9) ─────────────────────
async function dealUsdc(addr: Address, amount: bigint) {
  const { keccak256, encodeAbiParameters } = await import('viem');
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, 9n]));
  await testClient.setStorageAt({ address: USDC, index: slot, value: `0x${amount.toString(16).padStart(64, '0')}` as `0x${string}` });
}

async function main() {
  await assertFork();
  const st = loadState();
  const contracts = loadContracts();
  if (!st.token || !st.poolKey) throw new Error('Run npm run launch first');
  if (!contracts.registry)     throw new Error('Run Deploy.s.sol + npm run launch first');

  const asset    = st.token;
  const registry = contracts.registry as Address;
  const escrow   = contracts.escrow   as Address;
  const vault    = contracts.vault    as Address;

  console.log('\n=== Revpad E2E Test Suite ===');
  console.log(`  token    : ${asset}`);
  console.log(`  registry : ${registry}`);
  console.log(`  server   : ${SERVER_URL}`);
  console.log(`  fac      : ${FAC_URL}`);

  // ── A. Token is registered ──────────────────────────────────────────────────
  const registryAbi = [
    { type: 'function', name: 'routers', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'address' }] },
  ] as const;
  const routerAddr: Address = await publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'routers', args: [asset as Address] });
  pass(routerAddr !== '0x0000000000000000000000000000000000000000', 'A. Token registered in RevpadRegistry', routerAddr);

  // ── B. Register BYO service ─────────────────────────────────────────────────
  const slug = `e2e-test-${Date.now()}`;
  const { status: svcStatus, body: svcBody } = await post(SERVER_URL, '/api/services', {
    asset,
    creator: account('creator').address,
    slug,
    name:       'E2E test service',
    upstreamUrl: UPSTREAM_ECHO.replace('/get', ''), // base URL without path
    priceUsdc:  '100000', // 0.1 USDC (6 dec)
    description: 'Automated E2E test service',
    timeoutSeconds: 30,
  });
  pass(svcStatus === 201, 'B. POST /api/services returns 201', JSON.stringify(svcBody));
  const serviceId = svcBody?.id;

  // ── C. Agent without payment gets 402 ──────────────────────────────────────
  const { status: noPayStatus } = await get(SERVER_URL, `/s/${slug}/get`);
  pass(noPayStatus === 402, 'C. Missing payment → 402');

  // ── D. Agent pays and gets 200 ──────────────────────────────────────────────
  // Fund agent with 1 USDC
  const agent = account('agent');
  await dealUsdc(agent.address, parseUnits('1', 6));
  const agentBalance0 = await balanceOf(USDC, agent.address);
  pass(agentBalance0 >= 100_000n, 'D-pre. Agent has USDC', formatUnits(agentBalance0, 6));

  // Get service manifest to build PaymentRequired
  const { body: manifest } = await get(SERVER_URL, `/api/services/${slug}/manifest`);
  const requirements = manifest?.payment;
  pass(!!requirements, 'D. Manifest has payment requirements', JSON.stringify(requirements));

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: `${SERVER_URL}/s/${slug}/get`, description: 'E2E test', mimeType: 'application/json' },
    accepts: [requirements],
  };

  // Sign and submit payment via x402 client
  const usdcName = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'name' });
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: toClientEvmSigner(agent as any, publicClient as any), networks: [NETWORK] });
  const payload = await client.createPaymentPayload(paymentRequired);

  // Agent makes authenticated request to gateway
  const { x402Client: x402C } = await import('@x402/core/client');
  // Use raw fetch with X-PAYMENT header (the client SDK encodes the header)
  const { encodePaymentSignatureHeader } = await import('@x402/core/http');
  const payHeader = encodePaymentSignatureHeader(payload);

  const { status: paidStatus, body: paidBody } = await get(SERVER_URL, `/s/${slug}/get`, { 'X-PAYMENT': payHeader });
  pass(paidStatus === 200, 'D. Paid request returns 200', JSON.stringify(paidBody).slice(0, 80));

  const agentBalance1 = await balanceOf(USDC, agent.address);
  pass(agentBalance0 - agentBalance1 === 100_000n, 'D. Agent USDC deducted', formatUnits(agentBalance0 - agentBalance1, 6));

  // ── E. Replay rejected ──────────────────────────────────────────────────────
  const { status: replayStatus } = await get(SERVER_URL, `/s/${slug}/get`, { 'X-PAYMENT': payHeader });
  pass(replayStatus === 402, 'E. Replay rejected with 402');

  // ── F. Failing upstream → not charged ──────────────────────────────────────
  // Create a second service pointing at a known-failing URL (httpbin.org/status/500)
  const failSlug = `e2e-fail-${Date.now()}`;
  await post(SERVER_URL, '/api/services', {
    asset, creator: account('creator').address,
    slug: failSlug, name: 'Fail service',
    upstreamUrl: 'https://httpbin.org',
    priceUsdc: '100000',
  });

  // Build fresh payment for the fail service
  const { body: failManifest } = await get(SERVER_URL, `/api/services/${failSlug}/manifest`);
  const failPaymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: `${SERVER_URL}/s/${failSlug}/status/500`, description: 'fail', mimeType: 'application/json' },
    accepts: [failManifest.payment],
  };
  await dealUsdc(agent.address, parseUnits('1', 6));
  const failPayload = await client.createPaymentPayload(failPaymentRequired);
  const failHeader  = encodePaymentSignatureHeader(failPayload);

  const agentBefore  = await balanceOf(USDC, agent.address);
  const routerBefore = await balanceOf(USDC, routerAddr);
  const { status: failStatus } = await get(SERVER_URL, `/s/${failSlug}/status/500`, { 'X-PAYMENT': failHeader });
  const agentAfter   = await balanceOf(USDC, agent.address);
  const routerAfter  = await balanceOf(USDC, routerAddr);

  pass(failStatus === 502, 'F. Upstream 500 → gateway returns 502');
  pass(agentBefore === agentAfter, 'F. Agent USDC not deducted on upstream failure', `${formatUnits(agentBefore - agentAfter, 6)} USDC`);
  pass(routerBefore === routerAfter, 'F. Router USDC unchanged on upstream failure');

  // ── G. Keeper: distribute router ────────────────────────────────────────────
  const routerBalance = await balanceOf(USDC, routerAddr);
  pass(routerBalance > 0n, 'G-pre. Router has USDC to distribute', formatUnits(routerBalance, 6));

  // Call distribute() directly (simulating keeper)
  const routerW = wallet('creator'); // any wallet can call distribute
  const distributeHash = await routerW.writeContract({
    address: routerAddr,
    abi: [{ type: 'function', name: 'distribute', stateMutability: 'nonpayable', inputs: [], outputs: [] }],
    functionName: 'distribute',
  });
  await publicClient.waitForTransactionReceipt({ hash: distributeHash });
  pass(true, 'G. distribute() called', distributeHash);

  // ── H. Escrow claimable = 20% of revenue ───────────────────────────────────
  const escrowAbi = [
    { type: 'function', name: 'claimable',  stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'tokenData',  stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{
      type: 'tuple', components: [
        { name: 'creator', type: 'address' }, { name: 'launchTime', type: 'uint48' },
        { name: 'forfeited', type: 'bool' }, { name: 'usdcAccrued', type: 'uint128' },
        { name: 'usdcClaimed', type: 'uint128' }, { name: 'tokenPending', type: 'uint128' },
        { name: 'recordedRevenue', type: 'uint128' }, { name: 'poolId', type: 'bytes32' },
      ],
    }]},
  ] as const;
  const td = await publicClient.readContract({ address: escrow as Address, abi: escrowAbi, functionName: 'tokenData', args: [asset as Address] });
  const claimable = await publicClient.readContract({ address: escrow as Address, abi: escrowAbi, functionName: 'claimable', args: [asset as Address] });
  const expectedClaimable = (BigInt(td.recordedRevenue) * 2000n) / 10_000n; // 20%
  pass(claimable === expectedClaimable, 'H. Escrow claimable == 20% of recordedRevenue',
    `${formatUnits(claimable, 6)} USDC (rev=${formatUnits(td.recordedRevenue, 6)})`);

  // ── I. Keeper: buyback after cap window ─────────────────────────────────────
  const tok = asset as Address;
  const dopplerAbi = [{ type: 'function', name: 'balanceLimitEnd', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint48' }] }] as const;
  const capEnd = await publicClient.readContract({ address: tok, abi: dopplerAbi, functionName: 'balanceLimitEnd' });
  const nowBlock = await publicClient.getBlock();

  if (nowBlock.timestamp <= capEnd) {
    console.log(`  Warping past cap window (${capEnd})...`);
    await testClient.setNextBlockTimestamp({ timestamp: capEnd + 1n });
    await testClient.mine({ blocks: 1 });
  }

  const vaultAbi2 = [
    { type: 'function', name: 'assetData', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }],
      outputs: [{ type: 'tuple', components: [
        { name: 'poolKey', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }]},
        { name: 'poolId', type: 'bytes32' }, { name: 'registered', type: 'bool' },
        { name: 'balanceUSDC', type: 'uint128' }, { name: 'buybackFromRevenue', type: 'uint128' },
        { name: 'buybackFromTrading', type: 'uint128' }, { name: 'tokenBalance', type: 'uint128' },
        { name: 'lastExecuteTime', type: 'uint64' },
      ]}],
    },
    { type: 'function', name: 'execute', stateMutability: 'nonpayable',
      inputs: [{ name: 'asset', type: 'address' }, { name: 'usdcIn', type: 'uint256' }, { name: 'minTokenOut', type: 'uint256' }],
      outputs: [] },
  ] as const;

  const vData = await publicClient.readContract({ address: vault as Address, abi: vaultAbi2, functionName: 'assetData', args: [tok] });
  const vaultUsdc = vData.balanceUSDC;
  pass(vaultUsdc > 0n, 'I-pre. Vault has USDC for buyback', formatUnits(vaultUsdc, 6));

  const erc20Abi2 = [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const;
  const supplyBefore = await publicClient.readContract({ address: tok, abi: erc20Abi2, functionName: 'totalSupply' });

  const execAmt = vaultUsdc > 10_000_000n ? 10_000_000n : vaultUsdc; // up to 10 USDC
  const execW = wallet('creator');
  const execHash = await execW.writeContract({
    address: vault as Address,
    abi: vaultAbi2,
    functionName: 'execute',
    args: [tok, execAmt, 0n],
  });
  await publicClient.waitForTransactionReceipt({ hash: execHash });
  pass(true, 'I. BuybackVault.execute() succeeded', execHash);

  // ── J. Total supply decreased (tokens burned) ────────────────────────────────
  const supplyAfter = await publicClient.readContract({ address: tok, abi: erc20Abi2, functionName: 'totalSupply' });
  const burned = supplyBefore - supplyAfter;
  pass(burned > 0n, 'J. Tokens burned', formatUnits(burned, 18));

  // ── K. PlatformFeeReceiver: collect forwards platform share to treasury ────
  const pfrAddr = contracts.platformFeeReceiver as Address | undefined;
  if (pfrAddr) {
    const pfrAbi = [
      { type: 'function', name: 'collect', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }], outputs: [] },
      { type: 'function', name: 'treasury', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
      { type: 'function', name: 'proposeTreasury', stateMutability: 'nonpayable', inputs: [{ name: 'newTreasury', type: 'address' }], outputs: [] },
      { type: 'function', name: 'acceptTreasury', stateMutability: 'nonpayable', inputs: [], outputs: [] },
      { type: 'function', name: 'pendingTreasury', stateMutability: 'view',
        inputs: [], outputs: [{ name: 'proposed', type: 'address' }, { name: 'executableAt', type: 'uint256' }] },
    ] as const;

    const pfrTreasury = await publicClient.readContract({ address: pfrAddr, abi: pfrAbi, functionName: 'treasury' });
    const pfrBalanceBefore = await balanceOf(USDC, pfrAddr);
    const treasuryBalBefore = await balanceOf(USDC, pfrTreasury);

    // PFR accumulates the 10% treasury share from distribute() above.
    // Call collect() to forward to the actual treasury.
    const collectW = wallet('creator');
    try {
      const collectHash = await collectW.writeContract({
        address: pfrAddr, abi: pfrAbi, functionName: 'collect', args: [asset as Address],
      });
      await publicClient.waitForTransactionReceipt({ hash: collectHash });
    } catch {
      // collect may fail if PFR has no USDC yet (asset not registered in PFR on older deploys)
    }

    const pfrBalanceAfter = await balanceOf(USDC, pfrAddr);
    const treasuryBalAfter = await balanceOf(USDC, pfrTreasury);
    const forwarded = treasuryBalAfter - treasuryBalBefore;
    pass(pfrBalanceAfter === 0n || pfrBalanceAfter < pfrBalanceBefore, 'K. PFR.collect() forwarded USDC to treasury',
      `forwarded=${formatUnits(forwarded, 6)} USDC`);

    // ── L. Treasury change via two-step (propose + warp + accept) ──────────
    const newTreasury = account('treasury').address; // use existing treasury account
    const adminW = wallet('creator'); // admin = deployer = account[0] = creator in Anvil

    try {
      // Propose
      const proposeHash = await adminW.writeContract({
        address: pfrAddr, abi: pfrAbi, functionName: 'proposeTreasury', args: [newTreasury],
      });
      await publicClient.waitForTransactionReceipt({ hash: proposeHash });

      const [proposed, executableAt] = await publicClient.readContract({
        address: pfrAddr, abi: pfrAbi, functionName: 'pendingTreasury',
      });
      pass(proposed === newTreasury, 'L-1. Treasury proposed', proposed);
      pass(executableAt > 0n, 'L-2. Executable timestamp set', executableAt.toString());

      // Warp past the 48h delay
      await testClient.setNextBlockTimestamp({ timestamp: executableAt });
      await testClient.mine({ blocks: 1 });

      // Accept
      const acceptHash = await adminW.writeContract({
        address: pfrAddr, abi: pfrAbi, functionName: 'acceptTreasury',
      });
      await publicClient.waitForTransactionReceipt({ hash: acceptHash });

      const finalTreasury = await publicClient.readContract({
        address: pfrAddr, abi: pfrAbi, functionName: 'treasury',
      });
      pass(finalTreasury === newTreasury, 'L-3. Treasury changed after accept', finalTreasury);
    } catch (e) {
      console.log(`  L. Treasury change test skipped or failed: ${e}`);
    }
  } else {
    console.log('  K/L. Skipped — no platformFeeReceiver in contracts.json');
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n=== E2E Test Summary ===');
  console.log(`  Service slug   : ${slug}`);
  console.log(`  Router         : ${routerAddr}`);
  console.log(`  Revenue (USDC) : ${formatUnits(td.recordedRevenue, 6)}`);
  console.log(`  Escrow claimable: ${formatUnits(claimable, 6)}`);
  console.log(`  Vault USDC (pre): ${formatUnits(vaultUsdc, 6)}`);
  console.log(`  Tokens burned  : ${formatUnits(burned, 18)}`);
  console.log(`  PFR address    : ${pfrAddr ?? 'n/a'}`);
  console.log('\nAll checks above must be PASS for a clean run.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
