#!/usr/bin/env bash
# companion-refresh-prompts.sh — make a live companion's open conversations
# follow its CURRENT SOUL.md.
#
# Hermes saves each conversation's assembled system prompt on its first turn
# and reuses it verbatim on every later turn (prefix caching:
# agent/conversation_loop.py `_restore_or_build_system_prompt`). A SOUL.md
# changed afterwards reaches only NEW conversations — and a family group is one
# conversation that never ends, so a rule changed there never arrives at all.
#
# Live on 2026-09-13, japan2026: at 06:40 the SOUL gained "anyone in the group
# may approve a plan" and "call the rename tool when someone renames you". The
# group conversation had started at 04:54 and kept its 04:54 prompt. It went on
# asking for the organizer's approval, and it agreed to a new name without
# calling the tool, so the router never heard the name.
#
# This clears the saved prompt of every open conversation — what Hermes itself
# does after a /model switch (hermes_state.py `update_session_model`) — and
# restarts the gateway so no in-memory copy survives. History, memory and titles
# are untouched. Each conversation's next turn rebuilds its prompt from disk
# once, which costs one prompt-cache miss.
#
# The write goes through HERMES'S Python, never the host's: the Hermes image
# pins SQLite because Debian 13's 3.46.1 has the WAL-reset corruption bug, and
# the VM's host python links exactly that version.
#
# Refuses while a turn is in flight: the restart would cut it off mid-reply.
#
# Usage: scripts/companion-refresh-prompts.sh <profile>
set -euo pipefail

die() { printf 'companion-refresh-prompts: %s\n' "$1" >&2; exit 2; }

PROFILE="${1:-}"
[[ "$PROFILE" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || die "usage: $0 <profile>"

REFRESH_PY='
import sqlite3, sys, time
path = sys.argv[1]
try:
    db = sqlite3.connect(f"file:{path}?mode=rw", uri=True, timeout=30, isolation_level=None)
    db.execute("BEGIN IMMEDIATE")
except sqlite3.OperationalError as exc:
    print(f"companion-refresh-prompts: cannot open {path}: {exc}", file=sys.stderr)
    raise SystemExit(4)
busy = db.execute("SELECT COUNT(*) FROM session_turn_leases WHERE CAST(expires_at AS REAL) > ?", (time.time(),)).fetchone()[0]
if busy:
    db.execute("ROLLBACK")
    print(f"companion-refresh-prompts: {busy} turn(s) in flight; try again in a minute", file=sys.stderr)
    raise SystemExit(3)
cleared = db.execute(
    "UPDATE sessions SET system_prompt = NULL, system_prompt_hash = NULL "
    "WHERE ended_at IS NULL AND (system_prompt IS NOT NULL OR system_prompt_hash IS NOT NULL)"
).rowcount
db.execute(
    "DELETE FROM system_prompts WHERE NOT EXISTS "
    "(SELECT 1 FROM sessions WHERE sessions.system_prompt_hash = system_prompts.hash)"
)
db.execute("COMMIT")
print(cleared)
'

if [ "$(uname -s)" = Darwin ]; then
  PY="$HOME/.hermes/hermes-agent/venv/bin/python"
  [ -x "$PY" ] || die "no Hermes venv python at $PY"
  CLEARED="$("$PY" -c "$REFRESH_PY" "$HOME/.hermes/profiles/$PROFILE/state.db")"
  launchctl kickstart -k "gui/$(id -u)/ai.hermes.gateway-$PROFILE" >/dev/null \
    || die "cleared $CLEARED prompt(s) but could not restart ai.hermes.gateway-$PROFILE"
else
  CONTAINER="${HERMES_CONTAINER:-hermes}"
  docker exec "$CONTAINER" test -d "/opt/data/profiles/$PROFILE" || die "no profile $PROFILE in container $CONTAINER"
  CLEARED="$(docker exec -i "$CONTAINER" python3 -c "$REFRESH_PY" "/opt/data/profiles/$PROFILE/state.db")"
  docker exec "$CONTAINER" hermes -p "$PROFILE" gateway stop </dev/null >/dev/null 2>&1 || true
  docker exec "$CONTAINER" hermes -p "$PROFILE" gateway start </dev/null >/dev/null \
    || die "cleared $CLEARED prompt(s) but gateway start failed for $PROFILE"
fi

printf 'REFRESHED %s prompts=%s\n' "$PROFILE" "$CLEARED"
