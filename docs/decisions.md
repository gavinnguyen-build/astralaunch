# Off-chain decisions (server, indexer, keeper)

Contract decisions live in `packages/contracts/docs/decisions.md`.

## Launch fee + rate limit (2026-09-25)

Off-chain only: no contract changes. Code: `apps/server/src/services/launchFee.ts`,
`apps/server/src/routes/launchFee.ts`, `apps/indexer/src/writer.ts`, migration `0005_launch_fee.sql`.

**D-LF1: Fee.** 10 MON native (`LAUNCH_FEE_MON`, `LAUNCH_FEE_WEI` in `packages/shared/src/constants.ts`),
paid to `LAUNCH_FEE_TREASURY` (`0x888F…351C`, `addresses.ts`). Verification reads the tx from Monad and
requires: `to == treasury` (a direct transfer; value forwarded by a contract call does not count),
`value >= fee` (overpayment is accepted but covers one launch), receipt status success, and block
`<= finalized`. Launcher = `tx.from`. Receipts are unique by tx hash (lowercased).

**D-LF2: Rate limit.** At most 3 counted launches per launcher per rolling 24h. A launch counts once a
Registered event consumes a fee receipt. Checked at:
- verify time (wall clock): if the launcher already has 3 counted launches in the last 24h, the receipt
  is *not stored* and the call returns 429 with `nextSlotAt`. The payment stays valid on-chain and can
  be submitted again once a slot frees up.
- consume time (register block timestamp, so re-indexing is deterministic): a 4th registration in the
  window is indexed but not listed, and the receipt stays unused.
Admin listings (`source='admin'`) never count.

**D-LF3: Identity.** The launcher is the register() tx sender, read by the indexer through
`getTransaction`. The Registered event's `creator` (fee recipient) is never used for matching. Stored as
`idx_registrations.launcher`. Rows indexed before migration 0005 have `launcher = ''` and never match.

**D-LF4: Visibility.** A token is listed iff a fee receipt has `consumed_asset = token`. `/api/tokens`
(list, detail, all sub-resources), `/api/explorer` and `/api/creator/me` only return listed tokens;
unlisted ones 404. `GET /api/admin/tokens/unlisted` (Bearer `ADMIN_API_KEY`, disabled when unset)
shows the rest. Not filtered: `/api/services/*` and the `/s/*` gateway. They are service endpoints,
and hiding them would break paid calls.

**D-LF5: Matching.** On each Registered event the indexer, in the same DB transaction as the row insert,
consumes the launcher's oldest unused `source='fee'` receipt whose fee block `<=` the register block (the
fee must come before the launch). A per-launcher advisory lock serializes the check and the write.
`consumed_asset` is unique, so one receipt = one token, and re-indexing is a no-op.
Conservative addition: if verify runs *after* the indexer already saw the registration (the user
launched before calling verify), verify matches the oldest unlisted registration by that launcher at
or after the fee block. Without this, a paying user would stay hidden forever because of a race.

**D-LF6: Legacy tokens.** SIGHT (`0x30Ae…05aD`) and FEED (`0x2686…6dDf`) were launched before the fee.
`apps/server/src/scripts/listLegacyTokens.ts` writes a `source='admin'` receipt per asset (see runbook).

## Tokens come from chain (2026-09-25)

**D-TK1: Source of truth.** The indexer upserts the `tokens` row on each Registered event, in the same
transaction as the registration: asset, creator (event field), launcher (register() tx sender), router,
poolId, numeraire, initializer, register tx/block/time (`launched_at` = block time), and
name/symbol/decimals read from the ERC-20. Idempotent: re-indexing refreshes on-chain fields only and
never overwrites a known name/symbol/launcher with ''. An ERC-20 read that *reverts* falls back to
''/''/18 so the row still exists; an RPC error fails the chunk, which is retried.
Code: `apps/server/src/services/tokenSync.ts`, migration `0006_tokens_onchain.sql`.

**D-TK2: POST /api/tokens is metadata-only.** Fields: imageUrl, xHandle (new `x_handle` column; the
legacy `twitter` URL column is left as is), website, description. It needs a personal_sign by the token's
on-chain creator (`tokens.creator`) over `tokenMetadataMessage` (shared), which binds the asset, every
provided field and `issuedAt`. issuedAt must be within 10 min of server time and newer than the last
accepted update (`metadata_signed_at`), so an old signed update cannot be replayed. Unknown asset → 404:
it can no longer create tokens. Signing by the launcher alone is not accepted (conservative).
POST /api/services returns 403 for tokens that are not listed (D-LF4). The `/s/*` gateway and existing
services are not filtered.

**D-TK3: Backfill.** `apps/server/src/scripts/backfillTokens.ts` runs the same upsert for every
`idx_registrations` row and fills `idx_registrations.launcher` from the register tx where it is ''.
It does not change listing status (use `listLegacyTokens.ts` for that).
Also fixed: `tokens.launched_at` is TIMESTAMPTZ in SQL but was declared without a time zone in the drizzle
schema, which shifted reads by the host's UTC offset.

## Creator-signed service create/update (2026-09-25)

**D-SV1.** `POST /api/services` and `PATCH /api/services/:id` only accept a personal_sign by the token's
**on-chain creator**, taken from the `tokens` row the indexer writes from the Registered event. The body's
`creator` field is no longer accepted, and `router` also comes from the tokens row.
- Message: `serviceCreateMessage` / `serviceUpdateMessage` (shared) = a fixed header plus canonical JSON
  (fixed key order) of every provided field and `issuedAt`. Updates also bind the service id and asset.
  JSON is used instead of `key: value` lines so multi-line values (e.g. JSON schemas) cannot forge fields.
- Order of checks: token not registered → 404; not listed → 403; `issuedAt` more than 10 min from server
  time → 400; an update with `issuedAt` ≤ the last accepted one → 409; signer ≠ on-chain creator → 403.
- Replay: every accepted message's keccak256 is inserted into `signed_requests` in the same transaction
  as the write; an exact replay → 409. Keyed on the message, not the signature, so ECDSA signature
  malleability cannot bypass it. Updates are also monotonic on `services.auth_signed_at`.
- The PATCH response no longer returns `upstreamSecret`.
- Existing services created by the old, unsigned flow keep working (gateway unchanged). Their
  `creator` column may hold a client-supplied value, but it is no longer used for authorization.

**D-SV1 addendum (token metadata).** `POST /api/tokens` uses the same scheme: a fixed header plus canonical
JSON (`tokenMetadataMessage`), signed by the on-chain creator, with a 10 min `issuedAt` window, replay
protection through `signed_requests` (purpose `token_metadata`), and monotonic `metadata_signed_at`. A wrong
signer now gets 403 (was 401). Unlike services, metadata may be set while the token is still unlisted.

## Gateway speaks standard x402 v2 headers (2026-09-25)

**D-GW1.** The gateway sent `X-PAYMENT-REQUIRED` and read only `X-PAYMENT`, while the SDK's v2 HTTP client
(`x402HTTPClient`, @x402/core 2.26) reads `PAYMENT-REQUIRED`, sends `PAYMENT-SIGNATURE` and reads
`PAYMENT-RESPONSE`. So a standard SDK agent could not pay. The fix is additive: the 402 carries both
`PAYMENT-REQUIRED` and `X-PAYMENT-REQUIRED`; the payment is read from `PAYMENT-SIGNATURE` or `X-PAYMENT`; and
a successful paid response adds `PAYMENT-RESPONSE` (SDK `encodePaymentResponseHeader`) with the settle tx.
Settle-after-success is unchanged. The SDK exports no header-name constants, so the names mirror
`x402HTTPClient` and are covered by `gateway-headers.test.ts`, which uses that client.
Known issue, not changed: the gateway logs `payer` as `unknown` for v2 payloads (it reads `payload.payer`),
which undercounts distinct payers.

## Demo loop fixes (2026-09-25)

**D-GW2: Payer.** The gateway recorded `payer = 'unknown'` for v2 payloads (it read `payload.payer`). It now
records the address the facilitator verified (`VerifyResponse.payer`), falling back to the verified EIP-3009
`authorization.from`. On verify failure the claimed `from` is logged for information only.

**D-TS1: Timestamps.** Every timestamp column is TIMESTAMPTZ in SQL and `withTimezone: true` in drizzle.
`services`, `gateway_requests` and `service_probes` were already TIMESTAMPTZ in SQL but declared without a
time zone in drizzle, so reads shifted by the host's UTC offset. `idx_checkpoints.updated_at` was the one
TIMESTAMP column; migration 0008 converts it (`AT TIME ZONE 'UTC'`, idempotent). `timestamps.test.ts`
runs under TZ=Asia/Ho_Chi_Minh and checks every column in both drizzle and SQL.

**D-DS1: Demo services + upstream allowlist.** `apps/demo-services` (port 4001, no secrets):
`/feed/digest` (real arXiv Atom API, served from cache, see D-DS2) and `/sight/signals` (bundled sample data,
labeled "sample data", deterministic per handle), with JSON schemas in `apps/demo-services/schemas/`. It does
not verify `X-Astralaunch-Signature`: nothing secret is served, and payment is enforced by the gateway.
The SSRF guard blocks loopback upstreams, so `UPSTREAM_ALLOWLIST` (exact origins, empty by default) lets an
operator allow `http://127.0.0.1:4001` only; every other private target stays blocked.
`ALLOW_LOCAL_UPSTREAMS=true` (blanket bypass) stays fork-only.

**D-KS1: Keystores in scripts.** `mainnet-register-service.ts` / `mainnet-pay.ts` accept `<ROLE>_KEYSTORE`
(Foundry account name or path) with a hidden password prompt or `<ROLE>_KEYSTORE_PASSWORD_FILE`, so mainnet
keys never pass through the shell. The V3 decryption (scrypt/pbkdf2, aes-128-ctr, keccak MAC) is checked
against the official Web3 Secret Storage test vectors (`astralaunch-anvil/src/keystore.test.ts`).

## Market data for the web app (Phase A, 2026-09-25)

**D-MK1.**
- **Indexer.** Two new contract sets:
  - `swaps`: PoolManager `Swap` and `Initialize`, filtered by the registered pool ids (topic1).
  - `asset_transfers`: ERC-20 `Transfer` of registered assets, used for holders and supply.
  A pool can trade between launch and `register()`. So when a new pool is discovered after these sets
  have passed its launch, a targeted look-back backfill covers `[registration − INDEXER_SWAP_LOOKBACK_BLOCKS
  (20,000), checkpoint]` for that pool and asset only.
- **Buybacks.** A swap is a buyback when `Swap.sender == BuybackVault` (the vault swaps through
  `PoolManager.unlock`).
- **Prices.** Stored as exact 1e18 bigints (`price_wad`), the asset price in its numeraire.
- **USD.** USDC pairs count 1 USDC as 1 USD. MON pairs use the Chainlink MON/USD feed; it is null when the
  feed is stale beyond `MAX_ORACLE_STALENESS_S`. The **current** feed price is applied to historical
  candles and trades (display only).
- **24h change.** Last price vs the price 24h ago, or vs the launch price for tokens younger than 24h.
- **Supply.** Mints minus burns (to 0x0 or 0x…dEaD) from indexed transfers. The burn address and 0x0 are
  not counted as holders.
- **Creator trading fees** are an estimate: the simulated `collectFees` total × `getShares`, the same method
  the keeper uses.
- **Endpoints.** `/api/creator/:wallet` and `/api/leaderboard` only include listed tokens (D-LF4). Leaderboard
  ranking uses the shared clean-revenue rules (`services/cleanRevenue.ts`). Traders: coming soon.

## Web Phase B: read-only pages (2026-09-25)

**D-WB1. Markup.** `apps/web/scripts/dc2tsx.py` converts `docs/design/*.dc.html` into `apps/web/src/design/*View.tsx`.
It keeps every inline style and element, and maps `sc-for`/`sc-if` and `{{…}}` bindings to a `v` props object.
Pages (`src/pages/*`) build `v` from the real API. Sample literals in the markup were replaced by bindings
by hand. The pages keep the designs' fixed 1440px layout, centered.

**D-WB2. Real-data mappings.**
- **UCR** (SPEC §13) is `150 × clean revenue / volume` over 30 days. Buyback swaps are excluded from volume.
  With no volume the UCR is n/a, never infinite.
- **Verified** = SPEC O5 mainnet thresholds (≥100 USDC clean revenue, ≥10 clean payers), from
  `VERIFIED_MIN_*` in shared constants.
- **Buyback from usage / trading** reads the BuybackVault v2 `assetData`. The old detail route decoded the
  v1 layout, so that block was always null.
- **"Trading fees claimed"** on the token page became **"Escrow claimed"**: creator fee claims from Doppler
  are not indexed.
- **USD values can be null** (stale Chainlink). The UI then shows the MON/USDC value with "USD price
  unavailable".
- **Traders:** the leaderboard tab and the chart page's Top Traders tab show "coming soon".

**D-WB3. Chart.** lightweight-charts 5.2 draws the chart; the TradingView attribution logo is kept.
- Timeframes: 5m / 15m / 1h / 4h / D come from the API. 1s / 1m / W are shown disabled (not indexed).
- Drawing tools, undo and settings are disabled. The design's range row is empty in the design itself.
- `%` / `log` / `auto` switch the price-scale mode.

**D-WB4. Read-only until later phases.** Try API, Trade, Claim, Release, Sign and save, and Launch are shown
disabled with a note. Actions arrive in Phases C and D. Privy is mounted only when `VITE_PRIVY_APP_ID` is
set, so read-only pages work without it; `/creator?wallet=0x…` shows any creator.

**D-WB5. Dev fixes.**
- The Vite proxy key `'/s'` also matched `/src/*`, so every module request went to the API server.
  It is now anchored as `'^/s/'`.
- `API_PROXY_TARGET` overrides the proxy target (default `http://localhost:3001`).
- `PROBES_DISABLED=true` stops a read-only preview server from writing service probes.

## Web Phase C: launch from the browser (2026-09-26)

**D-LC1. One flow module.** `apps/web/src/lib/launch.ts` is framework-free and mirrors
`astralaunch-anvil/src/mainnet-launch.ts` parameter for parameter:
- supply, pool/vested split and vesting schedule
- fee and tick spacing
- sorted beneficiaries and exclusions
- two curves from the fixed `INITIAL_MCAP_USD` (not shown in the UI)
- no-op governance and migration; integrator = PlatformFeeReceiver
- startTime recomputed from the latest block right before sending
- the [600, 900] s cap-window check before `register`

Contract addresses come from `GET /api/config`, i.e. the server's deployment env; the browser hardcodes none.

**D-LC2. Order.**
1. Launch fee: 10 MON to the treasury, skipped when the wallet has an unused receipt.
2. `POST /api/launch-fee/verify`, retried while the tx is not finalized.
3. `createMulticurve`.
4. `register(asset, feeRecipient)`.
5. Wait until the indexer consumed the fee (token listed, tokens row exists).
6. Signed `POST /api/tokens` (details), then signed `POST /api/services`.
   Both use the existing JSON messages and only the on-chain creator can sign them, so with a different
   fee recipient these two steps are skipped with a note.

Every tx is simulated first and sent with gas = estimate × 1.1. The 3-per-24h limit is checked before
planning and on verify (HTTP 429).

**D-LC3. Design fields without backend support.** Image upload, Health check path and Method are shown
disabled. The token image is a URL saved as signed metadata; `tokenURI` stays `''` as in the script.
ENS is not available on Monad, so the fee recipient must be a 0x address.

**D-LC4. Fork testing.** `apps/web/scripts/fork-prepare.sh` prepares a fresh scratch DB and a fork env in
the gitignored `astralaunch-anvil/.anvil-state/`. `scripts/fork-launch-test.ts` runs the flow from Node
against a local RPC only.

**D-LC5. Confirmation display (2026-09-26, per Tun).** The confirmation dialog shows only Token, Pairing,
Fee recipient, Supply, Vesting, Launch fee (10 MON) and Estimated total (fee + gas), with Cancel and
"Confirm and launch". The plan simulation and every check in `lib/launch.ts` are unchanged; only the
display was reduced.

## Admin hide (2026-09-26)

**D-AD1.** `POST /api/admin/tokens/:asset/hide {reason}` / `.../unhide`, authenticated with `Authorization: Bearer
<ADMIN_API_KEY>`; `GET /api/admin/tokens/hidden` lists them (table `hidden_tokens`, migration 0010).
"Listed" is now *fee consumed and not hidden* (`isListedSql` / `isAssetListed`), so a hidden token
disappears from every public endpoint:
- tokens (list, detail and sub-routes), explorer, creator, leaderboard, stats
- new service registration

The `/s/*` gateway keeps serving existing services, and on-chain state is untouched.
Script: `apps/server/src/scripts/hideToken.ts` (dry run unless `--yes`).

## Phase D: web actions (2026-09-26)

**D-PD1. Universal Router address.** The previous `UNIVERSAL_ROUTER` in `addresses.ts` (0xf70536…D6A7) has
no code on Monad. It is replaced by 0x0D97Dc33264bfC1c226207428A79b26757fb9dc3 (Doppler SDK / Uniswap
deployments). A read-only check on 2026-09-26 found 19,499 bytes of code, and `poolManager()` equals
`POOL_MANAGER`. Also added `V4_QUOTER` 0xa222Dd…6891.

**D-PD2. Swap encoding.** The Monad Universal Router accepts the UR 2.0 `V4_SWAP` encoding
(`ExactInputSingleParams` without `maxHopSlippage`). `lib/trade.ts` defaults to 2.0 and keeps 2.1.1 behind
a parameter. Routes:
- USDC pair: `[PERMIT2_PERMIT] V4_SWAP[SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]`.
- MON pair buy: `WRAP_ETH(router, amountIn)` then `V4_SWAP[SWAP, SETTLE(WMON, OPEN_DELTA, payerIsUser=false), TAKE_ALL]`,
  with `value = amountIn`. The MON is wrapped in the same tx.
- MON pair sell: `[PERMIT2_PERMIT] V4_SWAP[SWAP, SETTLE_ALL, TAKE(WMON, router, OPEN_DELTA)]` then
  `UNWRAP_WETH(sender, minOut)`. The user receives MON.

**D-PD3. Trade safety.**
- Slippage defaults to 1% and is capped at 0.1–5%.
- `minOut = quote × (1 − slippage)` uses the on-chain v4 Quoter.
- Deadline is now + 20 min.
- Approvals (revised 2026-09-26, per Tun; replaces "exact amount only"). The default is the Uniswap-standard flow,
  so repeat trades need one confirmation:
  - The ERC-20 → Permit2 approval is **unlimited** (`maxUint256`), sent once per token. Doppler tokens already
    ship with this allowance, so a sell never needs it.
  - The Permit2 `PermitSingle` for the Universal Router has amount `maxUint160` (Permit2 does not decrement it)
    and expires after **30 days**. The signature deadline stays 30 min. The router only pulls from the wallet
    that calls it, so the permit is usable only in swaps the user sends.
  - The review screen says so plainly before the user signs: "This grants a long-lived permission". It names
    the unlimited approval and the permit's end date, and points to the setting below.
  - Setting **"Exact approvals only"** (off by default, remembered per browser) keeps the earlier behaviour:
    approval and permit for exactly the trade amount, permit valid 30 min, extra confirmations on every
    token trade. Permits that already exist stay valid until they expire.
  - Code: `lib/trade.ts` `approvalAmount` / `permitTerms` (`ApprovalMode` 'standard' | 'exact').
  - Verified on a local fork with the swap harness and the on-chain allowances:
    - standard mode: the first USDC buy needs 3 prompts (approve, sign, swap); USDC → Permit2 allowance =
      `maxUint256` and Permit2 USDC → UR = `maxUint160` for 30.00 days. The second buy needs 1 prompt.
    - a sell needs 2 prompts the first time (sign, swap), then 1.
    - exact mode: every FEED sell needs 2 prompts; the permit is used up (amount 0) and expires in 30 min.
- Every tx (approval, swap) is simulated with `eth_call`, then sent with gas = estimate × 1.1.
- The review screen shows min received, the 2% pool fee, the route, and gas in MON.

**D-PD4. Try API (x402 from the browser).**
- Uses the `@x402/core` `x402HTTPClient` and the `@x402/evm` exact scheme, with no hand-written headers.
- Before the user signs, the page checks:
  - the requirement is exact / eip155:143 / USDC;
  - `payTo == registry.routers(asset)` on-chain;
  - the signed authorization's `to`, `value` and `from` match.
- The confirmation shows the USDC balance. The user signs one EIP-3009 authorization and pays no gas.
- The facilitator settles only after the upstream call succeeds, as SPEC requires.

**D-PD5. Creator actions.**
- Trading fees: `initializer.collectFees(poolId)`, which pays the caller its beneficiary share.
- Escrow: `FeeEscrow.claim(asset)`.
- Vesting: `DERC20.release(scheduleId)`, using the first schedule with an available amount. If none is
  available, the button refuses with a cliff note.
- Each action is simulated, confirmed in a modal (contract, call, gas × 1.1, MON cost), then sent.
- Buttons are enabled only when the connected wallet is the page's wallet.

**D-PD6. Service settings.** The Creator page signs the existing `serviceUpdateMessage` or
`serviceCreateMessage` (formats unchanged). The price must be 0.000001–100 USDC, and the upstream must be
an http(s) URL. The server keeps its SSRF and replay checks: a signed update must be newer than the last
accepted one, at 1-second resolution.

**D-PD7. Slug pre-check at launch.** `planLaunch` checks `GET /api/services/:slug/manifest` and throws
`slug_taken` before any transaction. Before this change, a taken slug was found only after the token was
already launched.

## Swap panel (2026-09-26)

**D-SW1.** The chart page's Trade button and pop-up are replaced by an inline swap panel (`components/SwapPanel.tsx`).
It keeps the interaction patterns of a DEX swap in Astralaunch's own visual design (CLAUDE.md: original design only).
- Buy/Sell tabs and a flip button. Exact-in only. The pay-side input has 25% / 50% / Max buttons. Max on a native MON
  buy keeps `gasPrice × 1M gas` for gas.
- Quotes arrive as you type (300 ms debounce, v4 Quoter) and need no wallet. They refresh every 12 s.
- Price impact is the execution price compared with a 1/1000-size quote, so the 2% fee cancels out. At 3% or more
  the impact shows amber, at 10% or more red. At 15% or more the button turns red and the review requires a checkbox.
- Min received and the 2% pool fee are always visible under the quote.
- The single primary button's label follows the state: Connect wallet, Enter an amount, Not enough X,
  Getting the price…, then Review swap.
- The review dialog takes one wallet action per click: Approve → Sign permit → Buy/Sell (amounts per D-PD3),
  with a stepper. The gas for each tx (simulated estimate × 1.1, shown in MON) is visible before the click that
  sends it. The swap gas can only be simulated after the permit is signed, so it appears then.
- The minimum received the user reviewed is the on-chain floor. If a refreshed quote is more than 0.1% worse,
  a "Price updated" banner asks for acceptance before continuing.
- Wallet errors map to one calm sentence: cancelled, slippage exceeded (`V4TooLittleReceived` / `InsufficientETH`),
  not enough MON for gas, expired.
- The success view shows the amount actually received: the balance difference, plus gas when the output is MON.

Verified on a local Anvil fork with `apps/web/scripts/swap-harness` driven by headless Chrome:
- USDC buy with a rejected-then-accepted approval, then permit, then swap.
- USDC sell with permit only.
- MON buy (one tx) and MON sell (permit, then swap).
- The flip button, the insufficient-balance label, and the high-impact gate.

## Gateway: response schema and upstream path prefix (2026-09-26)

**D-GW3. Schema check before settle.** Found in mainnet testing: nullsight and nullfeed shared the upstream
base `http://127.0.0.1:4001`, so `/s/nullfeed/sight/signals` returned SIGHT data and would have charged FEED's
router. The gateway now reads the upstream body (max 10 MB) before settling. When the service has a `responseSchema`:
- a body that is not JSON → `response_not_json`
- a schema mismatch → `schema_mismatch`
- a schema that cannot be used → `schema_invalid`

In each case it returns 502, does NOT settle and logs the error code, so the buyer is not charged. Services
without a schema behave as before. Creator schemas are untrusted, so they are interpreted by
`@cfworker/json-schema` and never compiled to code. They are checked at registration (400 when unusable).
They cannot be changed by PATCH (signed message format unchanged).

**D-GW4. Upstream path prefix.** `upstreamUrl` may include a path (e.g. `http://127.0.0.1:4001/sight`). The gateway
maps `/s/{slug}/<path>?<query>` to `<upstreamUrl>/<path>?<query>`, keeping the raw query and repeated keys.
Requests are refused with 400 before any payment when:
- the path contains encoded `/` or `\` (the incoming URL is already dot-normalised);
- the target would leave the prefix.

At create/update, an `upstreamUrl` with a query, fragment or credentials is rejected. Health probes call
`<upstreamUrl>/health`, so demo-services also serves `/sight/health` and `/feed/health`. The register script
keeps the current price on an update when `PRICE_USDC` is unset.


## One-transaction launch: LaunchHelper (2026-09-26)

**D-LH1. Periphery, not a core change.** `packages/contracts/src/LaunchHelper.sol`, in one call:
`Airlock.create(params)` → `AstralaunchRegistry.register(asset, creator)` → forward the fee to the treasury →
emit `LaunchFeePaid(launcher, asset, amount)`. The deployed v2 core is unchanged, and a direct launch still works.
The helper has no admin and holds no funds. Its airlock, registry, treasury and fee are immutable, and it is
`nonReentrant`. All-or-nothing: if create or register reverts (any config mismatch), no fee is taken.

**D-LH2. The SDK builds the params (CLAUDE.md rule 11).** The web encodes `CreateParams` with the Doppler SDK
(`encodeCreateMulticurveParams`, same builder as mainnet-launch.ts) and passes them through. The helper never
builds or inspects the multicurve encoding; the registry's on-chain checks are the gate. The SDK's salt is
random per encode, so the web encodes once, then simulates and sends that same value. Fork-verified: the
Airlock does not depend on `msg.sender`, so a token created through the helper registers like a direct launch.

**D-LH3. `msg.value` is exactly the fee or 0.** 0 = the launcher already holds an unused receipt (e.g. a paid fee
whose launch failed), so the one-tx flow never charges twice. Without a receipt, a 0-value launch is simply
unlisted, like any direct launch. Any other value reverts. *Conservative reading:* the spec asks for the fee
to be forwarded; the 0 path adds no way around listing, which stays off-chain (D-LF1).

**D-LH4. Launcher = tx sender.** `POST /api/launch-fee/verify` accepts a tx to the configured LaunchHelper.
The fee is the amount in the helper's own `LaunchFeePaid` log (logs from any other address are ignored).
The receipt's launcher is `tx.from`, matching the indexer's register-sender rule (D-LF3). The late match
prefers the event's asset. A helper tx that paid nothing → `no_fee_paid` (422). Direct transfers are unchanged.

**D-LH5. Config and startup check.** `LAUNCH_HELPER_ADDRESS` (server) is exposed as `launchHelper` in
`/api/config`. Unset = the web uses the multi-transaction flow. When set, the server refuses to start unless
the address has code and its airlock, registry, treasury and fee match AIRLOCK, the registry,
LAUNCH_FEE_TREASURY and LAUNCH_FEE_WEI. Per CLAUDE.md rule 8, the mainnet address goes into
`packages/shared/src/addresses.ts` (with the deploy tx) once deployed; until then it is config only.

**D-LH6. One signature: `launchDetailsMessage`.** New header `Astralaunch: launch details` + canonical JSON of the
metadata fields and a nested canonical `service`, then `issuedAt`. `POST /api/tokens/launch-details`
applies the same rules as the two single-purpose endpoints (on-chain creator, fresh issuedAt, replay record
`launch_details`, listed token + safe upstream for a service, monotonic metadata) and commits both in one
transaction. The old messages and endpoints are unchanged. The web signs right after the launch tx confirms
(the token address is only final then) and posts once the token is listed (the listing wait of ≤ 300 s fits
the 600 s signature window).

## Trade latency after a swap (2026-09-26)

**D-IX1. Market-data poll.** The indexer follow loop runs the full cycle (registry, routers, USDC transfers,
market) every `INDEXER_POLL_INTERVAL_S`. In between it runs only the market sets (swaps + pool inits, asset
transfers) every `INDEXER_SWAP_POLL_INTERVAL_S` (unset = same as the full interval; `docker-compose.prod.yml`: 3 s).
One sequential loop, so two cycles never race on a checkpoint.
- Every set, market included, still indexes only up to the `finalized` block. Market data moves no money and
  does not feed the keeper, and on Monad mainnet `finalized` was measured at head − 1 block (2026-09-26), so
  finality is not the source of the delay; the 10 s poll was.
- The registry, router and USDC sets, which the keeper and revenue depend on, keep the normal interval.

**D-SW2. Optimistic trade row.** Once the swap receipt arrives, the chart page adds the user's trade to the trades
table and a new "My trades" tab (connected wallet only). The row is decoded from the receipt's PoolManager
`Swap` event for the token's pool id, with the same mapping as the server, and labelled "confirming". It is dropped
as soon as `/trades` returns the same tx hash (or after 10 min). Trades, candles, holders and the panel balances
then refresh every 2 s for 30 s, then return to their normal intervals (`lib/optimisticTrade.ts`).
- Fork check (`scripts/swap-harness/chart.html`, the real TokenChart page, fork server + indexer at 10 s / 3 s):
  - The "confirming" row appeared 1 ms after the receipt, including in My trades.
  - After finality (64 blocks mined, since Anvil's `finalized` is head − 64), the indexed row replaced it in 2.0 s
    with identical values and no duplicate.
  - 0–30 s after the swap: 14 requests each for trades, candles and holders. After that: trades every 15 s;
    candles and holders stop.

## Service example call (2026-09-29)

**D-SV2. `examplePath`.** A service may carry one sample request relative to its gateway path, e.g.
`/signals?handle=monad` (migration 0011, `services.example_path`).
- It is part of the signed service create, update and launch-details messages.
  - The key sits before `issuedAt`, or at the end of the service object in launch details. `canonical()` drops
    unset fields, so a message without it is byte-for-byte the old one, and earlier signatures stay valid
    (test pins the old strings).
  - On an update, `""` removes it.
- Validation (`examplePathError`, shared):
  - it starts with `/`;
  - no whitespace, `#`, backslash or encoded slash;
  - no dot segments, including percent-encoded ones.
  So it can only address the service's own endpoints behind the gateway prefix (D-GW4).
- It is exposed in the token list and token detail `service`, and in the manifest.
- The web uses it for "Try a sample call" on the token page and the Home cards. The button is hidden when the
  service has none. There is one confirm card (query params as `name: value`, price, "no gas · not charged if it
  fails"), then the existing x402 flow. The result shows Done + the settlement tx, or one plain sentence; the
  response body is not shown.
- The agent link shown is always the gateway (`VITE_API_BASE` + `/s/{slug}/`), never the upstream URL.

**D-SV3. Fork servers never reach the real facilitator.** During the D-SV2 fork check, the fork server used the
default `X402_FACILITATOR_URL` (the Monad mainnet facilitator), and one test authorization was sent there for
verification.
- It was from a public Anvil account, to a fork-only router, and not settled (upstream down → 502), so there was
  no mainnet transaction and no funds moved; it expired after 60 s.
- Now `fork-prepare.sh` writes a local facilitator URL, and the server refuses to start when `MONAD_RPC_URL` is
  local but the facilitator is not (`lib/forkGuard.ts`).

## One API link services (2026-09-30)

**D-SL1. The creator pastes one link.** From the link they already use to call their API (e.g.
`https://myagent.ai/v1/ask?q=hello`) the server derives:
- the upstream origin;
- the allowed prefix, which is the directory of the pasted path (`/v1/`; `/` for `https://api.myagent.ai/ask`,
  or with "Open the whole domain");
- `examplePath`, the rest of the path plus its query (`/ask?q=hello`).

Agents call `https://api.astralaunch.xyz/s/<slug>/<path under the prefix>`. `upstream_url` keeps its meaning
(origin + prefix) and `lib/upstream.ts` still confines every call to it. One price for every call.
Supported: request/response of any content type, streaming (SSE / chunked), file upload and file responses, and
sessions through headers or ids. Not supported: async jobs that need polling, WebSocket/WebRTC, MCP/A2A.

**D-SL2. Forwarding and limits.** Any method, path under the prefix, query and body (≤ 25 MB) is forwarded, with the
agent's safe headers. Dropped: hop-by-hop, cookie, payment, `x-forwarded-*`, `cf-*` and gateway-owned headers.
Limits are env-configurable: `GATEWAY_MAX_REQUEST_BYTES` 25 MB, `GATEWAY_MAX_RESPONSE_BYTES` 25 MB (non-streamed),
`GATEWAY_TIMEOUT_S` 120 (non-streamed total, and time to headers for a stream), `GATEWAY_STREAM_IDLE_S` 60.
Upstream calls use `node:http`/`https` (`lib/upstreamClient.ts`):
- public https only, except UPSTREAM_ALLOWLIST / ALLOW_LOCAL_UPSTREAMS;
- DNS is checked inside the socket's lookup at connect time, so no DNS-rebinding window;
- private IP literals are refused;
- redirects are never followed;
- bodies are not decompressed, so bytes pass through as sent.

**D-SL3. Charge rule** (`lib/proxy.ts settlementFor`, supersedes the "schema always" part of D-GW3):
- A non-2xx answer (including redirects) or a connection error is never charged.
- **Streamed** responses (`text/event-stream`, or chunked non-JSON) are charged when the upstream's 2xx headers
  arrive, before the body streams. The bytes then pass through unbuffered.
- **Buffered** responses are charged after the full 2xx body is read, and after the schema check only when the
  service declared one.

A stream that breaks after the headers is still charged. The agent paid for the call, and the API accepted it.

**D-SL4. Payment window.** The authorization must still be valid when the gateway settles, which can be up to the
120 s upstream timeout after the agent signed. So `maxTimeoutSeconds = max(PAYMENT_TIMEOUT_SECONDS, timeout + 30)`,
capped at 300 s (the server's replay guard), which gives 150 s by default. Streams settle at the headers, well inside it.
Verified on 2026-09-30 against the official facilitator (`https://x402-facilitator.molandak.org`), verify only,
using a random wallet with 0 USDC so nothing could settle:
- 60 s, 150 s and 300 s windows all returned `insufficient_funds`, so they passed every time check;
- the control (a 1 s window, verified 7 s later) returned `invalid_payment_expired`.

The SDK facilitator (`@x402/evm` 2.26) only requires `validBefore ≥ now + 6 s` at verify and at settle.

**D-SL5. The upstream is never revealed.**
- Stripped from responses: `Server`, `X-Powered-By`, `Via`, cloud/CDN ids, `Set-Cookie`, the upstream's CORS,
  trace ids and similar headers.
- `Location` inside the prefix is rewritten to the gateway URL. The same origin outside the prefix is dropped.
  Another https origin (e.g. a signed file URL) is kept.
- Our errors never contain the upstream host. Upstream error bodies are shown only as ≤ 2 KB of text, with the host
  replaced by `<upstream>`.
- No public endpoint returns the link, the key or any secret. The public creator dashboard and the PATCH response
  used to return `upstreamUrl`; that is fixed. The only way to read them is the signed
  `POST /api/services/:id/settings`. That read is not single-use: it may be re-sent within the 600 s window.

**D-SL6. The API key is encrypted at rest.** `services.api_key_enc` holds AES-256-GCM with a random nonce. The key
is HKDF-SHA256(`GATEWAY_HMAC_MASTER_KEY`, "astralaunch/service-api-key/v1"), and the service id is the AAD.
Rotating the master key makes stored API keys unreadable, so creators would have to re-enter them. Only the header
name is ever returned.

**D-SL7. Protect your API.** Each service has a random shared secret (`protect_secret`, generated on first use for
older services). The gateway sends it as `X-Astralaunch-Secret` on every forwarded call, next to the existing HMAC
`X-Astralaunch-Signature`. Snippets for Node/Express, Python/FastAPI and Cloudflare Workers reject calls without it.
Every 5 minutes a probe makes the example call directly, without the secret or the key. A 2xx marks the service
`unprotected` (creator-only); a network error leaves the status unchanged.

**D-SL8. Attach check.** Create, a link change, and launch-details all call the pasted link once through the same
client, with the gateway's headers when the service already exists. A 2xx is required within the timeout.
The result records the kind (`json` / `stream` / `file`), the content type and, for JSON only, a ≤ 4 KB sample.
Errors are human-readable ("We could not reach this link", "It answered with an error (404)",
"It took longer than 120 seconds to answer").
`POST /api/services/check` runs the same check before a launch. It needs no auth, because no token exists yet,
and allows 10 per minute per client address.

**D-SL9. Signed messages.** `apiLink`, `wholeDomain`, `apiKeyHeader` and `apiKeyValue` are appended to the
create / update / launch-details canonical keys, just before `issuedAt`. A message without them is byte-identical,
so earlier signatures stay valid. A create carries exactly one of `apiLink` (new) or `upstreamUrl` (legacy).

**D-SL10. POST-only APIs and the sample request (2026-09-30).** Many agent APIs answer only POST with a JSON body
(e.g. `POST /v1/chat`). A plain GET on their link gets 405, which blocked launch even though the gateway forwards
POST fine.

Without a sample request, the check sends one plain GET to the link and nothing else. It never sends a request the
creator did not write, because a real API may act on it (an earlier draft probed with `POST {}`; removed 2026-09-30).
- a 2xx is recorded as before;
- a **405 or 400** means the endpoint exists but wants another method or a body: the link is **reachable**,
  launch/attach is allowed, "no sample call" is saved (`response_kind` NULL) and the hint "Your API is reachable. To
  show a sample call, add a Sample request under Advanced." is shown;
- a **404** is refused with "Nothing found at this link.";
- anything else is refused as before ("It answered with an error (N).").

The check has no side effects beyond that GET.

The optional **sample request** (Advanced: GET or POST, and for POST a JSON body of ≤ 16 KB) makes the check send
exactly that request, which must return 2xx. It also drives "Try a sample call". The fields are `sampleMethod` and
`sampleBody`, appended to the signed create / update / launch-details keys before `issuedAt`, so old messages are
unchanged. On an update, `sampleMethod: ""` removes the sample. Migration 0013 is registered in the journal.

`publicSample` sets what the token page and the manifest expose:
- no sample call → `null`, and the page hides "Try a sample call" (the agent link and its copy button stay);
- legacy services keep their GET example path.

Probes without a sample use a plain GET. Health counts any answer below 500 as up. Protection counts 401/403 as
protected and 2xx as unprotected, and leaves the status unchanged for anything else: without a sample, a 405 cannot
show whether the secret is enforced.

**D-DS2. Feed digest served from cache; fallback sample when arXiv is down (2026-10-01).** From the VPS, arXiv takes
about 16 s to answer. It also returns 429 when polled often; this was seen from a dev machine on 2026-10-01. The old
8 s timeout turned that into 502 `arXiv unavailable`.
- **Serving:** `/feed/digest` is now stale-while-revalidate per topic (case-insensitive). A cached result is returned
  at once with `cached: true` and its `fetchedAt`. When it is 10 min old or more, one background refresh starts.
- **Refresh limits:** at most one refresh is in flight per topic, and at most one attempt per topic every 10 min,
  failed attempts included, so a slow or rate-limiting arXiv is not retried in a loop.
- **arXiv request:** timeout 30 s, User-Agent `Astralaunch-demo-services/1.0 (+https://astralaunch.xyz; …)`.
- **Persistence:** the cache is kept in `FEED_CACHE_FILE`, written atomically (tmp + rename), in the
  `demo_feed_cache` volume at `/data` in production. It is loaded at start, and "agent payments" is warmed in the
  background.
- **Fallback:** with no cached result, a request waits for arXiv, up to 30 s (the gateway allows 120 s). If that fails,
  it gets 5 real arXiv papers on agent payments, bundled in `src/fallback.ts`. That answer has
  `"source": "fallback sample"`, `cached: true` and `fetchedAt` = the day they were copied. arXiv never causes a 5xx;
  only an invalid topic gets an error (400).
- **Schema:** the published schema (`schemas/feed-digest.json`) now allows
  `source ∈ {"arXiv API (export.arxiv.org)", "fallback sample"}`. Services registered before this change keep the old
  copy (`services.response_schema`, `source` const). There, the gateway refuses a fallback answer as a schema mismatch,
  so it returns 502 and does not charge. The creator must update the stored schema with a signed settings update to
  serve the fallback.

**D-SV4. Stale response schemas: creators can replace or remove them, and see the failures (2026-10-01).** A service
stores its own copy of its response schema (`services.response_schema`). When the API's answers change, every
response fails the gateway check: a 502, never charged. Before this change the creator had no way to know and no way
to fix it. Seen with nullfeed: D-DS2 added `"source": "fallback sample"`, and the stored schema only allows the arXiv
value.
- **Update / remove.** `PATCH /api/services/:id` accepts `responseSchema` (stringified JSON Schema, ≤ 20,000 chars;
  `""` removes it). It is signed like the other update fields. `responseSchema` is appended to the canonical update
  keys before `issuedAt`, so a message without it is byte-for-byte the same as before and earlier signed messages stay
  valid. The server compiles the schema before accepting it (400 with a readable message). A new or removed schema
  clears the service's recorded mismatches, since they were checked against the old one.
- **Mismatches.** The gateway records each failed check (`schema_mismatch`, `response_not_json`, `schema_invalid`)
  in `schema_mismatches` (migration 0014). A row holds the code, the validator's first error (≤ 300 chars) and the
  request path under `/s/{slug}`. The query string is never stored, because it can carry agent data. Rows older than
  7 days are pruned on write.
- **Creator-only.** The 7-day count and the latest error are returned only by the signed settings read
  (`POST /api/services/:id/settings`). They are never on a public endpoint (token, list, manifest,
  `/api/creator/:wallet`). `/api/creator/me` is not used, because it trusts an unauthenticated header.
- **Creator page.** After "Show my settings" (one signature), a notice reads "N responses did not match your schema
  in the last 7 days", with the latest error and a link to the Response schema field in Advanced. That field is a
  JSON textarea with validation and a "Remove schema" button; saving sends the schema only when it changed.
- **Register script.** `RESPONSE_SCHEMA` on an existing service replaces the schema; `REMOVE_SCHEMA=1` removes it.
- **Operator alert.** Not added. The Telegram path lives in the keeper, which does not read the server database.
  Possible follow-up: a keeper job over `schema_mismatches`.

## Keeper: distribute below the router minimum (2026-10-11)

**D-KP1. Keeper thresholds never sit below the contract's.** Incident: between 2026-10-06 and 2026-10-07 the
mainnet keeper (`0x9e64…B854`) sent 472 `distribute()` calls and spent about 4.87 MON, until its balance reached the
0.2 MON reserve and the spend guard blocked it. It called the SIGHT router (holding 0.25 USDC) and the FEED router
(holding 0.10 USDC) every 10 minutes.
- **Cause.** `RevenueRouter.distribute()` returns without doing anything below `MIN_DISTRIBUTE` = 0.5 USDC. The call
  still succeeds and is still billed. The keeper's default threshold was 0.1 USDC, so it saw "revenue to distribute"
  every tick, and the balance never changed. Checked on chain: nonces 1600–1605 are pairs of `distribute()` 1 s
  apart every 10 minutes, each with status 1 and no logs.
- **Why the daily cap did not stop it.** `MAX_MON_PER_DAY` was set to 5 MON in Coolify; the loop cost about 3 MON
  per day.
- **Fix.**
  - `ROUTER_MIN_DISTRIBUTE_USDC` (0.5 USDC) mirrors the Solidity constant, and a test reads the value from
    `AstralaunchConstants.sol`.
  - The keeper default is 1 USDC (`KEEPER_MIN_DISTRIBUTE_USDC`), and a test asserts it is ≥ the router minimum.
  - A `MIN_DISTRIBUTE_USDC` below the router minimum is clamped up, with a warning in the log.
  - Defence in depth: a `distribute()` whose receipt has no log from the router is remembered, and that router is
    skipped until its USDC balance changes. A Telegram alert is sent once.
  - The default `MAX_MON_PER_DAY` is 1 MON (about 30 real transactions at about 0.03 MON). A test replays the
    incident's rate and checks that the cap stops it.
- **Production** (2026-10-11): `MIN_DISTRIBUTE_USDC=1`, `MAX_MON_PER_DAY=1`, wallet topped up with 5 MON. Watched on
  chain for 2 ticks: no new transactions. The 0.25 and 0.10 USDC stay in the routers until each reaches 1 USDC.
