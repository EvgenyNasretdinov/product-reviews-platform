# Plan 1 — Foundation and Synchronous API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested REST API for products, reviews, votes, and moderation, backed by Postgres and Redis, with domain events written to an outbox table but not yet delivered anywhere.

**Architecture:** pnpm monorepo. `packages/contracts` holds Zod schemas shared by every app; `packages/db` owns the Prisma schema and migrations; `apps/api` is a NestJS HTTP service that owns all writes and writes outbox rows inside the same transaction as each state change. The event consumers that drain the outbox arrive in Plan 2 — until then the outbox simply accumulates rows, and the tests assert on those rows.

**Tech Stack:** TypeScript 5.7, Node 22 LTS, pnpm 10 workspaces, Turborepo, NestJS 11, Prisma 6, Postgres 17, Redis 7, Vitest 3, Testcontainers, supertest, Zod 3, argon2.

**Spec:** `docs/design/2026-09-13-product-reviews-design.md`

## Global Constraints

- Node 22 LTS everywhere: `.nvmrc`, every Dockerfile, every CI job. The dev machine runs Node 23; do not rely on that.
- Package names are scoped `@reviews/*`. The repository is `product-reviews-platform`.
- **No employer, client, or company name appears anywhere in the repository** — not in package names, README, code, comments, fixtures, or commit messages. The repository is public.
- **Commit messages carry no AI attribution trailer** (no `Co-Authored-By`, no "Generated with"). Conventional Commits format: `type(scope): subject`, imperative mood, body explaining *why*.
- All identifiers for business entities are UUIDv7. `outbox.id` is `BIGINT GENERATED ALWAYS AS IDENTITY` — never `BIGSERIAL`.
- API base path is `/api/v1`. OpenAPI is served at `/docs`.
- Every table and column name in Postgres is `snake_case`; Prisma models are `PascalCase` with explicit `@map`/`@@map`.
- Tests use Vitest, never Jest, in every package including the NestJS apps.
- No `any` in committed TypeScript. ESLint runs with `@typescript-eslint` recommended-type-checked.

---

### Task 1: Workspace bootstrap and shared tooling

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.npmrc`, `.editorconfig`
- Create: `packages/tooling/package.json`, `packages/tooling/tsconfig.base.json`, `packages/tooling/eslint.config.mjs`, `packages/tooling/vitest.base.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `@reviews/tooling` exporting `tsconfig.base.json` (path `@reviews/tooling/tsconfig.base.json`), a flat ESLint config as the package's `./eslint` export, and `defineBaseConfig()` from `./vitest` returning a Vitest `UserConfig` with `globals: true`, `environment: 'node'`, and `passWithNoTests: false`.
- Root scripts every later task relies on: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, all delegating to `turbo run <task>`.

- [ ] **Step 1: Create the workspace manifest**

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Root `package.json`:

```json
{
  "name": "product-reviews-platform",
  "private": true,
  "packageManager": "pnpm@10.2.1",
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:unit": "turbo run test:unit",
    "test:integration": "turbo run test:integration"
  },
  "devDependencies": {
    "turbo": "^2.3.0",
    "typescript": "^5.7.0"
  }
}
```

`.nvmrc` contains exactly `22`.

`.npmrc`:

```
engine-strict=true
auto-install-peers=true
```

- [ ] **Step 2: Configure Turborepo**

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {},
    "test:unit": { "dependsOn": ["^build"] },
    "test:integration": { "dependsOn": ["^build"], "cache": false },
    "test": { "dependsOn": ["test:unit", "test:integration"] }
  }
}
```

`test:integration` is uncached because it depends on live containers, not just on file inputs.

- [ ] **Step 3: Create the shared tooling package**

`packages/tooling/package.json`:

```json
{
  "name": "@reviews/tooling",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./tsconfig.base.json": "./tsconfig.base.json",
    "./eslint": "./eslint.config.mjs",
    "./vitest": "./vitest.base.ts"
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "eslint": "^9.17.0",
    "typescript-eslint": "^8.18.0",
    "vitest": "^3.0.0"
  }
}
```

`packages/tooling/tsconfig.base.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": false,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

`experimentalDecorators` and `emitDecoratorMetadata` are on because NestJS requires them; `apps/web` overrides them off.

`packages/tooling/vitest.base.ts`:

```ts
import type { UserConfig } from 'vitest/config';

export function defineBaseConfig(overrides: UserConfig = {}): UserConfig {
  return {
    ...overrides,
    test: {
      globals: true,
      environment: 'node',
      passWithNoTests: false,
      ...overrides.test,
    },
  };
}
```

`packages/tooling/eslint.config.mjs` exports a flat config array built from `@eslint/js` recommended plus `typescript-eslint` `recommendedTypeChecked`, with `languageOptions.parserOptions.projectService = true`, and a rule block setting `@typescript-eslint/no-explicit-any` to `error` and `@typescript-eslint/consistent-type-imports` to `error`. It ignores `dist`, `.next`, `coverage`, and `node_modules`.

- [ ] **Step 4: Verify the workspace resolves**

Run: `pnpm install && pnpm typecheck && pnpm lint`
Expected: install succeeds; both turbo tasks report no packages with those scripts yet (turbo exits 0 with "No tasks were executed"). If turbo exits non-zero because no task matched, that is acceptable at this point only for this step — later tasks add real scripts.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(repo): bootstrap pnpm workspace with shared tooling

Sets up pnpm workspaces, Turborepo task orchestration, and a single
@reviews/tooling package holding the TypeScript, ESLint, and Vitest
configuration that every other package extends, so that lint and
compiler settings are defined once rather than drifting per package.

Node is pinned to 22 LTS in .nvmrc; the same version is used in the
Docker images and CI so a reviewer builds what CI builds."
```

---

### Task 2: Local infrastructure with Docker Compose

**Files:**
- Create: `docker-compose.dev.yml`, `.env.example`
- Create: `scripts/check-infra.sh`
- Modify: root `package.json` (add `infra:up`, `infra:down`, `infra:check` scripts)

**Interfaces:**
- Produces: Postgres on `localhost:5432` (db `reviews`, user `reviews`, password `reviews`), Redis on `localhost:6379`, RabbitMQ on `localhost:5672` with the management UI on `localhost:15672` (guest/guest). Env var names fixed here and used by every later task: `DATABASE_URL`, `REDIS_URL`, `RABBITMQ_URL`.

- [ ] **Step 1: Write the infrastructure smoke check first**

`scripts/check-infra.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

fail() { echo "FAIL: $1" >&2; exit 1; }

docker compose -f docker-compose.dev.yml exec -T postgres \
  pg_isready -U reviews -d reviews >/dev/null 2>&1 || fail "postgres not ready"

docker compose -f docker-compose.dev.yml exec -T redis \
  redis-cli ping 2>/dev/null | grep -q PONG || fail "redis not ready"

docker compose -f docker-compose.dev.yml exec -T rabbitmq \
  rabbitmq-diagnostics -q ping >/dev/null 2>&1 || fail "rabbitmq not ready"

echo "OK: postgres, redis, rabbitmq are reachable"
```

Make it executable: `chmod +x scripts/check-infra.sh`.

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/check-infra.sh`
Expected: FAIL — no compose file exists yet, so `docker compose` errors out.

- [ ] **Step 3: Write the compose file**

`docker-compose.dev.yml` defines three services, each with a healthcheck and a named volume:

- `postgres`: image `postgres:17-alpine`, env `POSTGRES_USER=reviews`, `POSTGRES_PASSWORD=reviews`, `POSTGRES_DB=reviews`, port `5432:5432`, healthcheck `pg_isready -U reviews -d reviews` every 5s with 10 retries, volume `pgdata:/var/lib/postgresql/data`.
- `redis`: image `redis:7-alpine`, port `6379:6379`, healthcheck `redis-cli ping`.
- `rabbitmq`: image `rabbitmq:4-management-alpine`, ports `5672:5672` and `15672:15672`, healthcheck `rabbitmq-diagnostics -q ping`, volume `rabbitmqdata:/var/lib/rabbitmq`.

`.env.example`:

```
DATABASE_URL=postgresql://reviews:reviews@localhost:5432/reviews?schema=public
REDIS_URL=redis://localhost:6379
RABBITMQ_URL=amqp://guest:guest@localhost:5672
JWT_SECRET=dev-only-secret-change-me
JWT_EXPIRES_IN=12h
API_PORT=3001
NEXT_PUBLIC_API_URL=http://localhost:3001/api/v1
```

Add to root `package.json` scripts:

```json
"infra:up": "docker compose -f docker-compose.dev.yml up -d --wait",
"infra:down": "docker compose -f docker-compose.dev.yml down -v",
"infra:check": "./scripts/check-infra.sh"
```

`--wait` makes `infra:up` block until every healthcheck passes, so the next command in a script or CI job never races the database.

- [ ] **Step 4: Run the check to verify it passes**

Run: `pnpm infra:up && pnpm infra:check`
Expected: `OK: postgres, redis, rabbitmq are reachable`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(infra): add local Postgres, Redis, and RabbitMQ via Compose

Brings up the three backing services with healthchecks so that
'pnpm infra:up' blocks until they are actually accepting connections
rather than merely started, which removes the usual race between
container start and the first migration.

Application containers are added in a later change; this file is the
infrastructure-only variant used when running the apps on the host."
```

---

### Task 3: Shared contracts package

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/vitest.config.ts`
- Create: `packages/contracts/src/index.ts`, `src/common.ts`, `src/auth.ts`, `src/product.ts`, `src/review.ts`, `src/moderation.ts`, `src/events.ts`
- Test: `packages/contracts/src/review.test.ts`, `packages/contracts/src/events.test.ts`

**Interfaces:**
- Produces, all exported from `@reviews/contracts`:
  - `ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'FLAGGED'` and `reviewStatusSchema`
  - `VoteValue = 'HELPFUL' | 'NOT_HELPFUL'` and `voteValueSchema`
  - `ReviewSort = 'helpful' | 'newest' | 'rating_desc' | 'rating_asc'` and `reviewSortSchema` (default `'helpful'`)
  - `createReviewInputSchema` → `{ rating: number (int 1–5), title: string (3–120), body: string (10–5000) }`
  - `updateReviewInputSchema` — the same three fields, all optional, but `.refine` requires at least one present
  - `reviewDtoSchema` → `{ id, productId, author: { id, displayName }, rating, title, body, status, verifiedPurchase, helpfulCount, notHelpfulCount, createdAt, publishedAt | null, moderationReason: string | null }`
  - `ratingSummaryDtoSchema` → `{ productId, reviewCount, averageRating, distribution: { 1..5: number } }`
  - `productDtoSchema`, `productDetailDtoSchema` (product plus `summary`)
  - `paginatedSchema<T>(item)` → `{ items: T[], nextCursor: string | null }`
  - `loginInputSchema`, `sessionUserDtoSchema` (`{ id, email, displayName, role }`), `roleSchema` (`'CUSTOMER' | 'MODERATOR'`)
  - `moderationDecisionInputSchema` → `{ decision: 'APPROVED' | 'REJECTED', reason: string | null }`
  - `EVENT_TYPES` const object and `eventTypeSchema` for `review.submitted`, `review.approved`, `review.rejected`, `review.flagged`, `review.unpublished`
  - `eventEnvelopeSchema(payload)` → `{ eventId, eventType, version: 1, occurredAt, aggregateType: 'review', aggregateId, payload }`
  - `reviewSubmittedPayloadSchema`, `reviewModeratedPayloadSchema`, `reviewUnpublishedPayloadSchema`

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/review.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createReviewInputSchema, reviewSortSchema, updateReviewInputSchema } from './review.js';

describe('createReviewInputSchema', () => {
  it('accepts a well-formed review', () => {
    const parsed = createReviewInputSchema.parse({
      rating: 5,
      title: 'Excellent build quality',
      body: 'Used it daily for three months without a single issue.',
    });
    expect(parsed.rating).toBe(5);
  });

  it.each([0, 6, 2.5])('rejects rating %s', (rating) => {
    expect(() => createReviewInputSchema.parse({ rating, title: 'Fine', body: 'Long enough body.' })).toThrow();
  });

  it('rejects a body shorter than 10 characters', () => {
    expect(() => createReviewInputSchema.parse({ rating: 4, title: 'Fine', body: 'short' })).toThrow();
  });

  it('trims surrounding whitespace from title and body', () => {
    const parsed = createReviewInputSchema.parse({ rating: 4, title: '  Good  ', body: '  Long enough body.  ' });
    expect(parsed.title).toBe('Good');
  });
});

describe('updateReviewInputSchema', () => {
  it('rejects an empty patch', () => {
    expect(() => updateReviewInputSchema.parse({})).toThrow();
  });

  // Zod keeps a key in the parsed output whenever it was present in the input, even when its
  // value is undefined. A guard written over Object.keys therefore counts these as real edits.
  it('rejects a patch whose only field is undefined', () => {
    expect(() => updateReviewInputSchema.parse({ rating: undefined })).toThrow();
  });

  it('rejects a patch whose every field is undefined', () => {
    expect(() =>
      updateReviewInputSchema.parse({ rating: undefined, title: undefined, body: undefined }),
    ).toThrow();
  });

  it('accepts a rating-only patch', () => {
    expect(updateReviewInputSchema.parse({ rating: 3 })).toEqual({ rating: 3 });
  });
});

describe('reviewSortSchema', () => {
  it('defaults to helpful', () => {
    expect(reviewSortSchema.parse(undefined)).toBe('helpful');
  });

  it('rejects an unknown sort', () => {
    expect(() => reviewSortSchema.parse('cheapest')).toThrow();
  });
});
```

`packages/contracts/src/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, eventEnvelopeSchema, reviewSubmittedPayloadSchema } from './events.js';

const envelope = eventEnvelopeSchema(reviewSubmittedPayloadSchema);

const validSubmittedEnvelope = {
  eventId: '0193a6f0-0000-7000-8000-000000000001',
  eventType: EVENT_TYPES.REVIEW_SUBMITTED,
  version: 1,
  occurredAt: '2026-09-13T10:00:00.000Z',
  aggregateType: 'review',
  aggregateId: '0193a6f0-0000-7000-8000-000000000002',
  payload: {
    reviewId: '0193a6f0-0000-7000-8000-000000000002',
    productId: '0193a6f0-0000-7000-8000-000000000003',
    authorId: '0193a6f0-0000-7000-8000-000000000004',
    rating: 5,
    title: 'Great',
    body: 'Long enough body text.',
    verifiedPurchase: true,
  },
};

describe('eventEnvelopeSchema', () => {
  it('parses a submitted event and coerces occurredAt to a Date', () => {
    const parsed = envelope.parse({
      eventId: '0193a6f0-0000-7000-8000-000000000001',
      eventType: EVENT_TYPES.REVIEW_SUBMITTED,
      version: 1,
      occurredAt: '2026-09-13T10:00:00.000Z',
      aggregateType: 'review',
      aggregateId: '0193a6f0-0000-7000-8000-000000000002',
      payload: {
        reviewId: '0193a6f0-0000-7000-8000-000000000002',
        productId: '0193a6f0-0000-7000-8000-000000000003',
        authorId: '0193a6f0-0000-7000-8000-000000000004',
        rating: 5,
        title: 'Great',
        body: 'Long enough body text.',
        verifiedPurchase: true,
      },
    });
    expect(parsed.occurredAt).toBeInstanceOf(Date);
  });

  // Change ONLY the version. Passing a bare { version: 2 } would throw because every other
  // required field is missing, and the assertion would pass against an unconstrained z.number().
  it('rejects an envelope whose version is unknown', () => {
    expect(() => envelope.parse({ ...validSubmittedEnvelope, version: 2 })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @reviews/contracts test:unit`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Implement the schemas**

Create the package manifest depending on `zod@^3.24.0`, with scripts `build: tsc -b`, `typecheck: tsc --noEmit`, `lint: eslint .`, `test:unit: vitest run`, `test: vitest run`. `tsconfig.json` extends `@reviews/tooling/tsconfig.base.json` with `rootDir: src`, `outDir: dist`.

Write the schema modules to match the Interfaces block above. Key details the tests pin down:

```ts
// src/review.ts
export const createReviewInputSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(10).max(5000),
});

export const updateReviewInputSchema = createReviewInputSchema
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
    message: 'at least one field must be provided',
  });

export const reviewSortSchema = z
  .enum(['helpful', 'newest', 'rating_desc', 'rating_asc'])
  .default('helpful');
```

```ts
// src/events.ts
export const EVENT_TYPES = {
  REVIEW_SUBMITTED: 'review.submitted',
  REVIEW_APPROVED: 'review.approved',
  REVIEW_REJECTED: 'review.rejected',
  REVIEW_FLAGGED: 'review.flagged',
  REVIEW_UNPUBLISHED: 'review.unpublished',
} as const;

export function eventEnvelopeSchema<T extends z.ZodTypeAny>(payload: T) {
  return z.object({
    eventId: z.string().uuid(),
    eventType: eventTypeSchema,
    version: z.literal(1),
    occurredAt: z.coerce.date(),
    aggregateType: z.literal('review'),
    aggregateId: z.string().uuid(),
    payload,
  });
}
```

`src/index.ts` re-exports every module.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @reviews/contracts test:unit && pnpm --filter @reviews/contracts typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(contracts): add shared Zod schemas for DTOs and domain events

Puts the API request and response shapes and the event envelope in one
package so the HTTP service, the worker, and the web app validate
against the same definitions instead of three drifting copies.

Events carry an explicit version field from the start, which makes a
future payload change an additive migration rather than a coordinated
deploy of producer and consumer."
```

---

### Task 4: Database schema, identity migration, and seed data

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/vitest.config.ts`
- Create: `packages/db/prisma/schema.prisma`, `packages/db/prisma/seed.ts`
- Create: `packages/db/src/index.ts`
- Test: `packages/db/test/schema.integration.test.ts`, `packages/db/test/setup.ts`

**Interfaces:**
- Produces: `@reviews/db` exporting `PrismaClient`, the generated model types, and `createPrismaClient(url?: string): PrismaClient`.
- Prisma models: `User`, `Product`, `Purchase`, `Review`, `ReviewVote`, `ProductRatingSummary`, `OutboxEvent` mapped to `users`, `products`, `purchases`, `reviews`, `review_votes`, `product_rating_summary`, `outbox`.
- Seed users, referenced by every later test and by the web login picker:
  - `alice@example.com` / `password123` — CUSTOMER, has purchases
  - `bob@example.com` / `password123` — CUSTOMER, no purchases
  - `mod@example.com` / `password123` — MODERATOR

- [ ] **Step 1: Write the failing schema test**

`packages/db/test/schema.integration.test.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../src/index.js';
import type { PrismaClient } from '../src/index.js';

let container: StartedPostgreSqlContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const url = container.getConnectionUri();
  execSync('pnpm prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  prisma = createPrismaClient(url);
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

async function seedProductAndUser() {
  const user = await prisma.user.create({
    data: { email: `u${Date.now()}@example.com`, displayName: 'U', passwordHash: 'x', role: 'CUSTOMER' },
  });
  const product = await prisma.product.create({
    data: { slug: `p-${Date.now()}`, name: 'P', description: 'd', priceCents: 100, currency: 'EUR' },
  });
  return { user, product };
}

describe('reviews table', () => {
  it('allows only one review per author per product', async () => {
    const { user, product } = await seedProductAndUser();
    const base = { productId: product.id, authorId: user.id, rating: 5, title: 't', body: 'b' };
    await prisma.review.create({ data: base });
    await expect(prisma.review.create({ data: base })).rejects.toThrow(/Unique constraint/);
  });

  it('rejects a rating outside 1..5', async () => {
    const { user, product } = await seedProductAndUser();
    await expect(
      prisma.review.create({ data: { productId: product.id, authorId: user.id, rating: 6, title: 't', body: 'b' } }),
    ).rejects.toThrow();
  });

  it('deletes votes when the review is deleted', async () => {
    const { user, product } = await seedProductAndUser();
    const review = await prisma.review.create({
      data: { productId: product.id, authorId: user.id, rating: 4, title: 't', body: 'b' },
    });
    await prisma.reviewVote.create({ data: { reviewId: review.id, userId: user.id, value: 'HELPFUL' } });
    await prisma.review.delete({ where: { id: review.id } });
    expect(await prisma.reviewVote.count({ where: { reviewId: review.id } })).toBe(0);
  });

  it('issues time-ordered UUIDv7 identifiers', async () => {
    const { product: first } = await seedProductAndUser();
    const { product: second } = await seedProductAndUser();
    expect(first.id < second.id).toBe(true);
    expect(first.id[14]).toBe('7'); // version nibble
  });
});

describe('outbox table', () => {
  it('uses an identity column rather than a serial default', async () => {
    const rows = await prisma.$queryRaw<Array<{ is_identity: string; column_default: string | null }>>`
      SELECT is_identity, column_default
      FROM information_schema.columns
      WHERE table_name = 'outbox' AND column_name = 'id'
    `;
    expect(rows[0]?.is_identity).toBe('YES');
    expect(rows[0]?.column_default).toBeNull();
  });

  it('refuses an explicitly supplied id', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload)
                         VALUES (1, 'review', gen_random_uuid(), 'review.submitted', '{}'::jsonb)`,
    ).rejects.toThrow();
  });

  it('assigns increasing ids', async () => {
    const { product } = await seedProductAndUser();
    const a = await prisma.outboxEvent.create({
      data: { aggregateType: 'review', aggregateId: product.id, eventType: 'review.submitted', payload: {} },
    });
    const b = await prisma.outboxEvent.create({
      data: { aggregateType: 'review', aggregateId: product.id, eventType: 'review.submitted', payload: {} },
    });
    expect(b.id > a.id).toBe(true);
  });
});
```

The `is_identity` assertion is the test that pins down the whole `BIGSERIAL`-versus-identity decision, and the explicit-id test proves `GENERATED ALWAYS` rather than `BY DEFAULT`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/db test:integration`
Expected: FAIL — no schema, no migration, no client.

- [ ] **Step 3: Write the Prisma schema**

`packages/db/prisma/schema.prisma`. Generator `prisma-client-js`, datasource `postgresql` from `env("DATABASE_URL")`.

Models, with every field mapped to snake_case:

```prisma
enum Role { CUSTOMER MODERATOR }
enum ReviewStatus { PENDING APPROVED REJECTED FLAGGED }
enum VoteValue { HELPFUL NOT_HELPFUL }

model User {
  id           String   @id @default(uuid(7)) @db.Uuid
  email        String   @unique
  displayName  String   @map("display_name")
  passwordHash String   @map("password_hash")
  role         Role     @default(CUSTOMER)
  createdAt    DateTime @default(now()) @map("created_at")
  reviews      Review[]
  votes        ReviewVote[]
  purchases    Purchase[]
  @@map("users")
}

model Review {
  id               String       @id @default(uuid(7)) @db.Uuid
  productId        String       @map("product_id") @db.Uuid
  authorId         String       @map("author_id") @db.Uuid
  rating           Int
  title            String
  body             String
  status           ReviewStatus @default(PENDING)
  verifiedPurchase Boolean      @default(false) @map("verified_purchase")
  moderationReason String?      @map("moderation_reason")
  helpfulCount     Int          @default(0) @map("helpful_count")
  notHelpfulCount  Int          @default(0) @map("not_helpful_count")
  createdAt        DateTime     @default(now()) @map("created_at")
  updatedAt        DateTime     @updatedAt @map("updated_at")
  publishedAt      DateTime?    @map("published_at")

  product Product      @relation(fields: [productId], references: [id], onDelete: Cascade)
  author  User         @relation(fields: [authorId], references: [id], onDelete: Cascade)
  votes   ReviewVote[]

  @@unique([productId, authorId])
  @@index([productId, status, createdAt(sort: Desc)])
  @@index([productId, status, helpfulCount(sort: Desc)])
  @@map("reviews")
}

model OutboxEvent {
  id            BigInt    @id @default(autoincrement())
  aggregateType String    @map("aggregate_type")
  aggregateId   String    @map("aggregate_id") @db.Uuid
  eventType     String    @map("event_type")
  payload       Json
  occurredAt    DateTime  @default(now()) @map("occurred_at")
  publishedAt   DateTime? @map("published_at")
  attempts      Int       @default(0)
  lastError     String?   @map("last_error")

  @@index([id], map: "outbox_unpublished_idx")
  @@map("outbox")
}
```

`Product`, `Purchase`, `ReviewVote`, and `ProductRatingSummary` follow the same conventions; `ReviewVote` uses `@@id([reviewId, userId])` and `onDelete: Cascade` on both relations; `ProductRatingSummary` uses `productId` as `@id` with `reviewCount`, `ratingSum`, `averageRating Decimal @db.Decimal(3,2)`, and `count1`..`count5`.

- [ ] **Step 4: Generate the migration and hand-edit it**

Run: `pnpm --filter @reviews/db exec prisma migrate dev --name init --create-only`

Then edit the generated `packages/db/prisma/migrations/*_init/migration.sql`:

1. Replace `"id" BIGSERIAL NOT NULL` on the `outbox` table with `"id" BIGINT GENERATED ALWAYS AS IDENTITY`.
2. Add the check constraint and the partial index, which Prisma cannot express:

```sql
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

DROP INDEX IF EXISTS "outbox_unpublished_idx";
CREATE INDEX "outbox_unpublished_idx" ON "outbox" ("id") WHERE "published_at" IS NULL;
```

Add a comment at the top of the edited migration explaining that the identity column is intentional and must survive future regeneration.

- [ ] **Step 5: Verify Prisma does not report drift**

Run: `pnpm --filter @reviews/db exec prisma migrate dev --name drift-check`
Expected: Prisma reports "Already in sync, no schema change or pending migration was found" and creates no new migration.

If instead Prisma wants to recreate the column as `BIGSERIAL`, stop and take the fallback: keep the identity column in the migration, add `id BigInt @id @default(dbgenerated())` is **not** valid here — instead mark the model field as `@default(autoincrement())` and add `packages/db/prisma/migrations/.drift-note.md` recording the behaviour. Then write an ADR at `docs/adr/0002-identity-columns-over-bigserial.md` documenting what Prisma actually does and how the migration is protected. Either way the test from Step 1 must pass.

- [ ] **Step 6: Write the client wrapper and seed**

`packages/db/src/index.ts`:

```ts
import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';
export { PrismaClient };

export function createPrismaClient(url?: string): PrismaClient {
  return new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
}
```

`packages/db/prisma/seed.ts` creates: the three users above with argon2id hashes of `password123`; eight products with realistic names, descriptions, prices in EUR, and `image_url` pointing at a deterministic placeholder service; purchases linking Alice to four of them; and roughly thirty approved reviews spread unevenly across products so the histogram has visible shape, plus one `FLAGGED` and one `PENDING` review so the moderation queue is not empty on first run. Seeded approved reviews must also populate `product_rating_summary` so the catalogue is not blank before the worker exists.

Add `"prisma": { "seed": "tsx prisma/seed.ts" }` to the package manifest and a `db:seed` script.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @reviews/db test:integration`
Expected: PASS, all eight assertions including `is_identity === 'YES'`.

Then run the seed against local infrastructure and confirm it is idempotent:
Run: `pnpm infra:up && pnpm --filter @reviews/db db:migrate && pnpm --filter @reviews/db db:seed && pnpm --filter @reviews/db db:seed`
Expected: the second run succeeds without unique-constraint errors (the seed upserts by natural key).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(db): add schema, migrations, and seed data

Models products, users, reviews, votes, purchases, the rating summary
projection, and the outbox journal.

Two constraints are enforced in the database rather than in application
code because they are invariants rather than validation: one review per
author per product, and a rating between 1 and 5. The unique constraint
doubles as natural idempotency for a retried submission.

The outbox id is a standard identity column rather than BIGSERIAL. The
generated migration is hand-edited for this, and a test asserts
information_schema.is_identity so a regenerated migration cannot
silently revert it."
```

---

### Task 5: API skeleton, configuration, and health checks

**Files:**
- Create: `apps/api/package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `vitest.config.ts`, `vitest.integration.config.ts`
- Create: `apps/api/src/main.ts`, `src/app.module.ts`
- Create: `apps/api/src/config/env.ts`, `src/config/config.module.ts`
- Create: `apps/api/src/common/prisma/prisma.service.ts`, `prisma.module.ts`
- Create: `apps/api/src/health/health.controller.ts`, `health.module.ts`
- Test: `apps/api/src/config/env.test.ts`, `apps/api/test/health.integration.test.ts`, `apps/api/test/harness.ts`

**Interfaces:**
- Produces:
  - `loadEnv(source: NodeJS.ProcessEnv): AppEnv` from `src/config/env.ts`, where `AppEnv` is `{ nodeEnv, apiPort, databaseUrl, redisUrl, rabbitmqUrl, jwtSecret, jwtExpiresIn, reviewSubmitRateLimit }`. Throws an `Error` listing every invalid variable at once.
  - `PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy`.
  - `apps/api/test/harness.ts` exporting two entry points. **Every later integration task uses this harness** — it starts Postgres and Redis containers once per Vitest worker via a global setup and runs `prisma migrate deploy`.
    - `setupTestApp(envOverrides?: Record<string, string>): TestContext` — **the default path every suite uses.** Called once at the top level of a test file; it registers `beforeAll` (create), `afterEach` (truncate), and `afterAll` (close) itself, so truncation between tests cannot be forgotten. Returns a context exposing `app`, `prisma`, and `request`.
    - `createTestApp(envOverrides?): Promise<TestApp>` — the manual-control escape hatch, for the rare suite that boots a second app (for example one deliberately configured with a dead dependency). A suite using it owns its own truncation.
    - `envOverrides` are applied to `process.env` before the Nest module compiles, and **every** overridable key is reset to its default on each call — the suites share one worker, so a key left set by an earlier file would silently change a later one's behaviour.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/config/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  NODE_ENV: 'test',
  API_PORT: '3001',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  JWT_SECRET: 'x'.repeat(32),
  JWT_EXPIRES_IN: '12h',
};

describe('loadEnv', () => {
  it('parses a valid environment and coerces the port to a number', () => {
    expect(loadEnv(valid).apiPort).toBe(3001);
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('reports every invalid variable at once', () => {
    expect(() => loadEnv({ ...valid, API_PORT: 'nope', REDIS_URL: 'not-a-url' })).toThrow(/API_PORT[\s\S]*REDIS_URL/);
  });
});
```

`apps/api/test/health.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './harness.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('GET /api/v1/health', () => {
  it('reports the service as alive', async () => {
    const res = await ctx.request.get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });
});

describe('GET /api/v1/health/ready', () => {
  it('reports each dependency', async () => {
    const res = await ctx.request.get('/api/v1/health/ready').expect(200);
    expect(res.body.checks).toMatchObject({ database: 'up', cache: 'up' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @reviews/api test:unit`
Expected: FAIL — `./env.js` does not exist.

- [ ] **Step 3: Implement configuration**

`src/config/env.ts` builds a Zod object schema over the raw env, uses `z.coerce.number()` for ports, `z.string().min(32)` for `JWT_SECRET`, `z.string().url()` for the three connection URLs, and defaults `REVIEW_SUBMIT_RATE_LIMIT` to `5` per hour. On failure it throws with `error.issues.map((i) => \`${i.path.join('.')}: ${i.message}\`).join('\n')` so all problems surface in one run rather than one restart per typo.

- [ ] **Step 4: Implement the Nest application skeleton**

`src/main.ts` creates the app, sets `app.setGlobalPrefix('api/v1')`, enables a `ValidationPipe` configured with `whitelist: true` and `forbidNonWhitelisted: true`, enables CORS for the web origin, registers a global exception filter that maps Prisma `P2002` (unique violation) to `409` and `P2025` (record not found) to `404`, and listens on `apiPort`.

`PrismaService` extends the generated client and calls `$connect()` in `onModuleInit`.

`HealthController` exposes `GET /health` returning `{ status: 'ok', uptime }` without touching dependencies, and `GET /health/ready` running `SELECT 1` against Postgres and `PING` against Redis, returning `200` with `{ status, checks }` when both are up and `503` when either is down. Liveness must not check dependencies — otherwise a Redis blip makes Kubernetes restart a healthy process.

- [ ] **Step 5: Build the integration harness**

`apps/api/test/global-setup.ts` starts one `PostgreSqlContainer` and one `RedisContainer`, runs `prisma migrate deploy` against the Postgres URL, and publishes both URLs through `provide()` so tests read them with `inject()`. It stops the containers in teardown.

`apps/api/test/harness.ts`:

```ts
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { inject } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  request: supertest.Agent;
  truncate(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  process.env.DATABASE_URL = inject('databaseUrl');
  process.env.REDIS_URL = inject('redisUrl');
  process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-chars';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app); // the same pipes and filters main.ts installs
  await app.init();

  const prisma = app.get(PrismaService);
  const truncate = async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE outbox, review_votes, reviews, product_rating_summary, purchases, products, users RESTART IDENTITY CASCADE',
    );
  };

  return { app, prisma, request: supertest(app.getHttpServer()), truncate, close: () => app.close() };
}
```

`configureApp(app)` must be extracted into `src/bootstrap.ts` and called from both `main.ts` and the harness, so integration tests exercise the same pipes and filters as production. A test suite that silently skips the global `ValidationPipe` proves nothing about the running service.

- [ ] **Step 6: Run to verify the tests pass**

Run: `pnpm --filter @reviews/api test:unit && pnpm --filter @reviews/api test:integration`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(api): add service skeleton with validated config and health probes

Environment variables are parsed through a Zod schema at startup, so a
missing or malformed value fails immediately with every problem listed
at once instead of surfacing as a null-pointer on the first request
that happens to need it.

Liveness and readiness are separate endpoints: liveness touches no
dependency, so a brief Redis outage cannot cause an orchestrator to
restart an otherwise healthy process.

Adds the integration harness that later tests build on. It boots the
real application through the same bootstrap function main.ts uses, so
the tests exercise the production pipes and exception filters rather
than a stripped-down module."
```

---

### Task 6: Cursor pagination

**Files:**
- Create: `apps/api/src/common/pagination/cursor.ts`
- Test: `apps/api/src/common/pagination/cursor.test.ts`

**Interfaces:**
- Produces: `encodeCursor(key: string | number, id: string): string` and `decodeCursor(cursor: string): { key: string; id: string }`, which throws `BadRequestException` on malformed input. Used by the product list and the review list.

- [ ] **Step 1: Write the failing test**

```ts
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursor codec', () => {
  it('round-trips a key and an id', () => {
    const cursor = encodeCursor(42, '0193a6f0-0000-7000-8000-000000000001');
    expect(decodeCursor(cursor)).toEqual({ key: '42', id: '0193a6f0-0000-7000-8000-000000000001' });
  });

  it('produces url-safe output', () => {
    const cursor = encodeCursor('2026-09-13T10:00:00.000Z', '0193a6f0-0000-7000-8000-000000000001');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each(['', 'not-base64!', Buffer.from('{"key":"a"}').toString('base64url')])(
    'rejects malformed cursor %s',
    (bad) => {
      expect(() => decodeCursor(bad)).toThrow(BadRequestException);
    },
  );
});
```

The third case matters: a cursor missing `id` must be rejected rather than silently paginating on a partial key.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/api test:unit -- cursor`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`encodeCursor` JSON-encodes `{ key: String(key), id }` and writes it as `base64url`. `decodeCursor` decodes, parses, validates with a Zod object requiring both non-empty strings, and wraps any failure in `new BadRequestException('invalid cursor')`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/api test:unit -- cursor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): add opaque cursor codec for keyset pagination

Offset pagination repeats or skips rows whenever the underlying list
changes between requests, which for a review list under active voting
and moderation is constantly. The cursor carries the sort key and the
row id so the next page resumes from an exact position.

The value is opaque base64url rather than a readable composite so that
the sort key can change later without becoming a public contract."
```

---

### Task 7: Authentication and authorisation

**Files:**
- Create: `apps/api/src/auth/auth.module.ts`, `auth.service.ts`, `auth.controller.ts`, `jwt.strategy.ts`, `password.ts`
- Create: `apps/api/src/auth/guards/jwt-auth.guard.ts`, `guards/roles.guard.ts`
- Create: `apps/api/src/auth/decorators/current-user.decorator.ts`, `decorators/roles.decorator.ts`, `decorators/public.decorator.ts`
- Test: `apps/api/src/auth/password.test.ts`, `apps/api/test/auth.integration.test.ts`
- Modify: `apps/api/test/harness.ts` (add `loginAs`)

**Interfaces:**
- Produces:
  - `hashPassword(plain: string): Promise<string>` and `verifyPassword(hash: string, plain: string): Promise<boolean>` using argon2id.
  - `@CurrentUser()` param decorator yielding `{ id: string; email: string; role: Role }`.
  - `@Roles('MODERATOR')` method decorator and `RolesGuard`.
  - `@Public()` to opt an endpoint out of the globally registered `JwtAuthGuard`.
  - Harness addition: `loginAs(email: string): Promise<string>` returning a bearer token, used by every later integration test.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/auth/password.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('password123');
    expect(await verifyPassword(hash, 'password123')).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('password123');
    expect(await verifyPassword(hash, 'password124')).toBe(false);
  });

  it('produces a different hash for the same password', async () => {
    expect(await hashPassword('password123')).not.toBe(await hashPassword('password123'));
  });

  it('returns false rather than throwing on a corrupt hash', async () => {
    expect(await verifyPassword('not-a-hash', 'password123')).toBe(false);
  });
});
```

`apps/api/test/auth.integration.test.ts` covers, using the harness:

1. `POST /auth/login` with valid credentials returns `200` and `{ accessToken, user: { id, email, displayName, role } }`, and the body contains no `passwordHash`.
2. Wrong password returns `401` with the same message and shape as an unknown email — the response must not reveal whether the account exists.
3. Unknown email returns `401`.
4. `GET /auth/me` without a token returns `401`.
5. `GET /auth/me` with the token from case 1 returns the same user.
6. `GET /auth/me` with a token signed by a different secret returns `401`.
7. A moderator-only route returns `403` for a `CUSTOMER` token and `200` for a `MODERATOR` token. Use `GET /moderation/reviews` once Task 14 exists; until then assert against a temporary test-only controller **is not acceptable** — instead move cases 7 into Task 14 and note it there.

Implement cases 1–6 now; case 7 belongs to Task 14.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @reviews/api test:unit -- password`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`password.ts` wraps `argon2.hash(plain, { type: argon2.argon2id })` and `argon2.verify`, catching verification errors and returning `false`.

`AuthService.login(email, password)` loads the user, verifies the hash, and signs `{ sub: user.id, email, role }`. When the user does not exist it must still run a verification against a fixed dummy hash before failing, so response timing does not leak account existence.

`JwtAuthGuard` is registered globally with `APP_GUARD` and skips handlers marked `@Public()`. Public endpoints are: login, product list, product detail, review list, and both health endpoints.

`RolesGuard` reads the `@Roles` metadata and compares against `request.user.role`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @reviews/api test:unit && pnpm --filter @reviews/api test:integration -- auth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): add password login, JWT sessions, and role guards

Passwords are hashed with argon2id. A login attempt for an unknown
email still performs a verification against a dummy hash before
failing, so the response time does not disclose which accounts exist,
and both failure modes return an identical body.

Authentication is a global guard with an explicit @Public() opt-out
rather than an opt-in guard per controller: a new endpoint is then
private by default, and forgetting the decorator fails closed."
```

---

### Task 8: Product catalogue read API

**Files:**
- Create: `apps/api/src/products/products.module.ts`, `products.controller.ts`, `products.service.ts`, `products.repository.ts`, `products.mapper.ts`
- Test: `apps/api/test/products.integration.test.ts`, `apps/api/test/fixtures.ts`

**Interfaces:**
- Consumes: `decodeCursor`/`encodeCursor` (Task 6), `PrismaService` (Task 5), `productDtoSchema`/`productDetailDtoSchema` (Task 3).
- Produces:
  - `GET /api/v1/products?q=&cursor=&limit=` → `{ items: ProductDto[], nextCursor: string | null }`, each item embedding `summary`.
  - `GET /api/v1/products/:slug` → `ProductDetailDto` or `404`.
  - `apps/api/test/fixtures.ts` exporting `createProduct(prisma, overrides?)`, `createUser(prisma, overrides?)`, `createReview(prisma, { productId, authorId, ...overrides })`, and `createSummary(prisma, productId, ratings: number[])`. Every later integration test uses these.

- [ ] **Step 1: Write the failing integration test**

Cases, all against `setupTestApp()` (which truncates between tests for you):

1. Empty catalogue returns `{ items: [], nextCursor: null }`.
2. With three products, the list returns all three ordered by `createdAt DESC, id DESC`.
3. `limit=2` returns two items and a non-null `nextCursor`; requesting that cursor returns the third item and a null `nextCursor`; the two pages share no ids.
4. `q=chair` matches case-insensitively on name and does not match unrelated products.
5. A product with reviews rated `[5,5,4,1]` reports `summary.reviewCount === 4`, `summary.averageRating === 3.75`, and `summary.distribution` equal to `{ '1': 1, '2': 0, '3': 0, '4': 1, '5': 2 }`.
6. A product with no reviews reports `reviewCount: 0`, `averageRating: 0`, and an all-zero distribution rather than a missing `summary`.
7. `GET /products/:slug` returns the detail payload including description.
8. `GET /products/unknown-slug` returns `404`.
9. `limit=500` is rejected with `400` (the cap is 100).

Write these as real `it()` blocks using the fixtures; for example:

```ts
it('reports the rating distribution for a product', async () => {
  const product = await createProduct(ctx.prisma, { slug: 'desk-lamp' });
  const users = await Promise.all([1, 2, 3, 4].map(() => createUser(ctx.prisma)));
  const ratings = [5, 5, 4, 1];
  await Promise.all(
    users.map((u, i) => createReview(ctx.prisma, { productId: product.id, authorId: u.id, rating: ratings[i]!, status: 'APPROVED' })),
  );
  await createSummary(ctx.prisma, product.id, ratings);

  const res = await ctx.request.get('/api/v1/products/desk-lamp').expect(200);

  expect(res.body.summary).toMatchObject({
    reviewCount: 4,
    averageRating: 3.75,
    distribution: { '1': 1, '2': 0, '3': 0, '4': 1, '5': 2 },
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/api test:integration -- products`
Expected: FAIL with `404` on every route.

- [ ] **Step 3: Implement**

`ProductsRepository` owns every Prisma call. The list query is keyset pagination:

```ts
// The two conditions must be combined under AND. Spreading them as two `OR` keys into one
// object literal silently drops the first: searching while paginating would return rows that
// do not match the search, with no error anywhere.
where: {
  AND: [
    ...(q ? [{ OR: [{ name: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] }] : []),
    ...(cursor ? [{ OR: [{ createdAt: { lt: cursorDate } }, { createdAt: cursorDate, id: { lt: cursorId } }] }] : []),
  ],
},
orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
take: limit + 1,
```

Fetching `limit + 1` rows is how `nextCursor` is decided without a second count query.

`products.mapper.ts` converts a Prisma row plus its summary row into the DTO, and — this is the part worth care — synthesises a zero summary when `product_rating_summary` has no row, so the frontend never has to handle a missing field. `averageRating` is converted from Prisma `Decimal` to `number`.

The `limit` query parameter is validated by a Zod pipe: integer, 1–100, default 20.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/api test:integration -- products`
Expected: PASS, all nine cases.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): add product catalogue with embedded rating summaries

Listing and detail read the materialised summary rather than
aggregating reviews per request, so the catalogue costs one indexed
read per product regardless of how many reviews it has.

Products with no reviews get a synthesised zero summary instead of a
missing field, which keeps the client free of a null branch on every
rating display.

Pagination fetches one row beyond the page size to decide whether a
next cursor exists, avoiding a second COUNT query per request."
```

---

### Task 9: Cache port and Redis implementation

**Files:**
- Create: `apps/api/src/common/cache/cache.service.ts` (abstract), `redis-cache.service.ts`, `memory-cache.service.ts`, `cache.module.ts`, `cache.keys.ts`
- Test: `apps/api/src/common/cache/memory-cache.service.test.ts`, `apps/api/test/cache.integration.test.ts`
- Modify: `apps/api/src/products/products.service.ts` (read through the cache)

**Interfaces:**
- Produces:
  - `abstract class CacheService { get<T>(key: string): Promise<T | null>; set<T>(key: string, value: T, ttlSeconds: number): Promise<void>; del(...keys: string[]): Promise<void>; delByPrefix(prefix: string): Promise<void>; }`
  - `cacheKeys.productDetail(slug)` → `product:detail:{slug}`, `cacheKeys.productSummary(productId)` → `product:summary:{id}`, `cacheKeys.reviewListPrefix(productId)` → `product:{id}:reviews:`, `cacheKeys.reviewListFirstPage(productId, sort, ratingFilter)` → `product:{id}:reviews:{sort}:{rating ?? 'all'}`.
  - TTLs as exported constants: `TTL_PRODUCT_DETAIL = 60`, `TTL_SUMMARY = 60`, `TTL_REVIEW_LIST = 30`.
  - **Plan 2's aggregation consumer deletes exactly these keys**, so the key builders must live in a place both apps can import. Put `cache.keys.ts` in `packages/contracts/src/cache-keys.ts` instead and re-export it from the API, so the worker cannot drift.

- [ ] **Step 1: Write the failing tests**

Unit tests for `MemoryCacheService`: `get` on a missing key returns `null`; `set` then `get` round-trips an object; a value expires after its TTL (use `vi.useFakeTimers()` and advance past it); `del` removes specific keys; `delByPrefix` removes matching keys and leaves others.

Integration tests for the Redis implementation and the caching behaviour:

1. Two consecutive `GET /products/:slug` requests hit Postgres once — assert by counting calls to `PrismaService.product.findUnique` and expecting one.

   Counting those calls needs care. A bare `vi.spyOn` on a Prisma model delegate silently breaks the query: Prisma's delegates are Proxies that misreport property descriptors, so the spy replaces the method rather than wrapping it and the real query never runs. The test then passes whether or not the cache works, which is worse than no test. Capture the original method bound to its delegate first and hand it back to the spy, so it both records calls and executes the genuine query:

   ```ts
   const delegate = prisma.product;
   const original = delegate.findUnique.bind(delegate);
   const spy = vi.spyOn(delegate, 'findUnique').mockImplementation(original);
   ```
2. After `cache.del(cacheKeys.productDetail(slug))`, the next request queries again.
3. A cached payload is byte-identical to the uncached one — fetch, flush, fetch, and `toEqual` the two bodies. This catches serialisation losses such as `Date` becoming a string only on the cache path.

Case 3 is the one that actually finds bugs; write it explicitly.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @reviews/api test:unit -- cache`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`RedisCacheService` uses `ioredis`, `JSON.stringify`/`JSON.parse`, and `SET key value EX ttl`. `delByPrefix` uses `SCAN` with `MATCH prefix*` in batches — never `KEYS`, which blocks the server.

`MemoryCacheService` is a `Map` with per-entry expiry checked on read, used in tests and as the fallback when `REDIS_URL` is absent.

`CacheModule` provides `CacheService` with a factory choosing the implementation from config.

`ProductsService` wraps detail and list reads in cache-aside: read, on miss compute and `set`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @reviews/api test:unit -- cache && pnpm --filter @reviews/api test:integration -- cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): add cache-aside layer behind a swappable port

Product detail and rating summaries are the hottest reads and change
only when moderation publishes a review, which makes them the right
things to cache and the wrong things to recompute per request.

Callers depend on an abstract CacheService, so tests run against an
in-memory implementation with no container and the Redis client stays
out of the domain code.

Key builders live in the shared contracts package because the worker
invalidates the same keys it never writes; keeping them in one module
prevents the producer and the invalidator from drifting apart.

delByPrefix scans in batches rather than using KEYS, which would block
the Redis event loop for the duration of the scan."
```

---

### Task 10: Review submission with transactional outbox

**Files:**
- Create: `apps/api/src/reviews/reviews.module.ts`, `reviews.controller.ts`, `reviews.service.ts`, `reviews.repository.ts`, `reviews.mapper.ts`
- Create: `packages/db/src/outbox.ts`
- Test: `packages/db/src/outbox.test.ts`, `apps/api/test/review-submission.integration.test.ts`

**Interfaces:**
- Consumes: `createReviewInputSchema`, `EVENT_TYPES`, `eventEnvelopeSchema` (Task 3); `PrismaService`.
- Produces:
  - `writeOutboxEvent(tx: Prisma.TransactionClient, event: { eventType: EventType; aggregateId: string; payload: unknown }): Promise<void>`, exported from `@reviews/db` — generates `eventId` as UUIDv7, stamps `occurredAt`, validates the payload against the matching schema before insert, and writes one `outbox` row. **Every state change in this codebase emits its event through this function inside the same transaction.**
  - It lives in `packages/db` rather than in the API because the worker writes outbox rows too (Plan 2, moderation consumer). It is a plain function with no NestJS dependency, so both a Nest provider and a bare worker handler can call it. Unit-test it directly against a transaction client mock: it must reject an unknown `eventType` and must reject a payload that fails its schema, before any insert is attempted.
  - `POST /api/v1/products/:productId/reviews` → `202 Accepted` with the `PENDING` review.

- [ ] **Step 1: Write the failing integration test**

Cases:

1. An authenticated customer submits a valid review → `202`; body has `status: 'PENDING'`, `publishedAt: null`, and the author's `displayName`.
2. The same request writes exactly one `outbox` row with `event_type = 'review.submitted'`, `aggregate_id` equal to the review id, and a payload containing `rating`, `title`, `body`, `productId`, `authorId`, `verifiedPurchase`.
3. A second submission by the same user for the same product → `409`, and the body includes the existing `reviewId`.
4. The `409` path writes **no** additional outbox row — assert the count is still 1. This is the test that catches an event emitted outside the transaction boundary.
5. A user with a matching `purchases` row gets `verifiedPurchase: true`; a user without one gets `false`.
6. An unauthenticated submission → `401`.
7. `rating: 6` → `400`; `body: 'short'` → `400`.
8. Submitting for an unknown product id → `404`.
9. The new review does **not** appear in `GET /products/:productId/reviews` (that endpoint arrives in Task 11; if executing tasks in order, add this assertion in Task 11 instead).

Case 4 written out, since it is the point of the whole task:

```ts
it('writes no outbox event when the submission conflicts', async () => {
  const token = await ctx.loginAs('alice@example.com');
  const product = await createProduct(ctx.prisma);
  const payload = { rating: 5, title: 'Great lamp', body: 'Bright and well made.' };

  await ctx.request.post(`/api/v1/products/${product.id}/reviews`).auth(token, { type: 'bearer' }).send(payload).expect(202);
  await ctx.request.post(`/api/v1/products/${product.id}/reviews`).auth(token, { type: 'bearer' }).send(payload).expect(409);

  expect(await ctx.prisma.outboxEvent.count()).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/api test:integration -- review-submission`
Expected: FAIL — route not found.

- [ ] **Step 3: Implement**

`ReviewsService.submit` runs inside `prisma.$transaction`:

```ts
return this.prisma.$transaction(async (tx) => {
  const verifiedPurchase = (await tx.purchase.count({ where: { userId, productId } })) > 0;
  const review = await tx.review.create({
    data: { productId, authorId: userId, rating, title, body, verifiedPurchase, status: 'PENDING' },
  });
  await writeOutboxEvent(tx, {
    eventType: EVENT_TYPES.REVIEW_SUBMITTED,
    aggregateId: review.id,
    payload: { reviewId: review.id, productId, authorId: userId, rating, title, body, verifiedPurchase },
  });
  return review;
});
```

The unique-violation path is handled by catching `P2002` and re-reading the existing review to include its id in the `409` body. Because the throw happens inside the transaction, the outbox insert rolls back with it — which is exactly what case 4 asserts.

The controller returns `HttpStatus.ACCEPTED` explicitly via `@HttpCode(202)`: the review is stored but not yet published, and `201 Created` would misrepresent that.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/api test:integration -- review-submission`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): accept review submissions and record events in the outbox

The review row and its domain event are written in one transaction, so
there is no window in which a review exists without its event or an
event refers to a review that was rolled back. Publishing to the broker
is a separate concern handled by the relay.

Submission answers 202 rather than 201: the review is stored but is not
yet published, and saying 'created' would promise a visibility the
system has not delivered.

A duplicate submission is rejected by the database's unique constraint
and answered with 409 plus the existing review id, and the rollback
takes the outbox row with it. A test asserts the event count stays at
one, since emitting the event outside the transaction is the easy
mistake here."
```

---

### Task 11: Review listing with sorting, filtering, and pagination

**Files:**
- Modify: `apps/api/src/reviews/reviews.controller.ts`, `reviews.service.ts`, `reviews.repository.ts`
- Test: `apps/api/test/review-listing.integration.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/products/:productId/reviews?sort=&rating=&cursor=&limit=` → `{ items: ReviewDto[], nextCursor: string | null }`, `APPROVED` only.

- [ ] **Step 1: Write the failing integration test**

Cases:

1. Only `APPROVED` reviews are returned — seed one of each status and assert the list length is 1.
2. `sort=newest` orders by `createdAt DESC`, tie-broken by `id DESC`.
3. `sort=helpful` orders by `helpfulCount DESC`, tie-broken by `createdAt DESC` then `id DESC`.
4. `sort=rating_desc` and `sort=rating_asc` order by rating with the same tie-breakers.
5. `rating=4` returns only 4-star reviews.
6. Paging with `limit=2` across five reviews yields three pages, no duplicates, and no omissions — collect all ids across pages and compare the sorted set to the seeded set. Do this for `sort=helpful` specifically, because a non-unique sort key is where keyset pagination breaks.
7. A cursor from `sort=newest` used with `sort=helpful` must not crash; it returns `400`.
8. `limit=0` and `limit=101` return `400`.
9. The response never includes `moderationReason` for another user's review.

Case 6 is the important one:

```ts
it('pages through helpful-sorted reviews without duplicates or gaps', async () => {
  const product = await createProduct(ctx.prisma);
  const seeded = await seedApprovedReviews(ctx.prisma, product.id, [
    { helpfulCount: 3 }, { helpfulCount: 3 }, { helpfulCount: 3 }, { helpfulCount: 1 }, { helpfulCount: 0 },
  ]);

  const collected: string[] = [];
  let cursor: string | null = null;
  do {
    const url = `/api/v1/products/${product.id}/reviews?sort=helpful&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
    const res: { body: { items: Array<{ id: string }>; nextCursor: string | null } } = await ctx.request.get(url).expect(200);
    collected.push(...res.body.items.map((r) => r.id));
    cursor = res.body.nextCursor;
  } while (cursor);

  expect(collected.sort()).toEqual(seeded.map((r) => r.id).sort());
});
```

Three reviews sharing `helpfulCount: 3` is deliberate — that is the condition under which a cursor built only from the sort key loses or repeats rows.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/api test:integration -- review-listing`
Expected: FAIL.

- [ ] **Step 3: Implement**

A `SORTS` lookup maps each sort value to its Prisma `orderBy` array and to the field used as the cursor key, so adding a sort is one entry rather than a new branch in three places:

```ts
const SORTS = {
  helpful:     { column: 'helpfulCount', direction: 'desc' },
  newest:      { column: 'createdAt',    direction: 'desc' },
  rating_desc: { column: 'rating',       direction: 'desc' },
  rating_asc:  { column: 'rating',       direction: 'asc' },
} as const;
```

Every sort appends `{ id: 'desc' }` as the final tie-breaker, and the cursor carries both the key and the id, so the `WHERE` clause is the standard keyset comparison `(key, id) < (cursorKey, cursorId)` expressed as an `OR` pair. The cursor also records which sort produced it; a mismatch throws `BadRequestException` (case 7).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/api test:integration -- review-listing`
Expected: PASS, all nine cases.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): list approved reviews with sorting, filtering, and keyset paging

Every sort order appends the row id as a final tie-breaker and the
cursor carries both values, because the natural sort keys here are not
unique: several reviews commonly share a helpful count, and a cursor
built from that column alone silently skips or repeats them. A test
pages through deliberately tied rows to hold this behaviour in place.

The cursor records the sort it was produced under, so switching sort
mid-pagination fails loudly instead of returning an arbitrary slice."
```

---

### Task 12: Helpfulness votes

**Files:**
- Create: `apps/api/src/reviews/votes.controller.ts`, `votes.service.ts`
- Test: `apps/api/test/votes.integration.test.ts`

**Interfaces:**
- Produces: `PUT /api/v1/reviews/:reviewId/vote` with `{ value: 'HELPFUL' | 'NOT_HELPFUL' }` → `200` with the updated counts; `DELETE /api/v1/reviews/:reviewId/vote` → `204`.

- [ ] **Step 1: Write the failing integration test**

Cases:

1. A first `HELPFUL` vote sets `helpfulCount: 1`, `notHelpfulCount: 0`.
2. Repeating the identical vote leaves the counts at 1 — voting is idempotent, not cumulative.
3. Changing to `NOT_HELPFUL` yields `helpfulCount: 0`, `notHelpfulCount: 1`.
4. `DELETE` removes the vote and returns the counts to zero.
5. `DELETE` with no existing vote returns `204` and does not error.
6. The review's author voting on their own review → `403`.
7. Voting on a non-`APPROVED` review → `404` (a pending review is not publicly addressable).
8. Ten concurrent votes from ten distinct users produce `helpfulCount: 10` — issue them with `Promise.all` and assert the final count. This is the test that catches a lost update from a read-modify-write counter.
9. Unauthenticated → `401`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/api test:integration -- votes`
Expected: FAIL.

- [ ] **Step 3: Implement**

One transaction per vote, and **the statement order is the whole correctness argument**. Take an exclusive lock on the review row as its own statement first, then write the vote, then recompute both counters from `review_votes`:

```sql
-- 1. Lock the review row. Its own statement, before any write.
SELECT author_id, status FROM reviews WHERE id = $1::uuid FOR UPDATE;

-- 2. Upsert the review_votes row (Prisma upsert on the (review_id, user_id) key).

-- 3. Recompute both counters. Never an increment.
UPDATE reviews r SET
  helpful_count     = v.helpful,
  not_helpful_count = v.not_helpful
FROM (
  SELECT
    count(*) FILTER (WHERE value = 'HELPFUL')     AS helpful,
    count(*) FILTER (WHERE value = 'NOT_HELPFUL') AS not_helpful
  FROM review_votes WHERE review_id = $1::uuid
) v
WHERE r.id = $1::uuid;
```

**Why the leading lock is not redundant.** Doing steps 2 and 3 without step 1 fails under READ COMMITTED, and it fails silently. A statement takes its snapshot at statement start. When ten voters run step 3 concurrently, each blocks on the review row; on unblocking, Postgres re-evaluates the row it collided with but does **not** retake the snapshot, so the aggregate over `review_votes` still reads the pre-wait view. Every voter computes `1` and writes `1`. Serialising the *write* does not make the *read* in the same statement fresh — that is the trap.

With the lock taken first as a separate statement, the recompute never blocks, so it takes a fresh snapshot that includes every vote committed before the lock was acquired.

**Do not merge the lock into the `UPDATE`.** `UPDATE ... FOR UPDATE` is not a thing, and moving the lock later reintroduces the undercount exactly.

`FOR UPDATE` is stronger than strictly needed — `FOR NO KEY UPDATE` self-conflicts, which is all that mutual exclusion among voters requires, and it would not block inserts into other tables holding a foreign key to `reviews`. `review_votes` is currently the only such table, so this costs nothing today; revisit if a second one appears.

An `increment` is wrong for the original reason too: it reads a value a concurrent transaction has already changed, and loses updates under precisely the load that makes the count matter.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/api test:integration -- votes`
Expected: PASS, including the ten-concurrent-voters case.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): add helpfulness voting with recomputed counters

A vote upserts one row keyed by review and user, so a repeated vote is
idempotent and a changed vote moves rather than stacks.

The denormalised counters on the review are recomputed from the vote
table inside the same transaction rather than incremented. An increment
reads a value that a concurrent transaction may already have changed,
which loses updates exactly when a review is popular enough for the
count to matter. A test votes from ten users concurrently and asserts
the count lands on ten."
```

---

### Task 13: Author review management

**Files:**
- Modify: `apps/api/src/reviews/reviews.controller.ts`, `reviews.service.ts`
- Test: `apps/api/test/review-management.integration.test.ts`

**Interfaces:**
- Produces: `PATCH /api/v1/reviews/:id`, `DELETE /api/v1/reviews/:id`, `GET /api/v1/me/reviews`.

- [ ] **Step 1: Write the failing integration test**

Cases:

1. The author patches the body of a `PENDING` review → `200`, content updated, status still `PENDING`, one new `review.submitted` outbox row.
2. The author patches an `APPROVED` review → status returns to `PENDING`, `publishedAt` is cleared, and **two** outbox rows appear: `review.unpublished` then `review.submitted`, in that order by `id`.
3. A different customer patching someone else's review → `403`.
4. A moderator patching someone else's review → `403` (moderators decide, they do not rewrite).
5. The author deletes their review → `204`, the row is gone, its votes are gone, and one `review.unpublished` row exists.
6. A moderator deletes another user's review → `204`.
7. After deletion the same author may submit a new review for that product → `202`.
8. `GET /me/reviews` returns the caller's reviews in every status, including `PENDING` and `REJECTED`, with `moderationReason` populated for rejected ones.
9. `GET /me/reviews` never returns another user's review.

Case 2 written out, because the event ordering is the subtle part:

```ts
it('unpublishes and resubmits when an approved review is edited', async () => {
  const token = await ctx.loginAs('alice@example.com');
  const { review } = await seedApprovedReviewBy(ctx, 'alice@example.com');

  await ctx.request.patch(`/api/v1/reviews/${review.id}`).auth(token, { type: 'bearer' })
    .send({ body: 'Rewritten after three more months of use.' }).expect(200);

  const events = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: review.id }, orderBy: { id: 'asc' } });
  expect(events.map((e) => e.eventType)).toEqual(['review.unpublished', 'review.submitted']);

  const updated = await ctx.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
  expect(updated.status).toBe('PENDING');
  expect(updated.publishedAt).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/api test:integration -- review-management`
Expected: FAIL.

- [ ] **Step 3: Implement**

`update` runs in one transaction: load the review with `FOR UPDATE` semantics via `prisma.$queryRaw` or an update-guarded write, reject unless `authorId === userId`, and if the current status is `APPROVED`, emit `review.unpublished` before applying the patch and emitting `review.submitted`. Order matters: the aggregation consumer must see the removal before the resubmission, or a rejected edit could leave the old rating counted.

`remove` allows the author or a `MODERATOR`, deletes the row (votes cascade), and emits `review.unpublished` in the same transaction. Because the delete cascades and the projection recomputes from source, the event carries only `reviewId` and `productId`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/api test:integration -- review-management`
Expected: PASS, all nine cases.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): let authors edit and delete their reviews

Editing an approved review returns it to moderation and emits an
unpublish before the resubmission, in that order, so the rating never
counts text that is no longer on display. The ordering is asserted by a
test rather than left to the reader.

Deletion is a hard delete: votes cascade and the freed unique slot lets
the author write a fresh review. Retaining a moderation audit trail
would argue for a soft delete instead; that is a column and a filter
away and is noted as such in the design document.

Moderators may delete a review but may not edit one. Rewriting a
customer's words is not a moderation decision."
```

---

### Task 14: Moderation API

**Files:**
- Create: `apps/api/src/moderation/moderation.module.ts`, `moderation.controller.ts`, `moderation.service.ts`
- Test: `apps/api/test/moderation.integration.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/moderation/reviews?status=&cursor=&limit=` and `POST /api/v1/moderation/reviews/:id` with `{ decision: 'APPROVED' | 'REJECTED', reason: string | null }`, both `MODERATOR`-only.

- [ ] **Step 1: Write the failing integration test**

Cases:

1. A `CUSTOMER` token → `403` on both endpoints. *(This is case 7 deferred from Task 7.)*
2. No token → `401`.
3. A `MODERATOR` sees `FLAGGED` reviews by default, newest first.
4. `status=PENDING` filters accordingly.
5. Approving a `FLAGGED` review sets `status: 'APPROVED'`, sets `publishedAt`, and writes one `review.approved` outbox row.
6. Rejecting requires a reason: `{ decision: 'REJECTED', reason: null }` → `400`.
7. Rejecting with a reason sets `status: 'REJECTED'`, stores `moderationReason`, and writes one `review.rejected` row.
8. Approving an already-`APPROVED` review → `409`, and writes no outbox row. The manual path must be guarded exactly like the automatic one.
9. The queue listing includes the full review body and the author's display name, so a moderator can actually judge it.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/api test:integration -- moderation`
Expected: FAIL.

- [ ] **Step 3: Implement**

The decision is a conditional update inside a transaction:

```ts
const updated = await tx.review.updateMany({
  where: { id, status: { in: ['PENDING', 'FLAGGED'] } },
  data: { status: decision, moderationReason: reason, publishedAt: decision === 'APPROVED' ? new Date() : null },
});
if (updated.count === 0) throw new ConflictException('review is not awaiting moderation');
await writeOutboxEvent(tx, { eventType: decision === 'APPROVED' ? EVENT_TYPES.REVIEW_APPROVED : EVENT_TYPES.REVIEW_REJECTED, aggregateId: id, payload: { reviewId: id, productId, decision, reason, moderatorId } });
```

`updateMany` with a status predicate rather than `update` by id is deliberate: the guard and the write are one statement, so two moderators clicking simultaneously produce one decision and one event, not two.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/api test:integration -- moderation`
Expected: PASS, all nine cases.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): add the moderation queue and decision endpoint

A decision is a single conditional update predicated on the review
still awaiting moderation, so two moderators acting at the same moment
produce one decision and one event rather than two of each.

Rejection requires a reason. The reason is shown back to the author in
their own review list, which is the only thing that makes a rejection
actionable rather than mysterious.

Both endpoints are role-guarded and the queue returns the full review
text, since a moderator cannot judge an excerpt."
```

---

### Task 15: Rate limiting on submission

**Files:**
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/reviews/reviews.controller.ts`
- Create: `apps/api/src/common/throttle/throttle.module.ts`
- Test: `apps/api/test/throttle.integration.test.ts`

**Interfaces:**
- Produces: submission limited to `REVIEW_SUBMIT_RATE_LIMIT` (default 5) per user per hour, returning `429` with a `Retry-After` header.

- [ ] **Step 1: Write the failing integration test**

Boot this suite with `setupTestApp({ REVIEW_SUBMIT_RATE_LIMIT: '2' })`. Cases: two submissions to two different products succeed; the third returns `429` with a numeric `Retry-After`; a different user is unaffected; `GET` endpoints are never throttled.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/api test:integration -- throttle`
Expected: FAIL — the third request returns `202`.

- [ ] **Step 3: Implement**

Use `@nestjs/throttler` with the Redis storage adapter so the limit holds across instances rather than per process. Key by user id when authenticated, falling back to IP. Apply with `@Throttle` on the submit handler only.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/api test:integration -- throttle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): rate-limit review submission per user

Review spam is cheap to generate and expensive to moderate, so the
submit endpoint is capped while read endpoints are untouched.

The counter lives in Redis rather than in process memory: an in-memory
limiter multiplies the effective limit by the number of instances,
which makes it a comment rather than a control."
```

---

### Task 16: OpenAPI documentation

**Files:**
- Modify: `apps/api/src/bootstrap.ts`, every controller (add `@ApiTags`, `@ApiOperation`, response decorators)
- Test: `apps/api/test/openapi.integration.test.ts`

**Interfaces:**
- Produces: Swagger UI at `/docs`, the JSON document at `/docs-json`.

- [ ] **Step 1: Write the failing integration test**

Cases: `GET /docs-json` returns `200`; the document lists every path implemented in Tasks 7–15 (assert on an explicit array of path strings, so a forgotten decorator fails the build); each documented operation has at least one non-`200` response documented; the `POST` submit operation documents `202`, `400`, `401`, `409`, and `429`.

```ts
it('documents every implemented route', async () => {
  const res = await ctx.request.get('/docs-json').expect(200);
  const paths = Object.keys(res.body.paths).sort();
  expect(paths).toEqual([
    '/api/v1/auth/login', '/api/v1/auth/me',
    '/api/v1/health', '/api/v1/health/ready',
    '/api/v1/me/reviews',
    '/api/v1/moderation/reviews', '/api/v1/moderation/reviews/{id}',
    '/api/v1/products', '/api/v1/products/{productId}/reviews', '/api/v1/products/{slug}',
    '/api/v1/reviews/{id}', '/api/v1/reviews/{reviewId}/vote',
  ]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/api test:integration -- openapi`
Expected: FAIL — `/docs-json` returns `404`.

- [ ] **Step 3: Implement**

Configure `SwaggerModule` in `bootstrap.ts` with a title, a description pointing at the design document, bearer auth, and `SwaggerModule.setup('docs', app, document)`. Annotate controllers. Since DTOs are Zod schemas rather than classes, use `nestjs-zod` to derive the OpenAPI schemas from the shared contracts, so the documentation cannot drift from the validation.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/api test:integration -- openapi`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(api): publish an OpenAPI document generated from the validators

The response and request schemas are derived from the same Zod
definitions the runtime validates against, so the published contract
cannot drift from the enforced one.

A test asserts the exact set of documented paths. Documentation that is
not checked stops matching the service within a release or two, and the
assertion turns that from a discovery into a build failure."
```

---

## Plan 1 self-review

**Spec coverage.** §3 data model → Task 4. §6 API surface: auth → Task 7; products → Task 8; review listing → Task 11; submission → Task 10; edit/delete/me → Task 13; votes → Task 12; moderation → Task 14; health → Task 5; rate limiting → Task 15; OpenAPI → Task 16; cursor pagination → Task 6. §7 caching → Task 9. §2.1 outbox write side → Task 10, with the relay and consumers deferred to Plan 2 as intended. §2.2 idempotency: conditional updates appear in Tasks 13 and 14; recompute-based counters in Task 12; the rating projection recompute belongs to Plan 2. §5 moderation policy → Plan 2. §8 frontend and §9 E2E → Plan 3.

**Deliberate deferrals, recorded so they are not mistaken for gaps:** the outbox relay, the moderation classifier, the rating projection, and cache invalidation on publish are all Plan 2. Until Plan 2 lands, a submitted review stays `PENDING` unless a moderator acts through the Task 14 endpoint, and `product_rating_summary` changes only via the seed. This is a working, testable system — it is simply one where publication is manual.

**Type consistency check.** `CacheService` key builders are defined once in `packages/contracts/src/cache-keys.ts` (Task 9) and imported by both apps, so Plan 2's consumer deletes the keys Task 9 writes. `writeOutboxEvent(tx, event)` from `@reviews/db` has the same signature in Tasks 10, 13, and 14, and Plan 2's moderation consumer imports the same function. `EVENT_TYPES` values in Tasks 10, 13, and 14 match the `eventTypeSchema` enum from Task 3. The Task 5 harness gains `loginAs` in Task 7 and is used unchanged thereafter, with `setupTestApp()` as the default entry point and `createTestApp()` reserved for suites needing manual control; fixtures from Task 8 are reused by Tasks 10–15.
