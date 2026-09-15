# syntax=docker/dockerfile:1
#
# Multi-stage build for @reviews/api. Also provides the `migrate` target
# that docker-compose.yml's one-shot `migrate` service runs. It is kept in
# this file rather than a fourth Dockerfile because it shares the same
# base image and pnpm/turbo setup — but it is built from its own, separate
# pruned dependency tree (see db-pruner/db-deps/migrate below), scoped to
# just @reviews/db, not to @reviews/api. Reusing the API's own `build`
# stage was the first approach and it worked, but it dragged in
# everything @reviews/api's devDependencies need — @nestjs/cli, swc,
# testcontainers for Postgres/Redis, passport, supertest — none of which
# `prisma migrate deploy && prisma db seed` touches. Scoping the install to
# @reviews/db alone (below) removes all of that.
#
# What's left is still ~640MB, and it is worth saying plainly what that is
# rather than leaving it unremarked: @prisma/client + the Prisma CLI +
# their query engines are ~190MB on their own — an unavoidable cost of
# anything that runs `prisma migrate`. The rest is @reviews/db's own
# devDependencies — @testcontainers/postgresql, eslint, vitest, typescript
# — which exist for *its* lint/test scripts, not for migrate/seed, but
# come along anyway because pnpm has no supported way to install "some but
# not all devDependencies" of one workspace package.
#
# Two leaner alternatives were tried and rejected:
#   - `pnpm install --frozen-lockfile --prod` (skip devDependencies
#     entirely, ~217MB), then add back just `prisma`+`tsx` with
#     `pnpm add`: pnpm refuses this outright —
#     `ERR_PNPM_INCLUDED_DEPS_CONFLICT: modules directory ... was
#     installed with optionalDependencies, dependencies. Current install
#     wants optionalDependencies, dependencies, devDependencies.` — a
#     node_modules built with one set of included dependency types can't
#     be topped up with another; only a fresh install can add a dep type.
#   - Same `--prod` install, then `npm install -g prisma tsx` alongside
#     it: this actually made the image *larger* (816MB), because the
#     globally-installed `prisma` package fetches its own, separate copy
#     of the query engines rather than reusing the ones pnpm's store
#     already fetched for @prisma/client — duplicating the single biggest
#     line item instead of avoiding it.
# A full install scoped to just @reviews/db, despite the devDependency
# weight it can't shed, was the more reliable option given that.
#
# Stages:
#   base      - Node + bash (see below) + corepack, nothing project-specific.
#   pruner    - `turbo prune` cuts the monorepo down to @reviews/api and the
#               workspace packages it actually depends on (@reviews/db,
#               @reviews/contracts, @reviews/tooling), so nothing from
#               apps/web or apps/worker ends up in the api image or its
#               cache layers.
#   deps      - installs exactly the pruned dependency set, dev deps
#               included: `build` below needs typescript, the Nest CLI,
#               and the Prisma CLI (transitively, via @reviews/db#generate).
#   build     - copies in the pruned source and runs
#               `turbo run build --filter=@reviews/api...`, which (per
#               turbo.json) also runs @reviews/db's `generate` task first,
#               so the Prisma client and its query engine exist in
#               node_modules/.pnpm before anything tries to import it.
#   prod-deps - a second, independent branch from `pruner` (not built on
#               top of `build`): a plain `pnpm install --frozen-lockfile
#               --prod`, with the generated Prisma client spliced in from
#               `build` afterward. See the comment on this stage below for
#               why it isn't simply `build` plus `pnpm prune --prod`.
#   runtime   - a fresh node:22-alpine layer carrying just the built
#               output and the production-only node_modules, run as the
#               non-root `node` user the base image already provides.
#
#   db-pruner - a second, independent `turbo prune`, scoped to @reviews/db
#               alone, for the migrate image below.
#   db-deps   - installs that smaller dependency set (dev deps included:
#               migrate needs the Prisma CLI and tsx).
#   migrate   - `docker-compose.yml` target for the one-shot migrate/seed
#               job. Generates the Prisma client, then runs as the
#               non-root `node` user with `prisma migrate deploy` and
#               `prisma db seed` as its command.

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
RUN turbo prune @reviews/api --docker

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
# `prisma generate` (run as part of the `generate` task below) does not
# need a reachable database — it only reads prisma/schema.prisma — so no
# DATABASE_URL is required here. The real one is supplied at container
# runtime by docker-compose.yml.
RUN turbo run build --filter=@reviews/api...

FROM base AS prod-deps
WORKDIR /app
ARG PNPM_VERSION
RUN corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=pruner /app/out/json/ .
# A genuine --prod install, not `build`'s full install pruned afterward.
# `pnpm prune --prod` (with CI=true to dodge its interactive "reinstall
# from scratch?" prompt) was tried first: it completes, but the prompt it
# auto-answers *is* a full wipe-and-reinstall, and pnpm does not reliably
# restore each workspace package's own node_modules symlinks through it —
# apps/api/node_modules/reflect-metadata and its neighbours came back
# empty. The container built that way starts and looks fine right up
# until `node main.js` throws `ERR_MODULE_NOT_FOUND: reflect-metadata`. A
# clean --prod install from the pruned manifests has no such gap.
RUN pnpm install --frozen-lockfile --prod
COPY --from=pruner /app/out/full/ .
# This install never ran `prisma generate` (the Prisma CLI is a
# devDependency, excluded by --prod), so @prisma/client here is the
# unwritten package shell with no query engine. Splice in the actual
# generated client from the `build` stage instead of regenerating it.
# `auto-install-peers=true` (.npmrc) means `prisma`/`typescript` —
# @prisma/client's peers — get installed here too despite --prod, so the
# hashed .pnpm folder name matches `build`'s; `find` below still resolves
# it dynamically rather than hardcoding the hash, so a Prisma/TypeScript
# version bump can't make this silently copy into the wrong place.
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
# node_modules from prod-deps (production-only, correctly linked); the
# built dist output and package.json files from `build` (prod-deps never
# compiles anything, it only installs).
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=node:node /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
USER node
EXPOSE 3001
# node:22-alpine has no curl; wget is part of busybox, so it costs nothing
# extra in the image.
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=10 \
  CMD wget -q -O- http://127.0.0.1:3001/api/v1/health || exit 1
CMD ["node", "apps/api/dist/src/main.js"]

# ---- migrate: its own pruned tree, scoped to @reviews/db only ----

FROM base AS db-pruner
WORKDIR /app
ARG TURBO_VERSION
RUN npm install -g turbo@${TURBO_VERSION}
COPY . .
RUN turbo prune @reviews/db --docker

FROM base AS db-deps
WORKDIR /app
ARG PNPM_VERSION
RUN corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=db-pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM base AS migrate
WORKDIR /app
ARG PNPM_VERSION
RUN corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=db-deps /app/ .
COPY --from=db-pruner /app/out/full/ .
RUN pnpm --filter @reviews/db run generate
WORKDIR /app/packages/db
ENV NODE_ENV=production
USER node
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm exec prisma db seed"]
