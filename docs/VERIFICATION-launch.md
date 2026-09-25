# Verification: browser launch flow on an Anvil fork (Phase C, 2026-09-26)

**What:** `apps/web/src/lib/launch.ts`, the module the Launch page runs, driven end to end from
Node (`apps/web/scripts/fork-launch-test.ts`) with Anvil #0.
**Where:** Monad mainnet fork at chain head (block 107948913), real v2 contracts.
**Stack:** server :3101 and indexer on a scratch DB, demo-services :4001.
**Result:** PASS. Every step below was simulated before sending, with gas = estimate × 1.1.

| Run | Fee | Launch | Register | Listed | Metadata / service |
|---|---|---|---|---|---|
| USDC `FSIGHT` + metadata + service | 10 MON `0x511f1b89…c1fa`, verified | `0x408a9c65…5046` → `0xe0d98F5c…C571` | `0xec161842…f91e` | yes | signed, saved: API shows `@forksight`, service `fork-sight` 0.5 USDC |
| MON `FFEED` (Chainlink MON/USD) | 10 MON `0x571b61eb…2f2c`, verified | `0xafca1a40…b914` → `0x0db626BF…AB58` | `0x55ff7283…fb04` | yes | none requested |
| Paid fee without launching, then `FTHIRD` | reused `0xa0544940…77cf` (no new payment) | `0x75d7ef5a…3a9f` → `0x80a3062c…6b6c` | `0xf29e3177…1a41` | yes | none requested |
| Fourth launch within 24h | refused before any tx: `rate_limited: Launch limit reached: 3 launches per 24h per wallet. Next slot …` | | | | |

Plan checks (every run): beneficiaries Doppler 5%, PlatformFeeReceiver 30%, BuybackVault 10%, FeeEscrow 20%,
creator 35% (sorted by address); launch gas ≈ 5.07–5.11M (limit incl. ×1.1); fee tx gas 23,100.
