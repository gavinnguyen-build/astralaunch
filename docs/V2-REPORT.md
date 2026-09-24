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

*(to be filled as implementation proceeds)*

## Phase 2: Off-Chain

*(to be filled as implementation proceeds)*
