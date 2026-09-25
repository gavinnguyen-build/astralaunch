# Astralaunch keeper (scheduled on-chain jobs). Build from the repo root:
#   docker build -f apps/keeper/Dockerfile -t astralaunch-keeper .
# KEEPER_PRIVATE_KEY is a runtime secret only — never a build arg.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/keeper/package.json apps/keeper/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @astralaunch/keeper...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/keeper apps/keeper
RUN pnpm -F @astralaunch/shared build

FROM base AS runtime
ENV NODE_ENV=production \
    CONTRACTS_JSON_PATH=/repo/packages/contracts/deployments/monad-mainnet.json
COPY --from=build --chown=node:node /repo /repo
COPY --chown=node:node packages/contracts/deployments/monad-mainnet.json packages/contracts/deployments/
USER node
WORKDIR /repo/apps/keeper
# No HTTP surface: liveness is the process itself (restart policy) plus the
# keeper's own Telegram low-balance / spend-guard alerts.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
