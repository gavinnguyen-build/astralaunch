# Revpad Anvil Verification Report

**Date:** 2026-09-22
**Fork block:** 106905849 (Monad mainnet, `https://rpc.monad.xyz`)
**Fork timestamp:** 2026-09-22T02:04:00 UTC (1790042640)

## SDK Versions (package.json)

| Package | Declared | Installed |
|---|---|---|
| `@whetstone-research/doppler-sdk` | 1.0.43 | 1.0.43 |
| `@x402/core` | 2.26.0 | 2.26.0 |
| `@x402/evm` | 2.26.0 | 2.26.0 |
| `viem` | ^2.21.0 | 2.56.8 |
| `tsx` | ^4.19.0 | devDep |
| `typescript` | ^5.6.0 | devDep |

**Foundry:** anvil 1.8.3 / cast 1.8.3
**Node.js:** v24.14.0

---

## Step Results Table

| # | Command | PASS/FAIL | Key numbers / notes |
|---|---|---|---|
| 1 | Prerequisites | PASS | anvil 1.8.3, cast 1.8.3, node v24.14.0; npm install clean; typecheck 0 errors |
| 2 | `./anvil/start-fork.sh` | PASS | fork block 106905849, chain-id 143 confirmed within 1s |
| 3 | `./anvil/fund.sh 10000` | PASS | USDC slot=9; creator/trader/agent each 10,000 USDC; EIP-7702 delegations cleared on first run (see fixes) |
| 4 | `npm run check` | PASS | See module table below; Airlock owner `0x21E2ce70511e4FE542a97708e89520471DAa7A66`; USDC name="USDC", version="2", decimals=6, EIP-3009 callable; on-chain version = "2" matches `USDC_EIP712_VERSION=2` — no `.env.anvil` update needed |
| 5 | `./anvil/snapshot.sh save` | PASS | Snapshot `0x2` saved |
| 6 | x402: facilitator + pay | PASS | All 6/6 assertions pass; settle tx `0xeab043...`; payTo received 0.02 USDC; replay rejected (`invalid_exact_evm_nonce_already_used`); tampered amount rejected (`invalid_exact_evm_payload_authorization_value_mismatch`) |
| 7 | `npm run launch` | PASS | `POOL_FEE=20000` (2%) succeeded; gasUsed **4,547,173**; token `0xC25b98ED37d0ddb5C5b0948D6F4aba432C524034`; pool fee=20000, tickSpacing=200, status=2 (active); total supply 1e9; creator holds 0 at launch (allocation vested). No revert → POOL_FEE=10000 retry not needed. |
| 8a | `npm run trade -- 200` (within cap) | PASS (expected revert) | Reverted with custom error `0x90bfb865` (DopplerERC20V1 `BalanceLimitExceeded`); 200 USDC would exceed 1% supply cap in first 10 min |
| 8b | `./anvil/time-travel.sh 0.01` | PASS | Advanced ~14.4 min; block timestamp 1790044639 |
| 8c | `npm run trade -- 200` (after cap) | PASS | Bought 14,373,800.46 tokens; sold half; received 107.74 USDC back |
| 9 | `npm run trade -- 50` | PASS | Bought 3,359,915.48 tokens; sold half; received 24.52 USDC back; cumulative buys 250 USDC |
| 10 | `npm run fees` | PASS | See fee table below; USDC fees = **2.000%** of buy vol; token fees = **2.000%** of sell vol; all 4 share splits within 0.01% of expected |
| 11 | `npm run vesting` | PASS | day 0→0, day 29→0, day 31→12.74M, day 182→74.8M (49.8%), day 366→150M (100%); fork reverted after test |
| 12 | Stop Anvil | PASS | Process killed; port 8545 connection refused confirmed |

### Doppler Module Check (Step 4)

| Module | Deployed? | Address |
|---|---|---|
| airlock | **yes** | `0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12` |
| dopplerERC20V1Factory | **yes** | `0xf1542Dd2D46394C16372FB00f2c339b53CeF2cE5` |
| v4ScheduledMulticurveInitializer | **yes** | `0xCe3099B2F07029b086E5e92a1573C5f5A3071783` |
| v4MulticurveInitializer | **NO** | not in SDK for chain 143 |
| v4DecayMulticurveInitializer | **NO** | not in SDK for chain 143 |
| dopplerHookInitializer | **yes** | `0x56ea13Da5f39863D3B3d54826187306Af7ada544` |
| noOpMigrator | **yes** | `0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731` |
| noOpGovernanceFactory | **yes** | `0xb4deE32EB70A5E55f3D2d861F49Fb3D79f7a14d9` |
| poolManager | **yes** | `0x188d586ddcf52439676ca21a244753fa19f9ea8e` |
| universalRouter | **yes** | `0x0d97dc33264bfc1c226207428a79b26757fb9dc3` |
| permit2 | **yes** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

### Fee Split (Step 10)

Total volume: 250 USDC buys, 8,866,857.97 tokens sold.

| Beneficiary | Share config | USDC received | Token received | Actual USDC % of pool |
|---|---|---|---|---|
| Doppler (airlock owner) | 5% | 0.25 USDC | 8,866,857.97 | 5.0% |
| creator | 35% | 1.75 USDC | 62,068.01 | 36.84% of non-Doppler |
| escrowStub (FeeEscrow) | 20% | 1.00 USDC | 35,467.43 | 21.05% of non-Doppler |
| buybackStub (BuybackVault) | 10% | 0.50 USDC | 17,733.72 | 10.53% of non-Doppler |
| treasury | 30% | 1.50 USDC | 53,201.15 | 31.58% of non-Doppler |
| **Total** | **100%** | **5.00 USDC** | **177,337.27** | **2.000% of buy vol** |

Note: Doppler takes 5% of total fees as the platform cut. The remaining 95% is split 35/20/10/30 among project beneficiaries. Each beneficiary only received tokens when they explicitly called `collectFees()` themselves.

### Vesting Schedule (Step 11)

VESTED_TOKENS = 150,000,000 (15% of 1B supply)

| Day | Available tokens | % of total vested |
|---|---|---|
| 0 | 0 | 0% |
| 29 | 0 | 0% (cliff not reached) |
| 31 | 12,744,668 | 8.5% |
| 182 | 74,799,463 | 49.8% |
| 366 | 150,000,000 | 100% |

---

## Code Fixes

### Fix 1: `anvil/fund.sh` — Clear EIP-7702 delegations

**Reason:** At fork block 106905847 (first fork attempt), all Anvil dev accounts (indices 0–6) had 23-byte EIP-7702 delegation bytecode (`0xef0100<target>`) on Monad mainnet. The x402 facilitator's `verifyHashSignatureWithCode` branched to `verifyERC1271` (smart-account path) instead of ECDSA recovery. The delegated contract at `0x1e40c78ae4d114b4a4c42dece4fefd00199ca378` reverts `isValidSignature`, so every payment verification returned `invalid_exact_evm_signature`.

**Diff:** Added a block before slot-finding that iterates accounts 0–6, checks for non-zero code, and calls `cast rpc anvil_setCode <addr> 0x` to restore plain EOA status on the local fork.

```diff
+# Clear EIP-7702 delegation code that Monad mainnet has on all well-known Anvil dev accounts.
+echo "Clearing EIP-7702 delegations from dev accounts (Monad mainnet fork artifact)..."
+for i in 0 1 2 3 4 5 6; do
+  ADDR=$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index "$i")
+  CODE=$(cast code "$ADDR" --rpc-url "$RPC" 2>/dev/null || echo "0x")
+  if [[ "$CODE" != "0x" ]]; then
+    cast rpc anvil_setCode "$ADDR" "0x" --rpc-url "$RPC" >/dev/null
+    echo "  account $i $ADDR: cleared EIP-7702 delegation"
+  fi
+done
```

**Note:** On the second Anvil run (fork block 106905849) the delegations were already absent, confirming Monad cleared them in those 2 blocks. The guard is retained for reproducibility with any fork block.

---

### Fix 2: `anvil/start-fork.sh` — Add `--block-time 1`

**Reason:** The Doppler SDK's `createMulticurve` internally calls `waitForTransactionReceipt({ confirmations: 2 })`, which requires 2 blocks to be mined after the tx block. Anvil's default instant-mining mode only mines a block when a transaction arrives; after the launch tx there are no further transactions, so no new blocks are mined and the 180-second viem timeout is reached.

**Diff:**
```diff
 ARGS=(
   --fork-url "$MONAD_RPC_URL"
   ...
+  --block-time 1              # auto-mine every 1 s so Doppler SDK's confirmations:2 resolves
 )
```

**Status:** `--block-time 1` enabled interval mining in the ARGS but in practice Anvil v1.8.3 did NOT auto-mine empty blocks on a fork. The fix below (Fix 3) was additionally required.

---

### Fix 3: `src/02-launch.ts` — Background block miner during `createMulticurve`

**Reason:** Even with `--block-time 1` in start-fork.sh, Anvil v1.8.3 does not auto-produce empty interval blocks on a fork. The SDK's `waitForTransactionReceipt({ confirmations: 2 })` needs 2 blocks mined after the tx block. Without this, it always times out regardless of timeout duration.

**Diff:**
```diff
-  console.log('Creating...');
-  const res = await sdk.factory.createMulticurve(params);
+  console.log('Creating...');
+  // Doppler SDK calls waitForTransactionReceipt({ confirmations: 2 }), which requires two
+  // blocks to be mined after the tx block.  Anvil's --block-time does not mine empty
+  // interval blocks on a fork, so we drive mining ourselves while awaiting the SDK call.
+  const miner = setInterval(() => testClient.mine({ blocks: 1 }).catch(() => {}), 1000);
+  const res = await sdk.factory.createMulticurve(params).finally(() => clearInterval(miner));
```

---

### Fix 4: `src/02-launch.ts` — Wall-clock `now` for `startTime`

**Reason:** The SDK client-side validates `balanceLimitEnd > Math.floor(Date.now() / 1000)` using **wall-clock time**. After an `evm_revert`, the Anvil block timestamp reverts to the snapshot point (02:04 UTC) while real time has advanced ~16 minutes. `startTime = blockTimestamp + 2` produces a `balanceLimitEnd` ~994 seconds in the past relative to wall clock, causing the SDK to throw `token.balanceLimitEnd must be in the future`.

**Diff:**
```diff
-  const now = Number((await publicClient.getBlock()).timestamp);
+  // Use wall clock for startTime: the SDK validates balanceLimitEnd > Date.now()/1000.
+  // On a reverted fork the block timestamp can lag real time by minutes, causing the
+  // SDK's client-side guard to throw even when startTime is future relative to the block.
+  const now = Math.max(Number((await publicClient.getBlock()).timestamp), Math.floor(Date.now() / 1000));
```

---

### Fix 5: `src/env.ts` — Add `multicall3` to `monadFork` chain definition

**Reason:** The Doppler SDK's `getPendingFees` calls `callAggregate3`, which reads `client.chain.contracts.multicall3.address`. The `monadFork` chain definition had no `contracts` block. Without it, every `npm run fees` call throws `Multicall3 address is not configured on this chain`. Multicall3 is deployed at the canonical `0xcA11bde05977b3631167028862bE2a173976CA11` on Monad mainnet.

**Diff:**
```diff
 export const monadFork = defineChain({
   id: CHAIN_ID,
   name: 'Monad (Anvil fork)',
   nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
   rpcUrls: { default: { http: [RPC_URL] } },
+  // Doppler SDK's getPendingFees calls callAggregate3, which reads chain.contracts.multicall3.
+  // Multicall3 is deployed at the canonical address on Monad mainnet.
+  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
 });
```

---

## Impact on SPEC

### a) Does a 2% fee work on Monad's scheduled multicurve? (SPEC D4)

**YES.** `POOL_FEE=20000` (2% in Uniswap v4 units) with `TICK_SPACING=200` launched successfully. Pool state confirmed `fee=20000, tickSpacing=200`. USDC-side fees collected at exactly 2.000% of buy volume. The scheduled multicurve is the only multicurve initializer available for Monad in SDK 1.0.43 (`v4MulticurveInitializer` and `v4DecayMulticurveInitializer` are absent).

### b) Is a decaying anti-snipe fee available on Monad? (SPEC O2)

**NO.** `v4DecayMulticurveInitializer` is not in SDK 1.0.43 for chain 143 and has no deployed contract address. The per-wallet balance cap (`maxBalanceLimit`/`balanceLimitEnd`) in DopplerERC20V1 provides a substitute anti-snipe mechanism during the first 10 minutes (confirmed by test). The `dopplerHookInitializer` (Rehype) is deployed but was not tested here; README notes it has decay-like fee behavior.

### c) Does the DopplerERC20V1 per-wallet balance cap work? (SPEC O3)

**YES.** Within 10 minutes of launch, buying 200 USDC reverted with `0x90bfb865` (`BalanceLimitExceeded`). After `time-travel.sh 0.01` (past `balanceLimitEnd`), the same 200 USDC buy succeeded. The cap is enforced natively in DopplerERC20V1 without a separate contract.

### d) Does vesting enforce the 30-day cliff? (SPEC §4.5)

**YES.** `computeAvailableVestedAmount` returns 0 at day 0 and day 29. It returns 12,744,668 tokens at day 31 (just past the cliff). The schedule is linear from cliff to 365 days. At day 366 the full 150,000,000 tokens (15% of supply) are available.

### e) Do beneficiaries receive fees only by calling collectFees themselves? (SPEC §6.3–6.4)

**YES.** In test 04, each role's wallet explicitly called `pool.collectFees()` through its own SDK instance. Only after that call did the USDC/token balance change. Beneficiaries (including the escrowStub and buybackStub stand-ins for FeeEscrow and BuybackVault) receive nothing passively — they must each invoke `collectFees()` themselves. This means FeeEscrow and BuybackVault contracts MUST implement and call `collectFees()` to receive their shares.

### f) Launch gas used (Anvil value, not Monad billing)

**4,547,173 gas** (Anvil/Ethereum opcode pricing). Simulation estimate was 4,544,373. The SDK-buffered gas limit for real Monad: ~4,998,810. Well under Monad's 30M per-tx limit. Note: Monad bills by gas limit, not gas used, and uses different opcode pricing — re-measure on testnet before billing estimates.

### g) Anything that contradicts SPEC.md or README findings

1. **EIP-7702 on Anvil dev accounts (not in README):** All Monad mainnet well-known Anvil dev addresses (mnemonic index 0–6) had EIP-7702 delegation code at fork block 106905847. This silently breaks ECDSA signature verification in x402 (steers to ERC-1271 path which reverts). Not mentioned in README. Must clear code via `anvil_setCode` before x402 tests. By block 106905849 these delegations were absent (transient state on Monad mainnet).

2. **`v4MulticurveInitializer` / `v4DecayMulticurveInitializer` absent (matches README §1):** Confirmed absent. Only `v4ScheduledMulticurveInitializer` is usable. README finding is correct.

3. **Multicall3 missing from chain definition (not in README):** `monadFork = defineChain({...})` in `env.ts` omitted `contracts.multicall3`, causing `getPendingFees` to fail. Monad does have Multicall3 at the canonical address.

4. **Doppler SDK `confirmations: 2` vs Anvil fork (not in README):** SDK waits for 2 post-tx blocks. Anvil fork mode does not auto-mine interval blocks without a concurrency hack. This is a significant friction point for any test script using the Doppler SDK on an Anvil fork.

5. **Fee split precision:** The 5% Doppler share results in the remaining 95% being split 35/20/10/30. The test confirms exact proportionality with no rounding loss visible at 6 decimal places.

6. **No contradiction with SPEC §4.5 vesting:** 30-day cliff, 1-year linear vest, 15% of supply to creator — all confirmed.

7. **USDC name vs EIP-712 domain:** On Monad mainnet, `USDC.name()` returns `"USDC"` (not `"USD Coin"`). The domain separator matches `keccak256(abi.encode(...name="USDC", version="2", chainId=143, verifyingContract=...))`. The `.env.anvil.example` correctly documents version `"2"`.
