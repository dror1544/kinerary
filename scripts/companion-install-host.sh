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
if [ -d "$HOME/.hermes/profiles/$PROFILE_NAME" ]; then
  printf 'ALREADY_PRESENT %s\n' "$PROFILE_NAME"
  exit 0
fi

/usr/bin/env python3 "$RENDER" \
  --input "$HANDOFF" \
  --output "$WORK/rendered" \
  --install-profile "$PROFILE_NAME" >/dev/null

printf 'INSTALLED %s\n' "$PROFILE_NAME"
