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
#
# A SECTION THAT FAILS IS REPORTED, NEVER SMOOTHED OVER. This used to run the
# alerts check with `|| true`, so a query that could not reach the database
# printed "Nothing needs attention" and exited 0 — a monitor announcing a
# healthy fleet it had not looked at. Each section now either prints its answer
# or says plainly that it could not be read, the other sections still run, and
# the script exits non-zero at the end, which Hermes delivers as a failed
# watchdog with this output attached.
set -uo pipefail

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

# run_section <tool args…>: on success OUT holds stdout; on failure ERR holds the
# first line of the tool's error and FAILED is incremented. Never both.
FAILED=0
OUT=""
ERR=""
run_section() {
  local err_file
  err_file="$(mktemp)"
  OUT=""
  ERR=""
  if OUT="$(fleet_tool "$@" 2>"$err_file")"; then
    rm -f "$err_file"
    return 0
  fi
  ERR="$(head -n 1 "$err_file" | cut -c1-300)"
  rm -f "$err_file"
  [ -n "$ERR" ] || ERR="exited without an error message"
  FAILED=$((FAILED + 1))
  return 1
}

# This is delivered with --no-agent: no model sits between this script and
# Telegram, so whatever markdown syntax appears here is exactly what the
# gateway's markdown→MarkdownV2 converter has to work with. Plain indented
# text has nothing for it to convert, which is why an earlier version of this
# digest rendered "flat" despite being sent through the same formatter as
# every other message. Bold section titles + fenced code blocks around the
# tabular sections (so column alignment survives) fixes that with no agent
# involved.
echo "*📋 Kinerary daily digest — $(date '+%a %d %b, %H:%M')*"
echo

if run_section --tool fleet_overview; then
  echo "*Fleet overview*"
  echo '```'
  echo "$OUT"
  echo '```'
else
  echo "❌ The fleet overview could not be read: $ERR"
fi
echo

if run_section --tool statistics --days 7; then
  echo "*Statistics — last 7 days*"
  echo '```'
  echo "$OUT"
  echo '```'
else
  echo "❌ Statistics could not be read: $ERR"
fi
echo

# The same alerts the watchdog uses, so the digest and the alerts can never
# disagree about what is wrong. Empty output means healthy ONLY when the check
# itself succeeded.
if run_section --tool alerts; then
  if [ -n "$OUT" ]; then
    echo "*⚠️ Needs attention*"
    echo '```'
    echo "$OUT"
    echo '```'
  else
    echo "✅ *Nothing needs attention.*"
  fi
else
  echo "❌ *Fleet health could NOT be checked* — the alerts query failed, so this digest cannot say whether anything needs attention."
  echo "   $ERR"
fi

[ "$FAILED" -eq 0 ] || exit 1
