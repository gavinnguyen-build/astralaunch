# Revpad Contracts — Review

> Status: v0.7 (2026-09-23) — 102 tests pass (85 unit/invariant + 17 fork). D20 final: `startTime+720` (12 min target, [600,900] s accepted). Boundary tests at 599/600/900/901. `balanceLimitEnd` mock removed; tests read real chain value (696 s). Fork gas table included.
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

**D20 — Two observed failures**:
1. First launch (Anvil, `startTime + 600`): `window = 576 s < 600 s` → `WrongBalanceCap(576, 600)`.
2. If `startTime + 900` were used on Monad (0.4 s blocks): `vestingStart ≈ now + 1`, `window = 901 s > 900 s` → `WrongBalanceCap(901, 900)`. This would reject every valid Monad mainnet launch.

**Root cause**: `vestingStart = block.timestamp` at `createMulticurve` mine time. On Anvil (1 s blocks + SDK confirmation lag ~26 s), `vestingStart ≈ now + 26`. On Monad (0.4 s blocks), `vestingStart ≈ now + 1`.

**Fix** (decisions.md D20): `balanceLimitEnd = startTime + 720` (12-minute target).
- Monad: `window ≈ 721 s` ✓
- Anvil: `window ≈ 696 s` ✓
Both within [600, 900]. Verified on fresh deploy: `vestingStart = 1790148291`, `balanceLimitEnd = 1790148987`, **window = 696 s** ✓.

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

```
forge test --no-match-path "test/fork/**"
Ran 34 tests for test/unit/RevpadRegistry.t.sol:RevpadRegistryTest
Suite result: ok. 34 passed; 0 failed; 0 skipped
Ran 15 tests for test/unit/BuybackVault.t.sol:BuybackVaultTest
Suite result: ok. 15 passed; 0 failed; 0 skipped
Ran 20 tests for test/unit/FeeEscrow.t.sol:FeeEscrowTest
Suite result: ok. 20 passed; 0 failed; 0 skipped
Ran 15 tests for test/unit/RevenueRouter.t.sol:RevenueRouterTest
Suite result: ok. 15 passed; 0 failed; 0 skipped
Ran 1 test for test/invariant/RevpadInvariants.t.sol:RevpadInvariantsTest
Suite result: ok. 1 passed; 0 failed; 0 skipped
Ran 5 test suites in 6.53s (11.40s CPU time): 85 tests passed, 0 failed, 0 skipped (85 total tests)
```

```
CONTRACTS_JSON_PATH=../../revpad-anvil/.anvil-state/contracts.json \
forge test --match-path "test/fork/**" --fork-url http://127.0.0.1:8545 --gas-report
Ran 17 tests for test/fork/RegistryFork.t.sol:RegistryForkTest
Suite result: ok. 17 passed; 0 failed; 0 skipped; finished in 41.66ms (122.92ms CPU time)
Ran 1 test suite in 47.29ms (41.66ms CPU time): 17 tests passed, 0 failed, 0 skipped (17 total tests)
```

| Suite | Tests | Status |
|-------|-------|--------|
| Unit — RevpadRegistry | 34 | ✅ (includes 4 boundary tests at 599/600/900/901 s) |
| Unit — FeeEscrow | 20 | ✅ |
| Unit — BuybackVault | 15 | ✅ (includes CapWindowActive test) |
| Unit — RevenueRouter | 15 | ✅ |
| Invariant | 1 (4 properties) | ✅ 500 runs × 100 depth |
| Fork — RegistryForkTest | **17** | ✅ real chain value 696 s, no mock |
| **Total** | **102** | **✅ 0 failures** |

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

| Test | Gas |
|------|-----|
| `test_deploy_addresses` | 61,080 |
| `test_deploy_immutablesWiredCorrectly` | 74,670 |
| `test_register_acceptsValidToken` | 861,824 |
| `test_register_revertsOnDuplicate` | 735,745 |
| `test_register_revertsWrongBalanceCap_fivePct` | 208,807 |
| `test_register_revertsWrongBalanceCap_window` | 240,341 |
| `test_register_revertsWrongCreator` | 129,410 |
| `test_register_revertsWrongIntegrator` | 82,310 |
| `test_register_revertsWrongPool` | 102,894 |
| `test_register_revertsWrongVestingAmount` | 197,072 |
| `test_revenuePath_exactSplits` | 1,203,998 |
| `test_escrowClaim_fullPath` | 1,291,694 |
| `test_buyback_executeAndBurn` | 1,611,861 |
| `test_buyback_revertsInCapWindow` | 1,070,349 |
| `test_forfeit_redirectsToVault` | 1,002,112 |
| `test_washCheck_netLossPerSelfPaid` | 1,322,960 |
| `test_escrow_vault_collect_exactShares` | 3,460,289 |
| ForkTrader deployment | 552,868 |
| ForkTrader.swapUSDCForToken | **376,177** |
| Launch (02-launch.ts, gasUsed) | **4,552,981** |

### Verified economics (live fork numbers)

| Scenario | Result |
|----------|--------|
| Revenue split (10 USDC) | provider 6,000,000 · buyback 3,000,000 · treasury 1,000,000 USDC-units ✓ |
| Real collect (10 USDC swap, 2% fee) | escrow 39,999 · vault 19,999 USDC-units; ratio E:V ≈ 2:1 ✓ |
| Buyback (10 USDC) | 953,017,632,543,025,721,665,867 token atoms burned |
| Wash check (1 USDC self-pay) | net loss 200,000 USDC-units (20% of paid) ✓ |
| Balance cap window (D20, target 720 s) | vestingStart=1790148291, balanceLimitEnd=1790148987, **window=696 s** ✓ |

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
| `execute()` disabled for ~12 min after launch | D19: vault would receive > 1% of supply at launch price | Keeper waits until after `balanceLimitEnd` |

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
| FeeEscrow | `0x3C2BafebbB0c8c58f39A976e725cD20D611d01e9` | 630 |
| BuybackVault | `0x5f246ADDCF057E0f778CD422e20e413be70f9a0c` | 631 |
| RevenueRouter (impl) | `0xaD82Ecf79e232B0391C5479C7f632aA1EA701Ed1` | 632 |
| RevpadRegistry | `0x4Dd5336F3C0D70893A7a86c6aEBe9B953E87c891` | 633 |
| Test token | `0x02C829Cf088B20FB501d1a9cef9c9D8C4491604C` | launched by 02-launch.ts (window 696 s) |

### contracts.json (written by Deploy.s.sol)

`Deploy.s.sol` writes `../../revpad-anvil/.anvil-state/contracts.json` after every broadcast containing:
`deployer`, `deployerStartNonce`, `escrow`, `vault`, `routerImpl`, `registry`, `treasury`, `admin`.

Fork tests read `CONTRACTS_JSON_PATH` env var (default same file). Launch script reads `contracts.escrow`, `contracts.vault`, `contracts.treasury` — no manual env vars needed.
