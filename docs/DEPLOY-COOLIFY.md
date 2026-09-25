# Deploying Astralaunch on Coolify (one VPS)

Stack file: `docker-compose.prod.yml` (repo root). The root `docker-compose.yml` is the
local-dev Postgres and is not used in production.

| Service | Image source | Public? | Port | Healthcheck |
|---|---|---|---|---|
| `web` | `apps/web/Dockerfile` (Vite build → nginx) | yes: `astralaunch.xyz`, `www.astralaunch.xyz` | 80 | `GET /healthz` |
| `server` | `apps/server/Dockerfile` (API + x402 gateway) | yes: `api.astralaunch.xyz` | 3001 | `GET /health` (includes DB) |
| `indexer` | `apps/indexer/Dockerfile` (follow mode) | no | – | `idx_checkpoints.updated_at` newer than 10 min |
| `keeper` | `apps/keeper/Dockerfile` | no | 8080 (internal) | `GET /health`: 503 when no tick succeeded within 3 × `POLL_INTERVAL_S` |
| `demo-services` | `apps/demo-services/Dockerfile` | no | 4001 (internal) | `GET /health` |
| `postgres` | `postgres:16-alpine` | no | 5432 (internal) | `pg_isready` |

All services use `restart: unless-stopped` and capped json-file logs (5 × 20 MB).

## Networks

- `internal` (`internal: true`, no internet route): `postgres`, `server`, `indexer`, `keeper`, `demo-services`.
  Postgres has no host port. demo-services is reachable only by the server as `http://demo-services:4001`.
- `egress`: `server`, `indexer`, `keeper` (Monad RPC, facilitator, Telegram), `demo-services` (arXiv), `web`.
- No service publishes a host port. Coolify's proxy (Traefik) reaches `web` and `server`
  through the domains assigned in the UI and terminates HTTPS for them.

## Coolify setup

1. **New resource → Docker Compose** from this Git repo, branch `main`.
   Set *Docker Compose Location* to `/docker-compose.prod.yml`, base directory `/`.
2. **Domains** (per service in the Coolify UI):
   - `web` → `https://astralaunch.xyz,https://www.astralaunch.xyz`, container port 80
   - `server` → `https://api.astralaunch.xyz`, container port 3001
   - leave every other service without a domain.
3. **DNS (Hostinger)**: in the Hostinger DNS zone for `astralaunch.xyz`, create `A` records
   for `@`, `www` and `api` pointing at the VPS public IP (plus `AAAA` records if the VPS has
   IPv6). Remove any parking or default records for those names. Ports 80 and 443 must be open
   on the VPS firewall. Coolify issues and renews the Let's Encrypt certificates itself once
   the records resolve, because the domains in step 2 use `https://`. Let DNS propagate
   before the first deploy, or the certificate challenge fails and has to be retried.
4. **Environment variables**: fill in the variables below in the Coolify env editor. Tick
   *Is Build Variable?* for every `VITE_*` (web). Mark the secrets as locked.
5. **Deploy.** The expected order is postgres → demo-services → server (runs migrations) → indexer and keeper. web starts independently.
6. **Verify** (see "Post-deploy checks").

## Environment variables

Legend: **secret** = never commit, lock in Coolify. **public** = safe to show, including in
the browser bundle. "default" = value baked into `docker-compose.prod.yml`, so it only needs
setting to override.

Contract addresses are the **v2 mainnet deployment**,
`packages/contracts/deployments/monad-mainnet.json` (commit `c89dde3`, 2026-09-25). v1
(registry `0x25845Cee…`) is retired. `docs/MAINNET-RUNBOOK.md` and `apps/*/.env.mainnet.example`
now carry v2.

### Shared by several services

| Var | Used by | Kind | Value |
|---|---|---|---|
| `POSTGRES_PASSWORD` | postgres, server, indexer, keeper | **secret**, required | `openssl rand -hex 24` (hex, so it is URL-safe inside `DATABASE_URL`) |
| `MONAD_RPC_URL` | server, indexer, keeper | public | default `https://rpc.monad.xyz` |
| `MONAD_CHAIN_ID` | server, keeper | public | default `143` |
| `FACILITATOR_SUBMITTER_ADDRESSES` | server, indexer, keeper | public | default `0x7f6a2850669202519f0FE8aa912451238820Db86` |
| `USDC_ADDRESS` | server, keeper | public | default `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |
| `ASTRALAUNCH_REGISTRY_ADDRESS` | server, keeper | public | default `0x6B3A79C723AB69f8938C87209E1D9730c739e00c` |
| `FEE_ESCROW_ADDRESS` | server, keeper | public | default `0xA070ad1387d525E4A180Bdb09B65FD4086858F15` |
| `BUYBACK_VAULT_ADDRESS` | server, keeper | public | default `0x394F1dcA6011C16BC6e70CA13F6F29767D92171E` |
| `PLATFORM_FEE_RECEIVER_ADDRESS` | server, keeper | public | default `0x2eFE45394d7578dC39c75d06Fe88722118F5Ec76` |
| `ADMIN_ADDRESS` | server, keeper | public | default `0xe89f19D370F496520803e7ABb30c1A20B04B0f7f` (startup check of `admin()` wiring) |

`DATABASE_URL` is assembled inside the compose file as
`postgresql://astralaunch:${POSTGRES_PASSWORD}@postgres:5432/astralaunch`. Do not set it by hand.
`CONTRACTS_JSON_PATH` is baked into the server, indexer and keeper images, pointing at the
copied `monad-mainnet.json`.

### server (`api.astralaunch.xyz`)

| Var | Kind | Value / notes |
|---|---|---|
| `GATEWAY_HMAC_MASTER_KEY` | **secret**, required | `openssl rand -hex 32`. Rotating it invalidates existing gateway credentials. |
| `ADMIN_API_KEY` | **secret**, optional | Bearer token for `/api/admin/*`. Unset = admin API disabled. |
| `UPSTREAM_ALLOWLIST` | public | default `http://demo-services:4001`: the one private origin allowed past the SSRF block |
| `CORS_ORIGINS` | public | default `https://astralaunch.xyz,https://www.astralaunch.xyz`. Read by the server (`apps/server/src/lib/cors.ts`); bare origins only, a wildcard or path refuses to start. |
| `X402_FACILITATOR_URL` | public | default `https://x402-facilitator.molandak.org` |
| `PAYMENT_TIMEOUT_SECONDS` | public | default `60`. The server refuses > 300 on a non-local RPC. |
| `GUARDIAN_ADDRESS` | public | default `0x62c1a140eB643BF43659E7e5134CAfDFeDe17e8b` |
| `TREASURY_ADDRESS` | public | default `0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C` |
| `PORT` | public | fixed `3001` |
| `PROBES_DISABLED` | public, optional | `true` disables the upstream probe worker |
| `ALLOW_LOCAL_UPSTREAMS` | — | **never set in production** (disables SSRF protection entirely) |
| `PRIVY_APP_SECRET`, `LITELLM_BASE_URL`, `LITELLM_API_KEY` | **secret** | Listed in `.env.example`, but no server code reads them today. Set them only when a feature needs them. |

### indexer

| Var | Kind | Value / notes |
|---|---|---|
| `INDEXER_POLL_INTERVAL_S` | public | default `10` |
| `INDEXER_MAX_RPS` | public | default `25`. Lower it if the public RPC rate-limits. |
| `INDEXER_CHUNK_SIZE` | public | default `100` blocks (code default 10000; https://rpc.monad.xyz rejects wide `eth_getLogs` ranges, the fetcher halves on range errors and regrows) |
| `INDEXER_FINALITY_LAG` | public | default `0` |
| `INDEXER_SWAP_LOOKBACK_BLOCKS` | public, optional | code default `20000` |
| `INDEXER_RPC_TIMEOUT_MS` | public, optional | code default `30000` |
| `INDEXER_HEALTH_MAX_AGE_S` | public | default `600`. The healthcheck fails when the checkpoint is older than this. |

The start block and contract addresses come from `monad-mainnet.json`, not env. First boot
backfills from block `107840649`, and the healthcheck allows a 10-minute start period.

### keeper

| Var | Kind | Value / notes |
|---|---|---|
| `KEEPER_PRIVATE_KEY` | **secret**, required | Key for the keeper wallet **`0x9e641007829DA8eB199b2Bec64B1E6dcbfdaB854`**. Used only by the keeper, never by any other service, and never an Anvil or test key (CLAUDE.md rule 15). Keep the wallet funded with MON. |
| `DATABASE_URL` | (assembled in compose) | Token discovery. Each tick the keeper reads the listed tokens (launch fee consumed, not hidden) with router, numeraire and pool id. A new listing is picked up on the next tick without a restart. It only runs `SELECT`s, so a read-only Postgres role is enough if you want to tighten it. |
| `ASSETS` | public, optional | **Debug override only; leave empty.** Alone, it services those tokens from the DB, listed or not. With `ROUTERS`, it uses explicit pairs without the DB. |
| `ROUTERS` | public, optional | Comma-separated RevenueRouter addresses matching `ASSETS` |
| `KEEPER_HEALTH_PORT` | public | fixed `8080`, internal only. `GET /health` returns the last successful tick, target count and wallet MON balance. |
| `POLL_INTERVAL_S` | public | default `600` (shared `KEEPER_DEFAULT_INTERVAL_S`). Values below 300 (`KEEPER_MIN_INTERVAL_S`) are clamped to 300 on a non-local RPC. The `30` in `.env.mainnet.example` has no effect. |
| `COLLECT_INTERVAL_S` | public | default `21600` (6 h, shared `COLLECT_INTERVAL_S`) |
| `MIN_MON_BALANCE`, `MAX_MON_PER_DAY`, `SINGLE_TX_ALERT` | public, optional | in MON (e.g. `0.5`); code defaults in shared |
| `MIN_COLLECT_USDC`, `MIN_DISTRIBUTE_USDC`, `MIN_BUYBACK_USDC` | public, optional | in USDC (e.g. `1.5`); code defaults in shared |
| `DRY_RUN` | public | default `false`. `true` estimates gas without sending. Use it for the first deploy. |
| `TELEGRAM_BOT_TOKEN` | **secret**, optional | Treasury proposal, admin transfer, low-balance and **tick-failure** alerts. Identical failures repeat at most hourly, and a recovery sends one alert. |
| `TELEGRAM_CHAT_ID` | public, optional | |

### demo-services (internal only)

| Var | Kind | Value |
|---|---|---|
| `DEMO_SERVICES_HOST` | public | fixed `0.0.0.0` (the code defaults to `127.0.0.1`, which is unreachable from other containers) |
| `DEMO_SERVICES_PORT` | public | fixed `4001` |

Demo services registered in the DB must use upstream URLs on `http://demo-services:4001/…`
with their own path prefix: `http://demo-services:4001/sight` (nullsight) and
`http://demo-services:4001/feed` (nullfeed). The gateway keeps each service inside its prefix. If they were registered as
`http://127.0.0.1:4001/…`, update them with `PATCH /api/services/:id`. Otherwise the gateway
blocks them as private IPs, because only the allowlisted origin passes.

### web (build variables, all public)

`VITE_*` values are inlined into the JS bundle at build time. In Coolify, tick
*Is Build Variable?*. Changing one requires a rebuild, not a restart. **Never put a secret in a
`VITE_*` variable.**

| Var | Value |
|---|---|
| `VITE_API_BASE` | `https://api.astralaunch.xyz` (the web's API base URL) |
| `VITE_PRIVY_APP_ID` | `cmuh6urs5000y0bkzkff6fn3c` |
| `VITE_CHAIN_ID` | `143` |
| `VITE_RPC_URL` | `https://rpc.monad.xyz` |
| `VITE_REGISTRY_ADDR` | `0x6B3A79C723AB69f8938C87209E1D9730c739e00c` |
| `VITE_ESCROW_ADDR` | `0xA070ad1387d525E4A180Bdb09B65FD4086858F15` |
| `VITE_VAULT_ADDR` | `0x394F1dcA6011C16BC6e70CA13F6F29767D92171E` |
| `VITE_EXPLORER_URL` | optional; defaults to `MONAD_EXPLORER_URL` from shared |

In the Privy dashboard, add `https://astralaunch.xyz` and `https://www.astralaunch.xyz` as
allowed origins for app `cmuh6urs5000y0bkzkff6fn3c`.

## Post-deploy checks

```bash
curl -fsS https://api.astralaunch.xyz/health     # {"status":"ok","db":"ok",...}
curl -fsS https://api.astralaunch.xyz/api/config
curl -fsSI https://astralaunch.xyz/ | head -1       # 200
curl -fsSI https://astralaunch.xyz/token/0x0 | head -1   # 200 (SPA fallback)
# CORS preflight: must return Access-Control-Allow-Origin once CORS ships (see below)
curl -si -X OPTIONS https://api.astralaunch.xyz/api/stats \
  -H 'Origin: https://astralaunch.xyz' -H 'Access-Control-Request-Method: GET' | grep -i access-control
```

In Coolify logs, look for:
- server: `Contract addresses verified on chain 143`, `Admin wiring verified: 0xe89f…`, `Migrations complete.`
- indexer: `[indexer] mode=follow chain=143 …`, then advancing blocks
- keeper: `[keeper] starting — … targets from database (listed tokens)`, then `[keeper] tick — N asset(s) balance=… MON`, where N is the number of listed tokens. With `DRY_RUN=true` first, confirm the wallet balance and target count (also shown in the container's `/health`), then flip to `false`.

Postgres backups: enable Coolify's scheduled backup on the `postgres` service (volume `postgres_data`).

## Building locally

```bash
docker build -f apps/server/Dockerfile        -t astralaunch-server .
docker build -f apps/indexer/Dockerfile       -t astralaunch-indexer .
docker build -f apps/keeper/Dockerfile        -t astralaunch-keeper .
docker build -f apps/demo-services/Dockerfile -t astralaunch-demo-services .
docker build -f apps/web/Dockerfile           -t astralaunch-web .
docker compose -f docker-compose.prod.yml config   # validate the stack file
```

All builds use the repo root as the context. `.dockerignore` keeps every `.env*` file
(except `*.example`), node_modules, Foundry artifacts and docs out of the images. The Node
images install the workspace with `pnpm install --frozen-lockfile --filter <app>...`, build
`@astralaunch/shared`, and run TypeScript through `tsx`, like the existing `start:mainnet`
scripts. They run as the unprivileged `node` user.

The `gyp ERR!` lines in the web build log come from optional native addons
(`bufferutil`, `utf-8-validate`, `keccak`) that cannot compile in `node:24-slim`. They fall
back to JS and never reach the browser bundle, so the build still succeeds.

### Verified locally (2026-09-26, Docker 29.7.2, arm64)

| Check | Result |
|---|---|
| All five images build from the repo root | pass |
| `docker compose -f docker-compose.prod.yml config` | pass |
| server image + throwaway Postgres + `https://rpc.monad.xyz` | 10 migrations applied. `Admin wiring verified: 0xe89f…`, `Contract addresses verified on chain 143` (confirms the v2 addresses are live). `/health` returns `db: ok`, and the container healthcheck turns healthy. |
| server CORS preflight `OPTIONS /api/stats` with `Origin: https://astralaunch.xyz` | **404, no `Access-Control-*` headers.** Code change 1 is needed. |
| indexer image (follow mode) | Starts at block 107840649 and writes `idx_checkpoints`. `docker-healthcheck.mjs` exits 0 and the container is healthy. The first build failed because the indexer imports `apps/server/src/services/*`, so the image now copies the whole server `src`. |
| keeper image, `--once --dry-run` with a throwaway random key | Verifies contracts and admin wiring, runs one tick with 0 assets, and exits cleanly. |
| keeper DB discovery, e2e (2026-09-26): keeper image + Postgres migrated by the server image, dry run, throwaway key | Tick 1: SIGHT registered but unlisted, FEED listed but hidden → `0 asset(s)`. Then, without a restart, SIGHT was listed and a spoofed listed row (fake asset, SIGHT's router) was inserted. Tick 2 → `2 asset(s)`: SIGHT passed the on-chain cross-check and its dry-run jobs ran; the spoof was skipped (`router … reports asset 0x30Ae…`) with no transaction. `/health` returned `ok:true` with target count and balance, went `ok:false` while no tick succeeded for more than 3 × interval (host asleep), and recovered on the next tick. |
| demo-services image | `/health` and `/sight/signals` return 200. It binds `0.0.0.0` via env. |
| web image | `tsc` + `vite build` pass. `/`, `/token/…` (SPA fallback) and `/healthz` return 200. `index.html` is `no-cache`, and hashed assets are `immutable`. The bundle contains `api.astralaunch.xyz` and the Privy app id. |
| Secrets in images | No `.env*` files except the committed `*.example`. All Node images run as `node`. |

Not verified: a deploy on the VPS itself, Coolify domain routing and certificates, Hostinger
DNS, and the keeper running with the real key.

## Code changes needed (for the Phase D session)

These are required or recommended for Docker/production. Keeper discovery, keeper health and
the v1 → v2 address cleanup of the runbook and env examples are done (keeper commit).

1. **CORS: done (2026-09-26, `lib/cors.ts`).** Before this, `apps/server/src/index.ts` had no CORS middleware. The browser on
   `https://astralaunch.xyz` calling `https://api.astralaunch.xyz` fails every request.
   Add `hono/cors` restricted to the origins in `CORS_ORIGINS`
   (default `https://astralaunch.xyz,https://www.astralaunch.xyz`, parsed in `env.ts`). Allow
   the methods `GET, POST, PATCH, OPTIONS`, and allow and expose the x402 payment headers
   using the SDK's header constants (CLAUDE.md rule 7), so browser x402 calls to `/s/*` can
   read the settlement response.
2. **Test fixtures** in `apps/indexer` and `apps/server` still use v1 addresses as plain
   constants. This is harmless, but they can move to v2 whenever those tests are touched.
   (SPEC §23 was updated to v2 with Tun's approval, 2026-09-26.)
3. **Single address source.** Server and keeper read contract addresses from env, while the
   indexer reads `monad-mainnet.json`. Consider having server and keeper read
   `CONTRACTS_JSON_PATH` too.
4. **`apps/server` `start` script** uses `node --experimental-transform-types src/index.ts`.
   The image runs `tsx` instead, matching `start:mainnet`. Align the script if it is meant
   to be the production entrypoint.
5. **pnpm 12 warning.** Root `package.json` `"pnpm.onlyBuiltDependencies"` is ignored by
   pnpm 12 (build approvals live in `pnpm-workspace.yaml` `allowBuilds`). It is harmless,
   but the dead key can be removed.
