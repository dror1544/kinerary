#!/usr/bin/env bash
# Rebuild and restart the MCP container after a deploy.
# Run from wherever this MCP server is deployed:
#   bash reset-mcp.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Validate required keys are present in .env before touching the container
for key in MCP_API_KEY TRIP_API_KEY; do
  if ! grep -q "^${key}=" .env 2>/dev/null; then
    echo "❌ ${key} is missing from .env — run setup-macos.sh first"
    exit 1
  fi
done

echo "[reset] Rebuilding image..."
docker compose build

echo "[reset] Restarting container..."
docker compose up -d

sleep 2
if docker ps --filter "name=trip-mcp" --filter "status=running" | grep -q trip-mcp; then
  echo "✅ trip-mcp is running"
  echo "--- last log lines ---"
  docker logs --tail=5 trip-mcp
else
  echo "❌ Container failed — check: docker logs trip-mcp"
  exit 1
fi
