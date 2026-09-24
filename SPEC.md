# Revpad — SPEC

> Status: draft v0.3 (updated 2026-09-23: Fix 1-3 implemented, integrator check, SPEC catches up with code) · Target: Monad mainnet (chainId 143) · Hackathon deadline: 2026-10-13
> Source of truth for product + economics. `CLAUDE.md` holds working rules for the coding agent.
> `docs/BANKR_REFERENCE.md` is functional context only. Evidence for v0.2 changes: `docs/VERIFICATION-anvil.md`, `docs/VERIFICATION-real.md`.

---

## 0. Decisions log

### Locked
| # | Decision |
|---|---|
| D1 | Every service on Revpad has a token. A token may exist without a service (attach later). No pre-token / gateway-only mode. |
| D2 | Launch is permissionless, anytime, no revenue gate. Revpad charges no launch fee; creator pays Monad gas only (~0.5 MON, §4.6). |
| D3 | Revenue is measured **only after launch**, through the service's RevenueRouter. No revenue-anchored start price. |
| D4 | Trading fee = **2%** of volume. Doppler beneficiary shares: Doppler 5% / creator-liquid 35% / creator-escrow 20% / buyback 10% / platform 30%. **Verified on fork**: fees = 2.000% in both currencies, split exact. |
| D5 | Service revenue split: provider 60% / buyback 30% / platform 10%. Agents pay the provider's list price, no surcharge. |
| D6 | Escrow unlock: 0.2 USDC per 1 USDC of recorded service revenue. Unclaimed escrow forfeits to buyback 365 days after launch. |
| D7 | Supply: 1,000,000,000. 85% into the pool, 15% creator allocation vested 1 year with a 30-day cliff (native DopplerERC20V1 vesting). |
| D8 | Buyback buys the token from its own pool and burns it. Execution is permissionless. |
| D9 | Doppler multicurve (Uniswap v4), lockable beneficiaries, no migration, pool paired with USDC. |
| D10 | **Initializer: `V4ScheduledMulticurveInitializer`.** Monad has no standard or decay multicurve initializer (SDK 1.0.43, confirmed on fork). Tick spacing 200. |
| D11 | **Launch via Doppler SDK, then register on-chain.** The frontend creates the token with the SDK; `RevpadRegistry.register(asset)` verifies the on-chain config and only then deploys the router and lists the token (§6.1). Replaces "factory calls Airlock". |
| D12 | **Anti-snipe v1 = DopplerERC20V1 per-wallet balance cap: 1% of supply for the first 12 minutes** (`balanceLimitEnd = startTime + 720 s`; registry accepts [600, 900] s). Verified: over-cap buy reverts, succeeds after the window. Weak against multi-wallet bots; accepted for v1. |
| D13 | **x402 facilitator = Monad official** `https://x402-facilitator.molandak.org` (x402 v2 only). Always call it through the SDK `HTTPFacilitatorClient`. Self-hosted facilitator (SDK `registerExactEvmScheme`) is the fallback. |
| D14 | **Contracts swap through `PoolManager.unlock()` directly** (IUnlockCallback), not Universal Router/Permit2. Universal Router is for user wallets only. |
| D15 | Each fee beneficiary contract (FeeEscrow, BuybackVault) must call `collectFees` on the initializer itself; Doppler releases a beneficiary's share only to the caller (verified). |
| D16 | **`DOPPLER_HOOK` is constant across launches.** The V4ScheduledMulticurveInitializer's hook address (`0x580ca49389d83b019d07E17e99454f2F218e2dc0`) is the same for every token launched through it on Monad mainnet. Confirmed across 4+ distinct token launches in testing. `RevpadRegistry.register` now takes `(address asset, address creator)` — `poolId` is computed on-chain from `INITIALIZER.getState(asset).poolKey`. The registry adds `WrongPool` error when the pool's hook ≠ `DOPPLER_HOOK`. |
| D17 | **Integrator must equal the Revpad treasury.** `Airlock.getAssetData(asset).integrator` is recorded at launch time by the Doppler SDK. For every Revpad token, the integrator is the treasury address. `RevpadRegistry.register` now checks this and reverts with `WrongIntegrator` on mismatch. |
| D18 | **Balance cap window: registry enforces [600, 900] s; launch script targets 720 s.** `DopplerERC20V1.vestingStart` = `block.timestamp` at deploy. On Monad (0.4 s blocks) the tx lands ~1 s after `startTime`, giving `window ≈ 721 s`. On Anvil (1 s blocks + SDK lag ~26 s) `window ≈ 696 s`. Both inside [600, 900]. Using 900 caused `WrongBalanceCap` on Monad because the window was 901 s (decisions.md D20). |
| D21 | **PlatformFeeReceiver replaces treasury wallet as beneficiary/integrator/router destination.** A singleton whose address is fixed forever; it forwards collected funds to a changeable `treasury` via a two-step 48h-delay pattern (`proposeTreasury → acceptTreasury`). Treasury changes are effective for ALL tokens (old and new) without touching existing contracts. RevpadRegistry no longer has `setTreasury()`; the treasury is managed through PlatformFeeReceiver. |
| D22 | **Two-step admin transfer on RevpadRegistry and PlatformFeeReceiver.** `transferAdmin(newAdmin)` sets `pendingAdmin`; only `pendingAdmin` can call `acceptAdmin()` to finalize. `cancelAdminTransfer()` by current admin. No delay (admin transfer is already gated by the new admin accepting). FeeEscrow, BuybackVault, RevenueRouter have no admin. |

### Open
| # | Question | Current default |
|---|---|---|
| O1 | Standard starting market cap | **Verified on Anvil fork (2026-09-23): 1 USDC buys ~96,776 tokens → implied FDV $10,333 (~1.03× target, within tick-rounding). `withCurves` config is correct. Keeping $10,000 for v1. Revisit for mainnet.** |
| O2 | Stronger anti-snipe: Rehype hook (`startFee`→`endFee` decay + native asset buyback) | **Deferred — research later.** v1 uses D12 only |
| O4 | Token-denominated escrow fees | Keeper swaps them to USDC (single-currency escrow accounting) |
| O5 | Verified badge thresholds | Hackathon: ≥20 USDC clean revenue from ≥5 clean payers; mainnet: ≥100 USDC / ≥10 |
| O6 | Keep 2% total fee on mainnet? | Keep for hackathon; re-evaluate vs Monad launchpad fees |
| O7 | Can the creator change the provider payout address? | Yes, creator-only, emits event |
| ~~O8~~ | ~~Facilitator submitter addresses~~ | **Locked.** `0x7f6a2850669202519f0FE8aa912451238820Db86` recorded in `addresses.ts` and `.env.example`. Server reads via `FACILITATOR_SUBMITTER_ADDRESSES` env var for clean-revenue filtering (§13). |
| O9 | Payers with EIP-7702-delegated wallets (ERC-1271 path in the facilitator) | Not yet tested on real Monad; add one payment test before mainnet |
| O10 | Multi-asset quote pairs (forex stablecoins such as EURC, then tokenised stocks) | EURC is not natively deployed on Monad as of 2026-09; no liquid USDC pool exists. Deferred until Revpad v1 ships and a liquid quote token appears on Monad. See §21 for scope. |
| O11 | Keeper and server availability SLA | Single-instance confirmed acceptable for hackathon (23 Sep — keeper verified collect/distribute/buyback in one tick). Mainnet requires dual-region or decentralised keeper; deferred to §21. |

When an open item is decided, move it to "Locked" and update the relevant section.

## 1. Summary

Revpad is a token launchpad on Monad for **x402 services** (APIs that charge per request via HTTP 402 + USDC). Each service is paired with a token. Two money flows exist per token:

1. **Trading fees (2%)** from people trading the token → split between Doppler, the creator (part liquid, part escrowed), buyback, and the platform.
2. **Service revenue** from agents paying for calls through the Revpad gateway → split between provider, buyback, and platform. Every 1 USDC of revenue also unlocks 0.2 USDC of the creator's escrowed trading fees.

Effect: a creator earns from hype immediately (liquid share), but the escrowed share only becomes theirs when the service has paying users. Tokens without real usage eventually hand their escrow to holders via buyback.

Positioning (internal, not a tagline): same launch ease as agent-token launchpads, but the token's buyback is fed by metered service revenue, and creator earnings above the liquid share depend on usage.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| Asset | The launched ERC-20 token (Doppler DERC20). |
| Service | An x402 endpoint registered on Revpad and bound to one asset. |
| Provider | Address that receives the provider share of service revenue. Defaults to the creator. |
| Gateway | Revpad's HTTP proxy that returns 402, verifies payment, forwards to upstream, settles on success. |
| Upstream | The provider's real API (BYO) or a Revpad-hosted template runtime. |
| RevenueRouter | Per-asset contract used as x402 `payTo`. Splits inflows. |
| FeeEscrow | Singleton holding the 20% escrowed creator fee share per asset. |
| BuybackVault | Singleton holding buyback funds per asset; buys + burns. |
| Clean revenue | Display-level revenue after wash filtering (§13). Never used by contracts. |
| UCR | Usage Coverage Ratio = revenue-funded buyback ÷ trading-funded buyback (§13). |

---

## 3. Invariants (never violate)

1. Revpad never custodies user funds. Every flow is contract-enforced; no admin function can move escrow, buyback, or router balances to an arbitrary address.
2. `ESCROW_UNLOCK_BPS < 10000 - PROVIDER_BPS`. With provider 6000, unlock must be < 4000. Current value 2000. This keeps self-paid ("wash") revenue loss-making.
3. Gateway settles payment **only after** the upstream returns a successful response. Failed calls are never charged.
4. Contracts count **all** USDC inflows to a RevenueRouter as revenue (economically safe, no oracle). Wash filtering happens only at display level.
5. BuybackVault can only (a) swap USDC → its own asset through that asset's pool and (b) burn the asset.
6. Split math: sum of outputs == input, rounding dust stays in the contract and is carried to the next distribution.
7. All Monad transactions sent by Revpad code (frontend, keeper, scripts) set an explicit gas limit = estimate + small buffer. Monad bills the gas **limit**, not gas used.
8. `@x402/evm` must be ≥ 2.12.0 (2.9.0–2.11.0 point to a proxy address not deployed on Monad and fail silently at settle).
9. No hardcoded contract addresses outside `packages/shared/src/addresses.ts`; every entry has a source comment.

---

## 4. Economics

### 4.1 Trading fee (2% of volume)

| Beneficiary | Share (WAD) | % of volume | Claim path |
|---|---|---|---|
| Doppler protocol (Airlock owner) | 0.05 | 0.10% | Doppler (minimum required by contract) |
| Creator — liquid | 0.35 | 0.70% | Creator claims directly from Doppler |
| Creator — escrow (FeeEscrow) | 0.20 | 0.40% | Unlocks by revenue (§4.3) |
| BuybackVault | 0.10 | 0.20% | Buy + burn (§6.4) |
| Platform treasury | 0.30 | 0.60% | PlatformFeeReceiver (singleton) → forwards to changeable treasury (48h delay, D21) |

- Doppler on EVM takes 5% of trading fees; with lockable beneficiaries the Airlock owner **must** be a beneficiary with ≥ 5%. Get it via SDK `getAirlockOwner(publicClient)`.
- Beneficiaries must be sorted by address ascending (SDK does this); shares must sum to 1e18.
- Fees arrive in both currencies: buyers pay fees in USDC, sellers pay fees in the asset.
- Uniswap v4 fee units: 2% = `20000` (hundredths of a bip), tick spacing `200`. Verified on the scheduled multicurve (pool state fee=20000, tickSpacing=200).
- Verified on fork (250 USDC buys, 8.87M tokens sold): USDC-side fees = 2.000% of buy volume, token-side fees = 2.000% of sell volume; the four Revpad beneficiaries received exactly 35/20/10/30 of the 95% after Doppler.
- A beneficiary receives its share only when **it** calls `collectFees`. Contract beneficiaries must implement this call.

### 4.2 Service revenue

| Recipient | BPS | Notes |
|---|---|---|
| Provider | 6000 − costBps | costBps = 0 for BYO APIs |
| Cost recipient (Revpad) | costBps | Only for Revpad-hosted templates; covers inference. Capped (§10) |
| BuybackVault | 3000 | |
| Platform treasury | 1000 | |

### 4.3 Creator escrow

- `allowanceUSDC(asset) = recordedRevenue(asset) × 2000 / 10000`
- Claimable = `min(allowanceUSDC, escrowUSDCAccrued) − escrowUSDCClaimed`
- Token-denominated escrow fees: keeper swaps to USDC in small, slippage-capped batches (O4). Escrow accounting is USDC only.
- `forfeit(asset)`: callable by anyone after `launchTime + 365 days`; moves remaining unclaimed escrow USDC to BuybackVault for that asset.

Effective provider take while escrow has balance: 0.6 + 0.2 = **0.8 per 1 USDC** of revenue.

### 4.4 Wash check (must stay true)

Creator self-pays 1 USDC through gateway (or transfers directly to router):
- Gets back 0.6 (provider) + 0.2 (escrow unlock) = 0.8 → loss 0.2
- Buyback of 0.3 raises price; creator holds ≤ 15% supply → gain ≈ 0.045
- Net ≈ −0.155 per USDC. Any parameter change must keep this negative.

### 4.5 Supply

| Bucket | % | Mechanism |
|---|---|---|
| Pool (numTokensToSell) | 85% | Doppler scheduled multicurve |
| Creator allocation | 15% | DopplerERC20V1 native vesting: `cliffDuration` 30 days, `duration` 365 days |

- `numTokensToSell + vested == initialSupply` exactly; Airlock sends any leftover to the timelock. Verified: creator holds 0 tokens at launch.
- **Vesting accrues linearly from launch; the cliff only gates claiming** (verified: 0 at day 29, 12.74M ≈ 8.5% at day 31, 49.8% at day 182, 100% at day 366). So at day 30 the creator can claim ~30 days' worth at once (~12.3M tokens, ~1.2% of supply). Show this date and amount on the token page.
- No `CreatorVesting` contract is needed.

### 4.6 Launch cost

- No Revpad fee. Creator pays Monad gas for the launch transaction.
- Measured on real Monad (`eth_estimateGas`, no tx): launch **4,589,375 gas**; gasLimit ×1.1 = **~5.05M** (well under the 30M per-tx limit).
- Monad bills `gasLimit × gasPrice`. At 100 gwei base + a few gwei priority: **~0.51–0.55 MON per launch**.
- Other measured costs: USDC approve 87,715 gas; USDC transfer 83,195; x402 settle (`transferWithAuthorization`) 136,409 gas, paid by the facilitator.
- Anvil forks run with Foundry ≥ 1.8 use Monad execution: fork measurement 4,547,173 vs real 4,589,375 (0.9% apart). Gas measured on the fork is usable for estimates.
- Frontend: simulate, show MON estimate, send with gasLimit = estimate × 1.1.

### 4.7 Worked examples

Creator income per day, token mcap 500K, volume 50K/day, service revenue 100 USDC/day:
- Liquid fees: 0.70% × 50,000 = 350
- Escrow accrues: 0.40% × 50,000 = 200; unlocks 0.2 × 100 = 20
- Provider revenue share: 60
- Vesting (after cliff): 15% × 500,000 / 365 ≈ 205

Platform per day at 200K total volume and 500 USDC total service revenue: 0.60% × 200,000 + 10% × 500 = 1,200 + 50 = 1,250.

---

## 5. Architecture

```
                 ┌──────────────────────────── Monad ────────────────────────────┐
 Creator ──SDK launch──▶ Doppler Airlock ──▶ DopplerERC20V1 + v4 pool (USDC, scheduled multicurve)
                 │   then register(asset) ▶ RevpadRegistry ─ verifies config, deploys RevenueRouter (clone)
                 │                                             │ fees (both currencies) ▼
                 │                          Doppler beneficiaries: Airlock owner · creator ·
                 │                          FeeEscrow · BuybackVault · Treasury
 Agent ─HTTP─▶ Gateway ─verify/settle─▶ Monad x402 facilitator ─USDC─▶ RevenueRouter
                 │  │                                                  │ distribute()
                 │  └─forward─▶ Upstream (BYO API | hosted template)   ├─▶ provider 60%
                 │                                                     ├─▶ BuybackVault 30%
                 │                                                     ├─▶ Treasury 10%
                 │                                                     └─▶ FeeEscrow.recordRevenue()
 Keeper ─────────┴─ distribute · collect fees · swap escrow token fees · buyback+burn · forfeit
 Envio indexer ◀── chain events        Server (Hono) ◀── Postgres (gateway logs, probes)
 Web (Vite+React) ◀── Server API + Envio GraphQL + Doppler indexer API
```

Monorepo (pnpm workspace):

```
apps/web          Vite + React + TS (Privy auth, viem)
apps/server       Hono: public API + x402 gateway routes + hosted template runtime
apps/keeper       Node worker: scheduled on-chain jobs
packages/contracts  Foundry: RevpadRegistry, RevenueRouter, FeeEscrow, BuybackVault
packages/indexer    Envio HyperIndex config + handlers
packages/shared     constants (fees, bps), addresses, zod schemas, fee math, types
```

Infra: Hetzner + Coolify, Cloudflare Tunnel, Postgres. LLM calls for hosted templates via existing LiteLLM proxy.

---

## 6. Smart contracts (`packages/contracts`)

Solidity ^0.8.24, Foundry. Custom errors, events on every state change, NatSpec on public functions. USDC has 6 decimals.

### 6.1 `RevpadRegistry` (launch via SDK, verify, then register)

Why: re-implementing the Doppler multicurve encoding in Solidity is long and error-prone. The SDK launch path is already verified on the fork. The registry enforces the same guarantees by **checking** the result on-chain instead of **building** it.

Flow:
1. Frontend launches with the Doppler SDK using the fixed Revpad config (§4): scheduled multicurve, fee 20000, tick spacing 200, beneficiaries [Airlock owner 5%, creator 35%, FeeEscrow 20%, BuybackVault 10%, PlatformFeeReceiver 30%], supply 1e9 with 85/15, vesting 30d/365d, balance cap 1% for 12 min (720 s target; registry accepts 10–15 min), noOp governance and migration, numeraire USDC, integrator = PlatformFeeReceiver.
2. Anyone calls `register(asset, creator)`. No `poolId` parameter — it is derived on-chain (D16).

```solidity
function register(address asset, address creator) external returns (address router);
function isRegistered(address asset) external view returns (bool);
```

`register` verifies on-chain, reverting with a specific custom error on each mismatch:

| Check | Error |
|---|---|
| Airlock.getAssetData: poolInitializer == INITIALIZER | `WrongInitializer` |
| Airlock.getAssetData: liquidityMigrator == NOMIG | `WrongMigrator` |
| Airlock.getAssetData: governance == 0x…dEaD | `WrongGovernance` |
| Airlock.getAssetData: numeraire == USDC | `WrongNumeraire` |
| Airlock.getAssetData: totalSupply == 1e9×1e18 | `WrongTotalSupply` |
| Airlock.getAssetData: numTokensToSell == 850M×1e18 | `WrongNumTokensToSell` |
| Airlock.getAssetData: integrator == PlatformFeeReceiver (D17, D21) | `WrongIntegrator` |
| getState(asset).poolKey.hooks == DOPPLER_HOOK (D16) | `WrongPool` |
| poolKey.fee == 20000 | `WrongFee` |
| poolKey.tickSpacing == 200 | `WrongTickSpacing` |
| poolKey currencies are {asset, USDC} | `WrongPoolCurrencies` |
| getShares(poolId, Airlock owner) == 0.05e18 | `WrongDopplerShare` |
| getShares(poolId, creator) == 0.35e18 | `WrongCreatorShare` |
| getShares(poolId, FeeEscrow) == 0.20e18 | `WrongEscrowShare` |
| getShares(poolId, BuybackVault) == 0.10e18 | `WrongBuybackShare` |
| getShares(poolId, PlatformFeeReceiver) == 0.30e18 | `WrongTreasuryShare` |
| vestingSchedules(0).cliff == 30 days | `WrongVestingCliff` |
| vestingSchedules(0).duration == 365 days | `WrongVestingDuration` |
| totalAllocatedOf(creator) == 150M×1e18 (Fix 2) | `WrongVestingAmount` |
| vestedTotalAmount() == 150M×1e18 (Fix 2) | `WrongVestingAmount` |
| maxBalanceLimit() == 10M×1e18 (1%) (Fix 3) | `WrongBalanceCap` |
| 600 s ≤ balanceLimitEnd − vestingStart ≤ 900 s (Fix 3, D18) | `WrongBalanceCap` |
| asset not already registered | `AlreadyRegistered` |

Then: deploy `RevenueRouter` clone, register asset in FeeEscrow and BuybackVault (pool key, creator, launch time, router), emit `Registered(asset, creator, router, poolId, timestamp)`.

Tokens that fail verification are never listed. Week-2 check: confirm every field above is readable from the initializer/token/Airlock (the SDK reads fee, tick spacing, status, pool key and pending fees from chain). If a field is not readable on-chain, document the fallback in `docs/decisions.md` (e.g. verify from the Airlock `Create` event data).

Admin (multisig): `pause`, `transferAdmin` (two-step, D22). Treasury changes are managed through PlatformFeeReceiver (D21). No power over registered assets' funds.

### 6.2 `RevenueRouter` (clone per asset)

```solidity
address public asset; address public provider; address public costRecipient; uint16 public costBps;
function distribute() external;                 // permissionless
function setProvider(address p) external;        // only creator
function setCost(address r, uint16 bps) external;// only registry admin, bps ≤ MAX_COST_BPS (3000), hosted services only
```

`distribute()`:
- `amt = USDC.balanceOf(this)`; return if `amt < MIN_DISTRIBUTE` (e.g. 0.5 USDC).
- provider `(6000 − costBps)`, cost `costBps`, buyback `3000`, treasury `1000` (bps of amt); dust stays.
- `FeeEscrow.recordRevenue(asset, amt)` (only callable by the registered router of `asset`).
- `BuybackVault.creditUSDC(asset, buybackAmt)` accounting.
- Emit `Distributed(asset, amt, providerAmt, costAmt, buybackAmt, treasuryAmt)`.

Note: USDC arriving via `transferWithAuthorization` does not execute router code; revenue is realized at `distribute()`.

### 6.3 `FeeEscrow` (singleton)

State per asset: `creator, launchTime, usdcAccrued, usdcClaimed, tokenPending, recordedRevenue, forfeited`.

```solidity
function collect(address asset) external;            // calls collectFees(poolId) on the scheduled initializer AS the beneficiary; attributes deltas
function swapTokenFees(address asset, uint256 maxIn, uint256 minOut) external; // asset -> USDC via PoolManager.unlock (O4)
function recordRevenue(address asset, uint256 amt) external; // only router
function claimable(address asset) external view returns (uint256);
function claim(address asset) external;              // only creator
function forfeit(address asset) external;            // anyone, after launchTime + 365 days
```

- Doppler pays a beneficiary only when that beneficiary calls `collectFees` (verified), so `collect` must be called by this contract; anyone may trigger `collect`.
- Attribution: collection is per pool; balance deltas around the call are attributed to that asset.
- `claimable = min(recordedRevenue * 2000 / 10000, usdcAccrued) − usdcClaimed` (never negative).
- `forfeit` moves unclaimed escrow (+ pending token fees) to BuybackVault for the asset; later accruals go straight to buyback.

### 6.4 `BuybackVault` (singleton)

```solidity
function collect(address asset) external;           // calls collectFees(poolId) on the initializer as the beneficiary
function creditUSDC(address asset, uint256 amt, uint8 sourceTag) external; // only routers/escrow
function execute(address asset, uint256 usdcIn, uint256 minTokenOut) external; // permissionless
function burnTokens(address asset) external;        // burn asset-denominated balance
```

Rules in `execute`:
- `usdcIn ≤ min(balanceUSDC[asset], MAX_PER_CALL)`; at most once per `MIN_INTERVAL` (e.g. 10 min) per asset.
- Swap USDC → `asset` **through `PoolManager.unlock()`** with an `unlockCallback` that swaps on the asset's own pool key, settles USDC, takes the asset. No Universal Router, no Permit2.
- Require `minTokenOut`; burn all received tokens with DopplerERC20V1 `burn` (exists; confirm it burns the caller's own balance) or transfer to `0x…dEaD` as fallback.
- Track `buybackFromRevenue` vs `buybackFromTrading` per asset and emit `BuybackExecuted(asset, usdcIn, tokensBurned, sourceTag)`.
- Known cost: the swap pays the 2% pool fee (≈1.75% net leakage after the vault's own share returns). Accept for v1.
- During the balance cap window (first ~12 minutes; `balanceLimitEnd − vestingStart ∈ [600, 900] s`) `execute()` reverts with `CapWindowActive` (D19). Keeper waits until after `balanceLimitEnd`.

### 6.5 `PlatformFeeReceiver` (singleton, D21)

```solidity
function collect(address asset) external;                 // permissionless: collectFees + forward to treasury
function proposeTreasury(address newTreasury) external;   // admin, 48h delay
function acceptTreasury() external;                       // admin, after delay
function cancelProposal() external;                       // admin
function pendingTreasury() external view returns (address proposed, uint256 executableAt);
function registerAsset(address asset, bytes32 poolId) external; // only RevpadRegistry
function transferAdmin(address newAdmin) external;              // admin, two-step (D22)
function acceptAdmin() external;                                // pendingAdmin only
function cancelAdminTransfer() external;                        // admin
```

- Address is fixed forever as the 30% Doppler beneficiary, Airlock integrator, and RevenueRouter treasury destination.
- `collect(asset)` calls `initializer.collectFees(poolId)`, then forwards ALL USDC and ALL asset-token balances to the current `treasury`.
- Treasury changes use a two-step pattern: `proposeTreasury` sets a 48h timer; `acceptTreasury` applies the change after the delay. This makes treasury changes effective for ALL tokens (old and new) without touching existing contracts.
- Keeper calls `collect()` per asset each tick and monitors `pendingTreasury()` for proposals (Telegram alerts).

### 6.6 `CreatorVesting`

Removed in v0.2. DopplerERC20V1 provides vesting with a cliff natively (§4.5).

### 6.7 Tests (required before any deploy)

- Unit: every function, every revert path.
- Fuzz: split sums equal input; `claimable ≤ min(allowance, accrued)`; forfeit only after 365d; buyback only reduces USDC and burns asset.
- Invariant: no path moves funds to an address other than provider/cost/treasury/burn/creator.
- Fork (Anvil or `forge test --fork-url`, Foundry ≥ 1.8, `--network monad`): launch through the real Doppler scheduled multicurve with the SDK config, `register` accepts it; a token with any wrong parameter is rejected; FeeEscrow/BuybackVault `collect` receive their shares; buyback via `PoolManager.unlock` + burn; gas per call.

## 7. Launch flow

1. Creator connects (Privy: X/email login + embedded wallet, or external wallet).
2. Fills: name, symbol, image, description, links. Optional: attach a service now (§8).
3. Frontend shows fixed economics (fee split, supply, vesting, cliff claim date, balance cap) — not editable.
4. Frontend builds the SDK params (§6.1), simulates, shows the MON gas estimate (~0.5 MON), sends with gasLimit = estimate × 1.1. The SDK waits for 2 confirmations.
5. Frontend (or server) calls `RevpadRegistry.register(asset)`. On `Registered`: server creates the token record; if a service was configured, it becomes active with `payTo = router`.
6. Trading opens at the scheduled start time with the 1%-per-wallet balance cap active for ~12 minutes.

## 8. Service attach flow

A token has at most one active service in v1.

### 8.1 BYO API
Fields: upstream base URL, route(s), HTTP method, price per call (USDC), request/response JSON schema, health path, description, category, tags.
- Server generates `upstreamSecret`; gateway signs forwarded requests with HMAC header `X-Revpad-Signature` (timestamp + body hash). Provider is encouraged to reject unsigned calls.
- Public URL: `https://gw.revpad.xyz/s/{slug}/{route}` (domain TBD).

### 8.2 Hosted Prompt template (§10)
Fields: system prompt, model (allowlist), max input/output tokens, price, description. Revpad hosts and runs it.

Changing price or upstream: creator-only, logged, visible on token page history.

---

## 9. Gateway (`apps/server`, route group `/s/*`)

### 9.1 Request lifecycle
1. Agent calls `/s/{slug}/{route}` without payment → respond **402** with payment requirements: scheme `exact`, network Monad (`eip155:143`), asset USDC, amount = price, `payTo` = service's RevenueRouter, `extra: { name: "USDC", version: "2" }` (on-chain EIP-712 domain; `"USD Coin"` breaks signatures), resource description + schema. Use `@x402/*` SDK types/middleware; do not hardcode header names.
2. Agent retries with payment payload → gateway calls facilitator **verify**.
3. Verified → forward to upstream with HMAC signature, timeout (default 20s, configurable per service ≤ 60s).
4. Upstream 2xx and response passes schema check → facilitator **settle** → return upstream body + settlement response.
5. Upstream non-2xx / timeout / schema fail → return error, **do not settle**.
6. Log every request (§9.3).

Risk: settle can fail after the upstream already did work (expired or insufficient authorization). Mitigate with verify immediately before forwarding and short validity windows; log `settle_failed` and rate-limit payers with repeated failures.

### 9.2 Facilitator

- Primary: Monad official facilitator `https://x402-facilitator.molandak.org` (x402 v2 only). Verified on real Monad: `/supported` lists `exact` on `eip155:143`; verify + settle succeeded (tx `0x6e7e1d…609a40`); replay rejected.
- **Always use the SDK `HTTPFacilitatorClient`** (`@x402/core/http`). A hand-written request without the v2 wire format returned `unsupported_scheme`. Send `paymentPayload.accepted` as the requirements.
- `x402.org/facilitator` does **not** support Monad mainnet.
- Single point of failure → fallback: self-hosted facilitator using `@x402/evm` `registerExactEvmScheme` (proven on the fork). Cost if self-hosted: ~136K gas per settle (~0.015 MON at ~100 gwei with the 1.1 buffer).
- Store the URL in config. Maintain the list of facilitator submitter addresses used for clean-revenue detection (O8, §13).

### 9.3 Logging (Postgres `gateway_requests`)
`id, service_id, asset, payer, amount_usdc, status_code, upstream_status, latency_ms, verified, settled, settle_tx_hash, error_code, request_bytes, response_bytes, created_at`

### 9.4 Health probes
Every 5 min per service: signed request to `health_path` (free, internal). Store `service_probes(service_id, ok, latency_ms, status, checked_at)`. Uptime = successful probes ÷ total over window.

### 9.5 Abuse controls
Per-payer and per-IP rate limits; max request body size; upstream response size cap; block private-network upstream URLs (SSRF: resolve DNS, reject RFC1918/loopback/link-local).

---

## 10. Hosted Prompt template

- Runtime inside `apps/server`, calls LiteLLM with the creator's system prompt + user input.
- Model allowlist with per-model cost table (USD per 1K in/out tokens).
- `estCost = maxIn × inPrice + maxOut × outPrice`. Enforce `price ≥ 2 × estCost`.
- Router `costBps = ceil(estCost / price × 10000)`, hard cap 3000; cost recipient = Revpad treasury.
- Input schema fixed: `{ "input": string }`; output `{ "output": string }`.
- Never return the system prompt; strip it from errors. Apply max token caps server-side.

---

## 11. Indexer (`packages/indexer`, Envio HyperIndex)

Entities (minimum):
- `Asset` (address, creator, router, pool, launchedAt, provider)
- `RevenuePayment` from USDC `Transfer(to ∈ routers)`: txHash, from (payer), amount, block, `txFrom` (to detect facilitator-submitted), timestamp
- `Distribution` (router `Distributed` events)
- `EscrowAccrual`, `EscrowClaim`, `EscrowForfeit`
- `Buyback` (usdcIn, tokensBurned, sourceTag)
- `VestingRelease`

Market data (price, mcap, volume, holders): use Doppler's public indexer API if it supports Monad; otherwise index pool `Swap` events. Still to verify (not covered by the fork tests).

---

## 12. Server API (`apps/server`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tokens?sort=clean_revenue_30d&tab=revenue\|new` | Explore list |
| GET | `/api/tokens/:asset` | Aggregated token + service + metrics |
| GET | `/api/tokens/:asset/payments` | Recent payments feed |
| GET | `/api/tokens/:asset/health` | Uptime, latency, recent probes |
| POST | `/api/services` | Attach BYO service (creator auth) |
| POST | `/api/services/prompt` | Create hosted prompt service (creator auth) |
| PATCH | `/api/services/:id` | Update price/upstream (creator auth, logged) |
| GET | `/api/explorer` | All Revpad x402 services on Monad + totals |
| GET | `/api/services/:slug/manifest` | Machine-readable service description for agents |
| GET | `/api/creator/me` | Creator dashboard data |

Auth: Privy JWT; creator identity = wallet that called `launch`.

---

## 13. Metrics & wash scoring (display only)

Clean payment = all of:
- settlement tx submitted by an allowlisted facilitator address (list maintained from observed settlements and facilitator info; the facilitator may use several or rotating addresses — alert on settlements to routers from unknown submitters), and
- matches a `gateway_requests` row with `settled = true`, and
- payer not funded directly by creator/provider addresses within 30 days (v1: 1 hop; v2: 2 hops).

Payer weight `w = min(1, distinctServicesPaid / 3) × ageFactor` where `ageFactor = 0.5` if wallet's first on-chain activity < 7 days ago, else 1.
`cleanRevenue = Σ amount × w`.

Per token (24h / 7d / 30d): clean revenue, raw revenue, clean payers, repeat-payer rate, top-payer share, calls, success rate, p95 latency, uptime, last successful call, buyback by source.

**UCR** = `(0.30 × cleanRevenue30d) / (0.002 × volume30d)`. UCR ≥ 1 means revenue-funded buyback ≥ trading-funded buyback. Equivalent: clean revenue ≥ volume / 150.

Alerts on token page: uptime < 95% (7d), clean revenue −50% WoW, top-payer share > 50%.

Verified badge: thresholds in O5, recomputed daily.

---

## 14. Frontend (`apps/web`)

### 14.1 Pages
| Route | Content |
|---|---|
| `/` Explore | Default tab "With revenue": sorted by clean revenue 30d. Columns: token, service, clean revenue 30d, UCR, uptime, clean payers, mcap, volume 24h. Tab "New": newest launches. |
| `/launch` | Launch form (§7), fixed economics panel, gas estimate, optional service attach |
| `/t/:asset` | Hero: UCR + clean revenue. Trade panel (fee 2% disclosed). Price chart. Sections: Service (URL, price, schema, try-it that pays via connected wallet), Health, Payments, Buyback (by source), Creator (escrow claimable/claimed/forfeit date, vesting schedule), Holders |
| `/t/:asset/service` | Attach/edit service (creator only): BYO or Prompt template |
| `/creator` | My tokens; claim liquid fees (Doppler), claim escrow, release vesting; service logs; provider address |
| `/explorer` | All Revpad x402 services on Monad: calls, revenue, payers, recent payments |
| `/docs` | How fees, escrow, buyback, and the gateway work |

Trading (user wallets): Uniswap v4 Universal Router `V4_SWAP` with Permit2 approval (encoding verified on the fork in test 03); quotes via the v4 Quoter. Always show fee and min-received.

### 14.2 Design direction

UI is **not decided**: the first mockup was set aside and Tun is sourcing a different UI. Keep only these product rules until a new design is chosen:
- Make usage vs hype legible on every screen; usage-backed and trading-backed values always use two fixed, distinct colors.
- Token page leads with usage (clean revenue, UCR), not the price chart.
- Always disclose the 2% fee, min-received, MON gas estimate, balance-cap window, and the creator's cliff claim date.

## 15. Keeper (`apps/keeper`)

Default poll interval: **10 minutes** (`POLL_INTERVAL_S=600`). Minimum on non-localhost RPC: **5 minutes**.

### Job order per asset (by usefulness — high-value first)

1. `RevenueRouter.distribute()` — if router USDC balance ≥ `MIN_DISTRIBUTE_USDC` (default 1 USDC).
2. `BuybackVault.execute(asset, …)` — if vault USDC balance ≥ `MIN_BUYBACK_USDC` (default 1 USDC), cap window ended, and cooldown elapsed.
3. `FeeEscrow.collect(asset)`, `BuybackVault.collect(asset)`, `PlatformFeeReceiver.collect(asset)` — each gated by:
   - **Pending fee pre-check:** simulates `initializer.collectFees(poolId)` via `eth_call` from the beneficiary's address. Skips if pending USDC < `MIN_COLLECT_USDC` (default 1 USDC).
   - **Cadence:** at most once per `COLLECT_INTERVAL_S` (default 6 hours) per beneficiary per asset.
4. `FeeEscrow.forfeit(asset)` when due (365 days).

Distribute and buyback run before collect so a spend-guard block from expensive collects never prevents useful work.

### Economic thresholds

All are keeper-side gas-saving thresholds, independent of on-chain contract minimums (e.g. `RevenueRouter.MIN_DISTRIBUTE = 0.5 USDC`). Origin: each collect/distribute costs ~0.1 MON ≈ $0.03 at 100 gwei; 1 USDC ≈ 33× the gas cost, so the threshold ensures txs are economically justified.

| Env var | Default | Purpose |
|---------|---------|---------|
| `MIN_COLLECT_USDC` | 1 | Skip collect if pending USDC for that beneficiary < this |
| `MIN_DISTRIBUTE_USDC` | 1 | Skip distribute if router USDC balance < this |
| `MIN_BUYBACK_USDC` | 1 | Skip buyback if vault USDC balance < this |
| `COLLECT_INTERVAL_S` | 21600 (6h) | Min seconds between collects per beneficiary per asset |

### Spend guards

| Env var | Default | Purpose |
|---------|---------|---------|
| `MAX_MON_PER_DAY` | 0.2 | Maximum MON spend in rolling 24h window |
| `MIN_MON_BALANCE` | 0.2 | Minimum wallet balance; keeper stops if below |
| `SINGLE_TX_ALERT` | 0.05 | Telegram warning if single tx costs more |

### Dry-run mode

`--dry-run` or `DRY_RUN=true`: estimates gas for every job, logs SEND/SKIP per job with pending amounts and reasons, sends zero transactions. Required before first mainnet run.

After all per-asset jobs: monitor `PlatformFeeReceiver.pendingTreasury()` and `pendingAdmin()` on both RevpadRegistry and PlatformFeeReceiver; send Telegram alert if a treasury change proposal or admin transfer is detected or resolved (D22).

Explicit gas limits on every tx (`estimate × 1.1`; Monad bills the gas limit). Keeper wallet funded with MON; Telegram alert when low. All functions are permissionless, so anyone can run a keeper.

---

## 16. Security & compliance

- Admin powers: pause new launches, set hosted `costBps` (capped), transfer admin (two-step, D22). Treasury changes via PlatformFeeReceiver (48h delay, D21). Nothing else. Admin = multisig on mainnet.
- Reentrancy guards on all external-transfer functions; checks-effects-interactions.
- SSRF protection in gateway (§9.5). Secrets only in env; never log payment payloads in full.
- Copy rules: use "usage-backed", "buyback", "revenue share to the pool". Never "profit", "dividend", "investment return", "yield" for tokens. Footer disclaimer: tokens are not investment products.
- Buyback + revenue linkage can be read as securities-like; get legal review before mainnet marketing.

---

## 17. Verification status

### Done (evidence in docs/VERIFICATION-anvil.md, docs/VERIFICATION-real.md)
| Item | Result |
|---|---|
| Doppler modules on Monad | Airlock, DopplerERC20V1 factory, scheduled multicurve, NoOp migrator/governance, PoolManager, Universal Router, Permit2 deployed. No standard/decay multicurve. |
| 2% fee + tick spacing 200 on scheduled multicurve | Works; fees exactly 2.000% both currencies |
| Beneficiary split 5/35/20/10/30 | Exact; each beneficiary must call `collectFees` itself |
| Vesting 30d cliff / 365d | Works; accrues from launch, cliff gates claim |
| Per-wallet balance cap | Works (revert inside window, success after) |
| Supply accounting | 1e9, creator 0 at launch, nothing to timelock |
| USDC | `0x7547…b603`, name "USDC", version "2", 6 decimals, EIP-3009 |
| x402 on fork (local facilitator) | verify/settle/replay/tamper all correct. Note: Anvil mnemonic accounts 0–6, 9 carry ERC-7702 delegation code from Monad mainnet fork — must clear with `anvil_setCode` before signing EIP-3009 messages (otherwise facilitator takes ERC-1271 path and fails). Accounts 7, 8 are clean EOAs. |
| x402 on real Monad (official facilitator) | verify + settle OK, replay rejected |
| Launch gas on real Monad | 4,589,375 (~0.52 MON); fork within 0.9% |

| RevpadRegistry reads all §6.1 fields from chain | ✅ 17/17 fork tests pass. DOPPLER_HOOK constant confirmed. Integrator == treasury confirmed. totalAllocatedOf + vestedTotalAmount confirmed 150M each. balanceLimitEnd − vestingStart window 696 s on Anvil fork (within [600, 900]). |

### Still to verify
- [ ] DopplerERC20V1 `burn` semantics (caller's own balance).
- [ ] Contract-driven collect + buyback via `PoolManager.unlock` + burn on the fork.
- [ ] EIP-7702-delegated payer through the official facilitator (O9).
- [x] Full facilitator submitter address(es) recorded (O8). Locked 2026-09-24.
- [ ] Rehype hook (O2) — deferred.

## 18. Milestones

| Window | Deliverables |
|---|---|
| 22–23 Sep | ✅ Anvil-fork + real-Monad verification; SPEC v0.2; all contracts done with 93 tests (78 unit + 15 fork); Fix 1-3 + integrator check; SPEC v0.3 |
| 23 Sep (cont.) | ✅ Backend running end-to-end on Anvil fork: server (Hono + Postgres + x402 gateway) + keeper all functional. E2E test suite 17/17 PASS (A–J: registry, service register, 402, paid call + settlement, replay reject, upstream-fail → 502 + no charge, distribute, escrow claimable, buyback execute, burn). Keeper ran collect/distribute/buyback with real tx hashes. Two fork environment fixes documented: (1) ERC-7702 delegation on Anvil mnemonic accounts requires `anvil_setCode` clearance; (2) USDC EIP-712 domain name is `"USDC"` not `"USD Coin"` (CLAUDE.md rule 14). |
| 24–30 Sep | Envio indexer; deploy to mainnet with a fresh admin key and small amounts; one full real flow |
| 1–5 Oct | Deploy to mainnet; one full real flow with official facilitator |
| 6–12 Oct | Web app (new UI), hosted Prompt template, wash scoring + UCR, 2–3 demo services, demo agent, video |
| 13 Oct | Submission |

## 19. Demo script

1. Launch a token for the nullsight service (show gas estimate, fixed economics).
2. Run a demo agent that makes paid calls through the gateway (show 402 → pay → response).
3. Keeper distributes: provider receives 60%, escrow allowance increases, buyback executes and burns.
4. Token page: clean revenue, UCR, health, buyback by source, creator escrow unlocking.
5. Wash attempt: creator self-pays 100 USDC → dashboard shows net loss ≈ 20 USDC and buyback to holders.
6. Explorer view: all x402 services on Monad through Revpad.

---

## 20. Kill criteria (post-mainnet)

- 2 months: ≥1 token with UCR ≥ 1 over 30 days.
- 6 months: ≥3 tokens with UCR ≥ 1 over 30 consecutive days, each with ≥20 clean payers.
- If not met: stop the launchpad; keep gateway + explorer as Monad x402 infrastructure.

---

## 21. Out of scope (v1) / roadmap

- Revenue-anchored start price (removed; would need pre-launch revenue).
- Escrow paying infra providers directly.
- Paying for services with the asset token (discount + split 60/30/10 in token).
- Staking for access (free quota / rate limit).
- Index token of top services.
- Arbitrary code hosting (serverless handlers).
- MCP / agent directory server.
- Launch from X via existing Chrome extension.
- Custom v4 hook: route anti-snipe tax fully to buyback; exempt BuybackVault from pool fee.
- Anchoring gateway log hashes on-chain.
- **Multi-asset quote pairs** (O10): allow tokens to trade against forex stablecoins (EURC, then tokenised stocks) as the quote currency, with the same fee split. Prerequisites: (1) quote-token allowlist in RevpadRegistry (admin-curated, verified liquid USDC pool); (2) two-hop buyback USDC → quote → token via PoolManager; (3) escrow conversion: collect token-denominated fees in quote currency, convert to USDC for escrow accounting; (4) USD price source at launch time for displaying start-price in USD regardless of quote; (5) quote-pool oracle for UCR denominator. Estimated 7–12 working days once a liquid quote token exists on Monad. Not blocked on any contract change to the USDC path.

---

### Open (continued)

| # | Question | Current default |
|---|---|---|
| O10 | Multi-asset quote pairs | EURC not yet on Monad (2026-09). Deferred to post-v1. See §21 for full scope. |
| O11 | Keeper and server availability SLA | Single-instance, no HA. Acceptable for hackathon; mainnet requires dual-region deployment or a decentralised keeper network. Evaluate before mainnet launch. |

---

## 22. References

- Doppler docs (fees, multicurve, lockable beneficiaries): https://docs.doppler.lol
- Doppler contracts (Airlock fee handling, excess tokens to timelock): https://github.com/whetstoneresearch/doppler
- Doppler SDK: `@whetstone-research/doppler-sdk` 1.0.43
- x402 SDK: `@x402/core`, `@x402/evm` 2.26.0
- Monad x402 guide and facilitator: https://docs.monad.xyz/guides/x402 · https://docs.monad.xyz/tooling-and-infra/agentic-payments
- Monad gas pricing (gas limit billing): https://docs.monad.xyz/developer-essentials/gas-pricing
- Foundry with Monad execution (≥ 1.8, `--network monad`): https://docs.monad.xyz/tooling-and-infra/toolkits/foundry

---

## 23. Verified addresses (Monad mainnet, chainId 143)

Copy into `packages/shared/src/addresses.ts` with these sources.

| Contract | Address | Source |
|---|---|---|
| Doppler Airlock | `0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12` | SDK 1.0.43, code verified on fork |
| Airlock owner (Doppler 5% beneficiary) | `0x21E2ce70511e4FE542a97708e89520471DAa7A66` | `getAirlockOwner`, fork |
| DopplerERC20V1 factory | `0xf1542Dd2D46394C16372FB00f2c339b53CeF2cE5` | SDK, fork |
| V4ScheduledMulticurveInitializer | `0xCe3099B2F07029b086E5e92a1573C5f5A3071783` | SDK, fork |
| Doppler multicurve hook (DOPPLER_HOOK) | `0x580ca49389d83b019d07E17e99454f2F218e2dc0` | fork: INITIALIZER.getState(asset).poolKey.hooks, constant across all launches (D16) |
| NoOpMigrator | `0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731` | SDK, fork |
| NoOpGovernanceFactory | `0xb4deE32EB70A5E55f3D2d861F49Fb3D79f7a14d9` | SDK, fork |
| Uniswap v4 PoolManager | `0x188d586ddcf52439676ca21a244753fa19f9ea8e` | SDK, fork |
| Universal Router (wallets only) | `0x0d97dc33264bfc1c226207428a79b26757fb9dc3` | SDK, fork |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | SDK, fork |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | canonical; required by SDK `getPendingFees` |
| USDC | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | x402 SDK default assets; on-chain name "USDC", version "2" |
| DopplerHookInitializer (unused in v1) | `0x56ea13Da5f39863D3B3d54826187306Af7ada544` | SDK, fork |
| Rehype hook (O2, not verified) | `0xe2AEbc987592593b667ec29178D0A83929Db78b6` | SDK only |
| x402 facilitator | `https://x402-facilitator.molandak.org` | Monad docs; verified on real Monad |
| Facilitator submitter (observed) | `0x7f6a2850669202519f0FE8aa912451238820Db86` | settle tx `0x6e7e1dc75f884a4891a025837738f133bbb4bea01189c23e923c647f0b609a40` |
