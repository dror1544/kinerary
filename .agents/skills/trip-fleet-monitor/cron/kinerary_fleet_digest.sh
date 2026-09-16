#!/usr/bin/env bash
# Daily fleet digest, delivered verbatim by `hermes cron --no-agent`.
# No model runs, so the morning report costs nothing and still arrives on a day
# when no model provider is reachable.
#
# DEPLOY: copy into the Hermes PROFILE's scripts directory —
#   cp cron/kinerary_fleet_digest.sh ~/.hermes/profiles/<profile>/scripts/
#
# Nothing below names a host, a container or a stack: the target comes from
# fleet-stacks.json (default_stack). Override with KINERARY_FLEET_STACK.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET="${KINERARY_FLEET_MCP:-$HERE/../skills/travel/trip-fleet-monitor/fleet-mcp.mjs}"

NODE="${KINERARY_NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE" ]; then
  for candidate in "$HOME/.local/bin/node" /usr/local/bin/node /opt/homebrew/bin/node; do
    [ -x "$candidate" ] && NODE="$candidate" && break
  done
fi
[ -n "$NODE" ] || { echo "no node binary found; set KINERARY_NODE_BIN" >&2; exit 1; }

# No arrays here on purpose. macOS ships bash 3.2, where expanding an EMPTY
# array under `set -u` is an unbound-variable error rather than an empty list —
# which killed this script right after the header and would have delivered a
# digest consisting of its own title. A function takes the argument list
# instead, and works the same on bash 3.2 and 5.
fleet_tool() {
  if [ -n "${KINERARY_FLEET_STACK:-}" ]; then
    "$NODE" "$FLEET" "$@" --stack "$KINERARY_FLEET_STACK"
  else
    "$NODE" "$FLEET" "$@"
  fi
}

echo "📋 Kinerary daily digest — $(date '+%a %d %b, %H:%M')"
echo

fleet_tool --tool fleet_overview
echo

fleet_tool --tool statistics --days 7
echo

# The same alerts the watchdog uses, so the digest and the alerts can never
# disagree about what is wrong.
problems="$(fleet_tool --tool alerts || true)"
if [ -n "$problems" ]; then
  echo "$problems"
else
  echo "✅ Nothing needs attention."
fi
