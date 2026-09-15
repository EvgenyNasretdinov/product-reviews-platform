# syntax=docker/dockerfile:1
#
# Multi-stage build for @reviews/web. Same pruning approach as the other
# two Dockerfiles (see apps/api/Dockerfile for the full explanation of
# base/pruner/deps/build), with one difference that matters a lot here:
#
# `NEXT_PUBLIC_API_URL` is inlined into the browser JS bundle by `next
# build` — it is not read from the environment at runtime the way
# `API_INTERNAL_URL` is (see apps/web/lib/api-client.ts). That means it
# must be supplied as a *build* ARG, not a compose `environment:` entry;
# setting it only at `docker run`/Compose time would leave the browser
# bundle pointed at whatever (or nothing) was baked in at image-build
# time. `API_INTERNAL_URL`, by contrast, is read by the Next *server*
# (Route Handlers) on every request, so it is deliberately left unset in
# this image and supplied at container runtime by docker-compose.yml
# instead — the same image can then be pointed at a different internal
# API host without a rebuild.
#
# `output: 'standalone'` (next.config.ts) is what makes the runtime stage
# possible without carrying the whole workspace: it traces exactly the
# files `next start` needs (server.js plus a minimal node_modules) instead
# of requiring the full pruned install.

ARG PNPM_VERSION=10.2.1
ARG TURBO_VERSION=2.10.12

FROM node:22-alpine AS base
# @reviews/db's generate script (packages/db/scripts/safe-generate.sh) is
# a bash script; alpine's default shell is ash/busybox, which doesn't run
# it. @reviews/web doesn't use @reviews/db directly, but it is pruned in
# alongside @reviews/web (see the pruner stage below) purely to satisfy
# turbo.json's build->generate dependency, so this build hits the same
# script.
RUN apk add --no-cache bash && corepack enable

FROM base AS pruner
WORKDIR /app
ARG TURBO_VERSION
RUN npm install -g turbo@${TURBO_VERSION}
COPY . .
# turbo.json's `build` task depends on `@reviews/db#generate` for *every*
# package, not only packages that actually depend on @reviews/db — so
# @reviews/db must be in the pruned set here even though @reviews/web's
# own dependency graph never reaches it, or turbo can't resolve that task
# reference at all ("Could not find package @reviews/db").
RUN turbo prune @reviews/web @reviews/db --docker

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
# Published host port, not the Compose service name: this is what the
# *browser* will call, and the browser cannot resolve "api".
ARG NEXT_PUBLIC_API_URL=http://localhost:3001/api/v1
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN turbo run build --filter=@reviews/web...

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=10 \
  CMD wget -q -O- http://127.0.0.1:3000 || exit 1
CMD ["node", "apps/web/server.js"]
