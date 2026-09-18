#!/usr/bin/env bash
# Fleet watchdog. Prints NOTHING when the fleet is healthy.
#
# DEPLOY: copy into the Hermes PROFILE's scripts directory —
#   cp cron/kinerary_fleet_alerts.sh ~/.hermes/profiles/<profile>/scripts/
# Hermes resolves --script/--monitor-script against that directory, not the
# global ~/.hermes/scripts. A job pointing at the wrong one is accepted happily
# and fails at run time with "Script not found".
#
# Run by `hermes cron` in --monitor-script mode, which hashes this output:
# unchanged output suppresses the run entirely, so an unresolved problem does
# not re-send every tick, while a problem appearing OR clearing is a change and
# does get reported. The silence-when-healthy contract lives in the `alerts`
# tool, not in any grep here.
#
# Nothing below names a host, a container or a stack: the target comes from
# fleet-stacks.json (default_stack), so this script is identical on every
# deployment. Override per-run with KINERARY_FLEET_STACK.
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

exec "$NODE" "$FLEET" --tool alerts ${KINERARY_FLEET_STACK:+--stack "$KINERARY_FLEET_STACK"}
