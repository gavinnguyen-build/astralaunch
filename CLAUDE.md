# CLAUDE.md — Astralaunch (formerly Revpad)

Astralaunch is a token launchpad on Monad for x402 services. Each service is bound to a token launched via Doppler (Uniswap v4 multicurve, USDC or MON pair). Trading fees are split on-chain; service revenue flows through a per-token RevenueRouter into provider payouts, buyback-and-burn, and escrow unlocks for the creator.

**Read `SPEC.md` before any task.** It is the source of truth for economics and behavior. `docs/BANKR_REFERENCE.md` is background only.

---

## Repo layout (pnpm workspace)

```
apps/web            Vite + React + TypeScript, Privy, viem
apps/server         Hono: API + x402 gateway (/s/*) + hosted Prompt template runtime
apps/keeper         Node worker for scheduled on-chain jobs
packages/contracts  Foundry (Solidity ^0.8.24)
packages/indexer    Envio HyperIndex
packages/shared     constants, addresses, zod schemas, fee math, shared types
docs/               VERIFICATION-anvil.md, VERIFICATION-real.md, BANKR_REFERENCE.md, decisions.md
packages/contracts/docs/  decisions.md, CONTRACTS-REVIEW.md
```

## Commands

```bash
pnpm i
pnpm dev                              # web + server + keeper (turbo/concurrently)
pnpm -F web dev
pnpm -F server dev
pnpm -F keeper dev
pnpm lint && pnpm typecheck && pnpm test

cd packages/contracts
forge build
forge test -vv
forge test --network monad --fork-url $MONAD_RPC_URL --match-path test/fork/*   # Monad mainnet fork tests (Foundry >= 1.8)
forge fmt

pnpm -F indexer codegen && pnpm -F indexer dev
```

If a command above does not exist yet, create it in the relevant `package.json` rather than inventing an alternative.

---

## Non-negotiable rules

These encode SPEC §3. Do not change them without an explicit instruction from Tun, and update SPEC §0 when he does.

1. **Economics constants live only in `packages/shared/src/constants.ts`** and are mirrored in Solidity constants. Current values:
   - Pool fee: 2% (`20000` in Uniswap v4 fee units)
   - Beneficiary shares (WAD): Doppler 0.05, creator 0.35, FeeEscrow 0.20, BuybackVault 0.10, treasury 0.30
   - Revenue split (bps): provider 6000, buyback 3000, treasury 1000; hosted `costBps` ≤ 3000 taken from provider share
   - Escrow unlock: 2000 bps of recorded revenue; forfeit after 365 days
   - Supply: 1e9; 85% pool; 15% creator vesting, 30-day cliff, 365 days total
2. **Wash constraint:** `ESCROW_UNLOCK_BPS < 10000 - PROVIDER_BPS`. Add a compile-time/test assertion. Any change must keep SPEC §4.4 net result negative.
3. **Never custody user funds.** No admin function may move router, escrow, or buyback balances to arbitrary addresses. Admin can only: pause new launches, set capped hosted `costBps`, transfer admin (two-step, D22). Treasury via PlatformFeeReceiver (48h delay, D21).
4. **Settle after success.** Gateway calls facilitator settle only after upstream 2xx + schema pass. Never charge failed calls.
5. **Revenue counting:** contracts count all USDC inflows to a router. Wash filtering is display-only (SPEC §13). Never make contracts depend on off-chain "clean revenue".
6. **Monad gas:** Monad bills the gas *limit*. Every tx sent by our code sets `gas = estimate × 1.1` (constant `GAS_BUFFER`), never wallet defaults.
7. **x402 SDK:** `@x402/evm` ≥ 2.12.0. Use SDK types/middleware; never hardcode x402 header names or payload shapes.
8. **Addresses:** only in `packages/shared/src/addresses.ts`, each with a source comment (doc URL or tx). Nothing unverified gets used on mainnet.
9. **USDC = 6 decimals.** Use bigint everywhere in TS for token amounts. No floats in money math.
10. **Doppler specifics:** Airlock owner must be a beneficiary with ≥ 5%; beneficiaries sorted ascending by address; shares sum to 1e18; `numTokensToSell + vested == initialSupply` (Airlock sends leftovers to the timelock).
11. **Launch = Doppler SDK + `AstralaunchRegistry.register`.** Use the `V4ScheduledMulticurveInitializer` (Monad has no standard/decay multicurve). Never re-implement the multicurve encoding in Solidity; the registry verifies on-chain config instead. v2: Registry accepts USDC or WMON as numeraire; start market cap is set by creator (not fixed). Dev buy (via Bundler) is only supported by DopplerHookInitializer and Rehype initializer — not available with V4ScheduledMulticurveInitializer. Returns with Rehype.
12. **Fee beneficiaries collect themselves.** FeeEscrow and BuybackVault must call `collectFees` on the initializer; Doppler only pays the caller.
13. **Contracts swap via `PoolManager.unlock()`** (IUnlockCallback). Universal Router + Permit2 only for user wallets.
14. **x402 facilitator calls go through the SDK `HTTPFacilitatorClient`** (`@x402/core/http`), never hand-written HTTP. Facilitator URL from config (Monad official by default). USDC EIP-712 domain: name `"USDC"`, version `"2"`.
15. **Keys:** the test wallet whose key appeared in chat is for tests only. Never use it (or any Anvil dev key) as deployer, owner, admin, or treasury on mainnet.
16. **Anvil/Forge on Monad:** Foundry ≥ 1.8 with `--network monad`; gas measured on the fork is within ~1% of real Monad.

---

## How to work

- **Verify before build.** Any assumption about Doppler, Monad, USDC, the facilitator, or Envio gets a fork test or a documented check first. Record results in `docs/VERIFICATION-*.md` (what was checked, how, result, date). SPEC §17 lists what is already verified.
- **If a check fails, stop.** Write the finding and a proposed fallback; do not silently work around it.
- Plan → small change → test → commit. One concern per commit. Conventional commit messages.
- When SPEC is ambiguous, pick the most conservative option, note it in `docs/decisions.md`, and flag it in your summary.
- Do not add features listed in SPEC §21 (roadmap) unless asked.
- End every session with: what changed, what was verified, what is blocked, next step.

## Solidity conventions

- Foundry, `^0.8.24`, custom errors, events for every state change, NatSpec on external functions.
- Checks-effects-interactions; `nonReentrant` on functions that transfer tokens.
- Use `SafeTransferLib`/`SafeERC20`. No `tx.origin`. No unbounded loops over user-controlled arrays.
- Required tests per contract: unit (all reverts), fuzz (split sums, claimable bounds), invariants (no fund leakage), fork test against real Doppler on Monad.
- Split math: compute each share with bps, send, keep dust in contract for next round. Assert `sum(out) + dust == in` in tests.

## TypeScript conventions

- `strict: true`, ESM, viem for chain access, zod at every API boundary.
- Money: `bigint` + helpers in `packages/shared/src/money.ts` (parse/format USDC and token units).
- Server: Hono routers per domain (`tokens`, `services`, `gateway`, `explorer`, `creator`). No business logic in route handlers; put it in `services/`.
- Postgres via a typed query layer (Drizzle or Kysely); migrations committed.
- Gateway: SSRF protection on upstream URLs (resolve DNS, block private ranges), timeouts, body size caps, per-payer rate limits.
- Never log full payment payloads or secrets.

## UI rules (apps/web)

- Every screen's job: make **usage vs hype** legible. Usage-backed values and trading-backed values always use their fixed, distinct colors (tokens in SPEC §14.2).
- Token page hero = UCR meter + clean revenue, not the price chart.
- Always disclose the 2% trading fee and min-received on trades; always show the MON gas estimate before launch.
- Original design only. Do not replicate the visual design, layout, copy, or branding of Bankr, Clanker, pump.fun, nad.fun, or any other product.
- Avoid template tells: all-caps eyebrow labels, monospace data labels, identical rounded cards with the same shadow, "→" appended to every link.
- Copy: "usage-backed", "buyback", "revenue". Never "profit", "dividend", "yield", "investment return" for tokens.

## Environment variables

```
MONAD_RPC_URL=
MONAD_CHAIN_ID=143
X402_FACILITATOR_URL=https://x402-facilitator.molandak.org
FACILITATOR_SUBMITTER_ADDRESSES=0x7f6a2850669202519f0FE8aa912451238820Db86
USDC_ADDRESS=0x754704Bc059F8C67012fEd69BC8A327a5aafb603
WMON_ADDRESS=0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A
MON_USD_ORACLE=0xBcD78f76005B7515837af6b50c7C52BCf73822fb
TREASURY_ADDRESS=
GUARDIAN_ADDRESS=
ASTRALAUNCH_REGISTRY_ADDRESS=
FEE_ESCROW_ADDRESS=
BUYBACK_VAULT_ADDRESS=
PLATFORM_FEE_RECEIVER_ADDRESS=
KEEPER_PRIVATE_KEY=                   # keeper only, never in web/server
TELEGRAM_BOT_TOKEN=                   # optional: treasury proposal alerts
TELEGRAM_CHAT_ID=                     # optional: treasury proposal alerts
DATABASE_URL=
PRIVY_APP_ID=
PRIVY_APP_SECRET=
LITELLM_BASE_URL=
LITELLM_API_KEY=
GATEWAY_HMAC_MASTER_KEY=
ENVIO_API_TOKEN=
```

Secrets never in the repo. `.env.example` lists names only.

## Deployment

Hetzner + Coolify, Cloudflare Tunnel in front of `apps/server` and `apps/web`. Postgres managed in Coolify. Keeper runs as a separate service with its own funded wallet and a low-balance alert.
