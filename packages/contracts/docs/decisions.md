# Revpad Contracts — Spike Results & Decisions

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

**Decision D1 — NOGOV constant**: The constant previously named `NOGOV` in RevpadRegistry was
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

Since there is no on-chain function to look up poolId by asset address, `RevpadRegistry.register()`
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
