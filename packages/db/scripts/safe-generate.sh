#!/usr/bin/env bash
# `prisma generate` writes the query-engine binary to a location shared by
# every workspace package that resolves @prisma/client (the same physical
# path inside the pnpm store, regardless of which package's `prisma
# generate` triggered it). Two `prisma generate` processes running at the
# same time — e.g. turbo scheduling this package's own `build` and
# `test:integration` in parallel (both call this script), or apps/api's
# integration harness shelling out to `db:migrate` (which also calls this
# script) while either of those is still running — can each partially
# overwrite that binary and corrupt it (see docs/plans task-5 review: a
# corrupted libquery_engine-*.dylib.node failed to dlopen).
#
# Every script in this package that used to call `prisma generate` directly
# now calls this one instead, so there is exactly one place that actually
# generates the client, and a simple mkdir-based lock (atomic on POSIX,
# which is all this project targets) makes concurrent callers queue instead
# of racing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_DIR="$SCRIPT_DIR/../.prisma-generate.lock"

release() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap release EXIT

attempts=0
until mkdir "$LOCK_DIR" 2>/dev/null; do
  attempts=$((attempts + 1))
  if [ "$attempts" -gt 600 ]; then
    echo "safe-generate: timed out waiting for lock at $LOCK_DIR" >&2
    exit 1
  fi
  sleep 0.1
done

pnpm exec prisma generate
