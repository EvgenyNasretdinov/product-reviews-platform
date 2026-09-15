#!/usr/bin/env bash
# Checks the assembled system, not its parts. Every container in the
# Compose stack can report healthy while the application is still useless
# (e.g. migrations/seed never ran) — this is the check that would catch
# that: it looks for a non-empty catalogue, not just an open port.
set -euo pipefail
API_ROOT=${API_ROOT:-http://localhost:3001}
API=${API_URL:-$API_ROOT/api/v1}
WEB=${WEB_URL:-http://localhost:3000}

curl -fsS "$API/health/ready" | grep -q '"database":"up"'    || { echo "FAIL: api not ready"; exit 1; }
test "$(curl -fsS "$API/products" | jq '.items | length')" -gt 0 || { echo "FAIL: catalogue is empty, seed did not run"; exit 1; }
curl -fsS "$WEB" | grep -qi '<title'                          || { echo "FAIL: web did not render"; exit 1; }
# /docs-json is deliberately published outside the api/v1 prefix (see
# apps/api/src/bootstrap.ts's configureOpenApi) so the OpenAPI document
# stays at a fixed, version-independent URL.
curl -fsS "$API_ROOT/docs-json" | jq -e '.paths' >/dev/null   || { echo "FAIL: openapi document missing"; exit 1; }
echo "OK: api, worker seed, web, and docs all responding"
