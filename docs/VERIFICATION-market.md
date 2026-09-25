# Verification: market data inputs (Phase A, 2026-09-25)

All checks read-only against Monad mainnet (`cast call` / `cast receipt` / `eth_getLogs`); no transactions.

| What | How | Result |
|---|---|---|
| v4 `Swap` layout + sign convention | Decoded PoolManager logs of the SIGHT buyback `0x4cc6c725…d448` and FEED buyback `0x1e98eb5d…6eae` | `amount0/amount1` are the **swapper's** deltas (+ received, − paid): SIGHT pool `amount0 = +58006136615143254089104` (SIGHT), `amount1 = −150000` (USDC). PASS |
| Buyback detection | `Swap.sender` of the same logs | `0x394F1dcA6011C16BC6e70CA13F6F29767D92171E` = BuybackVault (deployments/monad-mainnet.json) in every buyback swap. PASS |
| MON pair two-hop | Same FEED tx | Hop 1: pool `0x18a9fc87…549954` (MON/USDC, fee 500) `+5.803155 WMON / −0.15 USDC`; hop 2: FEED pool `0xd29e4604…` `+58477.66 FEED / −5.803155 WMON`. PASS |
| Price math | `priceWadFromSqrtX96` on the SIGHT swap `sqrtPriceX96 = 126208693145960762050` | 2.5376e-6 USDC/SIGHT → ≈ $2,537 mcap at 1e9 supply (fixed $2,500 launch cap). Launch `Initialize` price 2.5309e-6 (block 107858010). PASS |
| `Initialize` selector | SIGHT launch tx `0xff6dc3d0…e56b` (block 107858010) | topic0 `0xdd466e67…6438` = `Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)`. PASS |
| RPC topic filters | `eth_getLogs` on block 107858010 with `[[Swap, Initialize], [poolIds]]` | OR-arrays in topic0 and topic1 supported. PASS |
| Chainlink MON/USD | `MON_USD_ORACLE` `decimals()`, `description()`, `latestRoundData()` | 8 decimals, "MON / USD", answer 2562000 ($0.02562), updated 13 s before the read. PASS |
| Token vesting ABI | SIGHT `0x30Ae…05aD`, creator `0x11e2…cbc6` | derc20V2 functions: `totalAllocatedOf` = 150M, `getScheduleIdsOf` = [0], `vestingOf(creator,0)` = (150M, 0 released), `vestingSchedules(0)` = (cliff 2592000, duration 31536000), `computeAvailableVestedAmount` = 0 (inside the cliff). PASS |
| Old vesting call | `vestedAmount(address,uint256)` used by `/api/creator/me` | **reverts**, so `/api/creator/me` has always returned `vesting: null`. The new `/api/creator/:wallet` uses the functions above. |
