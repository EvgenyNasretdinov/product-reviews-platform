# 0001: Modular monolith over microservices

## Context

The system has one bounded context — reviews, products, and the moderation
and rating machinery around them — deployed as three processes (`apps/api`,
`apps/worker`, `apps/web`) over shared Postgres, Redis, and RabbitMQ. Nothing
in the domain forces a split narrower than that: there is one team, one
release cadence, and no part of the write path that needs to scale, fail, or
deploy independently of the rest.

The question was whether to draw service boundaries around sub-domains
(reviews, moderation, ratings, catalogue) as independently deployable
services communicating over the network, or to keep them as modules inside
a small number of processes communicating through the database and the
outbox.

## Decision

Keep it a modular monolith: three processes, module boundaries enforced by
directory structure and NestJS module wiring rather than by a network hop.
`apps/api` owns every write and the HTTP surface; `apps/worker` owns the
outbox relay and the event consumers; `apps/web` is the frontend. The
module boundaries inside `apps/api` (products, reviews, moderation, auth)
are drawn so that lifting one out into its own service later is a
mechanical extraction — new process, new Dockerfile, same interfaces —
not a rewrite.

## Consequences

- One `docker compose up` starts the whole system; there is no per-service
  deployment pipeline, service mesh, or inter-service auth to build or
  operate.
- A schema change to `reviews` or `product_rating_summary` is a single
  migration, not a coordinated multi-service rollout.
- The API and worker still communicate asynchronously through Postgres and
  RabbitMQ (see ADR 0002), so the module split already exercises the seam a
  future service extraction would use — the monolith isn't hiding a design
  that assumes synchronous, in-process calls everywhere.
- If a module ever needs independent scaling (e.g. moderation becomes CPU-
  heavy with a real ML classifier) or an independent team takes it over,
  extraction has a natural seam: the module already only talks to the rest
  of the system through its outbox events and its own repository.

## Alternatives considered

- **Service-per-domain** (a reviews service, a moderation service, a rating
  service, each with its own deployment). Rejected — not because it is too
  complex in the abstract, but because nothing here needs independent
  scaling or independent deployment. A catalogue of this size and a write
  volume this low would pay the cost of network calls, service discovery,
  and distributed tracing between services that all share one database
  anyway, without buying anything back. That trade only turns around once
  a module has genuinely different scaling needs or ownership from the
  rest, and this project has neither.
