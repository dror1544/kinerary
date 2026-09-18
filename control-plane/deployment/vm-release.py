#!/usr/bin/env python3
"""kinerary-cp-release — upgrade the production control plane, and go back.

Installed on the control-plane VM as /usr/local/sbin/kinerary-cp-release —
outside /opt/kinerary, because upgrading and rolling back switch that checkout,
and the first rollback target predates this file.

    kinerary-cp-release status
    kinerary-cp-release plan <rev|main>
    kinerary-cp-release upgrade <rev|main> [--hermes-rev R] [--force-live] [--dry-run]
    kinerary-cp-release rollback [--to REV] [--restore-db|--keep-db] [--restore-hermes] [--force-live] [--dry-run]
    kinerary-cp-release verify
    kinerary-cp-release restart-bridges [--dry-run]
    kinerary-cp-release prune [--dry-run]
    kinerary-cp-release history | snapshots
    kinerary-cp-release install [--gate-pubkey-file F] [--dry-run]
    kinerary-cp-release gate <verb> …       the agent path (trip-monitor), see GATE below

THREE WAYS BACK, CHEAPEST FIRST (docs/control-plane-vm-deployment.md):

  1. rollback              the previous version's images and checkout, keeping
                           the newer database — when every migration since is
                           declared `-- rollback: compatible`.
  2. rollback --restore-db the pre-upgrade dump too. Loses DB writes since the
                           upgrade, and refuses when a trip was built since.
  3. vm-restore-snapshot.sh (from the Mac, a person only) the whole VM.

Every upgrade takes a pg_dump and a Proxmox snapshot of this VM first. The
snapshot is taken by proxmox-snapshot-runner.sh ON the Proxmox host, which
also undoes a snapshot that stalls — the guest cannot thaw itself while frozen.

--dry-run runs every guard and preflight for real, prints each step with its
command and what it costs, and changes nothing (it may `git fetch`).

GATE. `gate` is what the trip-monitor agent reaches, through the `cprelease`
user's forced command and one sudoers line. It can read, plan, dry-run and
REQUEST; it can never approve. A request sends Dror a one-time code through
the trip bot; only a code he types into the trip-monitor chat approves it, and
it approves exactly the action frozen at request time.
"""
from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import hmac
import io
import json
import os
import pwd
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Dict, Iterable, List, NamedTuple, Optional, Sequence, Tuple

# --------------------------------------------------------------------------- #
# Where things are. Environment overrides exist for tests and the rehearsal
# clone; sudo resets the environment, so the agent path always gets these.
# --------------------------------------------------------------------------- #
ENV = os.environ
REPO = Path(ENV.get("KINERARY_CP_REPO", "/opt/kinerary"))
DEPLOYMENT_DIR = REPO / "control-plane" / "deployment"
DEPLOY_ROOT = Path(ENV.get("KINERARY_CP_DEPLOY_ROOT", "/opt/kinerary-deploy"))
PROVISIONING_ENV = DEPLOY_ROOT / "provisioning.env"
VM_ENV = DEPLOY_ROOT / "vm.env"
STATE_DIR = Path(ENV.get("KINERARY_CP_STATE_DIR", "/var/lib/kinerary-cp-release"))
BACKUP_DIR = Path(ENV.get("KINERARY_CP_BACKUP_DIR", "/var/backups/kinerary-cp"))
LOG_DIR = Path(ENV.get("KINERARY_CP_LOG_DIR", "/var/log/kinerary"))
LIB_DIR = Path(ENV.get("KINERARY_CP_LIB_DIR", "/usr/local/lib/kinerary-cp-release"))
HERMES_DATA = Path(ENV.get("KINERARY_CP_HERMES_DATA", "/opt/hermes-data"))
INSTALLED_TOOL = Path("/usr/local/sbin/kinerary-cp-release")
INSTALLED_GATE = Path("/usr/local/sbin/kinerary-cp-release-gate")
SECRETS_DIR = DEPLOYMENT_DIR / ".local-secrets"

# This deployment's infrastructure — the VMID, the Proxmox host, the keys that
# reach it, the bot's name — is deliberately NOT in this file: the kinerary repo
# is public. It lives in the private kinerary-deploy repo as control-plane.env,
# with PROXMOX_HOST / PROXMOX_SSH_USER read from provisioning.env (their one
# home), and without it nothing that needs it runs. There are no defaults.
SITE_FILE = Path(ENV.get("KINERARY_CP_SITE_FILE", str(DEPLOY_ROOT / "control-plane.env")))
SITE_REQUIRED = ("CP_VMID", "CP_EXPECT_BOT", "CP_PROXMOX_SSH_KEY_ON_VM", "CP_PROXMOX_KNOWN_HOSTS_ON_VM",
                 "PROXMOX_HOST", "PROXMOX_SSH_USER")

COMPOSE_PROJECT = "kinerary-cp"
PG_CONTAINER = ENV.get("KINERARY_CP_PG_CONTAINER", "kinerary-cp-postgres-1")
RELAY_CONTAINER = "kinerary-cp-relay-1"
HERMES_CONTAINER = "hermes"
DB_USER = DB_NAME = "kinerary_control_plane"
READYZ = "http://127.0.0.1:4310/readyz"

# Limits (docs/control-plane-vm-deployment.md, "Upgrades and rollback").
MIN_ROOT_FREE_GB = 10
BACKUP_KEEP = 10
BACKUP_MAX_TOTAL_GB = 5
IMAGE_KEEP_HISTORY_ROWS = 5
SNAPSHOT_MAX_AGE_DAYS = 14
SNAPSHOT_WARN_AGE_DAYS = 7
BUILD_CACHE_KEEP = "5GB"
LOCAL_FS_TYPES = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs"}
BUILT_STATES = ("provisioning", "ready_private", "activation_approved", "active", "completed", "sealed")

# Gate limits.
REQUEST_TTL_SECONDS = 600
REQUEST_MAX_ATTEMPTS = 3
REQUESTS_PER_HOUR = 5
GATE_TOKEN = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
REV_TOKEN = re.compile(r"^(main|[0-9a-f]{7,40})$")
REQUEST_ID = re.compile(r"^r-[0-9]{1,6}$")
CODE_TOKEN = re.compile(r"^[0-9]{6}$")

ROLLBACK_HEADER = re.compile(r"^--\s*rollback:\s*(compatible|breaking)\s*[—-]\s*(\S.*)$", re.M)
MIGRATION_FILE = re.compile(r"^\d+_.+\.sql$")


class Refused(Exception):
    """A guard said no. Nothing was changed by the step that raised it."""


class MigrateFailed(Refused):
    """migrate failed during a switch; the checkout and vm.env were put back, but
    migrations before the failing one may have committed."""


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #
class Report:
    def __init__(self, stream=None, color: Optional[bool] = None):
        self.stream = stream or sys.stdout
        self.color = self.stream.isatty() if color is None and hasattr(self.stream, "isatty") else bool(color)
        self.failures = 0
        self.facts: Dict[str, str] = {}

    def _mark(self, code: str, mark: str) -> str:
        return f"\033[{code}m{mark}\033[0m" if self.color else mark

    def line(self, text: str = "") -> None:
        print(text, file=self.stream, flush=True)

    def head(self, text: str) -> None:
        self.line(); self.line(f"── {text} ──")

    def ok(self, text: str) -> None:
        self.line(f"  {self._mark('32', '✓')} {text}")

    def fail(self, text: str) -> None:
        self.failures += 1
        self.line(f"  {self._mark('31', '✗')} {text}")

    def note(self, text: str) -> None:
        self.line(f"  {self._mark('33', '!')} {text}")

    def step(self, text: str) -> None:
        self.line(f"  → {text}")

    def fact(self, key: str, value: str) -> None:
        self.facts[key] = value


# --------------------------------------------------------------------------- #
# Running things. read() always runs; act() is what --dry-run replaces with a
# description, so a dry run can never change anything by accident.
# --------------------------------------------------------------------------- #
class Shell:
    def __init__(self, report: Report, dry_run: bool = False):
        self.report = report
        self.dry_run = dry_run

    def read(self, argv: Sequence[str], *, input: Optional[bytes] = None, timeout: Optional[float] = 120,
             check: bool = False) -> subprocess.CompletedProcess:
        proc = subprocess.run(list(argv), input=input, capture_output=True, timeout=timeout)
        if check and proc.returncode != 0:
            raise Refused(f"{shlex.join(argv)} exited {proc.returncode}: {proc.stderr.decode(errors='replace')[-400:]}")
        return proc

    def text(self, argv: Sequence[str], **kwargs) -> str:
        return self.read(argv, **kwargs).stdout.decode(errors="replace")

    def act(self, argv: Sequence[str], *, describe: str = "", input: Optional[bytes] = None,
            timeout: Optional[float] = None, check: bool = True, env: Optional[Dict[str, str]] = None,
            stream_output: bool = False) -> subprocess.CompletedProcess:
        shown = describe or shlex.join(argv)
        if self.dry_run:
            self.report.step(f"would run: {shown}")
            return subprocess.CompletedProcess(list(argv), 0, b"", b"")
        self.report.step(shown)
        run_env = {**os.environ, **env} if env else None
        if stream_output:
            proc = subprocess.run(list(argv), input=input, timeout=timeout, env=run_env,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            for text_line in proc.stdout.decode(errors="replace").splitlines()[-30:]:
                self.report.line(f"      {text_line}")
        else:
            proc = subprocess.run(list(argv), input=input, capture_output=True, timeout=timeout, env=run_env)
        if check and proc.returncode != 0:
            err = (proc.stderr or b"").decode(errors="replace")[-600:] if not stream_output else ""
            raise Refused(f"{shown} exited {proc.returncode}{': ' + err if err else ''}")
        return proc


# --------------------------------------------------------------------------- #
# Pure helpers (tested in tests/scripts/test_vm_release.py)
# --------------------------------------------------------------------------- #
def read_env_text(text: str) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def update_env_text(text: str, updates: Dict[str, str]) -> str:
    """Replace KEY= lines in place; append keys that are absent. Nothing else moves."""
    seen = set()
    out = []
    for raw in text.splitlines():
        key = raw.split("=", 1)[0].strip() if "=" in raw and not raw.lstrip().startswith("#") else None
        if key in updates:
            out.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            out.append(raw)
    for key, value in updates.items():
        if key not in seen:
            out.append(f"{key}={value}")
    return "\n".join(out) + "\n"


def site_from_texts(control_plane_env: Optional[str], provisioning_env: str, vm_env: str) -> Dict[str, str]:
    """The deployment's facts from kinerary-deploy's files. Refuses rather than guesses.

    Only the keys this tool needs are kept from provisioning.env, which also
    holds credentials. vm.env overrides it, in the order compose reads them.
    Every value that ends up in an ssh command line is checked here.
    """
    if control_plane_env is None:
        raise Refused(f"{SITE_FILE} is missing — this deployment's infrastructure facts (VMID, Proxmox keys, bot) "
                      "live in the private kinerary-deploy repo as control-plane.env, not in this public tool")
    site = read_env_text(control_plane_env)
    for source in (read_env_text(provisioning_env), read_env_text(vm_env)):
        for key in ("PROXMOX_HOST", "PROXMOX_SSH_USER"):
            if source.get(key):
                site[key] = source[key]
    missing = [key for key in SITE_REQUIRED if not site.get(key)]
    if missing:
        raise Refused(f"control-plane.env / provisioning.env lack: {', '.join(missing)}")
    checks = {
        "CP_VMID": r"^[0-9]{1,9}$",
        "CP_EXPECT_BOT": r"^[A-Za-z0-9_]{5,64}$",
        "CP_PROXMOX_SSH_KEY_ON_VM": r"^[A-Za-z0-9_./~-]+$",
        "CP_PROXMOX_KNOWN_HOSTS_ON_VM": r"^[A-Za-z0-9_./~-]+$",
        "PROXMOX_HOST": r"^[A-Za-z0-9.:-]+$",
        "PROXMOX_SSH_USER": r"^[a-z_][a-z0-9_-]{0,31}$",
        "CP_REFUSE_STORAGE": r"^[A-Za-z0-9._ -]*$",
    }
    for key, pattern in checks.items():
        if key in site and not re.match(pattern, site[key]):
            raise Refused(f"{key} has characters it may not: {site[key][:40]!r}")
    return {key: site[key] for key in (*SITE_REQUIRED, "CP_REFUSE_STORAGE") if key in site}


def rollback_declaration(sql: str) -> Optional[Tuple[str, str]]:
    """(`compatible`|`breaking`, reason) from a migration's first 20 lines, or None."""
    match = ROLLBACK_HEADER.search("\n".join(sql.splitlines()[:20]))
    return (match.group(1), match.group(2).strip()) if match else None


def classify_migrations(files: Iterable[str], declaration: Callable[[str], Optional[Tuple[str, str]]]
                        ) -> Tuple[str, List[Tuple[str, str, str]]]:
    """Verdict over a set of migrations: `compatible` only if EVERY one says so.

    An undeclared migration is `breaking` — fail safe, so a missing header can
    never make keeping the newer database look safe.
    """
    details: List[Tuple[str, str, str]] = []
    verdict = "compatible"
    for name in sorted(files):
        declared = declaration(name)
        kind, reason = declared if declared else ("breaking", "no `-- rollback:` header — treated as breaking")
        if kind != "compatible":
            verdict = "breaking"
        details.append((name, kind, reason))
    return verdict, details


def extract_agent_tools(interview_mcp_source: str) -> List[str]:
    """The *_for_chat tools interview-mcp.ts registers behind AGENT_KEY.

    Same extraction as interview-stack-deploy/deploy.sh: from `if (AGENT_KEY)`
    to the end, newlines collapsed, `mcp.tool( "name"`.
    """
    start = interview_mcp_source.find("if (AGENT_KEY)")
    if start < 0:
        return []
    body = interview_mcp_source[start:].replace("\n", " ")
    return re.findall(r'mcp\.tool\( *"([a-z_]+)"', body)


def parse_runner_output(text: str) -> Tuple[Dict[str, str], List[Tuple[str, str]], List[Tuple[str, int, str]]]:
    """proxmox-snapshot-runner.sh output → (values, checks, snapshots)."""
    values: Dict[str, str] = {}
    checks: List[Tuple[str, str]] = []
    snapshots: List[Tuple[str, int, str]] = []
    for line in text.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.startswith("check."):
            checks.append((key[len("check."):], value))
        elif key == "snapshot":
            parts = value.split("\t")
            name = parts[0]
            snaptime = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            snapshots.append((name, snaptime, parts[2] if len(parts) > 2 else ""))
        else:
            values[key] = value
    return values, checks, snapshots


def snapshots_to_prune(snapshots: Sequence[Tuple[str, int, str]], now: float, *, keep_newest: int,
                       max_age_days: Optional[int]) -> List[str]:
    """Release (pre-*) snapshots to delete: beyond the newest `keep_newest`, or
    (when max_age_days is set) older than that — but never the newest one."""
    releases = sorted([s for s in snapshots if s[0].startswith("pre-")], key=lambda s: s[1], reverse=True)
    doomed = []
    for index, (name, snaptime, _desc) in enumerate(releases):
        if index == 0:
            continue
        too_many = index >= keep_newest
        too_old = max_age_days is not None and (now - snaptime) > max_age_days * 86400
        if too_many or too_old:
            doomed.append(name)
    return doomed


def backups_to_prune(backups: Sequence[Tuple[str, int]], *, keep: int, max_total_bytes: int) -> List[str]:
    """Backup dirs (name, bytes), names sortable by time. Newest always kept."""
    ordered = sorted(backups, key=lambda b: b[0], reverse=True)
    doomed = [name for name, _ in ordered[keep:]]
    kept = [b for b in ordered[:keep]]
    total = sum(size for _, size in kept)
    while len(kept) > 1 and total > max_total_bytes:
        name, size = kept.pop()
        doomed.append(name)
        total -= size
    return doomed


def images_to_prune(tags: Iterable[str], keep_revs: Iterable[str]) -> List[str]:
    """kinerary-cp/{api,worker,agent-runtime}:<rev> images not in keep_revs.

    Hermes images are never pruned here: building one is a manual step.
    """
    keep = {r for r in keep_revs if r}
    doomed = []
    for tag in tags:
        match = re.match(r"^kinerary-cp/(api|worker|agent-runtime):([0-9a-f]{7,40})$", tag)
        if match and match.group(2) not in keep:
            doomed.append(tag)
    return sorted(doomed)


# --------------------------------------------------------------------------- #
# History
# --------------------------------------------------------------------------- #
HISTORY_FIELDS = ["utc", "action", "from_rev", "to_rev", "hermes_from", "hermes_to", "snapshot",
                  "backup_dir", "verdict", "result", "actor"]


def history_path() -> Path:
    return STATE_DIR / "history.tsv"


def read_history(path: Optional[Path] = None) -> List[Dict[str, str]]:
    path = path or history_path()
    if not path.exists():
        return []
    rows = []
    for raw in path.read_text().splitlines()[1:]:
        parts = raw.split("\t")
        if len(parts) < len(HISTORY_FIELDS):
            parts += [""] * (len(HISTORY_FIELDS) - len(parts))
        rows.append(dict(zip(HISTORY_FIELDS, parts)))
    return rows


def append_history(row: Dict[str, str], path: Optional[Path] = None) -> None:
    path = path or history_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a") as handle:
        if new:
            handle.write("\t".join(HISTORY_FIELDS) + "\n")
        handle.write("\t".join(str(row.get(f, "")).replace("\t", " ").replace("\n", " ") for f in HISTORY_FIELDS) + "\n")


# An upgrade with one of these results changed something that may need undoing,
# and its row carries the way back: the version it came from, the dump, the
# snapshot. `switching` is written BEFORE the switch starts, so a run that dies
# mid-switch still leaves one; the row written when it ends supersedes it.
SWITCHED_RESULTS = ("ok", "verify-failed", "switch-failed", "switching")
RECOVERABLE_RESULTS = SWITCHED_RESULTS + ("migrate-failed",)


def recovery_point(rows: Sequence[Dict[str, str]], current_rev: str, to: Optional[str] = None) -> Optional[Dict[str, str]]:
    """The upgrade whose way back applies to what is running now, or None.

    It must describe the running version: a switched upgrade landed on its
    to_rev; a migrate-failed one was put back on its from_rev, possibly with some
    of the new migrations committed. `to` picks the upgrade that came from that
    version. Without `to`, a rollback recorded after the latest upgrade means
    that upgrade was already undone.
    """
    def matches(rev: str, wanted: str) -> bool:
        return bool(rev) and bool(wanted) and (rev.startswith(wanted) or wanted.startswith(rev))

    for row in reversed(rows):
        if row["action"] == "rollback" and row["result"] in ("ok", "verify-failed") and to is None:
            return None
        if row["action"] != "upgrade" or row["result"] not in RECOVERABLE_RESULTS:
            continue
        running = row["to_rev"] if row["result"] in SWITCHED_RESULTS else row["from_rev"]
        if not matches(running, current_rev):
            if to is None:
                return None
            continue
        if to is None or matches(row["from_rev"], to):
            return row
    return None


class Swap(NamedTuple):
    """A --restore-db that replaced the live database: the copy set aside (the
    state the rollback discards) and the stamp both copies are named after.
    It is what makes the swap undoable until the target's services start."""
    aside: str
    stamp: str


def remote_runner_command(mode: str, vmid: str, args: Sequence[str] = (), *,
                          ignore_snapshots: Sequence[str] = (), refuse_storage: str = "") -> str:
    """The snapshot runner's command line, as ONE argument for ssh.

    ssh joins whatever argv it is given with spaces and hands the result to a
    shell on the far side, so an unquoted argument is shell source there. A
    snapshot description is "aa61f6e -> 8c89e30": unquoted, that `>` redirected
    the runner's output into a file named after the target revision on the
    Proxmox host, and the caller saw none of its checks or recovery lines.
    """
    remote = ["env"]
    if ignore_snapshots:
        remote.append("IGNORE_SNAPSHOTS=" + " ".join(n for n in ignore_snapshots if re.match(r"^pre-[A-Za-z0-9_-]{1,36}$", n)))
    if refuse_storage:
        remote.append("REFUSE_STORAGE=" + refuse_storage)
    remote += ["bash", "-s", "--", mode, str(vmid), *args]
    return shlex.join(remote)


class Undo(NamedTuple):
    """One thing a rollback changed before its point of no return: what it was,
    how to put it back, and what to run by hand if putting it back fails."""
    what: str
    put_back: Callable[[], None]
    by_hand: str


def databases_to_prune(names: Iterable[str]) -> List[str]:
    """Scratch databases this tool leaves (verify/restore copies, and a restore
    that was undone) always go; of the databases a --restore-db replaced, the
    newest is kept for inspection."""
    scratch = sorted(n for n in names if re.match(rf"^{DB_NAME}_(verify|restore|restore_failed)_[0-9t]+z$", n))
    replaced = sorted(n for n in names if re.match(rf"^{DB_NAME}_pre_rollback_[0-9t]+z$", n))
    return scratch + replaced[:-1]


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(moment: dt.datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- #
# The gate's requests (tested without a VM)
# --------------------------------------------------------------------------- #
class GateRefusal(Exception):
    pass


def parse_gate(tokens: Sequence[str]) -> Tuple[str, List[str]]:
    """Validate a gate command. Returns (verb, args). Flags a person reserves are refused."""
    if not tokens:
        raise GateRefusal("no verb — try: gate help")
    for token in tokens:
        if not GATE_TOKEN.match(token):
            raise GateRefusal(f"refused token {token[:20]!r}: letters, digits, . _ : - only")
    verb, rest = tokens[0], list(tokens[1:])
    if verb in ("status", "help", "history", "snapshots", "verify"):
        if rest:
            raise GateRefusal(f"{verb} takes no arguments")
        return verb, []
    if verb == "plan":
        if len(rest) != 1 or not REV_TOKEN.match(rest[0]):
            raise GateRefusal("plan <main|commit>")
        return verb, rest
    if verb in ("dry-run", "request"):
        return verb, parse_gate_action(rest)
    if verb == "approve":
        if len(rest) != 2 or not REQUEST_ID.match(rest[0]) or not CODE_TOKEN.match(rest[1]):
            raise GateRefusal("approve r-<n> <6-digit code>")
        return verb, rest
    if verb in ("cancel", "result"):
        if len(rest) != 1 or not REQUEST_ID.match(rest[0]):
            raise GateRefusal(f"{verb} r-<n>")
        return verb, rest
    raise GateRefusal(f"unknown verb {verb!r} — try: gate help")


def parse_gate_action(rest: Sequence[str]) -> List[str]:
    if not rest:
        raise GateRefusal("which action: upgrade <rev> | rollback | prune | restart-bridges")
    action, args = rest[0], list(rest[1:])
    reserved = {"--force-live", "--keep-db", "--restore-hermes", "--force", "--dry-run"}
    for arg in args:
        if arg in reserved:
            raise GateRefusal(f"{arg} is reserved for a person at the VM's terminal")
    if action == "upgrade":
        if not args or not REV_TOKEN.match(args[0]):
            raise GateRefusal("upgrade <main|commit> [--hermes-rev <rev>]")
        out = ["upgrade", args[0]]
        extra = args[1:]
        if extra:
            if len(extra) != 2 or extra[0] != "--hermes-rev" or not re.match(r"^[0-9a-f]{7,40}$", extra[1]):
                raise GateRefusal("upgrade <main|commit> [--hermes-rev <rev>]")
            out += extra
        return out
    if action == "rollback":
        out = ["rollback"]
        i = 0
        while i < len(args):
            if args[i] == "--restore-db":
                out.append("--restore-db"); i += 1
            elif args[i] == "--to" and i + 1 < len(args) and re.match(r"^[0-9a-f]{7,40}$", args[i + 1]):
                out += ["--to", args[i + 1]]; i += 2
            else:
                raise GateRefusal("rollback [--to <commit>] [--restore-db]")
        return out
    if action in ("prune", "restart-bridges"):
        if args:
            raise GateRefusal(f"{action} takes no arguments")
        return [action]
    raise GateRefusal(f"unknown action {action!r}")


class Requests:
    """One-time-code approvals, stored root-only. The code itself is never stored."""

    def __init__(self, directory: Path, clock: Callable[[], float] = time.time):
        self.directory = directory
        self.clock = clock

    def _path(self, request_id: str) -> Path:
        if not REQUEST_ID.match(request_id):
            raise GateRefusal("bad request id")
        return self.directory / f"{request_id}.json"

    @contextmanager
    def _lock(self, request_id: str):
        """Serialize a complete read-modify-write for one request."""
        self._path(request_id)  # validate before using the id in a lock-file name
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock_path = self.directory / f".{request_id}.lock"
        with os.fdopen(os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600), "r+") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            yield

    @contextmanager
    def _creation_lock(self):
        """Protect rate limiting and allocation of the next request id."""
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock_path = self.directory / ".create.lock"
        with os.fdopen(os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600), "r+") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            yield

    def _all(self) -> List[Dict]:
        if not self.directory.exists():
            return []
        items = []
        for path in sorted(self.directory.glob("r-*.json")):
            try:
                items.append(json.loads(path.read_text()))
            except (OSError, ValueError):
                continue
        return items

    def _save(self, request: Dict) -> None:
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self._path(request["id"])
        fd, tmp_name = tempfile.mkstemp(prefix=f".{request['id']}.", suffix=".tmp", dir=self.directory)
        tmp = Path(tmp_name)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as handle:
                json.dump(request, handle, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)

    def _get_unlocked(self, request_id: str) -> Dict:
        path = self._path(request_id)
        if not path.exists():
            raise GateRefusal(f"no request {request_id}")
        request = json.loads(path.read_text())
        if request["status"] == "pending" and self.clock() > request["expires_at"]:
            request["status"] = "expired"
            self._save(request)
        return request

    def get(self, request_id: str) -> Dict:
        with self._lock(request_id):
            return self._get_unlocked(request_id)

    def pending(self) -> List[Dict]:
        return [r for r in (self.get(i["id"]) for i in self._all()) if r["status"] == "pending"]

    @staticmethod
    def _digest(salt: str, code: str) -> str:
        return hashlib.sha256(f"{salt}:{code}".encode()).hexdigest()

    def create(self, action: List[str], summary: str) -> Tuple[Dict, str]:
        with self._creation_lock():
            now = self.clock()
            recent = [r for r in self._all() if now - r.get("created_at", 0) < 3600]
            if len(recent) >= REQUESTS_PER_HOUR:
                raise GateRefusal(f"{REQUESTS_PER_HOUR} requests in the last hour — wait before asking again")
            for item in self._all():
                with self._lock(item["id"]):
                    older = self._get_unlocked(item["id"])
                    if older["status"] == "pending":
                        older["status"] = "superseded"
                        self._save(older)
            numbers = [int(r["id"].split("-")[1]) for r in self._all()]
            code = f"{secrets.randbelow(10 ** 6):06d}"
            salt = secrets.token_hex(16)
            request = {
                "id": f"r-{(max(numbers) + 1) if numbers else 1}",
                "action": action,
                "summary": summary,
                "created_at": now,
                "expires_at": now + REQUEST_TTL_SECONDS,
                "salt": salt,
                "code_sha256": self._digest(salt, code),
                "attempts": 0,
                "status": "pending",
            }
            with self._lock(request["id"]):
                self._save(request)
            return request, code

    def approve(self, request_id: str, code: str) -> Dict:
        with self._lock(request_id):
            request = self._get_unlocked(request_id)
            if request["status"] != "pending":
                raise GateRefusal(f"{request_id} is {request['status']}, not pending")
            if not hmac.compare_digest(self._digest(request["salt"], code), request["code_sha256"]):
                request["attempts"] += 1
                if request["attempts"] >= REQUEST_MAX_ATTEMPTS:
                    request["status"] = "locked"
                self._save(request)
                left = REQUEST_MAX_ATTEMPTS - request["attempts"]
                raise GateRefusal(f"wrong code for {request_id}" + (f" — {left} tr{'y' if left == 1 else 'ies'} left" if left > 0 else " — request locked"))
            request["status"] = "approved"
            request["approved_at"] = self.clock()
            self._save(request)
            return request

    def cancel(self, request_id: str) -> Dict:
        with self._lock(request_id):
            request = self._get_unlocked(request_id)
            if request["status"] != "pending":
                raise GateRefusal(f"{request_id} is {request['status']}, not pending")
            request["status"] = "cancelled"
            self._save(request)
            return request

    def mark(self, request_id: str, **fields) -> Dict:
        with self._lock(request_id):
            request = self._get_unlocked(request_id)
            request.update(fields)
            self._save(request)
            return request

    @staticmethod
    def public(request: Dict) -> Dict:
        """What may be shown to the agent: never the salt or the digest."""
        return {k: v for k, v in request.items() if k not in ("salt", "code_sha256")}


# --------------------------------------------------------------------------- #
# The live system
# --------------------------------------------------------------------------- #
class ControlPlane:
    def __init__(self, report: Report, dry_run: bool = False, actor: str = "human"):
        self.r = report
        self.sh = Shell(report, dry_run)
        self.dry_run = dry_run
        self.actor = actor
        self._site: Optional[Dict[str, str]] = None

    @property
    def site(self) -> Dict[str, str]:
        if self._site is None:
            read = lambda path: path.read_text() if path.exists() else ""  # noqa: E731
            self._site = site_from_texts(SITE_FILE.read_text() if SITE_FILE.exists() else None,
                                         read(PROVISIONING_ENV), read(VM_ENV))
        return self._site

    @property
    def vmid(self) -> str:
        return self.site["CP_VMID"]

    # ------------------------------------------------------------ basics --
    def compose(self, *args: str) -> List[str]:
        return ["docker", "compose", "-f", str(DEPLOYMENT_DIR / "compose.vm.yml"),
                "--env-file", str(PROVISIONING_ENV), "--env-file", str(VM_ENV), *args]

    def vm_env(self) -> Dict[str, str]:
        return read_env_text(VM_ENV.read_text())

    def set_vm_env(self, updates: Dict[str, str]) -> None:
        described = " ".join(f"{k}={v}" for k, v in updates.items())
        if self.dry_run:
            self.r.step(f"would set in {VM_ENV}: {described}")
            return
        stat = VM_ENV.stat()
        text = update_env_text(VM_ENV.read_text(), updates)
        fd, tmp = tempfile.mkstemp(dir=str(VM_ENV.parent), prefix=".vm.env.")
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        os.chmod(tmp, stat.st_mode & 0o777)
        os.chown(tmp, stat.st_uid, stat.st_gid)
        os.replace(tmp, VM_ENV)
        self.r.step(f"set in {VM_ENV}: {described}")

    def repo_owner(self) -> str:
        return pwd.getpwuid(REPO.stat().st_uid).pw_name

    def git_argv(self, *args: str) -> List[str]:
        base = ["git", "-c", f"safe.directory={REPO}", "-C", str(REPO), *args]
        if os.geteuid() == 0 and self.repo_owner() != "root":
            return ["sudo", "-u", self.repo_owner(), "-H", *base]
        return base

    def git(self, *args: str, check: bool = True) -> str:
        proc = self.sh.read(self.git_argv(*args), timeout=180)
        if check and proc.returncode != 0:
            raise Refused(f"git {' '.join(args)}: {proc.stderr.decode(errors='replace').strip()[-300:]}")
        return proc.stdout.decode(errors="replace").strip()

    def fetch(self) -> None:
        # Remote-tracking refs only; the one side effect a dry run allows.
        self.git("fetch", "--quiet", "origin")

    def resolve(self, rev: str) -> Tuple[str, str]:
        ref = "origin/main" if rev == "main" else rev
        full = self.git("rev-parse", "--verify", f"{ref}^{{commit}}")
        return full, full[:7]

    def subject(self, rev: str) -> str:
        return self.git("log", "-1", "--format=%s", rev, check=False)[:90]

    def psql(self, sql: str, check: bool = True, db: str = DB_NAME) -> str:
        proc = self.sh.read(["docker", "exec", PG_CONTAINER, "psql", "-U", DB_USER, "-d", db, "-At",
                             "-v", "ON_ERROR_STOP=1", "-c", sql], timeout=120)
        if check and proc.returncode != 0:
            raise Refused(f"psql: {proc.stderr.decode(errors='replace').strip()[-300:]}")
        return proc.stdout.decode(errors="replace").strip()

    def readyz(self) -> Tuple[bool, str]:
        try:
            with urllib.request.urlopen(READYZ, timeout=5) as response:
                body = response.read().decode()
            return '"status":"ready"' in body.replace(" ", ""), body[:200]
        except Exception as error:  # noqa: BLE001 - any failure is "not ready"
            return False, str(error)[:200]

    # -------------------------------------------------------- migrations --
    def migration_files(self, rev: str) -> List[str]:
        listing = self.git("ls-tree", "--name-only", f"{rev}:control-plane/db/migrations")
        return sorted(name for name in listing.splitlines() if MIGRATION_FILE.match(name))

    def migration_sql(self, rev: str, name: str) -> Optional[str]:
        proc = self.sh.read(self.git_argv("show", f"{rev}:control-plane/db/migrations/{name}"), timeout=60)
        return proc.stdout.decode(errors="replace") if proc.returncode == 0 else None

    def applied_migrations(self) -> List[str]:
        return sorted(v for v in self.psql("SELECT version FROM public.control_plane_schema_migrations").splitlines() if v)

    def declaration_from(self, revs: Sequence[str]) -> Callable[[str], Optional[Tuple[str, str]]]:
        def lookup(name: str) -> Optional[Tuple[str, str]]:
            for rev in revs:
                if not rev:
                    continue
                sql = self.migration_sql(rev, name)
                if sql is not None:
                    return rollback_declaration(sql)
            return None
        return lookup

    def show_migration_verdict(self, title: str, verdict: str, details: List[Tuple[str, str, str]]) -> None:
        if not details:
            self.r.ok(f"{title}: none")
            return
        for name, kind, reason in details:
            (self.r.ok if kind == "compatible" else self.r.note)(f"{name}: {kind} — {reason}")
        self.r.fact("migrations", f"{len(details)} {title.lower()}, {verdict}")

    # ------------------------------------------------------------ guards --
    def guard_jobs(self) -> None:
        inflight = self.psql("SELECT count(*) FROM control_plane.jobs WHERE state NOT IN ('succeeded','failed','cancelled')")
        if inflight != "0":
            self.r.fail(f"{inflight} provisioning job(s) in flight — recreating the worker would cut one off")
        else:
            self.r.ok("no provisioning job in flight")

    def guard_interview(self, force_live: bool) -> None:
        live = self.psql(
            "SELECT telegram_chat_id FROM control_plane.intake_sessions WHERE state <> 'confirmed' "
            "AND awaiting = 'machine' AND awaiting_since > now() - interval '5 minutes' LIMIT 1")
        if not live:
            self.r.ok("no interview mid-turn")
        elif force_live:
            self.r.note(f"an interview is mid-turn (chat {live}) — continuing because --force-live")
        else:
            self.r.fail(f"an interview is mid-turn (chat {live}) — the relay restart would drop its message")

    def guard_checkout_clean(self) -> None:
        dirty = self.git("status", "--porcelain", "--untracked-files=no")
        if dirty:
            self.r.fail(f"{REPO} has tracked changes — a version has to be a commit you can name:\n      {dirty[:300]}")
        else:
            self.r.ok(f"{REPO} has no tracked changes")

    def fs_type(self, path: Path) -> str:
        probe = path
        while not probe.exists() and probe != probe.parent:
            probe = probe.parent
        return self.sh.text(["findmnt", "-n", "-o", "FSTYPE", "--target", str(probe)]).strip()

    def guard_storage(self, extra_bytes: int = 0) -> None:
        fstype = self.fs_type(BACKUP_DIR)
        if fstype in LOCAL_FS_TYPES:
            self.r.ok(f"backups go to {BACKUP_DIR} on local {fstype}, never NFS")
        else:
            self.r.fail(f"{BACKUP_DIR} is on '{fstype or 'unknown'}' — backups are only written to a local filesystem")
        netfs = self.sh.text(["findmnt", "-rn", "-t", "nfs,nfs4,cifs,smb3,fuse.sshfs", "-o", "TARGET"]).strip()
        if netfs:
            self.r.fail(f"this VM has network filesystems mounted ({netfs.replace(chr(10), ', ')}) — a snapshot freeze could hang on them")
        else:
            self.r.ok("no network filesystem mounted in this VM")
        free = shutil.disk_usage("/").free
        need = MIN_ROOT_FREE_GB * 1024 ** 3 + extra_bytes
        if free < need:
            self.r.fail(f"/ has {free / 1024 ** 3:.1f} GB free; need {need / 1024 ** 3:.1f} GB — run: kinerary-cp-release prune --dry-run")
        else:
            self.r.ok(f"/ has {free / 1024 ** 3:.1f} GB free (need {need / 1024 ** 3:.1f} GB)")
        backups = self.backup_dirs()
        total = sum(size for _, size in backups)
        self.r.ok(f"{len(backups)} backup dir(s), {total / 1024 ** 3:.2f} GB (limits: {BACKUP_KEEP} and {BACKUP_MAX_TOTAL_GB} GB, pruned after an upgrade)")

    def refuse_if_failed(self, what: str) -> None:
        if self.r.failures:
            raise Refused(f"{self.r.failures} check(s) failed — {what}")

    # --------------------------------------------------------- proxmox --
    def proxmox(self, mode: str, *args: str, timeout: float = 90, ignore_snapshots: Sequence[str] = ()) -> Tuple[int, str]:
        script = (LIB_DIR / "proxmox-snapshot-runner.sh")
        if not script.exists():
            script = DEPLOYMENT_DIR / "proxmox-snapshot-runner.sh"
        site = self.site
        argv = ["ssh", "-i", site["CP_PROXMOX_SSH_KEY_ON_VM"], "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
                "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={site['CP_PROXMOX_KNOWN_HOSTS_ON_VM']}",
                "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
                f"{site['PROXMOX_SSH_USER']}@{site['PROXMOX_HOST']}",
                remote_runner_command(mode, self.vmid, args, ignore_snapshots=ignore_snapshots,
                                      refuse_storage=site.get("CP_REFUSE_STORAGE", ""))]
        # Output is held in memory, never written to disk, while this call is
        # open: during a snapshot this VM's filesystems are frozen.
        try:
            proc = subprocess.run(argv, input=script.read_bytes(), capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return 124, "result=failed ssh to the Proxmox host timed out"
        return proc.returncode, proc.stdout.decode(errors="replace") + proc.stderr.decode(errors="replace")

    def show_runner(self, output: str, *, only_failures: bool = False) -> None:
        values, checks, _ = parse_runner_output(output)
        for name, value in checks:
            status, _, detail = value.partition(" ")
            if status == "pass":
                if not only_failures:
                    self.r.ok(f"host: {detail or name}")
            else:
                self.r.fail(f"host: {detail or name}")
        for key, value in values.items():
            if key.startswith("pool.") and not key.startswith("pool.after"):
                self.r.fact("pool", f"{key[5:]} {value}")
            if key.startswith("recovery."):
                self.r.note(f"host recovery — {key[9:]}: {value}")

    def snapshot_list(self) -> List[Tuple[str, int, str]]:
        code, output = self.proxmox("list")
        if code != 0:
            raise Refused(f"could not list snapshots of VM {self.vmid}: {output.strip()[-300:]}")
        return parse_runner_output(output)[2]

    def delete_snapshot(self, name: str) -> None:
        if self.dry_run:
            self.r.step(f"would delete snapshot {name} of VM {self.vmid} (on the Proxmox host)")
            return
        self.r.step(f"deleting snapshot {name} of VM {self.vmid}")
        code, output = self.proxmox("delete", name, timeout=300)
        if code != 0:
            self.show_runner(output)
            raise Refused(f"could not delete snapshot {name}: {output.strip().splitlines()[-1] if output.strip() else code}")

    # --------------------------------------------------------- backups --
    def backup_dirs(self) -> List[Tuple[str, int]]:
        if not BACKUP_DIR.exists():
            return []
        out = []
        for entry in sorted(BACKUP_DIR.iterdir()):
            if entry.is_dir():
                size = sum(f.stat().st_size for f in entry.rglob("*") if f.is_file())
                out.append((entry.name, size))
        return out

    def db_size_bytes(self) -> int:
        try:
            return int(self.psql("SELECT pg_database_size(current_database())"))
        except (Refused, ValueError):
            return 0

    def table_counts(self, db: str = DB_NAME) -> Dict[str, int]:
        tables = self.psql("SELECT table_schema||'.'||table_name FROM information_schema.tables "
                           "WHERE table_type='BASE TABLE' AND (table_schema='control_plane' "
                           "OR (table_schema='public' AND table_name='control_plane_schema_migrations')) ORDER BY 1", db=db)
        counts = {}
        for table in tables.splitlines():
            if table:
                counts[table] = int(self.psql(f"SELECT count(*) FROM {table}", db=db))
        return counts

    # A dump is only trusted once it has been restored. Every backup is restored
    # into a scratch database when it is taken, and its row counts are read THERE —
    # so they describe the dump itself, not the live database a moment later,
    # which keeps accepting writes. And --restore-db never drops the live
    # database on a hope: it restores into a new one, checks it, and swaps.

    def dump_database(self, path: Path) -> None:
        with path.open("wb") as handle:
            proc = subprocess.run(["docker", "exec", PG_CONTAINER, "pg_dump", "-U", DB_USER, "-d", DB_NAME, "-Fc"],
                                  stdout=handle, stderr=subprocess.PIPE, timeout=900)
        if proc.returncode != 0:
            raise Refused(f"pg_dump failed: {proc.stderr.decode(errors='replace')[-300:]}")

    def drop_database(self, name: str) -> None:
        if name in (DB_NAME, "postgres", "template0", "template1") or not re.match(rf"^{DB_NAME}_[a-z_]+_[0-9t]+z$", name):
            raise Refused(f"refusing to drop database {name!r}: only this tool's own copies are ever dropped")
        self.psql(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)', db="postgres")

    def restore_dump_into(self, dump: Path, name: str) -> None:
        """Restore a dump into a NEW database. pg_restore's exit status is the verdict:
        one transaction, stop at the first error, and nothing is left behind on failure."""
        self.drop_database(name)
        self.psql(f'CREATE DATABASE "{name}" TEMPLATE template0', db="postgres")
        try:
            with dump.open("rb") as handle:
                proc = subprocess.run(["docker", "exec", "-i", PG_CONTAINER, "pg_restore", "-U", DB_USER, "-d", name,
                                       "--no-owner", "--exit-on-error", "--single-transaction"],
                                      stdin=handle, capture_output=True, timeout=1800)
        except BaseException:
            # A timeout kills the docker client, not pg_restore inside the
            # container; DROP ... WITH (FORCE) ends its session too.
            try:
                self.drop_database(name)
            except Exception as error:  # noqa: BLE001 - the original failure is the one to report
                self.r.note(f"could not drop {name} ({error}); `kinerary-cp-release prune` removes it")
            raise
        if proc.returncode != 0:
            detail = proc.stderr.decode(errors="replace").strip()[-400:]
            self.drop_database(name)
            raise Refused(f"pg_restore of {dump} failed (exit {proc.returncode}): {detail}")

    def prepare_restored_database(self, dump_dir: Path, stamp: str) -> str:
        """The dump restored into a new database and proven to match it. The live
        database is not touched, and services keep running."""
        scratch = f"{DB_NAME}_restore_{stamp}"
        if self.dry_run:
            self.r.step(f"would restore {dump_dir}/db.dump into a new database {scratch} and compare every table's "
                        "count with db.counts.json — the live database untouched, no downtime")
            return scratch
        self.r.step(f"restore {dump_dir.name}/db.dump into {scratch} (the live database is not touched)")
        self.restore_dump_into(dump_dir / "db.dump", scratch)
        expected = json.loads((dump_dir / "db.counts.json").read_text())
        actual = self.table_counts(db=scratch)
        mismatched = sorted(t for t in set(expected) | set(actual) if expected.get(t) != actual.get(t))
        if mismatched:
            self.drop_database(scratch)
            raise Refused(f"the restored copy does not match the dump's counts for: {', '.join(mismatched)} — nothing was changed")
        self.r.ok(f"restored copy matches the dump: {len(expected)} tables, every row count equal")
        return scratch

    def swap_in_database(self, scratch: str, stamp: str) -> str:
        """Put the restored copy in the live database's place and keep the replaced
        one as <db>_pre_rollback_<stamp>. Needs its clients stopped."""
        aside = f"{DB_NAME}_pre_rollback_{stamp}"
        if self.dry_run:
            self.r.step(f"would rename {DB_NAME} to {aside} and {scratch} to {DB_NAME}")
            return Swap(aside, stamp)
        live = f'"{DB_NAME}"'
        self.psql(f"ALTER DATABASE {live} ALLOW_CONNECTIONS false", db="postgres")
        self.psql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '{DB_NAME}' "
                  "AND pid <> pg_backend_pid()", db="postgres")
        try:
            self.psql(f'ALTER DATABASE {live} RENAME TO "{aside}"', db="postgres")
        except Refused:
            self.psql(f"ALTER DATABASE {live} ALLOW_CONNECTIONS true", db="postgres")
            raise
        try:
            self.psql(f'ALTER DATABASE "{scratch}" RENAME TO {live}', db="postgres")
        except Refused as error:
            try:
                self.psql(f'ALTER DATABASE "{aside}" RENAME TO {live}', db="postgres")
                self.psql(f"ALTER DATABASE {live} ALLOW_CONNECTIONS true", db="postgres")
            except Refused:
                raise Refused(f"CRITICAL: the live database is now named {aside} and could not be renamed back. "
                              f"Rename it by hand: ALTER DATABASE \"{aside}\" RENAME TO {live}; "
                              f"ALTER DATABASE {live} ALLOW_CONNECTIONS true") from error
            raise
        try:
            self.psql(f'ALTER DATABASE "{aside}" ALLOW_CONNECTIONS true', db="postgres")
        except Refused as error:
            # The swap itself is done; this only matters to someone inspecting the old copy.
            self.r.note(f"{aside} still refuses connections ({error}); ALTER DATABASE \"{aside}\" ALLOW_CONNECTIONS true")
        self.r.ok(f"database replaced by the restored copy; the replaced one is kept as {aside}")
        return Swap(aside, stamp)

    def undo_swap(self, swap: Swap) -> None:
        """Put the database that was replaced back under the live name.

        The clients have been stopped since the pre-rollback backup, so the copy
        set aside is exactly the live state and this loses nothing. The restored
        copy is kept as _restore_failed_<stamp> until `prune`.
        """
        failed = f"{DB_NAME}_restore_failed_{swap.stamp}"
        if self.dry_run:
            self.r.step(f"would rename {DB_NAME} to {failed} and {swap.aside} back to {DB_NAME}")
            return
        live = f'"{DB_NAME}"'
        self.psql(f"ALTER DATABASE {live} ALLOW_CONNECTIONS false", db="postgres")
        self.psql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '{DB_NAME}' "
                  "AND pid <> pg_backend_pid()", db="postgres")
        self.psql(f'ALTER DATABASE {live} RENAME TO "{failed}"', db="postgres")
        self.psql(f'ALTER DATABASE "{swap.aside}" RENAME TO {live}', db="postgres")
        self.psql(f"ALTER DATABASE {live} ALLOW_CONNECTIONS true", db="postgres")
        self.r.ok(f"the database that was replaced is live again; the copy the rollback restored is kept as {failed}")

    def stop_database_clients(self) -> None:
        self.sh.act(self.compose("stop", "worker", "relay", "interview-mcp", "companion-mcp", "api"),
                    describe="compose stop worker relay interview-mcp companion-mcp api  (downtime: bot and signups pause)",
                    timeout=300)

    def start_database_clients(self) -> None:
        """Bring the stopped clients back on whatever version is checked out now.

        Both commands are checked: this runs where a caller is about to report
        whether production is back, and a restart that failed silently would
        turn that report into "the rollback was undone" over a stopped bot.
        """
        self.sh.act(self.compose("up", "-d", "--wait", "api", "worker", "interview-mcp", "companion-mcp"),
                    describe="compose up -d --wait api worker interview-mcp companion-mcp", timeout=900)
        self.sh.act([str(DEPLOYMENT_DIR / "vm-relay-restart.sh"), "--force-live"], describe="vm-relay-restart.sh",
                    env={"KINERARY_RELAY_READY_SECONDS": "120"}, timeout=300)

    def take_backup(self, label: str, include_hermes: bool) -> Path:
        stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
        target = BACKUP_DIR / f"{stamp}-{label}"
        if self.dry_run:
            self.r.step(f"would dump the database ({self.db_size_bytes() / 1024 ** 2:.0f} MB live) to {target}/db.dump, "
                        f"restore it into a scratch database to prove it restores and count its rows there, "
                        f"record vm.env and the Hermes profile list"
                        + (" and tar hermes-data without auth.json" if include_hermes else ""))
            return target
        BACKUP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        target.mkdir(mode=0o700)
        try:
            self.r.step(f"pg_dump → {target}/db.dump")
            dump_started = iso(utcnow())
            self.dump_database(target / "db.dump")
            verify = f"{DB_NAME}_verify_{stamp.lower()}"
            self.r.step(f"restore the dump into {verify} to prove it restores, and count its rows there")
            self.restore_dump_into(target / "db.dump", verify)
            try:
                counts = self.table_counts(db=verify)
            finally:
                self.drop_database(verify)
            (target / "db.counts.json").write_text(json.dumps(counts, indent=2, sort_keys=True))
            (target / "taken_at").write_text(dump_started + "\n")
        except Exception:
            # A directory without a proven dump must never look like a backup.
            shutil.rmtree(target, ignore_errors=True)
            raise
        shutil.copy2(VM_ENV, target / "vm.env")
        profiles = sorted(p.name for p in (HERMES_DATA / "profiles").iterdir() if p.is_dir()) if (HERMES_DATA / "profiles").exists() else []
        (target / "profiles.txt").write_text("\n".join(profiles) + "\n")
        if include_hermes:
            self.r.step(f"tar hermes-data (without auth.json) → {target}/hermes-data.tar.gz")
            proc = subprocess.run(["tar", "-C", str(HERMES_DATA), "--exclude=./auth.json", "--exclude=./auth.lock",
                                   "--exclude=*.sock", "--exclude=*.pid", "-czf", str(target / "hermes-data.tar.gz"), "."],
                                  capture_output=True, timeout=900)
            if proc.returncode not in (0, 1):  # 1 = files changed while reading; a live profile writes
                raise Refused(f"tar of hermes-data failed: {proc.stderr.decode(errors='replace')[-300:]}")
        for path in target.iterdir():
            os.chmod(path, 0o600)
        self.r.ok(f"backup written: {target} ({sum(f.stat().st_size for f in target.iterdir()) / 1024 ** 2:.1f} MB)")
        return target

    # ----------------------------------------------------------- images --
    def image_exists(self, tag: str) -> bool:
        return self.sh.read(["docker", "image", "inspect", tag], timeout=30).returncode == 0

    def kinerary_images(self, rev: str) -> List[str]:
        return [f"kinerary-cp/api:{rev}", f"kinerary-cp/worker:{rev}", f"kinerary-cp/agent-runtime:{rev}"]

    def build_images(self, full: str, short: str) -> None:
        missing = [t for t in self.kinerary_images(short) if not self.image_exists(t)]
        if not missing:
            self.r.ok(f"images for {short} already built")
            return
        worktree = Path(f"/var/tmp/kinerary-build-{short}")
        builds = [
            ["docker", "build", "-f", "control-plane/api/Dockerfile", "-t", f"kinerary-cp/api:{short}", "."],
            ["docker", "build", "-f", "control-plane/worker/Dockerfile", "-t", f"kinerary-cp/worker:{short}", "."],
            ["docker", "build", "-f", "control-plane/deployment/agent-runtime.Dockerfile",
             "--build-arg", f"BASE=kinerary-cp/api:{short}", "-t", f"kinerary-cp/agent-runtime:{short}", "."],
        ]
        if self.dry_run:
            self.r.step(f"would build {len(builds)} images for {short} in a worktree at {worktree} (~1.6 GB, before the snapshot so builds do not grow it)")
            return
        if worktree.exists():
            self.sh.read(self.git_argv("worktree", "remove", "--force", str(worktree)))
        self.sh.act(self.git_argv("worktree", "add", "--detach", str(worktree), full), describe=f"git worktree add {worktree} {short}")
        try:
            for argv in builds:
                proc = subprocess.run(argv, cwd=str(worktree), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=3600)
                self.r.step(shlex.join(argv))
                if proc.returncode != 0:
                    tail = proc.stdout.decode(errors="replace").splitlines()[-20:]
                    raise Refused("image build failed:\n      " + "\n      ".join(tail))
        finally:
            self.sh.read(self.git_argv("worktree", "remove", "--force", str(worktree)))
        self.r.ok(f"built {', '.join(self.kinerary_images(short))}")

    def validate_compose(self, full: str) -> None:
        text = self.sh.read(self.git_argv("show", f"{full}:control-plane/deployment/compose.vm.yml"), check=True).stdout
        with tempfile.NamedTemporaryFile(prefix="kinerary-compose.", suffix=".yml", delete=False) as handle:
            handle.write(text)
            temp = handle.name
        try:
            proc = self.sh.read(["docker", "compose", "--project-directory", str(DEPLOYMENT_DIR), "-f", temp,
                                 "--env-file", str(PROVISIONING_ENV), "--env-file", str(VM_ENV), "config", "-q"], timeout=60)
        finally:
            os.unlink(temp)
        if proc.returncode != 0:
            self.r.fail(f"the target's compose.vm.yml does not validate against this VM's env files and secrets: "
                        f"{proc.stderr.decode(errors='replace').strip()[-300:]}")
        else:
            self.r.ok("the target's compose.vm.yml validates against this VM's env files and secrets")

    # ---------------------------------------------------------- switch --
    def switch_to(self, full: str, short: str, hermes_rev: Optional[str], previous: Dict[str, str],
                  *, restart_hermes: bool, force_live_note: bool = True) -> None:
        """Checkout, vm.env, migrate, services, relay, hermes. Reverts on a failed migrate."""
        self.switch_code(full, short, hermes_rev, previous)
        self.start_switched(hermes_rev, restart_hermes=restart_hermes)

    def switch_code(self, full: str, short: str, hermes_rev: Optional[str], previous: Dict[str, str]) -> None:
        """Checkout, vm.env, migrate — nothing that is running is touched yet, and a
        failed migrate puts the checkout and vm.env back. Everything here is still
        undoable, which is what lets a failed rollback put its database back too."""
        self.sh.act(self.git_argv("checkout", "--quiet", "--detach", full), describe=f"git checkout --detach {short}")
        self.sh.act(self.git_argv("tag", "-f", f"deployed/{short}", full), describe=f"git tag deployed/{short}")
        updates = {"KINERARY_REV": short}
        if hermes_rev:
            updates["HERMES_REV"] = hermes_rev
        self.set_vm_env(updates)

        before = set(self.applied_migrations()) if not self.dry_run else set()
        try:
            self.sh.act(self.compose("run", "--rm", "--no-deps", "migrate"), describe=f"migrate with kinerary-cp/api:{short}", timeout=900,
                        stream_output=True)
        except Refused:
            committed = sorted(set(self.applied_migrations()) - before)
            self.r.fail("migrate failed — putting the checkout and vm.env back; no running container was touched")
            if committed:
                self.r.note(f"these migrations DID commit before the failure: {', '.join(committed)}")
            self.git("checkout", "--quiet", "--detach", previous["full"])
            self.set_vm_env({"KINERARY_REV": previous["KINERARY_REV"], "HERMES_REV": previous["HERMES_REV"]})
            raise MigrateFailed(f"migrate with {short} failed; running {previous['KINERARY_REV']} again"
                                + (f", with these new migrations committed: {', '.join(committed)}" if committed else ""))

    def start_switched(self, hermes_rev: Optional[str], *, restart_hermes: bool) -> None:
        """The point of no return: the target's containers start. From here a failure
        rolls forward (verify, then rollback), because putting an older database back
        under running newer code would strand it."""
        self.sh.act(self.compose("up", "-d", "--wait", "--remove-orphans", "api", "worker", "interview-mcp", "companion-mcp"),
                    describe="compose up -d --wait api worker interview-mcp companion-mcp  (downtime: none for trips)", timeout=900,
                    stream_output=True)
        self.sh.act([str(DEPLOYMENT_DIR / "vm-relay-restart.sh"), "--force-live"],
                    describe="vm-relay-restart.sh --force-live  (downtime: the Telegram bot pauses; messages wait at Telegram)",
                    env={"KINERARY_RELAY_READY_SECONDS": "120"}, timeout=300, stream_output=True)
        if restart_hermes:
            self.sh.act(self.compose("up", "-d", "--wait", "hermes"),
                        describe="compose up -d hermes  (downtime: companions and site AI features restart)", timeout=900)
        else:
            self.r.ok("Hermes untouched — companions and site AI features keep running")

    # ---------------------------------------------------------- verify --
    def relay_log(self) -> List[Dict]:
        proc = self.sh.read(["docker", "logs", RELAY_CONTAINER], timeout=60)
        text = proc.stdout.decode(errors="replace") + "\n" + proc.stderr.decode(errors="replace")
        events = []
        for raw in text.splitlines():
            start = raw.find("{")
            if start < 0:
                continue
            try:
                events.append(json.loads(raw[start:]))
            except ValueError:
                events.append({"raw": raw})
        return events

    def live_companions(self) -> List[Tuple[str, str]]:
        rows = self.psql(
            "SELECT DISTINCT t.slug || '|' || b.hermes_profile FROM control_plane.telegram_chat_bindings b "
            "JOIN control_plane.trips t ON t.id = b.trip_id WHERE b.closed_at IS NULL AND b.hermes_profile IS NOT NULL "
            "AND t.reachability <> 'unreachable' ORDER BY 1")
        return [tuple(row.split("|", 1)) for row in rows.splitlines() if "|" in row]  # type: ignore[misc]

    def verify(self) -> bool:
        before = self.r.failures
        env = self.vm_env()
        rev, hermes_rev = env.get("KINERARY_REV", ""), env.get("HERMES_REV", "")
        self.r.head(f"Verify — KINERARY_REV={rev} HERMES_REV={hermes_rev}")

        ready, body = self.readyz()
        (self.r.ok if ready else self.r.fail)(f"readyz: {'ready' if ready else body}")
        head = self.git("rev-parse", "--short=7", "HEAD", check=False)
        (self.r.ok if head == rev else self.r.fail)(f"checkout HEAD {head} {'matches' if head == rev else 'does not match'} KINERARY_REV")
        try:
            files = set(self.migration_files("HEAD"))
            applied = set(self.applied_migrations())
            missing = sorted(files - applied)
            extra = sorted(applied - files)
            (self.r.ok if not missing else self.r.fail)(
                f"{len(files)} migration(s) in the checkout {'all applied' if not missing else 'NOT applied: ' + ', '.join(missing)}")
            if extra:
                self.r.note(f"the database carries {len(extra)} newer migration(s) this version does not know: {', '.join(extra)}")
        except Refused as error:
            self.r.fail(f"migrations: {error}")

        ps = self.sh.text(["docker", "ps", "--format", "{{.Names}}\t{{.Image}}"])
        running = dict(line.split("\t", 1) for line in ps.splitlines() if "\t" in line)
        for name in ("api", "worker", "relay", "interview-mcp", "companion-mcp"):
            container = f"{COMPOSE_PROJECT}-{name}-1"
            image = running.get(container, "")
            (self.r.ok if image.endswith(f":{rev}") else self.r.fail)(f"{container}: {image or 'NOT RUNNING'}")
        image = running.get(HERMES_CONTAINER, "")
        (self.r.ok if image.endswith(f":{hermes_rev}") else self.r.fail)(f"{HERMES_CONTAINER}: {image or 'NOT RUNNING'}")

        events = self.relay_log()
        identity = [e for e in events if e.get("event") == "relay.bot_identity"]
        bot = identity[-1].get("username") if identity else None
        expected_bot = self.site["CP_EXPECT_BOT"]
        (self.r.ok if bot == expected_bot else self.r.fail)(f"relay bot: @{bot or 'unknown'} (expected @{expected_bot})")
        polling = [e for e in events if e.get("event") == "relay.ready"]
        (self.r.ok if polling and polling[-1].get("polling") else self.r.fail)("relay reported relay.ready with polling")
        conflicts = [e for e in events if e.get("event") == "telegram_api.get_updates_failed" and e.get("status") == 409]
        (self.r.ok if not conflicts else self.r.fail)(
            "no 409/Conflict — this relay is the only getUpdates loop" if not conflicts else f"{len(conflicts)} 409/Conflict line(s) — a second poller exists")

        source = REPO / "control-plane" / "api" / "src" / "interview-mcp.ts"
        expected_tools = extract_agent_tools(source.read_text()) if source.exists() else []
        agent_log = HERMES_DATA / "profiles" / "trip-intake" / "logs" / "agent.log"
        registered = ""
        if agent_log.exists():
            for raw in agent_log.read_text(errors="replace").splitlines():
                if re.search(r"MCP server 'interview'.*registered.*tool\(s\):", raw):
                    registered = raw
        if not expected_tools:
            self.r.note("could not extract the *_for_chat tool list from interview-mcp.ts — gateway tools not checked")
        else:
            missing_tools = [t for t in expected_tools if f"mcp__interview__{t}" not in registered]
            (self.r.ok if not missing_tools else self.r.fail)(
                f"trip-intake registered all {len(expected_tools)} *_for_chat tools" if not missing_tools
                else f"trip-intake is MISSING tools: {', '.join(missing_tools)}")

        creds = self.sh.text(["sudo", "-u", "hermes", "-H", "hermes", "auth", "list"], timeout=60)
        count = len(re.findall(r"openai-codex|anthropic|openrouter|ollama", creds))
        (self.r.ok if count else self.r.fail)(f"Hermes has {count} provider credential entr{'y' if count == 1 else 'ies'}")

        awaited = [e for e in events if e.get("event") == "relay.gateways_awaited"]
        connected_ids = {e.get("gateway_id") for e in events if e.get("event") == "relay.gateway_connected"}
        for slug, profile in self.live_companions():
            if awaited:
                gone = profile in (awaited[-1].get("missing") or [])
                ok = not gone or profile in connected_ids
            else:
                ok = profile in connected_ids
            (self.r.ok if ok else self.r.fail)(f"trip {slug}: companion {profile} {'connected to the relay' if ok else 'NOT connected to the relay'}")
            env_file = DEPLOY_ROOT / "trips" / slug / "mcp" / ".env"
            if not env_file.exists():
                self.r.note(f"trip {slug}: no trip-mcp bridge configured")
                continue
            port = read_env_text(env_file.read_text()).get("MCP_PORT", "")
            listening = bool(port) and bool(self.sh.text(["ss", "-ltnH", f"sport = :{port}"]).strip())
            (self.r.ok if listening else self.r.fail)(
                f"trip {slug}: trip-mcp bridge {'listening on' if listening else 'NOT listening on'} :{port or '?'}"
                + ("" if listening else " — run: kinerary-cp-release restart-bridges"))
        return self.r.failures == before

    # ----------------------------------------------------------- notify --
    def notify(self, text: str) -> bool:
        """Tell Dror through the trip bot. sendMessage only — never getUpdates,
        which belongs to the relay. The token stays in this process's memory."""
        if self.dry_run:
            self.r.step("would send Dror a Telegram message through the trip bot")
            return True
        try:
            token = (SECRETS_DIR / "telegram_creds").read_text().strip()
            chat = (SECRETS_DIR / "telegram_super_admin_chat_id").read_text().strip()
            data = urllib.parse.urlencode({"chat_id": chat, "text": text, "disable_web_page_preview": "true"}).encode()
            request = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data)
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.loads(response.read().decode()).get("ok") is True
        except Exception:  # noqa: BLE001 - the error text could carry the URL, and with it the token
            return False


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def current_versions(cp: ControlPlane) -> Dict[str, str]:
    env = cp.vm_env()
    return {"KINERARY_REV": env.get("KINERARY_REV", ""), "HERMES_REV": env.get("HERMES_REV", ""),
            "full": cp.git("rev-parse", "HEAD", check=False)}


def cmd_status(cp: ControlPlane) -> int:
    r = cp.r
    versions = current_versions(cp)
    r.head("Running")
    r.ok(f"KINERARY_REV={versions['KINERARY_REV']}  HERMES_REV={versions['HERMES_REV']}  checkout {versions['full'][:7]} \"{cp.subject('HEAD')}\"")
    ready, body = cp.readyz()
    (r.ok if ready else r.fail)(f"readyz {'ready' if ready else body}")
    r.head("History (latest 5)")
    rows = read_history()
    for row in rows[-5:]:
        r.line(f"  {row['utc']}  {row['action']:<9} {row['from_rev']} → {row['to_rev']}  {row['result']}  {row['actor']}  {row['snapshot']}")
    if rows and rows[-1]["result"] == "switching":
        # Written before the switch and superseded when it ends: still there means
        # the run died mid-switch (killed, or the VM went down under it).
        r.note(f"the {rows[-1]['action']} of {rows[-1]['utc']} never finished — run `kinerary-cp-release verify`. "
               "If it was a --restore-db rollback, the database it replaced is the newest "
               f"{DB_NAME}_pre_rollback_* copy (`prune --dry-run` lists them) and nothing has been dropped.")
    r.head(f"Snapshots of VM {cp.vmid}")
    try:
        now = time.time()
        for name, snaptime, desc in cp.snapshot_list():
            age = (now - snaptime) / 86400
            if not name.startswith("pre-"):
                r.note(f"{name}  {age:.1f} days  {desc}  — made by hand: never pruned here, but it grows as the disk "
                       "changes and counts toward the pool's worst case; delete it when it is no longer needed")
            else:
                (r.note if age > SNAPSHOT_WARN_AGE_DAYS else r.ok)(f"{name}  {age:.1f} days  {desc}")
    except Refused as error:
        r.note(str(error))
    r.head("Storage")
    code, output = cp.proxmox("preflight")
    values, _, _ = parse_runner_output(output)
    for key, value in values.items():
        if key.startswith("pool."):
            r.ok(f"{key[5:]}: {value}")
    cp.guard_storage()
    pending = Requests(STATE_DIR / "requests").pending()
    r.head("Pending agent requests")
    if not pending:
        r.ok("none")
    for request in pending:
        r.note(f"{request['id']}: {' '.join(request['action'])} (expires {iso(dt.datetime.fromtimestamp(request['expires_at'], dt.timezone.utc))})")
    return 0


def cmd_plan(cp: ControlPlane, rev: str) -> int:
    r = cp.r
    cp.fetch()
    full, short = cp.resolve(rev)
    versions = current_versions(cp)
    r.head(f"Plan: {versions['KINERARY_REV']} → {short}")
    r.ok(f"target {short} \"{cp.subject(full)}\"")
    ahead = cp.git("rev-list", "--count", f"{versions['full']}..{full}", check=False)
    r.ok(f"{ahead or '?'} commit(s) ahead of the running checkout")
    applied = set(cp.applied_migrations())
    files = set(cp.migration_files(full))
    unknown = sorted(applied - files)
    if unknown:
        r.fail(f"the database has migrations {short} does not contain ({', '.join(unknown)}) — that is a downgrade, use rollback")
    verdict, details = classify_migrations(files - applied, cp.declaration_from([full]))
    cp.show_migration_verdict("New migrations", verdict, details)
    if details:
        (r.ok if verdict == "compatible" else r.note)(
            "a later rollback can keep the database" if verdict == "compatible"
            else "a later rollback will need --restore-db (or --keep-db after reading the reasons)")
    for tag in cp.kinerary_images(short):
        (r.ok if cp.image_exists(tag) else r.note)(f"{tag} {'present' if cp.image_exists(tag) else 'will be built'}")
    return 1 if r.failures else 0


def cmd_upgrade(cp: ControlPlane, rev: str, hermes_rev: Optional[str], force_live: bool) -> int:
    r = cp.r
    r.head("1/5 Prepare" + ("  [DRY RUN — nothing will change]" if cp.dry_run else ""))
    cp.fetch()
    full, short = cp.resolve(rev)
    versions = current_versions(cp)
    previous = {**versions}
    if short == versions["KINERARY_REV"] and (not hermes_rev or hermes_rev == versions["HERMES_REV"]):
        r.ok(f"already running {short}")
        return 0
    r.ok(f"{versions['KINERARY_REV']} → {short} \"{cp.subject(full)}\"")
    r.fact("target", f"{versions['KINERARY_REV']} -> {short} \"{cp.subject(full)}\"")
    cp.guard_checkout_clean()
    applied = set(cp.applied_migrations())
    files = set(cp.migration_files(full))
    unknown = sorted(applied - files)
    if unknown:
        r.fail(f"the database has migrations {short} lacks ({', '.join(unknown)}) — refusing a downgrade; use rollback")
    verdict, details = classify_migrations(files - applied, cp.declaration_from([full]))
    cp.show_migration_verdict("New migrations", verdict, details)
    r.fact("rollback", "code-only rollback keeps the database" if verdict == "compatible" else "rollback would need --restore-db")
    hermes_changes = bool(hermes_rev) and hermes_rev != versions["HERMES_REV"]
    if hermes_changes:
        tag = f"kinerary-cp/hermes:{hermes_rev}"
        (r.ok if cp.image_exists(tag) else r.fail)(f"{tag} {'present' if cp.image_exists(tag) else 'missing — build it first (runbook: Hermes)'}")
    cp.validate_compose(full)
    cp.guard_storage(extra_bytes=cp.db_size_bytes() + (2 * 1024 ** 3))
    cp.refuse_if_failed("nothing was changed")
    cp.build_images(full, short)

    r.head("2/5 Guards")
    cp.guard_jobs()
    cp.guard_interview(force_live)
    doomed_snapshots = snapshots_to_prune(cp.snapshot_list(), time.time(), keep_newest=1, max_age_days=None)
    if doomed_snapshots:
        r.ok(f"will delete older release snapshot(s) before taking a new one: {', '.join(doomed_snapshots)}")
    code, output = cp.proxmox("preflight", ignore_snapshots=doomed_snapshots)
    cp.show_runner(output)
    if code != 0 and not parse_runner_output(output)[1]:
        r.fail(f"could not run the snapshot preflight on the Proxmox host: {output.strip()[-200:]}")
    cp.refuse_if_failed("nothing was changed")

    r.head("3/5 Safety point (no downtime)")
    for name in doomed_snapshots:
        cp.delete_snapshot(name)
    backup = cp.take_backup(f"{versions['KINERARY_REV']}-to-{short}", include_hermes=hermes_changes)
    snapshot = f"pre-{short}-{utcnow().strftime('%Y%m%d%H%M')}"
    if cp.dry_run:
        r.step(f"would snapshot VM {cp.vmid} as {snapshot} on the Proxmox host: --vmstate 0, 120 s limit, "
               f"host-side thaw/unlock/cleanup if it stalls; a thin volume in the VM's own pool, nothing on NFS")
    else:
        r.step(f"snapshot VM {cp.vmid} as {snapshot} (the guest's filesystems freeze for a moment)")
        code, output = cp.proxmox("create", snapshot, f"{versions['KINERARY_REV']} -> {short}", timeout=420)
        cp.show_runner(output, only_failures=True)
        if code != 0:
            append_history({"utc": iso(utcnow()), "action": "upgrade", "from_rev": versions["KINERARY_REV"], "to_rev": short,
                            "hermes_from": versions["HERMES_REV"], "hermes_to": hermes_rev or versions["HERMES_REV"],
                            "backup_dir": str(backup), "verdict": verdict, "result": "snapshot-failed", "actor": cp.actor})
            raise Refused(f"snapshot failed — nothing was switched; the dump is kept at {backup}")
        r.ok(f"snapshot {snapshot} taken")

    r.head("4/5 Switch")
    record = {"action": "upgrade", "from_rev": versions["KINERARY_REV"], "to_rev": short,
              "hermes_from": versions["HERMES_REV"], "hermes_to": hermes_rev if hermes_changes else versions["HERMES_REV"],
              "snapshot": snapshot, "backup_dir": str(backup), "verdict": verdict, "actor": cp.actor}
    if not cp.dry_run:
        # Before anything switches: if this process dies mid-switch, the way back
        # (from_rev, dump, snapshot) is already on record.
        append_history({**record, "utc": iso(utcnow()), "result": "switching"})
    try:
        cp.switch_to(full, short, hermes_rev if hermes_changes else None, previous, restart_hermes=hermes_changes)
    except MigrateFailed:
        if not cp.dry_run:
            append_history({**record, "utc": iso(utcnow()), "result": "migrate-failed"})
            r.line(f"The way back from any migrations that committed: kinerary-cp-release rollback --restore-db")
        raise
    except Refused:
        if not cp.dry_run:
            append_history({**record, "utc": iso(utcnow()), "result": "switch-failed"})
            r.line(f"Switched to {short} but a service did not come up. The way back: kinerary-cp-release rollback"
                   + ("" if verdict == "compatible" else " --restore-db"))
        raise

    r.head("5/5 Verify")
    if cp.dry_run:
        r.step("would verify: readyz, migrations, image tags, relay bot + polling + no 409, trip-intake tools, "
               "Hermes credentials, every live trip's companion and trip-mcp bridge")
        r.line()
        r.line(f"Dry run complete: {r.failures} problem(s). Nothing was changed.")
        return 1 if r.failures else 0
    ok = cp.verify()
    append_history({**record, "utc": iso(utcnow()), "result": "ok" if ok else "verify-failed"})
    back = "kinerary-cp-release rollback" + ("" if verdict == "compatible" else " --restore-db")
    if ok:
        install_tool_files(cp, quiet=True)
        prune_after_upgrade(cp)
        r.line(); r.line(f"Upgraded to {short}. The way back: {back}")
        cp.notify(f"Kinerary control plane upgraded {versions['KINERARY_REV']} -> {short} ({cp.actor}). Verify passed.\nWay back: {back}")
        return 0
    r.line(); r.line(f"Upgraded to {short}, but verify FAILED. To go back: {back}")
    cp.notify(f"Kinerary control plane upgraded {versions['KINERARY_REV']} -> {short} ({cp.actor}) but VERIFY FAILED.\nTo go back: {back}")
    return 2


def cmd_rollback(cp: ControlPlane, to: Optional[str], restore_db: bool, keep_db: bool, restore_hermes: bool, force_live: bool) -> int:
    r = cp.r
    r.head("1/5 Target" + ("  [DRY RUN — nothing will change]" if cp.dry_run else ""))
    rows = read_history()
    versions = current_versions(cp)
    upgrade = recovery_point(rows, versions["KINERARY_REV"], to=to)
    if to:
        known = {row["from_rev"] for row in rows} | {row["to_rev"] for row in rows}
        target_short = next((k for k in known if k and (k.startswith(to) or to.startswith(k))), None)
        if not target_short:
            raise Refused(f"{to} is not a version this VM has run (see: kinerary-cp-release history)")
    else:
        if not upgrade:
            raise Refused("no recorded upgrade describes what is running now — name the version: rollback --to <rev>")
        target_short = upgrade["from_rev"]
        if upgrade["result"] != "ok":
            r.note(f"recovering from an upgrade that ended '{upgrade['result']}' ({upgrade['utc']})")
    full = cp.git("rev-parse", "--verify", f"{target_short}^{{commit}}")
    short = full[:7]
    hermes_target = upgrade["hermes_from"] if upgrade and upgrade.get("hermes_from") else versions["HERMES_REV"]
    hermes_changes = hermes_target != versions["HERMES_REV"]
    r.ok(f"{versions['KINERARY_REV']} → {short} \"{cp.subject(full)}\"" + (f", Hermes {versions['HERMES_REV']} → {hermes_target}" if hermes_changes else ""))
    r.fact("target", f"{versions['KINERARY_REV']} -> {short} \"{cp.subject(full)}\"")
    for tag in cp.kinerary_images(short):
        (r.ok if cp.image_exists(tag) else r.fail)(f"{tag} {'present' if cp.image_exists(tag) else 'MISSING — pruned? rebuild it or pick another target'}")
    if hermes_changes:
        (r.ok if cp.image_exists(f"kinerary-cp/hermes:{hermes_target}") else r.fail)(f"kinerary-cp/hermes:{hermes_target}")

    r.head("2/5 What happens to the database")
    applied = set(cp.applied_migrations())
    files = set(cp.migration_files(full))
    newer = applied - files
    verdict, details = classify_migrations(newer, cp.declaration_from(["HEAD"] + [row["to_rev"] for row in reversed(rows)]))
    cp.show_migration_verdict("Migrations newer than the target", verdict, details)
    dump_dir = Path(upgrade["backup_dir"]) if upgrade and upgrade.get("backup_dir") else None
    if restore_db:
        if not dump_dir or not (dump_dir / "db.dump").exists():
            r.fail("no pre-upgrade dump recorded for this version change — --restore-db is not possible")
        else:
            since = (dump_dir / "taken_at").read_text().strip() if (dump_dir / "taken_at").exists() else upgrade["utc"]
            r.ok(f"will restore {dump_dir}/db.dump, taken {since}")
            built = cp.psql(f"SELECT string_agg(slug || ' (' || lifecycle_state || ')', ', ') FROM control_plane.trips "
                            f"WHERE updated_at > '{since}' AND lifecycle_state IN {BUILT_STATES}")
            jobs = cp.psql(f"SELECT count(*) FROM control_plane.jobs WHERE created_at > '{since}'")
            profiles_then = set((dump_dir / "profiles.txt").read_text().split()) if (dump_dir / "profiles.txt").exists() else set()
            profiles_now = {p.name for p in (HERMES_DATA / "profiles").iterdir() if p.is_dir()} if (HERMES_DATA / "profiles").exists() else set()
            new_profiles = sorted(profiles_now - profiles_then) if profiles_then else []
            if built or jobs != "0" or new_profiles:
                r.fail("refused: trips were built since the dump — their container, DNS, proxy host and companion would outlive a "
                       f"database that no longer knows them. Built: {built or 'none'}; jobs since: {jobs}; new profiles: "
                       f"{', '.join(new_profiles) or 'none'}. Tear those trips down first, or roll back without --restore-db.")
            lost = []
            for table in ("trips", "intake_sessions", "intake_versions", "telegram_chat_bindings", "jobs"):
                count = cp.psql(f"SELECT count(*) FROM control_plane.{table} WHERE created_at > '{since}'", check=False)
                if count and count != "0":
                    lost.append(f"{count} {table}")
            (r.note if lost else r.ok)("rows created since the dump that the restore discards: " + (", ".join(lost) or "none"))
    elif newer and verdict != "compatible":
        if keep_db:
            r.note("keeping the newer database although a migration is not declared compatible (--keep-db): read the reasons above")
        else:
            r.fail("a newer migration is not declared compatible — choose --restore-db, or --keep-db after reading the reasons above")
    else:
        r.ok("keeping the database as it is — every newer migration is declared compatible" if newer else "no newer migrations — keeping the database")
    newest = cp.psql("SELECT source_revision FROM control_plane.releases WHERE status='available' ORDER BY created_at DESC LIMIT 1", check=False)
    if newest and cp.sh.read(cp.git_argv("merge-base", "--is-ancestor", newest, full)).returncode != 0:
        r.note(f"the newest available site release ({newest[:7]}) is newer than {short}: trips provisioned after this rollback "
               "pair this older worker with newer site code")
    if restore_hermes and not (hermes_changes and dump_dir and (dump_dir / "hermes-data.tar.gz").exists()):
        r.fail("--restore-hermes needs an upgrade that changed HERMES_REV and a hermes-data backup")

    r.head("3/5 Guards")
    cp.guard_jobs()
    cp.guard_interview(force_live)
    cp.guard_storage(extra_bytes=cp.db_size_bytes())
    cp.refuse_if_failed("nothing was changed")

    r.head("4/5 Switch")
    pre_label = f"{versions['KINERARY_REV']}-before-rollback-to-{short}"
    record = {"action": "rollback", "from_rev": versions["KINERARY_REV"], "to_rev": short,
              "hermes_from": versions["HERMES_REV"], "hermes_to": hermes_target, "backup_dir": str(dump_dir or ""),
              "verdict": "restore-db" if restore_db else ("keep-db" if newer else "no-newer-migrations"), "actor": cp.actor}
    if not cp.dry_run:
        # Before anything changes: a run that dies mid-rollback still leaves a row.
        append_history({**record, "utc": iso(utcnow()), "result": "switching"})
    undo = prepare_rollback(cp, restore_db=restore_db, dump_dir=dump_dir, pre_label=pre_label,
                            restore_hermes=restore_hermes, hermes_changes=hermes_changes)
    previous = {**versions}
    hermes_rev = hermes_target if hermes_changes else None
    result = "switch-failed"

    def undone() -> None:
        nonlocal result
        result = "undone"

    try:
        switch_with_undo(cp, undo, lambda: cp.switch_code(full, short, hermes_rev, previous),
                         lambda: cp.start_switched(hermes_rev, restart_hermes=hermes_changes or restore_hermes),
                         on_undone=undone)
    except BaseException:
        if not cp.dry_run:
            append_history({**record, "utc": iso(utcnow()), "result": result})
        raise

    r.head("5/5 Verify")
    if cp.dry_run:
        r.step("would verify: readyz, migrations, image tags, relay, trip-intake tools, Hermes credentials, live trips")
        r.line(); r.line(f"Dry run complete: {r.failures} problem(s). Nothing was changed.")
        return 1 if r.failures else 0
    ok = cp.verify()
    append_history({**record, "utc": iso(utcnow()), "result": "ok" if ok else "verify-failed"})
    cp.notify(f"Kinerary control plane rolled back {versions['KINERARY_REV']} -> {short} ({cp.actor})"
              f"{' with the database restored' if restore_db else ''}. Verify {'passed' if ok else 'FAILED'}.")
    return 0 if ok else 2


def restore_database_for_rollback(cp: ControlPlane, dump_dir: Path, pre_label: str) -> Swap:
    """--restore-db without ever betting the live database on the restore.

    1. Restore the dump into a new database and prove it matches (services up).
    2. Stop the database's clients.
    3. Back the live database up, now that nothing writes to it — the exact
       state the rollback discards, itself proven restorable.
    4. Swap the restored copy in; the replaced database is kept aside.
    If 2-4 fail, the copy is dropped and the clients come back on the untouched
    database. Nothing is switched until this returns, and what it returns is what
    undoes the swap if the switch then fails.
    """
    stamp = utcnow().strftime("%Y%m%dt%H%M%Sz")
    scratch = cp.prepare_restored_database(dump_dir, stamp)
    try:
        cp.stop_database_clients()
        cp.take_backup(pre_label, include_hermes=False)
        return cp.swap_in_database(scratch, stamp)
    except BaseException as failure:
        # Whatever stopped it — a refusal, a pg_dump past its timeout, a full
        # disk, Ctrl-C — the clients this stopped come back before the failure
        # goes any further, and nothing in the cleanup may keep them down.
        try:
            cp.drop_database(scratch)
        except Exception as error:  # noqa: BLE001 - a leftover copy is prune's job; the services are not
            cp.r.note(f"could not drop {scratch} ({error}); `kinerary-cp-release prune` removes it")
        try:
            cp.start_database_clients()
        except Exception as error:  # noqa: BLE001 - reported with the failure that caused it
            restart = shlex.join(cp.compose("up", "-d", "--wait", "api", "worker", "interview-mcp", "companion-mcp"))
            raise Refused(f"--restore-db failed ({type(failure).__name__}: {failure}), and the services it had stopped "
                          f"could not be started again ({type(error).__name__}: {error}). The bot and signups are "
                          f"STOPPED on the untouched database. Start them: {restart} && "
                          f"{DEPLOYMENT_DIR / 'vm-relay-restart.sh'} --force-live") from failure
        raise


def switch_with_undo(cp: ControlPlane, undo: Sequence[Undo], switch_code: Callable[[], None],
                     start_services: Callable[[], None], *, on_undone: Optional[Callable[[], None]] = None) -> None:
    """Switch to the target, with one point of no return: the moment its services start.

    Before it, everything this rollback already changed is put back — each entry
    in `undo`, newest first — and the previous version comes back up on it. The
    database loses nothing (its clients have been stopped since the pre-rollback
    backup) and neither does hermes-data (Hermes has been stopped since it was
    moved aside). After the services start, the target is running: an older
    database or profile directory underneath it would strand it, so that failure
    rolls forward (`verify`, then `rollback`).
    """
    try:
        switch_code()
    except BaseException as failure:
        if not undo:  # nothing had been changed yet
            raise
        problems = []
        for entry in reversed(list(undo)):
            try:
                entry.put_back()
            except Exception as error:  # noqa: BLE001 - every step is attempted, then all of them reported
                problems.append(f"{entry.what} ({type(error).__name__}: {error}) — by hand: {entry.by_hand}")
        if problems:
            raise Refused(f"the rollback failed ({type(failure).__name__}: {failure}) and undoing it did not finish: "
                          + "; ".join(problems)) from failure
        cp.r.note("the rollback was undone: the version, the database and Hermes from before it are back, "
                  "and nothing was lost")
        if on_undone:
            on_undone()
        raise
    start_services()


def database_undo(cp: ControlPlane, swap: Swap) -> Undo:
    def put_back() -> None:
        cp.undo_swap(swap)
        cp.start_database_clients()

    restart = shlex.join(cp.compose("up", "-d", "--wait", "api", "worker", "interview-mcp", "companion-mcp"))
    return Undo("the database", put_back,
                f'on {PG_CONTAINER}: ALTER DATABASE "{DB_NAME}" RENAME TO "{DB_NAME}_restore_failed_{swap.stamp}"; '
                f'ALTER DATABASE "{swap.aside}" RENAME TO "{DB_NAME}"; '
                f'ALTER DATABASE "{DB_NAME}" ALLOW_CONNECTIONS true — then {restart} '
                f"&& {DEPLOYMENT_DIR / 'vm-relay-restart.sh'} --force-live")


def hermes_undo(cp: ControlPlane, aside: Path) -> Undo:
    return Undo("Hermes's data", lambda: undo_hermes_data(cp, aside),
                f"rm -rf {HERMES_DATA} && mv {aside} {HERMES_DATA} && "
                + shlex.join(cp.compose("up", "-d", "--wait", "hermes")))


def prepare_rollback(cp: ControlPlane, *, restore_db: bool, dump_dir: Optional[Path], pre_label: str,
                     restore_hermes: bool, hermes_changes: bool) -> List[Undo]:
    """Everything a rollback changes before it switches anything, and how to put
    each of them back. Returned newest last, which is the order they are undone
    in reverse."""
    undo: List[Undo] = []
    if restore_db and dump_dir:
        undo.append(database_undo(cp, restore_database_for_rollback(cp, dump_dir, pre_label)))
    else:
        cp.take_backup(pre_label, include_hermes=False)
    if restore_hermes and dump_dir and hermes_changes:
        undo.append(hermes_undo(cp, restore_hermes_data(cp, dump_dir)))
    return undo


def restore_hermes_data(cp: ControlPlane, dump_dir: Path) -> Path:
    """hermes-data from the upgrade's backup, keeping the CURRENT auth.json (refresh
    tokens are single-use). The current directory goes back if the restore fails,
    and the path it was kept at is returned so a failed SWITCH can put it back too
    — Hermes is stopped from here until something starts it again.""" 
    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    aside = HERMES_DATA.with_name(f"{HERMES_DATA.name}.before-rollback-{stamp}")
    cp.sh.act(["docker", "stop", HERMES_CONTAINER], describe="docker stop hermes")
    cp.sh.act(["mv", str(HERMES_DATA), str(aside)], describe=f"keep current hermes-data at {aside}")
    try:
        cp.sh.act(["install", "-d", "-o", "10000", "-g", "10000", "-m", "0700", str(HERMES_DATA)], describe=f"recreate {HERMES_DATA}")
        cp.sh.act(["tar", "-C", str(HERMES_DATA), "-xzf", str(dump_dir / "hermes-data.tar.gz")], describe="restore hermes-data from the upgrade's backup")
        cp.sh.act(["cp", "-p", str(aside / "auth.json"), str(HERMES_DATA / "auth.json")],
                  describe="carry the CURRENT auth.json across (refresh tokens are single-use)")
        cp.sh.act(["chown", "-R", "10000:10000", str(HERMES_DATA)], describe="chown hermes-data to the hermes uid")
    except BaseException:
        if not cp.dry_run and aside.is_dir():
            cp.sh.act(["rm", "-rf", str(HERMES_DATA)], describe="remove the half-restored hermes-data", check=False)
            cp.sh.act(["mv", str(aside), str(HERMES_DATA)], describe="put the current hermes-data back", check=False)
        raise
    return aside


def undo_hermes_data(cp: ControlPlane, aside: Path) -> None:
    """Put back the hermes-data a rollback replaced, and start Hermes on it.

    Nothing is lost: Hermes has been stopped since the directory was moved aside,
    so the copy kept there is the live one, and what this removes came out of a
    backup that is still on disk."""
    if not cp.dry_run and not aside.is_dir():
        raise Refused(f"{aside} is gone — hermes-data cannot be put back by this tool; "
                      f"the backup it was restored from is in the rollback's dump directory")
    cp.sh.act(["rm", "-rf", str(HERMES_DATA)], describe="remove the hermes-data this rollback restored")
    cp.sh.act(["mv", str(aside), str(HERMES_DATA)], describe=f"put {aside.name} back as {HERMES_DATA.name}")
    cp.sh.act(cp.compose("up", "-d", "--wait", "hermes"),
              describe="compose up -d hermes  (companions and site AI features come back)", timeout=900)


def cmd_restart_bridges(cp: ControlPlane) -> int:
    r = cp.r
    r.head("Restart trip-mcp bridges and their companions" + ("  [DRY RUN]" if cp.dry_run else ""))
    trips = cp.live_companions()
    if not trips:
        r.ok("no live trip has a companion")
    for slug, profile in trips:
        trip_dir = DEPLOY_ROOT / "trips" / slug
        if not (trip_dir / "mcp" / ".env").exists():
            r.note(f"{slug}: no bridge configured")
            continue
        cp.sh.act(["sudo", "-u", "hermes", "-H", "env", f"REPO_ROOT={REPO}", f"KINERARY_DEPLOY_ROOT={DEPLOY_ROOT}",
                   str(DEPLOY_ROOT / "setup-mcp.sh"), "--restart-only", "--trip-dir", str(trip_dir)],
                  describe=f"{slug}: setup-mcp.sh --restart-only", timeout=180, check=False)
        cp.sh.act(["sudo", "-u", "hermes", "-H", "hermes", "-p", profile, "gateway", "stop"], describe=f"{profile}: gateway stop",
                  timeout=120, check=False)
        cp.sh.act(["sudo", "-u", "hermes", "-H", "hermes", "-p", profile, "gateway", "start"], describe=f"{profile}: gateway start",
                  timeout=120, check=False)
    if not cp.dry_run:
        time.sleep(20)
        cp.verify()
    return 1 if r.failures else 0


def prune_after_upgrade(cp: ControlPlane) -> None:
    try:
        doomed = backups_to_prune(cp.backup_dirs(), keep=BACKUP_KEEP, max_total_bytes=BACKUP_MAX_TOTAL_GB * 1024 ** 3)
        for name in doomed:
            cp.sh.act(["rm", "-rf", str(BACKUP_DIR / name)], describe=f"remove old backup {name}")
    except Refused as error:
        cp.r.note(f"backup pruning skipped: {error}")


def cmd_prune(cp: ControlPlane) -> int:
    r = cp.r
    r.head("Prune" + ("  [DRY RUN — nothing will change]" if cp.dry_run else ""))
    now = time.time()
    try:
        snapshots = cp.snapshot_list()
        doomed = snapshots_to_prune(snapshots, now, keep_newest=2, max_age_days=SNAPSHOT_MAX_AGE_DAYS)
        releases = [s for s in snapshots if s[0].startswith("pre-")]
        r.ok(f"{len(releases)} release snapshot(s); removing {len(doomed)} (older than {SNAPSHOT_MAX_AGE_DAYS} days or beyond 2; never the newest)")
        for name in doomed:
            cp.delete_snapshot(name)
    except Refused as error:
        r.fail(str(error))
    backups = cp.backup_dirs()
    doomed_backups = backups_to_prune(backups, keep=BACKUP_KEEP, max_total_bytes=BACKUP_MAX_TOTAL_GB * 1024 ** 3)
    r.ok(f"{len(backups)} backup dir(s); removing {len(doomed_backups)}")
    for name in doomed_backups:
        cp.sh.act(["rm", "-rf", str(BACKUP_DIR / name)], describe=f"remove backup {name}")
    rows = read_history()
    keep = {cp.vm_env().get("KINERARY_REV", "")}
    for row in rows[-IMAGE_KEEP_HISTORY_ROWS:]:
        keep |= {row["from_rev"], row["to_rev"]}
    tags = cp.sh.text(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"]).split()
    doomed_images = images_to_prune(tags, keep)
    r.ok(f"keeping images for {', '.join(sorted(k for k in keep if k))}; removing {len(doomed_images)} image tag(s)")
    for tag in doomed_images:
        cp.sh.act(["docker", "image", "rm", tag], describe=f"docker image rm {tag}", check=False)
    help_text = cp.sh.text(["docker", "builder", "prune", "--help"])
    flag = "--keep-storage" if "--keep-storage" in help_text else "--max-used-space"
    cp.sh.act(["docker", "builder", "prune", "-f", flag, BUILD_CACHE_KEEP], describe=f"docker builder prune {flag} {BUILD_CACHE_KEEP}", check=False)
    cp.sh.act(cp.git_argv("worktree", "prune"), describe="git worktree prune", check=False)
    try:
        names = cp.psql("SELECT datname FROM pg_database ORDER BY 1", db="postgres").splitlines()
        doomed_databases = databases_to_prune(names)
        r.ok(f"removing {len(doomed_databases)} database copies (scratch restores, and replaced databases beyond the newest)")
        for name in doomed_databases:
            if cp.dry_run:
                r.step(f"would drop database {name}")
            else:
                cp.drop_database(name)
                r.step(f"dropped database {name}")
    except Refused as error:
        r.fail(f"could not prune database copies: {error}")
    for path in (STATE_DIR / "requests").glob("r-*.json") if (STATE_DIR / "requests").exists() else []:
        if now - path.stat().st_mtime > 7 * 86400:
            cp.sh.act(["rm", "-f", str(path)], describe=f"remove old request {path.name}")
    return 1 if r.failures else 0


def install_tool_files(cp: ControlPlane, quiet: bool = False) -> None:
    sources = {
        DEPLOYMENT_DIR / "vm-release.py": INSTALLED_TOOL,
        DEPLOYMENT_DIR / "vm-release-gate.sh": INSTALLED_GATE,
        DEPLOYMENT_DIR / "proxmox-snapshot-runner.sh": LIB_DIR / "proxmox-snapshot-runner.sh",
    }
    for source, target in sources.items():
        if not source.exists():
            if not quiet:
                cp.r.note(f"{source} not in this checkout — keeping the installed {target}")
            continue
        if target.exists() and target.read_bytes() == source.read_bytes():
            continue
        cp.sh.act(["install", "-D", "-o", "root", "-g", "root", "-m", "0755", str(source), str(target)], describe=f"install {target}")


def cmd_install(cp: ControlPlane, gate_pubkey_file: Optional[str]) -> int:
    r = cp.r
    r.head("Install" + ("  [DRY RUN]" if cp.dry_run else ""))
    if os.geteuid() != 0 and not cp.dry_run:
        raise Refused("install runs as root")
    install_tool_files(cp)
    for directory, mode in ((STATE_DIR, "0700"), (STATE_DIR / "requests", "0700"), (BACKUP_DIR, "0700"), (LOG_DIR, "0750")):
        cp.sh.act(["install", "-d", "-o", "root", "-g", "root", "-m", mode, str(directory)], describe=f"mkdir {directory} ({mode})")
    if not history_path().exists():
        env = cp.vm_env()
        row = {"utc": iso(utcnow()), "action": "baseline", "from_rev": "", "to_rev": env.get("KINERARY_REV", ""),
               "hermes_from": "", "hermes_to": env.get("HERMES_REV", ""), "result": "ok", "actor": "install"}
        if cp.dry_run:
            r.step(f"would seed history with the running version {row['to_rev']} / Hermes {row['hermes_to']}")
        else:
            append_history(row)
            r.ok(f"history seeded with {row['to_rev']} / Hermes {row['hermes_to']}")
    if gate_pubkey_file:
        key = Path(gate_pubkey_file).read_text().strip()
        if not re.match(r"^ssh-ed25519 [A-Za-z0-9+/=]+( [^\n]*)?$", key):
            raise Refused("the gate key must be one ssh-ed25519 public key")
        if cp.sh.read(["id", "cprelease"]).returncode != 0:
            cp.sh.act(["useradd", "--system", "--create-home", "--shell", "/bin/sh", "cprelease"], describe="useradd cprelease")
        home = Path("/home/cprelease")
        line = f'restrict,command="{INSTALLED_GATE}" {key}\n'
        sudoers = f"cprelease ALL=(root) NOPASSWD: {INSTALLED_TOOL} gate *\n"
        if cp.dry_run:
            r.step(f"would write {home}/.ssh/authorized_keys: {line.strip()[:90]}…")
            r.step(f"would write /etc/sudoers.d/kinerary-cp-release (validated with visudo): {sudoers.strip()}")
        else:
            (home / ".ssh").mkdir(mode=0o700, exist_ok=True)
            (home / ".ssh" / "authorized_keys").write_text(line)
            os.chmod(home / ".ssh" / "authorized_keys", 0o600)
            subprocess.run(["chown", "-R", "cprelease:cprelease", str(home / ".ssh")], check=True)
            with tempfile.NamedTemporaryFile("w", delete=False) as handle:
                handle.write(sudoers)
            if subprocess.run(["visudo", "-cf", handle.name], capture_output=True).returncode != 0:
                os.unlink(handle.name)
                raise Refused("the sudoers line did not validate — nothing installed")
            shutil.move(handle.name, "/etc/sudoers.d/kinerary-cp-release")
            os.chmod("/etc/sudoers.d/kinerary-cp-release", 0o440)
            r.ok("gate user cprelease: forced command + one sudoers line")
    return 0


# --------------------------------------------------------------------------- #
# The gate (trip-monitor's path)
# --------------------------------------------------------------------------- #
GATE_HELP = """kinerary-cp-release gate — what trip-monitor can do on the production control plane

  status | history | snapshots | verify | help         read-only
  plan <main|commit>                                     what an upgrade would change
  dry-run upgrade <main|commit> [--hermes-rev <rev>]     every check, nothing changed
  dry-run rollback [--to <commit>] [--restore-db]
  dry-run prune | dry-run restart-bridges
  request <same action as dry-run>                       passes the dry-run, then sends Dror a code
  approve r-<n> <code>                                   only with the code Dror typed to you
  result r-<n> | cancel r-<n>

Only `main` commits. --force-live, --keep-db and --restore-hermes are a person's call.
Restoring the whole VM from a snapshot is Dror's, from his Mac — never through here."""


def run_action(cp: ControlPlane, action: Sequence[str]) -> int:
    verb, args = action[0], list(action[1:])
    if verb == "upgrade":
        hermes = args[args.index("--hermes-rev") + 1] if "--hermes-rev" in args else None
        return cmd_upgrade(cp, args[0], hermes, force_live=False)
    if verb == "rollback":
        to = args[args.index("--to") + 1] if "--to" in args else None
        return cmd_rollback(cp, to, "--restore-db" in args, False, False, force_live=False)
    if verb == "prune":
        return cmd_prune(cp)
    if verb == "restart-bridges":
        return cmd_restart_bridges(cp)
    raise Refused(f"unknown action {verb}")


def resolve_agent_revs(cp: ControlPlane, action: List[str]) -> List[str]:
    """Pin `main` to a hash and require every commit to be on origin/main."""
    cp.fetch()
    resolved = list(action)
    for index, value in enumerate(resolved):
        if index == 1 and resolved[0] == "upgrade" or (index > 0 and resolved[index - 1] == "--to"):
            full, short = cp.resolve(value)
            if cp.sh.read(cp.git_argv("merge-base", "--is-ancestor", full, "origin/main")).returncode != 0:
                raise GateRefusal(f"{short} is not on origin/main — only main commits are deployed through the gate")
            resolved[index] = short
    return resolved


def cmd_gate(tokens: Sequence[str]) -> int:
    out = sys.stdout
    try:
        verb, args = parse_gate(tokens)
    except GateRefusal as error:
        print(f"refused: {error}", file=out)
        return 2
    audit(f"gate {verb} {' '.join(args)}")
    requests = Requests(STATE_DIR / "requests")
    report = Report(out, color=False)
    try:
        if verb == "help":
            print(GATE_HELP, file=out); return 0
        if verb == "history":
            for row in read_history()[-10:]:
                print(f"{row['utc']}  {row['action']:<9} {row['from_rev']} -> {row['to_rev']}  {row['result']}  {row['actor']}", file=out)
            return 0
        cp = ControlPlane(report, dry_run=verb in ("dry-run", "request", "plan"), actor="agent")
        if verb == "status":
            return cmd_status(cp)
        if verb == "snapshots":
            for name, snaptime, desc in cp.snapshot_list():
                print(f"{name}  {iso(dt.datetime.fromtimestamp(snaptime, dt.timezone.utc))}  {desc}", file=out)
            return 0
        if verb == "verify":
            return 0 if cp.verify() else 1
        if verb == "plan":
            return cmd_plan(ControlPlane(report, dry_run=True, actor="agent"), args[0])
        if verb == "dry-run":
            action = resolve_agent_revs(cp, args)
            return run_action(cp, action)
        if verb == "request":
            action = resolve_agent_revs(cp, args)
            buffer = io.StringIO()
            capture = Report(buffer, color=False)
            code = run_action(ControlPlane(capture, dry_run=True, actor="agent"), action)
            print(buffer.getvalue(), file=out)
            if code != 0:
                print("refused: the dry-run did not pass — no request created, nothing sent", file=out)
                return 1
            summary = "; ".join(f"{k}: {v}" for k, v in capture.facts.items())
            request, secret = requests.create(action, summary)
            expires = dt.datetime.fromtimestamp(request["expires_at"], dt.timezone.utc).strftime("%H:%M UTC")
            sent = ControlPlane(report, actor="agent").notify(
                f"Kinerary release request {request['id']} from trip-monitor\n"
                f"{' '.join(action)}\n{summary}\n\n"
                f"Code: {secret}  (expires {expires}, {REQUEST_MAX_ATTEMPTS} tries)\n"
                f"To approve, send to trip-monitor:  approve {request['id']} {secret}\n"
                f"Do not reply here. Ignore this message to let it expire.")
            del secret
            if not sent:
                requests.mark(request["id"], status="cancelled", reason="could not reach Dror on Telegram")
                print(f"refused: could not deliver the code to Dror — {request['id']} cancelled", file=out)
                return 1
            print(f"requested {request['id']}: {' '.join(action)}. Dror has the code (expires {expires}). "
                  f"Wait for him to send you: approve {request['id']} <code>", file=out)
            return 0
        if verb == "approve":
            request = requests.approve(args[0], args[1])
            launch_request(request["id"])
            print(f"approved {request['id']}: {' '.join(request['action'])} started. Follow it with: result {request['id']}", file=out)
            return 0
        if verb == "cancel":
            request = requests.cancel(args[0])
            print(f"cancelled {request['id']}", file=out)
            return 0
        if verb == "result":
            request = Requests.public(requests.get(args[0]))
            print(json.dumps({k: request[k] for k in ("id", "action", "status", "exit_code") if k in request}), file=out)
            log = LOG_DIR / f"release-{args[0]}.log"
            if log.exists():
                print("\n".join(log.read_text(errors="replace").splitlines()[-40:]), file=out)
            return 0
    except (GateRefusal, Refused) as error:
        if verb == "approve" and "locked" in str(error):
            ControlPlane(Report(io.StringIO()), actor="agent").notify(f"Kinerary release request {args[0]} locked after {REQUEST_MAX_ATTEMPTS} wrong codes.")
        audit(f"gate {verb} refused: {error}")
        print(f"refused: {error}", file=out)
        return 1
    return 2


def launch_request(request_id: str) -> None:
    argv = [str(INSTALLED_TOOL), "run-request", request_id]
    if shutil.which("systemd-run"):
        subprocess.run(["systemd-run", f"--unit=kinerary-cp-release-{request_id}", "--collect", "--quiet", *argv], check=True)
    else:
        subprocess.Popen(argv, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cmd_run_request(request_id: str) -> int:
    """Run an APPROVED request's frozen action, detached from the ssh session."""
    requests = Requests(STATE_DIR / "requests")
    request = requests.get(request_id)
    if request["status"] != "approved":
        print(f"refused: {request_id} is {request['status']}", file=sys.stderr)
        return 2
    requests.mark(request_id, status="running", started_at=time.time())
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"release-{request_id}.log"
    with log_path.open("a") as log:
        report = Report(log, color=False)
        cp = ControlPlane(report, actor=f"agent:{request_id}")
        try:
            with lock():
                code = run_action(cp, request["action"])
        except Refused as error:
            report.line(f"STOPPED: {error}")
            code = 1
        except Exception as error:  # noqa: BLE001 - recorded, then reported to Dror
            report.line(f"CRASHED: {type(error).__name__}: {error}")
            code = 3
    requests.mark(request_id, status="done" if code == 0 else "failed", exit_code=code, finished_at=time.time())
    tail = "\n".join(log_path.read_text(errors="replace").splitlines()[-12:])
    ControlPlane(Report(io.StringIO()), actor="agent").notify(
        f"Kinerary release {request_id} ({' '.join(request['action'])}) {'finished' if code == 0 else 'FAILED'} (exit {code}).\n{tail}")
    return code


def audit(text: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with (LOG_DIR / "release-gate.log").open("a") as handle:
            handle.write(f"{iso(utcnow())} {text}\n")
    except OSError:
        pass


class nolock:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class lock:
    """One release action at a time, whoever started it."""

    def __enter__(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.handle = (STATE_DIR / "lock").open("w")
        try:
            fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("another kinerary-cp-release action is running")
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.handle, fcntl.LOCK_UN)
        self.handle.close()


# --------------------------------------------------------------------------- #
def main(argv: Sequence[str]) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    command, rest = argv[0], list(argv[1:])
    if command == "gate":
        return cmd_gate(rest)
    if command == "run-request":
        if os.geteuid() != 0 or len(rest) != 1:
            print("run-request <id> runs as root, started by an approval", file=sys.stderr)
            return 2
        return cmd_run_request(rest[0])

    dry_run = "--dry-run" in rest
    rest = [a for a in rest if a != "--dry-run"]
    report = Report()

    def flag(name: str) -> bool:
        if name in rest:
            rest.remove(name)
            return True
        return False

    def option(name: str) -> Optional[str]:
        if name in rest:
            index = rest.index(name)
            if index + 1 >= len(rest):
                raise Refused(f"{name} needs a value")
            value = rest[index + 1]
            del rest[index:index + 2]
            return value
        return None

    read_only = command in ("status", "plan", "verify", "history", "snapshots")
    if os.geteuid() != 0 and not (read_only and command == "history"):
        print("kinerary-cp-release runs as root (sudo)", file=sys.stderr)
        return 2
    try:
        cp = ControlPlane(report, dry_run=dry_run or read_only)
        if command == "status":
            return cmd_status(cp)
        if command == "history":
            for row in read_history():
                print("\t".join(row[f] for f in HISTORY_FIELDS))
            return 0
        if command == "snapshots":
            for name, snaptime, desc in cp.snapshot_list():
                print(f"{name}\t{iso(dt.datetime.fromtimestamp(snaptime, dt.timezone.utc))}\t{desc}")
            return 0
        if command == "verify":
            return 0 if ControlPlane(report).verify() else 1
        if command == "plan":
            if len(rest) != 1:
                raise Refused("plan <rev|main>")
            return cmd_plan(cp, rest[0])
        if command == "install":
            key_file = option("--gate-pubkey-file")
            return cmd_install(cp, key_file)
        with (nolock() if dry_run else lock()):
            if command == "upgrade":
                hermes = option("--hermes-rev")
                force_live = flag("--force-live")
                if len(rest) != 1:
                    raise Refused("upgrade <rev|main> [--hermes-rev R] [--force-live] [--dry-run]")
                return cmd_upgrade(cp, rest[0], hermes, force_live)
            if command == "rollback":
                to = option("--to")
                restore_db, keep_db = flag("--restore-db"), flag("--keep-db")
                restore_hermes, force_live = flag("--restore-hermes"), flag("--force-live")
                if restore_db and keep_db:
                    raise Refused("--restore-db and --keep-db are opposites")
                if rest:
                    raise Refused(f"unexpected: {' '.join(rest)}")
                return cmd_rollback(cp, to, restore_db, keep_db, restore_hermes, force_live)
            if command == "restart-bridges":
                return cmd_restart_bridges(cp)
            if command == "prune":
                return cmd_prune(cp)
        print(f"unknown command {command!r}\n\n{__doc__}", file=sys.stderr)
        return 2
    except Refused as error:
        report.line()
        report.line(f"STOPPED: {error}")
        return 1
    except (subprocess.TimeoutExpired, OSError) as error:
        report.line()
        report.line(f"STOPPED: {type(error).__name__}: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
