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

| # | Contract | Gas Used | Gas Limit (×1.1) |
|---|----------|----------|-------------------|
| 1 | FeeEscrow | 801,058 | 1,020,901 |
| 2 | BuybackVault | 1,051,189 | 1,320,650 |
| 3 | PlatformFeeReceiver | 532,846 | 699,311 |
| 4 | RevenueRouter (impl) | 413,074 | 554,648 |
| 5 | RevpadRegistry | 1,290,801 | 1,603,196 |

### Keystore setup

```bash
# Import deployer key (one-time)
cast wallet import revpad-deployer --interactive
```

### Environment variables

Set in shell or `.env` before deploy:

```bash
export ADMIN_ADDRESS=0xe89f19D370F496520803e7ABb30c1A20B04B0f7f
export TREASURY_ADDRESS=0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C
```

### Verify hardcoded addresses

All 7 hardcoded addresses were verified to have bytecode on Monad mainnet (2026-09-24):

| Address | Purpose | Status |
|---------|---------|--------|
| `0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e` | PoolManager | PASS (48,020 chars) |
| `0xCe3099B2F07029b086E5e92a1573C5f5A3071783` | Initializer | PASS (30,228 chars) |
| `0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12` | Airlock | PASS (11,416 chars) |
| `0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731` | NoMigrator | PASS (1,076 chars) |
| `0x580ca49389d83b019d07E17e99454f2F218e2dc0` | DopplerHook | PASS (6,632 chars) |
| `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | USDC | PASS (3,598 chars) |
| `0x21E2ce70511e4FE542a97708e89520471DAa7A66` | Airlock owner | PASS (344 chars) |

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

ADMIN_ADDRESS=0xe89f19D370F496520803e7ABb30c1A20B04B0f7f \
TREASURY_ADDRESS=0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C \
forge script script/Deploy.s.sol \
  --rpc-url https://rpc.monad.xyz \
  --broadcast \
  --account revpad-deployer \
  --gas-estimate-multiplier 110
```

The script deploys 5 contracts in nonce order and writes `contracts.json`.

**Expected output** (assuming deployer nonce = 0):

| Contract | Predicted Address |
|----------|-------------------|
| FeeEscrow | `0x22523FeEA974939Fd6c94dAF7F9d112D667DeC3B` |
| BuybackVault | `0xcBe741362a59943174f028a44A1b82722c24e7E7` |
| PlatformFeeReceiver | `0x510cb102906a4bE9193B025620f6824ee8b4eC21` |
| RevenueRouter (impl) | `0x2bcee60E8a8BD4b2c52aAfA8B57d47D427dACb09` |
| RevpadRegistry | `0x25845Cee2b0E6dF0DA40bb9B60A84D162eabd00B` |

> Addresses depend on deployer nonce. If deployer has sent any previous txs, addresses will differ. Check deployer nonce first: `cast nonce 0x11e2dD9a4B9062675fD89178a2C9778182Dfcbc6 --rpc-url https://rpc.monad.xyz`

---

## 3. Verify wiring

After broadcast, verify admin and treasury are NOT the deployer:

```bash
RPC=https://rpc.monad.xyz

# Read addresses from deploy output / contracts.json
REGISTRY=<RevpadRegistry address>
PFR=<PlatformFeeReceiver address>

# Registry admin
cast call $REGISTRY "admin()(address)" --rpc-url $RPC
# Expected: 0xe89f19D370F496520803e7ABb30c1A20B04B0f7f

# PFR admin
cast call $PFR "admin()(address)" --rpc-url $RPC
# Expected: 0xe89f19D370F496520803e7ABb30c1A20B04B0f7f

# PFR treasury
cast call $PFR "treasury()(address)" --rpc-url $RPC
# Expected: 0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C

# Registry → PFR cross-ref
cast call $REGISTRY "platformFeeReceiver()(address)" --rpc-url $RPC
# Expected: $PFR address

# Registry paused = false
cast call $REGISTRY "paused()(bool)" --rpc-url $RPC
# Expected: false
```

**Admin/treasury wiring in `Deploy.s.sol`:**
- Line 46: `admin = vm.envOr("ADMIN_ADDRESS", msg.sender)` — env var overrides deployer
- Line 47: `treasury = vm.envOr("TREASURY_ADDRESS", msg.sender)` — env var overrides deployer
- Line 60: `PlatformFeeReceiver(futureRegistry, INITIALIZER, treasury, admin)` — gets both from env
- Lines 62-63: `RevpadRegistry(address(pfr), ..., admin)` — gets admin from env

Deployer address is never stored as admin or treasury when env vars are set.

---

## 4. Launch first token

Use the Doppler SDK launch script with `creator = deployer` (or a separate creator wallet):

```bash
cd revpad-anvil

# Set CONTRACTS_JSON_PATH to the mainnet contracts.json
export CONTRACTS_JSON_PATH=../packages/contracts/broadcast/Deploy.s.sol/143/run-latest.json

# Or manually set:
export ESCROW_ADDRESS=<FeeEscrow>
export BUYBACK_ADDRESS=<BuybackVault>
export PLATFORM_FEE_RECEIVER_ADDRESS=<PFR>
export REGISTRY_ADDRESS=<RevpadRegistry>

# Launch (adapts 02-launch.ts for mainnet — creator needs MON for gas)
npx tsx src/02-launch.ts
```

After launch, register the asset:

```bash
# The register call is done by the launch script or manually:
cast send $REGISTRY "register(address,address)(address)" \
  <ASSET_ADDRESS> <CREATOR_ADDRESS> \
  --rpc-url $RPC \
  --account revpad-deployer \
  --gas-limit 500000
```

Verify registration:

```bash
cast call $REGISTRY "isRegistered(address)(bool)" <ASSET_ADDRESS> --rpc-url $RPC
# Expected: true

cast call $REGISTRY "routers(address)(address)" <ASSET_ADDRESS> --rpc-url $RPC
# Returns the deployed RevenueRouter clone address
```

---

## 5. Start server

Set environment variables in `apps/server/.env` (or Coolify env):

```bash
# Chain
MONAD_RPC_URL=https://rpc.monad.xyz
MONAD_CHAIN_ID=143

# x402
X402_FACILITATOR_URL=https://x402-facilitator.molandak.org
FACILITATOR_SUBMITTER_ADDRESSES=0x7f6a2850669202519f0FE8aa912451238820Db86

# Contracts (from deploy output)
USDC_ADDRESS=0x754704Bc059F8C67012fEd69BC8A327a5aafb603
PLATFORM_FEE_RECEIVER_ADDRESS=<PFR>
REVPAD_REGISTRY_ADDRESS=<Registry>
FEE_ESCROW_ADDRESS=<Escrow>
BUYBACK_VAULT_ADDRESS=<Vault>
TREASURY_ADDRESS=0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C

# Gateway — mainnet values
PAYMENT_TIMEOUT_SECONDS=60
GATEWAY_HMAC_MASTER_KEY=<openssl rand -hex 32>
# Do NOT set ALLOW_LOCAL_UPSTREAMS on mainnet

# Auth
PRIVY_APP_ID=<app id>
PRIVY_APP_SECRET=<app secret>

# Database
DATABASE_URL=postgresql://revpad:<pw>@<host>:5432/revpad

# AI
LITELLM_BASE_URL=<url>
LITELLM_API_KEY=<key>
```

```bash
pnpm -F server dev   # or production start via Coolify
```

---

## 6. Start keeper

Set environment variables in `apps/keeper/.env`:

```bash
MONAD_RPC_URL=https://rpc.monad.xyz
KEEPER_PRIVATE_KEY=<funded keeper wallet — NOT deployer, NOT admin>
ASSETS=<comma-separated asset addresses>
ROUTERS=<comma-separated router addresses, same order as ASSETS>

# Contracts
PLATFORM_FEE_RECEIVER_ADDRESS=<PFR>
REVPAD_REGISTRY_ADDRESS=<Registry>
FEE_ESCROW_ADDRESS=<Escrow>
BUYBACK_VAULT_ADDRESS=<Vault>

# Optional: Telegram alerts for treasury proposals + admin transfers
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_CHAT_ID=<chat id>

POLL_INTERVAL_S=30
```

```bash
# Test Telegram alerts first
pnpm -F keeper dev -- --telegram-test

# Start keeper
pnpm -F keeper dev
```

The keeper runs 5 jobs per asset every `POLL_INTERVAL_S`:
1. `collect` — pull Doppler trading fees (escrow + vault)
2. `collectPFR` — pull platform trading fees
3. `distribute` — forward revenue from routers
4. `buyback` — swap + burn
5. `forfeit` — redirect abandoned escrow to vault (after 365 days)

**Keeper wallet balance alert:** monitor the keeper wallet MON balance. Top up when it drops below 0.5 MON.

---

## 7. First paid call

Use `real-02-pay.ts` to send a 0.02 USDC payment through the x402 gateway:

```bash
cd revpad-anvil

# Create .env.real with a funded wallet (NOT an Anvil dev key)
echo "REAL_PRIVATE_KEY=<private key with USDC balance>" > .env.real

npx tsx src/real-02-pay.ts
```

The script:
1. Sends a payment of 0.02 USDC via x402 to the Monad official facilitator
2. Requires interactive "yes" confirmation
3. Reports settlement tx hash

---

## 8. Verify each step

After the first paid call, verify on-chain state:

```bash
RPC=https://rpc.monad.xyz
ROUTER=<router address from registration>
ESCROW=<FeeEscrow address>
VAULT=<BuybackVault address>
PFR=<PlatformFeeReceiver address>

# Check router USDC balance (should have received payment)
cast call 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 \
  "balanceOf(address)(uint256)" $ROUTER --rpc-url $RPC

# After keeper distributes, check escrow/vault/PFR received their shares
cast call 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 \
  "balanceOf(address)(uint256)" $ESCROW --rpc-url $RPC

cast call 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 \
  "balanceOf(address)(uint256)" $VAULT --rpc-url $RPC

cast call 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 \
  "balanceOf(address)(uint256)" $PFR --rpc-url $RPC

# Check Doppler trading fee events (after trades)
cast logs --from-block latest --address $ESCROW --rpc-url $RPC
```

---

## 9. Rollback / stop

Contracts are immutable once deployed. Available emergency controls:

### Pause new launches

```bash
cast send $REGISTRY "setPause(bool)" true \
  --rpc-url $RPC --account <admin-keystore>
```

This prevents new `register()` calls. Existing tokens continue to function.

### Transfer admin (two-step)

```bash
# Step 1: current admin initiates
cast send $REGISTRY "transferAdmin(address)" <NEW_ADMIN> \
  --rpc-url $RPC --account <admin-keystore>

# Step 2: new admin accepts
cast send $REGISTRY "acceptAdmin()" \
  --rpc-url $RPC --account <new-admin-keystore>

# Cancel if needed
cast send $REGISTRY "cancelAdminTransfer()" \
  --rpc-url $RPC --account <admin-keystore>
```

Same two-step pattern applies to PlatformFeeReceiver admin.

### Change treasury (48h delay)

```bash
# Step 1: admin proposes
cast send $PFR "proposeTreasury(address)" <NEW_TREASURY> \
  --rpc-url $RPC --account <admin-keystore>

# Step 2: wait 48 hours, then admin accepts
cast send $PFR "acceptTreasury()" \
  --rpc-url $RPC --account <admin-keystore>

# Cancel if needed
cast send $PFR "cancelProposal()" \
  --rpc-url $RPC --account <admin-keystore>
```

### Stop server / keeper

```bash
# Server: stop the Coolify service or kill the process
# Keeper: stop the Coolify service or kill the process
# Existing contracts remain functional — users can interact directly
```

### What cannot be rolled back

- Deployed contracts (no upgradeable proxies)
- Tokens already launched and registered
- Trades already executed
- Revenue already distributed
