# 0004: Identity columns over BIGSERIAL for the outbox journal

## Context

The transactional outbox (`outbox.id`) is an append-only journal: rows are
inserted by application code and never given an explicit `id`, and the
column must guarantee a monotonically increasing sequence tied one-to-one to
the table. The SQL standard form for this is an identity column
(`GENERATED ALWAYS AS IDENTITY`), not Postgres's legacy `SERIAL`/`BIGSERIAL`
pseudo-type:

- `GENERATED ALWAYS` rejects an explicit `INSERT ... (id, ...) VALUES (1, ...)`
  outright, which is exactly the invariant we want for an append-only
  journal (nothing should ever choose its own outbox id).
- The backing sequence is owned by the column itself, not a separate object
  that a DBA could accidentally drop or reassign, as happens with
  `BIGSERIAL`'s implicit sequence.

Prisma's schema language has no `identity` modifier: `BigInt @id
@default(autoincrement())` always generates `BIGSERIAL` in the migration
SQL. The open question for this task was whether hand-editing the generated
migration to use `GENERATED ALWAYS AS IDENTITY` would survive Prisma Migrate
tooling being run again, or whether `prisma migrate dev` would detect
"drift" against the `autoincrement()` schema field and try to revert the
column back to `BIGSERIAL`.

This had to be verified empirically rather than assumed, so the migration
was generated, hand-edited, and then run through `prisma migrate dev`
(Prisma 6.19.3) against a real Postgres 17 instance to observe the actual
behaviour, twice: once to apply the pending migration, once more as a pure
no-op check.

## Decision

**Prisma introspects an identity column back as `autoincrement()`, exactly
as hoped.** Verified output:

```
$ pnpm exec prisma migrate dev --name drift-check
Already in sync, no schema change or pending migration was found.
```

No new migration was generated on the second run, and `information_schema`
confirms the column is a real identity column, not a serial:

```
 column_name | is_identity | column_default
-------------+-------------+----------------
 id          | YES         | (null)
```

So the primary risk in this task resolved favorably with **no workaround
needed** for the identity column itself: keep `BigInt @id
@default(autoincrement())` in `schema.prisma`, and hand-edit only the
generated migration SQL to use `GENERATED ALWAYS AS IDENTITY` instead of
`BIGSERIAL`. A comment at the top of the migration file documents that this
edit is deliberate and must survive if the migration is ever regenerated.

**A related, second finding surfaced during the same verification, on a
different object: the partial index.** The `outbox_unpublished_idx` index
(`CREATE INDEX ... ON outbox (id) WHERE published_at IS NULL`) is also
hand-written, because Prisma's schema language cannot express a partial
index predicate. The first attempt kept Prisma's own `@@index([id], map:
"outbox_unpublished_idx")` declaration in `schema.prisma` (matching a plain,
non-partial index) alongside the hand-written partial version in the
migration SQL. Running `prisma migrate dev` against that combination
produced a *real* drift-correction attempt:

```
Applying migration `20260913214333_init`
Error: P3018
Database error: ERROR: relation "outbox_unpublished_idx" already exists
```

The generated corrective migration was a bare `CREATE INDEX
"outbox_unpublished_idx" ON "outbox"("id");` with no preceding `DROP`.
Prisma's introspection cannot represent a partial index, so when it rebuilds
its internal model of "what already exists" from the migration history, the
partial index is invisible to it -- it concludes no index by that name
exists yet and tries to (re-)create a plain one, colliding with the real,
physical object of the same name.

The fix was to remove the `@@index` declaration for `outbox.id` from
`schema.prisma` entirely, since it inaccurately describes the real index
either way. With no index declared for that column, Prisma has nothing to
diff against, the partial index in the migration is left alone, and
`migrate dev` reports "Already in sync" cleanly, including the CHECK
constraint and the identity column. `schema.prisma` carries a comment
recording why no `@@index` appears there.

## Consequences

- `packages/db/prisma/schema.prisma`'s `OutboxEvent` model has no `@@index`
  for `id`. The partial index is created and owned entirely by hand-written
  SQL in the initial migration (`packages/db/prisma/migrations/*_init/migration.sql`),
  with a comment at the top of that file explaining both hand-edits (the
  identity column and the unmodeled index/check constraint) and pointing
  back to this ADR.
- `prisma migrate dev --name drift-check` reports "Already in sync, no
  schema change or pending migration was found" and creates no new
  migration, verified against a live Postgres 17 instance.
- `packages/db/test/schema.integration.test.ts` pins this down with an
  `information_schema.columns` assertion (`is_identity = 'YES'`,
  `column_default IS NULL`) plus a rejected explicit-id insert, so a future
  regression (e.g. someone "helpfully" re-adding `@@index` for `outbox.id`,
  or running an unreviewed `migrate dev` that reverts the identity column)
  would surface as a broken migration apply or a failing test, not a silent
  schema change.
- Any *future* raw-SQL customization of a Prisma-modeled object (an index,
  in particular) needs to either stay fully undeclared in `schema.prisma`
  (as done here) or accept that `migrate dev` may try to "fix" it back to
  what the schema literally describes. This is a general property of
  Prisma Migrate, not specific to this table.

## Alternatives considered

- **Accept `BIGSERIAL`.** Rejected per the task's constraints: `BIGSERIAL`'s
  sequence is a separate, independently droppable object, and it does not
  reject explicit `id` inserts the way `GENERATED ALWAYS AS IDENTITY` does,
  which is the actual invariant we need for an append-only journal.
- **Keep the plain `@@index` in `schema.prisma` and re-apply the DROP/CREATE
  partial-index edit after every future `migrate dev`.** Rejected: this
  is an "escalating hack" that has to be remembered and redone by every
  future contributor touching this migration, exactly the failure mode the
  task asked to avoid.
- **Drop the partial index and use a plain index instead**, sacrificing the
  `WHERE published_at IS NULL` optimization the outbox worker's polling
  query depends on. Rejected: it would make `schema.prisma` and
  `migrate dev` fully agree, but at the cost of the actual index the worker
  needs -- the outbox table is expected to accumulate published rows
  indefinitely, and an unfiltered index over all of them defeats the
  point of the partial index.
