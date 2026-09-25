# Astralaunch v2 — Report

## Phase 0: On-Chain Fact Verification

### 1. MON Pairing — WMON Address and SDK Params

**Finding:** The Doppler SDK (v1.0.43) on Monad mainnet (chain 143) uses WMON as the wrapped native token.

- **WMON address:** `0x3bd359c1119da7da1d913d1c4d2b7c461115433a`
  Source: `@whetstone-research/doppler-sdk` dist/evm/index.js line 839:
  ```
  weth: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
  // INFO: this is wmon, but we treat it as weth because mon is native
  ```

- **SDK params for MON-paired tokens:**
  - `numeraire`: WMON address (`0x3bd359c1119da7da1d913d1c4d2b7c461115433a`)
  - `numerairePrice`: MON/USD price (e.g., 0.38 if MON = $0.38)
  - `numeraireDecimals`: 18 (WMON is 18 decimals, same as WETH)
  - The V4ScheduledMulticurveInitializer works with any ERC-20 numeraire; pools are always `asset ↔ numeraire_erc20`.

- **Decision:** MON pairing uses WMON as the numeraire ERC-20. The pool is `asset ↔ WMON`. The SDK `withCurves({ numerairePrice })` takes the MON/USD price so tick ranges compute correctly.

### 2. Uniswap v4 USDC/MON Pool on Monad

**Finding (updated 2026-09-25):** Deep native MON/USDC liquidity exists on Uniswap v4 on Monad.

**GeckoTerminal top USDC/MON pools on Monad (chain 143):**

| DEX | Version | Pool | Fee | TVL | 24h Vol |
|---|---|---|---|---|---|
| Uniswap | v4 | Native MON/USDC (PoolId `0x18a9fc...`, currency0=address(0)) | 500 (0.05%) | ~$1.1M | ~$2.2M |
| Uniswap | v3 | WMON/USDC (`0x2fb1252...`) | 3000 (0.3%) | ~$1.3M | ~$200K |
| PancakeSwap | v3 | USDC/WMON | 500 (0.05%) | ~$164K | ~$30K |
| Balancer | v3 | MON/USDC | n/a | ~$25K | low |

**On-chain verification (cast call against mainnet RPC):**

1. **Uniswap v4 native MON/USDC (fee=500, ts=10):**
   - PoolKey: `(address(0), 0x754704...USDC, 500, 10, address(0))`
   - sqrtPriceX96: `12586971096737792889464`
   - liquidity: `21584406959668679180`
   - **Selected for two-hop buyback leg 1.**

2. **Uniswap v3 WMON/USDC (fee=3000):**
   - Pool: `0x2fb12527CF9Ff41dF82de41528F4F43904101d35`
   - USDC balance: ~$494K, WMON balance: ~31K WMON
   - liquidity: `27133035452901267460`

3. **Chainlink MON/USD oracle:**
   - Address: `0xBcD78f76005B7515837af6b50c7C52BCf73822fb`
   - `latestRoundData()`: answer=2523372 (8 dec = $0.02523/MON)
   - `decimals()`: 8
   - `description()`: "MON / USD"

**Decision (updated):** Two-hop buyback implemented for WMON-paired tokens: USDC → native MON (via v4 pool fee=500 ts=10) → wrap → WMON → token → burn. FeeEscrow uses Chainlink oracle for WMON claim valuation.

### 3. Dev Buy on Monad

**Finding (updated):** Dev buy is **not available** with V4ScheduledMulticurveInitializer. The Doppler SDK rejects dev buys with this initializer:
```
Error: Dev buys require a DopplerHookInitializer or Rehype initializer; 'scheduled' is not supported
```

**Decision:** Dev buy removed from the codebase. Returns with Rehype/DopplerHook initializer (via the initializer allowlist). Bundler address (`0xf45588E8e0B1df9dB9ae7E20eCE5726AE931357c`) removed from `addresses.ts`, launch UI, and test scripts.

### 4. MON/USD Price Source

**Finding (updated 2026-09-25):** Chainlink MON/USD oracle verified on Monad mainnet.

- **Oracle address:** `0xBcD78f76005B7515837af6b50c7C52BCf73822fb`
- **Decimals:** 8
- **Description:** "MON / USD"
- **Latest answer:** 2523372 (= $0.02523/MON at time of verification)
- **Staleness:** typically < 1 minute

**Decision:** FeeEscrow uses the on-chain Chainlink oracle for WMON escrow claim valuation (max staleness 1 hour). Launch UI still uses CoinGecko API for the `numerairePrice` SDK parameter (tick range computation only, not enforced on-chain).

---

## Phase 0 Summary

| Question | Answer |
|----------|--------|
| WMON address | `0x3bd359c1119da7da1d913d1c4d2b7c461115433a` |
| Numeraire for MON pairing | WMON (ERC-20, 18 decimals) |
| Native MON/USDC v4 pool | fee=500, ts=10, ~$1.1M TVL — used for two-hop buyback |
| Chainlink MON/USD oracle | `0xBcD78f76005B7515837af6b50c7C52BCf73822fb`, 8 dec, max 1h staleness |
| Dev buy + scheduled multicurve | **Not available** — requires DopplerHookInitializer or Rehype |
| MON/USD price (launch UI) | Off-chain (CoinGecko API) — on-chain oracle used only by FeeEscrow |

---

## Phase 1: Contracts

### Implemented

| Contract | Changes |
|----------|---------|
| `AstralaunchConstants.sol` | Renamed from RevpadConstants. Same economics values. |
| `AstralaunchRegistry.sol` | New. Dual numeraire (USDC/WMON). Initializer allowlist with 48h timelock. Guardian role (cancel-only). Balance-limit exclusion checks. Per-token numeraire + initializer storage. |
| `RevenueRouter.sol` | Import updated to AstralaunchConstants. No logic changes (revenue is always USDC). |
| `FeeEscrow.sol` | Rewritten. Per-token numeraire support. WMON escrow with Chainlink MON/USD oracle for claim valuation. `claimableWmon()` view. Adapter pattern for fee collection. |
| `BuybackVault.sol` | Rewritten. Two-hop buyback for WMON pairs (USDC → native MON → WMON → token → burn). Governed MON/USDC pool key (propose/48h/accept + guardian cancel). PoolKey extracted to separate mapping. Adapter pattern. |
| `PlatformFeeReceiver.sol` | Rewritten. Guardian can cancel treasury/admin proposals. Forwards USDC + WMON + tokens to treasury. Adapter pattern. |
| `IFeeAdapter.sol` | New interface. `collectFeesCall(poolId)` returns `(target, calldata)` so beneficiary calls initializer directly (preserves msg.sender for Doppler fee payouts). |
| `InitializerV1Adapter.sol` | New. Wraps V4ScheduledMulticurveInitializer behind IFeeAdapter. `collectFeesCall` returns initializer address + `abi.encodeCall(collectFees, poolId)`. |
| `IDopplerERC20V1.sol` | Added `isExcludedFromBalanceLimit(address)`. |
| `Deploy.s.sol` | Updated for v2 constructor signatures + guardian + initial initializer seeding. |

### Legacy backup

All v1 contracts copied to `deployments/legacy-revpad/`.

### Test Results

```
forge test -vv --no-match-path "test/fork/*"

Ran 8 test suites in 6.37s (13.63s CPU time):
  211 tests passed, 0 failed, 0 skipped (211 total tests)

Invariant tests: 4 invariants, 500 runs, 50,000 calls, 0 reverts
```

### Test Coverage

- **AstralaunchRegistry.t.sol**: 79 tests — dual numeraire, initializer allowlist (propose/accept/cancel with 48h delay), guardian restrictions, balance-limit exclusion checks, all airlock/pool/beneficiary/vesting/cap error paths
- **RevenueRouter.t.sol**: 15 tests (2 fuzz) — distribute splits, dust accounting, costBps
- **FeeEscrow.t.sol**: 28 tests (2 fuzz) — USDC and WMON collect, Chainlink oracle valuation (fresh/stale/zero reverts), partial claims, forfeit with WMON to vault
- **BuybackVault.t.sol**: 26 tests (2 fuzz) — two-hop for WMON pairs, MON/USDC pool key governance (propose/accept/cancel by registry/guardian), cooldown, max-per-call, adapter
- **PlatformFeeReceiver.t.sol**: 54 tests (2 fuzz) — guardian cancel, WMON forwarding, treasury change delay, admin transfer
- **AstralaunchInvariants.t.sol**: 4 invariants — escrow allowance bounded, no overpayment, router dust, vault balance
- **InitializerV1Adapter.t.sol**: 7 tests + 1 proof test — constructor, collectFeesCall target/calldata, caller identity, getShares/getState delegation, second-initializer proof

---

## Phase 2: Off-Chain

### packages/shared
- `constants.ts`: Comment updated to reference AstralaunchConstants.sol
- `addresses.ts`: Added WMON, BUNDLER, AIRLOCK_OWNER, SUPPORTED_NUMERAIRES, NUMERAIRE_DECIMALS
- `schemas.ts`: Renamed "Revpad:" → "Astralaunch:" in service registration message

### apps/web
- **Launch page**: Added pairing choice (USDC/MON radio buttons), creator-set start market cap (USD input), dev buy amount (optional). MON/USD price fetched from `/api/prices/mon`. SDK params computed per numeraire.
- **format.ts**: Added `KNOWN_TOKENS` map (USDC, WMON), `fmtMon()`, `fmtNumeraire()` formatters
- All "Revpad" text → "Astralaunch"
- Package name: `@astralaunch/web`

### apps/server
- DB schema: Added `numeraire` column to `tokens` and `idx_registrations` tables
- Routes: Updated token endpoints for numeraire. Added `/api/prices/mon` with CoinGecko + 5-min cache.
- Gateway: `X-Revpad-Signature` → `X-Astralaunch-Signature`
- Env: `REVPAD_FACTORY_ADDRESS` → `ASTRALAUNCH_REGISTRY_ADDRESS`, added `GUARDIAN_ADDRESS`, `WMON_ADDRESS`
- Package name: `@astralaunch/server`

### apps/keeper
- `chain.ts`: Added WMON address, AstralaunchRegistry ABI for `assetNumeraires()`, `assetInitializers()`
- `jobs.ts`: Checks numeraire per asset. Skips buyback for WMON-paired tokens. TODO stub for O4 WMON→USDC swap. Alerts for initializer proposals.
- `telegram.ts`: Added alerts for initializer proposals/acceptances/cancellations
- Package name: `@astralaunch/keeper`

### packages/indexer
- Updated Registered event ABI to include `numeraire` and `initializer` fields
- Tracks `numeraire` per registered token
- Package name: `@astralaunch/indexer`

### Docs
- `CLAUDE.md`: Updated header, rule 11 (AstralaunchRegistry), env vars section (added WMON, GUARDIAN, renamed REGISTRY)
- `.env.example`: Updated with new env var names

---

## Phase 3: Gap-Closing

### Task 4: Adapter Redesign (collectFeesCall pattern)

**Problem:** `IFeeAdapter.collectFees(poolId)` was called directly by beneficiaries. This works when the adapter IS the initializer, but a separate adapter contract would receive fees instead of the beneficiary (Doppler pays `msg.sender`).

**Solution:** Replaced `collectFees` with `collectFeesCall` (a `view` function) that returns `(address target, bytes memory calldata)`. The beneficiary performs the raw `.call()` itself, preserving its identity as `msg.sender`.

**Changes:**
- `IFeeAdapter.sol`: `collectFees(bytes32) → (uint128, uint128)` replaced with `collectFeesCall(bytes32) → (address, bytes)`
- New `InitializerV1Adapter.sol`: wraps initializer behind IFeeAdapter
- `FeeEscrow.sol`, `BuybackVault.sol`, `PlatformFeeReceiver.sol`: use `target.call(cdata)` pattern + `CollectFeesFailed` error
- `Deploy.s.sol`: nonce layout N+0..N+4 adapter, N+5 registry
- All 5 test files: mock `doCollect()` + `collectFeesCall()` pattern
- New `InitializerV1Adapter.t.sol`: 7 unit tests + 1 second-initializer proof test

**Result:** 197 tests pass (was 189). The second-initializer proof test confirms that wrapping any initializer preserves beneficiary identity.

### Task 6: TypeScript Typecheck + Tests

**Fixes:**
- `package.json`: Added `packageManager: "pnpm@12.5.1"` (required by turbo 2.11.2)
- `apps/keeper/src/__tests__/ordering.test.ts`: Added `getAssetNumeraire` and `WMON` to chain.js mock
- `apps/keeper/src/__tests__/share.test.ts`: Same mock additions

**Results:**
```
pnpm typecheck:  6 tasks successful (shared build + 5 typechecks)
pnpm test:       4 tasks successful
  server:  11 passed
  keeper:  44 passed
  indexer: 43 passed, 1 skipped (migration.test.ts needs Postgres)
```

### Task 1a-c: Launch Scripts

**New scripts:**
- `revpad-anvil/src/launch-wmon.ts`: Launches WMON-paired token with `excludedFromBalanceLimit`
- `revpad-anvil/src/launch-devbuy.ts`: Launches two dev-buy tokens (with/without Bundler vesting)
- `revpad-anvil/src/02-launch.ts`: Added `excludedFromBalanceLimit: [escrow, vault, pfr]` to tokenConfig()

### Tasks 1d-f, 2, 3: Fork Tests (Executed)

**Fork test results (Anvil fork, block 107229260, updated 2026-09-25):**

```
Ran 3 test suites in 1.14s (1.12s CPU time): 33 tests passed, 0 failed, 0 skipped (33 total tests)

RegistryFork.t.sol:   24 passed, 0 failed
WmonFork.t.sol:        6 passed, 0 failed
LiquidityProbe.t.sol:  3 passed, 0 failed
```

**Task 2 — isExcludedFromBalanceLimit: CONFIRMED**

`test_isExcludedFromBalanceLimit_existsOnRealToken` PASSED. The function exists on real DopplerERC20V1 bytecode. Evidence:
- `tok.isExcludedFromBalanceLimit(escrow)` → `true`
- `tok.isExcludedFromBalanceLimit(vault)` → `true`
- `tok.isExcludedFromBalanceLimit(pfr)` → `true`
- `tok.isExcludedFromBalanceLimit(0xCAFE)` → `false`

The `excludedFromBalanceLimit` array passed in `tokenConfig()` at launch time is correctly applied on-chain. Note: `address(0xDEAD)` (the NOGOV address) is auto-excluded by Doppler, independent of launch config.

**Task 3 — Dev-Buy: REMOVED**

Dev buys require DopplerHookInitializer or Rehype (not V4ScheduledMulticurveInitializer). All dev buy code removed from codebase: `launch-devbuy.ts`, `DevBuyFork.t.sol`, BUNDLER address, Launch.tsx dev buy fields. Returns with Rehype initializer via the allowlist.

**WMON-Paired Token: CONFIRMED WORKING (two-hop buyback, oracle escrow)**

- `test_register_wmonNumeraire` PASSED: `registry.assetNumeraires(asset) == WMON`
- `test_collect_receivesWMON` PASSED: escrow received `3999999999999999` WMON (~0.004 WMON from 1 WMON swap at 2%)
- `test_twoHopBuyback_burnTokens` PASSED: 3 USDC revenue → vault gets 3 USDC via distribute → two-hop buyback (USDC → native MON via real v4 pool fee=500 ts=10 → wrap → WMON → token → burn). **3,751,468,154,800,126,370,883,698 tokens burned.**
- `test_claimWmon_oracleValuation` PASSED: 100 USDC revenue recorded, 5 WMON trading fees collected, Chainlink oracle answer=2707267 ($0.0271/MON). Creator claimed `19999999999999999` WMON (~0.02 WMON), `wmonClaimedUsd=54145` (8 dec).
- `test_washCheck_wmonPair` PASSED — wash constraint: `ESCROW_UNLOCK_BPS` (2000 bps = 20% of recorded revenue unlocked as escrow) < `10000 - PROVIDER_BPS` (10000 − 6000 = 4000 bps = the portion of each revenue dollar NOT returned to provider). Worked example: a creator who self-pays 1 USDC for a WMON-paired token gets back 0.60 USDC (provider share, 6000 bps) + 0.20 USDC-equivalent in WMON (escrow unlocked, valued by Chainlink oracle at claim time, 2000 bps of 1 USDC recorded revenue) = **0.80 USDC-equivalent total**, and **loses 0.20 USDC**. The remaining 0.20 goes to the platform: 0.10 USDC treasury (1000 bps) + 0.30 USDC buyback (3000 bps) − 0.20 USDC-equivalent escrow = 0.20 net. Loss is always > 0 because the compile-time assertion `_WASH_ASSERT = (10000 - 6000) - 2000 - 1 = 1999` prevents any parameter combination where wash could break even.
- `test_pfr_forwardsWMON` PASSED: treasury received `5999999999999999` WMON (~0.006 WMON, the 30% PFR share)

**USDC-Paired Token: CONFIRMED WORKING (single-hop buyback)**

- Real 10 USDC swap generates correct fee splits: escrow 39,999 (20%), vault 19,999 (10%)
- PFR collect forwards 59,999 USDC to treasury (30% share)
- Buyback burns 953,017,632,543,025,721,665,867 tokens for 10 USDC
- Wash constraint holds: 1 USDC self-pay → 0.6 provider + 0.2 escrow = 0.8 received, net loss 0.2

**Liquidity Probe (fork-verified, 2026-09-25):**

Native MON/USDC v4 pools found on Monad (currency0=address(0)):

| Fee | Tick Spacing | sqrtPriceX96 | Liquidity | Notes |
|-----|-------------|--------------|-----------|-------|
| 100 | 1 | 11824554402319638109187 | 622545667 | Shallow |
| **500** | **10** | **13031725198633156476928** | **21593306817506544910** | **Deepest — selected for buyback** |
| 3000 | 60 | 13032700921217581491474 | 20997613533631895 | Moderate |
| 10000 | 200 | 13046220933358555838126 | 5374262084909219 | Low |

WMON/USDC v3 pool: fee=3000, sqrtPriceX96=4295128740, liquidity=0 (empty).

PoolKey for selected pool: `(address(0), 0x754704Bc059F8C67012fEd69BC8A327a5aafb603, 500, 10, address(0))`

PoolId verification: `keccak256(abi.encode(monUsdcPoolKey))` = `0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954`. Confirmed via `forge script` — matches the GeckoTerminal pool id exactly.

### Task 5: USDC/MON Liquidity Measurement (Redone 2026-09-25)

**Methodology:** GeckoTerminal API + on-chain verification via `cast call` against Monad mainnet RPC.

**Native MON/USDC pools (Uniswap v4, currency0=address(0)):**

| Fee | Tick Spacing | sqrtPriceX96 | Liquidity | TVL | Status |
|-----|-------------|-------------|-----------|-----|--------|
| 500 | 10 | 12586971096737792889464 | 21584406959668679180 | ~$1.1M | **Deep liquidity — selected for two-hop** |

**WMON/USDC pools (Uniswap v3):**

| Fee | Pool | Liquidity | TVL |
|-----|------|-----------|-----|
| 3000 | `0x2fb12527CF9Ff41dF82de41528F4F43904101d35` | 27133035452901267460 | ~$1.3M |

**Chainlink MON/USD oracle:**

| Field | Value |
|-------|-------|
| Address | `0xBcD78f76005B7515837af6b50c7C52BCf73822fb` |
| answer | 2523372 (= $0.02523/MON) |
| decimals | 8 |
| description | "MON / USD" |
| updatedAt | 1790311169 (< 1 min staleness) |

**Conclusion:** The native MON/USDC v4 pool (fee=500, ts=10, hooks=0) has ~$1.1M TVL and ~$2.2M daily volume. This is the deepest on-chain liquidity path and is used for leg 1 of the two-hop buyback. The Chainlink oracle provides reliable MON/USD pricing for escrow valuation.

---

## Open Questions

1. **WMON→USDC swap for escrow: CLOSED.** FeeEscrow now holds WMON escrow directly (no swap needed). Creator claims WMON valued via Chainlink MON/USD oracle at claim time. O4 swap job removed from keeper.

2. **MON-paired token buyback: CLOSED.** Two-hop buyback implemented: USDC → native MON (v4 pool fee=500 ts=10) → wrap → WMON → token → burn. Both legs inside one `unlock()` call.

3. **MON/USD price oracle: CLOSED.** Chainlink MON/USD oracle verified on Monad mainnet (`0xBcD78f76005B7515837af6b50c7C52BCf73822fb`, 8 decimals, max 1h staleness). Used by FeeEscrow for WMON claim valuation. Launch UI still uses CoinGecko for SDK `numerairePrice`.

4. **Balance-limit exclusion: CLOSED.** `isExcludedFromBalanceLimit()` confirmed working on real deployed tokens. Escrow, vault, and PFR are all correctly excluded. Launch scripts pass `excludedFromBalanceLimit: [escrow, vault, pfr]` to tokenConfig().

5. **Dev buys: CLOSED — REMOVED.** The Doppler SDK requires DopplerHookInitializer or Rehype for dev buys. The V4ScheduledMulticurveInitializer we use on Monad does not support dev buys. Dev buy code removed from codebase; returns with Rehype.

---

## Decisions Made Autonomously

| # | Decision | Rationale |
|---|----------|-----------|
| A1 | IFeeAdapter.collectFeesCall + InitializerV1Adapter | Replaced `collectFees(poolId)` with `collectFeesCall(poolId) → (target, calldata)`. Beneficiaries do `target.call(calldata)` to preserve msg.sender identity for Doppler payouts. InitializerV1Adapter wraps the V4ScheduledMulticurveInitializer. Deploy.s.sol deploys adapter at nonce N+4, registry at N+5. |
| A2 | ~~WMON-paired buyback: accumulate USDC, revert on execute()~~ **SUPERSEDED** | Two-hop buyback now implemented: USDC → native MON (v4 pool fee=500 ts=10) → wrap → WMON → token → burn. MON/USDC pool key is a governed constructor param (propose/48h/accept + guardian cancel). |
| A3 | ~~FeeEscrow.creditNumeraireSwap: authorized by routers/registry~~ **SUPERSEDED** | Removed. FeeEscrow now holds WMON directly and values claims via Chainlink MON/USD oracle. No keeper swap needed. |
| A4 | Guardian is immutable (set at deploy, cannot be changed) | Conservative choice per CLAUDE.md: the guardian is a safety mechanism, not an operational role. Changing the guardian would require a full redeploy. |
| A5 | Start market cap not checked by registry | Per Decision #2: follow what Doppler allows; creator sets it at launch. The registry verifies beneficiaries, vesting, supply, and pool config — not pricing. |
