#!/usr/bin/env bash
# Materialize one trip companion on this host, from a handoff supplied on stdin.
#
# THIS IS A TRUST BOUNDARY. It is the forced command for a dedicated SSH key
# used by the provisioning worker, and it is written on the assumption that
# everything arriving from the other side is untrusted:
#
#   - `$SSH_ORIGINAL_COMMAND` is IGNORED, deliberately and completely. That
#     string is whatever the caller typed after `ssh host …`, and honouring any
#     part of it is what turns a single-purpose key into general host
#     execution. It is not read, not logged, not branched on.
#   - No arguments are accepted. Invocation shape is fixed.
#   - Every host-side path is derived here. The handoff names a profile; it
#     does not choose where anything is written.
#   - The profile name is charset-checked BEFORE it is ever used as a path
#     component, because it becomes a directory under ~/.hermes/profiles.
#
# Why SSH at all: the Hermes install this must create a profile in is a macOS
# arm64 venv (`~/.hermes/hermes-agent/venv` — Mach-O, pinned to absolute host
# paths, 1.5G), and the profiles it creates are served by the gateway running
# on this host. A containerised Hermes could neither execute nor create
# profiles for the build that actually runs them.
#
# This is a BRIDGE, not a foundation. The durable contract is the adapter's:
# "materialize this companion from this validated handoff". Under the planned
# K3s direction a trip companion becomes an orchestrated deployable unit and
# this path disappears without the provisioning contract changing. Do not
# spread SSH-to-this-Mac into any other layer, and do not let an already
# provisioned trip depend on it at runtime — nothing here is on the path of a
# live trip, its routing, or its chat binding.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RENDER="$REPO_ROOT/profile-templates/familytrip-companion/render_profile.py"

# A forced command runs with a non-interactive, non-login PATH — no shell rc is
# sourced — so `hermes` at ~/.local/bin is not found the way it is in a
# terminal. `render_profile.py` shells `hermes profile create` itself, so the
# child needs this too, not just the check below. Set explicitly here rather
# than depending on the caller: the wrapper deriving its own environment is the
# same principle as it deriving its own paths.
PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
export PATH

die() { printf 'companion-install-host: %s\n' "$1" >&2; exit 2; }

[ -f "$RENDER" ] || die "render_profile.py not found at $RENDER"
command -v hermes >/dev/null 2>&1 || die "hermes CLI not on PATH for $(whoami)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/companion-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

# The handoff, and nothing else, comes from the caller.
HANDOFF="$WORK/handoff.json"
umask 077
cat > "$HANDOFF"
[ -s "$HANDOFF" ] || die "empty handoff on stdin"

# Validate before use. `render_profile.py` does its own strict schema check and
# forbidden-key scan; this is the narrower question of whether the one value
# that becomes a filesystem path is safe to treat as one.
PROFILE_NAME="$(
  /usr/bin/python3 - "$HANDOFF" <<'PY'
import json, re, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"handoff is not valid JSON: {e}", file=sys.stderr); raise SystemExit(2)
name = ((d.get("profile") or {}).get("name") or "")
# Conservative on purpose: this becomes ~/.hermes/profiles/<name>. No dots (no
# traversal), no separators, no spaces, bounded length.
if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,62}", name):
    print(f"refusing unsafe profile name: {name!r}", file=sys.stderr); raise SystemExit(2)
print(name)
PY
)" || die "handoff validation failed"

# render_profile.py refuses to overwrite an existing profile, so a retried job
# after a partial success is a safe error rather than a silent clobber. Report
# it as already-present instead of failing the whole provisioning run: the
# profile from the earlier attempt is still there and still correct.
# Locate a python that can read YAML. Only the Hermes venv's has it on a
# stock macOS, and this script already requires the Hermes install to exist.
find_yaml_python() {
  for candidate in \
      "$HOME/.hermes/hermes-agent/venv/bin/python3" \
      "$(command -v python3 || true)" \
      /usr/bin/python3; do
    [ -x "$candidate" ] || continue
    "$candidate" -c 'import yaml' >/dev/null 2>&1 && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

# ACTIVATE, not just materialize.
#
# `render_profile.py` writes `config.overlay.yaml` and an INSTALL.md that says
# to "deliberately merge" it. Nothing did. A profile created by the automated
# path therefore had NO config.yaml at all, and the first message routed to it
# died with "No LLM provider configured" — the trip provisioned, the companion
# installed, the binding opened, and the organizer got an error. Found live
# 2026-09-06 on japan20262.
#
# "Deliberately" is why the template refuses to do this itself: the overlay
# carries `SET_VIA_SECURE_CONFIG` placeholders for things only a real
# deployment can fill (trip-mcp's URL, set later by the MCP bridge). So the
# merge is deliberate here rather than blind: any subtree still holding a
# placeholder is DROPPED, never written. A missing key is a capability the
# companion does not have yet; a placeholder key is one it thinks it has.
merge_overlay() {
  local name="$1"
  local home="$HOME/.hermes/profiles/$name"
  local overlay="$home/config.overlay.yaml"
  local config="$home/config.yaml"
  [ -f "$overlay" ] || { printf 'companion-install-host: no overlay to merge\n' >&2; return 0; }

  local py
  py="$(find_yaml_python)" || {
    printf 'companion-install-host: no python with PyYAML; %s left unconfigured\n' "$name" >&2
    return 0
  }

  "$py" - "$overlay" "$config" <<'PYMERGE'
import sys, yaml
overlay_path, config_path = sys.argv[1], sys.argv[2]
PLACEHOLDER = "SET_VIA_SECURE_CONFIG"

def has_placeholder(node):
    if isinstance(node, dict):
        return any(has_placeholder(v) for v in node.values())
    if isinstance(node, list):
        return any(has_placeholder(v) for v in node)
    return isinstance(node, str) and PLACEHOLDER in node


def strip(node):
    """Drop any subtree still carrying an unresolved placeholder.

    The WHOLE subtree, not just the offending key. `mcp_servers.trip-mcp` with
    its url removed is not a safer trip-mcp — it is a server entry that cannot
    connect, which is the "thinks it has a capability" state this exists to
    prevent. The MCP bridge writes that entry properly when it runs."""
    if isinstance(node, dict):
        return {k: strip(v) for k, v in node.items() if not has_placeholder(v)}
    if isinstance(node, list):
        return [strip(v) for v in node if not has_placeholder(v)]
    return node

overlay = strip(yaml.safe_load(open(overlay_path)) or {}) or {}
try:
    existing = yaml.safe_load(open(config_path)) or {}
except FileNotFoundError:
    existing = {}

# The profile's own config wins: this fills gaps, it does not overwrite a
# choice someone already made in the target profile.
merged = dict(overlay)
merged.update(existing)
with open(config_path, "w") as fh:
    yaml.safe_dump(merged, fh, sort_keys=False, allow_unicode=True)
print(f"merged overlay -> {config_path} (model={merged.get('model', {}).get('default', 'NONE')})", file=sys.stderr)
PYMERGE
}

if [ -d "$HOME/.hermes/profiles/$PROFILE_NAME" ]; then
  # Idempotent, and it repairs: a profile installed before the merge existed
  # is still missing its provider, and a retry should fix that rather than
  # report success and change nothing.
  merge_overlay "$PROFILE_NAME"
  printf 'ALREADY_PRESENT %s\n' "$PROFILE_NAME"
  exit 0
fi

/usr/bin/env python3 "$RENDER" \
  --input "$HANDOFF" \
  --output "$WORK/rendered" \
  --install-profile "$PROFILE_NAME" >/dev/null

merge_overlay "$PROFILE_NAME"

printf 'INSTALLED %s\n' "$PROFILE_NAME"
