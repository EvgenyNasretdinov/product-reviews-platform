#!/usr/bin/env bash
# `prisma generate` writes the query-engine binary to a location shared by
# every workspace package that resolves @prisma/client (the same physical
# path inside the pnpm store, regardless of which package's `prisma
# generate` triggered it). Two `prisma generate` processes running at the
# same time can each partially overwrite that binary and corrupt it (see
# docs/plans task-5 review: a corrupted libquery_engine-*.dylib.node failed
# to dlopen).
#
# Since the event-pipeline branch's review, turbo.json declares `generate`
# as its own first-class task that `build`/`test:unit`/`test:integration`
# depend on, so turbo itself now guarantees only one `generate` ever runs
# at a time *for those*, without help from this script. What this lock
# still guards: `predb:migrate`/`predb:seed` (this package's own
# `package.json`) call `pnpm run generate` every time `db:migrate`/
# `db:seed` runs, and every worker/api integration suite's
# `global-setup.ts` shells out to `db:migrate` from its own process —
# two such suites starting at once (the ordinary case under turbo) can
# still race two `generate` invocations against each other outside the
# task graph turbo sees.
#
# Every script in this package that calls `prisma generate` calls this one
# instead, so there is exactly one place that actually generates the
# client, and a simple mkdir-based lock (atomic on POSIX, which is all this
# project targets) makes concurrent callers queue instead of racing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_DIR="$SCRIPT_DIR/../.prisma-generate.lock"

release() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

attempts=0
until mkdir "$LOCK_DIR" 2>/dev/null; do
  attempts=$((attempts + 1))
  if [ "$attempts" -gt 600 ]; then
    echo "safe-generate: timed out waiting for lock at $LOCK_DIR" >&2
    exit 1
  fi
  sleep 0.1
done
# Only installed once this process actually holds the lock: installing it
# before the acquire loop meant the timeout path (`exit 1` above) also ran
# `release`, `rmdir`-ing a lock directory this process never created and
# some *other* still-running process still held.
trap release EXIT

pnpm exec prisma generate
