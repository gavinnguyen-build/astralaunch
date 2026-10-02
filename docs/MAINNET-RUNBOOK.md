# Mainnet Deploy Runbook

> Generated: 2026-09-24 | Dry-run: Monad mainnet (chain 143) via `forge script` (no broadcast)

---

## Wallets

| Role | Address |
|------|---------|
| Deployer | `0x11e2dD9a4B9062675fD89178a2C9778182Dfcbc6` (keystore: `astralaunch-deployer`) |
| Admin | `0xe89f19D370F496520803e7ABb30c1A20B04B0f7f` |
| Treasury | `0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C` |

---

## Output file separation

Fork and mainnet both use chain id 143. `DEPLOY_OUTPUT` is **mandatory** (no default).

| Context | `DEPLOY_OUTPUT` | `FOUNDRY_BROADCAST` |
|---------|-----------------|---------------------|
| **Fork** | `../../astralaunch-anvil/.anvil-state/contracts.json` | *(unset, uses default `broadcast/`)* |
| **Mainnet** | `deployments/monad-mainnet.json` | `broadcast-mainnet` |

Safety guards in `Deploy.s.sol`:
- `DEPLOY_OUTPUT` unset -> **revert** with usage message listing both valid values
- Mainnet output + `ADMIN_ADDRESS` not set (would use deployer) -> **revert**

The output JSON includes `"dryRun": true` for simulations (no `--broadcast`),
`"dryRun": false` after a real broadcast. Server and keeper refuse to start if `dryRun` is true.

---

## 1. Prerequisites

### MON balance

Dry-run results (2026-09-24):

| Metric | Value |
|--------|-------|
| Estimated total gas | 5,198,706 |
| Estimated max fee per gas | 202 gwei |
| Base fee | 100 gwei |
| Priority fee | 2 gwei |
| **Estimated cost** | **1.05 MON** |

**Fund the deployer with at least 2 MON** (1.05 deploy + buffer for `register` + gas fluctuation).

Per-contract gas (simulated on Monad mainnet):

| # | Contract | Gas Used | Gas Limit (x1.1) |
|---|----------|----------|-------------------|
| 1 | FeeEscrow | 801,058 | 1,020,901 |
| 2 | BuybackVault | 1,051,189 | 1,320,650 |
| 3 | PlatformFeeReceiver | 532,846 | 699,311 |
| 4 | RevenueRouter (impl) | 413,074 | 554,648 |
| 5 | AstralaunchRegistry | 1,290,801 | 1,603,196 |

### Keystore setup

```bash
cast wallet import astralaunch-deployer --interactive
```

### Verify hardcoded addresses

All 7 verified on Monad mainnet (2026-09-24):

| Address | Purpose | Status |
|---------|---------|--------|
| `0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e` | PoolManager | PASS |
| `0xCe3099B2F07029b086E5e92a1573C5f5A3071783` | Initializer | PASS |
| `0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12` | Airlock | PASS |
| `0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731` | NoMigrator | PASS |
| `0x580ca49389d83b019d07E17e99454f2F218e2dc0` | DopplerHook | PASS |
| `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | USDC | PASS |
| `0x21E2ce70511e4FE542a97708e89520471DAa7A66` | Airlock owner | PASS |

Re-check before deploy:

```bash
for addr in \
  0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e \
  0xCe3099B2F07029b086E5e92a1573C5f5A3071783 \
  0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12 \
  0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731 \
  0x580ca49389d83b019d07E17e99454f2F218e2dc0 \
  0x754704Bc059F8C67012fEd69BC8A327a5aafb603 \
  0x21E2ce70511e4FE542a97708e89520471DAa7A66; do
  code=$(cast code "$addr" --rpc-url https://rpc.monad.xyz)
  [ "$code" = "0x" ] && echo "FAIL $addr" || echo "PASS $addr"
done
```

---

## 2. Deploy

```bash
cd packages/contracts

DEPLOY_OUTPUT=deployments/monad-mainnet.json \
FOUNDRY_BROADCAST=broadcast-mainnet \
ADMIN_ADDRESS=0xe89f19D370F496520803e7ABb30c1A20B04B0f7f \
TREASURY_ADDRESS=0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C \
forge script script/Deploy.s.sol \
  --rpc-url https://rpc.monad.xyz \
  --broadcast \
  --sender 0x11e2dD9a4B9062675fD89178a2C9778182Dfcbc6 \
  --account astralaunch-deployer \
  --gas-estimate-multiplier 110
```

This writes:
- `deployments/monad-mainnet.json` with `"dryRun": false`, all contract addresses, `chainId`, `blockNumber`
- `broadcast-mainnet/Deploy.s.sol/143/run-latest.json` (Forge broadcast log)

### 2a. Archive broadcast log and commit

```bash
cp broadcast-mainnet/Deploy.s.sol/143/run-latest.json \
   deployments/monad-mainnet-broadcast.json

git add deployments/monad-mainnet.json deployments/monad-mainnet-broadcast.json
git commit -m "deploy: mainnet contract addresses and broadcast log"
```

Both files contain only public addresses and tx data, no secrets.

### Expected output (v2 deploy, deployer nonce = 35)

| Contract | Predicted Address |
|----------|-------------------|
| FeeEscrow | `0xA070ad1387d525E4A180Bdb09B65FD4086858F15` |
| BuybackVault | `0x394F1dcA6011C16BC6e70CA13F6F29767D92171E` |
| PlatformFeeReceiver | `0x2eFE45394d7578dC39c75d06Fe88722118F5Ec76` |
| RevenueRouter (impl) | `0x8530406130Bc3AF2C63Ee6616966913a4B92108F` |
| AstralaunchRegistry | `0x6B3A79C723AB69f8938C87209E1D9730c739e00c` |

> Check nonce first: `cast nonce 0x11e2dD9a4B9062675fD89178a2C9778182Dfcbc6 --rpc-url https://rpc.monad.xyz`

---

## 3. Verify wiring

```bash
RPC=https://rpc.monad.xyz
REGISTRY=$(jq -r .registry deployments/monad-mainnet.json)
PFR=$(jq -r .platformFeeReceiver deployments/monad-mainnet.json)

# Confirm dryRun is false
jq .dryRun deployments/monad-mainnet.json
# Expected: false

# Registry admin
cast call $REGISTRY "admin()(address)" --rpc-url $RPC
# Expected: 0xe89f19D370F496520803e7ABb30c1A20B04B0f7f

# PFR admin
cast call $PFR "admin()(address)" --rpc-url $RPC
# Expected: 0xe89f19D370F496520803e7ABb30c1A20B04B0f7f

# PFR treasury
cast call $PFR "treasury()(address)" --rpc-url $RPC
# Expected: 0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C

# Registry -> PFR cross-ref
cast call $REGISTRY "platformFeeReceiver()(address)" --rpc-url $RPC
# Expected: $PFR address

# Registry paused = false
cast call $REGISTRY "paused()(bool)" --rpc-url $RPC
# Expected: false
```

---

## 4. Launch first token

### Set creator private key (not stored in shell history)

```bash
read -s CREATOR_PRIVATE_KEY && export CREATOR_PRIVATE_KEY
```

### Launch + register

```bash
cd astralaunch-anvil

CONTRACTS_JSON_PATH=../packages/contracts/deployments/monad-mainnet.json \
MONAD_RPC_URL=https://rpc.monad.xyz \
TOKEN_NAME="Astralaunch" \
TOKEN_SYMBOL="RVPD" \
  npx tsx src/mainnet-launch.ts
```

The script:
1. Refuses Anvil dev accounts on non-localhost RPC
2. Refuses `dryRun: true` or missing bytecode
3. Prints creator, token, beneficiaries, supply split, vesting, gas estimates, MON cost
4. Waits for you to type `yes`
5. Recomputes `startTime` from the latest block timestamp (not wall-clock from earlier)
6. Re-simulates, shows final `startTime` / `balanceLimitEnd`
7. Sends `createMulticurve`, then estimates `register()` gas on-chain (no hardcoded guess)
8. Validates balance cap window (600..900 s) before calling `register()`
9. Prints asset, poolId, router, and both tx hashes

### Retry register only (if launch succeeded but register failed)

```bash
ASSET_ADDRESS=<token address> \
CONTRACTS_JSON_PATH=../packages/contracts/deployments/monad-mainnet.json \
MONAD_RPC_URL=https://rpc.monad.xyz \
  npx tsx src/mainnet-register.ts
```

### Verify after launch

```bash
RPC=https://rpc.monad.xyz
ASSET=<asset address from output>
REGISTRY=0x6B3A79C723AB69f8938C87209E1D9730c739e00c

# Token exists
cast call $ASSET "name()(string)" --rpc-url $RPC
cast call $ASSET "symbol()(string)" --rpc-url $RPC
cast call $ASSET "totalSupply()(uint256)" --rpc-url $RPC

# Router registered
cast call $REGISTRY "routers(address)(address)" $ASSET --rpc-url $RPC

# Beneficiaries (from Airlock)
cast call 0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12 \
  "getAssetData(address)" $ASSET --rpc-url $RPC
```

---

## 5. Start server (mainnet)

### Create the database

```bash
# On the Postgres host (or via Coolify):
createdb astralaunch
```

### Configure environment

Fill in secrets in `apps/server/.env.mainnet` (copy from `.env.mainnet.example`):

```bash
cd apps/server
cp .env.mainnet.example .env.mainnet
# Edit: DATABASE_URL (e.g. postgres://user:pass@localhost:5432/astralaunch),
#       GATEWAY_HMAC_MASTER_KEY (openssl rand -hex 32),
#       PRIVY_APP_ID, PRIVY_APP_SECRET, LITELLM_BASE_URL, LITELLM_API_KEY,
#       CORS_ORIGINS (see below)
```

**Web ↔ server (CORS).** The web app calls the server at `VITE_API_BASE` (build-time, `apps/web/src/env.ts`)
for every `/api/*` request and for the `/s/*` gateway (Try API). When the web and the server are on different
origins (production: `https://astralaunch.xyz` → `https://api.astralaunch.xyz`), the server must list the web
origins in `CORS_ORIGINS`:

```bash
CORS_ORIGINS=https://astralaunch.xyz,https://www.astralaunch.xyz   # server
VITE_API_BASE=https://api.astralaunch.xyz                          # web build
```

- Bare origins only (scheme + host [+ port]); a wildcard or a path makes the server refuse to start. Empty = no
  cross-origin calls (same-origin and server-to-server calls still work).
- `/api/*` and `/s/*` answer preflights for these origins (methods GET/HEAD/POST/PUT/PATCH/DELETE, request
  headers `Content-Type`, `Accept`, `PAYMENT-SIGNATURE`, `X-PAYMENT`), expose `PAYMENT-RESPONSE`,
  `X-PAYMENT-RESPONSE`, `PAYMENT-REQUIRED` and `X-PAYMENT-REQUIRED`, and send no credentials.
- Local dev needs neither: leave `VITE_API_BASE` empty and the Vite proxy forwards `/api` and `/s/` to
  `API_PROXY_TARGET` (default `http://localhost:3001`).

Check after deploy:

```bash
curl -si -X OPTIONS https://api.astralaunch.xyz/api/stats -H 'Origin: https://astralaunch.xyz' \
  -H 'Access-Control-Request-Method: GET' | grep -i '^access-control-allow-origin'   # → https://astralaunch.xyz
curl -si -X OPTIONS https://api.astralaunch.xyz/api/stats -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: GET' | grep -ci '^access-control-allow-origin'  # → 0
```

### Run migrations

```bash
pnpm -F server db:migrate
```

### Launch fee migration + legacy token listing (one-off, 2026-09-25)

Migration `0005_launch_fee` adds `fee_receipts`. After it, public endpoints only show tokens with a
consumed launch fee (docs/decisions.md D-LF4), so SIGHT and FEED, which were launched before the fee,
must be listed by the admin script **before** the new server build goes live:

```bash
cd apps/server
pnpm exec tsx --env-file=.env.mainnet src/db/migrate.ts
# dry run: prints the target DB and checks both assets on-chain
pnpm exec tsx --env-file=.env.mainnet src/scripts/listLegacyTokens.ts --expect-db astralaunch_mainnet \
  --asset 0x30Ae380593A04C14aBFa994969B718a78A6105aD --asset 0x2686619d5569AEbcdfeC774e8a2167dE78376dDf
# apply
pnpm exec tsx --env-file=.env.mainnet src/scripts/listLegacyTokens.ts --expect-db astralaunch_mainnet \
  --asset 0x30Ae380593A04C14aBFa994969B718a78A6105aD --asset 0x2686619d5569AEbcdfeC774e8a2167dE78376dDf --yes
```

Tokens are created by the indexer from the Registered event (docs/decisions.md D-TK1). Registrations
indexed before migration 0006 need a one-off backfill of `tokens` rows (reads ERC-20 name/symbol/decimals
and the register tx sender from Monad):

```bash
cd apps/server
pnpm exec tsx --env-file=.env.mainnet src/db/migrate.ts          # applies 0006_tokens_onchain
pnpm exec tsx --env-file=.env.mainnet src/scripts/backfillTokens.ts --expect-db astralaunch_mainnet        # dry run
pnpm exec tsx --env-file=.env.mainnet src/scripts/backfillTokens.ts --expect-db astralaunch_mainnet --yes  # apply
```

Safe to re-run. Then restart the indexer and server with this build.

The script aborts if `DATABASE_URL`'s database is not `astralaunch_mainnet`, if an asset is not registered
in `AstralaunchRegistry`, or if `fee_receipts` does not exist. Re-running it is safe.
Set `ADMIN_API_KEY` in `.env.mainnet` to enable `GET /api/admin/tokens/unlisted`.

### Register a service / make a paid call (astralaunch-anvil/src)

Both scripts print everything they will send and ask for "yes" (or pass `--yes`). Keys are read from
env and never printed. Anvil dev keys are refused unless `ALLOW_ANVIL_KEYS=1` (local fork only).

```bash
cd astralaunch-anvil
read -s CREATOR_PRIVATE_KEY && export CREATOR_PRIVATE_KEY     # token's on-chain creator
ASSET=0x… SLUG=my-svc UPSTREAM_URL=https://api.example.com PRICE_USDC=0.01 \
  SERVER_URL=http://localhost:3001 npx tsx src/mainnet-register-service.ts
# optional: SCHEMA='{"type":"object"}' (or a .json path), NAME, DESCRIPTION, TIMEOUT_SECONDS
# an existing SLUG for the same ASSET is updated (price/upstream/description/timeout) with a signed PATCH

read -s AGENT_PRIVATE_KEY && export AGENT_PRIVATE_KEY         # payer wallet, needs USDC
SLUG=my-svc SERVICE_PATH=/json SERVER_URL=http://localhost:3001 \
  MONAD_RPC_URL=https://rpc.monad.xyz npx tsx src/mainnet-pay.ts
```

`PRICE_USDC` is human USDC (0.01), not raw units; above 100 USDC it needs `ALLOW_HIGH_PRICE=1`.
The pay script refuses when `payTo` is not `registry.routers(asset)` on chain, or the wallet lacks USDC.

### Token image and description: set once at launch (2026-10-02)

The token image and brief description are signed only in the launch-details message, the one signature right
after the launch transaction. It is accepted within 1 hour of the launch and only while neither is set yet. After
that they are final: `POST /api/tokens` refuses them with 400 "Image and description can only be set at launch.",
and existing values stay as they are. Uploads that no token references within 24 h are deleted.

Only the X account and website can be changed later, signed by the on-chain creator:

```bash
cd astralaunch-anvil
ASSET=0x… WEBSITE=https://example.com X_HANDLE=@name SERVER_URL=https://api.astralaunch.xyz \
  CREATOR_KEYSTORE=astralaunch-deployer npx tsx src/mainnet-token-details.ts
```

### Demo loop: SIGHT → /sight/signals, FEED → /feed/digest (2026-09-25; re-pointed 2026-09-26)

Prerequisites: SIGHT and FEED listed (legacy listing script above); `apps/server/.env.mainnet` contains
`UPSTREAM_ALLOWLIST=http://127.0.0.1:4001` (demo-services on the same host as the server; if they run in
separate containers, allowlist the internal origin instead, e.g. `http://demo-services:4001`, and set
`DEMO_SERVICES_HOST=0.0.0.0`). Fork proof of the whole loop: docs/VERIFICATION-demo-loop.md.

```bash
# 1. demo-services (127.0.0.1:4001)
pnpm -F @astralaunch/demo-services start

# 2. server with the new build (stop the running one first): migration 0008, then start
cd apps/server
pnpm exec tsx --env-file=.env.mainnet src/db/migrate.ts
pnpm start:mainnet

# 3. register both services, signed by the on-chain creator keystore (hidden password prompt, then "yes")
cd astralaunch-anvil
export SERVER_URL=http://localhost:3001 PRICE_USDC=0.5 CREATOR_KEYSTORE=astralaunch-deployer
ASSET=0x30Ae380593A04C14aBFa994969B718a78A6105aD SLUG=nullsight UPSTREAM_URL=http://127.0.0.1:4001/sight \
  DESCRIPTION="Ranked X-style signals for a handle (sample data)" \
  RESPONSE_SCHEMA=../apps/demo-services/schemas/sight-signals.json npx tsx src/mainnet-register-service.ts
ASSET=0x2686619d5569AEbcdfeC774e8a2167dE78376dDf SLUG=nullfeed UPSTREAM_URL=http://127.0.0.1:4001/feed \
  DESCRIPTION="Latest 5 arXiv papers for a topic" \
  RESPONSE_SCHEMA=../apps/demo-services/schemas/feed-digest.json npx tsx src/mainnet-register-service.ts
unset CREATOR_KEYSTORE

# 4. pay once for each, from an agent wallet that is NOT the creator (needs >= 1 USDC, no MON)
read -s AGENT_PRIVATE_KEY && export AGENT_PRIVATE_KEY     # or: export AGENT_KEYSTORE=<foundry account>
export MONAD_RPC_URL="$(grep '^MONAD_RPC_URL=' ../apps/server/.env.mainnet | cut -d= -f2-)"
SLUG=nullsight SERVICE_PATH='/signals?handle=nullsight' npx tsx src/mainnet-pay.ts
SLUG=nullfeed  SERVICE_PATH='/digest?topic=agent%20payments' npx tsx src/mainnet-pay.ts
unset AGENT_PRIVATE_KEY

# 5. keeper: dry run, then one live tick (KEEPER_PRIVATE_KEY etc. in apps/keeper/.env.mainnet)
cd ../apps/keeper
# Explicit ASSETS/ROUTERS pairs = debug override; normally the keeper discovers listed tokens from the DB.
export ASSETS=0x30Ae380593A04C14aBFa994969B718a78A6105aD,0x2686619d5569AEbcdfeC774e8a2167dE78376dDf
export ROUTERS=0x10bC2220716738E8Aef57b9CC72101c190acf240,0xdBa0705cE9217B9E3dB296AF6a1810eB0467fd3a
export MIN_BUYBACK_USDC=0.1     # one 0.5 USDC payment leaves 0.15 USDC in the vault; default min is 0.5
pnpm exec tsx src/start-mainnet.ts --dry-run --once
pnpm exec tsx src/start-mainnet.ts --once
```

**Re-point the demo services to their own path prefix (2026-09-26).** Both were first registered
with the same upstream base `http://127.0.0.1:4001`, so `/s/nullfeed/sight/signals` reached the SIGHT
endpoint. Each upstreamUrl now carries a prefix and the gateway never leaves it
(`/s/nullsight/<path>` → `http://127.0.0.1:4001/sight/<path>`). Deploy the new server and
demo-services first (the old gateway ignores the prefix), then send a signed PATCH per service. The
price is left unchanged when `PRICE_USDC` is not set:

```bash
cd astralaunch-anvil
export SERVER_URL=http://localhost:3001 CREATOR_KEYSTORE=astralaunch-deployer
unset PRICE_USDC
ASSET=0x30Ae380593A04C14aBFa994969B718a78A6105aD SLUG=nullsight UPSTREAM_URL=http://127.0.0.1:4001/sight \
  npx tsx src/mainnet-register-service.ts
ASSET=0x2686619d5569AEbcdfeC774e8a2167dE78376dDf SLUG=nullfeed UPSTREAM_URL=http://127.0.0.1:4001/feed \
  npx tsx src/mainnet-register-service.ts
unset CREATOR_KEYSTORE
```

Public paths after the change: `/s/nullsight/signals?handle=…` and `/s/nullfeed/digest?topic=…`.

**Example calls (2026-09-29, D-SV2).** "Try a sample call" on the token page runs the service's signed
`examplePath`. Deploy the server with migration 0011 first (an older server drops the unknown field and the
signature check fails), then, signed by the on-chain creator, with price and upstream unchanged:

```bash
cd astralaunch-anvil
export SERVER_URL=https://api.astralaunch.xyz CREATOR_KEYSTORE=astralaunch-deployer
unset PRICE_USDC UPSTREAM_URL
ASSET=0x30Ae380593A04C14aBFa994969B718a78A6105aD SLUG=nullsight EXAMPLE_PATH='/signals?handle=monad' \
  npx tsx src/mainnet-register-service.ts
ASSET=0x2686619d5569AEbcdfeC774e8a2167dE78376dDf SLUG=nullfeed EXAMPLE_PATH='/digest?topic=agent%20payments' \
  npx tsx src/mainnet-register-service.ts
unset CREATOR_KEYSTORE
curl -s https://api.astralaunch.xyz/api/services/nullsight/manifest | grep -o '"examplePath":"[^"]*"'
```

**Response schema update (2026-10-01, D-SV4, D-DS2).** nullfeed stores the old feed-digest schema, where `source`
has a single allowed value. Its fallback answer (`"source": "fallback sample"`) would fail the gateway check: a 502,
not charged. Deploy the server with migration 0014 and the demo-services change first. An older server drops the
unknown field, and the signature check fails. Then, signed by the on-chain creator, with everything else unchanged:

```bash
cd astralaunch-anvil
export SERVER_URL=https://api.astralaunch.xyz CREATOR_KEYSTORE=astralaunch-deployer
unset PRICE_USDC UPSTREAM_URL API_LINK EXAMPLE_PATH DESCRIPTION TIMEOUT_SECONDS REMOVE_SCHEMA
ASSET=0x2686619d5569AEbcdfeC774e8a2167dE78376dDf SLUG=nullfeed \
  RESPONSE_SCHEMA=../apps/demo-services/schemas/feed-digest.json npx tsx src/mainnet-register-service.ts
unset CREATOR_KEYSTORE
```

The script prints `Schema: replaced (N chars)` and the signed message, then asks before sending. Check it:
`POST /api/services/<id>/settings` (Creator page, "Show my settings") shows the new schema and 0 mismatches.
To stop checking responses instead, use `REMOVE_SCHEMA=1` in place of `RESPONSE_SCHEMA=…`.
`EXAMPLE_PATH=''` removes it.
The old `/s/nullsight/sight/signals` now reaches `…/sight/sight/signals` (404 upstream → 502, not charged).
In containers use the internal origin instead: `http://demo-services:4001/sight` and `…/feed`.

### Start (port 3001)

```bash
pnpm -F server start:mainnet
# Listens on http://localhost:3001
```

The server checks `dryRun`, bytecode, and admin wiring before accepting traffic.

---

## 6. Start keeper (mainnet)

Fill in `apps/keeper/.env.mainnet`:

```bash
cd apps/keeper
cp .env.mainnet.example .env.mainnet
# Edit: KEEPER_PRIVATE_KEY (set via read -s at runtime if preferred),
#       DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
```

**Token discovery.** Each tick the keeper reads the tokens to service from the server
database: listed tokens only (launch fee consumed and not admin-hidden, the server's
`isListedSql`), with router, numeraire and pool id. A newly listed token is picked up on
the next tick without a restart, and unlisted spam registrations never cost keeper gas.
Before its first job, each target is cross-checked on-chain (`router.asset()`, registry
numeraire, vault pool id); mismatches are logged and skipped. `ASSETS` (optionally with
`ROUTERS`) overrides discovery for debugging only.

**Health.** `GET /health` on `KEEPER_HEALTH_PORT` (default 8080) returns the last
successful tick, target count and wallet MON balance, and is 503 when no tick succeeded
within 3 × `POLL_INTERVAL_S`. A tick that throws (DB or RPC down) sends a Telegram alert;
identical errors repeat at most hourly, and recovery sends one alert.

### Keeper env vars (optional, defaults are safe)

**Intervals:**

| Var | Default | Description |
|-----|---------|-------------|
| `POLL_INTERVAL_S` | `600` (10 min) | Poll interval. Clamped to min 300s on non-localhost RPC. |
| `COLLECT_INTERVAL_S` | `21600` (6h) | Min seconds between collects per beneficiary per asset. |

**Economic thresholds** (keeper-side gas-saving, independent of on-chain minimums):

| Var | Default | Origin |
|-----|---------|--------|
| `MIN_COLLECT_USDC` | `1` | Skip collect if pending USDC < this. At ~0.1 MON/collect, 1 USDC ≈ 33× gas cost. |
| `MIN_DISTRIBUTE_USDC` | `1` | Skip distribute if router USDC < this. On-chain `MIN_DISTRIBUTE = 0.5 USDC`. |
| `MIN_BUYBACK_USDC` | `1` | Skip buyback if vault USDC < this. No on-chain minimum. |
| `COLLECT_MIN_VALUE_MULTIPLE` | `5` | Skip a collect unless its pending value is ≥ this × the collect's estimated gas cost (gas limit × price). Value in MON: WMON 1:1, USDC via the Chainlink MON/USD feed (skipped if the price is stale > 1h or unreadable). Each skip logs the comparison, e.g. `SKIP — value: pending 0.106 WMON ≈ 0.106 MON (WMON 1:1) vs 5× gas 0.141 MON = 0.705 MON`. Added after a mainnet collect spent 0.141 MON gas to move 0.106 WMON. |

**Spend guards:**

| Var | Default | Description |
|-----|---------|-------------|
| `MAX_MON_PER_DAY` | `0.2` | Maximum MON spend in a rolling 24h window. |
| `MIN_MON_BALANCE` | `0.2` | Minimum wallet balance; keeper stops sending if below. |
| `SINGLE_TX_ALERT` | `0.05` | Single tx cost above this triggers a Telegram warning. |
| `DRY_RUN` | `false` | Set `true` to estimate gas without sending transactions. |

### Step 1: Test Telegram alerts

```bash
read -s KEEPER_PRIVATE_KEY && export KEEPER_PRIVATE_KEY
pnpm -F keeper start:mainnet -- --telegram-test
```

### Step 2: Dry run (required before first live run)

```bash
pnpm -F keeper start:mainnet -- --dry-run
```

Expected output per tick:
```
[keeper] DRY RUN MODE — no transactions will be sent
[keeper] tick — 1 asset(s)  balance=X.XX MON  <timestamp>
[distribute:0xRouter] SKIP — 0 USDC < min 1
[buyback:0xAsset]     SKIP — 0 USDC < min 1
[collect:escrow:0xAsset] SKIP — pending 0 USDC < min 1
[collect:vault:0xAsset]  SKIP — pending 0 USDC < min 1
[collect:pfr:0xAsset]    SKIP — pending 0 USDC < min 1
[forfeit:0xAsset]     SKIP — window opens at ...
```

If fees exist, the job shows `SEND` and logs gas estimate as JSON:
```
[collect:escrow:0xAsset] SEND — pending 5.12 USDC >= min 1
{"dryRun":true,"fn":"collect","to":"0xEscrow","gas":"1020901","gasBuffered":"1122991","monCost":"0.112"}
```

Job order: distribute, buyback (high value, use existing USDC) BEFORE collect (expensive, may have nothing). A spend guard hit from collects never blocks useful work.

### Step 3: Start live

```bash
pnpm -F keeper start:mainnet
```

The keeper runs immediately on start, then `POLL_INTERVAL_S` seconds (default 600s) after each tick ends; ticks never overlap.
Each tick logs wallet balance and SEND/SKIP per job with amounts and reasons.
Collects are gated: pending fee pre-check via `eth_call` + 6h cadence per beneficiary.
If spend guards trigger (24h budget exceeded or balance too low), remaining jobs are skipped and a Telegram alert is sent.

---

## 7. Register BYO service

With the server running on mainnet:

### Sign the registration message

The creator must sign the message: `Astralaunch: register service "nullsight" for token 0x30ae380593a04c14abfa994969b718a78a6105ad`

```bash
# Using cast:
SIG=$(cast wallet sign \
  --account <creator-keystore> \
  "Astralaunch: register service \"nullsight\" for token 0x30ae380593a04c14abfa994969b718a78a6105ad")
echo $SIG
```

### Register

```bash
curl -X POST http://localhost:3001/api/services \
  -H 'Content-Type: application/json' \
  -d '{
    "asset": "0x30Ae380593A04C14aBFa994969B718a78A6105aD",
    "creator": "0x11e2dD9a4B9062675fD89178a2C9778182Dfcbc6",
    "slug": "nullsight",
    "name": "nullsight",
    "upstreamUrl": "https://httpbin.org",
    "priceUsdc": "500000",
    "signature": "'$SIG'",
    "description": "nullsight test endpoint",
    "responseSchema": "{\"type\":\"object\",\"required\":[\"slideshow\"]}"
  }'
```

Expected: `201` with `{ "id": "...", "slug": "nullsight", "router": "0x95D381..." }`.

Verify:

```bash
curl http://localhost:3001/api/services/nullsight/manifest | jq .
```

---

## 8. First paid call

```bash
read -s AGENT_PRIVATE_KEY && export AGENT_PRIVATE_KEY

cd astralaunch-anvil

SERVER_URL=http://localhost:3001 \
SERVICE_SLUG=nullsight \
SERVICE_PATH=/json \
MONAD_RPC_URL=https://rpc.monad.xyz \
  npx tsx src/mainnet-pay.ts
```

The script:
1. Fetches service manifest (payment requirements)
2. Signs EIP-3009 payment (0.5 USDC)
3. Sends paid request through gateway
4. Prints response, router USDC delta, and settlement tx hash

Expected: router balance +500000 (0.5 USDC).

---

## 9. Keeper distribute + verify

After the paid call, the router holds 0.5 USDC. The keeper distributes on its next tick.
For a one-shot run, just start and stop after the first tick:

```bash
# One tick runs immediately on start. Ctrl+C after it finishes.
pnpm -F keeper start:mainnet
```

### Expected distribute() split (0.5 USDC = 500000)

| Recipient | Share | Amount (6 dec) |
|-----------|-------|----------------|
| Provider (creator) | 60% | 300,000 (0.30 USDC) |
| BuybackVault | 30% | 150,000 (0.15 USDC) |
| PlatformFeeReceiver | 10% | 50,000 (0.05 USDC) |
| Escrow allowance | 20% of recorded revenue | 100,000 (0.10 USDC) |

**Buyback (execute)**: skipped until `block.timestamp > balanceLimitEnd` (1790235703, ~12 min after launch).

**PlatformFeeReceiver.collect()**: forwards USDC to treasury `0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C`.

---

## 10. Verify each step on-chain

```bash
RPC=https://rpc.monad.xyz
USDC=0x754704Bc059F8C67012fEd69BC8A327a5aafb603
ASSET=0x30Ae380593A04C14aBFa994969B718a78A6105aD
ROUTER=0x10bC2220716738E8Aef57b9CC72101c190acf240
REGISTRY=0x6B3A79C723AB69f8938C87209E1D9730c739e00c
ESCROW=0xA070ad1387d525E4A180Bdb09B65FD4086858F15
VAULT=0x394F1dcA6011C16BC6e70CA13F6F29767D92171E
PFR=0x2eFE45394d7578dC39c75d06Fe88722118F5Ec76
TREASURY=0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C
CREATOR=0x11e2dD9a4B9062675fD89178a2C9778182Dfcbc6

# ── After paid call ──
# Router should have 0.5 USDC (before distribute)
cast call $USDC "balanceOf(address)(uint256)" $ROUTER --rpc-url $RPC

# ── After keeper distribute ──
# Router should be ~0 (dust remains)
cast call $USDC "balanceOf(address)(uint256)" $ROUTER --rpc-url $RPC

# Provider (creator) received 0.30 USDC
cast call $USDC "balanceOf(address)(uint256)" $CREATOR --rpc-url $RPC

# BuybackVault credited 0.15 USDC (from revenue)
cast call $VAULT "getAssetData(address)" $ASSET --rpc-url $RPC

# PlatformFeeReceiver received 0.05 USDC -> forwarded to treasury
cast call $USDC "balanceOf(address)(uint256)" $TREASURY --rpc-url $RPC

# Escrow: recorded revenue = 0.5 USDC, claimable = 20% = 0.10 USDC
cast call $ESCROW "claimable(address)(uint256)" $ASSET --rpc-url $RPC

# ── After keeper collect (trading fees) ──
# FeeEscrow and BuybackVault call collectFees on the initializer
cast call $USDC "balanceOf(address)(uint256)" $ESCROW --rpc-url $RPC
cast call $USDC "balanceOf(address)(uint256)" $VAULT --rpc-url $RPC

# ── Buyback (only after balanceLimitEnd) ──
cast call $ASSET "balanceLimitEnd()(uint48)" --rpc-url $RPC
# Expected: 1790235703. Wait until block.timestamp > this value.

# Total supply decreases after buyback burn
cast call $ASSET "totalSupply()(uint256)" --rpc-url $RPC
```

---

## 9. Rollback / stop

### Pause new launches

```bash
cast send $REGISTRY "setPause(bool)" true \
  --rpc-url $RPC --account <admin-keystore>
```

### Transfer admin (two-step)

```bash
cast send $REGISTRY "transferAdmin(address)" <NEW_ADMIN> \
  --rpc-url $RPC --account <admin-keystore>
cast send $REGISTRY "acceptAdmin()" \
  --rpc-url $RPC --account <new-admin-keystore>
```

### Change treasury (48h delay)

```bash
cast send $PFR "proposeTreasury(address)" <NEW_TREASURY> \
  --rpc-url $RPC --account <admin-keystore>
# Wait 48 hours, then:
cast send $PFR "acceptTreasury()" \
  --rpc-url $RPC --account <admin-keystore>
```

### What cannot be rolled back

- Deployed contracts (immutable)
- Tokens launched and registered
- Trades executed
- Revenue distributed

---

## 11. Indexer (D24)

The custom indexer replaces Envio. It reads on-chain events and writes to the same Postgres database using `idx_*` tables.

### Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `DATABASE_URL` | *(required)* | Same Postgres as server |
| `MONAD_RPC_URL` | *(required)* | Monad mainnet RPC |
| `MONAD_CHAIN_ID` | `143` | Chain ID |
| `ASTRALAUNCH_REGISTRY_ADDRESS` | *(required)* | AstralaunchRegistry contract |
| `FEE_ESCROW_ADDRESS` | *(required)* | FeeEscrow contract |
| `BUYBACK_VAULT_ADDRESS` | *(required)* | BuybackVault contract |
| `PLATFORM_FEE_RECEIVER_ADDRESS` | *(required)* | PlatformFeeReceiver contract |
| `INDEXER_START_BLOCK` | `107840649` | Deployment block |
| `INDEXER_CHUNK_SIZE` | `10000` | Blocks per getLogs call |
| `INDEXER_POLL_INTERVAL_S` | `10` | Follow mode poll interval |
| `INDEXER_FINALITY_BLOCKS` | `0` | Monad has instant finality |

### Backfill (one-time, run to head and exit)

```bash
cd apps/indexer
DATABASE_URL=$MAINNET_DB \
MONAD_RPC_URL=https://rpc.monad.xyz \
  pnpm start --backfill
```

Expected: processes all blocks from 107840649 to head, writes events to `idx_*` tables, exits.

### Follow mode (long-running service)

```bash
cd apps/indexer
DATABASE_URL=$MAINNET_DB \
MONAD_RPC_URL=https://rpc.monad.xyz \
  pnpm start --follow
```

Deploy as a Coolify service alongside server and keeper.

### Health check

Query `idx_checkpoints` for staleness:

```sql
SELECT contract_set, block_number, updated_at,
       NOW() - updated_at AS lag
FROM idx_checkpoints;
```

Alert if `lag > 5 minutes` in follow mode.

### Expected block processing rate

- Backfill: ~5,000-10,000 blocks/second (most blocks have no relevant events)
- Follow: real-time, ~10s poll interval
- At current event volume (~1 event/10 min), each poll processes 0-1 events
