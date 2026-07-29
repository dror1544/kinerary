#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_DIR="$(dirname "$TESTS_DIR")"

cd "$TESTS_DIR"

# Install deps if needed
if [ ! -d node_modules/happy-dom ]; then
  echo "Installing test dependencies..."
  npm install --silent
fi

if [ ! -d "$FRAMEWORK_DIR/server/node_modules/express" ]; then
  echo "Installing server dependencies..."
  npm install --prefix "$FRAMEWORK_DIR/server" --silent
fi

# Parse optional suite filter: ./run-tests.sh config|server|render
SUITE="${1:-all}"

case "$SUITE" in
  config) FILES="config.test.js" ;;
  render) FILES="render.test.js" ;;
  server) FILES="server.test.js" ;;
  versions) FILES="config-versions.test.js" ;;
  all)    FILES="config.test.js render.test.js server.test.js config-versions.test.js" ;;
  *)
    echo "Usage: $0 [config|render|server|versions|all]"
    exit 1
    ;;
esac

echo ""
echo "Running: $SUITE tests"
echo "────────────────────────────────────────"
node --test --test-reporter=spec $FILES
