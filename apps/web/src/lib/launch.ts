/**
 * Launch flow (Phase C), framework-free so it runs in the browser and in the fork test runner.
 *
 * Mirrors astralaunch-anvil/src/mainnet-launch.ts exactly: 1e9 supply, 85% pool / 15% vested
 * (30-day cliff, 365 days), 2% fee / tick spacing 200, beneficiaries sorted (Doppler airlock owner 5%,
 * creator 35%, FeeEscrow 20%, BuybackVault 10%, PlatformFeeReceiver 30%), balance cap 1% until
 * startTime + 720 s, escrow / vault / PFR excluded from the cap, two curves from a fixed $2,500 initial
 * market cap (×20 then max; 40% / 60%), no-op governance and migration, integrator = PFR, and startTime
 * recomputed from the latest block right before sending. Then AstralaunchRegistry.register(asset, creator).
 *
 * Every tx is simulated first and sent with gas = estimate × 1.1 (CLAUDE.md rule 6).
 * Launch fee: 10 MON to the treasury unless the wallet already has an unused receipt, then
 * POST /api/launch-fee/verify. Metadata / service: JSON messages from packages/shared, signed by the
 * creator (the server only accepts the on-chain creator's signature).
 *
 * One-transaction mode (when /api/config returns a launchHelper): LaunchHelper.launch does
 * Airlock.create + register + the 10 MON fee (or 0 when an unused receipt exists) in ONE tx, with the
 * same SDK-encoded CreateParams; then ONE signature (launchDetailsMessage) covers metadata + service.
 */
import { DopplerSDK, getAirlockOwner, sortBeneficiaries } from '@whetstone-research/doppler-sdk/evm';
import { formatEther, getAddress, parseEther, parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import {
  INITIAL_MCAP_USD, MAX_ORACLE_STALENESS_S, POOL_FEE, POOL_TOKENS, TICK_SPACING, TOTAL_SUPPLY, VESTED_TOKENS, WAD,
  VESTING_CLIFF_S, VESTING_DURATION_S, launchDetailsMessage, serviceCreateMessage, tokenMetadataMessage, withBuffer,
} from '@astralaunch/shared';

const SHARES = {
  doppler: parseEther('0.05'), creator: parseEther('0.35'), escrow: parseEther('0.20'), buyback: parseEther('0.10'), treasury: parseEther('0.30'),
};
const BALANCE_CAP_WINDOW_S = 720;
const CAP_WINDOW_MIN = 600, CAP_WINDOW_MAX = 900;   // registry accepts [600, 900] s

export interface ChainConfig {
  chainId: number;
  contracts: { registry: Address; escrow: Address; vault: Address; platformFeeReceiver: Address };
  tokens: { usdc: Address; wmon: Address };
  monUsdOracle: Address;
  launchFee: { mon: number; wei: string; treasury: Address; maxPer24h: number };
  /** LaunchHelper (one-transaction launch); null/absent = multi-transaction flow. */
  launchHelper?: Address | null;
}

export interface LaunchInput {
  name: string;
  symbol: string;
  pairing: 'usdc' | 'mon';
  imageUrl?: string;
  xHandle?: string;
  website?: string;
  description?: string;
  service?: { slug: string; name: string; upstreamUrl: string; priceUsdc: bigint; description?: string; examplePath?: string };
}

export interface Ctx {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  apiBase: string;
  config: ChainConfig;
}

export class LaunchError extends Error {
  constructor(message: string, readonly code?: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

const registryAbi = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'creator', type: 'address' }], outputs: [{ name: 'router', type: 'address' }] },
  { type: 'function', name: 'routers', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'address' }] },
  { type: 'event', name: 'Registered', inputs: [
    { name: 'asset', type: 'address', indexed: true }, { name: 'creator', type: 'address', indexed: true },
    { name: 'router', type: 'address', indexed: true }, { name: 'poolId', type: 'bytes32', indexed: false },
    { name: 'numeraire', type: 'address', indexed: false }, { name: 'initializer', type: 'address', indexed: false },
    { name: 'timestamp', type: 'uint256', indexed: false }] },
] as const;
const tokenCapAbi = [
  { type: 'function', name: 'vestingStart', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceLimitEnd', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint48' }] },
] as const;
const createParamsComponents = [
  { name: 'initialSupply', type: 'uint256' }, { name: 'numTokensToSell', type: 'uint256' }, { name: 'numeraire', type: 'address' },
  { name: 'tokenFactory', type: 'address' }, { name: 'tokenFactoryData', type: 'bytes' }, { name: 'governanceFactory', type: 'address' },
  { name: 'governanceFactoryData', type: 'bytes' }, { name: 'poolInitializer', type: 'address' }, { name: 'poolInitializerData', type: 'bytes' },
  { name: 'liquidityMigrator', type: 'address' }, { name: 'liquidityMigratorData', type: 'bytes' }, { name: 'integrator', type: 'address' },
  { name: 'salt', type: 'bytes32' },
] as const;
/** packages/contracts/src/LaunchHelper.sol */
export const launchHelperAbi = [
  { type: 'function', name: 'launch', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: createParamsComponents }, { name: 'creator', type: 'address' }],
    outputs: [{ name: 'asset', type: 'address' }, { name: 'router', type: 'address' }] },
  { type: 'event', name: 'Launched', inputs: [
    { name: 'launcher', type: 'address', indexed: true }, { name: 'asset', type: 'address', indexed: true },
    { name: 'creator', type: 'address', indexed: true }, { name: 'router', type: 'address', indexed: false }] },
  { type: 'event', name: 'LaunchFeePaid', inputs: [
    { name: 'launcher', type: 'address', indexed: true }, { name: 'asset', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false }] },
] as const;
export type CreateParams = {
  initialSupply: bigint; numTokensToSell: bigint; numeraire: Address; tokenFactory: Address; tokenFactoryData: Hex;
  governanceFactory: Address; governanceFactoryData: Hex; poolInitializer: Address; poolInitializerData: Hex;
  liquidityMigrator: Address; liquidityMigratorData: Hex; integrator: Address; salt: Hex;
};
const oracleAbi = [
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [
    { type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
] as const;

async function api<T>(ctx: Ctx, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${ctx.apiBase}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FeeStatus {
  unusedReceipts: { txHash: string }[]; launchesLast24h: number; launchesLast24hAssets: string[];
  slotsLeft: number; canLaunch: boolean; nextSlotAt: number | null;
}
export const feeStatus = async (ctx: Ctx) => (await api<FeeStatus>(ctx, `/api/launch-fee/status?wallet=${ctx.account}`)).body;

/** Chainlink MON/USD (8 decimals); rejects stale answers like mainnet-launch.ts. */
async function monUsd(ctx: Ctx): Promise<{ priceUsd: number; updatedAt: number }> {
  const [, answer, , updatedAt] = await ctx.publicClient.readContract({ address: ctx.config.monUsdOracle, abi: oracleAbi, functionName: 'latestRoundData' });
  const block = await ctx.publicClient.getBlock();
  if (Number(block.timestamp) - Number(updatedAt) > MAX_ORACLE_STALENESS_S) {
    throw new LaunchError(`Chainlink MON/USD is stale (updated ${new Date(Number(updatedAt) * 1000).toISOString()}); MON pairing is unavailable right now.`, 'oracle_stale');
  }
  const priceUsd = Number(answer) / 1e8;
  if (!(priceUsd > 0)) throw new LaunchError('Chainlink MON/USD returned a non-positive price.', 'oracle_bad');
  return { priceUsd, updatedAt: Number(updatedAt) };
}

function sdkFor(ctx: Ctx) {
  return new DopplerSDK({ publicClient: ctx.publicClient as never, walletClient: ctx.walletClient as never, chainId: ctx.config.chainId });
}

/** Everything the confirmation dialog shows, from the preview simulation. */
export interface LaunchPlan {
  /** 'helper' = one transaction (LaunchHelper) + one signature; 'classic' = fee, launch, register + a signature each. */
  mode: 'helper' | 'classic';
  /** Wallet transactions / signatures the user will be asked for. */
  txCount: number; signatureCount: number;
  creator: Address;
  numeraire: Address; numeraireSymbol: 'USDC' | 'MON'; numerairePrice: number; oracleNote: string;
  beneficiaries: { beneficiary: Address; shares: bigint; label: string }[];
  excludedFromBalanceLimit: Address[];
  previewStartTime: number; predictedToken: Address;
  feeTx: { needed: boolean; reusingReceipt: string | null; valueWei: bigint; gas: bigint | null };
  launchGas: bigint; registerGas: 'after launch' | 'included';
  gasPrice: bigint; estimatedMonCost: bigint; monBalance: bigint;
  params: ReturnType<typeof buildParams>;
}

function buildParams(sdk: DopplerSDK, o: {
  name: string; symbol: string; tokenURI: string; startTime: number; beneficiaries: { beneficiary: Address; shares: bigint }[];
  creator: Address; pfr: Address; numeraire: Address; numerairePrice: number; numeraireDecimals: number; excluded: Address[];
}) {
  return sdk.buildMulticurveAuction()
    .tokenConfig({
      name: o.name, symbol: o.symbol, tokenURI: o.tokenURI,
      maxBalanceLimit: TOTAL_SUPPLY / 100n, balanceLimitEnd: o.startTime + BALANCE_CAP_WINDOW_S, excludedFromBalanceLimit: o.excluded,
    })
    .saleConfig({ initialSupply: TOTAL_SUPPLY, numTokensToSell: POOL_TOKENS, numeraire: o.numeraire })
    .withCurves({
      numerairePrice: o.numerairePrice, numeraireDecimals: o.numeraireDecimals, tokenDecimals: 18,
      fee: POOL_FEE, tickSpacing: TICK_SPACING, beneficiaries: o.beneficiaries,
      curves: [
        { marketCap: { start: INITIAL_MCAP_USD, end: INITIAL_MCAP_USD * 20 }, numPositions: 10, shares: 400_000_000_000_000_000n },
        { marketCap: { start: INITIAL_MCAP_USD * 20, end: 'max' }, numPositions: 10, shares: 600_000_000_000_000_000n },
      ],
    })
    .withSchedule({ startTime: o.startTime })
    .withVesting({ duration: BigInt(VESTING_DURATION_S), cliffDuration: VESTING_CLIFF_S, recipients: [o.creator], amounts: [VESTED_TOKENS] })
    .withGovernance({ type: 'noOp' })
    .withMigration({ type: 'noOp' })
    .withUserAddress(o.creator)
    .withIntegrator(o.pfr)
    .build();
}

async function paramsFor(ctx: Ctx, input: LaunchInput, startTime: number) {
  const { contracts, tokens } = ctx.config;
  const creator = getAddress(ctx.account);   // the creator / fee recipient is always the connected wallet
  let numeraire: Address, numerairePrice: number, numeraireDecimals: number, oracleNote: string;
  if (input.pairing === 'usdc') {
    numeraire = tokens.usdc; numerairePrice = 1; numeraireDecimals = 6; oracleNote = '1 USDC = $1';
  } else {
    const o = await monUsd(ctx);
    numeraire = tokens.wmon; numerairePrice = o.priceUsd; numeraireDecimals = 18;
    oracleNote = `Chainlink MON/USD, updated ${new Date(o.updatedAt * 1000).toISOString()}`;
  }
  const airlockOwner = getAddress(await getAirlockOwner(ctx.publicClient as never) as Address);
  const beneficiaries = sortBeneficiaries([
    { beneficiary: airlockOwner, shares: SHARES.doppler },
    { beneficiary: creator, shares: SHARES.creator },
    { beneficiary: contracts.escrow, shares: SHARES.escrow },
    { beneficiary: contracts.vault, shares: SHARES.buyback },
    { beneficiary: contracts.platformFeeReceiver, shares: SHARES.treasury },
  ]) as { beneficiary: Address; shares: bigint }[];
  if (beneficiaries.reduce((s, b) => s + b.shares, 0n) !== WAD) throw new LaunchError('Beneficiary shares do not sum to 1e18.');
  if (POOL_TOKENS + VESTED_TOKENS !== TOTAL_SUPPLY) throw new LaunchError('pool + vested != supply');
  const labels = new Map<string, string>([
    [airlockOwner, 'Doppler (airlock owner)'], [creator, 'Creator / fee recipient'], [getAddress(contracts.escrow), 'FeeEscrow'],
    [getAddress(contracts.vault), 'BuybackVault'], [getAddress(contracts.platformFeeReceiver), 'PlatformFeeReceiver'],
  ]);
  const excluded = [contracts.escrow, contracts.vault, contracts.platformFeeReceiver];
  const params = buildParams(sdkFor(ctx), {
    name: input.name, symbol: input.symbol, tokenURI: '', startTime, beneficiaries, creator,
    pfr: contracts.platformFeeReceiver, numeraire, numerairePrice, numeraireDecimals, excluded,
  });
  return {
    params, creator, numeraire, numerairePrice, oracleNote, excluded,
    numeraireSymbol: (input.pairing === 'usdc' ? 'USDC' : 'MON') as 'USDC' | 'MON',
    beneficiaries: beneficiaries.map((b) => ({ ...b, label: labels.get(getAddress(b.beneficiary)) ?? '' })),
  };
}

/** SDK-encoded Airlock CreateParams. The salt is random per call: encode once, then simulate and send that same value. */
export function encodeCreateParams(ctx: Ctx, params: ReturnType<typeof buildParams>): CreateParams {
  return sdkFor(ctx).factory.encodeCreateMulticurveParams(params) as unknown as CreateParams;
}

/** SDK-encoded CreateParams + creator for a launch at `startTime` (fork tests and fixtures use the browser code path). */
export async function launchCreateParams(ctx: Ctx, input: LaunchInput, startTime: number) {
  const p = await paramsFor(ctx, input, startTime);
  return { createParams: encodeCreateParams(ctx, p.params), creator: p.creator, numeraire: p.numeraire };
}

const hasMetadata = (i: LaunchInput) => !!(i.imageUrl || i.xHandle || i.website || i.description);
const wantsSignature = (i: LaunchInput) => hasMetadata(i) || !!i.service;

/** Rate limit + fee receipt check, then preview simulations for the confirmation dialog. */
export async function planLaunch(ctx: Ctx, input: LaunchInput): Promise<LaunchPlan> {
  const status = await feeStatus(ctx);
  if (status.launchesLast24h >= ctx.config.launchFee.maxPer24h) {
    throw new LaunchError(
      `Launch limit reached: ${ctx.config.launchFee.maxPer24h} launches per 24h per wallet. Next slot ${status.nextSlotAt ? new Date(status.nextSlotAt * 1000).toLocaleString() : 'later'}.`,
      'rate_limited', { nextSlotAt: status.nextSlotAt });
  }
  // A taken service slug would only fail after the token is launched: check it before any tx.
  if (input.service) {
    const m = await fetch(`${ctx.apiBase}/api/services/${encodeURIComponent(input.service.slug)}/manifest`);
    if (m.status === 200) throw new LaunchError(`The service name "${input.service.slug}" is already taken. Choose another ticker or attach the API later.`, 'slug_taken');
  }
  const reuse = status.unusedReceipts[0]?.txHash ?? null;
  const feeWei = BigInt(ctx.config.launchFee.wei);

  if (ctx.config.launchHelper) {
    // One transaction: simulate the whole LaunchHelper.launch (create + register + fee), so every
    // registry check runs before the user confirms, and the gas is the real total.
    const block = await ctx.publicClient.getBlock();
    const previewStartTime = Number(block.timestamp) + 60;
    const p = await paramsFor(ctx, input, previewStartTime);
    const createParams = encodeCreateParams(ctx, p.params);
    const value = reuse ? 0n : feeWei;
    const call = { account: ctx.account, address: ctx.config.launchHelper, abi: launchHelperAbi, functionName: 'launch', args: [createParams, p.creator], value } as const;
    const { result } = await ctx.publicClient.simulateContract(call);
    const gas = withBuffer(await ctx.publicClient.estimateContractGas(call));
    const gasPrice = await ctx.publicClient.getGasPrice();
    const monBalance = await ctx.publicClient.getBalance({ address: ctx.account });
    return {
      ...p, mode: 'helper', txCount: 1, signatureCount: wantsSignature(input) ? 1 : 0,
      excludedFromBalanceLimit: p.excluded, previewStartTime, predictedToken: result[0],
      feeTx: { needed: !reuse, reusingReceipt: reuse, valueWei: feeWei, gas: null },
      launchGas: gas, registerGas: 'included', gasPrice, estimatedMonCost: gas * gasPrice + value, monBalance,
    };
  }

  const feeGas = reuse ? null : await ctx.publicClient.estimateGas({ account: ctx.account, to: ctx.config.launchFee.treasury, value: feeWei });

  const block = await ctx.publicClient.getBlock();
  const previewStartTime = Number(block.timestamp) + 60;
  const p = await paramsFor(ctx, input, previewStartTime);
  const sim = await sdkFor(ctx).factory.simulateCreateMulticurve(p.params);
  const launchGas = sim.gasEstimate ?? 0n;
  const gasPrice = await ctx.publicClient.getGasPrice();
  const monBalance = await ctx.publicClient.getBalance({ address: ctx.account });
  // register() ≈ 1M gas on the fork; shown as an estimate until the token exists.
  const estimatedMonCost = (withBuffer(launchGas) + withBuffer(1_000_000n) + (feeGas ? withBuffer(feeGas) : 0n)) * gasPrice + (reuse ? 0n : feeWei);
  return {
    ...p, mode: 'classic', txCount: (reuse ? 0 : 1) + 2,
    signatureCount: (hasMetadata(input) ? 1 : 0) + (input.service ? 1 : 0),
    excludedFromBalanceLimit: p.excluded, previewStartTime, predictedToken: sim.tokenAddress as Address,
    feeTx: { needed: !reuse, reusingReceipt: reuse, valueWei: feeWei, gas: feeGas ? withBuffer(feeGas) : null },
    launchGas: withBuffer(launchGas), registerGas: 'after launch', gasPrice, estimatedMonCost, monBalance,
  };
}

export type StepKey = 'fee' | 'verify' | 'launch' | 'register' | 'listing' | 'metadata' | 'service' | 'sign' | 'details';
export type Progress = (step: StepKey, state: 'running' | 'done' | 'skipped' | 'error', info?: { tx?: Hex; note?: string }) => void;

export interface LaunchResult { asset: Address; poolId: Hex; router: Address; launchTx: Hex; registerTx: Hex; feeTx: Hex | null; listed: boolean; notes: string[] }

/** Runs the whole flow. Each tx is simulated right before sending. */
export async function executeLaunch(ctx: Ctx, input: LaunchInput, plan: LaunchPlan, progress: Progress, opts = { listingTimeoutMs: 300_000 }): Promise<LaunchResult> {
  if (plan.mode === 'helper') return executeHelperLaunch(ctx, input, plan, progress, opts);
  const notes: string[] = [];
  const chain = ctx.walletClient.chain ?? null;
  // ── 1. launch fee ──
  let feeTx: Hex | null = null;
  if (plan.feeTx.needed) {
    progress('fee', 'running');
    const gas = await ctx.publicClient.estimateGas({ account: ctx.account, to: ctx.config.launchFee.treasury, value: plan.feeTx.valueWei });
    feeTx = await ctx.walletClient.sendTransaction({ account: ctx.account, chain, to: ctx.config.launchFee.treasury, value: plan.feeTx.valueWei, gas: withBuffer(gas) });
    const r = await ctx.publicClient.waitForTransactionReceipt({ hash: feeTx });
    if (r.status !== 'success') throw new LaunchError(`Launch fee transaction reverted (${feeTx}).`, 'fee_failed');
    progress('fee', 'done', { tx: feeTx });
    progress('verify', 'running', { note: 'waiting for finality' });
    for (let i = 0; ; i++) {
      const v = await api<{ error?: string; message?: string; nextSlotAt?: number }>(ctx, '/api/launch-fee/verify', { method: 'POST', body: JSON.stringify({ txHash: feeTx }) });
      if (v.status === 201) break;
      if (v.body.error === 'not_finalized' && i < 90) { await sleep(2_000); continue; }
      throw new LaunchError(v.body.message ?? `Fee verification failed (${v.status}).`, v.body.error, { feeTx, nextSlotAt: v.body.nextSlotAt });
    }
    progress('verify', 'done', { tx: feeTx });
  } else {
    progress('fee', 'skipped', { note: `reusing paid fee ${plan.feeTx.reusingReceipt}` });
    progress('verify', 'skipped');
  }

  // ── 2. createMulticurve (startTime recomputed from the latest block) ──
  progress('launch', 'running');
  const fresh = await ctx.publicClient.getBlock();
  const startTime = Number(fresh.timestamp) + 60;
  const p = await paramsFor(ctx, input, startTime);
  const sdk = sdkFor(ctx);
  const sim = await sdk.factory.simulateCreateMulticurve(p.params);
  const res = await sdk.factory.createMulticurve({ ...p.params, gas: withBuffer(sim.gasEstimate ?? plan.launchGas) });
  const lr = await ctx.publicClient.waitForTransactionReceipt({ hash: res.transactionHash as Hex });
  if (lr.status !== 'success') throw new LaunchError(`Launch transaction reverted (${res.transactionHash}).`, 'launch_failed');
  const asset = getAddress(res.tokenAddress as Address);
  progress('launch', 'done', { tx: res.transactionHash as Hex, note: asset });

  // ── 3. balance-cap window check, then register (simulated) ──
  progress('register', 'running');
  const [vs, capEnd] = await Promise.all([
    ctx.publicClient.readContract({ address: asset, abi: tokenCapAbi, functionName: 'vestingStart' }),
    ctx.publicClient.readContract({ address: asset, abi: tokenCapAbi, functionName: 'balanceLimitEnd' }),
  ]);
  const win = BigInt(capEnd) - vs;
  if (win < BigInt(CAP_WINDOW_MIN) || win > BigInt(CAP_WINDOW_MAX)) {
    throw new LaunchError(`Balance-cap window ${win}s is outside [${CAP_WINDOW_MIN}, ${CAP_WINDOW_MAX}]; register() would revert. Token ${asset} is launched but not registered.`, 'cap_window', { asset });
  }
  const { request } = await ctx.publicClient.simulateContract({
    account: ctx.account, address: ctx.config.contracts.registry, abi: registryAbi, functionName: 'register', args: [asset, p.creator],
  });
  const regGas = await ctx.publicClient.estimateContractGas({
    account: ctx.account, address: ctx.config.contracts.registry, abi: registryAbi, functionName: 'register', args: [asset, p.creator],
  });
  const registerTx = await ctx.walletClient.writeContract({ ...request, chain, gas: withBuffer(regGas) });
  const rr = await ctx.publicClient.waitForTransactionReceipt({ hash: registerTx });
  if (rr.status !== 'success') throw new LaunchError(`register() reverted (${registerTx}). Token ${asset} is launched but not registered.`, 'register_failed', { asset });
  const router = await ctx.publicClient.readContract({ address: ctx.config.contracts.registry, abi: registryAbi, functionName: 'routers', args: [asset] });
  progress('register', 'done', { tx: registerTx });

  // ── 4. wait until the indexer consumed the fee (token listed + tokens row exists) ──
  progress('listing', 'running', { note: 'waiting for the indexer (finalized blocks)' });
  let listed = false;
  const deadline = Date.now() + opts.listingTimeoutMs;
  while (Date.now() < deadline) {
    const s = await feeStatus(ctx);
    if (s.launchesLast24hAssets.map((a) => a.toLowerCase()).includes(asset.toLowerCase())) { listed = true; break; }
    await sleep(3_000);
  }
  if (!listed) {
    progress('listing', 'error', { note: 'not listed yet; the indexer may be behind' });
    notes.push('The token is registered but not listed yet. Metadata and the service can be added from the Creator page once it is listed.');
    progress('metadata', 'skipped'); progress('service', 'skipped');
    return { asset, poolId: res.poolId as Hex, router, launchTx: res.transactionHash as Hex, registerTx, feeTx, listed, notes };
  }
  progress('listing', 'done');

  // ── 5. signed metadata + service (the connected wallet is the on-chain creator) ──
  const meta = {
    asset, issuedAt: Math.floor(Date.now() / 1000),
    ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}), ...(input.xHandle ? { xHandle: input.xHandle } : {}),
    ...(input.website ? { website: input.website } : {}), ...(input.description ? { description: input.description } : {}),
  };
  const hasMeta = Object.keys(meta).length > 2;
  if (!hasMeta) progress('metadata', 'skipped');
  else {
    progress('metadata', 'running', { note: 'sign in your wallet' });
    const signature = await ctx.walletClient.signMessage({ account: ctx.account, message: tokenMetadataMessage(meta) });
    const r = await api<{ error?: string }>(ctx, '/api/tokens', { method: 'POST', body: JSON.stringify({ ...meta, signature }) });
    if (r.status !== 200) throw new LaunchError(`Metadata was not saved: ${r.body.error ?? r.status}`, 'metadata_failed', { asset });
    progress('metadata', 'done');
  }
  if (!input.service) progress('service', 'skipped');
  else {
    progress('service', 'running', { note: 'sign in your wallet' });
    const svc = {
      asset, slug: input.service.slug, name: input.service.name, upstreamUrl: input.service.upstreamUrl,
      priceUsdc: input.service.priceUsdc.toString(), ...(input.service.description ? { description: input.service.description } : {}),
      ...(input.service.examplePath ? { examplePath: input.service.examplePath } : {}),
      issuedAt: Math.floor(Date.now() / 1000),
    };
    const signature = await ctx.walletClient.signMessage({ account: ctx.account, message: serviceCreateMessage(svc) });
    const r = await api<{ error?: string }>(ctx, '/api/services', { method: 'POST', body: JSON.stringify({ ...svc, signature }) });
    if (r.status !== 201) throw new LaunchError(`Service was not registered: ${r.body.error ?? r.status}`, 'service_failed', { asset });
    progress('service', 'done');
  }
  return { asset, poolId: res.poolId as Hex, router, launchTx: res.transactionHash as Hex, registerTx, feeTx, listed, notes };
}

/** Poll the fee status until `asset` counts as a listed launch of this wallet. */
async function waitListed(ctx: Ctx, asset: Address, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await feeStatus(ctx);
    if (s.launchesLast24hAssets.map((a) => a.toLowerCase()).includes(asset.toLowerCase())) return true;
    await sleep(3_000);
  }
  return false;
}

/**
 * One-transaction flow: LaunchHelper.launch (create + register + fee) → verify the fee from the same tx
 * (if paid) → ONE signature over metadata + service → wait for listing → POST /api/tokens/launch-details.
 */
async function executeHelperLaunch(ctx: Ctx, input: LaunchInput, plan: LaunchPlan, progress: Progress, opts: { listingTimeoutMs: number }): Promise<LaunchResult> {
  const notes: string[] = [];
  const chain = ctx.walletClient.chain ?? null;
  const helper = ctx.config.launchHelper!;

  // ── 1. the one transaction (startTime recomputed from the latest block) ──
  progress('launch', 'running', { note: plan.feeTx.needed ? 'create + register + 10 MON fee' : 'create + register (fee already paid)' });
  const fresh = await ctx.publicClient.getBlock();
  const p = await paramsFor(ctx, input, Number(fresh.timestamp) + 60);
  const createParams = encodeCreateParams(ctx, p.params);
  const value = plan.feeTx.needed ? plan.feeTx.valueWei : 0n;
  const call = { account: ctx.account, address: helper, abi: launchHelperAbi, functionName: 'launch', args: [createParams, p.creator], value } as const;
  const { request } = await ctx.publicClient.simulateContract(call);
  const gas = await ctx.publicClient.estimateContractGas(call);
  const tx = await ctx.walletClient.writeContract({ ...request, chain, gas: withBuffer(gas) });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== 'success') throw new LaunchError(`Launch transaction reverted (${tx}). No fee was taken.`, 'launch_failed');
  const launched = parseEventLogs({ abi: launchHelperAbi, eventName: 'Launched', logs: receipt.logs })
    .find((l) => getAddress(l.address) === getAddress(helper));
  if (!launched) throw new LaunchError(`Launch transaction ${tx} has no Launched event.`, 'launch_failed');
  const asset = getAddress(launched.args.asset);
  const router = getAddress(launched.args.router);
  const registered = parseEventLogs({ abi: registryAbi, eventName: 'Registered', logs: receipt.logs })
    .find((l) => getAddress(l.address) === getAddress(ctx.config.contracts.registry) && getAddress(l.args.asset) === asset);
  if (!registered) throw new LaunchError(`Launch transaction ${tx} has no Registered event for ${asset}.`, 'launch_failed');
  const poolId = registered.args.poolId;
  progress('launch', 'done', { tx, note: asset });

  // ── 2. fee receipt from the same transaction ──
  if (plan.feeTx.needed) {
    progress('verify', 'running', { note: 'waiting for finality' });
    for (let i = 0; ; i++) {
      const v = await api<{ error?: string; message?: string; nextSlotAt?: number }>(ctx, '/api/launch-fee/verify', { method: 'POST', body: JSON.stringify({ txHash: tx }) });
      if (v.status === 201) break;
      if (v.body.error === 'not_finalized' && i < 90) { await sleep(2_000); continue; }
      throw new LaunchError(v.body.message ?? `Fee verification failed (${v.status}).`, v.body.error, { feeTx: tx, asset, nextSlotAt: v.body.nextSlotAt });
    }
    progress('verify', 'done', { tx });
  } else {
    progress('verify', 'skipped', { note: `used paid fee ${plan.feeTx.reusingReceipt}` });
  }

  // ── 3. one signature for metadata + service (the connected wallet is the on-chain creator) ──
  const details = {
    asset, issuedAt: Math.floor(Date.now() / 1000),
    ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}), ...(input.xHandle ? { xHandle: input.xHandle } : {}),
    ...(input.website ? { website: input.website } : {}), ...(input.description ? { description: input.description } : {}),
    ...(input.service ? { service: {
      slug: input.service.slug, name: input.service.name, upstreamUrl: input.service.upstreamUrl,
      priceUsdc: input.service.priceUsdc.toString(), ...(input.service.description ? { description: input.service.description } : {}),
      ...(input.service.examplePath ? { examplePath: input.service.examplePath } : {}),
    } } : {}),
  };
  const wants = hasMetadata(input) || !!input.service;
  let signature: Hex | null = null;
  if (!wants) progress('sign', 'skipped');
  else {
    progress('sign', 'running', { note: 'one signature: token details + service' });
    signature = await ctx.walletClient.signMessage({ account: ctx.account, message: launchDetailsMessage(details) });
    progress('sign', 'done');
  }

  // ── 4. listing, then save the signed details ──
  progress('listing', 'running', { note: 'waiting for the indexer (finalized blocks)' });
  const listed = await waitListed(ctx, asset, opts.listingTimeoutMs);
  if (!listed) {
    progress('listing', 'error', { note: 'not listed yet; the indexer may be behind' });
    notes.push('The token is registered but not listed yet. Token details and the service can be added from the Creator page once it is listed.');
    progress('details', 'skipped');
    return { asset, poolId, router, launchTx: tx, registerTx: tx, feeTx: plan.feeTx.needed ? tx : null, listed, notes };
  }
  progress('listing', 'done');
  if (!signature) progress('details', 'skipped');
  else {
    progress('details', 'running');
    const r = await api<{ error?: string }>(ctx, '/api/tokens/launch-details', { method: 'POST', body: JSON.stringify({ ...details, signature }) });
    if (r.status !== 200 && r.status !== 201) throw new LaunchError(`Token details / service were not saved: ${r.body.error ?? r.status}`, 'details_failed', { asset });
    progress('details', 'done');
  }
  return { asset, poolId, router, launchTx: tx, registerTx: tx, feeTx: plan.feeTx.needed ? tx : null, listed, notes };
}

export const fmtMon = (wei: bigint) => `${Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 6 })} MON`;
