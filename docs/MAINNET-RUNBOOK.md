# Mainnet Deploy Runbook

> Generated: 2026-09-24 | Dry-run: Monad mainnet (chain 143) via `forge script` (no broadcast)

---

## Wallets

| Role | Address |
|------|---------|
| Deployer | `0x11e2dD9a4B9062675fD89178a2C9778182Dfcbc6` (keystore: `revpad-deployer`) |
| Admin | `0xe89f19D370F496520803e7ABb30c1A20B04B0f7f` |
| Treasury | `0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C` |

---

## Output file separation

Fork and mainnet both use chain id 143. `DEPLOY_OUTPUT` is **mandatory** (no default).

| Context | `DEPLOY_OUTPUT` | `FOUNDRY_BROADCAST` |
|---------|-----------------|---------------------|
| **Fork** | `../../revpad-anvil/.anvil-state/contracts.json` | *(unset, uses default `broadcast/`)* |
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
| 5 | RevpadRegistry | 1,290,801 | 1,603,196 |

### Keystore setup

```bash
cast wallet import revpad-deployer --interactive
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
  --account revpad-deployer \
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
| RevpadRegistry | `0x25845Cee2b0E6dF0DA40bb9B60A84D162eabd00B` |

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
cd revpad-anvil

CONTRACTS_JSON_PATH=../packages/contracts/deployments/monad-mainnet.json \
MONAD_RPC_URL=https://rpc.monad.xyz \
TOKEN_NAME="Revpad" \
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

## 5. Start server

```bash
# Contracts (from deployments/monad-mainnet.json)
USDC_ADDRESS=0x754704Bc059F8C67012fEd69BC8A327a5aafb603
PLATFORM_FEE_RECEIVER_ADDRESS=$(jq -r .platformFeeReceiver deployments/monad-mainnet.json)
REVPAD_REGISTRY_ADDRESS=$(jq -r .registry deployments/monad-mainnet.json)
FEE_ESCROW_ADDRESS=$(jq -r .escrow deployments/monad-mainnet.json)
BUYBACK_VAULT_ADDRESS=$(jq -r .vault deployments/monad-mainnet.json)

# Point to contracts JSON for dryRun check
CONTRACTS_JSON_PATH=packages/contracts/deployments/monad-mainnet.json

# Admin verification (server checks .admin() on startup)
ADMIN_ADDRESS=0xe89f19D370F496520803e7ABb30c1A20B04B0f7f

MONAD_RPC_URL=https://rpc.monad.xyz
MONAD_CHAIN_ID=143
X402_FACILITATOR_URL=https://x402-facilitator.molandak.org
FACILITATOR_SUBMITTER_ADDRESSES=0x7f6a2850669202519f0FE8aa912451238820Db86
PAYMENT_TIMEOUT_SECONDS=60
GATEWAY_HMAC_MASTER_KEY=<openssl rand -hex 32>
DATABASE_URL=postgresql://revpad:<pw>@<host>:5432/revpad
PRIVY_APP_ID=<app id>
PRIVY_APP_SECRET=<app secret>
LITELLM_BASE_URL=<url>
LITELLM_API_KEY=<key>
```

The server:
1. Checks `dryRun` flag in `CONTRACTS_JSON_PATH` -- refuses to start if `true`
2. Verifies all contract addresses have bytecode on chain
3. If `ADMIN_ADDRESS` is set, checks `RevpadRegistry.admin()` and `PlatformFeeReceiver.admin()` match

```bash
pnpm -F server dev
```

---

## 6. Start keeper

```bash
MONAD_RPC_URL=https://rpc.monad.xyz
KEEPER_PRIVATE_KEY=<funded keeper wallet>
ASSETS=<comma-separated asset addresses>
ROUTERS=<comma-separated router addresses>
CONTRACTS_JSON_PATH=packages/contracts/deployments/monad-mainnet.json
PLATFORM_FEE_RECEIVER_ADDRESS=$(jq -r .platformFeeReceiver deployments/monad-mainnet.json)
REVPAD_REGISTRY_ADDRESS=$(jq -r .registry deployments/monad-mainnet.json)
FEE_ESCROW_ADDRESS=$(jq -r .escrow deployments/monad-mainnet.json)
BUYBACK_VAULT_ADDRESS=$(jq -r .vault deployments/monad-mainnet.json)
ADMIN_ADDRESS=0xe89f19D370F496520803e7ABb30c1A20B04B0f7f
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_CHAT_ID=<chat id>
POLL_INTERVAL_S=30
```

```bash
pnpm -F keeper dev -- --telegram-test   # test alerts first
pnpm -F keeper dev
```

---

## 7. First paid call

```bash
cd revpad-anvil
echo "REAL_PRIVATE_KEY=<private key with USDC balance>" > .env.real
npx tsx src/real-02-pay.ts
```

---

## 8. Verify each step

```bash
RPC=https://rpc.monad.xyz
ROUTER=<router address from registration>
ESCROW=$(jq -r .escrow deployments/monad-mainnet.json)
VAULT=$(jq -r .vault deployments/monad-mainnet.json)
PFR=$(jq -r .platformFeeReceiver deployments/monad-mainnet.json)

cast call 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 \
  "balanceOf(address)(uint256)" $ROUTER --rpc-url $RPC
cast call 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 \
  "balanceOf(address)(uint256)" $ESCROW --rpc-url $RPC
cast call 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 \
  "balanceOf(address)(uint256)" $VAULT --rpc-url $RPC
cast call 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 \
  "balanceOf(address)(uint256)" $PFR --rpc-url $RPC
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
