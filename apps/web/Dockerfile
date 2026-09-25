# Astralaunch web: Vite static build served by nginx. Build from the repo root:
#   docker build -f apps/web/Dockerfile \
#     --build-arg VITE_API_BASE=https://api.astralaunch.xyz \
#     --build-arg VITE_PRIVY_APP_ID=cmuh6urs5000y0bkzkff6fn3c \
#     -t astralaunch-web .
# VITE_* values are inlined into the JS bundle at build time: they are public by
# definition and must be passed as build args, not runtime env.
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @astralaunch/web...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web

ARG VITE_API_BASE=https://api.astralaunch.xyz
ARG VITE_PRIVY_APP_ID=cmuh6urs5000y0bkzkff6fn3c
ARG VITE_CHAIN_ID=143
ARG VITE_RPC_URL=https://rpc.monad.xyz
# Defaults: v2 mainnet deployment, packages/contracts/deployments/monad-mainnet.json (c89dde3).
ARG VITE_REGISTRY_ADDR=0x6B3A79C723AB69f8938C87209E1D9730c739e00c
ARG VITE_ESCROW_ADDR=0xA070ad1387d525E4A180Bdb09B65FD4086858F15
ARG VITE_VAULT_ADDR=0x394F1dcA6011C16BC6e70CA13F6F29767D92171E
ARG VITE_EXPLORER_URL=
ENV VITE_API_BASE=$VITE_API_BASE VITE_PRIVY_APP_ID=$VITE_PRIVY_APP_ID \
    VITE_CHAIN_ID=$VITE_CHAIN_ID VITE_RPC_URL=$VITE_RPC_URL \
    VITE_REGISTRY_ADDR=$VITE_REGISTRY_ADDR VITE_ESCROW_ADDR=$VITE_ESCROW_ADDR \
    VITE_VAULT_ADDR=$VITE_VAULT_ADDR VITE_EXPLORER_URL=$VITE_EXPLORER_URL
RUN pnpm -F @astralaunch/shared build && pnpm -F @astralaunch/web build

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/healthz || exit 1
