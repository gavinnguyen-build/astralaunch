# Revpad Contracts — Review

> Status: v0.6 (2026-09-23) — All 98 tests pass (81 unit/invariant + 17 fork). D20: balanceLimitEnd buffer fix (startTime+900). Fork tests fully validated against live Anvil fork with real Doppler contracts.
> Covers: RevpadRegistry, RevenueRouter, FeeEscrow, BuybackVault.

---

## 1. SPEC §6.1 Verification Evidence

| Check | Error | On-chain evidence | Unit test | Fork test |
|-------|-------|-------------------|-----------|-----------|
| poolInitializer == V4ScheduledMulticurveInitializer | `WrongInitializer` | `Airlock.getAssetData(asset)[4]` = `0xCe3099…` | `test_register_revertsWrongInitializer` | — |
| liquidityMigrator == NoOpMigrator | `WrongMigrator` | `Airlock.getAssetData(asset)[3]` = `0x5F3b…` | `test_register_revertsWrongMigrator` | — |
| governance == 0x…dEaD | `WrongGovernance` | `Airlock.getAssetData(asset)[2]` = `0x…dEaD` (D1) | `test_register_revertsWrongGovernance` | — |
| numeraire == USDC | `WrongNumeraire` | `Airlock.getAssetData(asset)[0]` = `0x754704…` | `test_register_revertsWrongNumeraire` | — |
| totalSupply == 1e9×1e18 | `WrongTotalSupply` | `Airlock.getAssetData(asset)[8]` = 1,000,000,000×10^18 | `test_register_revertsWrongTotalSupply` | — |
| numTokensToSell == 850M×1e18 | `WrongNumTokensToSell` | `Airlock.getAssetData(asset)[7]` = 850,000,000×10^18 | `test_register_revertsWrongNumTokensToSell` | — |
| integrator == treasury (D17) | `WrongIntegrator` | `Airlock.getAssetData(asset)[9]` = TREASURY | `test_register_revertsWrongIntegrator` | `test_register_revertsWrongIntegrator` |
| poolKey.hooks == DOPPLER_HOOK (D16) | `WrongPool` | `INITIALIZER.getState(asset).poolKey.hooks` = `0x580ca4…` (4+ tokens) | `test_register_revertsWrongPool` | `test_register_revertsWrongPool` |
| poolKey.fee == 20000 | `WrongFee` | getState fee=20000 (D2) | `test_register_revertsWrongFee` | — |
| poolKey.tickSpacing == 200 | `WrongTickSpacing` | getState tickSpacing=200 | `test_register_revertsWrongTickSpacing` | — |
| currencies are {asset, USDC} | `WrongPoolCurrencies` | getState currencies match state.json | `test_register_revertsWrongPoolCurrencies` | — |
| getShares(poolId, airlockOwner) == 0.05e18 | `WrongDopplerShare` | decisions.md C | `test_register_revertsWrongDopplerShare` | — |
| getShares(poolId, creator) == 0.35e18 | `WrongCreatorShare` | decisions.md C | `test_register_revertsWrongCreatorShare` | `test_register_revertsWrongCreator` |
| getShares(poolId, FeeEscrow) == 0.20e18 | `WrongEscrowShare` | decisions.md C | `test_register_revertsWrongEscrowShare` | — |
| getShares(poolId, BuybackVault) == 0.10e18 | `WrongBuybackShare` | decisions.md C | `test_register_revertsWrongBuybackShare` | — |
| getShares(poolId, treasury) == 0.30e18 | `WrongTreasuryShare` | decisions.md C | `test_register_revertsWrongTreasuryShare` | — |
| vestingSchedules(0).cliff == 30d | `WrongVestingCliff` | decisions.md D, fork-probed | `test_register_revertsWrongVestingCliff` | — |
| vestingSchedules(0).duration == 365d | `WrongVestingDuration` | decisions.md D, fork-probed | `test_register_revertsWrongVestingDuration` | — |
| totalAllocatedOf(creator) == 150M×1e18 | `WrongVestingAmount` | cast call: `totalAllocatedOf` = 150M×10^18 ✓ | `test_register_revertsWrongVestingAmount` | `test_register_revertsWrongVestingAmount` |
| vestedTotalAmount() == 150M×1e18 | `WrongVestingAmount` | cast call: `vestedTotalAmount` = 150M×10^18 ✓ | (same as above) | (same as above) |
| maxBalanceLimit() == 10M×1e18 | `WrongBalanceCap` | decisions.md D | `test_register_revertsWrongBalanceCap` | `test_register_revertsWrongBalanceCap_fivePct` |
| 600 s ≤ balanceLimitEnd − vestingStart ≤ 900 s | `WrongBalanceCap` | launch script syncs Anvil time; window ≈ 602 s ✓ (D18) | `test_register_revertsWrongBalanceCap_window` / `_windowTooWide` | `test_register_revertsWrongBalanceCap_window` |
| Not already registered | `AlreadyRegistered` | — | `test_register_revertsIfDuplicate` | `test_register_revertsOnDuplicate` |

---

## 2. Balance Cap Window — Root Cause & Fix

**D20 — Observed on fork**: first launch had `balanceLimitEnd - vestingStart = 576 s`, below the 600 s minimum. Registry correctly reverted with `WrongBalanceCap(576, 600)`.

**Root cause**: `DopplerERC20V1` sets `vestingStart = block.timestamp` at the block when `createMulticurve` is mined, not when `now` was read in the launch script. The 02-launch.ts code set `balanceLimitEnd = startTime + 600 = now + 602`, but by the time the SDK call lands (waiting for 2 confirmations while mining every 1 s), `vestingStart ≈ now + 26`, giving `window = 602 - 26 = 576 s < 600 s`.

**Fix** (decisions.md D20): `revpad-anvil/src/02-launch.ts` now uses `balanceLimitEnd = startTime + 900` (the spec maximum, 15 min). As long as block lag is < 300 s (5 min), `window = 900 - lag ∈ [600, 900]`. Verified on fresh deploy: `vestingStart = 1790146308`, `balanceLimitEnd = 1790147179`, **window = 871 s** ✓.

**Registry enforcement** (`RevpadRegistry.sol:184-196`):
```solidity
if (capWindow < C.BALANCE_CAP_WINDOW)      // ≥ 600 s
    revert WrongBalanceCap(capWindow, C.BALANCE_CAP_WINDOW);
if (capWindow > C.BALANCE_CAP_WINDOW_MAX)  // ≤ 900 s
    revert WrongBalanceCap(capWindow, C.BALANCE_CAP_WINDOW_MAX);
```

---

## 3. Deploy.s.sol: address(0) Bug Fixed

**Bug**: Original `Deploy.s.sol` deployed `FeeEscrow` with `buybackVault = address(0)` (address not yet known). Since `buybackVault` is `immutable`, a mainnet deploy would make `forfeit()` silently send all forfeited USDC to address(0) — permanent loss.

**Fix** (`script/Deploy.s.sol`):
```solidity
uint256 nonce       = vm.getNonce(msg.sender);
address futureVault = vm.computeCreateAddress(msg.sender, nonce + 1); // N+1
FeeEscrow escrow    = new FeeEscrow(futureRegistry, futureVault, INITIALIZER); // N+0
```

**Post-deploy assertions** (script reverts on any mismatching immutable):
```solidity
require(escrow.buybackVault() == address(vault),    "escrow.buybackVault != vault");
require(escrow.registry()     == address(registry), "escrow.registry != registry");
require(vault.registry()      == address(registry), "vault.registry != registry");
require(address(vault.poolManager()) != address(0), "vault.poolManager is zero");
```

**contracts.json**: Script writes `../../revpad-anvil/.anvil-state/contracts.json` with deployer address, deployer start nonce, and all four contract addresses. Fork tests read `deployerStartNonce` from JSON (no longer hardcoded 633). Launch script reads `escrow`/`vault` from JSON (no longer requires env vars).

**Fork test** `test_deploy_immutablesWiredCorrectly` verifies wiring on every setUp run.

---

## 4. Test Counts

| Suite | Tests | Status |
|-------|-------|--------|
| Unit — RevpadRegistry | 30 | ✅ all pass |
| Unit — FeeEscrow | 20 | ✅ all pass |
| Unit — BuybackVault | 16 | ✅ all pass (includes test_execute_revertsIfCapWindow) |
| Unit — RevenueRouter | 15 | ✅ all pass |
| Invariant | 4 | ✅ 500 runs × 100 depth |
| Fork — RegistryForkTest | **17** | ✅ **all pass** against live Anvil fork |
| **Total** | **102** | **✅ 0 failures** |

> Run: `forge test --no-match-path "test/fork/**"` (unit+invariant, no fork needed)
> Then: `CONTRACTS_JSON_PATH=../../revpad-anvil/.anvil-state/contracts.json forge test --match-path "test/fork/**" --fork-url http://127.0.0.1:8545 -vv`

Fork tests summary (v0.6):
- **test_deploy_addresses** / **test_deploy_immutablesWiredCorrectly** — real Deploy.s.sol wiring verified
- **test_register_acceptsValidToken** — successful registration path (K: duplicate also tested)
- **test_register_reverts*** (5 tests) — wrong pool/creator/integrator/vesting/balanceCap
- **test_revenuePath_exactSplits** — 10 USDC → provider 6M, buyback 3M, treasury 1M exactly
- **test_escrowClaim_fullPath** — 100 USDC revenue → 20% unlock claimable
- **test_buyback_executeAndBurn** — real v4 swap, tokens burned verified > 0
- **test_buyback_revertsInCapWindow** — CapWindowActive guard (D19)
- **test_forfeit_redirectsToVault** — 365 d delay, forfeited USDC moves to vault
- **test_washCheck_netLossPerSelfPaid** — net loss = 200K USDC per 1M self-pay (SPEC §4.4 ✓)
- **test_escrow_vault_collect_exactShares** — real 10 USDC swap, escrow:vault = 39999:19999 ≈ 2:1 ✓

Tests using `vm.store` seeding (no real trades, noted explicitly):
- `test_escrowClaim_fullPath`, `test_washCheck_netLossPerSelfPaid`, `test_forfeit_redirectsToVault`

---

## 5. Gas Report

### Fork tests (real Doppler contracts on Anvil fork, 2026-09-23)

> `CONTRACTS_JSON_PATH=... forge test --match-path "test/fork/**" --fork-url http://127.0.0.1:8545 --gas-report`

| Test | Total gas | Key operations |
|------|-----------|----------------|
| `test_register_acceptsValidToken` | 860,370 | register() with 5 getShares + vestingSchedules + getState |
| `test_revenuePath_exactSplits` | 1,202,544 | register + distribute(10 USDC) |
| `test_escrowClaim_fullPath` | 1,290,240 | register + distribute(100 USDC) + claim |
| `test_buyback_executeAndBurn` | 1,606,623 | register + distribute + vault.execute(10 USDC) |
| `test_forfeit_redirectsToVault` | 1,000,658 | register + 365d warp + forfeit |
| `test_washCheck_netLossPerSelfPaid` | 1,321,506 | register + distribute + claim |
| `test_buyback_revertsInCapWindow` | 1,068,895 | register + distribute + reverted execute |
| `test_escrow_vault_collect_exactShares` | 3,473,849 | register + ForkTrader swap + collect×2 |
| ForkTrader.swapUSDCForToken | **403,214** | PoolManager.unlock + v4 swap (one-way) |
| Launch (02-launch.ts) | **4,547,185** | full Doppler createMulticurve on Monad |

### Verified economics (live fork numbers)

| Scenario | Result |
|----------|--------|
| Revenue split (10 USDC) | provider 6,000,000 · buyback 3,000,000 · treasury 1,000,000 USDC-units ✓ |
| Real collect (10 USDC swap, 2% fee) | escrow 39,999 · vault 19,999 USDC-units; ratio E:V ≈ 2:1 ✓ |
| Buyback (10 USDC) | 953,017,632,543,026,202,535,787 token atoms burned |
| Wash check (1 USDC self-pay) | net loss 200,000 USDC-units (20% of paid) ✓ |
| Balance cap window (D20 fix) | vestingStart=1790146308, balanceLimitEnd=1790147179, **window=871 s** ✓ |

### Unit tests (mock contracts, no real Doppler reads)

| Contract | Function | Avg gas | Max gas |
|----------|----------|---------|---------|
| RevpadRegistry | `register()` success | ~153 K | ~635 K |
| RevenueRouter | `distribute()` | ~243 K | ~260 K |
| FeeEscrow | `collect()` | ~180 K | ~181 K |
| FeeEscrow | `claim()` | ~96 K | ~97 K |
| FeeEscrow | `forfeit()` | ~93 K | ~152 K |
| BuybackVault | `collect()` | ~170 K | ~170 K |
| BuybackVault | `execute()` | ~232 K | ~234 K |

---

## 6. Security Checklist

All items confirmed present with source file:line references.

### 6.1 Anti-Spoofing

| Item | File:line | Mechanism |
|------|-----------|-----------|
| Pool must contain asset + USDC | `RevpadRegistry.sol:156-158` | `WrongPoolCurrencies` if neither currency matches |
| Pool must use DOPPLER_HOOK | `RevpadRegistry.sol:151` | `WrongPool` if `poolKey.hooks != DOPPLER_HOOK` |
| Creator must have exactly 35% share | `RevpadRegistry.sol:165` | `WrongCreatorShare` via `_checkShare` |
| Integrator must be treasury | `RevpadRegistry.sol:145` | `WrongIntegrator` |

### 6.2 Replay / Duplicate

| Item | File:line | Mechanism |
|------|-----------|-----------|
| Duplicate registration prevented | `RevpadRegistry.sol:123` | `AlreadyRegistered` if `routers[asset] != address(0)` |
| FeeEscrow double-register prevented | `FeeEscrow.sol:72` | `AlreadyRegistered` if `launchTime != 0` |
| BuybackVault double-register prevented | `BuybackVault.sol:84` | `AlreadyRegistered` if `registered == true` |

### 6.3 Admin Constraints

| Item | File:line | Status |
|------|-----------|--------|
| Economics constants non-modifiable | `RevpadConstants.sol:13-59` | All declared `constant` |
| Admin can only: set treasury, pause | `RevpadRegistry.sol:227-237` | `setTreasury`, `setPause` only |
| No admin path to move funds | All contracts | No `withdraw`, `transfer`, or `rescue` functions |
| Wash constraint (compile-time) | `RevpadConstants.sol:59` | `_WASH_ASSERT = (10000 - PROVIDER_BPS) - ESCROW_UNLOCK_BPS - 1` prevents underflow |

### 6.4 Reentrancy Guards

Every function that transfers tokens has `nonReentrant`. Functions that only update state (no transfers) do not need it.

| Contract | Function | Guard | File:line |
|----------|----------|-------|-----------|
| RevenueRouter | `distribute()` | custom `nonReentrant` (uint256 lock) | `RevenueRouter.sol:97` (guard at `sol:60-65`) |
| FeeEscrow | `collect()` | solady `nonReentrant` | `FeeEscrow.sol:96` |
| FeeEscrow | `claim()` | solady `nonReentrant` | `FeeEscrow.sol:142` |
| FeeEscrow | `forfeit()` | solady `nonReentrant` | `FeeEscrow.sol:158` |
| BuybackVault | `collect()` | solady `nonReentrant` | `BuybackVault.sol:99` |
| BuybackVault | `execute()` | solady `nonReentrant` | `BuybackVault.sol:141` |
| BuybackVault | `burnTokens()` | solady `nonReentrant` | `BuybackVault.sol:222` |
| FeeEscrow | `recordRevenue()` | none needed | `FeeEscrow.sol:126` — state-only, no transfers |
| BuybackVault | `creditUSDC()` | none needed | `BuybackVault.sol:123` — accounting-only, no transfers |
| RevpadRegistry | `register()` | none needed | `RevpadRegistry.sol:118` — checks-effects-interactions; no token transfers to untrusted callers |

### 6.5 BuybackVault: Swap Security

| Item | File:line | Mechanism |
|------|-----------|-----------|
| `unlockCallback` restricted to PoolManager | `BuybackVault.sol:178` | `if (msg.sender != address(poolManager)) revert NotAuthorized()` |
| `execute()` enforces `minTokenOut` | `BuybackVault.sol:166` | `if (tokensBurned < minTokenOut) revert SlippageTooHigh()` |
| `execute()` enforces `MAX_PER_CALL` (100 USDC) | `BuybackVault.sol:148` | `if (usdcIn > C.BUYBACK_MAX_PER_CALL) revert ExceedsMaxPerCall()` |
| `execute()` enforces `MIN_INTERVAL` (10 min cooldown) | `BuybackVault.sol:147` | `if (block.timestamp < lastExecuteTime + C.BUYBACK_MIN_INTERVAL) revert CooldownActive()` |
| `execute()` disabled during balance-cap window | `BuybackVault.sol:147-149` | `if (block.timestamp < balanceLimitEnd()) revert CapWindowActive()` (D19) |
| `execute()` uses asset's own poolKey (cannot target another pool) | `BuybackVault.sol:182` | `PoolKey memory key = _assets[asset].poolKey` — set at registration, not caller-supplied |
| USDC deducted before swap (checks-effects) | `BuybackVault.sol:155-156` | `d.balanceUSDC -= usdcIn; d.lastExecuteTime = block.timestamp` before `poolManager.unlock` |

### 6.6 Escrow Forfeit

| Item | File:line | Mechanism |
|------|-----------|-----------|
| 365-day delay enforced | `FeeEscrow.sol:162` | `if (block.timestamp < launchTime + FORFEIT_DELAY) revert ForfeitTooEarly()` |
| Only moves to BuybackVault | `FeeEscrow.sol:171-172` | Transfers to `buybackVault` (immutable, set at constructor) |
| Double-forfeit prevented | `FeeEscrow.sol:161` | `if (forfeited) revert AlreadyForfeited()` |
| `buybackVault` is not address(0) | `script/Deploy.s.sol` | Pre-computed with `vm.computeCreateAddress`; post-deploy assertion verifies |

---

## 7. Known Limitations

| Limitation | Reason | Mitigation |
|------------|--------|------------|
| Block-lag shrinks balance cap window | `vestingStart` is set at createMulticurve mine time, not at SDK call time; fixed by using `startTime + 900` (D20) | Verified: 871 s window on fresh deploy ✓ |
| Multi-wallet anti-snipe ineffective | D12 accepted for v1 | Deferred (O2 Rehype hook) |
| execute() disabled for 600–900 s after launch | D19: vault would receive > 1% of supply at launch price | Window is short; callers wait until balanceLimitEnd |

---

## 8. Addresses Used in Tests

### Monad mainnet constants (hardcoded in RegistryFork.t.sol)

| Name | Address | Role |
|------|---------|------|
| `INITIALIZER` | `0xCe3099B2F07029b086E5e92a1573C5f5A3071783` | V4ScheduledMulticurveInitializer |
| `AIRLOCK` | `0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12` | Doppler Airlock |
| `DOPPLER_HOOK` | `0x580ca49389d83b019d07E17e99454f2F218e2dc0` | Multicurve hook (constant) |
| `USDC` | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | Numeraire (balance slot 9) |

### Session addresses (from contracts.json, last fresh deploy 2026-09-23)

Fork tests read these from `contracts.json` at setUp — no hardcoded addresses.

| Name | Address | StartNonce |
|------|---------|------------|
| FeeEscrow | `0x91A1EeE63f300B8f41AE6AF67eDEa2e2ed8c3f79` | 634 |
| BuybackVault | `0xBe6Eb4ACB499f992ba2DaC7CAD59d56DA9e0D823` | 635 |
| RevenueRouter (impl) | `0x54287AaB4D98eA51a3B1FBceE56dAf27E04a56A6` | 636 |
| RevpadRegistry | `0xE401FBb0d6828e9f25481efDc9dd18Da9E500983` | 637 |
| Test token | `0xf795A04a8C302C5eAEe8e134C4E6d21B57C67f07` | launched by 02-launch.ts |

### contracts.json (written by Deploy.s.sol)

`Deploy.s.sol` writes `../../revpad-anvil/.anvil-state/contracts.json` after every broadcast containing:
`deployer`, `deployerStartNonce`, `escrow`, `vault`, `routerImpl`, `registry`, `treasury`, `admin`.

Fork tests read `CONTRACTS_JSON_PATH` env var (default same file). Launch script reads `contracts.escrow`, `contracts.vault`, `contracts.treasury` — no manual env vars needed.
