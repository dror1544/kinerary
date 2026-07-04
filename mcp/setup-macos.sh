#!/usr/bin/env bash
# First-time local setup for the trip-mcp server (macOS/Docker).
# Run once from this directory:
#   MCP_API_KEY=<agent-to-mcp-key> TRIP_API_KEY=<mcp-to-server-key> API_BASE_URL=http://your-site-host:8080 bash setup-macos.sh
#
# MCP_API_KEY  — key your agent (local or Cowork connector) uses to connect to this MCP server (/sse)
# TRIP_API_KEY — key this MCP server sends to the trip website API (must match an API key the site accepts)
# API_BASE_URL — where the trip site's Express server actually runs; defaults to localhost:8080
set -euo pipefail

MCP_API_KEY="${MCP_API_KEY:?Set MCP_API_KEY before running this script}"
TRIP_API_KEY="${TRIP_API_KEY:?Set TRIP_API_KEY before running this script}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

echo "[setup] Writing .env..."
cat > .env << EOF
MCP_API_KEY=${MCP_API_KEY}
TRIP_API_KEY=${TRIP_API_KEY}
API_BASE_URL=${API_BASE_URL:-http://localhost:8080}
EOF

echo "[setup] Building and starting Docker container..."
docker compose up -d --build

sleep 2
if docker ps --filter "name=trip-mcp" --filter "status=running" | grep -q trip-mcp; then
  echo "✅ trip-mcp is running on 127.0.0.1:3001"
  echo "   Local agent URL: http://127.0.0.1:3001/sse"
  echo "   For Claude Cowork / a remote connector: expose this port through your reverse proxy/tunnel first."
  echo "   Logs: docker logs trip-mcp"
else
  echo "❌ Container failed to start — check: docker logs trip-mcp"
  exit 1
fi
