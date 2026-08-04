#!/usr/bin/env bash
# scripts/hermes-pipeline/run.sh — orchestrates the three phases:
#   1. Bootstrap this machine (site host): keys, .env files, provision.js +
#      mcp.js running and reachable on the LAN.
#   2. Establish SSH access to the Hermes host (one-time, needs your password
#      once via ssh-copy-id).
#   3. Bootstrap the Hermes profile remotely: mcp_servers config, SOUL.md,
#      the trip-creation-interview skill.
#
# Each phase pauses for confirmation. Re-run this any time — every phase is
# idempotent (existing secrets, an existing profile, an existing keypair are
# all left alone, not regenerated).
#
# Does NOT: bring up the trip-site/trip-server containers, pick a Hermes
# model/provider, wire a Telegram bot token, or run the interview. Those are
# either live-site deploys (gated separately) or need a decision only you
# can make — see the final summary this prints for what's left.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$HERE/config.sh"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

info "=== Phase 1: bootstrap this machine (site host) ==="
"$HERE/01-bootstrap-site-host.sh"

echo
info "=== Phase 2: SSH access to ${HERMES_HOST} ==="
"$HERE/02-setup-ssh-access.sh"

echo
info "=== Phase 3: bootstrap the Hermes profile on ${HERMES_HOST} ==="
confirm "Proceed with phase 3 (writes files under ~/.hermes/profiles/${HERMES_PROFILE_NAME}/ on ${HERMES_HOST})?" || die "Aborted before phase 3."

# Pull the keys phase 1 generated straight out of the .env files rather than
# re-deriving them, so there's exactly one source of truth.
PROVISION_API_KEY="$(get_env_var "$REPO_ROOT/.env" PROVISION_API_KEY)"
MCP_API_KEY="$(get_env_var "$REPO_ROOT/mcp/.env" MCP_API_KEY)"
[ -n "$PROVISION_API_KEY" ] || die "PROVISION_API_KEY missing from .env — did phase 1 succeed?"
[ -n "$MCP_API_KEY" ]       || die "MCP_API_KEY missing from mcp/.env — did phase 1 succeed?"

INTERVIEW_SRC="$REPO_ROOT/.agents/skills/create-trip"
REMOTE_TMP="/tmp/kinerary-interview-$$"
ssh -i "$HERMES_SSH_KEY" "${HERMES_SSH_USER}@${HERMES_HOST}" "mkdir -p '$REMOTE_TMP'"
scp -i "$HERMES_SSH_KEY" -q \
  "$INTERVIEW_SRC/INTERVIEW.md" "$INTERVIEW_SRC/answers.example.json" \
  "${HERMES_SSH_USER}@${HERMES_HOST}:${REMOTE_TMP}/"

# Piped via stdin, not as CLI args or SendEnv, so the keys never land in this
# shell's history or either machine's `ps` output.
ssh -i "$HERMES_SSH_KEY" "${HERMES_SSH_USER}@${HERMES_HOST}" bash -s -- <<REMOTE
export SITE_HOST_IP='${SITE_HOST_IP}'
export PROVISION_PORT='${PROVISION_PORT}'
export MCP_PORT='${MCP_PORT}'
export PROVISION_API_KEY='${PROVISION_API_KEY}'
export MCP_API_KEY='${MCP_API_KEY}'
export HERMES_PROFILE_NAME='${HERMES_PROFILE_NAME}'
export INTERVIEW_SRC_DIR='${REMOTE_TMP}'
$(cat "$HERE/03-bootstrap-hermes-profile.sh")
REMOTE

ssh -i "$HERMES_SSH_KEY" "${HERMES_SSH_USER}@${HERMES_HOST}" "rm -rf '$REMOTE_TMP'"

echo
ok "All three phases complete."
info "This agent can only READ from provision.js — it cannot create, verify, or"
info "activate a trip. It writes a finished answers.json to its own workspace, and"
info "04-create-trip-from-answers.sh (this repo, run by you) does the rest, deterministically."
echo
info "Manual steps still needed before anyone can be interviewed for real:"
info "  1. On ${HERMES_HOST}: hermes -p ${HERMES_PROFILE_NAME} model   (pick provider/model)"
info "  2. On ${HERMES_HOST}: hermes -p ${HERMES_PROFILE_NAME} gateway setup   (Telegram bot token, DM-only)"
info "  3. Verify the read-only MCP tools actually work (ask it to call provision_health)"
info "  4. On ${HERMES_HOST}: hermes -p ${HERMES_PROFILE_NAME} gateway start"
info "  5. Test the interview yourself first — talk it through to a finished"
info "     workspace/answers.json, then run 04-create-trip-from-answers.sh against it."
info "  6. Activation (docker compose up -d --force-recreate trip-server) is a separate,"
info "     explicit step printed at the end of 04 — never automatic, same rule as everywhere else."
