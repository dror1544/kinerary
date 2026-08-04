#!/usr/bin/env bash
# scripts/hermes-pipeline/01-bootstrap-site-host.sh
#
# Runs on THIS machine (the site host — holds the repo, runs docker compose).
# Idempotent: safe to re-run. Never regenerates a secret that already exists.
#
# What it does:
#   1. Generates JWT_SECRET / HERMES_API_KEY / PROVISION_API_KEY into ./.env
#      (root) if missing, and MCP_API_KEY into mcp/.env if missing.
#   2. Keeps mcp/.env's TRIP_API_KEY in sync with root .env's HERMES_API_KEY —
#      these MUST be the same value (mcp.js authenticates to the site's own
#      API with it) and this script is the one place that enforces that.
#   3. Adds a LAN-reachable port binding for mcp.js via docker-compose.override.yml
#      (alongside, not instead of, the checked-in 127.0.0.1-only one), so the
#      Hermes host can reach it — mcp.js is documented as safe to expose on the LAN.
#   4. Installs provision.js as a launchd LaunchAgent, bound to the LAN IP
#      (never 0.0.0.0 — see mcp/PROVISIONING.md's "the one rule").
#   5. Starts mcp.js via docker compose.
#   6. Verifies both from this host, and greps in-repo nginx/proxy config for
#      anything that would accidentally forward provision.js's port.
#
# What it deliberately does NOT do: bring up trip-site/trip-server. That's a
# live-site deploy, gated separately (see CLAUDE.md) — this script only stands
# up the two agent-facing tool servers.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$HERE/config.sh"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

cd "$REPO_ROOT"

info "Site host LAN IP detected as: $SITE_HOST_IP"
info "Repo root: $REPO_ROOT"
echo
info "This will write secrets into .env and mcp/.env (both gitignored),"
info "install a launchd service for provision.js, widen mcp.js's docker"
info "port binding to the LAN, and start the mcp.js container."
confirm "Proceed?" || die "Aborted."

# ── 1. Root .env ────────────────────────────────────────────────────────────
ENV_FILE="$REPO_ROOT/.env"
touch "$ENV_FILE"

JWT_SECRET="$(get_env_var "$ENV_FILE" JWT_SECRET)"
if [ -z "$JWT_SECRET" ]; then
  JWT_SECRET="$(gen_key)"
  set_env_var "$ENV_FILE" JWT_SECRET "$JWT_SECRET"
  ok "Generated JWT_SECRET"
else
  info "JWT_SECRET already set, leaving it alone"
fi

HERMES_API_KEY="$(get_env_var "$ENV_FILE" HERMES_API_KEY)"
if [ -z "$HERMES_API_KEY" ]; then
  HERMES_API_KEY="$(gen_key)"
  set_env_var "$ENV_FILE" HERMES_API_KEY "$HERMES_API_KEY"
  ok "Generated HERMES_API_KEY (the site's key for mcp.js -> trip-server)"
else
  info "HERMES_API_KEY already set, leaving it alone"
fi

PROVISION_API_KEY="$(get_env_var "$ENV_FILE" PROVISION_API_KEY)"
if [ -n "$PROVISION_API_KEY" ] && [ "$PROVISION_API_KEY" = "$HERMES_API_KEY" ]; then
  warn "PROVISION_API_KEY currently equals HERMES_API_KEY — provision.js refuses to start like this. Regenerating it."
  PROVISION_API_KEY=""
fi
if [ -z "$PROVISION_API_KEY" ]; then
  PROVISION_API_KEY="$(gen_key)"
  # Defends against the astronomically unlikely but checked-at-startup collision.
  while [ "$PROVISION_API_KEY" = "$HERMES_API_KEY" ]; do PROVISION_API_KEY="$(gen_key)"; done
  set_env_var "$ENV_FILE" PROVISION_API_KEY "$PROVISION_API_KEY"
  ok "Generated PROVISION_API_KEY"
else
  info "PROVISION_API_KEY already set, leaving it alone"
fi

set_env_var "$ENV_FILE" PROVISION_PORT "$PROVISION_PORT"
set_env_var "$ENV_FILE" PROVISION_BIND "$SITE_HOST_IP"
set_env_var "$ENV_FILE" REPO_ROOT "$REPO_ROOT"
if [ -z "$(get_env_var "$ENV_FILE" ACTIVE_TRIP_DIR)" ]; then
  # Deliberately left blank rather than guessed — this is a statement about
  # which trip is actually live, and nothing is live yet from this script's
  # perspective. Set it by hand when you activate a trip.
  set_env_var "$ENV_FILE" ACTIVE_TRIP_DIR ""
fi
ok "Root .env written: $ENV_FILE"

# ── 2. mcp/.env ──────────────────────────────────────────────────────────────
MCP_ENV_FILE="$REPO_ROOT/mcp/.env"
touch "$MCP_ENV_FILE"

MCP_API_KEY="$(get_env_var "$MCP_ENV_FILE" MCP_API_KEY)"
if [ -z "$MCP_API_KEY" ]; then
  MCP_API_KEY="$(gen_key)"
  set_env_var "$MCP_ENV_FILE" MCP_API_KEY "$MCP_API_KEY"
  ok "Generated MCP_API_KEY (what Hermes presents to mcp.js's /sse)"
else
  info "MCP_API_KEY already set, leaving it alone"
fi

# Derived, not independent — always kept in sync with the site's own key.
set_env_var "$MCP_ENV_FILE" TRIP_API_KEY "$HERMES_API_KEY"
if [ -z "$(get_env_var "$MCP_ENV_FILE" API_BASE_URL)" ]; then
  set_env_var "$MCP_ENV_FILE" API_BASE_URL "http://localhost:${SITE_NGINX_PORT}"
fi
ok "mcp/.env written: $MCP_ENV_FILE"

# ── 3. Add a LAN-reachable port binding for mcp.js, alongside the existing one ──
# Compose merges `ports:` lists across override files by concatenation, not
# replacement — this ADDS a second, LAN-facing publish of the same container
# port next to docker-compose.yml's checked-in 127.0.0.1-only one. It does not
# remove or loosen that original binding; verified against `docker compose
# config`'s merged output, which lists both.
OVERRIDE_FILE="$REPO_ROOT/mcp/docker-compose.override.yml"
cat > "$OVERRIDE_FILE" <<EOF
# Auto-generated by scripts/hermes-pipeline/01-bootstrap-site-host.sh.
# Host-specific (bound to this machine's current LAN IP) — not meant to be
# committed. Compose concatenates ports: lists across override files, so this
# ADDS a LAN-reachable publish alongside docker-compose.yml's checked-in
# 127.0.0.1-only one (that original binding is untouched), per mcp/README.md's
# "Local always-on agent" reachability table.
services:
  trip-mcp:
    ports:
      - "${SITE_HOST_IP}:${MCP_PORT}:3001"
EOF
if ! command grep -qxF "mcp/docker-compose.override.yml" "$REPO_ROOT/.gitignore" 2>/dev/null; then
  echo "mcp/docker-compose.override.yml" >> "$REPO_ROOT/.gitignore"
  ok "Added mcp/docker-compose.override.yml to .gitignore (host-specific, LAN IP baked in)"
fi
ok "mcp.js will additionally be reachable at ${SITE_HOST_IP}:${MCP_PORT} (127.0.0.1:${MCP_PORT} still works too)"

# ── 4. provision.js as a launchd LaunchAgent ─────────────────────────────────
LAUNCHD_LABEL="com.kinerary.provision"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
PROVISION_LOG_DIR="$REPO_ROOT/mcp/logs"
mkdir -p "$PROVISION_LOG_DIR"

if [ ! -d "$REPO_ROOT/mcp/node_modules" ]; then
  info "Installing mcp/ npm dependencies (shared by mcp.js and provision.js)..."
  (cd "$REPO_ROOT/mcp" && npm install)
fi

cat > "$LAUNCHD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>${REPO_ROOT}/mcp/provision.js</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO_ROOT}/mcp</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PROVISION_API_KEY</key><string>${PROVISION_API_KEY}</string>
    <key>PROVISION_PORT</key><string>${PROVISION_PORT}</string>
    <key>PROVISION_BIND</key><string>${SITE_HOST_IP}</string>
    <key>REPO_ROOT</key><string>${REPO_ROOT}</string>
    <key>ACTIVE_TRIP_DIR</key><string>$(get_env_var "$ENV_FILE" ACTIVE_TRIP_DIR)</string>
    <key>HERMES_API_KEY</key><string>${HERMES_API_KEY}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${PROVISION_LOG_DIR}/provision.out.log</string>
  <key>StandardErrorPath</key><string>${PROVISION_LOG_DIR}/provision.err.log</string>
</dict>
</plist>
EOF

UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}/${LAUNCHD_LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$LAUNCHD_PLIST"
launchctl enable "gui/${UID_NUM}/${LAUNCHD_LABEL}"
ok "provision.js installed as a launchd service (${LAUNCHD_LABEL}), bound to ${SITE_HOST_IP}:${PROVISION_PORT}"

# ── 5. mcp.js via docker compose ─────────────────────────────────────────────
info "Starting mcp.js (docker compose)..."
(cd "$REPO_ROOT/mcp" && docker compose up -d --build)
ok "mcp.js container up"

# ── 6. Verify + audit ────────────────────────────────────────────────────────
sleep 2
info "Verifying locally..."
if curl -sf "http://${SITE_HOST_IP}:${PROVISION_PORT}/healthz" >/dev/null; then
  ok "provision.js healthz OK at ${SITE_HOST_IP}:${PROVISION_PORT}"
else
  warn "provision.js healthz did NOT respond. Check: tail -f ${PROVISION_LOG_DIR}/provision.err.log"
fi
if curl -sf "http://${SITE_HOST_IP}:${MCP_PORT}/healthz" >/dev/null; then
  ok "mcp.js healthz OK at ${SITE_HOST_IP}:${MCP_PORT}"
else
  warn "mcp.js healthz did NOT respond. Check: docker compose -f mcp/docker-compose.yml logs trip-mcp"
fi

info "Checking in-repo nginx/proxy config for anything that would forward port ${PROVISION_PORT}..."
if command grep -rn "$PROVISION_PORT" "$REPO_ROOT/nginx.conf" 2>/dev/null; then
  warn "Found a reference to port ${PROVISION_PORT} in nginx.conf — review it above."
else
  ok "No reference to port ${PROVISION_PORT} in nginx.conf."
fi
warn "This only checked files inside this repo checkout. If a system-level Cloudflare Tunnel, router port-forward, or reverse proxy exists OUTSIDE this repo, verify by hand that it does not forward to port ${PROVISION_PORT}."

echo
ok "Phase 1 (site host) complete."
info "Next: scripts/hermes-pipeline/02-setup-ssh-access.sh, to reach ${HERMES_HOST}."
