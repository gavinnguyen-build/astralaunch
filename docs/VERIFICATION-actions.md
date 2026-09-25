# Verification: Phase D web actions (Anvil fork)

Date: 2026-09-26. Setup:
- Anvil fork of Monad mainnet at head (chain 143), real v2 contracts, real Doppler / Uniswap v4 / Permit2 / UR.
- Local facilitator, fork server and indexer on a scratch DB, and demo-services.
- The modules are the same ones the browser uses (`apps/web/src/lib/{trade,x402,claims,launch}.ts`), driven
  from Node with Anvil dev keys. Fork only: the scripts refuse any non-local RPC.

| Check | How | Result |
|---|---|---|
| UR address has code | `cast code` / `poolManager()` read-only on mainnet | Old address: no code. 0x0D97…9dc3: 19,499 bytes, poolManager ok |
| Buy SIGHT (USDC pair) 1 USDC | `scripts/fork-trade-test.ts` | Exact Permit2 approval + PERMIT2_PERMIT + swap; received = quote ≥ min |
| Sell half SIGHT → USDC | same | Permit only (pre-granted Permit2 allowance on DERC20); received ≥ min |
| Buy FEED (MON pair) paying 5 MON | same | WRAP_ETH in the same tx; received = quote ≥ min |
| Sell half FEED → MON | same | UNWRAP_WETH to sender; MON received |
| UR encoding | same | 2.0 works; 2.1.1 not needed |
| Taken slug refused before any tx | `scripts/fork-actions-test.ts 1` | `slug_taken`, no tx sent |
| Launch + signed service PATCH | same | PHD launched and listed; price updated 0.5 → 0.6 USDC |
| x402 from the wallet | same | 402 → payTo = router (on-chain check) → signed EIP-3009 → 200, settle tx on the fork |
| Keeper once | `apps/keeper --once` | 0.6 USDC distributed; 0.008 USDC into escrow |
| collectFees(poolId) | `fork-actions-test.ts 2` | creator +0.013999 USDC |
| FeeEscrow.claim(asset) | same | creator +0.007999 USDC |
| release before cliff | same | refused before simulation ("Nothing is releasable yet…") |
| release after +31 days | same | release(0) → creator +12.74M PHD |
| UI | headless screenshots, Creator + chart pages on the fork | render ok; action buttons disabled without a wallet |
| Tests | `pnpm test`, typecheck, web build | server 83, indexer 82 (+2 skipped), keeper 52, demo 6; typecheck clean; build ok |

Not verified here: the Privy embedded / injected wallet popups (browser only). Test these on mainnet with
small amounts (see the Phase D report).
