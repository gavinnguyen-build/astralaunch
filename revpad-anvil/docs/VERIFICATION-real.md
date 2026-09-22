# VERIFICATION-real — Real Monad Mainnet Checks

> Companion to `docs/VERIFICATION-anvil.md`.
> Part 1: gas estimation via `simulateCreateMulticurve` on real Monad (no tx).
> Part 2: live 0.02 USDC x402 payment through the Monad official facilitator.

---

## Environment

| Item | Value |
|------|-------|
| Date | 2026-09-22 |
| Monad block (Part 1) | 106,943,158 — 2026-09-22T04:44:58Z |
| Monad block (Part 2) | 106,978,463 — 2026-09-22T07:42:40Z |
| `@whetstone-research/doppler-sdk` | 1.0.43 |
| `@x402/core` / `@x402/evm` | 2.26.0 |
| viem | 2.56.8 |
| Node | v24.14.0 |
| RPC | `https://rpc.monad.xyz` |
| Facilitator | `https://x402-facilitator.molandak.org` (Monad official, docs.monad.xyz) |
| Sender wallet | `0xB469251457Ad3D7E6070Dbe8F5564D069b45F473` |
| Anvil `--network monad` | enabled (Foundry 1.8.3 Monad execution model) |

---

## Part 1 — Gas Estimation (`npm run gas-real`)

No transactions submitted.

### Wallet balances

| Asset | Balance |
|-------|---------|
| USDC | 1 USDC |
| MON  | 2 MON  |

### `simulateCreateMulticurve` on real Monad

| Field | Value |
|-------|-------|
| Outcome | PASS |
| Predicted token address | `0x3B52aE261C2ee1F47EC31Fdc7409941c0f992Fb7` |
| Predicted poolId | `0xd18cddf3dd064ecca9e20a311cc02000282c3b53f5fd8c1a7668e351d0851bf0` |
| Gas estimate (Monad opcode pricing) | **4,589,375** |

### USDC gas estimates

| Operation | Gas units |
|-----------|-----------|
| `approve(spender, amount)` | 87,715 |
| `transfer(to, 1)` | 83,195 |

### Gas prices

| Metric | Value |
|--------|-------|
| `eth_gasPrice` | 102 gwei |
| `baseFeePerGas` (latest block) | 100 gwei |
| `maxPriorityFeePerGas` p50 (last 1 block) | 3 gwei |

### Gas comparison

> **Anvil note:** Foundry 1.8.3 with `--network monad` already uses Monad opcode pricing.
> The ratio 1.009 (< 1% difference) confirms Anvil and real Monad agree on gas cost.
> `VERIFICATION-anvil.md` was produced without `--network monad`; that flag was added
> as a result of this comparison.

| Operation | Monad simulated | Anvil measured (`--network monad`) | Ratio |
|-----------|----------------:|-----------------------------------:|------:|
| `createMulticurve` (launch) | **4,589,375** | 4,547,173 | **1.009×** |
| USDC `approve` | 87,715 | — | — |
| USDC `transfer` | 83,195 | — | — |

**Recommended `gasLimit` on real Monad (×1.1 buffer): 5,048,312**
(= 4,589,375 × 1.1, well within Monad's 30 M per-tx limit)

---

## Part 2 — Real x402 Payment (`npm run pay-real`)

### Pre-flight

| Check | Result |
|-------|--------|
| Wallet is not an Anvil dev account | PASS |
| Sender USDC balance ≥ 0.02 | PASS (1 USDC available) |
| `GET /supported` → `eip155:143` listed | PASS (`x402Version=2`) |

### Facilitator `/supported` full response

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "upto",
      "network": "eip155:143",
      "extra": { "facilitatorAddress": "0x7f6a2850669202519f0fe8aa912451238820db86" }
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:10143",
      "extra": {}
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:143",
      "extra": {}
    },
    {
      "x402Version": 2,
      "scheme": "upto",
      "network": "eip155:10143",
      "extra": { "facilitatorAddress": "0x7f6a2850669202519f0fe8aa912451238820db86" }
    }
  ],
  "extensions": [],
  "signers": {
    "eip155:10143": ["0x7f6a2850669202519f0FE8aa912451238820Db86"],
    "eip155:143":   ["0x7f6a2850669202519f0FE8aa912451238820Db86"]
  }
}
```

> The facilitator's on-chain submitter for `eip155:143` is
> `0x7f6a2850669202519f0FE8aa912451238820Db86`.

### Payment parameters

| Field | Value |
|-------|-------|
| Scheme | `exact` |
| Network | `eip155:143` |
| Asset | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |
| USDC on-chain `name()` | **"USDC"** |
| USDC on-chain `version()` | **"2"** |
| Amount | 0.02 USDC (20,000 units, 6 decimals) |
| PayTo | `0xB469251457Ad3D7E6070Dbe8F5564D069b45F473` (sender — self-payment) |
| Facilitator | `https://x402-facilitator.molandak.org` |
| `maxTimeoutSeconds` | 60 |

### Step results

| Step | Result | Detail |
|------|--------|--------|
| EIP-3009 sign (off-chain) | PASS | `{ x402Version:2, accepted:{ scheme:"exact", network:"eip155:143", ... } }` |
| `POST /verify` | PASS | `{ "isValid": true, "payer": "0xB469251457Ad3D7E6070Dbe8F5564D069b45F473" }` |
| `POST /settle` | PASS | tx `0x6e7e1dc75f884a4891a025837738f133bbb4bea01189c23e923c647f0b609a40` |
| `waitForTransactionReceipt` | PASS | block 106,978,469 · gasUsed 136,409 |
| payTo balance Δ | PASS (expected 0) | self-payment — USDC left and re-entered same address; delta=0 is correct |
| Replay rejected | PASS | `FiatTokenV2: authorization is used or canceled` |

> **Self-payment note:** `payTo` was set to the sender's own address (default when
> `REAL_PAYTO` is not set). `transferWithAuthorization(from=A, to=A)` executes on-chain
> but the net balance of address A does not change. The tx status `success` and the
> correct replay rejection are the authoritative confirmation that the payment executed.

### Settlement transaction

| Field | Value |
|-------|-------|
| TX hash | `0x6e7e1dc75f884a4891a025837738f133bbb4bea01189c23e923c647f0b609a40` |
| Block | 106,978,469 |
| Gas used | 136,409 (paid by facilitator, not sender) |
| `tx.from` (submitter) | `0x7f6a2850669202519f0fe8aa912451238820db86` (facilitator wallet) |

### x402.org optional probe

| Item | Value |
|------|-------|
| `eip155:143` in `x402.org/facilitator/supported` | **NOT FOUND** |
| Networks listed by x402.org | `eip155:84532`, Solana, Algorand, Aptos, Stellar, Hedera, XRPL (no Monad) |
| Optional second run | N/A — x402.org does not support Monad mainnet |

---

## Findings

### G1 — Monad opcode pricing vs Anvil (`--network monad`)

`simulateCreateMulticurve` on real Monad returned **4,589,375** gas vs Anvil's **4,547,173**
(ratio 1.009×, < 1% difference). This confirms that Foundry 1.8.3 with `--network monad`
already uses Monad's execution model on the fork — Anvil and real Monad agree to within 1%.

The recommended `gasLimit` for a real Monad launch with a 1.1× safety buffer is **5,048,312**,
well within Monad's 30 M per-tx limit.

Note: USDC ERC-20 operations (`approve`: 87,715 · `transfer`: 83,195) are significantly
cheaper than the launch; they are not the bottleneck.

### G2 — USDC EIP-712 domain on real Monad

On-chain `name()` = **"USDC"**, `version()` = **"2"** — matches `VERIFICATION-anvil.md`.
The `extra: { name: "USDC", version: "2" }` field in x402 `PaymentRequirements` is correct
for production. (Previous template incorrectly said "USD Coin"; this run confirms "USDC".)

### G3 — Monad official x402 facilitator

`https://x402-facilitator.molandak.org` reachable, supports `eip155:143` exact (x402 v2).
Facilitator submitter: `0x7f6a2850669202519f0FE8aa912451238820Db86`.

`/verify` returned `{ "isValid": true }` with payer correctly recovered from the
EIP-3009 signature. `/settle` submitted `transferWithAuthorization` on-chain in block
106,978,469 (gasUsed 136,409). A replay attempt was correctly rejected with
`FiatTokenV2: authorization is used or canceled`.

The **payer never needs MON** — all gas is paid by the facilitator wallet, confirming the
x402 design for Monad: sign with USDC balance, facilitator covers gas in MON.

### G4 — x402.org does not support Monad mainnet

`https://x402.org/facilitator/supported` does not list `eip155:143`. It covers Base Sepolia,
Solana, Algorand, Aptos, Stellar, Hedera, and XRPL — but not Monad. The Monad official
facilitator (`molandak.org`) is the only confirmed production endpoint.

### G5 — Wire format root cause (fix applied)

The original `httpPost` helper sent `{ paymentPayload, paymentRequirements }` without the
top-level `x402Version` field. The Monad facilitator rejected this with HTTP 400
`unsupported_scheme` and empty `payer`, because without `x402Version` it could not route
to the v2 parser. Replacing the hand-written fetch with `HTTPFacilitatorClient` from
`@x402/core/http` resolves this: the client sends
`{ x402Version: payload.x402Version, paymentPayload, paymentRequirements: payload.accepted }`.

---

## SPEC impact

| SPEC ref | Item | Status |
|----------|------|--------|
| §4 | `POOL_FEE=20000`, economics constants | Anvil-verified; Monad gas impact in G1 |
| §6.1 | Launch gas < Monad 30 M limit | **PASS** — 4,589,375 + 10% buffer = 5,048,312 < 30,000,000 |
| §17 | x402 exact scheme on `eip155:143` | **PASS** — live settlement confirmed (G3) |
| §17 | Monad official facilitator reachable | **PASS** — `https://x402-facilitator.molandak.org` (G3) |
| §17 | Payer needs no MON for x402 | **PASS** — facilitator pays gas; sender only needs USDC (G3) |
