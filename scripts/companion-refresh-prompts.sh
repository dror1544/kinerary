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
# NEVER CUTS A TURN. The clear takes the database's write lock, checks for turns
# in flight in the same transaction, and KEEPS the lock until the gateway has
# been restarted: a turn takes its lease with a write, so one that begins after
# the check cannot get its lease until the restart is done. (Until 2026-11-16 the
# lock ended at the COMMIT, before the restart, and a turn starting in that gap
# was cut.) The hold is bounded (--hold, default 30s): a gateway that needs the
# database in order to stop would otherwise wait on the lock this process holds,
# so after the bound the lock is let go whatever the restart is doing.
# While a turn is in flight this waits — at most --wait seconds (default 120;
# each attempt re-checks) — and when the time is up it gives up with nothing
# cleared and the gateway untouched (exit 3), rather than restarting under
# somebody's reply. It used to refuse at once; a rollout that has just rewritten
# a SOUL cannot ask a person to come back in a minute.
#
# AND SAYS WHETHER THE COMPANION CAME BACK WITH ITS TOOLS. A gateway that
# restarts before its trip-mcp bridge is reachable parks that server after three
# failed connects and stays toolless for the life of the process, silently, while
# the companion answers politely that it cannot read the trip. With
# --expect-tools-from <mcp.js> it reads the tool names the bridge DECLARES out of
# that file (the release's own, for a rollout) and then the gateway's OWN log:
# the line Hermes writes when it registers a server's tools
# (`MCP server '<name>' (...): registered N tool(s): mcp__<name>__<tool>, ...`).
# Every declared tool must be on a registration line logged AFTER the restart, or
# this exits 5 naming what is missing. An upstream process being alive proves
# nothing about what the gateway loaded (the interview-stack-deploy lesson).
#
# --dry-run changes nothing — no prompt cleared, no restart — and prints
# `DRYRUN <profile> turns_in_flight=<n> prompts=<n>`: whether the profile can be
# read at all, how many turns are in flight now, how many prompts a real run
# would clear.
#
# Usage: scripts/companion-refresh-prompts.sh [--dry-run] [--wait <seconds>]
#          [--expect-tools-from <mcp.js> [--server <name>] [--registration-wait <seconds>]] <profile>
# Exit:  0 done · 2 refused or failed · 3 a turn was still in flight after the wait ·
#        4 the profile's database cannot be opened · 5 tools not registered · 6 expected tools unreadable
set -euo pipefail

die() { printf 'companion-refresh-prompts: %s\n' "$1" >&2; exit "${2:-2}"; }

PROFILE=""
DRY_RUN=0
WAIT="${KINERARY_REFRESH_WAIT_SECONDS:-120}"
EXPECT_FROM=""
SERVER="trip-mcp"
REG_WAIT="${KINERARY_REFRESH_REGISTRATION_WAIT_SECONDS:-90}"
POLL="${KINERARY_REFRESH_POLL_SECONDS:-2}"
HOLD="${KINERARY_REFRESH_HOLD_SECONDS:-30}"

usage() { die "usage: $0 [--dry-run] [--wait <seconds>] [--hold <seconds>] [--expect-tools-from <mcp.js> [--server <name>] [--registration-wait <seconds>]] <profile>"; }
seconds() { case "$2" in ''|*[!0-9]*) die "$1 must be a whole number of seconds, not '$2'" ;; esac; [ "$2" -le 3600 ] || die "$1 is capped at 3600 seconds"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --wait) [ "$#" -ge 2 ] || usage; WAIT="$2"; shift ;;
    --hold) [ "$#" -ge 2 ] || usage; HOLD="$2"; shift ;;
    --expect-tools-from) [ "$#" -ge 2 ] || usage; EXPECT_FROM="$2"; shift ;;
    --server) [ "$#" -ge 2 ] || usage; SERVER="$2"; shift ;;
    --registration-wait) [ "$#" -ge 2 ] || usage; REG_WAIT="$2"; shift ;;
    -*) usage ;;
    *) [ -z "$PROFILE" ] || usage; PROFILE="$1" ;;
  esac
  shift
done
[[ "$PROFILE" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || usage
[[ "$SERVER" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$ ]] || die "--server is not a server name"
seconds --hold "$HOLD"; [ "$HOLD" -ge 1 ] || die "--hold must be at least 1 second"
seconds --wait "$WAIT"; seconds --registration-wait "$REG_WAIT"; seconds KINERARY_REFRESH_POLL_SECONDS "$POLL"
[ "$POLL" -ge 1 ] || die "KINERARY_REFRESH_POLL_SECONDS must be at least 1"

# "hold": print `CLEARED <n>` and keep the write lock until stdin has a line or closes, or <seconds> have passed; or print
# `BUSY <n>` and exit 3 when a turn is in flight; exit 4 when the database cannot be opened.
# "dry": open the database read-only, clear nothing, print "<turns in flight> <prompts a real run would clear>".
REFRESH_PY='
import select, sqlite3, sys, time
path = sys.argv[1]
dry = len(sys.argv) > 2 and sys.argv[2] == "dry"
hold = len(sys.argv) > 3 and sys.argv[2] == "hold"
try:
    if dry:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    else:
        db = sqlite3.connect(f"file:{path}?mode=rw", uri=True, timeout=30, isolation_level=None)
        db.execute("BEGIN IMMEDIATE")
except sqlite3.OperationalError as exc:
    print(f"companion-refresh-prompts: cannot open {path}: {exc}", file=sys.stderr)
    raise SystemExit(4)
busy = db.execute("SELECT COUNT(*) FROM session_turn_leases WHERE CAST(expires_at AS REAL) > ?", (time.time(),)).fetchone()[0]
if dry:
    pending = db.execute(
        "SELECT COUNT(*) FROM sessions WHERE ended_at IS NULL AND (system_prompt IS NOT NULL OR system_prompt_hash IS NOT NULL)"
    ).fetchone()[0]
    print(f"{busy} {pending}")
    raise SystemExit(0)
if busy:
    db.execute("ROLLBACK")
    print(f"BUSY {busy}", flush=True)
    raise SystemExit(3)
cleared = db.execute(
    "UPDATE sessions SET system_prompt = NULL, system_prompt_hash = NULL "
    "WHERE ended_at IS NULL AND (system_prompt IS NOT NULL OR system_prompt_hash IS NOT NULL)"
).rowcount
db.execute(
    "DELETE FROM system_prompts WHERE NOT EXISTS "
    "(SELECT 1 FROM sessions WHERE sessions.system_prompt_hash = system_prompts.hash)"
)
if hold:
    # Tell the caller the prompts are cleared and the lock is held, then keep it until the caller says the gateway has
    # been restarted (a line, or the end of its input), or the bound is up.
    print(f"CLEARED {cleared}", flush=True)
    select.select([sys.stdin], [], [], float(sys.argv[3]))
    db.execute("COMMIT")
    raise SystemExit(0)
db.execute("COMMIT")
print(cleared)
'

# The tool names a bridge declares: `mcp.tool("<name>"` / `mcp.registerTool("<name>"` in its source, whitespace
# collapsed so a call wrapped onto its own line still reads, whole-line comments dropped. One name per line.
# Exit 6 when there are none — a source whose shape changed must not pass as a bridge with no tools.
TOOLS_PY='
import re, sys
try:
    text = open(sys.argv[1], encoding="utf-8").read()
except OSError as exc:
    print(f"companion-refresh-prompts: cannot read {sys.argv[1]}: {exc.__class__.__name__}", file=sys.stderr)
    raise SystemExit(6)
text = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("//"))
names = []
for name in re.findall(r"\bmcp\.(?:tool|registerTool)\(\s*[\x27\"]([A-Za-z0-9_]+)[\x27\"]", " ".join(text.split())):
    if name not in names:
        names.append(name)
if not names:
    print(f"companion-refresh-prompts: no tool names found in {sys.argv[1]}: has the source changed shape?", file=sys.stderr)
    raise SystemExit(6)
print("\n".join(names))
'

# stdin: the gateway log from the restart on. argv: server name, then the file of expected tool names.
# Exit 0 when one registration line of that server carries every tool, whole names only (`get_today`
# is not there because `get_today_x` is); otherwise 1 and the missing names, at most 10, on stdout.
# The line is the one the fleet monitor and kinerary-cp-release read: tests/scripts/test_hermes_log_formats.py.
REGISTERED_PY='
import re, sys
server, names = sys.argv[1], [n for n in open(sys.argv[2]).read().split() if n]
line_re = re.compile(r"MCP server \x27([^\x27]+)\x27.*?registered (\d+) tool(?:\(s\))?:?(.*)$")
best = None
for raw in sys.stdin.read().splitlines():
    m = line_re.search(raw)
    if not (m and m.group(1) == server):
        continue
    missing = [n for n in names
               if not re.search(r"(?<![A-Za-z0-9_])(?:mcp__[A-Za-z0-9_-]+?__)?" + re.escape(n) + r"(?![A-Za-z0-9_])", m.group(3))]
    if best is None or len(missing) < len(best):
        best = missing
    if not missing:
        raise SystemExit(0)
print("(no registration line for this server after the restart)" if best is None else " ".join(best[:10]))
raise SystemExit(1)
'

EXPECTED=""
if [ -n "$EXPECT_FROM" ]; then
  [ -f "$EXPECT_FROM" ] || die "--expect-tools-from: no such file: $EXPECT_FROM" 6
fi

if [ "$(uname -s)" = Darwin ]; then
  PY="$HOME/.hermes/hermes-agent/venv/bin/python"
  [ -x "$PY" ] || die "no Hermes venv python at $PY"
  DB="$HOME/.hermes/profiles/$PROFILE/state.db"
  LOG="$HOME/.hermes/profiles/$PROFILE/logs/agent.log"
  LOCAL_PY="$PY"
  run_py() { "$PY" -c "$@"; }
  log_lines() { { wc -l 2>/dev/null < "$LOG" || echo 0; } | tr -d ' '; }
  log_from() { tail -n "+$1" "$LOG" 2>/dev/null || true; }
  restart_gateway() {
    launchctl kickstart -k "gui/$(id -u)/ai.hermes.gateway-$PROFILE" >/dev/null
  }
else
  CONTAINER="${HERMES_CONTAINER:-hermes}"
  docker exec "$CONTAINER" test -d "/opt/data/profiles/$PROFILE" || die "no profile $PROFILE in container $CONTAINER"
  DB="/opt/data/profiles/$PROFILE/state.db"
  LOG="/opt/data/profiles/$PROFILE/logs/agent.log"
  LOCAL_PY=python3
  run_py() { docker exec -i "$CONTAINER" python3 -c "$@"; }
  log_lines() { { docker exec "$CONTAINER" wc -l "$LOG" 2>/dev/null || echo 0; } | awk '{print $1}'; }
  log_from() { docker exec "$CONTAINER" tail -n "+$1" "$LOG" 2>/dev/null || true; }
  restart_gateway() {
    docker exec "$CONTAINER" hermes -p "$PROFILE" gateway stop </dev/null >/dev/null 2>&1 || true
    docker exec "$CONTAINER" hermes -p "$PROFILE" gateway start </dev/null >/dev/null
  }
fi

# What the bridge declares, read before anything is touched: a source that cannot be read stops the run here, not after
# the prompts are gone.
if [ -n "$EXPECT_FROM" ]; then
  EXPECTED="$("$LOCAL_PY" -c "$TOOLS_PY" "$EXPECT_FROM")" || exit "$?"
fi

if [ "$DRY_RUN" = 1 ]; then
  COUNTS="$(run_py "$REFRESH_PY" "$DB" dry)" || exit "$?"
  printf 'DRYRUN %s turns_in_flight=%s prompts=%s\n' "$PROFILE" "${COUNTS%% *}" "${COUNTS##* }"
  exit 0
fi

# Clear, waiting out a turn in flight — and only for as long as asked — and keep the database's write lock until the gateway
# has been restarted. The python that holds the lock runs in the background, reading its stdin from a fifo: writing to the
# fifo (or closing it) is "the gateway is restarted, let go".
WORK="$(mktemp -d "${TMPDIR:-/tmp}/refresh-prompts.XXXXXX")"
HOLD_PID=""
release_hold() {
  [ -n "$HOLD_PID" ] || return 0
  { echo go >&3; } 2>/dev/null || true
  exec 3>&- || true
  wait "$HOLD_PID" 2>/dev/null || true
  HOLD_PID=""
}
cleanup() { release_hold; rm -rf "$WORK"; }
trap '' PIPE
trap cleanup EXIT

attempt_clear() {   # 0: cleared, lock held (HOLD_PID, CLEARED set) · 3: turn in flight · else the python's own exit code
  local fifo="$WORK/release" out="$WORK/out" n=0
  rm -f "$fifo" "$out"
  mkfifo "$fifo"
  : > "$out"
  run_py "$REFRESH_PY" "$DB" hold "$HOLD" < "$fifo" > "$out" 2> "$WORK/err" &
  HOLD_PID=$!
  exec 3> "$fifo"
  while [ ! -s "$out" ] && kill -0 "$HOLD_PID" 2>/dev/null; do sleep 0.1; n=$((n + 1)); [ "$n" -lt 3000 ] || break; done
  case "$(cat "$out")" in
    "CLEARED "*) CLEARED="$(cut -d' ' -f2 < "$out")"; return 0 ;;
  esac
  local code=0
  exec 3>&-
  wait "$HOLD_PID" || code=$?
  HOLD_PID=""
  [ "$code" -ne 3 ] && [ -s "$WORK/err" ] && cat "$WORK/err" >&2
  [ "$code" -ne 0 ] || code=2
  return "$code"
}

WAITED=0
while :; do
  CODE=0
  attempt_clear || CODE=$?
  [ "$CODE" -eq 0 ] && break
  [ "$CODE" -eq 3 ] || exit "$CODE"
  # Waited time is counted in the sleeps taken, not read off a whole-second clock: `date +%s` can end a wait of N
  # seconds anywhere from N-1 to N, and a wait that is shorter than asked is the wrong way round for "never cut a turn".
  if [ "$WAITED" -ge "$WAIT" ]; then
    die "a turn was still in flight after waiting ${WAIT}s; nothing was cleared and the gateway was not restarted. Try again when the conversation is quiet." 3
  fi
  sleep "$POLL"
  WAITED=$(( WAITED + POLL ))
done

FROM=$(( $(log_lines) + 1 ))
RESTARTED=0
restart_gateway && RESTARTED=1
release_hold
[ "$RESTARTED" = 1 ] || die "cleared $CLEARED prompt(s) but could not restart the gateway for $PROFILE"

TOOLS="skipped"
if [ -n "$EXPECTED" ]; then
  EXPECTED_FILE="$WORK/expected"
  printf '%s\n' "$EXPECTED" > "$EXPECTED_FILE"
  WANT="$(printf '%s\n' "$EXPECTED" | wc -l | tr -d ' ')"
  REG_WAITED=0
  MISSING=""
  while :; do
    CODE=0
    MISSING="$(log_from "$FROM" | "$LOCAL_PY" -c "$REGISTERED_PY" "$SERVER" "$EXPECTED_FILE")" || CODE=$?
    [ "$CODE" -eq 0 ] && break
    if [ "$REG_WAITED" -ge "$REG_WAIT" ]; then
      die "cleared $CLEARED prompt(s) and restarted $PROFILE, but its gateway did not register every tool $SERVER declares within ${REG_WAIT}s: ${MISSING:-unreadable log}. The companion may be running without tools; check the bridge, then restart the gateway." 5
    fi
    sleep "$POLL"
    REG_WAITED=$(( REG_WAITED + POLL ))
  done
  TOOLS="$WANT"
fi

printf 'REFRESHED %s prompts=%s tools=%s\n' "$PROFILE" "$CLEARED" "$TOOLS"
