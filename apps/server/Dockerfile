# Astralaunch API + x402 gateway. Build from the repo root:
#   docker build -f apps/server/Dockerfile -t astralaunch-server .
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @astralaunch/server...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm -F @astralaunch/shared build

FROM base AS runtime
ENV NODE_ENV=production PORT=3001 \
    CONTRACTS_JSON_PATH=/repo/packages/contracts/deployments/monad-mainnet.json
COPY --from=build --chown=node:node /repo /repo
COPY --chown=node:node packages/contracts/deployments/monad-mainnet.json packages/contracts/deployments/
USER node
WORKDIR /repo/apps/server
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Apply pending Drizzle migrations, then start. Migrations are idempotent.
CMD ["sh", "-c", "node_modules/.bin/tsx src/db/migrate.ts && exec node_modules/.bin/tsx src/index.ts"]
