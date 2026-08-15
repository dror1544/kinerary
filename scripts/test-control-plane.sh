#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

( cd "$REPO_ROOT/control-plane/api" && npm run build && npm test )
PYTHONPATH="$REPO_ROOT/control-plane/worker" \
  python3 -m unittest discover -s "$REPO_ROOT/control-plane/worker/tests" -v

if [ -z "${CONTROL_PLANE_TEST_DATABASE_URL:-}" ]; then
  printf '%s\n' "[info] PostgreSQL migration tests skipped: CONTROL_PLANE_TEST_DATABASE_URL is unset"
fi
