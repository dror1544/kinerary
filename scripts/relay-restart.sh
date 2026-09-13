#!/usr/bin/env bash
# scripts/relay-restart.sh — restart the Trip Bot relay from THIS checkout, and
# prove it came back as the interview needs it.
#
#   scripts/relay-restart.sh                                   # real Telegram
#   scripts/relay-restart.sh --telegram-root http://127.0.0.1:4399   # the e2e stand-in
#
# ONE way to start the relay, because every way that existed went wrong
# differently. The interview's model calls happen IN the relay, so its
# environment is the interview's configuration: started from a shell without
# provisioning.env it silently runs WITH the Hermes agent (CLAUDE.md, "grows
# one back"). So this sources provisioning.env itself rather than trusting the
# caller, and afterwards reads the flags back out of the running process.
#
# Refuses while an interview is mid-turn — restarting drops the Telegram update
# in flight (2026-09-05) — unless --force-live, which is for a person who has
# checked with whoever is on that chat. Automation never passes it.
set -euo pipefail

CHECKOUT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
API_DIR="$CHECKOUT/control-plane/api"
ARCH="$CHECKOUT/control-plane/deployment/.local-secrets/architecture.relay-host.json"
ENV_FILE="$HOME/kinerary-deploy/provisioning.env"
RELAY_LOG="${RELAY_LOG:-/tmp/relay.log}"
PORT=4312
TELEGRAM_ROOT=""; FORCE_LIVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --telegram-root) TELEGRAM_ROOT="${2:?--telegram-root needs a URL}"; shift ;;
    --force-live) FORCE_LIVE=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
die() { printf 'relay-restart: %s\n' "$1" >&2; exit 1; }
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE"
[ -f "$ARCH" ] || die "missing $ARCH (scripts/backup-local-secrets.sh --restore)"

live="$(docker exec kinerary-control-plane-local-postgres-1 psql -U kinerary_control_plane -d kinerary_control_plane -At -c \
  "SELECT telegram_chat_id FROM control_plane.intake_sessions WHERE state <> 'confirmed' AND expired_at IS NULL
     AND awaiting = 'machine' AND awaiting_since > now() - interval '5 minutes'" 2>/dev/null || true)"
if [ -n "$live" ] && [ "$FORCE_LIVE" = 0 ]; then
  die "an interview is mid-turn (chat $live) — restarting now drops its message. Wait, or --force-live after checking with them."
fi

old="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
if [ -n "$old" ]; then
  kill "$old" 2>/dev/null || true
  for _ in $(seq 1 20); do lsof -nP -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1 || break; sleep 0.5; done
fi
lsof -nP -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1 && die "the old relay (pid $old) would not let go of :$PORT"

mark=$(wc -l < "$RELAY_LOG" 2>/dev/null || echo 0)
(
  set -a; . "$ENV_FILE"; set +a
  cd "$API_DIR"
  if [ -n "$TELEGRAM_ROOT" ]; then export TELEGRAM_API_ROOT="$TELEGRAM_ROOT"; else unset TELEGRAM_API_ROOT; fi
  env -u RELAY_GATEWAY_SECRET CONTROL_PLANE_ARCHITECTURE_PROFILE="$ARCH" \
    nohup node_modules/.bin/tsx src/relay/server.ts >> "$RELAY_LOG" 2>&1 &
)
for _ in $(seq 1 30); do lsof -nP -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1 && break; sleep 1; done
pid="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
[ -n "$pid" ] || die "the relay did not come up on :$PORT — see $RELAY_LOG"

# Read the configuration back off the process, not the shell that started it.
envdump="$(ps eww -o command= -p "$pid" | tr ' ' '\n')"
echo "$envdump" | grep -qx 'INTERPRET_PATH_DEFAULT=1' || die "relay pid $pid runs without INTERPRET_PATH_DEFAULT=1 — the agent would be back"
for var in INTERPRET_RUNNER EXTRACT_RUNNER; do
  echo "$envdump" | grep -q "^$var=." || die "relay pid $pid has no $var"
done
if [ -n "$TELEGRAM_ROOT" ]; then
  echo "$envdump" | grep -qx "TELEGRAM_API_ROOT=$TELEGRAM_ROOT" || die "relay pid $pid is not pointed at $TELEGRAM_ROOT"
elif echo "$envdump" | grep -q '^TELEGRAM_API_ROOT='; then
  die "relay pid $pid still points at a Telegram stand-in"
fi

# The interviewer reconnects on its own backoff; the relay is only useful once it has.
for _ in $(seq 1 60); do
  tail -n +"$((mark + 1))" "$RELAY_LOG" | grep -q '"event":"relay.gateway_connected"' && break
  sleep 1
done
tail -n +"$((mark + 1))" "$RELAY_LOG" | grep -q '"event":"relay.gateway_connected"' \
  || die "relay pid $pid is up but no gateway reconnected within 60s — see $RELAY_LOG"
printf 'relay up: pid %s, %s, gateways reconnected\n' "$pid" "${TELEGRAM_ROOT:-real Telegram}"
