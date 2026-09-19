#!/usr/bin/env bash
# scripts/bootstrap-fleet-monitor.sh — stand up a trip-fleet-monitor profile on
# a Hermes host: profile, skill, config, MCP servers, schedules, verification.
#
# GENERIC ON PURPOSE. Nothing here knows a hostname, a container, a uid, a
# deploy root or a database. That is the same rule the skill itself follows
# ("deployment is configuration, not code") and the same rule that keeps
# kinerary-deploy's scripts out of this repository: a script that names real
# infrastructure is an operator concern and lives there, not here. This one is
# the mechanism; the values come from the environment, and it REFUSES rather
# than defaulting to somebody's machine.
#
#   HERMES_HOME=~/.hermes \
#   FLEET_DB_URL_FILE=/path/to/db-url \
#   scripts/bootstrap-fleet-monitor.sh
#
# Idempotent: an existing profile, config, registration or schedule is left
# alone. Re-run it after rebuilding a host rather than remembering the steps.
#
# | variable | required | what |
# |---|---|---|
# | `HERMES_HOME`              | yes | where profiles live ON THIS HOST |
# | `FLEET_DB_URL` / `_FILE`   | yes | the control plane this monitors |
# | `MONITOR_PROFILE`          | no  | profile name (default trip-monitor) |
# | `MONITOR_STACK_LABEL`      | no  | what answers call it (default "production") |
# | `MONITOR_STACK_PRODUCTION` | no  | 1 = real travellers (default 1) |
# | `HERMES_EXEC`              | no  | how to run the CLI (default `hermes`); a VM runs it inside a container |
# | `HERMES_PATH_PREFIX`       | no  | what HERMES_HOME looks like to that CLI, when it differs |
# | `MONITOR_DELIVER` / `_FILE`| no  | e.g. `telegram:<chat>`; no schedules without it |
# | `MONITOR_ISSUE_TARGET`     | no  | issue-target.json; absent = no issue filing |
# | `MONITOR_OWNER`            | no  | `uid:gid` to chown the profile to afterwards |
# | `NODE_BIN`                 | no  | node for the MCP servers (default `node`) |
#
# It never starts the gateway. The monitor has its own Telegram bot and
# Telegram gives each update to ONE getUpdates loop, so starting a second one
# steals messages from the first. `--start-gateway` is a separate decision.
set -euo pipefail

SKILL=trip-fleet-monitor
REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
PROFILE="${MONITOR_PROFILE:-trip-monitor}"
NODE_BIN="${NODE_BIN:-node}"

die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m[ ok ]\033[0m %s\n' "$*"; }
info() { printf '\033[1;34m[info]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }

CHECK_ONLY=0
START_GATEWAY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --start-gateway) START_GATEWAY=1 ;;
    *) echo "usage: $0 [--check] [--start-gateway]" >&2; exit 2 ;;
  esac
  shift
done

[ -n "${HERMES_HOME:-}" ] || die "HERMES_HOME is required — this script does not guess where profiles live."
[ -d "$REPO_ROOT/.agents/skills/$SKILL" ] || die "no $SKILL skill in this checkout ($REPO_ROOT)."

# Always succeeds, even when it finds nothing. An empty result is a case the
# caller handles with a message; a non-zero return here would make `set -e` kill
# the script inside the command substitution, before that message is ever
# reached — a silent exit where a refusal was written.
read_or_value() {  # read_or_value <value> <file>
  if [ -n "$1" ]; then printf '%s' "$1"; return 0; fi
  if [ -n "$2" ] && [ -s "$2" ]; then tr -d '[:space:]' < "$2"; fi
  return 0
}
DB_URL="$(read_or_value "${FLEET_DB_URL:-}" "${FLEET_DB_URL_FILE:-}")"
[ -n "$DB_URL" ] || die "FLEET_DB_URL or FLEET_DB_URL_FILE is required — a monitor with no control plane reports nothing, which reads exactly like a healthy fleet."
DELIVER="$(read_or_value "${MONITOR_DELIVER:-}" "${MONITOR_DELIVER_FILE:-}")"

# `hermes` here, `docker exec … hermes` on a host that containerises it.
# shellcheck disable=SC2206
HERMES_CMD=(${HERMES_EXEC:-hermes})
hermes_cli() { "${HERMES_CMD[@]}" "$@"; }

PROFILE_DIR="$HERMES_HOME/profiles/$PROFILE"
# Where that CLI sees the same directory, when it is not this path.
CLI_PROFILE_DIR="${HERMES_PATH_PREFIX:-$HERMES_HOME}/profiles/$PROFILE"
CLI_SKILL_DIR="$CLI_PROFILE_DIR/skills/travel/$SKILL"

MISSING=0
say_missing() {
  if [ "$CHECK_ONLY" = 1 ]; then warn "MISSING: $1"; MISSING=$((MISSING + 1)); return 1; fi
  return 0
}

# ── 0. The MCP shells out to psql; without it the monitor is silently blind ──
if ! hermes_cli --version >/dev/null 2>&1; then
  die "cannot run the hermes CLI as: ${HERMES_CMD[*]}
  Set HERMES_EXEC to whatever runs it on this host."
fi

# ── 1. Profile ──────────────────────────────────────────────────────────────
if [ -d "$PROFILE_DIR" ]; then
  ok "profile '$PROFILE' exists"
elif say_missing "Hermes profile '$PROFILE'"; then
  hermes_cli profile create "$PROFILE" --no-skills
  ok "created profile '$PROFILE'"
fi

# ── 2. Skill, from the repo — the profile copy is never the source ──────────
if HERMES_HOME="$HERMES_HOME" "$REPO_ROOT/scripts/install-hermes-skill.sh" "$SKILL" "$PROFILE" --check >/dev/null 2>&1; then
  ok "skill '$SKILL' is in sync with the repo"
elif say_missing "skill '$SKILL' (absent, or the profile copy has diverged)"; then
  # --force discards a diverged PROFILE copy. Right on a host nobody edits by
  # hand; on one where somebody has, capture first — install-hermes-skill.sh
  # says so and refuses without this flag.
  HERMES_HOME="$HERMES_HOME" "$REPO_ROOT/scripts/install-hermes-skill.sh" "$SKILL" "$PROFILE" --force
  ok "installed '$SKILL'"
fi

# ── 3. Which control plane it reads ────────────────────────────────────────
# Beside the skill, never inside it: install-hermes-skill.sh diffs the skill
# directory, so a deployment's config in there would read as drift forever.
STACKS="$PROFILE_DIR/fleet-stacks.json"
if [ -s "$STACKS" ]; then
  ok "fleet-stacks.json exists (leaving it alone)"
elif say_missing "fleet-stacks.json"; then
  LABEL="${MONITOR_STACK_LABEL:-production}"
  PROD=true; [ "${MONITOR_STACK_PRODUCTION:-1}" = 1 ] || PROD=false
  umask 077
  cat > "$STACKS" <<JSON
{
  "//": "Written by scripts/bootstrap-fleet-monitor.sh. The MCP opens this",
  "//2": "connection read-only regardless (PGOPTIONS).",
  "default_stack": "prod",
  "stacks": {
    "prod": { "label": "$LABEL", "production": $PROD, "url": "$DB_URL" }
  }
}
JSON
  chmod 0600 "$STACKS"
  ok "wrote fleet-stacks.json"
fi

# ── 4. MCP servers ─────────────────────────────────────────────────────────
register_mcp() {  # register_mcp <name> <script>
  if hermes_cli --profile "$PROFILE" mcp list 2>/dev/null | grep -qE "(^|[[:space:]])$1([[:space:]]|$)"; then
    ok "MCP '$1' registered"; return
  fi
  say_missing "MCP server '$1'" || return 0
  hermes_cli --profile "$PROFILE" mcp add "$1" --command "$NODE_BIN" --args "$CLI_SKILL_DIR/$2"
  ok "registered MCP '$1'"
}
register_mcp fleet fleet-mcp.mjs

if [ -n "${MONITOR_ISSUE_TARGET:-}" ] && [ -s "${MONITOR_ISSUE_TARGET}" ]; then
  register_mcp issues issue-mcp.mjs
else
  warn "no MONITOR_ISSUE_TARGET — skipping the 'issues' MCP."
  warn "  The monitor will watch and report, but cannot file a GitHub issue."
fi

# ── 5. Schedules ───────────────────────────────────────────────────────────
# The digest runs with NO model (--no-agent), which is what keeps a daily
# report cheap enough to keep running; the alert calls one only on a change.
if [ -n "$DELIVER" ]; then
  if [ "$CHECK_ONLY" = 0 ]; then
    mkdir -p "$PROFILE_DIR/scripts"
    cp "$REPO_ROOT/.agents/skills/$SKILL/cron/"*.sh "$PROFILE_DIR/scripts/"
    chmod 0755 "$PROFILE_DIR/scripts/"*.sh
  fi
  add_cron() {  # add_cron <name> <args...>
    local name="$1"; shift
    if hermes_cli --profile "$PROFILE" cron list 2>/dev/null | grep -q "$name"; then
      ok "schedule '$name' exists"; return
    fi
    say_missing "schedule '$name'" || return 0
    hermes_cli --profile "$PROFILE" cron create "$@"
    ok "created schedule '$name'"
  }
  add_cron fleet-digest '0 9 * * *' --name fleet-digest \
    --script kinerary_fleet_digest.sh --no-agent --deliver "$DELIVER"
  add_cron fleet-alerts 'every 30m' \
    'The fleet changed. Say what is wrong now, shortest first. Triage anything under REPORTED BY A COMPANION with bug_reports before you speak.' \
    --name fleet-alerts --monitor-script kinerary_fleet_alerts.sh --deliver "$DELIVER"
else
  warn "no MONITOR_DELIVER — schedules not created. A monitor with nowhere to report is a monitor nobody hears."
fi

# ── 6. Ownership, where the CLI runs as somebody else ──────────────────────
if [ "$CHECK_ONLY" = 0 ] && [ -n "${MONITOR_OWNER:-}" ]; then
  chown -R "$MONITOR_OWNER" "$PROFILE_DIR"
  ok "profile owned by $MONITOR_OWNER"
fi

# ── 7. Prove it can read the fleet, rather than assuming ───────────────────
if [ "$CHECK_ONLY" = 0 ]; then
  info "reading the control plane through the MCP, as the monitor will"
  KINERARY_FLEET_CONFIG="$STACKS" "$NODE_BIN" \
    "$PROFILE_DIR/skills/travel/$SKILL/fleet-mcp.mjs" --tool stacks \
    || die "the MCP could not read the control plane. Fix that before a gateway starts reporting on it.
  A common cause: psql is not on PATH where the MCP runs (FLEET_PSQL_BIN overrides it)."
fi

if [ "$CHECK_ONLY" = 1 ]; then
  [ "$MISSING" -eq 0 ] && { ok "'$PROFILE' is fully bootstrapped on this host"; exit 0; }
  die "$MISSING thing(s) missing — run without --check to build them."
fi

# ── 8. The gateway, only when asked ───────────────────────────────────────
if [ "$START_GATEWAY" = 1 ]; then
  warn "Telegram gives each update to ONE getUpdates loop: if another host is running"
  warn "  a '$PROFILE' gateway on this bot, the two will steal each other's messages."
  hermes_cli -p "$PROFILE" gateway start
  ok "gateway started"
else
  ok "bootstrap complete. The gateway is NOT running."
  printf '  %s\n' "stop any other host's '$PROFILE' gateway first, then: $0 --start-gateway"
fi
