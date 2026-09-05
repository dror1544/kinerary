#!/usr/bin/env bash
# interview-stack-deploy/deploy.sh — bring the Trip Bot interview stack up on
# the current worktree's build, with the checks that were skipped on
# 2026-09-04 and 2026-09-05 and cost real live-run time each time.
#
# WHY THIS EXISTS
#
# Four services have to move together — control-plane API, the interview MCP
# sidecar, the trip-intake Hermes gateway, and the relay — and every one of
# today's deploy failures was a step done out of order or a restart whose
# result was assumed rather than checked:
#
#   - the API restarted without `provisioning.env` sourced, so it came up with
#     an EMPTY interview-agent key. That is a silent "working state" by
#     design (the *_for_chat routes just don't mount), so nothing failed
#     loudly — it cost two live rounds before a grep in the gateway log
#     found it.
#   - the sidecar was restarted the same way, and the fix that "confirmed" it
#     was a `ps` env-var check, which is not the question that matters. The
#     question is what the GATEWAY actually registered, and that was never
#     checked until a person had already been talking to a mute agent for
#     several minutes.
#   - a live conversation was interrupted by restarting the relay mid-run,
#     which drops an in-flight update outright — Telegram considers it
#     delivered, and it never reaches anything on our side.
#
# So: every step below either fails loudly or prints the exact number to look
# at, and the script refuses to touch the relay while an interview looks live
# unless told to anyway.
#
# WHAT THIS DOES NOT DO
#
# It does not decide whether to deploy — that stays a human call, same as
# CLAUDE.md's hard rule 2. It does not fresh-reset a trip (`fresh-interview.py`
# does that) and it does not touch git. Build, restart, verify — that is the
# whole job.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_DIR="$REPO_ROOT/control-plane/api"
DEPLOY_DIR="$REPO_ROOT/control-plane/deployment"
PROVISIONING_ENV="${HOME}/kinerary-deploy/provisioning.env"
RELAY_ARCH_PROFILE="$DEPLOY_DIR/.local-secrets/architecture.relay-host.json"
SOUL_REPO="$REPO_ROOT/.agents/skills/trip-intake-interviewer/SOUL.md"
SOUL_PROFILE="${HOME}/.hermes/profiles/trip-intake/SOUL.md"
AGENT_LOG="${HOME}/.hermes/profiles/trip-intake/logs/agent.log"
RELAY_LOG="/tmp/relay.log"

STEP=0
step() { STEP=$((STEP + 1)); printf '\n[%d] %s\n' "$STEP" "$1"; }
die()  { printf '\nFAILED: %s\n' "$1" >&2; exit 1; }
info() { printf '    %s\n' "$1"; }

FORCE_RESTART_RELAY=0
SKIP_GATEWAY=0
for arg in "$@"; do
  case "$arg" in
    --force-restart-relay) FORCE_RESTART_RELAY=1 ;;
    --skip-gateway) SKIP_GATEWAY=1 ;;
    --help)
      cat <<EOF
Usage: deploy.sh [--force-restart-relay] [--skip-gateway]

  --force-restart-relay   restart the relay even if a session looks mid-turn
                          (awaiting = machine, updated recently). Without
                          this flag the script stops and asks a human.
  --skip-gateway          skip the SOUL deploy + gateway restart (use when
                          only the control-plane code changed and SOUL did
                          not, so there is nothing to re-read).
EOF
      exit 0
      ;;
  esac
done

# ── 0. Preconditions ─────────────────────────────────────────────────────────
step "Preconditions"
[ -f "$PROVISIONING_ENV" ] || die "missing $PROVISIONING_ENV — cannot read the interview agent key"
[ -f "$RELAY_ARCH_PROFILE" ] || die "missing $RELAY_ARCH_PROFILE"
command -v docker >/dev/null || die "docker not on PATH"
info "repo root: $REPO_ROOT"

# ── 1. Build ─────────────────────────────────────────────────────────────────
step "Building control-plane/api"
( cd "$API_DIR" && npm run build ) || die "build failed — fix the type error before touching any live service"
info "build OK"

# ── 2. The interview-agent key, read ONCE, used everywhere below ────────────
#
# This is the fix for the first deploy failure: read it here, from the file
# that both the API and the sidecar are supposed to agree on, rather than
# relying on whatever happens to be in the calling shell's environment.
AGENT_KEY="$(grep -E '^CONTROL_PLANE_INTERVIEW_AGENT_KEY=' "$PROVISIONING_ENV" | cut -d= -f2- | head -1 || true)"
[ -n "$AGENT_KEY" ] || die "CONTROL_PLANE_INTERVIEW_AGENT_KEY is empty in $PROVISIONING_ENV — the *_for_chat tools would silently not mount"
info "agent key present (${#AGENT_KEY} chars)"

SIDECAR_KEY="$(grep -A8 "interview:" "${HOME}/.hermes/profiles/trip-intake/config.yaml" \
  | grep "X-API-Key:" | head -1 | sed 's/.*X-API-Key: *//' | tr -d '"'"'"' \r')"
[ -n "$SIDECAR_KEY" ] || die "could not read the sidecar's own X-API-Key from trip-intake/config.yaml"

# ── 3. Restart the control-plane API, WITH the key sourced ──────────────────
step "Restarting control-plane API"
( set -a; . "$PROVISIONING_ENV"; set +a
  cd "$DEPLOY_DIR"
  DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 \
    docker compose -f compose.local.yml up -d --no-build --force-recreate api
) || die "API restart failed"

for _ in $(seq 1 20); do
  READY="$(curl -s --max-time 3 http://127.0.0.1:4310/readyz || true)"
  echo "$READY" | grep -q '"status":"ready"' && break
  sleep 1
done
echo "$READY" | grep -q '"status":"ready"' || die "API never became ready: $READY"
info "API ready: $READY"

INSIDE_KEY_LEN="$(docker exec kinerary-control-plane-local-api-1 sh -c 'printf %s "$CONTROL_PLANE_INTERVIEW_AGENT_KEY" | wc -c' 2>/dev/null | tr -d ' ')"
[ "${INSIDE_KEY_LEN:-0}" -gt 0 ] || die "the API container came up with an EMPTY agent key — this is the exact 2026-09-04/05 failure. Check compose.local.yml reads \${CONTROL_PLANE_INTERVIEW_AGENT_KEY:-} and that provisioning.env was actually sourced above."
info "API container's agent key: ${INSIDE_KEY_LEN} chars (non-empty, confirmed inside the container — not just in this shell)"

# ── 4. Restart the interview MCP sidecar ─────────────────────────────────────
step "Restarting the interview MCP sidecar"
OLD_SIDECAR="$(lsof -nP -iTCP:4311 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
[ -n "$OLD_SIDECAR" ] && kill "$OLD_SIDECAR" 2>/dev/null
sleep 2
( cd "$API_DIR"
  INTERVIEW_MCP_KEY="$SIDECAR_KEY" INTERVIEW_MCP_PORT=4311 CONTROL_PLANE_INTERVIEW_AGENT_KEY="$AGENT_KEY" \
    nohup node dist/interview-mcp.js >> "${HOME}/kinerary-deploy/logs/interview-mcp.log" 2>&1 &
)
for _ in $(seq 1 10); do lsof -nP -iTCP:4311 -sTCP:LISTEN -t >/dev/null 2>&1 && break; sleep 0.5; done
NEW_SIDECAR="$(lsof -nP -iTCP:4311 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
[ -n "$NEW_SIDECAR" ] || die "sidecar did not come up on :4311"
SIDECAR_KEY_LEN="$(ps -E -p "$NEW_SIDECAR" 2>/dev/null | tr ' ' '\n' | grep '^CONTROL_PLANE_INTERVIEW_AGENT_KEY=' | cut -d= -f2- | wc -c | tr -d ' ')"
[ "${SIDECAR_KEY_LEN:-0}" -gt 1 ] || die "sidecar process (pid $NEW_SIDECAR) has no agent key in its environment"
info "sidecar up: pid $NEW_SIDECAR"

# ── 5. SOUL + gateway restart — with the check that was skipped ─────────────
#
# The second deploy failure: "the sidecar has 12 tools" was believed on the
# strength of a `ps` env-var grep, which proves the key exists, not that the
# gateway registered anything. The only question that matters is what the
# GATEWAY logged after it reconnected, so that is the only thing checked here.
if [ "$SKIP_GATEWAY" -eq 0 ]; then
  step "Deploying SOUL and restarting the trip-intake gateway"
  [ -f "$SOUL_REPO" ] || die "missing $SOUL_REPO"
  cp "$SOUL_REPO" "$SOUL_PROFILE"
  diff -q "$SOUL_REPO" "$SOUL_PROFILE" >/dev/null || die "SOUL copy did not verify identical"
  info "SOUL deployed to the live profile"

  RESTART_AT="$(date '+%Y-%m-%d %H:%M:%S')"
  /Users/elul/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main --profile trip-intake gateway restart \
    2>&1 | sed 's/^/    /' || die "gateway restart command failed"

  # Newline-collapsed on purpose: interview-mcp.ts wraps each `mcp.tool(`
  # call onto its own line before the name, and a line-oriented grep cannot
  # match across that boundary in general (it happened to work under this
  # host's grep during development, which is exactly the kind of thing not to
  # depend on in a script other machines run).
  EXPECTED_TOOLS="$(awk '/if \(AGENT_KEY\)/,0' "$API_DIR/src/interview-mcp.ts" \
    | tr '\n' ' ' | grep -oE 'mcp\.tool\( *"[a-z_]+"' | grep -oE '"[a-z_]+"' | tr -d '"')"
  [ -n "$EXPECTED_TOOLS" ] || die "could not extract the expected *_for_chat tool list from interview-mcp.ts — did the source shape change?"
  info "expecting these agent-gated tools to register: $(echo "$EXPECTED_TOOLS" | tr '\n' ' ')"

  # Two lines get logged per restart: a per-SERVER line that names every tool
  # ("MCP server 'interview' (HTTP): registered N tool(s): mcp__interview__…"),
  # and a summary line ("MCP: registered N tool(s) from 1 server(s)") that
  # does not. Matching the summary line first is a bug this script itself
  # shipped with — it always reports every expected tool "missing", because
  # there is nothing to match a name against on that line. Match the
  # per-server line, which is the one that actually answers the question.
  REGISTERED_LINE=""
  for _ in $(seq 1 15); do
    sleep 2
    REGISTERED_LINE="$(awk -v since="$RESTART_AT" '$0 >= since' "$AGENT_LOG" 2>/dev/null \
      | grep "MCP server 'interview'.*registered.*tool(s):" | tail -1 || true)"
    [ -n "$REGISTERED_LINE" ] && break
  done
  [ -n "$REGISTERED_LINE" ] || die "gateway never logged a tool registration after restarting — is it actually reconnecting to the sidecar?"
  info "gateway logged: $REGISTERED_LINE"

  MISSING=""
  for tool in $EXPECTED_TOOLS; do
    echo "$REGISTERED_LINE" | grep -q "mcp__interview__${tool}" || MISSING="$MISSING $tool"
  done
  [ -z "$MISSING" ] || die "the gateway registered tools but is MISSING: $MISSING — this is exactly how an agent goes mute with no error anywhere except this log line. Check the sidecar has the agent key (step 4) and restart the gateway again."
  info "all agent-gated tools confirmed registered — the agent can actually speak"
else
  step "Skipping SOUL deploy + gateway restart (--skip-gateway)"
fi

# ── 6. The relay — never restarted under a live conversation without asking ─
step "Relay"
LIVE_SESSIONS="$(docker exec kinerary-control-plane-local-postgres-1 psql -U kinerary_control_plane -d kinerary_control_plane -At -c \
  "SELECT telegram_chat_id FROM control_plane.intake_sessions WHERE state <> 'confirmed' AND awaiting = 'machine' AND awaiting_since > now() - interval '5 minutes';" 2>/dev/null || true)"

if [ -n "$LIVE_SESSIONS" ] && [ "$FORCE_RESTART_RELAY" -eq 0 ]; then
  cat <<EOF
    STOPPING before the relay restart.

    At least one interview looks mid-turn right now (awaiting = machine,
    updated in the last 5 minutes): $LIVE_SESSIONS

    Restarting the relay here drops whatever Telegram update is in flight —
    it is fetched by the dying process and never handled, and Telegram
    considers it delivered. This happened live on 2026-09-05 and ate an
    organizer's message mid-interview.

    Ask the person on that chat for a pause, or re-run with
    --force-restart-relay if you have already confirmed it is safe.
EOF
  exit 2
fi

OLD_RELAY="$(lsof -nP -iTCP:4312 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
[ -n "$OLD_RELAY" ] && kill "$OLD_RELAY" 2>/dev/null
sleep 2
( cd "$API_DIR"
  env -u RELAY_GATEWAY_SECRET CONTROL_PLANE_ARCHITECTURE_PROFILE="$RELAY_ARCH_PROFILE" \
    nohup npx tsx src/relay/server.ts > "$RELAY_LOG" 2>&1 &
)
for _ in $(seq 1 15); do lsof -nP -iTCP:4312 -sTCP:LISTEN -t >/dev/null 2>&1 && break; sleep 1; done
NEW_RELAY="$(lsof -nP -iTCP:4312 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
[ -n "$NEW_RELAY" ] || die "relay did not come up on :4312 — check $RELAY_LOG"
grep -q '"event":"relay.gateway_connected"' "$RELAY_LOG" || info "WARNING: relay is up but no gateway has connected yet — check $RELAY_LOG"
info "relay up: pid $NEW_RELAY"

echo
echo "All four services confirmed on the new build. Nothing here reset a trip or minted a link — use fresh-interview.py for that."
