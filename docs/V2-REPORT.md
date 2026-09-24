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

**Finding:** No known Uniswap v4 USDC/WMON pool with real liquidity was found on Monad.

- Monad's Uniswap v4 deployment (PoolManager: `0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e`) has pools created by Doppler launches, but no general USDC/WMON trading pair was verified.
- Other DEXes (Kuru, Bean, etc.) may have USDC/MON liquidity but are not Uniswap v4 and cannot be swapped via `PoolManager.unlock()`.

**Implication for BuybackVault (per autonomous mode instructions):**
- For MON-paired tokens, the BuybackVault cannot do a two-hop swap (USDC → WMON → token) because no USDC/WMON v4 pool exists.
- **Decision:** MON-paired token buybacks accumulate USDC in the vault and skip the swap. Documented as a TODO for when a USDC/WMON v4 pool becomes available. The vault tracks `pendingBuybackUSDC` per MON-paired asset.
- For USDC-paired tokens, buyback works exactly as before (single-hop USDC → token via the token's own pool).

### 3. Dev Buy on Monad

**Finding:** Doppler Bundler is deployed on Monad mainnet.

- **Bundler address:** `0xf45588E8e0B1df9dB9ae7E20eCE5726AE931357c`
  Source: `@whetstone-research/doppler-sdk` GENERATED_DOPPLER_DEPLOYMENTS["143"].Bundler

- **SDK support:** The `CreateMulticurveParams` interface includes an optional `devBuy` field:
  ```typescript
  interface MulticurveDevBuyConfig {
    exactAmountIn: bigint;
    recipient: Address;
    vesting: MulticurveDevBuyVestingConfig;
  }
  ```
  The `devBuy` field is available on `createMulticurve()` which is the same method used for scheduled multicurve launches. The SDK resolves the Bundler address per chain and handles the atomic buy.

- **Registry compatibility:** The Registry must accept tokens launched with dev buy. Dev buy does not change the Airlock config (same beneficiaries, same pool, same vesting). The only difference is the Bundler holds some tokens in vesting for the dev buyer. The Registry's checks (supply, pool config, beneficiaries, vesting) remain valid because:
  - `totalSupply` is unchanged (dev buy purchases from the pool, doesn't mint extra)
  - Pool config and beneficiaries are identical
  - Creator vesting is separate from dev buy vesting
  - `totalAllocatedOf(creator)` still returns the creator's vesting amount (Bundler vesting is separate)

- **Decision:** Registry v2 does NOT need special handling for dev buy. It works transparently.

### 4. MON/USD Price Source

**Finding:** No on-chain Monad oracle for MON/USD was found (no Chainlink, no Pyth verified).

- **Decision:** Use CoinGecko API or similar off-chain price feed for the launch UI. The `numerairePrice` parameter in the SDK is only used for tick range computation (off-chain), not enforced on-chain. The Registry does NOT check market cap (per v2 decision #2).
- Server can cache MON/USD price and expose it via `/api/price/mon`.

---

## Phase 0 Summary

| Question | Answer |
|----------|--------|
| WMON address | `0x3bd359c1119da7da1d913d1c4d2b7c461115433a` |
| Numeraire for MON pairing | WMON (ERC-20, 18 decimals) |
| USDC/WMON v4 pool | **Not found** — MON buybacks accumulate USDC, skip swap |
| Bundler address | `0xf45588E8e0B1df9dB9ae7E20eCE5726AE931357c` |
| Dev buy + scheduled multicurve | Compatible — SDK supports it; Registry needs no changes for dev buy |
| MON/USD price | Off-chain (CoinGecko API) — no on-chain oracle on Monad |

---

## Phase 1: Contracts

### Implemented

| Contract | Changes |
|----------|---------|
| `AstralaunchConstants.sol` | Renamed from RevpadConstants. Same economics values. |
| `AstralaunchRegistry.sol` | New. Dual numeraire (USDC/WMON). Initializer allowlist with 48h timelock. Guardian role (cancel-only). Balance-limit exclusion checks. Per-token numeraire + initializer storage. |
| `RevenueRouter.sol` | Import updated to AstralaunchConstants. No logic changes (revenue is always USDC). |
| `FeeEscrow.sol` | Rewritten. Per-token numeraire support. WMON fees park as `numerairePending`. `creditNumeraireSwap()` for keeper O4 swaps. Adapter pattern for fee collection. |
| `BuybackVault.sol` | Rewritten. WMON-paired tokens revert `BuybackNotAvailable()`. Removed CapWindowActive guard (Decision #6). Adapter pattern. |
| `PlatformFeeReceiver.sol` | Rewritten. Guardian can cancel treasury/admin proposals. Forwards USDC + WMON + tokens to treasury. Adapter pattern. |
| `IFeeAdapter.sol` | New interface for initializer fee adapters. |
| `IDopplerERC20V1.sol` | Added `isExcludedFromBalanceLimit(address)`. |
| `Deploy.s.sol` | Updated for v2 constructor signatures + guardian + initial initializer seeding. |

### Legacy backup

All v1 contracts copied to `deployments/legacy-revpad/`.

### Test Results

```
forge test -vv --no-match-path "test/fork/*"

Ran 6 test suites in 7.02s (14.57s CPU time):
  189 tests passed, 0 failed, 0 skipped (189 total tests)

Invariant tests: 4 invariants, 500 runs, 50,000 calls, 0 reverts
```

### Test Coverage

- **AstralaunchRegistry.t.sol**: 79 tests — dual numeraire, initializer allowlist (propose/accept/cancel with 48h delay), guardian restrictions, balance-limit exclusion checks, all airlock/pool/beneficiary/vesting/cap error paths
- **RevenueRouter.t.sol**: 15 tests (2 fuzz) — distribute splits, dust accounting, costBps
- **FeeEscrow.t.sol**: 23 tests (2 fuzz) — USDC and WMON collect, numerairePending, claim/forfeit with WMON
- **BuybackVault.t.sol**: 17 tests (2 fuzz) — BuybackNotAvailable for WMON, cooldown, max-per-call, adapter
- **PlatformFeeReceiver.t.sol**: 54 tests (2 fuzz) — guardian cancel, WMON forwarding, treasury change delay, admin transfer
- **AstralaunchInvariants.t.sol**: 4 invariants — escrow allowance bounded, no overpayment, router dust, vault balance

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

## Open Questions

1. **WMON→USDC swap for O4**: No Uniswap v4 USDC/WMON pool exists on Monad. The keeper O4 swap job for WMON-paired token escrow fees is a TODO stub. When a pool becomes available, implement the two-hop swap path (WMON → USDC via v4, or via an external DEX integration).

2. **MON-paired token buyback**: BuybackVault accumulates USDC for MON-paired tokens but cannot execute the swap (no v4 path: USDC → WMON → token). When a USDC/WMON pool exists, implement two-hop buyback in `unlockCallback`.

3. **MON/USD price oracle**: Using CoinGecko API with 5-min cache. No on-chain oracle verified for Monad. If Pyth or Chainlink launches on Monad, consider switching to on-chain price for more reliability.

4. **Balance-limit exclusion verification**: The `isExcludedFromBalanceLimit()` function on DopplerERC20V1 needs to be confirmed on the actual Monad mainnet token contract. The Doppler SDK creates tokens with `excludedFromBalanceLimit` list set by the SDK config — Astralaunch's launch flow must include escrow, vault, and PFR addresses in this list.

---

## Decisions Made Autonomously

| # | Decision | Rationale |
|---|----------|-----------|
| A1 | IFeeAdapter = IInitializer (same contract) for v2 launch | The V4ScheduledMulticurveInitializer already implements collectFees, getShares, getState — no need for a separate adapter wrapper. The registry seeds `INITIALIZER` as both the allowed initializer and its own adapter. |
| A2 | WMON-paired buyback: accumulate USDC, revert on execute() | Per autonomous mode instructions: no USDC/WMON v4 pool → skip swap, don't invent DEX integration. |
| A3 | FeeEscrow.creditNumeraireSwap: authorized by routers/registry | The keeper needs to call this after swapping WMON → USDC. Using the same authorization mechanism as recordRevenue (authorized routers). |
| A4 | Guardian is immutable (set at deploy, cannot be changed) | Conservative choice per CLAUDE.md: the guardian is a safety mechanism, not an operational role. Changing the guardian would require a full redeploy. |
| A5 | Start market cap not checked by registry | Per Decision #2: follow what Doppler allows; creator sets it at launch. The registry verifies beneficiaries, vesting, supply, and pool config — not pricing. |
