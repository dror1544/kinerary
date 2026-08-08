#!/usr/bin/env bash
# scripts/hermes-pipeline/config.sh — deployment topology for this specific
# kinerary + Hermes setup. Sourced by every other script in this directory.
# If your LAN changes, this is the only file that should need editing.

# This machine (site host): re-detected live from the default route each run
# rather than hardcoded, since it's what actually determines reachability —
# a stale cached IP here would silently break PROVISION_BIND / mcp_servers
# URLs without any error until someone tries to connect.
_default_iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
SITE_HOST_IP="${SITE_HOST_IP:-$(ipconfig getifaddr "${_default_iface:-en0}" 2>/dev/null)}"
if [ -z "$SITE_HOST_IP" ]; then
  echo "[config] Could not auto-detect this machine's LAN IP (default route interface: ${_default_iface:-unknown})." >&2
  echo "[config] Set SITE_HOST_IP=x.x.x.x explicitly and re-run." >&2
  exit 1
fi

# The Hermes host ("MacAI"). Bonjour hostname preferred over a static IP —
# DHCP can and will reassign the IP; macai.local survives that.
HERMES_HOST="${HERMES_HOST:-macai.local}"
# Default assumes the same account name as this machine — override with
# HERMES_SSH_USER=... if the Hermes host uses a different username.
HERMES_SSH_USER="${HERMES_SSH_USER:-$(whoami)}"
HERMES_SSH_KEY="${HERMES_SSH_KEY:-$HOME/.ssh/kinerary_hermes_ed25519}"

PROVISION_PORT="${PROVISION_PORT:-3002}"
MCP_PORT="${MCP_PORT:-3001}"
SITE_NGINX_PORT="${SITE_NGINX_PORT:-8081}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERMES_PROFILE_NAME="${HERMES_PROFILE_NAME:-trip-setup}"
