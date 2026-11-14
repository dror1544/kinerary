#!/usr/bin/env python3
"""Bring one release to named trips, in order, recording what each trip runs.

Until this command a merged change reached a running trip in pieces — site
payload, then the trip's bridge, then the companion — each run by hand, each with
its own prompt, and nothing recorded which version a trip ran. This is the
order as a command (docs/specs/sprint-9/568-trip-rollout.md, slice R1: the site
and bridge steps, the record, the approval):

    trip-rollout.py plan    --release <id|commit> --trip <slug>[,<slug>...] --plan-file <path>
    trip-rollout.py execute --plan-file <path> --plan-digest <sha256:...> [--steps site,bridge]
    trip-rollout.py status  [--trip <slug>]

`plan` changes nothing. For each trip it says what the trip runs now, what it
would run, the steps, and any reason it is refused; it writes the same to the
plan file and prints that file's digest. `execute` runs exactly that file. It
refuses a plan whose digest is not the one it is given (the approval prompt shows
that digest and the command carries it, so one approval covers one plan and a
file edited after `plan` runs nothing).

For each trip, steps run in order and stop at the first failure:

  1. site    the release's site/ server/ shared/ materialized from git and
             digest-verified, the deployment's deploy command run with a restart
             and WITHOUT the flag that overwrites the trip's config, then the
             site's own /api/health
  2. bridge  the deployment's bridge restart, then the bridge's own /health
             ("can you reach your trip"), whose code is the failure message

A `trip_rollouts` row is written as `running` before the first step acts and
closed `ok` or `failed` (with the NAME of the failed step). Once the site step
has succeeded the trip's row says it runs the target release and keeps the
release it ran before (the way back); a failed site step moves neither. A
rollback is the same command naming the previous release. Trips run one at a
time and the first failure stops the rest. Nothing here asks the organizer to
approve, notifies anyone, or moves a trip's lifecycle: it is not a provision.

NOTHING DEPLOYMENT-SPECIFIC IS DEFAULTED HERE (hard rule 6). A thin wrapper in
the deployment repository supplies, through the environment, and the command
REFUSES, naming each one, when any is unset:

  KINERARY_DEPLOY_ROOT            the deployment root; trips/<slug>/topology.yaml lives under it
  KINERARY_TRIP_DEPLOY_CMD        the deploy command: <cmd> <slug> <vmid> --restart --trip-dir <dir>,
                                  run with REPO_ROOT set to the materialized release
  KINERARY_BRIDGE_RESTART_CMD     <cmd> --restart-only --trip-dir <dir>
  KINERARY_CONTAINER_HOSTNAME_CMD <cmd> <vmid>  prints the hostname of that container
  KINERARY_ROLLOUT_PSQL_CMD       a psql command line to the control plane database; SQL arrives on stdin
Optional: KINERARY_ROLLOUT_REPO_ROOT (the checkout holding the release commits; default: this one),
KINERARY_ROLLOUT_CHILD_ENV (comma-separated extra variable NAMES the deployment's commands need),
KINERARY_ROLLOUT_SITE_WAIT_SECONDS / _BRIDGE_WAIT_SECONDS / _STEP_TIMEOUT_SECONDS.

The deploy, bridge and hostname commands run with an ALLOW-LISTED environment, not
this one's: a trip's keys are read inside the step, sent only to the trip's own
loopback bridge as a header, and never printed, logged, stored or put on a command line.
The rollout reads versions and health, never what travellers wrote.
"""
from __future__ import annotations

import argparse
import dataclasses
import getpass
import hashlib
import importlib.util
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

REPO = Path(__file__).resolve().parents[1]

PLAN_FORMAT = "trip-rollout-plan/1"
SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
RELEASE_REF = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
COMMIT = re.compile(r"^[a-f0-9]{40}$")
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
# The steps, in the only order they run. R1 builds the first two; the others are
# named so a request for them is refused with a reason rather than ignored.
ALL_STEPS = ("site", "bridge", "companion", "switches")
BUILT_STEPS = ("site", "bridge")
DEFAULT_STEPS = BUILT_STEPS
NOT_IN_THIS_SLICE = {
    "companion": "the companion step is slice R2 and is not in this slice",
    "switches": "the switches step is the feature-switch work (#567 S2) and is not in this slice",
}
# A trip with no site yet, or one that is gone, has nothing to roll out to.
# Past ready_private real people have used the site; that is exactly who a
# rollout is for, so `active` is eligible by design.
ROLLOUT_STATES = ("ready_private", "activation_approved", "active", "completed")
# A `running` row older than this is a rollout that died without closing its row
# (a kill -9, a power cut): the next execute closes it as `abandoned`. A younger
# one is a rollout that may still be going, and blocks.
STALE_RUNNING_SECONDS = 4 * 3600
# The default clock for each wait, overridable through the environment.
SITE_WAIT_DEFAULT = 90
BRIDGE_WAIT_DEFAULT = 30
STEP_TIMEOUT_DEFAULT = 900
# mcp_bridge.mcp_port_for_vmid's rule, mirrored (the same one
# companion-install-host.sh applies): 3000 + vmid, inside 3100-3999.
BRIDGE_PORT_BASE = 3000
BRIDGE_PORT_RANGE = (3100, 3999)

# What a child process may inherit. Not this process's whole environment: it can
# hold the relay's keys, a provider token, anything a login shell exported.
CHILD_ENV_BASE = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "SHELL",
                  "SSH_AUTH_SOCK", "TERM")
PSQL_ENV_EXTRA = ("DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT")


class Refused(Exception):
    """The command, or something about a trip, is refused: no step ran for it."""


class StepFailed(Exception):
    def __init__(self, step: str, message: str) -> None:
        super().__init__(message)
        self.step = step


def say(msg: str = "") -> None:
    print(msg, flush=True)


def whisper(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ── configuration: everything about WHERE comes from the environment ───────────

@dataclasses.dataclass
class Config:
    deploy_root: Path
    deploy_cmd: list
    bridge_cmd: list
    hostname_cmd: list
    psql_cmd: list
    repo_root: Path
    extra_child_env: tuple
    site_wait: int
    bridge_wait: int
    step_timeout: int
    environ: dict

    def child_env(self, extra: Optional[dict] = None) -> dict:
        names = CHILD_ENV_BASE + self.extra_child_env
        env = {k: self.environ[k] for k in names if k in self.environ}
        env["KINERARY_DEPLOY_ROOT"] = str(self.deploy_root)
        if extra:
            env.update(extra)
        return env

    def psql_env(self) -> dict:
        env = {k: v for k, v in self.environ.items()
               if k in CHILD_ENV_BASE or k in PSQL_ENV_EXTRA or k.startswith("PG") or k in self.extra_child_env}
        return env


REQUIRED_ENV = (
    ("KINERARY_DEPLOY_ROOT", "the deployment root (trips/<slug>/topology.yaml lives under it)"),
    ("KINERARY_TRIP_DEPLOY_CMD", "the command that deploys a release to one trip"),
    ("KINERARY_BRIDGE_RESTART_CMD", "the command that restarts one trip's bridge"),
    ("KINERARY_CONTAINER_HOSTNAME_CMD", "the command that prints the hostname of a container, given its id"),
    ("KINERARY_ROLLOUT_PSQL_CMD", "a psql command line to the control plane database"),
)


def _seconds(environ: dict, name: str, default: int) -> int:
    raw = environ.get(name, "")
    if not raw:
        return default
    if not raw.isdigit() or int(raw) < 1:
        raise Refused(f"{name} must be a whole number of seconds, not {raw!r}")
    return int(raw)


def load_config(environ: dict, need: tuple = tuple(n for n, _ in REQUIRED_ENV)) -> Config:
    """Refuse, naming every missing variable at once. No value is defaulted: a
    deployment that forgets one gets this refusal, not somebody else's host."""
    missing = [(n, why) for n, why in REQUIRED_ENV if n in need and not environ.get(n)]
    if missing:
        lines = "\n".join(f"  {n}  — {why}" for n, why in missing)
        raise Refused(
            "this deployment is not configured for rollouts; unset:\n" + lines +
            "\nThe deployment's own wrapper sets them (hard rule 6: this repository names no host, address,"
            " container or path).")

    def words(name: str) -> list:
        try:
            parts = shlex.split(environ.get(name, ""))
        except ValueError as exc:
            raise Refused(f"{name} is not a command line: {exc}")
        if not parts and name in need:
            raise Refused(f"{name} is empty")
        return parts

    deploy_cmd = words("KINERARY_TRIP_DEPLOY_CMD")
    if "--sync-config" in deploy_cmd:
        # The flag that overwrites a trip's own config. A rollout never passes it
        # (AC-6); a deployment that bakes it into the command is refused, not obeyed.
        raise Refused("KINERARY_TRIP_DEPLOY_CMD carries --sync-config, which overwrites a trip's config;"
                      " a rollout changes no trip config or data")
    root = Path(environ["KINERARY_DEPLOY_ROOT"]) if environ.get("KINERARY_DEPLOY_ROOT") else Path(".")
    if "KINERARY_DEPLOY_ROOT" in need and not root.is_dir():
        raise Refused(f"KINERARY_DEPLOY_ROOT is not a directory: {root}")
    extra = tuple(n for n in (environ.get("KINERARY_ROLLOUT_CHILD_ENV", "").replace(" ", "").split(",")) if n)
    bad = [n for n in extra if not ENV_NAME.match(n)]
    if bad:
        raise Refused(f"KINERARY_ROLLOUT_CHILD_ENV names something that is not a variable name: {bad[0]!r}")
    return Config(
        deploy_root=root,
        deploy_cmd=deploy_cmd,
        bridge_cmd=words("KINERARY_BRIDGE_RESTART_CMD"),
        hostname_cmd=words("KINERARY_CONTAINER_HOSTNAME_CMD"),
        psql_cmd=words("KINERARY_ROLLOUT_PSQL_CMD"),
        repo_root=Path(environ.get("KINERARY_ROLLOUT_REPO_ROOT") or REPO),
        extra_child_env=extra,
        site_wait=_seconds(environ, "KINERARY_ROLLOUT_SITE_WAIT_SECONDS", SITE_WAIT_DEFAULT),
        bridge_wait=_seconds(environ, "KINERARY_ROLLOUT_BRIDGE_WAIT_SECONDS", BRIDGE_WAIT_DEFAULT),
        step_timeout=_seconds(environ, "KINERARY_ROLLOUT_STEP_TIMEOUT_SECONDS", STEP_TIMEOUT_DEFAULT),
        environ=dict(environ),
    )


# ── the control plane database, through the deployment's psql command ─────────

class Db:
    """SQL goes in on stdin and values go in as psql variables (`:'name'`), so no
    value is ever spliced into SQL text and the database's password is whatever
    the deployment's command carries, never an argument of ours."""

    def __init__(self, cmd: list, env: dict) -> None:
        self.cmd = cmd
        self.env = env

    def run(self, sql: str, **values: str) -> str:
        args = list(self.cmd) + ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t"]
        for name, value in values.items():
            if "\n" in value or "\0" in value:
                raise ValueError(f"value for {name} is not a single line")
            args += ["-v", f"{name}={value}"]
        try:
            out = subprocess.run(args, input=sql, capture_output=True, text=True, env=self.env, timeout=120)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(f"the database command did not run: {type(exc).__name__}")
        if out.returncode != 0:
            raise DbError(out.stderr.strip()[-400:] or f"psql exited {out.returncode}")
        return out.stdout.strip()

    def rows(self, sql: str, **values: str) -> list:
        """`sql` must select one json value per row (row_to_json)."""
        return [json.loads(line) for line in self.run(sql, **values).splitlines() if line.strip()]


class DbError(RuntimeError):
    pass


RELEASE_SQL = """
SELECT row_to_json(r) FROM (
  SELECT id, source_revision, artifact_digest, status, data_schema_min, data_schema_max,
         COALESCE(jsonb_typeof(manifest -> 'files') = 'array', false) AS has_manifest
    FROM control_plane.releases
   WHERE id = :'ref' OR source_revision = :'ref'
   ORDER BY (status = 'available') DESC, created_at DESC
   LIMIT 1) r;
"""

TRIP_SQL = """
SELECT row_to_json(x) FROM (
  SELECT t.id, t.slug, t.lifecycle_state, (t.suspended_at IS NOT NULL) AS suspended,
         t.current_release_id, t.previous_release_id,
         (SELECT iv.schema_version FROM control_plane.intake_versions iv
           WHERE iv.trip_id = t.id ORDER BY iv.version DESC LIMIT 1) AS data_schema,
         EXISTS (SELECT 1 FROM control_plane.jobs j
                  WHERE j.trip_id = t.id AND j.state IN ('queued', 'leased', 'running', 'waiting')) AS job_in_flight
    FROM control_plane.trips t WHERE t.slug = :'slug') x;
"""


def get_release(db: Db, ref: str) -> dict:
    if not RELEASE_REF.match(ref):
        raise Refused(f"{ref!r} is not a release id or a commit")
    rows = db.rows(RELEASE_SQL, ref=ref)
    if not rows:
        raise Refused(f"no release {ref!r} in the control plane")
    return rows[0]


# ── a trip: its row, then its topology, then the container's own hostname ─────

def parse_topology(text: str) -> dict:
    """The nested mapping compute.py writes (yaml.safe_dump of plain scalars),
    read without PyYAML — this runs under whatever python the host has."""
    root: dict = {}
    stack = [(-1, root)]
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        m = re.match(r"^(\s*)([A-Za-z0-9_.-]+):\s*(.*?)\s*$", raw)
        if not m:
            continue
        indent, key, value = len(m.group(1)), m.group(2), m.group(3)
        while stack and stack[-1][0] >= indent:
            stack.pop()
        parent = stack[-1][1]
        if value == "":
            child: dict = {}
            parent[key] = child
            stack.append((indent, child))
        else:
            parent[key] = value.strip("'\"")
    return root


@dataclasses.dataclass
class Trip:
    row: dict
    slug: str
    trip_dir: Path
    vmid: str
    site_host: str
    site_port: int
    container: str

    @property
    def current(self) -> Optional[str]:
        return self.row.get("current_release_id")


OCTET = r"(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])"
IPV4 = re.compile(rf"^{OCTET}(\.{OCTET}){{3}}$")


def run_child(cfg: Config, args: list, extra_env: Optional[dict] = None, timeout: Optional[int] = None):
    """A child with the allow-listed environment and no stdin. Output is captured,
    never streamed: the caller decides what part of it, scrubbed, is shown."""
    return subprocess.run(args, capture_output=True, text=True, stdin=subprocess.DEVNULL,
                          env=cfg.child_env(extra_env), timeout=timeout or cfg.step_timeout,
                          cwd=str(cfg.deploy_root))


def resolve_trip(cfg: Config, db: Db, slug: str) -> Trip:
    """The way scripts/teardown-trip.py resolves one: the database row, then the
    trip's topology under the deployment root, then a check that the container
    the topology names really carries the hostname the topology gives it — a VMID
    handed to another container since is not this trip's to deploy to."""
    if not SLUG.match(slug):
        raise Refused(f"{slug!r} is not a slug")
    rows = db.rows(TRIP_SQL, slug=slug)
    if not rows:
        raise Refused(f"no trip {slug!r} in the control plane")
    row = rows[0]
    if slug.startswith("retired-"):
        raise Refused(f"{slug} is a retired trip")
    if row["lifecycle_state"] not in ROLLOUT_STATES:
        raise Refused(f"{slug} is {row['lifecycle_state']}: it has no running site to roll out to")
    if row["suspended"]:
        raise Refused(f"{slug} is suspended")
    if row["job_in_flight"]:
        raise Refused(f"{slug} has a provisioning job in flight; a rollout would race it")

    trip_dir = cfg.deploy_root / "trips" / slug
    topology_path = trip_dir / "topology.yaml"
    if not topology_path.is_file():
        raise Refused(f"{slug}: no topology under the deployment root")
    topo = parse_topology(topology_path.read_text(encoding="utf-8", errors="replace"))
    proxmox = topo.get("proxmox") or {}
    lxc = proxmox.get("lxc") or {}
    npm = topo.get("npm") or {}
    vmid = str(proxmox.get("vmid") or "")
    container = str(lxc.get("name") or "")
    host = str(lxc.get("ipv4") or "").split("/")[0]
    port = str(npm.get("forward_port") or "")
    if topo.get("name") != slug:
        raise Refused(f"{slug}: its topology describes {topo.get('name')!r}, not this trip")
    if not (re.fullmatch(r"[0-9]{1,6}", vmid) and container and IPV4.match(host)
            and re.fullmatch(r"[0-9]{1,5}", port) and 1 <= int(port) <= 65535):
        raise Refused(f"{slug}: its topology lacks a usable container id, name, address or port")
    try:
        named = run_child(cfg, cfg.hostname_cmd + [vmid], timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Refused(f"{slug}: could not ask which container {vmid} is ({type(exc).__name__})")
    if named.returncode != 0 or named.stdout.strip() != container:
        raise Refused(f"{slug}: container {vmid} is not the one its topology names; refusing to deploy to it")
    return Trip(row=row, slug=slug, trip_dir=trip_dir, vmid=vmid, site_host=host, site_port=int(port),
                container=container)


def release_refusal(cfg: Config, release: dict, row: dict) -> Optional[str]:
    """Why this release may not go to this trip, or None."""
    if release["status"] != "available":
        return f"release {release['id']} is {release['status']}, not available"
    if not release["has_manifest"]:
        return f"release {release['id']} has no sealed manifest, so its tree cannot be verified"
    schema = row.get("data_schema")
    if schema is None:
        return "the trip has no confirmed intake, so whether the release's data schema covers it is unknown"
    if not (release["data_schema_min"] <= schema <= release["data_schema_max"]):
        return (f"the trip's data schema {schema} is outside what release {release['id']} covers "
                f"({release['data_schema_min']}..{release['data_schema_max']})")
    return None


def commit_present(cfg: Config, revision: str) -> bool:
    out = subprocess.run(["git", "-C", str(cfg.repo_root), "cat-file", "-e", f"{revision}^{{commit}}"],
                         capture_output=True, stdin=subprocess.DEVNULL)
    return out.returncode == 0


# ── plan ──────────────────────────────────────────────────────────────────────

def parse_steps(raw: Optional[str]) -> tuple:
    if raw is None:
        return DEFAULT_STEPS
    wanted = [s for s in raw.split(",") if s]
    unknown = [s for s in wanted if s not in ALL_STEPS]
    if unknown:
        raise Refused(f"unknown step {unknown[0]!r}; the steps are {', '.join(ALL_STEPS)}")
    for s in wanted:
        if s in NOT_IN_THIS_SLICE:
            raise Refused(NOT_IN_THIS_SLICE[s])
    if not wanted:
        raise Refused("no steps named")
    return tuple(s for s in ALL_STEPS if s in wanted)   # always in running order


def digest_of(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def cmd_plan(cfg: Config, db: Db, args) -> int:
    if args.all:
        raise Refused("--all is not in this slice (R3): name the trips with --trip")
    slugs = []
    for item in args.trip or []:
        slugs += [s for s in item.split(",") if s]
    if not slugs:
        raise Refused("name at least one trip with --trip <slug>[,<slug>...]")
    if len(set(slugs)) != len(slugs):
        raise Refused("a trip is named twice")
    steps = parse_steps(args.steps)
    release = get_release(db, args.release)

    present = commit_present(cfg, release["source_revision"])
    trips, refused, notes = [], [], []
    say(f"release {release['id']}  commit {release['source_revision']}  ({release['status']})")
    say(f"steps   {', '.join(steps)}")
    for slug in slugs:
        try:
            trip = resolve_trip(cfg, db, slug)
            why = release_refusal(cfg, release, trip.row)
            if why is None and "site" in steps and not present:
                why = f"commit {release['source_revision'][:12]} is not in this checkout; fetch it first"
            if why:
                raise Refused(f"{slug}: {why}")
        except Refused as exc:
            refused.append({"slug": slug, "reason": str(exc)})
            say(f"  REFUSED  {exc}")
            continue
        current = trip.current
        entry = {"slug": slug, "trip_id": trip.row["id"], "from_release_id": current}
        trips.append(entry)
        if current is None:
            runs = "unknown (no release recorded)"
            note = "no way back is recorded for this first rollout"
        elif current == release["id"]:
            runs = f"{current} (the release named)"
            note = "already on this release; the steps run again and the record does not move"
        else:
            runs = current
            note = "rollback: this is the trip's recorded previous release" \
                if trip.row.get("previous_release_id") == release["id"] else ""
        say(f"  {slug}: runs {runs}  ->  {release['id']}")
        if note:
            say(f"      {note}")
            notes.append({"slug": slug, "note": note})

    plan = {
        "format": PLAN_FORMAT,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "release": {k: release[k] for k in ("id", "source_revision", "artifact_digest", "status")},
        "steps": list(steps),
        "trips": trips,
        "refused": refused,
        "notes": notes,
    }
    data = (json.dumps(plan, indent=2, sort_keys=True) + "\n").encode("utf-8")
    path = Path(args.plan_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    digest = digest_of(data)
    say(f"plan file {path}")
    say(f"digest    {digest}")
    if trips:
        say(f"to run:   scripts/trip-rollout.py execute --plan-file {shlex.quote(str(path))} --plan-digest {digest}")
    else:
        say("nothing in this plan can run")
    return 1 if refused else 0


# ── execute ───────────────────────────────────────────────────────────────────

def read_plan(path: str, expected_digest: Optional[str]) -> tuple:
    if not expected_digest:
        raise Refused("--plan-digest is required: the digest `plan` printed is what binds an approval to this file")
    if not DIGEST.match(expected_digest):
        raise Refused(f"--plan-digest {expected_digest!r} is not a sha256 digest")
    try:
        data = Path(path).read_bytes()
    except OSError as exc:
        raise Refused(f"plan file {path} cannot be read ({type(exc).__name__})")
    actual = digest_of(data)
    if actual != expected_digest:
        raise Refused(f"plan file {path} has changed since `plan` wrote it (digest {actual}, expected {expected_digest})")
    try:
        plan = json.loads(data)
    except ValueError:
        raise Refused(f"plan file {path} is not valid JSON")
    problem = validate_plan(plan)
    if problem:
        raise Refused(f"plan file {path} is not a rollout plan: {problem}")
    return plan, actual


def validate_plan(plan) -> Optional[str]:
    if not isinstance(plan, dict) or plan.get("format") != PLAN_FORMAT:
        return f"format is not {PLAN_FORMAT}"
    rel = plan.get("release")
    if not isinstance(rel, dict):
        return "no release"
    if not (isinstance(rel.get("id"), str) and RELEASE_REF.match(rel["id"])):
        return "release id is malformed"
    if not (isinstance(rel.get("source_revision"), str) and COMMIT.match(rel["source_revision"])):
        return "release commit is malformed"
    if not (isinstance(rel.get("artifact_digest"), str) and DIGEST.match(rel["artifact_digest"])):
        return "release digest is malformed"
    steps = plan.get("steps")
    if not (isinstance(steps, list) and steps and all(s in ALL_STEPS for s in steps)):
        return "steps are malformed"
    trips = plan.get("trips")
    if not (isinstance(trips, list) and trips):
        return "it lists no trips"
    seen = set()
    for t in trips:
        if not (isinstance(t, dict) and isinstance(t.get("slug"), str) and SLUG.match(t["slug"])):
            return "a trip slug is malformed"
        if t["slug"] in seen:
            return f"{t['slug']} is listed twice"
        seen.add(t["slug"])
        f = t.get("from_release_id")
        if not (f is None or (isinstance(f, str) and RELEASE_REF.match(f))):
            return f"{t['slug']}: the recorded current release is malformed"
    return None


def scrub(text: str, limit: int = 15) -> str:
    """The tail of a child's output, safe to show: control characters out, and
    anything that looks like a secret assignment redacted. Shown, never stored."""
    lines = [re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "?", ln)[:300] for ln in text.splitlines() if ln.strip()]
    lines = [re.sub(r"(?i)(key|token|secret|password|passwd)(\s*[=:]\s*)\S+", r"\1\2<redacted>", ln)
             for ln in lines[-limit:]]
    return "\n".join("      | " + ln for ln in lines)


def http_get(url: str, headers: Optional[dict] = None, timeout: int = 15) -> tuple:
    """(status, body) — no proxy, whatever the environment says: these are
    loopback and LAN addresses."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.read(8192).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(8192).decode("utf-8", "replace")


def site_healthy(trip: Trip, wait: int) -> bool:
    deadline = time.time() + wait
    url = f"http://{trip.site_host}:{trip.site_port}/api/health"
    while True:
        try:
            status, body = http_get(url, timeout=5)
            if status == 200 and json.loads(body).get("ok") is True:
                return True
        except (OSError, ValueError, AttributeError):
            pass
        if time.time() >= deadline:
            return False
        time.sleep(min(2, max(0.1, deadline - time.time())))


def bridge_health(port: int, key: str) -> tuple:
    """(reachable, code). The codes are companion-install-host.sh's
    bridge_health_code: what the bridge says when it cannot reach its trip
    (HTTP_<n>, E<errno>), BRIDGE_401 (it refused the key in its own mcp/.env),
    NO_HEALTH_ROUTE (an mcp.js that predates /health), none (no answer at all),
    UNRECOGNIZED. The key goes in a header over loopback, from this process's
    memory; it is not an argument of anything and is not printed."""
    try:
        status, body = http_get(f"http://127.0.0.1:{port}/health", {"X-API-Key": key})
    except OSError:
        return False, "none"
    try:
        doc = json.loads(body)
    except ValueError:
        doc = None
    if status == 200 and isinstance(doc, dict) and doc.get("ok") is True:
        return True, "reachable"
    if isinstance(doc, dict):
        code = doc.get("code")
        if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_]{1,40}", code):
            return False, code
        if doc == {"error": "unauthorized"}:
            return False, "BRIDGE_401"
    if "Cannot GET /health" in body:
        return False, "NO_HEALTH_ROUTE"
    return False, "UNRECOGNIZED"


def read_bridge_key(trip: Trip) -> Optional[str]:
    try:
        text = (trip.trip_dir / "mcp" / ".env").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    for line in text.splitlines():
        if line.startswith("MCP_API_KEY="):
            return line.split("=", 1)[1].strip().strip("\"'\r") or None
    return None


def file_digest(path: Path) -> Optional[str]:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def load_release_source():
    path = REPO / "control-plane" / "worker" / "control_plane_worker" / "release_source.py"
    spec = importlib.util.spec_from_file_location("kinerary_release_source", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MOVE_RECORD_SQL = """
WITH moved AS (
  UPDATE control_plane.trips SET
         previous_release_id = CASE WHEN :'from_release' = '' OR :'from_release' = :'to_release'
                                    THEN previous_release_id ELSE :'from_release' END,
         current_release_id = :'to_release'
   WHERE id = :'trip_id' AND current_release_id IS NOT DISTINCT FROM NULLIF(:'from_release', '')
   RETURNING 1)
SELECT count(*) FROM moved;
"""

OPEN_ROLLOUT_SQL = """
BEGIN;
UPDATE control_plane.trip_rollouts
   SET result = 'failed', failed_step = 'abandoned', finished_at = now()
 WHERE trip_id = :'trip_id' AND result = 'running'
   AND started_at < now() - make_interval(secs => %d);
INSERT INTO control_plane.trip_rollouts(id, trip_id, from_release_id, to_release_id, steps, result, actor, plan_digest)
VALUES (:'id', :'trip_id', NULLIF(:'from_release', ''), :'to_release', :'steps'::jsonb, 'running', :'actor', :'digest');
COMMIT;
""" % STALE_RUNNING_SECONDS

CLOSE_ROLLOUT_SQL = """
UPDATE control_plane.trip_rollouts
   SET result = :'result', failed_step = NULLIF(:'failed_step', ''), finished_at = now()
 WHERE id = :'id' AND result = 'running';
"""


class Interrupted(BaseException):
    pass


def _raise_interrupted(signum, _frame):
    raise Interrupted(signal.Signals(signum).name)


class Executor:
    def __init__(self, cfg: Config, db: Db, plan: dict, plan_digest: str, steps: tuple, release_row: dict) -> None:
        self.cfg, self.db, self.plan, self.plan_digest, self.steps = cfg, db, plan, plan_digest, steps
        self.release = plan["release"]
        self.release_row = release_row   # the control plane's own row, re-read at execute
        self.tree: Optional[str] = None

    def materialized(self) -> str:
        if self.tree is None:
            source = load_release_source()
            try:
                self.tree = source.materialize_release_source(
                    str(self.cfg.repo_root), self.release["source_revision"], self.release["artifact_digest"])
            except Exception as exc:
                code = getattr(exc, "safe_error_code", type(exc).__name__)
                raise StepFailed("site", f"the release tree could not be materialized and verified ({code})")
        return self.tree

    def cleanup(self) -> None:
        if self.tree:
            shutil.rmtree(self.tree, ignore_errors=True)
            self.tree = None

    # ---- steps

    def step_site(self, trip: Trip, rollout: dict) -> None:
        tree = self.materialized()
        config_path = trip.trip_dir / "trip.config.json"
        before = file_digest(config_path)
        args = self.cfg.deploy_cmd + [trip.slug, trip.vmid, "--restart", "--trip-dir", str(trip.trip_dir)]
        try:
            done = run_child(self.cfg, args, {"REPO_ROOT": tree})
        except OSError as exc:
            raise StepFailed("site", f"the deploy command did not run ({type(exc).__name__})")
        except subprocess.TimeoutExpired:
            raise StepFailed("site", f"the deploy command did not finish within {self.cfg.step_timeout}s")
        if done.returncode != 0:
            raise StepFailed("site", f"the deploy command exited {done.returncode}\n{scrub(done.stdout + done.stderr)}")
        if file_digest(config_path) != before:
            raise StepFailed("site", "the trip's trip.config.json changed during the deploy; a rollout changes no trip config")
        if not site_healthy(trip, self.cfg.site_wait):
            raise StepFailed("site", f"the site's own /api/health did not answer ok within {self.cfg.site_wait}s")
        moved = self.db.run(MOVE_RECORD_SQL, trip_id=trip.row["id"], from_release=rollout["from"] or "",
                            to_release=self.release["id"])
        if moved != "1":
            raise StepFailed("site", "the site is deployed but the trip's recorded release moved meanwhile, so it was not updated")

    def step_bridge(self, trip: Trip, rollout: dict) -> None:
        port = BRIDGE_PORT_BASE + int(trip.vmid)
        if not (BRIDGE_PORT_RANGE[0] <= port <= BRIDGE_PORT_RANGE[1]):
            raise StepFailed("bridge", "the trip's container id gives no usable bridge port")
        args = self.cfg.bridge_cmd + ["--restart-only", "--trip-dir", str(trip.trip_dir)]
        # The bridge's own code is not part of a release until slice R2, so the
        # restart runs what the host has; the release is named for the wrapper.
        extra = {"KINERARY_ROLLOUT_RELEASE_COMMIT": self.release["source_revision"],
                 "KINERARY_ROLLOUT_RELEASE_ID": self.release["id"]}
        try:
            done = run_child(self.cfg, args, extra)
        except OSError as exc:
            raise StepFailed("bridge", f"the bridge restart did not run ({type(exc).__name__})")
        except subprocess.TimeoutExpired:
            raise StepFailed("bridge", f"the bridge restart did not finish within {self.cfg.step_timeout}s")
        if done.returncode != 0:
            raise StepFailed("bridge", f"the bridge restart exited {done.returncode}\n{scrub(done.stdout + done.stderr)}")
        key = read_bridge_key(trip)
        if not key:
            raise StepFailed("bridge", "bridge health NO_KEY: no MCP_API_KEY beside the trip")
        deadline = time.time() + self.cfg.bridge_wait
        while True:
            reachable, code = bridge_health(port, key)
            # `none` is "not answering yet": a restarted bridge needs a moment. Any
            # other answer is the bridge's verdict and is not waited out.
            if reachable or code != "none" or time.time() >= deadline:
                break
            time.sleep(1)
        if not reachable:
            raise StepFailed("bridge", f"bridge health {code}: the bridge cannot reach its trip")

    # ---- one trip

    def run_trip(self, entry: dict) -> bool:
        slug = entry["slug"]
        say(f"{slug}")
        try:
            trip = resolve_trip(self.cfg, self.db, slug)
            if trip.current != entry["from_release_id"]:
                raise Refused(
                    f"{slug}: it now runs {trip.current or 'an unknown release'}, but the plan recorded "
                    f"{entry['from_release_id'] or 'unknown'}; no step ran. Plan again.")
            row_refusal = release_refusal(self.cfg, self.release_row, trip.row)
            if row_refusal:
                raise Refused(f"{slug}: {row_refusal}")
        except Refused as exc:
            say(f"  REFUSED  {exc}")
            return False

        rollout = {"id": "rollout_" + secrets.token_hex(8), "from": trip.current}
        steps = [s for s in self.steps]
        actor = "cli:" + re.sub(r"[^A-Za-z0-9_.-]", "_", getpass.getuser())[:60]
        try:
            self.db.run(OPEN_ROLLOUT_SQL, id=rollout["id"], trip_id=trip.row["id"], from_release=trip.current or "",
                        to_release=self.release["id"], steps=json.dumps(steps), actor=actor, digest=self.plan_digest)
        except DbError as exc:
            if "trip_rollouts_one_running_idx" in str(exc):
                say(f"  REFUSED  {slug}: another rollout of this trip is still running; no step ran")
                return False
            raise
        current_step = ""
        try:
            for step in steps:
                current_step = step
                say(f"  {step} ...")
                getattr(self, f"step_{step}")(trip, rollout)
                say(f"  {step} ok")
        except StepFailed as exc:
            self.close(rollout, "failed", exc.step)
            say(f"  FAILED at step {exc.step}: {exc}")
            return False
        except BaseException as exc:
            # A signal, a bug: the row must not be left saying `running`.
            self.close(rollout, "failed", current_step or "start")
            if isinstance(exc, Interrupted):
                say(f"  FAILED at step {current_step or 'start'}: interrupted ({exc})")
                raise
            say(f"  FAILED at step {current_step or 'start'}: {type(exc).__name__}")
            raise
        self.close(rollout, "ok", "")
        say(f"  done: {slug} now runs {self.release['id']}")
        return True

    def close(self, rollout: dict, result: str, failed_step: str) -> None:
        try:
            self.db.run(CLOSE_ROLLOUT_SQL, id=rollout["id"], result=result, failed_step=failed_step)
        except Exception as exc:  # the loudest place to be quiet: say so
            whisper(f"  WARNING: could not close rollout {rollout['id']} as {result}: {exc}")


def cmd_execute(cfg: Config, db: Db, args) -> int:
    plan, digest = read_plan(args.plan_file, args.plan_digest)
    steps = plan["steps"]
    if args.steps is not None:
        wanted = parse_steps(args.steps)
        extra = [s for s in wanted if s not in steps]
        if extra:
            raise Refused(f"step {extra[0]} is not in the plan; the approval covers the plan's steps only")
        steps = list(wanted)
    for s in steps:
        if s in NOT_IN_THIS_SLICE:
            raise Refused(NOT_IN_THIS_SLICE[s])
    steps = tuple(s for s in ALL_STEPS if s in steps)

    release = get_release(db, plan["release"]["id"])
    if (release["id"] != plan["release"]["id"] or release["source_revision"] != plan["release"]["source_revision"]
            or release["artifact_digest"] != plan["release"]["artifact_digest"]):
        raise Refused("the release in the control plane is not the one the plan names")
    if "site" in steps and not commit_present(cfg, release["source_revision"]):
        raise Refused(f"commit {release['source_revision'][:12]} is not in this checkout; fetch it first")

    for item in plan.get("refused") or []:
        if isinstance(item, dict) and isinstance(item.get("slug"), str) and SLUG.match(item["slug"]):
            say(f"skipped (refused at plan): {item['slug']}")
    ex = Executor(cfg, db, plan, digest, steps, release)
    say(f"release {release['id']}  commit {release['source_revision']}")
    say(f"steps   {', '.join(steps)}")
    old = {s: signal.signal(s, _raise_interrupted) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        for n, entry in enumerate(plan["trips"]):
            if not ex.run_trip(entry):
                rest = [t["slug"] for t in plan["trips"][n + 1:]]
                if rest:
                    say(f"stopped: {', '.join(rest)} not touched")
                return 1
    finally:
        ex.cleanup()
        for s, handler in old.items():
            signal.signal(s, handler)
    say("rollout finished")
    return 0


# ── status ────────────────────────────────────────────────────────────────────

STATUS_SQL = """
SELECT row_to_json(x) FROM (
  SELECT t.slug, t.lifecycle_state, t.current_release_id, t.previous_release_id,
         cr.source_revision AS current_revision,
         (SELECT row_to_json(r) FROM (
            SELECT to_release_id, result, failed_step, started_at FROM control_plane.trip_rollouts r
             WHERE r.trip_id = t.id ORDER BY r.started_at DESC LIMIT 1) r) AS last_rollout
    FROM control_plane.trips t
    LEFT JOIN control_plane.releases cr ON cr.id = t.current_release_id
   WHERE t.slug NOT LIKE 'retired-%' AND (:'slug' = '' OR t.slug = :'slug')
   ORDER BY t.slug) x;
"""


def cmd_status(cfg: Config, db: Db, args) -> int:
    if args.trip and not SLUG.match(args.trip):
        raise Refused(f"{args.trip!r} is not a slug")
    rows = db.rows(STATUS_SQL, slug=args.trip or "")
    if args.trip and not rows:
        raise Refused(f"no trip {args.trip!r} in the control plane")
    for r in rows:
        current = r["current_release_id"] or "unknown"
        commit = f" ({r['current_revision'][:12]})" if r.get("current_revision") else ""
        prev = r["previous_release_id"] or "none recorded"
        last = r.get("last_rollout")
        if last:
            tail = f"last rollout: {last['result']}" + (f" at {last['failed_step']}" if last.get("failed_step") else "") \
                + f" -> {last['to_release_id']}"
        else:
            tail = "no rollout yet"
        say(f"{r['slug']}  [{r['lifecycle_state']}]  runs {current}{commit}  previous {prev}  {tail}")
    if not rows:
        say("no trips")
    return 0


# ── entry ─────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("plan", help="show, and write to a file, what a rollout would do; changes nothing")
    p.add_argument("--release", required=True, help="a release id or a 40-hex commit")
    p.add_argument("--trip", action="append", help="trip slug, or several separated by commas (repeatable)")
    p.add_argument("--all", action="store_true", help="every eligible trip (not in this slice)")
    p.add_argument("--plan-file", required=True)
    p.add_argument("--steps", help="comma-separated; default site,bridge")
    e = sub.add_parser("execute", help="run a plan file")
    e.add_argument("--plan-file", required=True)
    e.add_argument("--plan-digest", help="the digest `plan` printed; required")
    e.add_argument("--steps", help="run only these steps of the plan")
    s = sub.add_parser("status", help="what each trip runs and its last rollout")
    s.add_argument("--trip")
    return ap


def main(argv: Optional[list] = None, environ: Optional[dict] = None) -> int:
    args = build_parser().parse_args(argv)
    environ = dict(os.environ if environ is None else environ)
    try:
        need = tuple(n for n, _ in REQUIRED_ENV) if args.command != "status" else ("KINERARY_ROLLOUT_PSQL_CMD",)
        cfg = load_config(environ, need)
        db = Db(cfg.psql_cmd, cfg.psql_env())
        handler = {"plan": cmd_plan, "execute": cmd_execute, "status": cmd_status}[args.command]
        return handler(cfg, db, args)
    except Refused as exc:
        whisper(f"refused: {exc}")
        return 2
    except (DbError, RuntimeError) as exc:
        whisper(f"database error: {exc}")
        return 1
    except Interrupted as exc:
        whisper(f"interrupted ({exc})")
        return 130


if __name__ == "__main__":
    sys.exit(main())
