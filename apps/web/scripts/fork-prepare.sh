#!/usr/bin/env bash
# Prepare a LOCAL Anvil fork for testing the browser launch flow (Phase C).
# Run after starting the fork (anvil on 127.0.0.1:8545, chain 143, at chain head).
# - funds dev accounts with USDC and clears their EIP-7702 code (astralaunch-anvil/anvil/fund.sh)
# - creates a fresh scratch database (default astralaunch_forktest) with all migrations
# - writes astralaunch-anvil/.anvil-state/forktest.env for the server and indexer (mainnet v2
#   contract addresses from deployments/monad-mainnet.json, indexer start = current fork head)
# Never touches mainnet or the mainnet database.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RPC="${ANVIL_RPC_URL:-http://127.0.0.1:8545}"
DB="${FORKTEST_DB:-astralaunch_forktest}"
case "$RPC" in http://127.0.0.1*|http://localhost*) ;; *) echo "Refusing non-local RPC $RPC"; exit 1;; esac
case "$DB" in *mainnet*) echo "Refusing database name $DB"; exit 1;; esac

HEAD=$(cast block-number --rpc-url "$RPC")
echo "fork head: $HEAD"
(cd "$ROOT/astralaunch-anvil" && bash anvil/fund.sh 1000 | tail -3)

dropdb --if-exists "$DB"; createdb "$DB"
for t in $(python3 -c "import json;print(' '.join(e['tag'] for e in json.load(open('$ROOT/apps/server/src/db/migrations/meta/_journal.json'))['entries']))"); do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/apps/server/src/db/migrations/$t.sql" >/dev/null
done
echo "database $DB migrated"

STATE="$ROOT/astralaunch-anvil/.anvil-state"
mkdir -p "$STATE"
python3 - "$ROOT" "$STATE" "$HEAD" "$DB" "$RPC" <<'PY'
import json, secrets, sys
root, state, head, db, rpc = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5]
d = json.load(open(f'{root}/packages/contracts/deployments/monad-mainnet.json'))
c = dict(d); c['blockNumber'] = head
json.dump(c, open(f'{state}/contracts-forktest.json', 'w'))
open(f'{state}/forktest.env', 'w').write(f"""DATABASE_URL=postgres://localhost:5432/{db}
MONAD_RPC_URL={rpc}
MONAD_CHAIN_ID=143
ASTRALAUNCH_REGISTRY_ADDRESS={d['registry']}
FEE_ESCROW_ADDRESS={d['escrow']}
BUYBACK_VAULT_ADDRESS={d['vault']}
PLATFORM_FEE_RECEIVER_ADDRESS={d['platformFeeReceiver']}
CONTRACTS_JSON_PATH={state}/contracts-forktest.json
ADMIN_ADDRESS=
ADMIN_API_KEY=
GATEWAY_HMAC_MASTER_KEY={secrets.token_hex(32)}
ALLOW_LOCAL_UPSTREAMS=true
PROBES_DISABLED=true
PORT=3101
X402_FACILITATOR_URL=http://127.0.0.1:4021
INDEXER_POLL_INTERVAL_S=2
""")
print(f"wrote {state}/forktest.env")
PY
