#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
COMPOSE_FILE="$REPO_ROOT/control-plane/db/compose.test.yml"

( cd "$REPO_ROOT/control-plane/api" && npm run build && npm test )
PYTHONPATH="$REPO_ROOT/control-plane/worker" \
  python3 -m unittest discover -s "$REPO_ROOT/control-plane/worker/tests" -v

# The canonical-record guardrails are enforced by PostgreSQL CHECK constraints
# and triggers, so a run without a database proves nothing about them while
# still exiting 0. Stand a database up rather than reporting a skip.
if [ -n "${CONTROL_PLANE_TEST_DATABASE_URL:-}" ]; then
  exit 0
fi

if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' \
    "[error] the PostgreSQL guardrail tests did not run." \
    "        Set CONTROL_PLANE_TEST_DATABASE_URL, or install Docker so that" \
    "        ${COMPOSE_FILE} can provide one." >&2
  exit 1
fi

cleanup() { docker compose -f "$COMPOSE_FILE" --profile test down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker compose -f "$COMPOSE_FILE" --profile test run --rm --build migration-tests
