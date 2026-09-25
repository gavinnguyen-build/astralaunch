# Astralaunch indexer (follow mode). Build from the repo root:
#   docker build -f apps/indexer/Dockerfile -t astralaunch-indexer .
# The indexer imports the DB schema and services from apps/server/src, so the server package is installed too.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/indexer/package.json apps/indexer/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @astralaunch/indexer... --filter @astralaunch/server...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
# writer.ts also imports server services (launchFee, tokenSync); copy the whole src.
COPY apps/server/src apps/server/src
COPY apps/indexer apps/indexer
RUN pnpm -F @astralaunch/shared build

FROM base AS runtime
ENV NODE_ENV=production \
    CONTRACTS_JSON_PATH=/repo/packages/contracts/deployments/monad-mainnet.json
COPY --from=build --chown=node:node /repo /repo
COPY --chown=node:node packages/contracts/deployments/monad-mainnet.json packages/contracts/deployments/
USER node
WORKDIR /repo/apps/indexer
# Healthy while the checkpoint keeps moving (see docker-healthcheck.mjs).
HEALTHCHECK --interval=60s --timeout=10s --start-period=10m --retries=3 \
  CMD ["node", "docker-healthcheck.mjs"]
CMD ["node_modules/.bin/tsx", "src/cli.ts", "--follow"]
