#!/usr/bin/env bash
# vm-relay-restart.sh — restart the relay on the Proxmox VM (compose.vm.yml),
# optionally pointed at a Telegram stand-in.
#
#   control-plane/deployment/vm-relay-restart.sh                                  # real Telegram
#   control-plane/deployment/vm-relay-restart.sh --telegram-root http://127.0.0.1:4399   # the e2e stand-in
#
# The VM twin of scripts/relay-restart.sh, with the same interface so
# scripts/e2e-full-cycle.py can drive either one (KINERARY_RELAY_RESTART). That
# script restarts the MAC's host relay; running it from here would bounce the
# Mac's live bot onto a stand-in, which is why the runner refuses --auto on a
# non-Mac stack unless this one is named instead.
#
# Same refusals and the same checks, read off the RUNNING container rather than
# assumed from the command that started it:
#   - an interview mid-turn blocks the restart (it would drop that message),
#     unless --force-live, for a person who has checked with that chat;
#   - the relay must report relay.ready;
#   - INTERPRET_PATH_DEFAULT=1 and both runners must be set inside it, or the
#     agent is back / a task returns NOT_CONFIGURED;
#   - TELEGRAM_API_ROOT must be exactly the stand-in asked for, or absent when
#     putting it back.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVISIONING_ENV="${KINERARY_PROVISIONING_ENV:-/opt/kinerary-deploy/provisioning.env}"
VM_ENV="${KINERARY_VM_ENV:-/opt/kinerary-deploy/vm.env}"
PG=kinerary-cp-postgres-1
RELAY=kinerary-cp-relay-1

die() { printf 'vm-relay-restart: %s\n' "$1" >&2; exit 1; }

TELEGRAM_ROOT=""
FORCE_LIVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --telegram-root) TELEGRAM_ROOT="${2:?--telegram-root needs a URL}"; shift ;;
    --force-live) FORCE_LIVE=1 ;;
    *) echo "usage: $0 [--telegram-root URL] [--force-live]" >&2; exit 2 ;;
  esac
  shift
done

# The env files are root-only, so compose runs under sudo; the stand-in URL has
# to survive sudo's environment reset to reach compose's interpolation.
compose() {
  sudo --preserve-env=TELEGRAM_API_ROOT docker compose -f "$DIR/compose.vm.yml" \
    --env-file "$PROVISIONING_ENV" --env-file "$VM_ENV" "$@"
}

if [ "$FORCE_LIVE" -eq 0 ]; then
  live="$(sudo docker exec "$PG" psql -U kinerary_control_plane -d kinerary_control_plane -At -c \
    "SELECT telegram_chat_id FROM control_plane.intake_sessions WHERE state <> 'confirmed'
     AND awaiting = 'machine' AND awaiting_since > now() - interval '5 minutes' LIMIT 1" 2>/dev/null || true)"
  [ -z "$live" ] || die "an interview is mid-turn (chat $live) — restarting now drops its message. Wait, or --force-live after checking with them."
fi

# --force-recreate removes the old container and its log with it. On
# 2026-09-11 that erased the only record of why an interview stalled, so the
# outgoing relay's log is appended here first.
RELAY_LOG="${KINERARY_RELAY_LOG:-/var/log/kinerary/relay.log}"
sudo install -d -m 0750 "$(dirname "$RELAY_LOG")"
if sudo docker inspect "$RELAY" >/dev/null 2>&1; then
  { printf '\n==== %s  outgoing relay, before vm-relay-restart.sh %s ====\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${TELEGRAM_ROOT:+--telegram-root $TELEGRAM_ROOT}"
    sudo docker logs "$RELAY" 2>&1; } | sudo tee -a "$RELAY_LOG" >/dev/null
fi

since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export TELEGRAM_API_ROOT="$TELEGRAM_ROOT"
compose up -d --force-recreate --no-deps relay >/dev/null 2>&1 || die "compose could not recreate the relay"

ready=0
for _ in $(seq 1 30); do
  if compose logs --since "$since" relay 2>/dev/null | grep -q '"event":"relay.ready"'; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || die "the relay did not report relay.ready — see: docker compose logs relay"

envdump="$(sudo docker exec "$RELAY" env)"
echo "$envdump" | grep -qx 'INTERPRET_PATH_DEFAULT=1' || die "the relay runs without INTERPRET_PATH_DEFAULT=1 — the agent would be back"
for var in INTERPRET_RUNNER EXTRACT_RUNNER; do
  echo "$envdump" | grep -q "^$var=." || die "the relay has no $var"
done
if [ -n "$TELEGRAM_ROOT" ]; then
  echo "$envdump" | grep -qx "TELEGRAM_API_ROOT=$TELEGRAM_ROOT" || die "the relay is not pointed at $TELEGRAM_ROOT"
elif echo "$envdump" | grep -q '^TELEGRAM_API_ROOT=.'; then
  die "the relay still points at a Telegram stand-in"
fi

echo "relay restarted on ${TELEGRAM_ROOT:-api.telegram.org} (agentless, runners set)"
