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
`/feed/digest` (real arXiv Atom API, cached 10 min per topic) and `/sight/signals` (bundled sample data,
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
- USDC → Permit2 approval covers the exact amount only, never unlimited. Doppler tokens ship with a
  Permit2 allowance, so selling needs only the signed PermitSingle (expiry 30 min, exact amount).
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
- The review dialog takes one wallet action per click: Approve (exact amount) → Sign permit → Buy/Sell,
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

