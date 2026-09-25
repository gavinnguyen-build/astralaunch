# Verification: one-transaction launch (LaunchHelper), 2026-09-26

**What:** `packages/contracts/src/LaunchHelper.sol`; server fee verification from its event; the combined signed
message; the web one-transaction flow (`apps/web/src/lib/launch.ts`). Decisions D-LH1..D-LH6.
**Where:** a local Anvil fork of Monad mainnet (port 8546, Foundry 1.8.3, `--network monad`, chain head block
≈ 108.01M) with the real Doppler Airlock and the deployed v2 registry. No mainnet transactions.

## Contracts

`forge test --no-match-path "test/fork/*"`: **230 passed, 0 failed** (includes LaunchHelper unit 18, fuzz 2 × 10,000
runs, invariants 3 × 500 runs / 50,000 calls: helper never holds MON; treasury gets exactly the fees of
successful launches).

Fork (`forge test --fork-url http://127.0.0.1:8546 --match-path test/fork/LaunchHelperFork.t.sol -j 1`),
CreateParams from the SDK through the browser code path (`apps/web/scripts/launch-helper-fixture.ts`):

```
[PASS] test_fork_directAirlockCreate_stillRegisters() (gas: 5789888)
[PASS] test_fork_monPair_oneTransaction() (gas: 5987215)
  mon launch via helper, gas: 5482117
[PASS] test_fork_usdcPair_oneTransaction() (gas: 6016871)
  usdc launch via helper, gas: 5511847
[PASS] test_fork_wrongCreator_revertsAtomically_noFee() (gas: 4943208)
[PASS] test_fork_wrongFee_reverts() (gas: 262775)
[PASS] test_fork_zeroFee_existingReceipt() (gas: 5988352)
Suite result: ok. 6 passed; 0 failed; 0 skipped
```

Checked per launch: registered with the right router and numeraire, Airlock data (supply, pool tokens,
integrator = PlatformFeeReceiver), 150M vested to the creator, treasury +10 MON exactly, helper balance 0,
`Registered` and `LaunchFeePaid` in the same tx. A wrong creator reverts with `WrongCreatorShare` and no fee moves.
One helper launch ≈ 5.48–5.51M gas (create + register + fee). Run the fork suite with `-j 1`: parallel fork tests
stalled the local Anvil (upstream state fetches timed out), which showed up as spurious reverts.

`script/DeployLaunchHelper.s.sol` deployed on the fork (`0x3C2BafebbB0c8c58f39A976e725cD20D611d01e9`) and
the server's startup check accepted it (`[server] LaunchHelper verified`).

## Server

`vitest run`: **119 passed** (new: 12 LaunchHelper fee cases, 11 launch-details cases; existing fee, service and
config tests unchanged). Covered: spoofed event from another contract, value-0 helper tx, underpaid event,
reverted tx, helper not configured, direct path unchanged, verify-before-index and index-before-verify,
the event's asset matched first, replay, tampered field, all-or-nothing on a taken slug, and old endpoints
still accepted. Indexer 82 and keeper 90 tests pass against the changed `launchFee.ts`.

## Web, end to end on the fork

`apps/web/scripts/fork-launch-helper-test.ts` (server :3102 with `LAUNCH_HELPER_ADDRESS`, indexer, scratch DB),
counting what the wallet is asked for:

| Scenario | Confirmation | Wallet asked | Treasury | Listed |
|---|---|---|---|---|
| USDC + metadata + service | 1 tx / 1 signature | 1 tx / 1 signature | +10 MON | yes; API shows @handle, website, service at 0.5 USDC |
| MON pairing, no details | 1 tx / 0 | 1 tx / 0 | +10 MON | yes |
| Fee paid directly earlier, then helper launch (value 0) | 1 tx / 0 | 1 tx / 0 | +0 | yes (receipt reused) |
| 4th launch in 24h | refused before any tx (`rate_limited`) | – | – | – |

`ALL CHECKS PASSED`. Web typecheck and `vite build` pass.

**Not verified:** mainnet deploy, and the Privy embedded wallet UI (driven from Node here).
