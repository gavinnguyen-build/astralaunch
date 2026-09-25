# Astralaunch Contracts — Spike Results & Decisions

Spike run: 2026-09-22
Anvil fork of Monad mainnet at block 107059291
Token launched: `0x0E45dD8943CcBa495213A52fF55d46368A239426`
PoolId: `0xd1c500c5561f4ca120c46226baf2dec0198502f996bc2c439c8c597bfeb466ab`

---

## A. Airlock.getAssetData

All fields readable. `getAssetData(address asset)` exists on Airlock at
`0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12`.

| Field | Result |
|-------|--------|
| numeraire | USDC `0x754704…` ✓ |
| timelock | `0x...dEaD` (dead addr) |
| governance | `0x...dEaD` (dead addr) — see D1 below |
| migrator (liquidityMigrator) | `0x5F3b…` (NOMIG) ✓ |
| poolInitializer | `0xCe30…` (INITIALIZER) ✓ |
| pool (poolOrHook) | asset token address (same as input) |
| migrationPool | `0xdead…dEaD` |
| numTokensToSell | 850,000,000 × 10^18 ✓ |
| totalSupply | 1,000,000,000 × 10^18 ✓ |
| integrator | treasury address |

**Decision D1 — NOGOV constant**: The constant previously named `NOGOV` in AstralaunchRegistry was
`0xb4deE32EB70A5E55f3D2d861F49Fb3D79f7a14d9`, which is the **NoOpGovernanceFactory** address
(confirmed in Doppler SDK chain-143 config). The value stored in `Airlock.getAssetData.governance`
for a token launched with `.withGovernance({ type: 'noOp' })` is actually
`0x000000000000000000000000000000000000dEaD` (the dead address). Updated registry constant:

```solidity
address constant NOGOV = 0x000000000000000000000000000000000000dEaD;
```

---

## B. IInitializer.getPoolKey

**FAIL: `getPoolKey(address asset)` does not exist.**

The actual function signature is:
```
getPoolKey(bytes32 poolId) → (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)
```

It takes a poolId (bytes32), not an asset address. No `getPoolId(address asset)` or
equivalent function exists on the V4ScheduledMulticurveInitializer.

**Decision D2 — register() requires poolId parameter**:

Since there is no on-chain function to look up poolId by asset address, `AstralaunchRegistry.register()`
must accept `poolId` as a caller-supplied parameter. The registry verifies the supplied poolId by:

1. Calling `INITIALIZER.getPoolKey(poolId)` → checking `fee == POOL_FEE` and `tickSpacing == TICK_SPACING`
2. Checking that the pool key contains the asset token as one of its currencies (anti-spoofing)
3. Checking that the pool key contains USDC as the other currency
4. Calling `INITIALIZER.getShares(poolId, beneficiary)` for all five beneficiaries

The poolId is public information emitted by the Airlock in the `Create` event at launch time and
also returned by the Doppler SDK's `createMulticurve()` call.

Updated signature:
```solidity
function register(address asset, address creator, bytes32 poolId) external returns (address router)
```

---

## C. IInitializer.getShares

All five beneficiary shares readable and correct.

```
getShares(bytes32 poolId, address beneficiary) → uint256 wad
```

| Beneficiary | Share (WAD) | Status |
|-------------|-------------|--------|
| doppler (0x21E2ce70…) | 0.05e18 | PASS |
| creator (0xf39Fd6e5…) | 0.35e18 | PASS |
| escrowStub (0x3C44CdDd…) | 0.20e18 | PASS |
| buybackStub (0x90F79bf6…) | 0.10e18 | PASS |
| treasury (0x70997970…) | 0.30e18 | PASS |

---

## D. DopplerERC20V1 fields

All fields readable and correct.

| Function | Status | Value |
|----------|--------|-------|
| `totalSupply()` | PASS | 1e9 × 1e18 |
| `maxBalanceLimit()` | PASS | 1% of supply |
| `balanceLimitEnd()` | PASS | launch + 600s |
| `vestingStart()` | PASS | launch block timestamp |
| `vestingSchedules(0)` | PASS | cliff=30d, duration=365d |
| `burn(uint256)` | PASS | selector exists |

---

## E. PoolId Derivation

The poolId is computed by the Doppler SDK as `keccak256(abi.encode(poolKey))` where poolKey is the
Uniswap v4 PoolKey struct. Verified that `keccak256(abi.encode(poolKey))` matches the SDK-returned
poolId for the launched token.

The poolKey from state.json for the test token:
```
currency0: 0x0E45dD8943CcBa495213A52fF55d46368A239426  (token, < USDC address)
currency1: 0x754704Bc059F8C67012fEd69BC8A327a5aafb603  (USDC)
fee: 20000
tickSpacing: 200
hooks: 0x580ca49389d83b019d07E17e99454f2F218e2dc0
```

Note: `currency0 < currency1` (token address < USDC address), so `zeroForOne = false` when
BuybackVault swaps USDC (currency1) → token (currency0).

---

## Summary of Required Contract Changes

| Change | Reason |
|--------|--------|
| `NOGOV = 0x...dEaD` | Actual governance address for noOp launches |
| `register(asset, creator, poolId)` | No on-chain asset→poolId lookup |
| `INITIALIZER.getPoolKey(poolId)` | Correct function signature (bytes32 not address) |
| Verify asset/USDC are pool currencies | Anti-spoofing: poolId must correspond to this asset |

---

## F. Fix 1 — DOPPLER_HOOK constant and getState(asset) (Decision D16)

**Finding**: `V4ScheduledMulticurveInitializer` exposes `getState(address asset)` which returns `(numeraire, status, PoolKey, farTick)`. The hook address embedded in every poolKey is identical across all launches.

Confirmed hook across 4+ distinct token launches:
- spike token `0x0E45dD894…` poolKey.hooks = `0x580ca49389d83b019d07E17e99454f2F218e2dc0`
- session tokens `0xad50518E…`, `0xCbd7…`, and others — all identical hook

**Decision D16**: Add `address constant DOPPLER_HOOK = 0x580ca49389d83b019d07E17e99454f2F218e2dc0`. Use `INITIALIZER.getState(asset)` to retrieve the poolKey directly (no poolId parameter needed from the caller). Compute `poolId = keccak256(abi.encode(poolKey))` on-chain. Change register signature to `register(address asset, address creator)`. Add `WrongPool()` error when `poolKey.hooks != DOPPLER_HOOK`.

Updated signature:
```solidity
function register(address asset, address creator) external returns (address router);
```

---

## G. Fix 2 — Vesting recipient and amount

**Finding**: `DopplerERC20V1` exposes:
- `totalAllocatedOf(address beneficiary) → uint256` — total vesting allocation for an address
- `vestedTotalAmount() → uint256` — sum of all vesting schedule totals
- `vestingScheduleCount() → uint256` — number of schedules (1 for Astralaunch tokens)

On-chain values confirmed for test token `0xad50518E…`:
- `totalAllocatedOf(creator)` = 150,000,000 × 10^18 ✓
- `vestedTotalAmount()` = 150,000,000 × 10^18 ✓
- `vestingScheduleCount()` = 1 ✓

Registry now checks both `totalAllocatedOf(creator) == VESTED_TOKENS_NUM` and `vestedTotalAmount() == VESTED_TOKENS_NUM`. Reverts with `WrongVestingAmount(got, expected)`.

---

## H. Fix 3 — Balance cap window (Decision D18, updated v0.4)

**Finding (v0.3)**: `balanceLimitEnd - vestingStart = 7199 s` on the Anvil fork of Monad mainnet block 107059290.

**Root cause**: `DopplerERC20V1` sets `vestingStart = block.timestamp` at deploy time (= the Anvil fork block timestamp, a historical Monad value). The launch script (`astralaunch-anvil/src/02-launch.ts`) previously set `startTime = Math.max(blockTimestamp, Date.now()/1000) + 2`, so on a historical fork where `Date.now() >> blockTimestamp`, `balanceLimitEnd = Date.now()/1000 + 602` (wall-clock time). The gap `balanceLimitEnd - vestingStart = (Date.now()/1000 + 602) - forkBlockTimestamp ≈ 7199 s`.

**Fix (v0.4)**: The launch script now syncs Anvil's block timestamp to real time (`testClient.setNextBlockTimestamp({ timestamp: BigInt(realNow) })`) before deploying, so `block.timestamp_at_deploy ≈ Date.now()/1000` and `balanceLimitEnd - vestingStart ≈ 602 s ≤ 900 s`.

**Decision D18 (updated)**: With the launch script fix, both bounds are now enforceable on-chain:
- Lower bound: `balanceLimitEnd - vestingStart >= BALANCE_CAP_WINDOW (600 s)`
- Upper bound: `balanceLimitEnd - vestingStart <= BALANCE_CAP_WINDOW_MAX (900 s)`

Fork tests verify both bounds via `vm.mockCall`.

---

## I. Integrator check (Decision D17)

`Airlock.getAssetData(asset).integrator` returns the integrator address recorded at launch. For all Astralaunch tokens, this equals the treasury address (confirmed in spike section A). Registry now checks `integrator == treasury` and reverts with `WrongIntegrator(got, expected)`.

---

## J. Fix 4 — BuybackVault.execute() disabled during balance-cap window (Decision D19)

**Finding**: At launch price (~$0.0000025/token, INITIAL_MCAP_USD = 2,500), a single USDC spent in
`execute()` buys roughly 100,000 tokens. The vault's own accumulated balance would exceed
`maxBalanceLimit` (1% = 10M tokens) after about 100 USDC of buybacks, causing a cryptic
ERC-20 transfer revert inside `unlockCallback` rather than a clear error at the call site.
More importantly, the DopplerERC20V1 balance cap applies to **any single wallet** holding
more than 1% of supply during the window. Since the vault is a single address, even the first
execute() call risks a transfer failure at low prices.

**Decision D19**: `BuybackVault.execute()` reverts with `CapWindowActive()` if
`block.timestamp < IDopplerERC20V1(asset).balanceLimitEnd()`. This is the safest option
(clear error, easily testable) and has no economic impact: the 600–900 s window is a tiny
fraction of the buyback lifecycle. Callers simply wait until the cap window expires.

Added error: `CapWindowActive()` (`BuybackVault.sol:58`).
Added guard: `BuybackVault.sol:147-149`.
Unit test: `test_execute_revertsIfCapWindow` (BuybackVault.t.sol).
Fork test: `test_buyback_revertsInCapWindow` (RegistryFork.t.sol, test S).
SPEC §6.4 updated to document this restriction.

---

## K. Fix 5 — Deploy.s.sol passed address(0) as FeeEscrow.buybackVault

**Finding**: The original `Deploy.s.sol` deployed `FeeEscrow` at nonce N with `buybackVault = address(0)`.
`buybackVault` is `immutable`; a mainnet deploy would make `forfeit()` permanently send USDC
to the zero address (silent loss, not a revert).

**Decision**: Pre-compute `futureVault = vm.computeCreateAddress(msg.sender, nonce + 1)` and
pass it to the FeeEscrow constructor. Add post-deploy assertions that revert if any immutable
is mismatched. Write deployed addresses and deployer nonce to
`../../astralaunch-anvil/.anvil-state/contracts.json` so fork tests and the launch script no longer
hardcode the nonce "633".

Fork test `test_deploy_immutablesWiredCorrectly` verifies the wiring on every setUp.

---

## L. Fix 6 — balanceLimitEnd block-lag buffer and mainnet window (Decision D20)

**Observed (Anvil)**: first fork launch with `startTime + 600` produced `window = 576 s` (below 600). Registry reverted `WrongBalanceCap(576, 600)`.

**Observed (Monad mainnet risk)**: switching to `startTime + 900` would cause `WrongBalanceCap` on real Monad. On Monad with 0.4 s blocks the tx lands ~1 s after `now`, giving `vestingStart ≈ now + 1` and `window = now + 2 + 900 − (now + 1) = 901 s > 900 s` → rejects every valid token.

**Decision D20**: Set `balanceLimitEnd = startTime + 720` (12-minute target). Registry accepts [600, 900] s.
- Monad: `window ≈ 721 s` ✓
- Anvil (1 s blocks + ~26 s SDK lag): `window ≈ 696 s` ✓

**Side effects**: SPEC D12 updated to "12 minutes"; unit boundary tests added at 599/600/900/901.

**Fork test fix**: setUp mocks `balanceLimitEnd` for the token launched with old code (window was 576 s); tests that check wrong windows re-mock to override. To be removed once the token is relaunched with the fixed script. `deal(USDC,...)` replaced with direct `vm.store(USDC, keccak256(addr‖9), amt)` to avoid fork-backend timeouts.

---

## M. Task 0 — Launch price verified (Decision O1)

**Date**: 2026-09-23. Anvil fork of Monad mainnet, token `0x02C829Cf088B20FB501d1a9cef9c9D8C4491604C`.

**Test**: `npm run task0` — funded trader with 10 USDC via `testClient.setStorageAt` (slot 9), swapped exactly 1 USDC for tokens via Universal Router V4_SWAP, measured tokens received.

**Result**:
| Run | USDC paid | Tokens received | Implied FDV | Ratio vs $10k |
|-----|-----------|-----------------|-------------|---------------|
| 1st | 1.000000 | 97,206.785 | $10,000.00 | 1.000× |
| 2nd | 1.000000 | 96,775.942 | $10,333.15 | 1.033× |

Slight run-to-run variation is tick-rounding (the multicurve initializer places liquidity at discrete ticks; price walks as positions are consumed). Variation < 5% → correct.

**Decision**: `withCurves` config is correct.
```typescript
numerairePrice: 1,       // USDC = $1 (human units)
numeraireDecimals: 6,
tokenDecimals: 18,
marketCap: { start: 10_000, end: 200_000 },  // USD, human units
```
There is no unit mismatch. SPEC O1 updated: "verified, keeping $10,000 for v1".

---

## Summary of Implemented Changes (v0.7)

| Change | Decision | Error |
|--------|----------|-------|
| `register(asset, creator)` — poolId computed on-chain | D16 | — |
| `DOPPLER_HOOK` constant; check poolKey.hooks | D16 | `WrongPool` |
| `getState(asset)` replaces `getPoolKey(poolId)` | D16 | — |
| `integrator == treasury` check | D17 | `WrongIntegrator` |
| `totalAllocatedOf(creator) == 150M×1e18` | Fix 2 | `WrongVestingAmount` |
| `vestedTotalAmount() == 150M×1e18` | Fix 2 | `WrongVestingAmount` |
| `balanceLimitEnd − vestingStart ∈ [600, 900] s` | D18 | `WrongBalanceCap` |
| Launch script syncs Anvil time before deploy | D18 | — |
| Fork setUp: reads from contracts.json + state.json (no redeploy) | Fix 5 | — |
| `execute()` reverts during balance-cap window | D19 | `CapWindowActive` |
| Deploy.s.sol: pre-compute futureVault; pass to FeeEscrow | Fix 5 | — |
| Deploy.s.sol: post-deploy assertions + write contracts.json | Fix 5 | — |
| `balanceLimitEnd = startTime + 720` (12-min target) | D20 | — |
| Unit boundary tests at 599/600/900/901 s | D20 | — |
| Fork tests: `vm.store` for USDC balances (no `deal()`) | D20 | — |
| ForkTrader + test V: real collect() with exact 20%:10% ratio | — | — |
