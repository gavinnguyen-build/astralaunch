#!/usr/bin/env bash
# Move fork time forward. Usage: anvil/time-travel.sh <days>   (decimals allowed, e.g. 0.5)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.anvil; set +a
RPC="${ANVIL_RPC_URL:-http://127.0.0.1:8545}"
DAYS="${1:?days required}"
SECS=$(awk -v d="$DAYS" 'BEGIN { printf "%d", d * 86400 }')
cast rpc evm_increaseTime "$SECS" --rpc-url "$RPC" >/dev/null
cast rpc evm_mine --rpc-url "$RPC" >/dev/null
echo "Advanced $DAYS day(s). Block timestamp: $(cast block latest --field timestamp --rpc-url "$RPC")"
echo "Note: x402 payments (test 07) use wall-clock validity; run them before time travel or revert first."
