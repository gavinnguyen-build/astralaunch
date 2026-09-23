# Revpad Contracts — Review

> Status: v0.5 (2026-09-23) — Deploy.s.sol fixed (futureVault + assertions + contracts.json); CapWindowActive guard added; fork setUp reads nonce from JSON; ForkTrader + real collect() tests.
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

**Observed on fork**: `balanceLimitEnd - vestingStart = 7199 s` (much more than the expected 600 s).

**Root cause**: `DopplerERC20V1` sets `vestingStart = block.timestamp` at deploy time (= the Anvil fork block's historical timestamp). The launch script previously computed `startTime = Math.max(blockTimestamp, Date.now()/1000) + 2`, and since the historical fork block was ~6600 s behind real time, `balanceLimitEnd = startTime + 600 ≈ Date.now()/1000 + 602` (wall-clock), giving `balanceLimitEnd - vestingStart ≈ 7199 s`.

**Fix**: `revpad-anvil/src/02-launch.ts` now syncs Anvil's block timestamp to real time (`testClient.setNextBlockTimestamp`) before deploying, so `block.timestamp_at_deploy ≈ Date.now()/1000` and `balanceLimitEnd - vestingStart ≈ 602 s`.

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
| Unit — BuybackVault | 15 | ✅ all pass (added test_execute_revertsIfCapWindow) |
| Unit — RevenueRouter | 15 | ✅ all pass |
| Fork — RegistryForkTest | 18 | run with `--fork-url http://127.0.0.1:8545` |
| **Total unit** | **80** | **✅** |

Fork tests added (v0.5 changes):
- **test_deploy_immutablesWiredCorrectly** — verifies Deploy.s.sol immutable wiring
- **test_buyback_revertsInCapWindow** (replaces old test S) — CapWindowActive guard
- **test_escrow_vault_collect_exactShares** (test V) — real ForkTrader swap + collect(), ratio check

Tests using `vm.store` seeding (artificial, noted explicitly):
- `test_escrowClaim_fullPath` — seeds escrow.usdcAccrued via vm.store (no trades on fresh fork)
- `test_washCheck_netLossPerSelfPaid` — seeds escrow.usdcAccrued via vm.store
- `test_forfeit_redirectsToVault` — seeds escrow.usdcAccrued via vm.store

Run unit tests:
```
forge test --match-path "test/unit/**"
```

Run fork tests (requires Anvil fork at http://127.0.0.1:8545 with token launched):
```
forge test --match-path "test/fork/**" --fork-url http://127.0.0.1:8545 -vv
```

---

## 5. Gas Report (unit tests, approximate)

Numbers from `forge test --match-path "test/unit/**" --gas-report` (mock contracts, no real Doppler reads).

| Contract | Function | Avg gas | Max gas |
|----------|----------|---------|---------|
| RevpadRegistry | `register()` success | ~153 K | ~635 K |
| RevenueRouter | `distribute()` | ~243 K | ~260 K |
| FeeEscrow | `collect()` | ~180 K | ~181 K |
| FeeEscrow | `claim()` | ~96 K | ~97 K |
| FeeEscrow | `forfeit()` | ~93 K | ~152 K |
| BuybackVault | `collect()` | ~170 K | ~170 K |
| BuybackVault | `execute()` | ~232 K | ~234 K |

On the real fork (real Doppler reads), `register()` is ~810 K and `execute()` includes the actual v4 swap (~400 K).

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
| Balance cap window gap on old forks | Anvil fork timestamp < real time; launch script fix closes this for new launches | Lower and upper bounds both enforced post-fix; tokens launched before fix may have wider windows |
| Multi-wallet anti-snipe ineffective | D12 accepted for v1 | Deferred (O2 Rehype hook) |
| execute() disabled for 600–900 s after launch | D19: vault would receive > 1% of supply at launch price | Window is short; callers wait until balanceLimitEnd |

---

## 8. Addresses Used in Tests

| Name | Address | Role |
|------|---------|------|
| `INITIALIZER` | `0xCe3099B2F07029b086E5e92a1573C5f5A3071783` | V4ScheduledMulticurveInitializer |
| `AIRLOCK` | `0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12` | Doppler Airlock |
| `DOPPLER_HOOK` | `0x580ca49389d83b019d07E17e99454f2F218e2dc0` | Multicurve hook (constant) |
| `USDC` | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | Numeraire |
| Test token | `0xad50518E1Dd6CA5B7491eEBa27e1fCb9a4BAc407` | Default fork test asset |
| `DEFAULT_ESCROW` | `0x3C2BafebbB0c8c58f39A976e725cD20D611d01e9` | FeeEscrow (ADMIN nonce 633) |
| `DEFAULT_VAULT` | `0x5f246ADDCF057E0f778CD422e20e413be70f9a0c` | BuybackVault (ADMIN nonce 634) |
| `DEFAULT_REGISTRY` | `0x4Dd5336F3C0D70893A7a86c6aEBe9B953E87c891` | RevpadRegistry (ADMIN nonce 636) |

### Why fresh deploy instead of vm.etch

`FeeEscrow` and `BuybackVault` declare `registry`, `buybackVault`/`poolManager`, and `initializer` as `public immutable`. `vm.etch` replaces bytecode without running the constructor, which would zero out all immutable fields. The fresh-deploy approach (in `RegistryFork.t.sol:setUp`) clears existing bytecode with `vm.etch(addr, new bytes(0))`, resets nonces, sets the deployer nonce from contracts.json (`vm.setNonce`), and deploys via `new` so every constructor runs and all immutables are properly set.

### contracts.json (written by Deploy.s.sol)

`Deploy.s.sol` writes `../../revpad-anvil/.anvil-state/contracts.json` after every broadcast containing:
- `deployer` — deployer address
- `deployerStartNonce` — nonce used for the first deployment (replaces hardcoded 633)
- `escrow`, `vault`, `routerImpl`, `registry` — deployed addresses
- `treasury`, `admin`

Fork tests read `CONTRACTS_JSON_PATH` env var (default path from `foundry.toml` fs_permissions). Falls back to hardcoded ADMIN/633 defaults when JSON absent.

The launch script (`02-launch.ts`) reads `contracts.escrow`, `contracts.vault`, `contracts.treasury` from this JSON before registering beneficiaries with Doppler, eliminating the need to pass `ESCROW_ADDRESS`/`BUYBACK_ADDRESS` env vars manually.
