# Astralaunch keeper (scheduled on-chain jobs). Build from the repo root:
#   docker build -f apps/keeper/Dockerfile -t astralaunch-keeper .
# KEEPER_PRIVATE_KEY is a runtime secret only — never a build arg.
# Token discovery imports the DB schema and isListedSql from apps/server/src, so the
# server package is installed too (same pattern as the indexer).
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/keeper/package.json apps/keeper/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @astralaunch/keeper... --filter @astralaunch/server...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server/src apps/server/src
COPY apps/keeper apps/keeper
RUN pnpm -F @astralaunch/shared build

FROM base AS runtime
ENV NODE_ENV=production KEEPER_HEALTH_PORT=8080 \
    CONTRACTS_JSON_PATH=/repo/packages/contracts/deployments/monad-mainnet.json
COPY --from=build --chown=node:node /repo /repo
COPY --chown=node:node packages/contracts/deployments/monad-mainnet.json packages/contracts/deployments/
USER node
WORKDIR /repo/apps/keeper
EXPOSE 8080
# /health is 503 when no tick succeeded within 3 × POLL_INTERVAL_S (src/health.ts).
HEALTHCHECK --interval=60s --timeout=5s --start-period=2m --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KEEPER_HEALTH_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/index.ts"]
