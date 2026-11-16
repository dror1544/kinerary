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
#   - Which KIND of bridge a companion is wired to (one `mcp.js` per trip, or the
#     one shared process) is this host's own decision, read from this script's
#     environment (KINERARY_SHARED_BRIDGE_ROUTES_DIR and _URL; see "The SHARED
#     trip-mcp bridge" below). No request field can turn it on or choose where it
#     writes or what it talks to.
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
# At most 64 KiB, whatever the request kind: the largest real handoff is a few
# KiB, and an unbounded read is a way to fill the disk through the forced
# command. One byte more than the cap is read so an oversize request is REFUSED,
# not silently truncated into something that might still parse.
head -c 65537 > "$HANDOFF"
[ -s "$HANDOFF" ] || die "empty handoff on stdin"
[ "$(wc -c < "$HANDOFF" | tr -d ' ')" -le 65536 ] || die "request larger than 64 KiB refused"

# Validate before use. `render_profile.py` does its own strict schema check and
# forbidden-key scan; this is the narrower question of whether the values that
# become filesystem paths are safe to treat as ones.
#
# Three requests arrive on this key: a companion handoff (the default); since
# 2026-09-11 a `trip_mcp_bridge_request`; and since 2026-09-28 a
# `trip_mcp_bridge_probe` (issue #119). The last two carry NOTHING but a trip
# slug and a profile name. Everything the bridge needs beyond those two (the
# site's address, the container, the port) is read from this host's own
# kinerary-deploy files below, never from the request.
#
# Since 2026-10-21 (issue #349) three more, all about which gateways run:
# `companion_gateway_status` (READ-ONLY: a list of profile NAMES) and
# `companion_gateway_backfill` (a list of NAMES to mark as managed), neither of
# which carries a `profile` object and so both are validated separately; and
# `companion_gateway_action`, one profile name, a verb from the closed set
# start|stop, and optionally the trip slug whose bridge to check first.
#
# Since 2026-11-16 (#568 slice R2) one more: `companion_profile_rerender`, which
# brings an EXISTING companion's SOUL.md and skills to the release a rollout is
# bringing its trip to. It carries a profile name, a mode (check|apply), whether
# an edited profile may be overwritten, the release's id and commit, and the
# handoff the render needs. It is the one request that is not self-contained:
# the render code and templates it uses are the RELEASE's, in a directory the
# caller hands over through the environment (KINERARY_RELEASE_TREE). An SSH
# forced command cannot set an environment variable, so the worker's key can
# never point this at a tree of its own choosing; only a process already running
# on this host as this user can, which is the rollout command. Without the
# variable the request is refused (see rerender_profile below).
VALIDATED="$(
  /usr/bin/python3 - "$HANDOFF" <<'PY'
import json, re, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"handoff is not valid JSON: {e}", file=sys.stderr); raise SystemExit(2)
if not isinstance(d, dict):
    print("refusing a request that is not a JSON object", file=sys.stderr); raise SystemExit(2)
kind = d.get("record_type") or "trip_assistant_profile_input"
if kind not in ("trip_assistant_profile_input", "trip_mcp_bridge_request", "trip_mcp_bridge_probe",
                "companion_gateway_status", "companion_gateway_backfill", "companion_gateway_action",
                "companion_profile_rerender"):
    print(f"refusing unknown request type: {kind!r}", file=sys.stderr); raise SystemExit(2)
if kind in ("companion_gateway_status", "companion_gateway_backfill"):
    # A list of profile NAMES and nothing else (issue 349). Each one is checked
    # with the same pattern as every other name that reaches this host, because
    # the status handler below reads a directory and matches a process by it.
    names = d.get("profiles")
    if (not isinstance(names, list) or not 1 <= len(names) <= 200 or len(set(map(str, names))) != len(names)
            or not all(isinstance(n, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{1,62}", n) for n in names)):
        print("refusing an unsafe gateway status request", file=sys.stderr); raise SystemExit(2)
    print(f"{kind}\t\t\t"); raise SystemExit(0)
profile = d.get("profile") or {}
name = profile.get("name") if isinstance(profile, dict) else None
# Conservative on purpose: this becomes ~/.hermes/profiles/<name>. No dots (no
# traversal), no separators, no spaces, bounded length.
if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,62}", name):
    print(f"refusing unsafe profile name: {name!r}", file=sys.stderr); raise SystemExit(2)
slug = ""
action = ""
if kind == "companion_gateway_action":
    action = d.get("action")
    if action not in ("start", "stop"):
        print(f"refusing unknown gateway action: {action!r}", file=sys.stderr); raise SystemExit(2)
if kind in ("trip_mcp_bridge_request", "trip_mcp_bridge_probe", "companion_gateway_action"):
    # Absent or a string, nothing else: 0, false, [] and {} are not "no slug".
    raw = d.get("slug")
    if raw is not None and not isinstance(raw, str):
        print(f"refusing unsafe trip slug: {raw!r}", file=sys.stderr); raise SystemExit(2)
    slug = raw or ""
    # Becomes ~/kinerary-deploy/trips/<slug>: the trip-slug grammar, no more.
    if slug != "" and (not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", slug) or len(slug) > 80):
        print(f"refusing unsafe trip slug: {slug!r}", file=sys.stderr); raise SystemExit(2)
    if slug == "" and kind != "companion_gateway_action":
        print(f"refusing unsafe trip slug: {slug!r}", file=sys.stderr); raise SystemExit(2)
if kind == "companion_profile_rerender":
    # Every value that reaches the tab-separated line below is matched against an
    # ASCII pattern first: a tab or a newline in one would be a second, forged field.
    mode = d.get("mode")
    if mode not in ("check", "apply"):
        print(f"refusing unknown re-render mode: {mode!r}", file=sys.stderr); raise SystemExit(2)
    allow = d.get("allow_edited")
    if allow is not True and allow is not False:
        print("refusing a re-render whose allow_edited is not true or false", file=sys.stderr); raise SystemExit(2)
    release = d.get("release")
    rid = release.get("id") if isinstance(release, dict) else None
    commit = release.get("commit") if isinstance(release, dict) else None
    if (not isinstance(rid, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", rid)
            or not isinstance(commit, str) or not re.fullmatch(r"[a-f0-9]{40}", commit)):
        print("refusing a re-render that does not name its release", file=sys.stderr); raise SystemExit(2)
    handoff = d.get("handoff")
    if (not isinstance(handoff, dict) or handoff.get("record_type") != "trip_assistant_profile_input"
            or not isinstance(handoff.get("profile"), dict) or handoff["profile"].get("name") != name):
        print("refusing a re-render whose handoff is not the profile's own", file=sys.stderr); raise SystemExit(2)
    # The handoff goes to its own file, mode 600 (umask 077 is already set), for render_profile.py.
    import os
    fd = os.open(os.path.join(os.path.dirname(sys.argv[1]), "rerender-handoff.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(handoff, fh, ensure_ascii=False)
    print(f"{kind}\t{name}\t\t{mode}\t{1 if allow else 0}\t{rid}\t{commit}")
    raise SystemExit(0)
print(f"{kind}\t{name}\t{slug}\t{action}")
PY
)" || die "handoff validation failed"
REQUEST_KIND="$(printf '%s' "$VALIDATED" | cut -f1)"
PROFILE_NAME="$(printf '%s' "$VALIDATED" | cut -f2)"
TRIP_SLUG="$(printf '%s' "$VALIDATED" | cut -f3)"
GATEWAY_ACTION="$(printf '%s' "$VALIDATED" | cut -f4)"
RERENDER_ALLOW="$(printf '%s' "$VALIDATED" | cut -f5)"
RERENDER_RELEASE_ID="$(printf '%s' "$VALIDATED" | cut -f6)"
RERENDER_RELEASE_COMMIT="$(printf '%s' "$VALIDATED" | cut -f7)"

# ── Which companion gateways run on THIS host (issue #349) ────────────────────
#
# The control plane decides which companions run; to decide it has to see, and
# to enforce it has to start and stop. Three request kinds, all naming PROFILES
# and nothing else the caller controls:
#
#   companion_gateway_status    READ-ONLY. For each name asked: running, duplicate,
#                               stopped or absent.
#   companion_gateway_backfill  writes the provenance marker into profiles that
#                               exist and are not on the deny list.
#   companion_gateway_action    start|stop one profile's gateway (handler below,
#                               after the bridge helpers it uses).
#
# A gateway is recognised the way scripts/e2e-full-cycle.py already does, by its
# command line: `-p|--profile <name> gateway run`, which launchd runs on a Mac and
# an s6 slot in the Hermes container runs on the VM (visible to this host's ps).
# A supervisor wrapper whose own arguments repeat that command line is ONE
# gateway, not two: a match whose parent is also a match for the same profile is
# not counted, so `duplicate` means two independent starters, the thing the
# upgrade precondition worries about.
#
# Written to a file, not inlined: macOS /bin/bash 3.2 mis-parses quotes inside a
# here-document inside a command substitution. Modes:
#   status <handoff> <profiles dir>   the GATEWAY lines and STATUS_END
#   count <name>                      the number of independent gateways, alone
write_gateway_probe() {
  cat > "$WORK/gateway_probe.py" <<'PYPROBE'
import json, os, re, subprocess, sys

NAME = re.compile(r"[a-z0-9][a-z0-9-]{1,62}")
GATEWAY = re.compile(r"(?:^|\s)(?:-p|--profile)(?:\s+|=)([a-z0-9][a-z0-9-]{1,62})\s+gateway\s+run(?:\s|$)")
ROW = re.compile(r"\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(.*)")


def hermes_process(args):
    """Is this command line a Hermes process, not any process whose arguments
    happen to read like one? Argument text alone is what a decoy supplies for
    free; together with the uid filter in top_level_counts() it takes the account
    itself to fake a gateway. Shapes that count:

      hermes -p NAME gateway run ...                      the CLI itself
      <venv>/python3 <venv>/bin/hermes -p NAME gateway run --replace
                                                          the shape the VM runs today
                                                          (Hermes ab0d98414, observed
                                                          on the VM: uid 10000,
                                                          /opt/hermes/.venv/bin/python3
                                                          /opt/hermes/.venv/bin/hermes
                                                          -p <profile> gateway run, plus flags)
      <python> ... -m hermes_cli.main|stderr_timestamp ... a module invocation, -m anywhere in argv

    TODO(rehearsal S4, #349 PR C): the newer Hermes (4097709b0c) may run a
    gateway differently (a supervised wrapper, a different entry point). Its
    command line is unknown until the container rehearsal; until S4 records it
    and the matcher is extended, a gateway of that shape would read as stopped.
    The confirming stop is therefore a REAL `hermes gateway stop`, so a
    mis-read never leaves a running gateway merely "confirmed"."""
    tokens = args.split()
    if not tokens:
        return False
    exe = os.path.basename(tokens[0])
    if exe == "hermes":
        return True
    if not exe.startswith("python"):
        return False
    rest = tokens[1:]
    if any(os.path.basename(t) == "hermes" for t in rest):
        return True
    return any(t == "-m" and i + 1 < len(rest) and rest[i + 1].startswith("hermes_cli")
               for i, t in enumerate(rest))


def fail(message):
    print("companion-install-host: " + message, file=sys.stderr)
    raise SystemExit(2)


def top_level_counts():
    try:
        listing = subprocess.run(["ps", "axww", "-o", "pid=,ppid=,uid=,args="], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        listing = None
    if listing is None or listing.returncode != 0:
        fail("could not list processes")
    matches = {}
    for line in listing.stdout.splitlines():
        row = ROW.fullmatch(line)
        # Only this account's processes (the hermes user, on the VM the same uid
        # as the container's), and only ones that are Hermes.
        mine = row is not None and int(row.group(3)) == os.getuid()
        found = GATEWAY.search(row.group(4)) if mine and hermes_process(row.group(4)) else None
        if found:
            matches[int(row.group(1))] = (int(row.group(2)), found.group(1))
    counts = {}
    for pid, (ppid, profile) in matches.items():
        parent = matches.get(ppid)
        if parent is None or parent[1] != profile:
            counts[profile] = counts.get(profile, 0) + 1
    return counts


mode = sys.argv[1]
if mode == "count":
    if not NAME.fullmatch(sys.argv[2]):
        fail("refusing an unsafe profile name")
    print(top_level_counts().get(sys.argv[2], 0))
    raise SystemExit(0)

names = json.load(open(sys.argv[2])).get("profiles")
if not isinstance(names, list) or not names or not all(isinstance(n, str) and NAME.fullmatch(n) for n in names):
    fail("refusing an unsafe gateway status request")
counts = top_level_counts()
for name in names:
    n = counts.get(name, 0)
    if n >= 2:
        state = "duplicate"
    elif n == 1:
        state = "running"
    elif os.path.isdir(os.path.join(sys.argv[3], name)):
        state = "stopped"
    else:
        state = "absent"
    print(f"GATEWAY {name} {state} {min(n, 99)}")
print(f"STATUS_END {len(names)}")
PYPROBE
}

# The provenance marker. A Hermes host also runs profiles that are not this
# product's companions (an operator's own, with their own bot tokens), and the
# control plane must never start or stop one of those. A profile this system
# INSTALLED carries the marker, and a profile without it is refused by every
# action. The marker is written only (1) by a fresh install here, never on an
# ALREADY_PRESENT retry - a profile that was there before this system touched it
# is exactly what the marker exists to exclude - and (2) by the backfill, which
# needs host-side evidence that this system installed it (the trip's
# companion-provenance.json, written when the bridge was wired, names the
# profile). It is created exclusively and never through a symlink, and a profile
# directory that is a symlink is not a profile.
#
# The deny list is the belt to that braces: names never touched even if somebody
# puts a marker in them. ONE list, scripts/protected-profiles.txt, which
# teardown-trip.py reads too (it adds only the interviewer). A missing or
# malformed list refuses everything: no list is not "nothing is protected".
GATEWAY_MARKER="kinerary-managed"
PROTECTED_FILE="$REPO_ROOT/scripts/protected-profiles.txt"
GATEWAY_DENY=""
load_gateway_deny() {
  local line out=" "
  [ -f "$PROTECTED_FILE" ] || die "no protected-profiles list at $PROTECTED_FILE: refusing to touch any gateway"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *[!a-z0-9-]*) die "malformed entry in $PROTECTED_FILE: refusing to touch any gateway" ;; esac
    out="$out$line "
  done < "$PROTECTED_FILE"
  GATEWAY_DENY="$out"
}
gateway_denied() {
  [ -n "$GATEWAY_DENY" ] || load_gateway_deny
  case "$GATEWAY_DENY" in *" $1 "*) return 0 ;; esac
  return 1
}
# Written to a file for the same bash 3.2 reason as the probe. Modes:
#   mark <profiles dir> <name>     marked | already | refused
#   backfill <handoff> <profiles dir> <deploy root> <deny list> <refuse-all 0|1>
#                                  one BACKFILL line per name, then BACKFILL_END
write_gateway_mark() {
  cat > "$WORK/gateway_mark.py" <<'PYMARK'
import json, os, re, stat, sys

MARKER = "kinerary-managed"
NAME = re.compile(r"[a-z0-9][a-z0-9-]{1,62}")


def mark(base, name):
    """Exclusive, no-follow create of the marker in a real profile directory."""
    path = os.path.join(base, name)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return "absent"
    if not stat.S_ISDIR(st.st_mode):          # a symlink to a directory is not a directory here
        return "refused"
    try:
        dir_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        return "refused"
    try:
        try:
            existing = os.lstat(MARKER, dir_fd=dir_fd)
            return "already" if stat.S_ISREG(existing.st_mode) else "refused"
        except FileNotFoundError:
            pass
        try:
            fd = os.open(MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dir_fd)
        except OSError:
            return "refused"
        with os.fdopen(fd, "w") as handle:
            handle.write(MARKER + "\n")
        return "marked"
    finally:
        os.close(dir_fd)


def peek(base, name):
    """What is there, without writing: absent | refused (a symlink or not a
    directory, or a marker that is not a regular file) | already | none."""
    path = os.path.join(base, name)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return "absent"
    if not stat.S_ISDIR(st.st_mode):
        return "refused"
    try:
        marker = os.lstat(os.path.join(path, MARKER))
    except FileNotFoundError:
        return "none"
    return "already" if stat.S_ISREG(marker.st_mode) else "refused"


def evidenced(deploy_root):
    """Profiles some trip's companion-provenance.json names: written by the bridge
    wiring this system performs, in a directory only this system's key writes."""
    found = set()
    trips = os.path.join(deploy_root, "trips")
    try:
        entries = sorted(os.scandir(trips), key=lambda e: e.name)
    except OSError:
        return found
    for entry in entries:
        if not entry.is_dir(follow_symlinks=False):
            continue
        path = os.path.join(entry.path, "companion-provenance.json")
        try:
            st = os.lstat(path)
            if not stat.S_ISREG(st.st_mode) or st.st_size > 65536:
                continue
            data = json.load(open(path))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and isinstance(data.get("profile"), str) and NAME.fullmatch(data["profile"]):
            found.add(data["profile"])
    return found


mode = sys.argv[1]
if mode == "mark":
    print(mark(sys.argv[2], sys.argv[3]))
    raise SystemExit(0)

handoff, base, deploy_root, deny, refuse_all = sys.argv[2:7]
names = json.load(open(handoff)).get("profiles")
if not isinstance(names, list) or not all(isinstance(n, str) and NAME.fullmatch(n) for n in names):
    print("companion-install-host: refusing an unsafe backfill request", file=sys.stderr)
    raise SystemExit(2)
proof = evidenced(deploy_root)
denied = set(deny.split())
for name in names:
    if refuse_all == "1" or name in denied:
        outcome = "refused"
    elif name not in proof:
        state = peek(base, name)
        outcome = state if state in ("already", "absent") else "refused"
        if outcome == "refused":
            print(f"companion-install-host: {name} not marked: no trip's provenance record names it", file=sys.stderr)
    else:
        outcome = mark(base, name)
    print(f"BACKFILL {name} {outcome}")
print(f"BACKFILL_END {len(names)}")
PYMARK
}
mark_managed() {
  gateway_denied "$1" && return 0
  write_gateway_mark
  /usr/bin/python3 "$WORK/gateway_mark.py" mark "$HOME/.hermes/profiles" "$1" >/dev/null || true
}

if [ "$REQUEST_KIND" = "companion_gateway_status" ]; then
  write_gateway_probe
  /usr/bin/python3 "$WORK/gateway_probe.py" status "$HANDOFF" "$HOME/.hermes/profiles" || die "gateway status failed"
  exit 0
fi

# Backfill: mark profiles that exist, were installed by this system (a trip's
# provenance record names them) and are not protected. Exactly one
# `BACKFILL <name> <marked|already|refused|absent>` line per name, then
# `BACKFILL_END <n>`. A Mac refuses every name: launchd is its supervisor.
if [ "$REQUEST_KIND" = "companion_gateway_backfill" ]; then
  gateway_denied none || true     # load (and validate) the protected list before anything else
  write_gateway_mark
  refuse_all=0
  if [ "$(uname -s)" = Darwin ]; then
    refuse_all=1
    printf 'companion-install-host: backfill refused: this platform runs launchd agents and is observe-only\n' >&2
  fi
  /usr/bin/python3 "$WORK/gateway_mark.py" backfill "$HANDOFF" "$HOME/.hermes/profiles" \
    "${KINERARY_DEPLOY_ROOT:-$HOME/kinerary-deploy}" "$GATEWAY_DENY" "$refuse_all" || die "gateway backfill failed"
  exit 0
fi


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
  local profile_dir="$HOME/.hermes/profiles/$name"
  local env_file="$profile_dir/.env"

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

  # Companions write nothing on purpose (see the `skills:` block
  # config.overlay.yaml.tpl adds), but write_file/patch stay technically
  # reachable through the toolset — they are not what skill_manage's
  # write_approval gate covers (tools/skill_manager_tool.py writes via
  # atomic_write_text, a different code path). HERMES_WRITE_SAFE_ROOT scopes
  # them to a directory of this profile's own that nothing legitimate ever
  # writes into, so a prompt-injected document or a wrong inference that
  # tries to write another profile's config.yaml, or this profile's own
  # skill files, is hard-denied by Hermes itself (agent/file_safety.py)
  # rather than merely discouraged. Created here so the value in .env always
  # names a directory that exists.
  local sandbox_dir="$profile_dir/write-sandbox"
  mkdir -p "$sandbox_dir"

  # Rewritten in place, not appended: this runs again on every retry, and three
  # copies of GATEWAY_RELAY_ID with different values is a worse state than none.
  umask 077
  touch "$env_file"
  /usr/bin/python3 - "$env_file" "$relay_url" "$name" "$secret" "$sandbox_dir" <<'PY'
import base64, hashlib, hmac, sys
env_path, url, gid, secret, sandbox_dir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]


def control_token(gateway_id, key):
    # The relay's own gateway-token format (protocol.ts makeUpgradeToken):
    # base64url("<id>:<exp>:<hmac-sha256 hex of '<id>:<exp>'>"), exp 0 = no
    # expiry. companion-mcp verifies it with the relay's verifyUpgradeToken, so
    # this is the relay credential the companion already holds, in the one
    # shape a static MCP header can carry — not a new secret.
    signed = f"{gateway_id}:0"
    sig = hmac.new(key.encode(), signed.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{signed}:{sig}".encode()).decode().rstrip("=")
managed = {
    "GATEWAY_RELAY_URL": url,
    "GATEWAY_RELAY_ID": gid,
    "GATEWAY_RELAY_SECRET": secret,
    # The companion's `trip-control` MCP connection (companion-mcp.ts): the one
    # way it can rename itself so the router hears the new name.
    "COMPANION_CONTROL_TOKEN": control_token(gid, secret),
    # Confines write_file/patch to this profile's own sandbox subdirectory —
    # see the comment above this block. Only newly enrolled companions get
    # this; a profile enrolled before this line existed is not retrofitted
    # (this whole function only runs at install/repair time, never on a
    # schedule against a live profile).
    "HERMES_WRITE_SAFE_ROOT": sandbox_dir,
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
  if [ "$(uname -s)" != Darwin ]; then
    start_gateway_supervised "$name"
    return 0
  fi
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
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
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
  # WAIT FOR THE OLD ONE TO ACTUALLY BE GONE before asking whether a new one is
  # up. `bootout` returns immediately and the gateway takes ~3s to drain, so
  # "is a gateway running?" answered now describes the process being killed.
  # That false positive is not hypothetical: on 2026-09-18 this function
  # reported "started" while reading the PID of the gateway it had just
  # terminated, the fallback below never ran, and the install ended with
  # nothing running at all.
  local waited=0
  while gateway_pids "$name" >/dev/null && [ "$waited" -lt 20 ]; do
    sleep 2
    waited=$((waited + 2))
  done

  # The error is KEPT, not sent to /dev/null. Three runs on 2026-09-18 ended
  # with no gateway and nothing in any log saying why, because this command's
  # own complaint was the only evidence and it was being discarded.
  local boot_err
  boot_err="$(launchctl bootstrap "gui/$(id -u)" "$plist" 2>&1)" || true

  # LAUNCHD SAYING YES IS NOT THE GATEWAY RUNNING, and over SSH the two come
  # apart. `bootstrap` into `gui/$UID` from a forced-command session does not
  # take: the plist is written, `launchctl list` shows nothing, no launchd log
  # line is emitted, and the gateway started during the install is torn down
  # with the session. What made it invisible is that the install had already
  # printed "started" by then. So: read it back.
  if gateway_alive "$name"; then
    printf 'companion-install-host: gateway %s started (launchd)\n' "$name" >&2
    return 0
  fi

  # NO FALLBACK STARTER. There used to be a detached gateway started with the replace flag here
  # for when launchd would not take the agent from an SSH session, and it is the
  # double starter that put two processes on one profile and made Hermes warn
  # "another profile's standalone gateway owns this host" (2026-10-13). One
  # supervisor per profile: if launchd did not start it, say so, and say what to
  # run. The agent is installed (RunAtLoad), so the next login starts it too.
  printf 'companion-install-host: launchctl did not start %s (%s); it is NOT RUNNING. From your own Terminal: launchctl bootstrap gui/%s %s\n' \
    "$name" "${boot_err:-no error reported}" "$(id -u)" "$plist" >&2
}

# The gateway processes for this profile, if any. `pgrep -f` because the
# profile name only appears in the arguments.
gateway_pids() {
  pgrep -f -- "--profile $1 gateway run" 2>/dev/null
}

# Is there actually a gateway process for this profile? Waits, because a
# gateway takes a few seconds to come up and answering too early would send the
# fallback after a launchd start that was going to work.
#
# Only ever asked once the previous gateway has exited — see start_gateway —
# so a match here is a gateway that is starting, never one that is stopping.
gateway_alive() {
  local name="$1" waited=0
  while [ "$waited" -lt 12 ]; do
    if gateway_pids "$name" >/dev/null; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# Linux (the Proxmox VM, compose.vm.yml): Hermes runs in a container whose
# per-profile gateways are s6 services, and `hermes` on PATH is a wrapper that
# execs into it. There, Hermes's own lifecycle command IS the supervisor: the
# gateway outlives this SSH session, the run intent it records is what the
# container reads on the next boot (hermes_cli/container_boot.py), and
# stop-then-start is the s6 twin of bootout-then-bootstrap above — a retry
# restarts the gateway rather than starting a second copy on the same socket.
# stdin is closed explicitly: the wrapper's `docker exec -i` would otherwise
# forward whatever this script's stdin still holds.
start_gateway_supervised() {
  local name="$1"
  if ! command -v hermes >/dev/null 2>&1; then
    printf 'companion-install-host: no hermes on PATH; %s installed but NOT RUNNING\n' "$name" >&2
    return 0
  fi
  hermes -p "$name" gateway stop </dev/null >/dev/null 2>&1 || true
  if hermes -p "$name" gateway start </dev/null >/dev/null 2>&1; then
    printf 'companion-install-host: gateway %s started\n' "$name" >&2
  else
    printf 'companion-install-host: hermes gateway start failed for %s; profile installed but NOT RUNNING\n' "$name" >&2
  fi
}

# Did the RUNNING gateway pick the bridge up? Read off its own log, not assumed.
#
# mcp_tool parks a server after three failed connects ("parking until a
# reconnect is requested") and nothing ever requests one — so a gateway that
# was started before trip-mcp existed stays toolless for the life of the
# process, silently. Same discipline as interview-stack-deploy's check for the
# interviewer's `*_for_chat` tools: grep the gateway's own registration line,
# because an upstream process being alive proves nothing about what it loaded.
# CAN THE BRIDGE REACH THE TRIP, not merely "is it listening".
#
# `gateway_registered_trip_mcp` below proves the agent can see the tools. That
# is one hop of two, and on 2026-09-18 the other one was the broken one: a
# freshly provisioned trip's bridge registered 50 tools and then failed every
# single call with `connect EHOSTUNREACH` on its way to the trip's own site.
# The companion told the organizer "I can't retrieve the trip plan right now",
# politely, indefinitely. Provisioning had reported success, because nothing
# upstream had ever asked the bridge the question that mattered.
#
# /health asks it: the bridge fetches its own trip's config and says whether it
# arrived. Local to this host, so it needs no key and reveals no address.
# The commit this script is running from — "unknown" rather than empty when
# the checkout is not a git tree, so the field is always present and a missing
# answer is never mistaken for a matching one.
repo_commit() {
  git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'unknown'
}

companion_provenance() {
  local trip_dir="$1" profile="$2" out="$1/companion-provenance.json"
  printf '{"repo_root":"%s","commit":"%s","branch":"%s","profile":"%s","wired_at":"%s"}\n' \
    "$REPO_ROOT" "$(repo_commit)" \
    "$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')" \
    "$profile" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out" 2>/dev/null || true
}

# BRIDGE_HEALTH is the operator-facing sentence for the install path's stderr;
# BRIDGE_HEALTH_CODE is the one token the probe path prints. The code is the
# only part of the bridge's answer that ever crosses back to the worker, and
# only in the shape [A-Za-z0-9_]{1,40}: the body is another process's output,
# and a newline or a space in it would otherwise be a forged second verdict.
#   HTTP_<n>      the trip refused the bridge's key (HTTP_401 = key mismatch)
#   E<errno>      the bridge could not reach the trip (EHOSTUNREACH is the Mac
#                 Local Network grant, staging only — see CLAUDE.md)
#   BRIDGE_401    the bridge refused the key in its own mcp/.env
#   NO_KEY        no MCP_API_KEY beside the trip, so nothing could be asked
#   NO_HEALTH_ROUTE  the running bridge's mcp.js predates /health (#127), so it
#                 cannot be verified either way — NOT evidence that it is broken
#   none          no answer at all: the bridge is not running
#   UNRECOGNIZED  an answer, but not one of the above
bridge_health_code() {
  local body="$1" code=""
  if [ -z "$body" ]; then printf 'none'; return 0; fi
  code=$(printf '%s\n' "$body" \
           | sed -n 's/^{.*"code":"\([A-Za-z0-9_]\{1,40\}\)"[,}].*$/\1/p' | head -1)
  if [ -n "$code" ] && [ "$(printf '%s\n' "$body" | wc -l | tr -d ' ')" = 1 ]; then
    printf '%s' "$code"; return 0
  fi
  case "$body" in
    '{"error":"unauthorized"}') printf 'BRIDGE_401' ;;
    *'Cannot GET /health'*) printf 'NO_HEALTH_ROUTE' ;;
    *) printf 'UNRECOGNIZED' ;;
  esac
}

bridge_reaches_trip() {
  local port="$1" trip_dir="$2" key="" body=""
  BRIDGE_HEALTH_CODE=""
  # /health is behind the MCP key like every other route on that server. We are
  # on the host, beside the trip's own mcp/.env, so the key is simply here —
  # which is why the endpoint never needed an exemption in the first place.
  key=$(sed -n 's/^MCP_API_KEY=//p' "$trip_dir/mcp/.env" 2>/dev/null | head -1 | tr -d '"\r')
  if [ -z "$key" ]; then
    BRIDGE_HEALTH="no MCP_API_KEY in $trip_dir/mcp/.env"
    BRIDGE_HEALTH_CODE="NO_KEY"
    return 1
  fi
  # `--config -` so the key arrives on stdin and never on the command line,
  # where `ps` would show it to every user on the box. Same reason the release
  # notifier feeds curl its token this way.
  #
  # Deliberately not `curl -f`: a 503 here carries the verdict we want to read
  # back to the operator, and -f would throw the body away with it.
  body=$(printf 'url = "http://127.0.0.1:%s/health"\nheader = "X-API-Key: %s"\nsilent\nshow-error\nmax-time = 15\n' \
           "$port" "$key" | curl --config - 2>/dev/null || true)
  case "$body" in
    *'"ok":true'*) return 0 ;;
  esac
  BRIDGE_HEALTH="${body:-no answer from the bridge}"
  BRIDGE_HEALTH_CODE="$(bridge_health_code "$body")"
  return 1
}

gateway_registered_trip_mcp() {
  local name="$1" from_line="$2" waited=0
  local log="$HOME/.hermes/profiles/$name/logs/agent.log"
  while [ "$waited" -lt 60 ]; do
    if [ -f "$log" ] && tail -n "+$from_line" "$log" 2>/dev/null \
         | grep -q "MCP server 'trip-mcp'.*registered [1-9][0-9]* tool"; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

# ── The SHARED trip-mcp bridge (docs/specs/sprint-9/x-wildcard-host-and-shared-bridge.md, B2) ──
#
# One `mcp.js` process (MCP_ROUTES_DIR set) serves every trip. Wiring a companion
# to it starts no process and allocates no port: it writes ONE route file into
# the directory that process reads (the trip's site address and agent key, and
# only the HASH of the companion's token) and ONE `mcp_servers.trip-mcp` entry
# into the profile, whose header names the token rather than holding it.
#
# WHETHER THIS HOST DOES THAT IS THIS HOST'S DECISION, never the request's: it is
# on only when this script's own environment sets BOTH variables below. A request
# can name a slug and a profile; it cannot name a mode, a directory or a URL. Set
# the variables for the forced command in authorized_keys the same way
# KINERARY_DEPLOY_ROOT is.
#
#   KINERARY_SHARED_BRIDGE_ROUTES_DIR  an absolute path to an existing directory
#                                      (not a symlink) the shared bridge reads
#   KINERARY_SHARED_BRIDGE_URL         http://127.0.0.1:<port> or http://localhost:<port>
#
# Loopback only, and that is a security rule rather than a convenience: the
# companion's token and every health probe travel on this URL in the clear, so it
# must never be a hop on a network. A shared bridge on another machine needs a
# transport this script does not pretend to have.
#
# One variable without the other is NOT shared mode and is said so, loudly: an
# unset flag that quietly downgrades a path is this repository's recurring bug
# class. A bad value for both is a refusal, never a fallback to per-trip wiring.
SHARED_BRIDGE_STATE=""     # "" = not decided yet, then "on" or "off"
SHARED_ROUTES_DIR=""
SHARED_URL=""

shared_bridge_decide() {
  local dir="${KINERARY_SHARED_BRIDGE_ROUTES_DIR:-}" url="${KINERARY_SHARED_BRIDGE_URL:-}" re port
  SHARED_BRIDGE_STATE=off
  [ -n "$dir" ] || [ -n "$url" ] || return 0
  if [ -z "$dir" ] || [ -z "$url" ]; then
    printf 'companion-install-host: only one of KINERARY_SHARED_BRIDGE_ROUTES_DIR and KINERARY_SHARED_BRIDGE_URL is set; shared mode is OFF and companions are wired per trip\n' >&2
    return 0
  fi
  case "$dir" in
    /*) ;;
    *) die "KINERARY_SHARED_BRIDGE_ROUTES_DIR is not an absolute path" ;;
  esac
  # The directory becomes a path argument and a log fragment: ASCII path
  # characters and the space a macOS home directory may hold, nothing a line
  # break or a quote could use.
  case "$dir" in
    *[!A-Za-z0-9._/' '-]*) die "KINERARY_SHARED_BRIDGE_ROUTES_DIR holds a character a path here may not" ;;
  esac
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then
    die "KINERARY_SHARED_BRIDGE_ROUTES_DIR is not an existing directory, or is a symlink"
  fi
  [ -w "$dir" ] || die "KINERARY_SHARED_BRIDGE_ROUTES_DIR is not writable by this user"
  # The pattern lives in a variable: bash 3.2 (the macOS /bin/bash) treats a quoted
  # right-hand side of =~ as a literal string.
  re='^http://(127\.0\.0\.1|localhost):([0-9]{1,5})$'
  if ! [[ "$url" =~ $re ]]; then
    die "KINERARY_SHARED_BRIDGE_URL must be http://127.0.0.1:<port> or http://localhost:<port> (loopback only: the token travels on it in the clear)"
  fi
  port="${BASH_REMATCH[2]}"
  if [ "$((10#$port))" -lt 1 ] || [ "$((10#$port))" -gt 65535 ]; then
    die "KINERARY_SHARED_BRIDGE_URL has a port outside 1-65535"
  fi
  SHARED_ROUTES_DIR="$dir"
  SHARED_URL="$url"
  SHARED_BRIDGE_STATE=on
}

# Call at top level (`if shared_bridge_on; then`), never inside $( ): a die in a
# command substitution would end only the substitution.
shared_bridge_on() {
  [ -n "$SHARED_BRIDGE_STATE" ] || shared_bridge_decide
  [ "$SHARED_BRIDGE_STATE" = on ]
}

# The shared bridge's own "is the process up" question. No key: /ready is the
# route that exists so a supervisor holding no token can ask it.
shared_bridge_ready() {
  local body
  body="$(curl -sS --max-time 5 "$SHARED_URL/ready" 2>/dev/null || true)"
  case "$body" in
    *'"ok":true'*) return 0 ;;
  esac
  return 1
}

# The companion's token, from ITS profile's .env, if there and well formed; empty
# otherwise. Well formed matters beyond tidiness: the value is placed inside a
# curl config file, where a quote would end the string it sits in.
shared_profile_token() {
  local t
  t="$(sed -n 's/^TRIP_MCP_TOKEN=//p' "$HOME/.hermes/profiles/$PROFILE_NAME/.env" 2>/dev/null | head -1 | tr -d "\"'\\r" || true)"
  case "$t" in
    ''|*[!A-Za-z0-9._~+/=-]*) return 0 ;;
  esac
  if [ "${#t}" -ge 16 ] && [ "${#t}" -le 256 ]; then printf '%s' "$t"; fi
  return 0
}

# CAN THE SHARED BRIDGE REACH THIS TRIP, asked with THIS trip's token. Sets
# BRIDGE_HEALTH / BRIDGE_HEALTH_CODE like bridge_reaches_trip does, so the install
# path and the probe read one vocabulary, plus two codes of its own:
#   NO_ROUTE   there is no route file for the trip in the bridge's directory
#   NO_KEY     the profile holds no (well-formed) TRIP_MCP_TOKEN to ask with
# BRIDGE_401 here means the bridge does not know the token: the route file is not
# the one it is reading, or has not been picked up yet (it rescans once a second).
shared_bridge_health() {
  local token body
  BRIDGE_HEALTH_CODE=""
  if [ ! -f "$SHARED_ROUTES_DIR/$TRIP_SLUG.json" ]; then
    BRIDGE_HEALTH="no route file for $TRIP_SLUG"
    BRIDGE_HEALTH_CODE="NO_ROUTE"
    return 1
  fi
  token="$(shared_profile_token)"
  if [ -z "$token" ]; then
    BRIDGE_HEALTH="no TRIP_MCP_TOKEN in the profile for $TRIP_SLUG"
    BRIDGE_HEALTH_CODE="NO_KEY"
    return 1
  fi
  # `--config -`: the token arrives on stdin and never on a command line.
  body="$(printf 'url = "%s/health"\nheader = "X-API-Key: %s"\nsilent\nshow-error\nmax-time = 15\n' \
            "$SHARED_URL" "$token" | curl --config - 2>/dev/null || true)"
  case "$body" in
    *'"ok":true'*) return 0 ;;
  esac
  BRIDGE_HEALTH="${body:-no answer from the shared bridge}"
  BRIDGE_HEALTH_CODE="$(bridge_health_code "$body")"
  return 1
}

# The trip's agent key, into $WORK/trip-key (a file in the 0700 temp dir, so it
# is never a command-line argument and never printed). A deployment hook first:
# it lives in the deployment's own repository, outside this one, because where
# trip keys are kept is that deployment's business. A hook that exists and fails
# is a failure, NOT a reason to fall back to whatever an old mcp/.env still holds:
# that is how a rotated key silently stays the old one. Without the hook, the
# trip's own mcp/.env (TRIP_API_KEY, then MCP_API_KEY).
shared_trip_key_file() {
  local hook="$DEPLOY_ROOT/trip-agent-key.sh" envf="$TRIP_DIR/mcp/.env" name k=""
  if [ -f "$hook" ] && [ -x "$hook" ]; then
    # At most 4 KiB: the validator below refuses anything long, and a runaway hook
    # must not fill the disk through the forced command.
    "$hook" "$TRIP_SLUG" < /dev/null 2>/dev/null | head -c 4097 > "$WORK/trip-key" \
      || die "trip-agent-key.sh failed for $TRIP_SLUG"
    return 0
  fi
  for name in TRIP_API_KEY MCP_API_KEY; do
    k="$(sed -n "s/^${name}=//p" "$envf" 2>/dev/null | head -1 | tr -d "\"'\\r" || true)"
    [ -z "$k" ] || break
  done
  [ -n "$k" ] || die "no agent key for $TRIP_SLUG: there is no executable trip-agent-key.sh in $DEPLOY_ROOT, and no TRIP_API_KEY or MCP_API_KEY in $envf"
  printf '%s\n' "$k" > "$WORK/trip-key"
}

# Written to a file for the same macOS bash 3.2 reason as the topology reader.
# Every value that matters arrives as a FILE or an argument that is not a secret:
# the key from $WORK/trip-key, the token from (and into) the profile's .env.
write_shared_wire_script() {
  cat > "$WORK/shared_wire.py" <<'PYWIRE'
import hashlib, json, os, re, secrets, sys, tempfile
import yaml

KEY_RE = re.compile(r"[A-Za-z0-9._~+/=-]{16,256}")
routes_dir, slug, api_base, keyfile, profile_dir, bridge_url = sys.argv[1:7]


def fail(message):
    print("companion-install-host: " + message, file=sys.stderr)
    raise SystemExit(2)


def atomic_write(path, text, mode):
    """Temp file in the SAME directory (so the rename cannot cross a filesystem),
    created 0600 and exclusively, then renamed over the target."""
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(path) + ".", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# 1. The trip's agent key: one line, in the allowed alphabet, and nothing else.
raw = open(keyfile, "rb").read()
try:
    text = raw.decode("ascii")
except UnicodeDecodeError:
    fail("the agent key is not plain ASCII")
if text.endswith("\n"):
    text = text[:-1]
if "\n" in text or "\r" in text:
    fail("the agent key is not a single line")
if not KEY_RE.fullmatch(text):
    fail("the agent key is not 16-256 characters of [A-Za-z0-9._~+/=-]")
trip_key = text

# 2. The companion's token: the one its profile already holds, else a new one.
env_path = os.path.join(profile_dir, ".env")
if os.path.islink(env_path):
    fail("the profile's .env is a symlink")
token = None
env_text = ""
if os.path.exists(env_path):
    env_text = open(env_path, encoding="utf-8", errors="replace").read()
    for line in env_text.splitlines():
        if line.startswith("TRIP_MCP_TOKEN="):
            token = line.split("=", 1)[1].strip().strip("\"'")
            break
if token is not None and not KEY_RE.fullmatch(token):
    fail("TRIP_MCP_TOKEN in the profile's .env is malformed; remove that line to have a new token made")
if token is None:
    token = secrets.token_hex(32)
    lead = "\n" if env_text and not env_text.endswith("\n") else ""
    fd = os.open(env_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a") as fh:
        fh.write(f"{lead}TRIP_MCP_TOKEN={token}\n")
    os.chmod(env_path, 0o600)

# 3. The route file: only the hash of the token, mode 0600, replaced atomically.
if os.path.islink(routes_dir) or not os.path.isdir(routes_dir):
    fail("the routes directory is not a real directory")
route = {
    "schema_version": 1,
    "trip": slug,
    "api_base_url": api_base,
    "trip_api_key": trip_key,
    "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
}
atomic_write(os.path.join(routes_dir, slug + ".json"), json.dumps(route) + "\n", 0o600)

# 4. The profile's trip-mcp entry, replacing any earlier one and touching nothing
# else. The header holds the NAME of the token, which Hermes reads from the
# profile's .env; the token itself is not written here.
cfg_path = os.path.join(profile_dir, "config.yaml")
if os.path.islink(cfg_path):
    fail("the profile's config.yaml is a symlink")
try:
    cfg = yaml.safe_load(open(cfg_path)) or {}
    mode = os.stat(cfg_path).st_mode & 0o777
except FileNotFoundError:
    cfg, mode = {}, 0o600
if not isinstance(cfg, dict):
    fail("the profile's config.yaml is not a mapping")
servers = cfg.get("mcp_servers")
if servers is None:
    servers = {}
if not isinstance(servers, dict):
    fail("mcp_servers in the profile's config.yaml is not a mapping")
servers["trip-mcp"] = {
    "transport": "sse",
    "url": bridge_url + "/sse",
    "headers": {"X-API-Key": "${TRIP_MCP_TOKEN}"},
}
cfg["mcp_servers"] = servers
atomic_write(cfg_path, yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True), mode)
PYWIRE
}

# What every successful wiring ends with, per trip or shared: the provenance
# record and the WIRED line the worker parses.
#
# WHICH CHECKOUT BUILT THIS COMPANION. The forced command in authorized_keys
# decides that, and on 2026-09-20 it named a feature branch 12 commits behind —
# so a run reported on two branches at once and nothing anywhere said so. Printed
# on the WIRED line because that is what the worker already reads, and written
# beside the trip because a log line ages out.
# The provenance record is the evidence the backfill trusts to mark a profile as
# this system's, so it is written only for a profile that already carries the
# marker (a fresh install writes the marker first). A bridge request naming
# somebody's own, unmarked profile must not be able to mint that evidence.
finish_wired() {
  if [ -f "$HOME/.hermes/profiles/$PROFILE_NAME/$GATEWAY_MARKER" ] \
       && [ ! -L "$HOME/.hermes/profiles/$PROFILE_NAME/$GATEWAY_MARKER" ] \
       && [ ! -L "$HOME/.hermes/profiles/$PROFILE_NAME" ] && ! gateway_denied "$PROFILE_NAME"; then
    companion_provenance "$TRIP_DIR" "$PROFILE_NAME"
  else
    printf 'companion-install-host: provenance not recorded: %s carries no provenance marker\n' "$PROFILE_NAME" >&2
  fi
  printf 'WIRED %s %s\n' "$PROFILE_NAME" "$(repo_commit)"
  exit 0
}

# Wire one companion to the shared bridge (read_trip_wiring has already run).
# Order: ask whether the bridge is up BEFORE writing anything; write the route and
# the profile entry; wait until the bridge has picked the route up BEFORE the
# gateway is started (a gateway refused three times parks its trip-mcp for life,
# and the bridge rescans only once a second); restart the gateway; wait for it to
# register the tools; then ask the bridge, with the trip's own token, whether it
# can reach the trip.
wire_shared_bridge() {
  local py api profile_dir limit waited=0
  api="http://$SITE_IP:$SITE_PORT"
  profile_dir="$HOME/.hermes/profiles/$PROFILE_NAME"
  py="$(find_yaml_python)" || die "no python with PyYAML to write $PROFILE_NAME's trip-mcp entry"
  shared_bridge_ready || die "the shared bridge is not answering /ready at $SHARED_URL; nothing was written"
  shared_trip_key_file
  write_shared_wire_script
  "$py" "$WORK/shared_wire.py" "$SHARED_ROUTES_DIR" "$TRIP_SLUG" "$api" "$WORK/trip-key" "$profile_dir" "$SHARED_URL" \
    || die "could not write the shared-bridge route and profile entry for $TRIP_SLUG"
  rm -f "$WORK/trip-key"

  limit="${KINERARY_SHARED_BRIDGE_ROUTE_WAIT_SECONDS:-10}"
  case "$limit" in ''|*[!0-9]*) limit=10 ;; esac
  while :; do
    shared_bridge_health && break
    [ "$BRIDGE_HEALTH_CODE" = BRIDGE_401 ] || break   # any other answer means the bridge knows the token
    [ "$waited" -lt "$limit" ] || die "the shared bridge does not accept the route written for $TRIP_SLUG after ${limit}s: is it reading the directory KINERARY_SHARED_BRIDGE_ROUTES_DIR names?"
    sleep 1
    waited=$((waited + 1))
  done

  GATEWAY_LOG="$HOME/.hermes/profiles/$PROFILE_NAME/logs/agent.log"
  LOG_FROM=$(( $(wc -l < "$GATEWAY_LOG" 2>/dev/null || echo 0) + 1 ))
  start_gateway "$PROFILE_NAME"
  if gateway_registered_trip_mcp "$PROFILE_NAME" "$LOG_FROM"; then
    # BOTH HOPS, as for a per-trip bridge: the agent can see the tools; now prove
    # the tools can see the trip.
    if ! shared_bridge_health; then
      printf 'companion-install-host: the shared trip-mcp bridge cannot reach %s — /health said: %s\n' \
        "$TRIP_SLUG" "$BRIDGE_HEALTH" >&2
      die "trip-mcp (shared bridge) wired for $TRIP_SLUG but it cannot reach the trip site"
    fi
    finish_wired
  fi
  printf 'companion-install-host: %s gateway registered no trip-mcp tools after restart\n' "$PROFILE_NAME" >&2
  tail -5 "$GATEWAY_LOG" >&2 2>/dev/null || true
  die "trip-mcp wired for $TRIP_SLUG but $PROFILE_NAME's gateway did not register its tools"
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
#
# Shared by the bridge request and the bridge probe, so the two kinds cannot
# drift in what they accept or where they look. Sets TRIP_DIR, VMID, SITE_IP,
# SITE_PORT, MCP_PORT; dies (exit 2) on anything it cannot vouch for.
read_trip_wiring() {
  DEPLOY_ROOT="${KINERARY_DEPLOY_ROOT:-$HOME/kinerary-deploy}"
  TRIP_DIR="$DEPLOY_ROOT/trips/$TRIP_SLUG"
  [ -f "$TRIP_DIR/topology.yaml" ] || die "no topology for $TRIP_SLUG on this host"
  [ -d "$HOME/.hermes/profiles/$PROFILE_NAME" ] || die "no companion profile $PROFILE_NAME on this host"
  local py
  py="$(find_yaml_python)" || die "no python with PyYAML to read the topology"
  # Into a file, not "$( ... <<HEREDOC )": macOS /bin/bash 3.2 — which is what
  # sshd runs a forced command with — mis-parses quotes inside a here-document
  # inside a command substitution, and one apostrophe in a comment made this
  # whole script unparseable.
  # Whether this host runs the SHARED bridge is its own decision (the two
  # KINERARY_SHARED_BRIDGE_* variables), taken before anything of the request is
  # trusted, and called here at top level, not in a command substitution, so a
  # bad value dies the script instead of a subshell.
  local mode=per_trip
  if shared_bridge_on; then mode=shared; fi
  "$py" - "$TRIP_DIR/topology.yaml" "$TRIP_SLUG" "$mode" > "$WORK/wiring" <<'PYTOPO' || die "could not read $TRIP_SLUG's topology"
import re, sys, yaml
topo = yaml.safe_load(open(sys.argv[1])) or {}
slug = sys.argv[2]
shared = sys.argv[3] == "shared"
lxc = ((topo.get("proxmox") or {}).get("lxc") or {})
if topo.get("name") != slug or lxc.get("name") != f"trip-{slug}":
    print(f"topology does not describe {slug}", file=sys.stderr); raise SystemExit(2)
vmid = str((topo.get("proxmox") or {}).get("vmid") or "")
ipv4 = str(lxc.get("ipv4") or "")
fport = str((topo.get("npm") or {}).get("forward_port") or "")
if shared:
    # A wildcard-routed trip has no npm section: the site port is the LXC's own,
    # with the npm one as the fallback for a topology written before that.
    fport = str(lxc.get("forward_port") or "") or fport
# EVERY VALUE IS CHECKED AGAINST AN ASCII PATTERN before it is printed. These
# travel tab-separated, and the fourth field is the port the bridge's KEY is
# sent to: an address carrying a tab once shifted the fields so the trip
# site's own port became the "MCP port". `isdigit()`/`int()` are not enough
# either — both accept non-ASCII digits. `[0-9]` is ASCII only; fullmatch,
# because `$` would allow a trailing newline. The values are never echoed.
OCTET = r"(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])"
ok = (
    re.fullmatch(rf"{OCTET}(\.{OCTET}){{3}}(/[0-9]{{1,2}})?", ipv4) is not None
    and re.fullmatch(r"[0-9]{1,5}", fport) is not None and 1 <= int(fport) <= 65535
)
if shared:
    # No bridge port is derived: one process serves every trip, so the
    # 3000 + vmid window (and the vmid it needs) does not apply.
    if not ok:
        print(f"topology for {slug} lacks a usable ip/port", file=sys.stderr); raise SystemExit(2)
    print(f"\t{ipv4.split('/')[0]}\t{fport}\t")
    raise SystemExit(0)
ok = (
    ok
    and re.fullmatch(r"[0-9]{1,4}", vmid) is not None
    # The port rule is mcp_bridge.mcp_port_for_vmid's: 3000 + vmid, inside
    # 3100-3999, clear of the hand-provisioned bridges below 3100.
    and 3100 <= 3000 + int(vmid) <= 3999
)
if not ok:
    print(f"topology for {slug} lacks a usable vmid/ip/port", file=sys.stderr); raise SystemExit(2)
print(f"{vmid}\t{ipv4.split('/')[0]}\t{fport}\t{3000 + int(vmid)}")
PYTOPO
  local wiring
  wiring="$(cat "$WORK/wiring")"
  VMID="$(printf '%s' "$wiring" | cut -f1)"; SITE_IP="$(printf '%s' "$wiring" | cut -f2)"
  SITE_PORT="$(printf '%s' "$wiring" | cut -f3)"; MCP_PORT="$(printf '%s' "$wiring" | cut -f4)"
  # Belt and braces on the one value the key follows: exactly four ASCII
  # digits, spelled out rather than [0-9], which some locales widen. Not asked
  # of the shared bridge, which has no per-trip port (MCP_PORT is empty there).
  if [ "$mode" = per_trip ]; then
    case "$MCP_PORT" in
      [0123456789][0123456789][0123456789][0123456789]) ;;
      *) die "topology for $TRIP_SLUG gave no usable bridge port" ;;
    esac
  fi
}

# ── The bridge probe: is an already-wired bridge still reaching its trip? ─────
#
# Issue #119. /health used to be asked exactly once, at install, and a bridge
# whose key was replaced afterwards — or whose host lost its route to the trip —
# then failed every call for good while its companion answered politely that it
# could not read the plan. The provisioner worker asks this on its idle poll
# loop and records the answer as the trip's reachability.
#
# READ-ONLY, deliberately. It runs no setup-mcp.sh, restarts no bridge and no
# gateway, writes nothing outside its own temp dir: repair is an operator's
# decision (hard rule 2), and
# an automatic re-wire would re-read whatever key is on disk, which is exactly
# the thing that may be wrong. The key is read here, beside the trip, and sent
# to the bridge on curl's stdin; it is never printed, and the worker never
# sees it. Stdout is EXACTLY one line, `HEALTH ok` or `HEALTH fail <code>`
# (codes: bridge_health_code). A refusal is exit 2 with no HEALTH line, so the
# worker can tell "the bridge failed" from "the question could not be asked".
# ── Gateway action: start or stop ONE companion's gateway ────────────────────
#
# Issue #349. The control plane's reconciler asks; this host decides whether it
# may. It answers EXACTLY one line, `ACTION <name> <start|stop> <ok|refused|failed>`,
# with the reason on stderr (prefixed, bounded): `refused` is a rule, `failed` is
# the host trying and not getting there, and neither is ever dressed as `ok`.
#
# What this host refuses, whatever it is asked:
#   - any profile on the deny list, and any profile without the provenance marker
#     (a profile this system did not install may belong to somebody's own bot);
#   - to stop the interviewer (`trip-intake`): it is always up;
#   - anything on a Mac. A Mac runs one launchd agent per profile, and launchd
#     (KeepAlive) is that platform's supervisor: this verb must not become a
#     second starter. The Mac stays observe-only.
#
# It never restarts. A start of a gateway that is already up is `ok`, a stop of
# one that is down is `ok`, and either way nothing is touched: the old install
# path's stop-then-start is exactly the double-starter this work removes.
#
# Waits are bounded and the bound is this host's own (KINERARY_GATEWAY_WAIT_SECONDS,
# default 45), never the request's.
gateway_note() { printf 'companion-install-host: %s\n' "$1" >&2; }
gateway_result() {  # name verb outcome reason
  gateway_note "$1 $2: $3 ($4)"
  printf 'ACTION %s %s %s\n' "$1" "$2" "$3"
}
run_bounded() {  # seconds command... — returns 124 when it had to be killed
  local limit="$1" pid waited=0
  shift
  "$@" >/dev/null 2>&1 </dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}
gateway_count() {
  /usr/bin/python3 "$WORK/gateway_probe.py" count "$1" || die "could not read the gateway state of $1"
}
# Wait (bounded) for the gateway count to satisfy `want`: up or down.
gateway_wait_for() {  # name up|down
  local name="$1" want="$2" waited=0 limit="${KINERARY_GATEWAY_WAIT_SECONDS:-45}" n
  case "$limit" in ''|*[!0-9]*) limit=45 ;; esac
  while :; do
    n="$(gateway_count "$name")"
    if [ "$want" = up ] && [ "$n" -ge 1 ]; then return 0; fi
    if [ "$want" = down ] && [ "$n" -eq 0 ]; then return 0; fi
    [ "$waited" -ge "$limit" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
}

# Q8: a gateway started before its trip-mcp bridge is up parks the bridge after
# three failed connects and stays toolless for the life of the process, so a DEAD
# bridge is brought back first. Only the trip's own bridge, only for a trip that
# has one configured, and only when it is not answering at all (or predates
# /health); a bridge that answers but cannot reach the trip is the probe's to
# report, not a reason to withhold the companion. Returns 1 if it could not be
# brought back: starting the gateway would only repeat the silent failure.
revive_bridge_before_start() {  # slug
  local slug="$1" root="${KINERARY_DEPLOY_ROOT:-$HOME/kinerary-deploy}" shared=0
  [ -n "$slug" ] || return 0
  # Shared mode (AC-B2.5): there is no per-trip bridge to bring back, so this
  # starts and restarts NOTHING. A trip "has a bridge" when it has a route file in
  # the shared bridge's directory; one without just starts, as a per-trip trip with
  # no mcp/.env does.
  if shared_bridge_on; then
    shared=1
    [ -f "$root/trips/$slug/topology.yaml" ] && [ -f "$SHARED_ROUTES_DIR/$slug.json" ] || return 0
  else
    [ -f "$root/trips/$slug/topology.yaml" ] && [ -f "$root/trips/$slug/mcp/.env" ] || return 0
  fi
  # The slug came from the caller: it must be THIS profile's trip before anything
  # of that trip is touched. The provenance record the bridge wiring writes names
  # the profile; a trip that does not, or is reached through a symlink, is refused.
  if [ -L "$root/trips/$slug" ] || [ -L "$root/trips/$slug/companion-provenance.json" ] \
       || ! grep -Fq "\"profile\":\"$PROFILE_NAME\"" "$root/trips/$slug/companion-provenance.json" 2>/dev/null; then
    gateway_note "trip $slug has no provenance record naming $PROFILE_NAME"
    return 2
  fi
  if [ "$shared" -eq 1 ]; then
    # A gateway started while the shared bridge is down is refused three times and
    # parks its trip-mcp for the life of the process, so the start waits on the
    # bridge rather than racing it. Whether it can reach this trip is the probe's
    # to report, exactly as for a per-trip bridge that answers.
    shared_bridge_ready && return 0
    gateway_note "the shared bridge is not answering /ready; not starting $PROFILE_NAME's gateway without it"
    return 1
  fi
  TRIP_SLUG="$slug"
  read_trip_wiring
  bridge_reaches_trip "$MCP_PORT" "$TRIP_DIR" && return 0
  case "$BRIDGE_HEALTH_CODE" in
    none|NO_HEALTH_ROUTE) ;;
    *) gateway_note "trip-mcp for $slug answers but cannot reach its trip ($BRIDGE_HEALTH_CODE); starting the gateway anyway"
       return 0 ;;
  esac
  [ -x "$DEPLOY_ROOT/setup-mcp.sh" ] || { gateway_note "no setup-mcp.sh to restart the bridge for $slug"; return 1; }
  gateway_note "trip-mcp for $slug is not answering; restarting it before the gateway"
  if ! REPO_ROOT="$REPO_ROOT" KINERARY_DEPLOY_ROOT="$DEPLOY_ROOT" "$DEPLOY_ROOT/setup-mcp.sh" \
         --restart-only --trip-dir "$TRIP_DIR" < /dev/null > "$WORK/restart-mcp.log" 2>&1; then
    tail -5 "$WORK/restart-mcp.log" >&2
    return 1
  fi
  bridge_reaches_trip "$MCP_PORT" "$TRIP_DIR" && return 0
  case "$BRIDGE_HEALTH_CODE" in
    none|NO_HEALTH_ROUTE) return 1 ;;
  esac
  return 0
}

if [ "$REQUEST_KIND" = "companion_gateway_action" ]; then
  write_gateway_probe
  verb="$GATEWAY_ACTION"
  name="$PROFILE_NAME"
  home="$HOME/.hermes/profiles/$name"
  if [ "$(uname -s)" = Darwin ]; then
    gateway_result "$name" "$verb" refused "this platform runs launchd agents and is observe-only"; exit 0
  fi
  if gateway_denied "$name"; then
    gateway_result "$name" "$verb" refused "not a profile this system manages"; exit 0
  fi
  if [ "$verb" = stop ] && [ "$name" = trip-intake ]; then
    gateway_result "$name" "$verb" refused "the interviewer is never stopped"; exit 0
  fi
  [ -L "$home" ] && { gateway_result "$name" "$verb" refused "its profile directory is a symlink"; exit 0; }
  [ -d "$home" ] || { gateway_result "$name" "$verb" refused "no such profile on this host"; exit 0; }
  if [ -L "$home/$GATEWAY_MARKER" ] || [ ! -f "$home/$GATEWAY_MARKER" ]; then
    gateway_result "$name" "$verb" refused "no provenance marker; run the backfill for it"; exit 0
  fi
  limit="${KINERARY_GATEWAY_WAIT_SECONDS:-45}"
  case "$limit" in ''|*[!0-9]*) limit=45 ;; esac
  now_running="$(gateway_count "$name")"
  if [ "$verb" = start ]; then
    if [ "$now_running" -ge 1 ]; then gateway_result "$name" start ok "already running"; exit 0; fi
    revive_bridge_before_start "$TRIP_SLUG" && bridge_status=0 || bridge_status=$?
    if [ "$bridge_status" -eq 2 ]; then
      gateway_result "$name" start refused "that trip's provenance record does not name this profile"; exit 0
    elif [ "$bridge_status" -ne 0 ]; then
      if shared_bridge_on; then
        gateway_result "$name" start failed "the shared trip-mcp bridge is down"; exit 0
      fi
      gateway_result "$name" start failed "its trip-mcp bridge is down and could not be restarted"; exit 0
    fi
    run_bounded "$limit" hermes -p "$name" gateway start || true
    if gateway_wait_for "$name" up; then gateway_result "$name" start ok "gateway is running"
    else gateway_result "$name" start failed "no gateway appeared within ${limit}s"; fi
  else
    # ALWAYS a real `hermes gateway stop`, even when the process table shows
    # nothing: it is idempotent, it also writes Hermes's own desired state (so a
    # boot does not bring the gateway back), and if this host mis-reads a
    # gateway's command line a running one is still stopped instead of being
    # reported "already stopped". It never restarts anything.
    run_bounded "$limit" hermes -p "$name" gateway stop || true
    if gateway_wait_for "$name" down; then gateway_result "$name" stop ok "gateway is stopped"
    else gateway_result "$name" stop failed "the gateway was still running after ${limit}s"; fi
  fi
  exit 0
fi

if [ "$REQUEST_KIND" = "trip_mcp_bridge_probe" ]; then
  read_trip_wiring
  if shared_bridge_on; then
    # Asked of the shared bridge with THIS trip's token, still one line. It never
    # asks /ready (that is the process, not the trip) and never needs the agent key.
    if shared_bridge_health; then
      printf 'HEALTH ok\n'
    else
      printf 'HEALTH fail %s\n' "${BRIDGE_HEALTH_CODE:-UNRECOGNIZED}"
    fi
    exit 0
  fi
  if bridge_reaches_trip "$MCP_PORT" "$TRIP_DIR"; then
    printf 'HEALTH ok\n'
  else
    printf 'HEALTH fail %s\n' "${BRIDGE_HEALTH_CODE:-UNRECOGNIZED}"
  fi
  exit 0
fi

if [ "$REQUEST_KIND" = "trip_mcp_bridge_request" ]; then
  read_trip_wiring
  if shared_bridge_on; then
    wire_shared_bridge
  fi
  [ -x "$DEPLOY_ROOT/setup-mcp.sh" ] || die "no setup-mcp.sh in $DEPLOY_ROOT"
  # REPO_ROOT: the bridge runs this checkout's mcp.js, the same checkout whose
  # templates rendered the companion. stdin from /dev/null so the backgrounded
  # bridge does not hold this SSH session open after the script returns.
  # Where the gateway's log stands BEFORE the restart, so the check below reads
  # this connection attempt rather than an older one.
  GATEWAY_LOG="$HOME/.hermes/profiles/$PROFILE_NAME/logs/agent.log"
  LOG_FROM=$(( $(wc -l < "$GATEWAY_LOG" 2>/dev/null || echo 0) + 1 ))

  if REPO_ROOT="$REPO_ROOT" "$DEPLOY_ROOT/setup-mcp.sh" "$PROFILE_NAME" "http://$SITE_IP:$SITE_PORT" \
       --vmid "$VMID" --trip-dir "$TRIP_DIR" --port "$MCP_PORT" < /dev/null > "$WORK/setup-mcp.log" 2>&1; then
    # RESTART, because the gateway is already running by now and read its
    # config before this entry existed.
    #
    # The provisioner installs the companion (which starts its gateway) and
    # THEN wires the bridge, so the gateway's first trip-mcp attempt is always
    # too early: either the entry is absent, or it is there without the
    # `transport: sse` that setup-mcp.sh patches in afterwards. On the wrong
    # transport mcp_tool POSTs to the URL, mcp.js serves SSE only (GET /sse +
    # POST /messages), the POST 404s, and after three of those the server is
    # PARKED for the life of the process.
    #
    # Live on 2026-09-12, `japan2026`: POST /sse 404 ×3 at 14:11:23-30 →
    # parked; the very next handshake at 14:11:32, made by setup-mcp.sh's own
    # `hermes mcp test`, succeeded. The test passing is exactly why nobody
    # noticed — the bridge was fine, the gateway just never reconnected. The
    # family's companion answered questions about their trip with no trip
    # tools at all, and tried to shell out to reach them.
    start_gateway "$PROFILE_NAME"
    if gateway_registered_trip_mcp "$PROFILE_NAME" "$LOG_FROM"; then
      # BOTH HOPS, before anyone is handed a companion. The agent can see the
      # tools; now prove the tools can see the trip. Same stance as the check
      # above — a failure here is reported as a failure, not as a WIRED with an
      # asterisk, because a companion that cannot read its own trip is the one
      # state that looks healthy from every other angle.
      if ! bridge_reaches_trip "$MCP_PORT" "$TRIP_DIR"; then
        printf 'companion-install-host: trip-mcp on :%s cannot reach %s — /health said: %s\n' \
          "$MCP_PORT" "$TRIP_SLUG" "$BRIDGE_HEALTH" >&2
        die "trip-mcp wired for $TRIP_SLUG but it cannot reach the trip site"
      fi
      # Provenance record and the WIRED line: finish_wired (above), shared with
      # the shared-bridge path so the two cannot drift.
      finish_wired
    fi
    # Wired but not reachable BY THE AGENT, which is the only sense that
    # matters. Reported as a failure rather than a WIRED with an asterisk: the
    # provisioner treats a bridge failure as non-fatal and logs it, so the trip
    # still finishes — with the one fact that would otherwise be invisible.
    printf 'companion-install-host: %s gateway registered no trip-mcp tools after restart\n' "$PROFILE_NAME" >&2
    tail -5 "$GATEWAY_LOG" >&2 2>/dev/null || true
    die "trip-mcp wired for $TRIP_SLUG but $PROFILE_NAME's gateway did not register its tools"
  fi
  tail -20 "$WORK/setup-mcp.log" >&2
  die "setup-mcp.sh failed for $TRIP_SLUG"
fi

# ── Re-render an existing companion from a release (#568 slice R2) ─────────────
#
# `render_profile.py` refuses an existing profile and the install path below
# answers ALREADY_PRESENT and leaves SOUL.md as it was, so until now a companion
# could never follow its trip to a newer release: the site and the bridge moved
# and its instructions did not. This brings the files a RENDER OWNS (SOUL.md,
# profile.yaml, INSTALL.md, config.overlay.yaml, references/, skills/) to a fresh
# render of the release's templates for this trip, in place, and nothing else:
# conversation history (state.db), memory, sessions, logs, the relay identity in
# .env and the profile's own config.yaml are not read or written, except that the
# overlay is merged into config.yaml exactly as an install merges it (the profile's
# own settings win).
#
#   check   READ-ONLY. RERENDER <name> clean|edited|unknown_provenance
#   apply   RERENDER <name> applied|unchanged, or the same two refusals with nothing written
#
# A profile somebody edited in place, or one installed before what was rendered
# was recorded (so there is nothing to tell an edit from the original), is
# REFUSED and reported, never overwritten (spec Decision 2). `allow_edited` is
# the plan's explicit permission to overwrite it, and the edited files are copied
# to $HOME/.hermes/profile-backups/<name>/<stamp>/ first (capture before deploy).
#
# What this refuses, whatever it is asked: a profile on the deny list, one that
# is a symlink, one this system did not install (no provenance marker; the backfill
# marks the ones it can prove), and any request when the release's tree is not a
# real directory this user owns holding the release's render_profile.py. The tree
# is the caller's environment, never the request's: see the header of the
# validation block.
#
# It does NOT start, stop or restart the gateway and it enrols nothing: the caller
# clears the saved prompts and restarts the gateway afterwards
# (scripts/companion-refresh-prompts.sh), which is what makes a running
# conversation follow the new SOUL.
rerender_profile() {
  local name="$PROFILE_NAME" home="$HOME/.hermes/profiles/$PROFILE_NAME" tree="${KINERARY_RELEASE_TREE:-}"
  local render flags out code status
  [ -n "$tree" ] || die "a re-render renders from a release: KINERARY_RELEASE_TREE is not set (only a rollout on this host sets it)"
  case "$tree" in /*) ;; *) die "KINERARY_RELEASE_TREE is not an absolute path" ;; esac
  render="$tree/profile-templates/familytrip-companion/render_profile.py"
  [ -d "$tree" ] && [ ! -L "$tree" ] && [ -O "$tree" ] || die "KINERARY_RELEASE_TREE is not a real directory this user owns"
  [ -f "$render" ] && [ ! -L "$render" ] && [ -O "$render" ] || die "the release carries no render_profile.py (a release built before the companion templates were part of it cannot re-render a companion)"
  if gateway_denied "$name"; then die "$name is not a profile this system manages"; fi
  [ ! -L "$home" ] || die "$name: its profile directory is a symlink"
  [ -d "$home" ] || die "no companion profile $name on this host"
  if [ -L "$home/$GATEWAY_MARKER" ] || [ ! -f "$home/$GATEWAY_MARKER" ]; then
    die "$name carries no provenance marker: this system did not install it (run the backfill for it)"
  fi

  flags=(--reinstall-profile "$name" --release-id "$RERENDER_RELEASE_ID" --release-commit "$RERENDER_RELEASE_COMMIT")
  if [ "$GATEWAY_ACTION" = check ]; then flags+=(--check); fi
  # An apply always has a place to copy aside what it replaces or deletes (the newest three backups per profile are kept).
  if [ "$GATEWAY_ACTION" = apply ]; then flags+=(--backup-root "$HOME/.hermes/profile-backups"); fi
  if [ "$RERENDER_ALLOW" = 1 ] && [ "$GATEWAY_ACTION" = apply ]; then flags+=(--allow-edited); fi
  out="$WORK/rerender.out"
  code=0
  /usr/bin/env python3 "$render" --input "$WORK/rerender-handoff.json" --output "$WORK/rerender-bundle" "${flags[@]}" \
    > "$out" 2> "$WORK/rerender.err" || code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne 3 ]; then
    # The release's own renderer said no. The usual cause is the handoff's SHAPE: this host builds it with the
    # control plane's current builder, and a release older than that shape refuses a key it does not know (or lacks one it
    # requires). Name that, with the renderer's own one-line reason, rather than a bare exit code.
    reason="$(grep -m1 '^ERROR:' "$WORK/rerender.err" | tr -c '[:print:]' '?' | cut -c1-240)"
    tail -5 "$WORK/rerender.err" | tr -c '[:print:]\n' '?' >&2
    die "the release's render_profile.py refused this trip's handoff for $name (exit $code): ${reason:-no reason given}. A release older than the handoff shape the control plane builds now cannot render it; roll the companion forward to a later release, or leave the companion step out"
  fi
  # The verdict is JSON written by the release's render_profile.py, i.e. by code that came from a
  # release but is still another program's output: read through a closed set, one word out.
  status="$(/usr/bin/python3 - "$out" <<'PYVERDICT'
import json, re, sys
try:
    v = json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])
except Exception:
    print("invalid"); raise SystemExit(0)
status = v.get("status") if isinstance(v, dict) else None
print(status if status in ("clean", "edited", "unknown_provenance", "applied", "unchanged") else "invalid")
if isinstance(v, dict):
    names = [n for n in (v.get("edited") or []) if isinstance(n, str) and re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", n)][:20]
    if names:
        print("edited: " + ", ".join(names), file=sys.stderr)
    backup = v.get("backup")
    if isinstance(backup, str) and re.fullmatch(r"[A-Za-z0-9._/ -]{1,300}", backup):
        print("the edited files were copied to " + backup, file=sys.stderr)
PYVERDICT
  )" || status=invalid
  [ "$status" != invalid ] || die "$name: the release's render_profile.py gave no verdict this host recognises"
  case "$status" in
    edited) printf 'companion-install-host: %s was edited in place; nothing was overwritten\n' "$name" >&2 ;;
    unknown_provenance) printf 'companion-install-host: %s predates the record of what was rendered, so an edit cannot be told from the original; nothing was overwritten\n' "$name" >&2 ;;
  esac
  case "$status" in applied|unchanged)
    if [ "$GATEWAY_ACTION" = apply ] && [ "$status" = applied ]; then merge_overlay "$name"; fi ;;
  esac
  printf 'RERENDER %s %s\n' "$name" "$status"
}

if [ "$REQUEST_KIND" = "companion_profile_rerender" ]; then
  gateway_denied none || true     # load (and validate) the protected list before anything else
  rerender_profile
  exit 0
fi

if [ -d "$HOME/.hermes/profiles/$PROFILE_NAME" ]; then
  # Idempotent, and it repairs: a profile installed before the merge existed
  # is still missing its provider, and a retry should fix that rather than
  # report success and change nothing.
  merge_overlay "$PROFILE_NAME"
  enroll_relay "$PROFILE_NAME"
  # NOT marked here: a profile that was already present was not installed by
  # this run, and "this system installed it" is what the marker asserts. Only the
  # backfill, with provenance evidence, marks a profile from before the marker.
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
mark_managed "$PROFILE_NAME"
start_gateway "$PROFILE_NAME"

printf 'INSTALLED %s\n' "$PROFILE_NAME"
