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

### Expected output (deployer nonce = 0)

| Contract | Predicted Address |
|----------|-------------------|
| FeeEscrow | `0x22523FeEA974939Fd6c94dAF7F9d112D667DeC3B` |
| BuybackVault | `0xcBe741362a59943174f028a44A1b82722c24e7E7` |
| PlatformFeeReceiver | `0x510cb102906a4bE9193B025620f6824ee8b4eC21` |
| RevenueRouter (impl) | `0x2bcee60E8a8BD4b2c52aAfA8B57d47D427dACb09` |
| AstralaunchRegistry | `0x25845Cee2b0E6dF0DA40bb9B60A84D162eabd00B` |

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
REGISTRY=0x25845Cee2b0E6dF0DA40bb9B60A84D162eabd00B

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
#       PRIVY_APP_ID, PRIVY_APP_SECRET, LITELLM_BASE_URL, LITELLM_API_KEY
```

### Run migrations

```bash
pnpm -F server db:migrate
```

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
#       ASSETS, ROUTERS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
```

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

The keeper runs immediately on start, then every `POLL_INTERVAL_S` seconds (default 600s).
Each tick logs wallet balance and SEND/SKIP per job with amounts and reasons.
Collects are gated: pending fee pre-check via `eth_call` + 6h cadence per beneficiary.
If spend guards trigger (24h budget exceeded or balance too low), remaining jobs are skipped and a Telegram alert is sent.

---

## 7. Register BYO service

With the server running on mainnet:

### Sign the registration message

The creator must sign the message: `Astralaunch: register service "nullsight" for token 0x13db78bd3f92382306a17d50dac93af1904e171d`

```bash
# Using cast:
SIG=$(cast wallet sign \
  --account <creator-keystore> \
  "Astralaunch: register service \"nullsight\" for token 0x13db78bd3f92382306a17d50dac93af1904e171d")
echo $SIG
```

### Register

```bash
curl -X POST http://localhost:3001/api/services \
  -H 'Content-Type: application/json' \
  -d '{
    "asset": "0x13DB78bd3F92382306a17d50dAC93Af1904e171d",
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
ASSET=0x13DB78bd3F92382306a17d50dAC93Af1904e171d
ROUTER=0x95D381aa54A2DA62C835Dd081D1D5a0f8700C722
REGISTRY=0x25845Cee2b0E6dF0DA40bb9B60A84D162eabd00B
ESCROW=0x22523FeEA974939Fd6c94dAF7F9d112D667DeC3B
VAULT=0xcBe741362a59943174f028a44A1b82722c24e7E7
PFR=0x510cb102906a4bE9193B025620f6824ee8b4eC21
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
| `INDEXER_START_BLOCK` | `107534868` | Deployment block |
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

Expected: processes all blocks from 107534868 to head, writes events to `idx_*` tables, exits.

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
