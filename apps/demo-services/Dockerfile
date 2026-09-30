# Astralaunch demo upstreams (feed digest, sight signals). Internal only: the
# server's x402 gateway reaches it over the compose network. Build from the repo root:
#   docker build -f apps/demo-services/Dockerfile -t astralaunch-demo-services .
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/demo-services/package.json apps/demo-services/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @astralaunch/demo-services...
COPY tsconfig.base.json ./
COPY apps/demo-services apps/demo-services

FROM base AS runtime
# The app defaults to 127.0.0.1; bind all interfaces so the server container can reach it.
ENV NODE_ENV=production DEMO_SERVICES_HOST=0.0.0.0 DEMO_SERVICES_PORT=4001
# arXiv cache, kept across restarts. Mount a volume here; a new named volume copies this dir's node ownership.
ENV FEED_CACHE_FILE=/data/feed-cache.json
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /repo /repo
USER node
WORKDIR /repo/apps/demo-services
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DEMO_SERVICES_PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/index.ts"]
