#!/usr/bin/env python3
"""Bring one release to named trips, in order, recording what each trip runs.

Until this command a merged change reached a running trip in pieces — site
payload, then the trip's bridge, then the companion — each run by hand, each with
its own prompt, and nothing recorded which version a trip ran. This is the
order as a command (docs/specs/sprint-9/568-trip-rollout.md, slices R1 and R2: the
site, bridge and companion steps, the record, the approval; and, from #567 S2, the switches step):

    trip-rollout.py plan    --release <id|commit> --trip <slug>[,<slug>...] --plan-file <path>
                            [--steps site,bridge,companion,switches] [--overwrite-edited-companion <slug>[,<slug>...]]
    trip-rollout.py execute --plan-file <path> --plan-digest <sha256:...> [--steps site,bridge,companion,switches]
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
  2. bridge  the deployment's bridge restart, run from the release's own mcp/ (the
             materialized tree, not the host's checkout), then the bridge's own
             /health ("can you reach your trip"), whose code is the failure message
  3. companion
             the profile's SOUL.md and skills re-rendered IN PLACE from the release's
             profile-templates/ for this trip (the installer's `companion_profile_rerender`
             request), then the saved prompts cleared, the gateway restarted and every tool
             the release's bridge declares confirmed registered, read off the gateway's own
             log (companion-refresh-prompts.sh). A profile edited in place, or installed
             before the record of what was rendered existed, is REFUSED and reported, never
             overwritten, unless the plan says so for that trip
             (--overwrite-edited-companion), and then its files are copied aside first. A
             conversation turn in flight is waited for, boundedly, never cut.
  4. switches
             the trip's per-trip feature switches (docs/specs/sprint-9/567-feature-switches.md, S2):
             the registered switches that are ON for this trip are read from the control plane
             (`control_plane.feature_enabled`, the one resolution) and written into the trip's
             trip.config.json ON ITS HOST as a `features` block — exactly those switches, each the
             literal true — by the deployment's own command, which touches no other key (it says so
             with a digest of the rest of the file before and after, and this step refuses the
             verdict if they differ). The command STOPS the site, merges, and STARTS it, in that order:
             a site that is running while its file is rewritten can write its own in-memory copy back
             over the merge (a participant added meanwhile) or lose the participant. Then this step
             waits for the site's own /api/health and READS BACK what the site now serves: GET
             /api/config with the trip's site key (TRIP_API_KEY, else MCP_API_KEY, from the trip's
             mcp/.env, as the bridge uses it — sent as a header, never on a command line, never
             printed), whose `features` must be exactly the member-visible part of what was written.
             The command's own verdict is its word; the readback is the evidence, and it is what
             catches a command that wrote nothing, or a site that did not pick the file up. With no
             key at all, the step says the readback was skipped, in its output, and goes on; a key
             the site REJECTS (HTTP 401/403) fails the step, since skipping would let a command that
             wrote nothing pass. Unlike a provision, a read that fails is a
             FAILED step, not an empty block: an operator is watching, and "every switch off" on a
             doubtful read would silently switch features off on a live trip. The site reads the
             file once at boot, so this is what makes a switch change reach it.

A release built before releases carried mcp/ and profile-templates/ is valid for step 1
and refused for steps 2 and 3 with a message saying so: its seal does not cover them.
Steps run only when named: the default is `site,bridge`, so a deployment that has not yet
configured the companion or features commands below is not broken by either slice.

The way back is the trip's recorded previous release. It is accepted even when that release
is no longer `available` (it was withdrawn from new builds, not from the trips that ran it):
`plan` says so as a warning in its output and in the plan file, and so does the approval
prompt. Any other release that is not `available` is refused.

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
and, only when the companion step is planned (each refused by name when it is unset):
  KINERARY_COMPANION_INSTALL_CMD  the command that runs the companion installer on the host that holds the
                                  profile (scripts/companion-install-host.sh); the request arrives on stdin,
                                  KINERARY_RELEASE_TREE names the release's materialized tree
  KINERARY_COMPANION_REFRESH_CMD  the command that runs scripts/companion-refresh-prompts.sh there
and, only when the switches step is planned (refused by name when unset):
  KINERARY_TRIP_FEATURES_CMD      <cmd> <slug> <vmid> --trip-dir <dir> --restart, with the trip's features block as
                                  JSON on STDIN and a per-run nonce in KINERARY_ROLLOUT_FEATURES_NONCE. In this
                                  order: STOP the trip's site; merge ONLY the `features` key into the trip's live
                                  trip.config.json on its host (every other key, participants added since
                                  provisioning included, left as it is); START the site. (Not merge-then-restart:
                                  a running site rewrites the file from memory when a participant is written.)
                                  Print as its LAST stdout line
                                  `FEATURES <slug> nonce=<n> block=sha256:<h> rest_before=sha256:<r> rest_after=sha256:<r>`
                                  where <n> repeats the nonce, <h> is the sha256 of the block as compact,
                                  key-sorted JSON and <r> is any digest of the rest of the file taken before and
                                  after the write (they must be equal). It never prints the file's content to
                                  stdout or stderr (a failed step shows the tail of both). Exit non-zero on any
                                  failure.
Optional: KINERARY_ROLLOUT_REPO_ROOT (the checkout holding the release commits; default: this one),
KINERARY_ROLLOUT_CHILD_ENV (comma-separated extra variable NAMES the deployment's commands need),
KINERARY_ROLLOUT_SITE_WAIT_SECONDS / _BRIDGE_WAIT_SECONDS / _STEP_TIMEOUT_SECONDS, and for the companion step
KINERARY_ROLLOUT_TURN_WAIT_SECONDS (how long a turn in flight is waited for, default 120) and
KINERARY_ROLLOUT_REGISTRATION_WAIT_SECONDS (how long the gateway has to register the bridge's tools, default 90).

The deploy, bridge, hostname and companion commands run with an ALLOW-LISTED environment, not
this one's: a trip's keys are read inside the step, sent only to the trip's own
loopback bridge as a header, and never printed, logged, stored or put on a command line.
The companion step reads the trip's own config to build the same handoff a provision builds
(the control plane's `build_companion_handoff`) and feeds it to the installer on STDIN: it
carries organizer-private interview answers, so it is never printed, logged or stored.
Otherwise the rollout reads versions and health, never what travellers wrote.
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
# The steps, in the only order they run. R1 built the first two, R2 the third and #567 S2 the last.
ALL_STEPS = ("site", "bridge", "companion", "switches")
BUILT_STEPS = ALL_STEPS
# What runs when no --steps is given. NOT the companion or switches steps yet: they need deployment commands
# (KINERARY_COMPANION_INSTALL_CMD and _REFRESH_CMD; KINERARY_TRIP_FEATURES_CMD) that a deployment configured for
# R1 does not have, and a default that suddenly refuses is not a default. Adding them is this one line, once the
# deployment's wrapper sets those.
DEFAULT_STEPS = ("site", "bridge")
# The release payload each step runs from: a release sealed before these trees were part of it covers neither.
STEP_ROOTS = {"bridge": ("mcp",), "companion": ("profile-templates", "mcp")}
# The steps that run from the release's materialized tree, so need its commit in the checkout.
RUNS_FROM_TREE = frozenset(("site", "bridge", "companion"))
# A rollback to the trip's own previous release is accepted when that release was withdrawn from new builds:
# `deprecated`. A `retired` release was pulled on purpose and is not a way back; candidate and verified never ran.
ROLLBACK_STATUSES = ("deprecated",)
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
TURN_WAIT_DEFAULT = 120
REGISTRATION_WAIT_DEFAULT = 90
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
    companion_install_cmd: list = dataclasses.field(default_factory=list)
    companion_refresh_cmd: list = dataclasses.field(default_factory=list)
    features_cmd: list = dataclasses.field(default_factory=list)
    turn_wait: int = 120
    registration_wait: int = 90

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


# Needed only when the companion step is planned or run: asked for then, by name, not at every command.
COMPANION_ENV = (
    ("KINERARY_COMPANION_INSTALL_CMD", "the command that runs the companion installer on the host that holds the profile"),
    ("KINERARY_COMPANION_REFRESH_CMD", "the command that clears a companion's saved prompts and restarts its gateway"),
)


# Needed only when the switches step is planned or run, for the same reason.
FEATURES_ENV = (
    ("KINERARY_TRIP_FEATURES_CMD", "the command that writes a trip's features block into its live trip.config.json on its host and restarts the site"),
)


def require_features_config(cfg: "Config") -> None:
    missing = [(n, why) for n, why in FEATURES_ENV if not cfg.environ.get(n)]
    if missing:
        lines = "\n".join(f"  {n}  — {why}" for n, why in missing)
        raise Refused("the switches step needs the deployment's own command; unset:\n" + lines +
                      "\nThe deployment's wrapper sets it (hard rule 6: this repository names no host, container or path).")
    if not cfg.features_cmd:
        raise Refused("KINERARY_TRIP_FEATURES_CMD must not be empty")


def require_companion_config(cfg: "Config") -> None:
    missing = [(n, why) for n, why in COMPANION_ENV if not cfg.environ.get(n)]
    if missing:
        lines = "\n".join(f"  {n}  — {why}" for n, why in missing)
        raise Refused("the companion step needs the deployment's own commands; unset:\n" + lines +
                      "\nThe deployment's wrapper sets them (hard rule 6: this repository names no host, container or path).")
    if not cfg.companion_install_cmd or not cfg.companion_refresh_cmd:
        raise Refused("KINERARY_COMPANION_INSTALL_CMD and KINERARY_COMPANION_REFRESH_CMD must not be empty")


def _seconds(environ: dict, name: str, default: int) -> int:
    raw = environ.get(name, "")
    if not raw:
        return default
    if not raw.isdigit() or int(raw) < 1:
        raise Refused(f"{name} must be a whole number of seconds, not {raw!r}")
    return int(raw)


def words_optional(environ: dict, name: str) -> list:
    try:
        return shlex.split(environ.get(name, ""))
    except ValueError as exc:
        raise Refused(f"{name} is not a command line: {exc}")


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
        companion_install_cmd=words_optional(environ, "KINERARY_COMPANION_INSTALL_CMD"),
        companion_refresh_cmd=words_optional(environ, "KINERARY_COMPANION_REFRESH_CMD"),
        features_cmd=words_optional(environ, "KINERARY_TRIP_FEATURES_CMD"),
        turn_wait=_seconds(environ, "KINERARY_ROLLOUT_TURN_WAIT_SECONDS", TURN_WAIT_DEFAULT),
        registration_wait=_seconds(environ, "KINERARY_ROLLOUT_REGISTRATION_WAIT_SECONDS", REGISTRATION_WAIT_DEFAULT),
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
         COALESCE(jsonb_typeof(manifest -> 'files') = 'array', false) AS has_manifest,
         CASE WHEN jsonb_typeof(manifest -> 'files') = 'array'
              THEN EXISTS (SELECT 1 FROM jsonb_array_elements(manifest -> 'files') f WHERE f ->> 'path' LIKE 'mcp/%')
              ELSE false END AS has_bridge,
         CASE WHEN jsonb_typeof(manifest -> 'files') = 'array'
              THEN EXISTS (SELECT 1 FROM jsonb_array_elements(manifest -> 'files') f WHERE f ->> 'path' LIKE 'profile-templates/%')
              ELSE false END AS has_companion
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
                  WHERE j.trip_id = t.id AND j.state IN ('queued', 'leased', 'running', 'waiting')) AS job_in_flight,
         pv.release_id AS provisioned_release_id,
         COALESCE(pv.finished_at > (SELECT max(r.started_at) FROM control_plane.trip_rollouts r WHERE r.trip_id = t.id),
                  pv.finished_at IS NOT NULL) AS provisioned_after_last_rollout
    FROM control_plane.trips t
    LEFT JOIN LATERAL (
      SELECT p.release_id, j.updated_at AS finished_at
        FROM control_plane.plans p
        JOIN control_plane.jobs j ON j.plan_id = p.id AND j.job_type = 'provision' AND j.state = 'succeeded'
       WHERE p.trip_id = t.id AND p.status = 'executed' AND p.release_id IS NOT NULL
       ORDER BY p.created_at DESC, p.id DESC LIMIT 1) pv ON true
   WHERE t.slug = :'slug') x;
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


def run_child(cfg: Config, args: list, extra_env: Optional[dict] = None, timeout: Optional[int] = None,
              input_text: Optional[str] = None):
    """A child with the allow-listed environment. No stdin unless `input_text` is given: the two things that are are the
    companion handoff, which carries organizer-private interview data and so travels on stdin and nowhere else, and
    the switches step's features block (a few registered names, no trip data).
    Output is captured, never streamed: the caller decides what part of it, scrubbed, is shown."""
    return subprocess.run(args, capture_output=True, text=True,
                          stdin=subprocess.DEVNULL if input_text is None else None, input=input_text,
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


ROOT_FLAGS = {"mcp": "has_bridge", "profile-templates": "has_companion"}


def release_refusal(cfg: Config, release: dict, row: dict, steps: tuple = ("site",), rollback_ok: bool = False) -> Optional[str]:
    """Why this release may not go to this trip, or None.

    `rollback_ok` is the caller's finding that the release IS this trip's own recorded previous release: the way
    back stays open after the release was withdrawn from new builds (`deprecated`), because the trips that ran it
    still need it as their safety net (spec Decision 5). Every other release that is not `available` is refused."""
    status = release["status"]
    if status != "available" and not (rollback_ok and status in ROLLBACK_STATUSES):
        return f"release {release['id']} is {status}, not available"
    if not release["has_manifest"]:
        return f"release {release['id']} has no sealed manifest, so its tree cannot be verified"
    schema = row.get("data_schema")
    if schema is None:
        return "the trip has no confirmed intake, so whether the release's data schema covers it is unknown"
    if not (release["data_schema_min"] <= schema <= release["data_schema_max"]):
        return (f"the trip's data schema {schema} is outside what release {release['id']} covers "
                f"({release['data_schema_min']}..{release['data_schema_max']})")
    for step in steps:
        absent = [r for r in STEP_ROOTS.get(step, ()) if not release.get(ROOT_FLAGS[r])]
        if absent:
            return (f"release {release['id']} was built before releases carried the bridge (mcp/) and the companion "
                    f"templates (profile-templates/): its seal does not cover {' or '.join(absent)}, so the {step} step "
                    "cannot run from it. Run the site step alone (--steps site) or name a later release")
    return None


def rollback_warning(release: dict) -> str:
    return (f"release {release['id']} is {release['status']}, no longer available for new builds. It is accepted "
            "because it is this trip's own recorded previous release: the way back stays open for a trip that ran it")


def stale_record_warning(row: dict) -> Optional[str]:
    """A warning, never a refusal: the trip's recorded release disagrees with the release of its latest
    successful provision, and no rollout has run since. A control-plane rollback followed by a re-provision
    leaves the record stale this way, and the migration's backfill does not run again. After a rollout the two
    differ on purpose (the record is newer), which is why a rollout since the provision silences it."""
    current, provisioned = row.get("current_release_id"), row.get("provisioned_release_id")
    if current and provisioned and current != provisioned and row.get("provisioned_after_last_rollout"):
        return (f"the recorded release is {current}, but the trip's latest successful provision was onto "
                f"{provisioned} and no rollout has run since, so the record may be stale; check what the trip "
                "really runs before relying on it as the way back")
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
        if s not in BUILT_STEPS:
            raise Refused(f"the {s} step is not built")
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
    overwrite = set()
    for item in args.overwrite_edited_companion or []:
        overwrite.update(x for x in item.split(",") if x)
    if overwrite and "companion" not in steps:
        raise Refused("--overwrite-edited-companion belongs to the companion step, which this plan does not run")
    if overwrite - set(slugs):
        raise Refused(f"--overwrite-edited-companion names {sorted(overwrite - set(slugs))[0]!r}, which is not a trip in this plan")
    if "companion" in steps:
        require_companion_config(cfg)
    if "switches" in steps:
        require_features_config(cfg)
    release = get_release(db, args.release)

    present = commit_present(cfg, release["source_revision"])
    trips, refused, notes, warnings = [], [], [], []
    say(f"release {release['id']}  commit {release['source_revision']}  ({release['status']})")
    say(f"steps   {', '.join(steps)}")
    for slug in slugs:
        try:
            trip = resolve_trip(cfg, db, slug)
            rollback = trip.row.get("previous_release_id") == release["id"]
            why = release_refusal(cfg, release, trip.row, steps, rollback)
            if why is None and RUNS_FROM_TREE.intersection(steps) and not present:
                why = f"commit {release['source_revision'][:12]} is not in this checkout; fetch it first"
            if why:
                raise Refused(f"{slug}: {why}")
        except Refused as exc:
            refused.append({"slug": slug, "reason": str(exc)})
            say(f"  REFUSED  {exc}")
            continue
        current = trip.current
        entry = {"slug": slug, "trip_id": trip.row["id"], "from_release_id": current,
                 "previous_release_id": trip.row.get("previous_release_id")}
        if release["status"] != "available":
            # Only reachable for the trip's own previous release (release_refusal). Recorded as data, not just
            # prose, so the approval prompt can state it from a field it validates rather than from free text.
            entry["target_status"] = release["status"]
            note_text = rollback_warning(release)
            warnings.append({"slug": slug, "warning": note_text})
            say(f"  WARNING  {slug}: {note_text}")
        if slug in overwrite:
            entry["overwrite_edited_companion"] = True
        trips.append(entry)
        stale = stale_record_warning(trip.row)
        if stale:
            warnings.append({"slug": slug, "warning": stale})
            say(f"  WARNING  {slug}: {stale}")
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
        if slug in overwrite:
            say("      a companion edited in place WILL BE OVERWRITTEN, after its files are copied aside")
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
        "warnings": warnings,
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
        # Added in R2; a plan written by R1 has none of them and stays valid.
        prev = t.get("previous_release_id")
        if not (prev is None or (isinstance(prev, str) and RELEASE_REF.match(prev))):
            return f"{t['slug']}: the recorded previous release is malformed"
        status = t.get("target_status")
        if not (status is None or status in ROLLBACK_STATUSES):
            return f"{t['slug']}: the target status is not one a rollback accepts"
        if status is not None and prev != rel["id"]:
            return f"{t['slug']}: it records a withdrawn target that is not its previous release"
        overwrite = t.get("overwrite_edited_companion", False)
        if not isinstance(overwrite, bool) or (overwrite and "companion" not in steps):
            return f"{t['slug']}: overwrite_edited_companion is malformed or names a step the plan does not run"
    return None


def scrub(text: str, limit: int = 15) -> str:
    """The tail of a child's output, safe to show: control characters out, and
    anything that looks like a secret assignment redacted. Shown, never stored."""
    lines = [re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "?", ln)[:300] for ln in text.splitlines() if ln.strip()]
    lines = [re.sub(r"(?i)(key|token|secret|password|passwd)(\s*[=:]\s*)\S+", r"\1\2<redacted>", ln)
             for ln in lines[-limit:]]
    return "\n".join("      | " + ln for ln in lines)


def http_get(url: str, headers: Optional[dict] = None, timeout: int = 15, limit: int = 8192) -> tuple:
    """(status, body) — no proxy, whatever the environment says: these are
    loopback and LAN addresses. The body is read up to `limit` bytes."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.read(limit).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(limit).decode("utf-8", "replace")


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


def read_site_key(trip: Trip) -> Optional[str]:
    """The key the trip's bridge presents to the trip's SITE (mcp/mcp.js: TRIP_API_KEY, falling back to its own
    MCP_API_KEY), read from the same file the bridge step reads. None when there is none."""
    try:
        text = (trip.trip_dir / "mcp" / ".env").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    found = {}
    for line in text.splitlines():
        for name in ("TRIP_API_KEY", "MCP_API_KEY"):
            if line.startswith(name + "="):
                found[name] = line.split("=", 1)[1].strip().strip("\"'\r") or None
    return found.get("TRIP_API_KEY") or found.get("MCP_API_KEY")


def file_digest(path: Path) -> Optional[str]:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _load_worker_module(filename: str, name: str):
    path = REPO / "control-plane" / "worker" / "control_plane_worker" / filename
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_release_source():
    return _load_worker_module("release_source.py", "kinerary_release_source")


def load_feature_block():
    """The worker's own `features` block builder and registry mirror: the SAME code a provision uses, so a rollout writes
    the block a provision would. Stdlib-only, which is why it can be read by path here."""
    return _load_worker_module("feature_block.py", "kinerary_feature_block")


def load_companion_profile():
    """The control plane's own `build_companion_handoff`: the SAME function a provision calls, so the companion a
    rollout renders is built from the same shape. It is stdlib-only, which is why it can be read by path here."""
    return _load_worker_module("companion_profile.py", "kinerary_companion_profile")


# What `_attach_companion` hands `build_companion_handoff` besides the config: the confirmed intake's provenance and
# the site's canonical address (the private URL the provision recorded). Read-only, by slug.
HANDOFF_SQL = """
SELECT row_to_json(x) FROM (
  SELECT t.id AS trip_id, iv.id AS intake_version_id, iv.schema_version, iv.digest, iv.confirmed_at,
         (SELECT j.result ->> 'private_url' FROM control_plane.jobs j
           WHERE j.trip_id = t.id AND j.job_type = 'provision' AND j.state = 'succeeded'
             AND j.result ->> 'private_url' IS NOT NULL
           ORDER BY j.updated_at DESC LIMIT 1) AS private_url
    FROM control_plane.trips t
    JOIN control_plane.intake_versions iv ON iv.trip_id = t.id
   WHERE t.slug = :'slug'
   ORDER BY iv.version DESC LIMIT 1) x;
"""

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

# The answer for every registered switch, from the same SQL function a provision and the relay use — one
# resolution, never recomputed here. A trip that is not in `trips` yields no rows, which the step reports.
FEATURES_SQL = """
SELECT row_to_json(x) FROM (
  SELECT s AS switch, control_plane.feature_enabled(t.id, s) AS enabled
    FROM control_plane.trips t, unnest(string_to_array(:'names', ',')) AS s
   WHERE t.id = :'trip_id') x;
"""

FEATURES_VERDICT = re.compile(
    r"^FEATURES ([a-z0-9][a-z0-9-]{0,62}) nonce=([a-f0-9]{32}) block=(sha256:[a-f0-9]{64}) rest_before=(sha256:[a-f0-9]{64}) rest_after=(sha256:[a-f0-9]{64})$")

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


class StepSkipped(Exception):
    """A step that has nothing to do for this trip, and says why. Not a failure, and not silence."""


RERENDER_VERDICT = re.compile(r"^RERENDER ([a-z0-9][a-z0-9-]{1,62}) (clean|edited|unknown_provenance|applied|unchanged)$")
REFRESHED = re.compile(r"^REFRESHED ([a-z0-9][a-z0-9_-]{0,63}) prompts=([0-9]+) tools=([0-9]+)$")
DRYRUN = re.compile(r"^DRYRUN ([a-z0-9][a-z0-9_-]{0,63}) turns_in_flight=([0-9]+) prompts=([0-9]+)$")


def _raise_interrupted(signum, _frame):
    raise Interrupted(signal.Signals(signum).name)


class Executor:
    def __init__(self, cfg: Config, db: Db, plan: dict, plan_digest: str, steps: tuple, release_row: dict) -> None:
        self.cfg, self.db, self.plan, self.plan_digest, self.steps = cfg, db, plan, plan_digest, steps
        self.release = plan["release"]
        self.release_row = release_row   # the control plane's own row, re-read at execute
        self.tree: Optional[str] = None

    def materialized(self, step: str = "site") -> str:
        if self.tree is None:
            source = load_release_source()
            try:
                self.tree = source.materialize_release_source(
                    str(self.cfg.repo_root), self.release["source_revision"], self.release["artifact_digest"])
            except Exception as exc:
                code = getattr(exc, "safe_error_code", type(exc).__name__)
                raise StepFailed(step, f"the release tree could not be materialized and verified ({code})")
        return self.tree

    def tree_for(self, step: str) -> str:
        """The release's tree, which must hold what this step runs from. The plan checked the manifest; this checks the
        tree itself, the thing that is actually run."""
        tree = self.materialized(step)
        absent = [r for r in STEP_ROOTS.get(step, ()) if not (Path(tree) / r).is_dir()]
        if absent:
            raise StepFailed(step, f"release {self.release['id']} does not carry {', '.join(r + '/' for r in absent)}: it "
                                   "was built before releases did, so the step cannot run from it")
        return tree

    def cleanup(self) -> None:
        if self.tree:
            shutil.rmtree(self.tree, ignore_errors=True)
            self.tree = None

    # ---- steps

    def step_site(self, trip: Trip, rollout: dict) -> None:
        tree = self.materialized("site")
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
        # The bridge runs the RELEASE's mcp/, from the materialized tree, exactly as the site step deploys the
        # release's site/: REPO_ROOT names the tree and the deployment's restart reads mcp/ under it. Not the
        # host's checkout, which may be any commit.
        tree = self.tree_for("bridge")
        args = self.cfg.bridge_cmd + ["--restart-only", "--trip-dir", str(trip.trip_dir)]
        extra = {"REPO_ROOT": tree,
                 "KINERARY_ROLLOUT_RELEASE_COMMIT": self.release["source_revision"],
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

    def build_handoff(self, trip: Trip) -> Optional[dict]:
        """The handoff a provision of this trip builds, from the trip's own config on this host and the control plane's
        record of its confirmed intake: through the SAME `build_companion_handoff`. None when the trip has no
        companion (its config names no assistant, or no organizer that resolves to a participant)."""
        try:
            config = json.loads((trip.trip_dir / "trip.config.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise StepFailed("companion", "the trip's trip.config.json cannot be read, so its companion cannot be rendered")
        if not isinstance(config, dict):
            raise StepFailed("companion", "the trip's trip.config.json is not an object")
        builder = load_companion_profile().build_companion_handoff
        # Whether this trip has a companion at all is the builder's own call (no assistant named, or no organizer that
        # resolves to a participant, is None), made before anything is read from the control plane: ask it first.
        try:
            probe = builder(trip_id=trip.row["id"], slug=trip.slug, config=config, intake_version_id="probe",
                            intake_schema_version=1, intake_digest="probe", confirmed_at="probe",
                            canonical_site_url="http://probe.invalid")
        except Exception as exc:    # a malformed config: say which kind of thing, never what it held
            raise StepFailed("companion", f"the companion handoff could not be built from the trip's config ({type(exc).__name__})")
        if probe is None:
            return None
        rows = self.db.rows(HANDOFF_SQL, slug=trip.slug)
        if not rows or not rows[0].get("private_url"):
            raise StepFailed("companion", "the control plane has no confirmed intake or no recorded site address for this trip; "
                                          "its companion cannot be rendered from what a provision would have built")
        row = rows[0]
        return builder(trip_id=row["trip_id"], slug=trip.slug, config=config, intake_version_id=row["intake_version_id"],
                       intake_schema_version=row["schema_version"], intake_digest=row["digest"], confirmed_at=row["confirmed_at"],
                       canonical_site_url=row["private_url"])

    def installer(self, tree: str, handoff: dict, mode: str, allow: bool) -> tuple:
        """One `companion_profile_rerender` request: (verdict, scrubbed stderr). The request, which holds the handoff,
        goes on stdin and is never printed."""
        name = handoff["profile"]["name"]
        request = {"record_type": "companion_profile_rerender", "schema_version": 1, "profile": {"name": name},
                   "handoff": handoff, "mode": mode, "allow_edited": allow,
                   "release": {"id": self.release["id"], "commit": self.release["source_revision"]}}
        try:
            done = run_child(self.cfg, self.cfg.companion_install_cmd, {"KINERARY_RELEASE_TREE": tree},
                             input_text=json.dumps(request, ensure_ascii=False))
        except OSError as exc:
            raise StepFailed("companion", f"the companion installer did not run ({type(exc).__name__})")
        except subprocess.TimeoutExpired:
            raise StepFailed("companion", f"the companion installer did not finish within {self.cfg.step_timeout}s")
        if done.returncode != 0:
            raise StepFailed("companion", f"the companion installer exited {done.returncode}\n{scrub(done.stdout + done.stderr)}")
        lines = [ln for ln in done.stdout.splitlines() if ln.strip()]
        found = RERENDER_VERDICT.match(lines[-1]) if lines else None
        if not found or found.group(1) != name:
            raise StepFailed("companion", "the companion installer gave no verdict this command recognises")
        return found.group(2), scrub(done.stderr, limit=6)

    def refresh(self, name: str, *flags: str) -> str:
        args = self.cfg.companion_refresh_cmd + list(flags) + [name]
        timeout = max(self.cfg.step_timeout, self.cfg.turn_wait + self.cfg.registration_wait + 120)
        try:
            done = run_child(self.cfg, args, timeout=timeout)
        except OSError as exc:
            raise StepFailed("companion", f"the prompt refresh did not run ({type(exc).__name__})")
        except subprocess.TimeoutExpired:
            raise StepFailed("companion", f"the prompt refresh did not finish within {timeout}s")
        if done.returncode != 0:
            why = {3: f"a conversation turn was still in flight after waiting {self.cfg.turn_wait}s, so the gateway was NOT "
                      "restarted and nothing was cut; run the step again when the conversation is quiet",
                   5: "the gateway did not register every tool the release's bridge declares",
                   6: "the release's bridge source could not be read for its tool names"}.get(done.returncode,
                                                                                         f"the prompt refresh exited {done.returncode}")
            raise StepFailed("companion", f"{why}\n{scrub(done.stdout + done.stderr)}")
        lines = [ln for ln in done.stdout.splitlines() if ln.strip()]
        return lines[-1] if lines else ""

    def step_companion(self, trip: Trip, rollout: dict) -> None:
        tree = self.tree_for("companion")
        handoff = self.build_handoff(trip)
        if handoff is None:
            raise StepSkipped("this trip has no companion: its config names no assistant, or no organizer that resolves to a "
                              "participant, so a provision builds none either")
        name = handoff["profile"]["name"]
        allow = bool(rollout.get("overwrite_edited_companion"))
        bridge_source = str(Path(tree) / "mcp" / "mcp.js")
        server = str(handoff["trip"].get("site_connection_name") or "trip-mcp")

        # 1. Is the profile one that may be re-rendered? Asked first, writing nothing, so a refusal changes nothing.
        verdict, noise = self.installer(tree, handoff, "check", False)
        if verdict in ("edited", "unknown_provenance") and not allow:
            what = ("was edited in place" if verdict == "edited" else
                    "was installed before the record of what was rendered existed, so an edit cannot be told from the original")
            raise StepFailed("companion", f"the companion profile {name} {what}; nothing was overwritten.\n{noise}\n"
                                          f"      Copy what is worth keeping into the release's templates, then plan again with "
                                          f"--overwrite-edited-companion {trip.slug} to replace it (its files are copied aside first).")
        # 2. Can the gateway's database be read, and is a turn in flight? Informational: the wait is the refresh's.
        pre = self.refresh(name, "--dry-run", "--expect-tools-from", bridge_source, "--server", server)
        if not DRYRUN.match(pre):
            raise StepFailed("companion", "the prompt refresh's dry run gave no answer this command recognises")
        if int(DRYRUN.match(pre).group(2)):
            say(f"      a conversation turn is in flight; it is waited for up to {self.cfg.turn_wait}s, never cut")
        # 3. Re-render in place.
        verdict, noise = self.installer(tree, handoff, "apply", allow)
        if verdict not in ("applied", "unchanged"):
            raise StepFailed("companion", f"the companion profile {name} was not re-rendered ({verdict}); nothing was overwritten\n{noise}")
        if allow and "copied to" in noise:
            say(noise)
        say(f"      profile {name}: {verdict}")
        # 4. Clear the saved prompts, restart the gateway, and read its own log for every tool the bridge declares.
        done = self.refresh(name, "--wait", str(self.cfg.turn_wait), "--expect-tools-from", bridge_source, "--server", server,
                            "--registration-wait", str(self.cfg.registration_wait))
        found = REFRESHED.match(done)
        if not found or found.group(1) != name or int(found.group(3)) < 1:
            raise StepFailed("companion", "the prompt refresh did not confirm the gateway's tools")
        say(f"      gateway restarted, {found.group(2)} saved prompt(s) cleared, {found.group(3)} bridge tool(s) registered")

    def step_switches(self, trip: Trip, rollout: dict) -> None:
        """Write the trip's resolved `features` block into its live config on its host, touching no other key, then wait
        for the site to be healthy again. Every failure is a failed step; nothing here falls back to "all off"."""
        feature_block = load_feature_block()
        names = list(feature_block.REGISTERED_SWITCHES)
        if not names:
            raise StepFailed("switches", "the worker's switch registry is empty, so there is nothing to resolve")
        try:
            rows = self.db.rows(FEATURES_SQL, names=",".join(names), trip_id=trip.row["id"])
        except (DbError, RuntimeError) as exc:
            raise StepFailed("switches", "the trip's switches could not be read from the control plane; nothing was written\n"
                                         + scrub(str(exc)))
        answers = {}
        for row in rows:
            if isinstance(row, dict) and isinstance(row.get("switch"), str) and isinstance(row.get("enabled"), bool):
                answers[row["switch"]] = row["enabled"]
        absent = [n for n in names if n not in answers]
        if absent:
            raise StepFailed("switches", f"the control plane gave no answer for {', '.join(absent)}; nothing was written")
        block = feature_block.build_features_block(answers)
        payload = json.dumps(block, sort_keys=True, separators=(",", ":"))
        expected = digest_of(payload.encode("utf-8"))

        config_path = trip.trip_dir / "trip.config.json"
        local_before = file_digest(config_path)
        args = self.cfg.features_cmd + [trip.slug, trip.vmid, "--trip-dir", str(trip.trip_dir), "--restart"]
        nonce = secrets.token_hex(16)     # a verdict must repeat it: a line printed without running this run's command fails
        try:
            done = run_child(self.cfg, args, {"KINERARY_ROLLOUT_FEATURES_NONCE": nonce}, input_text=payload)
        except OSError as exc:
            raise StepFailed("switches", f"the features command did not run ({type(exc).__name__})")
        except subprocess.TimeoutExpired:
            raise StepFailed("switches", f"the features command did not finish within {self.cfg.step_timeout}s")
        if done.returncode != 0:
            raise StepFailed("switches", f"the features command exited {done.returncode}\n{scrub(done.stdout + done.stderr)}")
        lines = [ln for ln in done.stdout.splitlines() if ln.strip()]
        found = FEATURES_VERDICT.match(lines[-1]) if lines else None
        if not found or found.group(1) != trip.slug:
            raise StepFailed("switches", "the features command gave no verdict this command recognises, so what it wrote is unknown")
        if found.group(2) != nonce:
            raise StepFailed("switches", "the features command's verdict does not carry this run's nonce, so it is not a verdict of this run")
        if found.group(3) != expected:
            raise StepFailed("switches", "the features command wrote a different block from the one it was given")
        if found.group(4) != found.group(5):
            raise StepFailed("switches", "the features command changed something other than `features` in the trip's config; "
                                         "a rollout writes the features block and nothing else")
        if file_digest(config_path) != local_before:
            raise StepFailed("switches", "the trip's local trip.config.json changed during the step; this step writes the live copy only")
        if not site_healthy(trip, self.cfg.site_wait):
            raise StepFailed("switches", f"the site's own /api/health did not answer ok within {self.cfg.site_wait}s after the restart")
        say(f"      features written: {', '.join(block) if block else 'none (every switch is off for this trip)'}")
        self.read_back_features(trip, block)

    def read_back_features(self, trip: Trip, block: dict) -> None:
        """What the SITE now serves, as the trip's own site key sees it: the member-visible part of `block`, exactly. The
        command's verdict is its own word; this is the evidence, and it fails the step when the site disagrees (a command
        that wrote nothing, a site that kept its old file), and when the site rejects the key (a misconfiguration, and a skip
        would let the liar through). No key at all is said in the output and not failed: the check cannot be made, and a
        silent skip is how a stale block would go unseen."""
        feature_block = load_feature_block()
        expected = {n: True for n in block if n in feature_block.MEMBER_VISIBLE_SWITCHES}
        key = read_site_key(trip)
        if not key:
            say("      readback SKIPPED: no site key beside the trip (mcp/.env), so what the site now serves was not checked")
            return
        try:
            status, body = http_get(f"http://{trip.site_host}:{trip.site_port}/api/config", {"X-API-Key": key},
                                    timeout=20, limit=16 * 1024 * 1024)
        except OSError as exc:
            raise StepFailed("switches", f"the site could not be asked what it serves after the restart ({type(exc).__name__})")
        if status in (401, 403):
            raise StepFailed("switches", f"the site did not accept the trip's key (HTTP {status}), so what it now serves could not be "
                                         "checked; a key the site rejects is a misconfiguration, and skipping the check would let a "
                                         "command that wrote nothing pass")
        if status != 200:
            raise StepFailed("switches", f"GET /api/config answered HTTP {status} after the restart")
        try:
            doc = json.loads(body)
        except ValueError:
            doc = None
        if not isinstance(doc, dict):
            raise StepFailed("switches", "GET /api/config did not answer a JSON object after the restart")
        served = doc.get("features", {})
        if served != expected:
            names = (", ".join(sorted(str(k) for k in served)) if isinstance(served, dict) else "something that is not a block") or "none"
            raise StepFailed("switches", "the site does not serve the features that were written (serves: " + names + "; expected: "
                                         + (", ".join(expected) or "none") + "): it did not pick the file up, or the command did not write it")
        say(f"      readback ok: the site serves {', '.join(expected) if expected else 'no features'} to a member")

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
            # The same rule `plan` applied, against what `plan` recorded: the way back is open only when the release
            # is this trip's own previous release NOW and was when the plan was written.
            # ...and only when the plan recorded the very status the approval displayed (target_status): a release
            # deprecated AFTER a plan that said "available" carried no warning, so it is not waved through.
            rollback = (entry.get("previous_release_id") == self.release["id"]
                        and trip.row.get("previous_release_id") == self.release["id"]
                        and entry.get("target_status") == self.release_row["status"])
            row_refusal = release_refusal(self.cfg, self.release_row, trip.row, self.steps, rollback)
            if row_refusal:
                raise Refused(f"{slug}: {row_refusal}")
        except Refused as exc:
            say(f"  REFUSED  {exc}")
            return False

        rollout = {"id": "rollout_" + secrets.token_hex(8), "from": trip.current,
                   "overwrite_edited_companion": entry.get("overwrite_edited_companion") is True}
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
                try:
                    getattr(self, f"step_{step}")(trip, rollout)
                except StepSkipped as skipped:
                    say(f"  {step} skipped: {skipped}")
                    continue
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
        if s not in BUILT_STEPS:
            raise Refused(f"the {s} step is not built")
    steps = tuple(s for s in ALL_STEPS if s in steps)
    if "companion" in steps:
        require_companion_config(cfg)
    if "switches" in steps:
        require_features_config(cfg)

    release = get_release(db, plan["release"]["id"])
    if (release["id"] != plan["release"]["id"] or release["source_revision"] != plan["release"]["source_revision"]
            or release["artifact_digest"] != plan["release"]["artifact_digest"]):
        raise Refused("the release in the control plane is not the one the plan names")
    if RUNS_FROM_TREE.intersection(steps) and not commit_present(cfg, release["source_revision"]):
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
    p.add_argument("--steps", help="comma-separated, from site,bridge,companion,switches; default site,bridge")
    p.add_argument("--overwrite-edited-companion", action="append", metavar="SLUG[,SLUG...]",
                   help="let the companion step replace a profile edited in place (its files are copied aside first); "
                        "default: an edited profile is reported and left alone")
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
