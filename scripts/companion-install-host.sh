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
# forbidden-key scan; this is the narrower question of whether the values that
# become filesystem paths are safe to treat as ones.
#
# Two requests arrive on this key: a companion handoff (the default), and —
# since 2026-09-11 — a `trip_mcp_bridge_request`, which carries NOTHING but a
# trip slug and a profile name. Everything the bridge needs beyond those two
# (the site's address, the container, the port) is read from this host's own
# kinerary-deploy files below, never from the request.
VALIDATED="$(
  /usr/bin/python3 - "$HANDOFF" <<'PY'
import json, re, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"handoff is not valid JSON: {e}", file=sys.stderr); raise SystemExit(2)
kind = d.get("record_type") or "trip_assistant_profile_input"
if kind not in ("trip_assistant_profile_input", "trip_mcp_bridge_request"):
    print(f"refusing unknown request type: {kind!r}", file=sys.stderr); raise SystemExit(2)
name = ((d.get("profile") or {}).get("name") or "")
# Conservative on purpose: this becomes ~/.hermes/profiles/<name>. No dots (no
# traversal), no separators, no spaces, bounded length.
if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,62}", name):
    print(f"refusing unsafe profile name: {name!r}", file=sys.stderr); raise SystemExit(2)
slug = ""
if kind == "trip_mcp_bridge_request":
    slug = d.get("slug") or ""
    # Becomes ~/kinerary-deploy/trips/<slug>: the trip-slug grammar, no more.
    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", slug) or len(slug) > 80:
        print(f"refusing unsafe trip slug: {slug!r}", file=sys.stderr); raise SystemExit(2)
print(f"{kind}\t{name}\t{slug}")
PY
)" || die "handoff validation failed"
REQUEST_KIND="$(printf '%s' "$VALIDATED" | cut -f1)"
PROFILE_NAME="$(printf '%s' "$VALIDATED" | cut -f2)"
TRIP_SLUG="$(printf '%s' "$VALIDATED" | cut -f3)"

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

# Everything the relay half needs is derived HERE, host-side, from the same
# architecture profile the relay itself reads. Nothing about it comes from the
# handoff — that is the untrusted side of this boundary, and a caller that
# could name the relay could point a trip's companion at one it controls.
ARCH_PROFILE="${KINERARY_ARCHITECTURE_PROFILE:-$REPO_ROOT/control-plane/deployment/.local-secrets/architecture.relay-host.json}"

# ENROLL, not just activate.
#
# A companion with a rendered profile, a merged config and a working trip-mcp
# still does not speak as itself. The relay routes by gateway IDENTITY, and a
# gateway carrying no identity falls through to `multiplex_gateway_id` — which
# is the INTERVIEWER. That failure is not silence, which is exactly why it
# survived so long: on 2026-09-10 japan-2026's organizer was answered in the
# interviewer's voice, out of the interviewer's profile, about their own trip.
# It was fixed by hand with an `echo` into the profile's .env, and nothing
# wrote it down — so italy-2026, provisioned hours later, shipped unenrolled
# too.
#
# Enrollment against THIS relay is three env stamps, not `hermes gateway
# enroll`: that subcommand redeems a single-use token against the hosted Nous
# connector and needs a portal login. Ours authenticates a gateway with a
# shared secret and takes its identity from the id, so per-trip enrollment is
# "same secret, distinct id" — and the id is the profile name, which is the
# rule docs/per-trip-gateway-architecture.md already states.
enroll_relay() {
  local name="$1"
  local env_file="$HOME/.hermes/profiles/$name/.env"

  if [ ! -f "$ARCH_PROFILE" ]; then
    printf 'companion-install-host: no architecture profile at %s; %s left UNENROLLED (it would answer as the interviewer)\n' \
      "$ARCH_PROFILE" "$name" >&2
    return 0
  fi

  local relay_url secret_file
  relay_url="$(/usr/bin/python3 - "$ARCH_PROFILE" <<'PY'
import json, sys
r = json.load(open(sys.argv[1])).get("relay") or {}
host, port = r.get("bind_host"), r.get("port")
print(f"http://{host}:{port}" if host and port else "")
PY
  )" || relay_url=""
  secret_file="$(/usr/bin/python3 - "$ARCH_PROFILE" <<'PY'
import json, sys
r = json.load(open(sys.argv[1])).get("relay") or {}
refs = r.get("gateway_secret_refs") or []
ref = refs[0] if refs else ""
print(ref[len("file://"):] if ref.startswith("file://") else "")
PY
  )" || secret_file=""

  if [ -z "$relay_url" ] || [ -z "$secret_file" ] || [ ! -r "$secret_file" ]; then
    printf 'companion-install-host: relay url/secret not resolvable from %s; %s left UNENROLLED\n' \
      "$ARCH_PROFILE" "$name" >&2
    return 0
  fi

  local secret
  secret="$(cat "$secret_file")"
  [ -n "$secret" ] || {
    printf 'companion-install-host: relay secret file is empty; %s left UNENROLLED\n' "$name" >&2
    return 0
  }

  # Rewritten in place, not appended: this runs again on every retry, and three
  # copies of GATEWAY_RELAY_ID with different values is a worse state than none.
  umask 077
  touch "$env_file"
  /usr/bin/python3 - "$env_file" "$relay_url" "$name" "$secret" <<'PY'
import sys
env_path, url, gid, secret = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
managed = {
    "GATEWAY_RELAY_URL": url,
    "GATEWAY_RELAY_ID": gid,
    "GATEWAY_RELAY_SECRET": secret,
}
with open(env_path) as fh:
    lines = fh.read().splitlines()
kept = [ln for ln in lines if ln.split("=", 1)[0].strip() not in managed]
while kept and not kept[-1].strip():
    kept.pop()
kept.append("")
kept.append("# Relay identity for this trip's gateway, written by companion-install-host.sh.")
kept.append("# The id IS the profile name: the relay routes to a gateway by it, and a")
kept.append("# gateway without one is served the interviewer's traffic instead of its own.")
kept += [f"{k}={v}" for k, v in managed.items()]
with open(env_path, "w") as fh:
    fh.write("\n".join(kept) + "\n")
PY
  chmod 600 "$env_file"
  printf 'companion-install-host: enrolled %s with the relay at %s\n' "$name" "$relay_url" >&2
}

# START it. A gateway that exists and is enrolled but is not running is still
# a companion that never answers.
#
# launchd rather than a bare background process because this outlives the SSH
# session that created it and has to come back after a reboot — the 2026-09-02
# power-cut evening was spent on a bridge that had simply died and nothing
# brought back. KeepAlive/ThrottleInterval/ExitTimeOut mirror the plist that
# was written by hand for japan2026, which is the only per-trip gateway that
# has actually run.
#
# This is the one thing here that leaves a process behind, so it is also the
# one thing that must be safe to repeat: `bootout` before `bootstrap` makes a
# retry a restart rather than a second copy fighting for the same socket.
start_gateway() {
  local name="$1"
  local home="$HOME/.hermes/profiles/$name"
  local label="ai.hermes.gateway-${name}"
  local plist="$HOME/Library/LaunchAgents/${label}.plist"
  local py="$HOME/.hermes/hermes-agent/venv/bin/python"

  if [ ! -x "$py" ]; then
    printf 'companion-install-host: no Hermes venv python; %s installed but NOT RUNNING\n' "$name" >&2
    return 0
  fi

  mkdir -p "$HOME/Library/LaunchAgents" "$home/logs"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${py}</string>
        <string>-m</string>
        <string>hermes_cli.stderr_timestamp</string>
        <string>--error-log</string>
        <string>${home}/logs/gateway.error.log</string>
        <string>--</string>
        <string>${py}</string>
        <string>-m</string>
        <string>hermes_cli.main</string>
        <string>--profile</string>
        <string>${name}</string>
        <string>gateway</string>
        <string>run</string>
        <string>--replace</string>
        <string>--external-supervisor</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${home}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${HOME}/.hermes/hermes-agent/venv/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.hermes/node/bin:${HOME}/.local/bin</string>
        <key>VIRTUAL_ENV</key>
        <string>${HOME}/.hermes/hermes-agent/venv</string>
        <key>HERMES_HOME</key>
        <string>${home}</string>
    </dict>
    <key>LimitLoadToSessionType</key>
    <array>
        <string>Aqua</string>
        <string>Background</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ExitTimeOut</key>
    <integer>25</integer>
    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>4096</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${home}/logs/gateway.log</string>
    <key>StandardErrorPath</key>
    <string>${home}/logs/gateway.error.log</string>
</dict>
</plist>
PLIST

  launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1; then
    printf 'companion-install-host: gateway %s started\n' "$name" >&2
  else
    printf 'companion-install-host: launchctl bootstrap failed for %s; plist written but NOT RUNNING\n' "$name" >&2
  fi
}

# ── The trip-mcp bridge, wired on THIS host ──────────────────────────────────
#
# The bridge is `node mcp.js` plus a `hermes mcp add` into the companion's
# profile, so it can only be set up where node and Hermes are — here. The
# worker used to run setup-mcp.sh inside its own container, which has neither:
# "env: can't execute 'node'", every provision, found by the first automated
# full cycle (2026-09-11). Every companion shipped blind unless someone started
# its bridge by hand.
#
# The request names a slug and a profile. The site's address, the container
# and the port come from this host's own topology.yaml for that slug, and the
# profile must already be one this key installed.
if [ "$REQUEST_KIND" = "trip_mcp_bridge_request" ]; then
  DEPLOY_ROOT="${KINERARY_DEPLOY_ROOT:-$HOME/kinerary-deploy}"
  TRIP_DIR="$DEPLOY_ROOT/trips/$TRIP_SLUG"
  [ -f "$TRIP_DIR/topology.yaml" ] || die "no topology for $TRIP_SLUG on this host"
  [ -d "$HOME/.hermes/profiles/$PROFILE_NAME" ] || die "no companion profile $PROFILE_NAME to wire"
  [ -x "$DEPLOY_ROOT/setup-mcp.sh" ] || die "no setup-mcp.sh in $DEPLOY_ROOT"
  py="$(find_yaml_python)" || die "no python with PyYAML to read the topology"
  # Into a file, not "$( ... <<HEREDOC )": macOS /bin/bash 3.2 — which is what
  # sshd runs a forced command with — mis-parses quotes inside a here-document
  # inside a command substitution, and one apostrophe in a comment made this
  # whole script unparseable.
  "$py" - "$TRIP_DIR/topology.yaml" "$TRIP_SLUG" > "$WORK/wiring" <<'PYTOPO' || die "could not read $TRIP_SLUG's topology"
import sys, yaml
topo = yaml.safe_load(open(sys.argv[1])) or {}
slug = sys.argv[2]
lxc = ((topo.get("proxmox") or {}).get("lxc") or {})
if topo.get("name") != slug or lxc.get("name") != f"trip-{slug}":
    print(f"topology does not describe {slug}", file=sys.stderr); raise SystemExit(2)
vmid = str((topo.get("proxmox") or {}).get("vmid") or "")
ip = str(lxc.get("ipv4") or "").split("/")[0]
fport = str((topo.get("npm") or {}).get("forward_port") or "")
# The port rule is mcp_bridge.mcp_port_for_vmid's: 3000 + vmid, inside
# 3100-3999, clear of the hand-provisioned bridges below 3100.
if not vmid.isdigit() or not (3100 <= 3000 + int(vmid) <= 3999) or not ip or not fport.isdigit():
    print(f"topology for {slug} lacks a usable vmid/ip/port", file=sys.stderr); raise SystemExit(2)
print(f"{vmid}\t{ip}\t{fport}\t{3000 + int(vmid)}")
PYTOPO
  WIRING="$(cat "$WORK/wiring")"
  VMID="$(printf '%s' "$WIRING" | cut -f1)"; SITE_IP="$(printf '%s' "$WIRING" | cut -f2)"
  SITE_PORT="$(printf '%s' "$WIRING" | cut -f3)"; MCP_PORT="$(printf '%s' "$WIRING" | cut -f4)"
  # REPO_ROOT: the bridge runs this checkout's mcp.js, the same checkout whose
  # templates rendered the companion. stdin from /dev/null so the backgrounded
  # bridge does not hold this SSH session open after the script returns.
  if REPO_ROOT="$REPO_ROOT" "$DEPLOY_ROOT/setup-mcp.sh" "$PROFILE_NAME" "http://$SITE_IP:$SITE_PORT" \
       --vmid "$VMID" --trip-dir "$TRIP_DIR" --port "$MCP_PORT" < /dev/null > "$WORK/setup-mcp.log" 2>&1; then
    printf 'WIRED %s\n' "$PROFILE_NAME"
    exit 0
  fi
  tail -20 "$WORK/setup-mcp.log" >&2
  die "setup-mcp.sh failed for $TRIP_SLUG"
fi

if [ -d "$HOME/.hermes/profiles/$PROFILE_NAME" ]; then
  # Idempotent, and it repairs: a profile installed before the merge existed
  # is still missing its provider, and a retry should fix that rather than
  # report success and change nothing.
  merge_overlay "$PROFILE_NAME"
  enroll_relay "$PROFILE_NAME"
  start_gateway "$PROFILE_NAME"
  printf 'ALREADY_PRESENT %s\n' "$PROFILE_NAME"
  exit 0
fi

/usr/bin/env python3 "$RENDER" \
  --input "$HANDOFF" \
  --output "$WORK/rendered" \
  --install-profile "$PROFILE_NAME" >/dev/null

merge_overlay "$PROFILE_NAME"
enroll_relay "$PROFILE_NAME"
start_gateway "$PROFILE_NAME"

printf 'INSTALLED %s\n' "$PROFILE_NAME"
