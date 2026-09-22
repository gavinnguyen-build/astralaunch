#!/usr/bin/env bash
# Give USDC to test roles by writing the balance slot directly (slot found by probing, then cached).
# Usage: anvil/fund.sh [amountUsdc=10000]
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.anvil; set +a
RPC="${ANVIL_RPC_URL:-http://127.0.0.1:8545}"
USDC="$USDC_ADDRESS"
AMOUNT_USDC="${1:-10000}"
AMOUNT=$(( AMOUNT_USDC * 1000000 ))
MNEMONIC="test test test test test test test test test test test junk"
SLOT_FILE=.anvil-state/usdc-slot
mkdir -p .anvil-state

bal() { cast call "$USDC" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC" | awk '{print $1}'; }

set_raw() { # addr slot value
  local idx; idx=$(cast index address "$1" "$2")
  cast rpc anvil_setStorageAt "$USDC" "$idx" "$(cast to-uint256 "$3")" --rpc-url "$RPC" >/dev/null
}

find_slot() {
  local probe; probe=$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index 9)
  for slot in $(seq 0 30); do
    local idx old; idx=$(cast index address "$probe" "$slot")
    old=$(cast storage "$USDC" "$idx" --rpc-url "$RPC")
    set_raw "$probe" "$slot" 123456789
    local b; b=$(bal "$probe")
    cast rpc anvil_setStorageAt "$USDC" "$idx" "$old" --rpc-url "$RPC" >/dev/null
    if [[ "$b" == "123456789" ]]; then echo "$slot"; return 0; fi
  done
  return 1
}

# Clear EIP-7702 delegation code that Monad mainnet has on all well-known Anvil dev accounts.
# On a real fork these addresses hold 23-byte EF0100 delegation bytecode, which causes the
# x402 facilitator to call ERC-1271 isValidSignature instead of plain ECDSA recovery, and
# the delegated contract reverts, so every x402 payment fails.
# Setting code to 0x restores them to plain EOAs on this local fork only.
echo "Clearing EIP-7702 delegations from dev accounts (Monad mainnet fork artifact)..."
for i in 0 1 2 3 4 5 6; do
  ADDR=$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index "$i")
  CODE=$(cast code "$ADDR" --rpc-url "$RPC" 2>/dev/null || echo "0x")
  if [[ "$CODE" != "0x" ]]; then
    cast rpc anvil_setCode "$ADDR" "0x" --rpc-url "$RPC" >/dev/null
    echo "  account $i $ADDR: cleared EIP-7702 delegation"
  fi
done

if [[ -f "$SLOT_FILE" ]]; then
  SLOT=$(cat "$SLOT_FILE")
else
  SLOT=$(find_slot) || { echo "Could not find the USDC balance slot (0..30)"; exit 1; }
  echo "$SLOT" > "$SLOT_FILE"
fi
echo "USDC balance slot: $SLOT"

# roles: 0 creator, 1 treasury, 2 escrowStub, 3 buybackStub, 4 trader, 5 agent, 6 facilitator, 7 routerStub
for i in 0 4 5; do
  ADDR=$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index "$i")
  set_raw "$ADDR" "$SLOT" "$AMOUNT"
  echo "account $i $ADDR -> $(bal "$ADDR") raw units ($AMOUNT_USDC USDC)"
done
