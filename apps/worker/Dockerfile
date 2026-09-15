# syntax=docker/dockerfile:1
#
# Multi-stage build for @reviews/worker. Same shape as apps/api/Dockerfile
# (see the comment there for what each stage does and why) — this one has
# no `migrate` target because the API's Dockerfile already provides it,
# built from the same @reviews/db dependency.

ARG PNPM_VERSION=10.2.1
ARG TURBO_VERSION=2.10.12

FROM node:22-alpine AS base
# @reviews/db's generate script (packages/db/scripts/safe-generate.sh) is
# a bash script; alpine's default shell is ash/busybox, which doesn't run
# it.
RUN apk add --no-cache bash && corepack enable

FROM base AS pruner
WORKDIR /app
ARG TURBO_VERSION
RUN npm install -g turbo@${TURBO_VERSION}
COPY . .
RUN turbo prune @reviews/worker --docker

FROM base AS deps
WORKDIR /app
ARG PNPM_VERSION
RUN corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
ARG PNPM_VERSION
ARG TURBO_VERSION
RUN corepack prepare pnpm@${PNPM_VERSION} --activate \
  && npm install -g turbo@${TURBO_VERSION}
COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .
RUN turbo run build --filter=@reviews/worker...

FROM base AS prod-deps
WORKDIR /app
ARG PNPM_VERSION
RUN corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=pruner /app/out/json/ .
# A genuine --prod install, not `build`'s full install pruned afterward.
# `pnpm prune --prod` (with CI=true to dodge its interactive "reinstall
# from scratch?" prompt) completes, but the prompt it auto-answers *is* a
# full wipe-and-reinstall, and pnpm does not reliably restore each
# workspace package's own node_modules symlinks through it —
# apps/worker/node_modules ends up missing entries a direct dependency
# needs, which only shows up as `node main.js` throwing
# ERR_MODULE_NOT_FOUND once the container actually runs. A clean --prod
# install from the pruned manifests has no such gap. See
# apps/api/Dockerfile's prod-deps stage for the same fix in more detail.
RUN pnpm install --frozen-lockfile --prod
COPY --from=pruner /app/out/full/ .
# Splice in the actual generated Prisma client (with its query engine)
# from `build`, since this --prod install never ran `prisma generate`
# (the Prisma CLI is a devDependency). See apps/api/Dockerfile for why
# the hashed .pnpm folder name is safe to resolve dynamically like this.
RUN --mount=type=bind,from=build,source=/app/node_modules/.pnpm,target=/build-pnpm-store \
    set -eu; \
    src=$(find /build-pnpm-store -maxdepth 1 -iname '@prisma+client@*' | head -1); \
    dst=$(find node_modules/.pnpm -maxdepth 1 -iname '@prisma+client@*' | head -1); \
    test -n "$src" && test -n "$dst"; \
    rm -rf "$dst/node_modules/.prisma"; \
    cp -R "$src/node_modules/.prisma" "$dst/node_modules/.prisma"

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=node:node /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
USER node
# This worker has no HTTP surface (see apps/worker/src/main.ts) so there is
# no readiness endpoint to probe. `pgrep` only confirms the Node process
# that owns dist/src/main.js is still alive — it says nothing about
# whether its RabbitMQ/Postgres/Redis connections are actually up. A
# worker whose broker connection has silently died still passes this
# check; only the logs or the downstream effects (no moderation, no rating
# updates) would show that.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD pgrep -f "apps/worker/dist/src/main.js" || exit 1
CMD ["node", "apps/worker/dist/src/main.js"]
