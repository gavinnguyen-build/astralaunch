#!/usr/bin/env bash
# Start an Anvil fork of Monad mainnet for Revpad tests.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.anvil; set +a

ARGS=(
  --fork-url "$MONAD_RPC_URL"
  --chain-id "${CHAIN_ID:-143}"
  --port "${ANVIL_PORT:-8545}"
  --accounts 10
  --balance 100000            # MON per dev account
  --code-size-limit 131072    # Monad allows 128 KB contracts
  --block-time 1              # auto-mine every 1 s so Doppler SDK's confirmations:2 resolves
  --network monad             # Foundry ≥1.8: Monad execution model (Monad opcode pricing + gas billing)
)
if [[ -n "${FORK_BLOCK:-}" ]]; then
  ARGS+=(--fork-block-number "$FORK_BLOCK")   # pin for reproducible runs
fi

mkdir -p .anvil-state
rm -f .anvil-state/state.json .anvil-state/state.snapshot.json .anvil-state/snapshot-id
echo "Forking Monad (chain ${CHAIN_ID:-143}) ${FORK_BLOCK:+at block $FORK_BLOCK}"
exec anvil "${ARGS[@]}"
