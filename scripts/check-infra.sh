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
