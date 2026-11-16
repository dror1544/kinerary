#!/usr/bin/env python3
"""Move enrolled gateway profiles from the relay's shared key to a per-gateway key.

#597 K1 (docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md, AC-K1.5).

A gateway holds `derive(master, its id)` instead of the master itself, where

    derive(m, id) = hex(HMAC-SHA256(m, "kinerary-relay-gateway:v1:" + id))

so a key held for one gateway id is not valid for another. This rewrites the
relay key of profiles that already exist on this host, so a deployment can move
from `shared` through `both` to `derived`:

    scripts/relay-rekey.py --profile NAME[,NAME...]    # the plan; changes nothing
    scripts/relay-rekey.py --all-enrolled              # the plan for every enrolled profile
    scripts/relay-rekey.py --all-enrolled --execute    # do it

Run it on the host that holds the profiles, as the operator who owns them.

What it does and does not do:

  * Rewrites only GATEWAY_RELAY_SECRET and, when the file has one,
    COMPANION_CONTROL_TOKEN, in each profile's own `.env`, using that profile's
    own GATEWAY_RELAY_ID. Every other line is kept. The file is replaced
    atomically and stays 0600.
  * Refuses to run while the architecture profile's relay.gateway_key_mode is
    `shared` (or absent): the relay would then still be checking the master, and
    every gateway re-keyed here would be locked out. Set `both` first, restart
    the relay and the companion control MCP, then run this.
  * Refuses a profile with no GATEWAY_RELAY_ID or no GATEWAY_RELAY_SECRET, a
    symlinked profile directory or `.env`, a name that is not a profile name,
    and a master it cannot read. If any selected profile is refused, nothing at
    all is written.
  * Restarts nothing. A gateway reads its key at start, so it lists the gateways
    that need a restart to pick the new one up.
  * Never prints a key, a token, or the path of the master's file.

The master is found the way `enroll_relay` in companion-install-host.sh finds it:
`relay.gateway_secret_refs[0]` of the architecture profile, which must be a
`file://` reference. `KINERARY_ARCHITECTURE_PROFILE` names the profile; unset, the
same default path as that script. Profiles live in `$HOME/.hermes/profiles/`
(the install script does not honour HERMES_HOME either; set HOME to point
elsewhere).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ARCH_PROFILE = REPO_ROOT / "control-plane/deployment/.local-secrets/architecture.relay-host.json"

GATEWAY_KEY_LABEL = "kinerary-relay-gateway:v1:"
KEY_MODES = ("shared", "both", "derived")
# The same rule the install script applies before a name becomes a path component.
PROFILE_NAME = re.compile(r"[a-z0-9][a-z0-9-]{1,62}")
SECRET_KEY = "GATEWAY_RELAY_SECRET"
ID_KEY = "GATEWAY_RELAY_ID"
TOKEN_KEY = "COMPANION_CONTROL_TOKEN"


class Refusal(Exception):
    """A reason to change nothing. The message never contains a key."""


def derive_gateway_key(master: str, gateway_id: str) -> str:
    if not master or not gateway_id:
        raise Refusal("cannot derive a key from an empty master or gateway id")
    return hmac.new(master.encode(), (GATEWAY_KEY_LABEL + gateway_id).encode(), hashlib.sha256).hexdigest()


def control_token(gateway_id: str, key: str) -> str:
    """The relay's own token format with no expiry (protocol.ts makeUpgradeToken)."""
    signed = f"{gateway_id}:0"
    sig = hmac.new(key.encode(), signed.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{signed}:{sig}".encode()).decode().rstrip("=")


# -- the architecture profile and the master ------------------------------------------

def architecture_profile_path() -> Path:
    return Path(os.environ.get("KINERARY_ARCHITECTURE_PROFILE") or DEFAULT_ARCH_PROFILE)


def read_relay_block(path: Path) -> dict:
    try:
        relay = json.loads(path.read_text(encoding="utf-8")).get("relay")
    except (OSError, ValueError):
        raise Refusal("the architecture profile cannot be read as JSON")
    if not isinstance(relay, dict):
        raise Refusal("the architecture profile has no relay block")
    return relay


def key_mode(relay: dict) -> str:
    mode = relay["gateway_key_mode"] if "gateway_key_mode" in relay else "shared"
    if mode not in KEY_MODES:
        raise Refusal("relay.gateway_key_mode is not shared, both or derived")
    return mode


def read_master(relay: dict) -> str:
    refs = relay.get("gateway_secret_refs")
    ref = refs[0] if isinstance(refs, list) and refs else ""
    if not isinstance(ref, str) or not ref.startswith("file://"):
        raise Refusal("relay.gateway_secret_refs[0] is not a file:// reference, so the master cannot be read here")
    try:
        master = Path(ref[len("file://"):]).read_text(encoding="utf-8").strip()
    except OSError:
        raise Refusal("the master secret file cannot be read")
    if not master:
        raise Refusal("the master secret file is empty")
    return master


# -- one profile's .env -----------------------------------------------------------------

LINE = re.compile(r"^(?P<prefix>\s*(?:export\s+)?)(?P<key>[A-Za-z_][A-Za-z0-9_]*)=(?P<value>.*)$")


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def values_in(lines: list[str]) -> dict[str, str]:
    found: dict[str, str] = {}
    for line in lines:
        m = LINE.match(line)
        if m and m["key"] not in found:
            found[m["key"]] = unquote(m["value"])
    return found


class Target:
    def __init__(self, name: str, env_path: Path, gateway_id: str, state: str, lines: list[str], has_token: bool):
        self.name = name
        self.env_path = env_path
        self.gateway_id = gateway_id
        self.state = state
        self.lines = lines
        self.has_token = has_token


def inspect_profile(profiles_dir: Path, name: str, master: str) -> Target:
    if not PROFILE_NAME.fullmatch(name):
        raise Refusal(f"{name!r} is not a profile name")
    profile = profiles_dir / name
    if profile.is_symlink():
        raise Refusal(f"{name}: the profile directory is a symlink")
    if not profile.is_dir():
        raise Refusal(f"{name}: no such profile")
    env_path = profile / ".env"
    if env_path.is_symlink():
        raise Refusal(f"{name}: .env is a symlink")
    if not env_path.is_file():
        raise Refusal(f"{name}: no .env, so it is not enrolled")
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        raise Refusal(f"{name}: .env cannot be read")
    values = values_in(lines)
    gateway_id = values.get(ID_KEY, "")
    if not gateway_id:
        raise Refusal(f"{name}: no {ID_KEY} in .env, so it is not enrolled")
    current = values.get(SECRET_KEY, "")
    if not current:
        raise Refusal(f"{name}: no {SECRET_KEY} in .env")
    derived = derive_gateway_key(master, gateway_id)
    # Compared in constant time out of habit: these are the two values that matter.
    if hmac.compare_digest(current.encode(), derived.encode()):
        state = "already derived"
    elif hmac.compare_digest(current.encode(), master.encode()):
        state = "shared -> derived"
    else:
        state = "unrecognised -> derived"
    return Target(name, env_path, gateway_id, state, lines, TOKEN_KEY in values)


def rewritten(target: Target, master: str) -> str:
    key = derive_gateway_key(master, target.gateway_id)
    replacements = {SECRET_KEY: key}
    if target.has_token:
        replacements[TOKEN_KEY] = control_token(target.gateway_id, key)
    out = []
    for line in target.lines:
        m = LINE.match(line)
        if m and m["key"] in replacements:
            line = f"{m['prefix']}{m['key']}={replacements[m['key']]}"
        out.append(line)
    return "\n".join(out) + "\n"


def write_atomically(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.rekey.{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# -- selection and the run --------------------------------------------------------------

def enrolled_names(profiles_dir: Path) -> list[str]:
    """Profiles that carry a relay identity. A symlink is listed so it is refused, not skipped."""
    if not profiles_dir.is_dir():
        raise Refusal("there is no profiles directory under HOME/.hermes")
    names = []
    for entry in sorted(profiles_dir.iterdir()):
        if entry.name.startswith(".") or not (entry.is_dir() or entry.is_symlink()):
            continue
        env_path = entry / ".env"
        if entry.is_symlink() or env_path.is_symlink():
            names.append(entry.name)
            continue
        try:
            text = env_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if ID_KEY in values_in(text.splitlines()):
            names.append(entry.name)
    return names


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Re-key enrolled gateway profiles to per-gateway relay keys.")
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument("--profile", help="profile name, or a comma-separated list")
    which.add_argument("--all-enrolled", action="store_true", help="every profile whose .env has a GATEWAY_RELAY_ID")
    parser.add_argument("--execute", action="store_true", help="write the change; without it, print the plan only")
    args = parser.parse_args(argv)

    profiles_dir = Path.home() / ".hermes" / "profiles"
    arch = architecture_profile_path()
    try:
        relay = read_relay_block(arch)
        mode = key_mode(relay)
        if mode == "shared":
            raise Refusal(
                "relay.gateway_key_mode is shared (or absent): the relay still checks the master, and a re-keyed "
                "gateway would be refused. Set it to both, restart the relay and the companion control MCP, "
                "then run this again."
            )
        master = read_master(relay)
        names = enrolled_names(profiles_dir) if args.all_enrolled else [n.strip() for n in args.profile.split(",") if n.strip()]
        if not names:
            raise Refusal("no profile selected" if not args.all_enrolled else "no enrolled profile found")
    except Refusal as exc:
        print(f"relay-rekey: refused: {exc}", file=sys.stderr)
        return 1

    targets: list[Target] = []
    refusals: list[str] = []
    for name in dict.fromkeys(names):
        try:
            targets.append(inspect_profile(profiles_dir, name, master))
        except Refusal as exc:
            refusals.append(str(exc))
    if refusals:
        for reason in refusals:
            print(f"relay-rekey: refused: {reason}", file=sys.stderr)
        print("relay-rekey: nothing was changed", file=sys.stderr)
        return 1

    print(f"relay.gateway_key_mode: {mode}")
    print(f"{'profile':<32} {'gateway id':<32} change")
    for t in targets:
        print(f"{t.name:<32} {t.gateway_id:<32} {t.state}")

    todo = [t for t in targets if t.state != "already derived"]
    if not args.execute:
        print(f"plan only: {len(todo)} of {len(targets)} would change. Add --execute to write.")
        return 0

    for t in todo:
        write_atomically(t.env_path, rewritten(t, master))
    print(f"re-keyed {len(todo)} of {len(targets)}.")
    if todo:
        print("restart these gateways to pick up the new key (nothing was restarted):")
        for t in todo:
            print(f"  {t.name} (gateway id {t.gateway_id})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
