#!/usr/bin/env bash
# Save or restore fork state. Usage: anvil/snapshot.sh save | revert
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.anvil; set +a
RPC="${ANVIL_RPC_URL:-http://127.0.0.1:8545}"
FILE=.anvil-state/snapshot-id
mkdir -p .anvil-state
case "${1:-save}" in
  save)
    cast rpc evm_snapshot --rpc-url "$RPC" | tr -d '"' > "$FILE"
    cp -f .anvil-state/state.json .anvil-state/state.snapshot.json 2>/dev/null || true
    echo "Saved snapshot $(cat "$FILE")"
    ;;
  revert)
    [[ -f "$FILE" ]] || { echo "No snapshot saved yet"; exit 1; }
    cast rpc evm_revert "$(cat "$FILE")" --rpc-url "$RPC" >/dev/null
    cp -f .anvil-state/state.snapshot.json .anvil-state/state.json 2>/dev/null || true
    # a snapshot id is consumed by revert; take a fresh one at the same point
    cast rpc evm_snapshot --rpc-url "$RPC" | tr -d '"' > "$FILE"
    echo "Reverted. New snapshot $(cat "$FILE") taken at the same state"
    ;;
  *) echo "usage: $0 save|revert"; exit 1 ;;
esac
