#!/usr/bin/env python3
"""One trip, signup to working companion, asserted at every stage.

WHY THIS EXISTS. On 2026-09-10 a provisioning job reported `succeeded` while
delivering a site with no assistant behind it. It was not lying about any one
step — each step was best-effort by design and each failure was recorded as a
warning. What nothing did was ask, afterwards, whether the thing was actually
built. Four separate faults hid in that gap for a whole day:

  * the MCP transport patch died on a missing PyYAML and left the entry
    DISABLED, while provisioning reported success;
  * `setup-mcp.sh` was killed at 180s by a timeout set to a third of its work;
  * the companion installer treated a bare `hermes profile create` skeleton as
    a finished companion and skipped rendering;
  * the companion had no relay identity, so every message it should have
    answered was served by the interviewer instead.

Every one is invisible from the job's own status and obvious from outside. So
this checks from outside, and each stage FAILS LOUDLY rather than warning.

    scripts/e2e-full-cycle.py --scenario multi               # leave it running
    scripts/e2e-full-cycle.py --scenario japan --teardown    # remove it afterwards
    scripts/e2e-full-cycle.py --scenario own                 # a person's OWN trip

The scenarios are fixtures: `japan`, `multi` and `manual` each have documents
and answers written down in control-plane/api/test/fixtures/make_documents.py,
so the run can assert that a place named in a document reached the phase page.
`own` is the other case — a person answering about a trip they actually mean to
take. Nothing about it is scripted and nothing here knows the destination, so
what the site is checked against is the intake THEY confirmed, read back from
control_plane.intake_versions after the fact.

Leaving the trip running is the default, for a trip someone wants to poke at
afterwards. `--teardown` removes exactly the trip this run created — by the id
signup returned, never by name — through scripts/teardown-trip.py, which undoes
every reference provisioning left: container, DNS, proxy host, profile,
gateway, bridge, allowlist entry, chat bindings, slug. It runs whether the
cycle passed or failed, because a failed run leaves the most behind.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
API = os.environ.get("KINERARY_API", "http://127.0.0.1:4310")
# Which stack this run inspects. The Mac's local compose project by default;
# `kinerary-cp` on the Proxmox VM (control-plane/deployment/compose.vm.yml),
# where the runner runs ON the VM so loopback addresses mean the VM's own.
PROJECT = os.environ.get("KINERARY_COMPOSE_PROJECT", "kinerary-control-plane-local")
MAC_STACK = PROJECT == "kinerary-control-plane-local"
PG = f"{PROJECT}-postgres-1"
# Where that stack keeps trips and companions, and how to reach its Hermes.
# The Mac's home directory and venv by default; on the VM these are root-only
# paths under /opt and a `hermes` wrapper into the container — which is why the
# VM runs this through control-plane/deployment/vm-e2e.sh, as root.
DEPLOY_ROOT = Path(os.environ.get("KINERARY_DEPLOY_ROOT") or Path.home() / "kinerary-deploy")
HERMES_HOME = Path(os.environ.get("KINERARY_HERMES_HOME") or Path.home() / ".hermes")


def hermes_cli() -> list[str]:
    exe = os.environ.get("KINERARY_HERMES_BIN")
    return [exe] if exe else [os.path.expanduser("~/.hermes/hermes-agent/venv/bin/python"), "-m", "hermes_cli.main"]

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


# The scenario that is not a fixture: a person's own trip. Named once so the
# places that must treat it differently cannot drift apart.
OWN = "own"


class Failed(Exception):
    """A stage that did not deliver what it claims to deliver."""


_stage = 0


def stage(title: str) -> None:
    global _stage
    _stage += 1
    print(f"\n{DIM}── {_stage}. {title} ──{RESET}")


def ok(msg: str) -> None:
    print(f"  {GREEN}✓{RESET} {msg}")


def note(msg: str) -> None:
    print(f"  {DIM}·{RESET} {msg}")


def check(condition: bool, good: str, bad: str) -> None:
    if condition:
        ok(good)
    else:
        raise Failed(bad)


# ── plumbing ─────────────────────────────────────────────────────────────────

def psql(sql: str) -> str:
    out = subprocess.run(
        ["docker", "exec", PG, "psql", "-U", "kinerary_control_plane",
         "-d", "kinerary_control_plane", "-At", "-c", sql],
        capture_output=True, text=True,
    )
    return out.stdout.strip()


def auth_header(email: str, password: str) -> dict[str, str]:
    blob = base64.urlsafe_b64encode(
        json.dumps({"email": email, "password": password}).encode()
    ).decode().rstrip("=")
    return {"X-Portal-Password-Login": blob}


def api(method: str, path: str, body: dict | None = None, headers: dict | None = None) -> dict:
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body or {}).encode() if method == "POST" else None,
        headers={"content-type": "application/json", **(headers or {})},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raise Failed(f"{method} {path} -> {exc.code}: {exc.read().decode(errors='replace')[:200]}") from exc


def wait_for(what: str, probe, timeout: int, interval: int = 10):
    """Poll until `probe()` returns something truthy. Prints as it waits, so a
    long provision does not look like a hang."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = probe()
        if last:
            return last
        print(f"    {DIM}waiting for {what}… ({int(deadline - time.time())}s left){RESET}", end="\r")
        time.sleep(interval)
    print()
    raise Failed(f"timed out after {timeout}s waiting for {what} (last: {last!r})")


# ── the stages ───────────────────────────────────────────────────────────────

def stage_preflight() -> None:
    stage("Preflight — the stack is the one we think it is")
    ready = api("GET", "/readyz")
    check(ready.get("status") == "ready", f"API ready ({ready.get('schema_migrations')} migrations)",
          f"API not ready: {ready}")

    # The trap that cost a whole run: containers mount a checkout from the HOST,
    # so `docker compose up` in the wrong directory runs the wrong branch in
    # silence. Read the markers off the RUNNING containers.
    markers = [
        (f"{PROJECT}-api-1", ["ls", "/app/dist/interpret.js"], "document reading"),
        (f"{PROJECT}-api-1",
         ["grep", "-l", "provisionOnConfirm", "/app/dist/relay/poller.js"], "confirm starts the build"),
        (f"{PROJECT}-worker-1",
         ["grep", "-l", "_planned_as_venues", "/app/control_plane_worker/transformer.py"],
         "planned places reach the site"),
    ]
    for container, cmd, what in markers:
        rc = subprocess.run(["docker", "exec", container, *cmd], capture_output=True).returncode
        check(rc == 0, f"deployed code carries: {what}", f"the running stack is missing: {what}")

    relay_container = os.environ.get("KINERARY_RELAY_CONTAINER")
    if relay_container:
        # The relay as a compose service (the VM): its environment is read inside
        # the container. Space-joined so the checks below read it like `ps eww`.
        running = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", relay_container],
                                 capture_output=True, text=True).stdout.strip()
        check(running == "true", f"relay container {relay_container} running",
              "the relay is down — nothing will answer")
        env = " ".join(subprocess.run(["docker", "exec", relay_container, "env"],
                                      capture_output=True, text=True).stdout.splitlines()) + " "
    else:
        relay_pid = subprocess.run(
            ["lsof", "-nP", "-iTCP:4312", "-sTCP:LISTEN", "-t"], capture_output=True, text=True
        ).stdout.split("\n")[0].strip()
        check(bool(relay_pid), "relay listening on :4312", "the relay is down — nothing will answer")
        env = subprocess.run(["ps", "eww", relay_pid], capture_output=True, text=True).stdout
    check("INTERPRET_PATH_DEFAULT=1" in env,
          "interview is agentless (INTERPRET_PATH_DEFAULT=1)",
          "INTERPRET_PATH_DEFAULT is unset — new sessions would run WITH the Hermes agent")
    for var in ("INTERPRET_RUNNER", "EXTRACT_RUNNER"):
        check(f"{var}=" in env and f"{var}= " not in env,
              f"{var} configured", f"{var} unset — that task returns NOT_CONFIGURED")


def stage_signup(trip_name: str) -> dict:
    stage("Signup — a new organizer, a new trip")
    stamp = datetime.now().strftime("%m%d%H%M%S")
    email = f"dror.elul+e2e{stamp}@gmail.com"
    password = secrets.token_urlsafe(12)
    # A FRESH email every run, because startSignup returns the caller's existing
    # approved row — reusing one hands back an OLD trip and tests nothing.
    result = api("POST", "/v1/signup", {
        "password": {"email": email, "password": password},
        "trip_name_request": trip_name,
    })
    check(result.get("status") == "approved" and result.get("tripId"),
          f"auto-approved -> {result.get('tripId')}",
          f"signup did not auto-approve: {result} (is signup.auto_approve true in the API's profile?)")
    return {"trip_id": result["tripId"], "email": email, "password": password}


def stage_interview(ctx: dict, scenario: str, work: Path, auto: "Auto | None" = None) -> None:
    stage(f"Interview — scenario '{scenario}'" + (" (automated organizer)" if auto else ""))
    if scenario == OWN:
        docs = None
        ok("your own trip — nothing is scripted; answer about a trip you mean to take")
        note("the checks afterwards come from the intake you confirm, not from a fixture")
    else:
        docs = _fixture_documents(scenario, work)
    enrollment = api("POST", f"/v1/trips/{ctx['trip_id']}/enrollment", {},
                     auth_header(ctx["email"], ctx["password"]))
    ctx["enrollment"] = enrollment
    ok(f"enrollment issued ({enrollment['enrollmentId']})")
    if auto:
        auto.interview(ctx, scenario, enrollment["token"], docs)
        return
    print(f"\n  {YELLOW}🧍 HUMAN{RESET} open this, answer the interview, and CONFIRM:\n")
    print(f"     https://t.me/{bot_username()}?start={enrollment['token']}\n")
    if docs:
        print(f"     send the scenario's document(s) when the bot asks: {docs}\n")


def _fixture_documents(scenario: str, work: Path) -> "Path | None":
    sys.path.insert(0, str(REPO / "control-plane/api/test/fixtures"))
    from make_documents import SCENARIOS, build  # noqa: E402

    spec = SCENARIOS[scenario]
    docs = None
    if spec["documents"]:
        docs = work / scenario
        files = build(scenario, docs)
        ok(f"generated {len(files)} document(s): {', '.join(f.name for f in files)}")
    else:
        ok("no documents — every answer typed, which is the control case")
    return docs


class Auto:
    """The person on Telegram, automated — see tools/auto-organizer.ts.

    For the length of the run the relay is pointed at a Telegram stand-in
    (tools/fake-telegram.ts) instead of api.telegram.org, and the organizer
    types, uploads and taps through it. That is the ONLY substitution: the
    relay, router, model calls, API, worker, provisioning, companion and MCP are
    the production code, doing production work. `end()` puts the relay back on
    real Telegram, and it is called from a `finally` — a failed run must not
    leave the bot answering a stand-in nobody is watching.
    """

    def __init__(self, work: Path) -> None:
        import socket
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.root = f"http://127.0.0.1:{self.port}"
        self.proc: subprocess.Popen | None = None
        self.log = work / "fake-telegram.log"

    def begin(self) -> None:
        stage("Automated organizer — relay pointed at the Telegram stand-in")
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", "tools/fake-telegram.ts", "--port", str(self.port)],
            cwd=REPO / "control-plane/api", stdout=self.log.open("w"), stderr=subprocess.STDOUT,
        )

        def healthy() -> bool:
            try:
                with urllib.request.urlopen(f"{self.root}/_control/health", timeout=2) as r:
                    return r.status == 200
            except Exception:  # noqa: BLE001
                return False
        wait_for("the Telegram stand-in", healthy, timeout=30, interval=1)
        ok(f"Telegram stand-in on {self.root}")
        relay_restart(self.root)
        ok("relay restarted against the stand-in (agentless, runners set, gateways reconnected)")

    def interview(self, ctx: dict, scenario: str, token: str, docs: Path | None) -> None:
        # A private-chat id no real Telegram user has (real ids are ~10 digits),
        # fresh per run so no earlier session or binding is inherited.
        chat = str(9_000_000_000_000 + secrets.randbelow(10**9))
        ctx["chat"] = chat
        env = {**os.environ, "CONTROL_PLANE_DATABASE_URL": live_database_url(),
               "PATH": f"/opt/homebrew/bin:{os.environ.get('PATH', '')}"}
        cmd = ["node", "--import", "tsx", "tools/auto-organizer.ts", "--scenario", scenario,
               "--token", token, "--chat", chat, "--telegram", self.root]
        if docs:
            cmd += ["--docs", str(docs)]
        result = subprocess.run(cmd, cwd=REPO / "control-plane/api", env=env)
        check(result.returncode == 0, "the organizer answered every question and confirmed",
              "the automated organizer stalled — its transcript is above")

    def end(self) -> None:
        stage("Automated organizer — relay back on real Telegram")
        try:
            relay_restart(None)
            ok("relay restarted against api.telegram.org")
        finally:
            if self.proc and self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.proc.kill()


def finish_workdir(work: Path, passed: bool) -> None:
    """This run's documents and stand-in log: gone when every scenario passed,
    kept and named when one did not — the rule preflight-deploy.sh's
    housekeeping applies to its own logs."""
    if passed:
        shutil.rmtree(work, ignore_errors=True)
    else:
        print(f"  {DIM}kept this run's documents and logs: {work}{RESET}")


def relay_restart(telegram_root: str | None) -> None:
    # scripts/relay-restart.sh restarts the MAC's host relay. Any other stack names
    # a twin with the same interface (the VM: control-plane/deployment/
    # vm-relay-restart.sh); main() refuses --auto on a non-Mac stack without one,
    # because the default would bounce the Mac's live relay onto a stand-in.
    script = os.environ.get("KINERARY_RELAY_RESTART") or str(REPO / "scripts/relay-restart.sh")
    cmd = [script] + (["--telegram-root", telegram_root] if telegram_root else [])
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise Failed(f"relay restart failed: {(result.stderr or result.stdout).strip()[-400:]}")


def live_database_url() -> str:
    """The live control-plane DB, reached from the host — for the organizer's
    READ-ONLY view of its own session (it opens the connection read-only)."""
    path = REPO / "control-plane/deployment/.local-secrets/control_plane_database_url_host"
    if not path.is_file():
        raise Failed(f"no {path} — the organizer needs the host URL of the live control-plane DB")
    return path.read_text().strip()


def bot_username() -> str:
    override = os.environ.get("KINERARY_BOT_USERNAME")
    if override:
        return override.lstrip("@")
    token_path = REPO / "control-plane/deployment/.local-secrets/telegram_creds"
    if token_path.exists():
        token = token_path.read_text().strip()
        out = subprocess.run(
            ["curl", "-s", "--max-time", "10", f"https://api.telegram.org/bot{token}/getMe"],
            capture_output=True, text=True,
        )
        try:
            return json.loads(out.stdout)["result"]["username"]
        except Exception:  # noqa: BLE001
            pass
    return "<your-bot>"


def stage_confirm_and_build(ctx: dict, wait_minutes: int, build: bool = True) -> None:
    stage("Confirm → build (provisionOnConfirm)" if build else "Confirm")
    trip = ctx["trip_id"]
    wait_for("the intake to be confirmed",
             lambda: psql(f"SELECT 1 FROM control_plane.intake_versions WHERE trip_id='{trip}' LIMIT 1") == "1",
             timeout=wait_minutes * 60, interval=15)
    ok("intake version written (immutable)")
    if not build:
        return

    # Confirming SHOULD start the build on its own. If it did not, say so and
    # drive it by hand — a green run must not hide that the hook failed.
    def planned() -> bool:
        return psql(f"SELECT state FROM control_plane.jobs WHERE trip_id='{trip}' LIMIT 1") != ""

    if not planned():
        note("no job yet — waiting a little for provisionOnConfirm")
        time.sleep(20)
    if planned():
        ok("confirming started the build by itself")
    else:
        raise Failed(
            "confirming produced no plan or job — provisionOnConfirm did not fire. "
            "Check the relay log for `interview.provisioning_started`; a "
            "NO_COMPATIBLE_RELEASE there means the RELAY lacks "
            "CONTROL_PLANE_ALLOW_UNSEALED_RELEASE."
        )

    state = wait_for("provisioning to finish",
                     lambda: (lambda s: s if s in ("succeeded", "failed") else None)(
                         psql(f"SELECT state FROM control_plane.jobs WHERE trip_id='{trip}' ORDER BY created_at DESC LIMIT 1")),
                     timeout=20 * 60, interval=15)
    print()
    check(state == "succeeded", "provisioning job succeeded", f"provisioning job {state}")
    ctx["slug"] = psql(f"SELECT slug FROM control_plane.trips WHERE id='{trip}'")
    ok(f"slug promoted to '{ctx['slug']}'")


def stage_site(ctx: dict) -> None:
    stage("The site — up, and serving THIS trip")
    slug = ctx["slug"]
    topology = DEPLOY_ROOT / "trips" / slug / "topology.yaml"
    check(topology.exists(), f"topology written ({topology})", f"no topology.yaml for {slug}")
    ip = next((l.split("ipv4:")[1].strip().split("/")[0]
               for l in topology.read_text().splitlines() if "ipv4:" in l), "")
    check(bool(ip), f"container ip {ip}", "no ipv4 in topology")
    ctx["ip"] = ip
    ctx["vmid"] = vmid_for(topology)

    code = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-m", "10", "-w", "%{http_code}", f"http://{ip}:8080/"],
        capture_output=True, text=True,
    ).stdout.strip()
    check(code == "200", f"site answers {code} on the LAN", f"site returned {code}")

    # The config the CONTAINER holds, not the copy on this Mac — that copy was
    # right on a run where the container's was not.
    cfg = subprocess.run(
        ["ssh", "-i", os.path.expanduser("~/.ssh/id_ed25519_proxmox_hermes"), "root@192.168.0.40",
         f"pct exec {vmid_for(topology)} -- cat /opt/kinerary/trips/{slug}/trip.config.json"],
        capture_output=True, text=True,
    ).stdout
    check(bool(cfg.strip()), "container holds a trip.config.json", "no config inside the container")
    data = json.loads(cfg)
    title = (data.get("meta") or {}).get("title", "")
    check(bool(title), f"config titled {title!r}", "config has no title")
    ctx["config"] = data


def vmid_for(topology: Path) -> str:
    for line in topology.read_text().splitlines():
        if "vmid:" in line:
            return line.split("vmid:")[1].strip().strip("'\"")
    raise Failed("no vmid in topology.yaml")


def stage_content(ctx: dict, scenario: str) -> None:
    stage("Content — what the documents said reached the site")
    sys.path.insert(0, str(REPO / "control-plane/api/test/fixtures"))
    from make_documents import SCENARIOS  # noqa: E402
    spec = SCENARIOS[scenario]
    phases = ctx["config"].get("phases", [])
    check(bool(phases), f"{len(phases)} phase(s) on the site", "the site has no phases")

    names = " ".join(json.dumps(p, ensure_ascii=False) for p in phases)
    for expected in spec.get("expect_in_phases", []):
        check(expected in names, f"phase present: {expected}", f"expected a phase mentioning {expected!r}")

    # The regression that started all of this: a place named in a document must
    # survive to the phase page, not be dropped by the transformer.
    #
    # As a venue OR as a day-plan item. The schema files a place by evidence of
    # booking: named in an itinerary it is `planned` and becomes a venue; with a
    # ticket reference it is a `travel_anchor`, and a dated anchor becomes a day
    # item (derive_days_from_anchors). Either is the place reaching the page —
    # the only failure is it reaching neither.
    venues = [v for p in phases for v in (p.get("venues") or [])]
    day_items = [i for p in phases for d in (p.get("days") or []) for i in (d.get("items") or [])]
    for expected in spec.get("expect_planned", []):
        needle = expected.lower()
        in_venues = any(needle in json.dumps(v, ensure_ascii=False).lower() for v in venues)
        in_days = any(needle in json.dumps(i, ensure_ascii=False).lower() for i in day_items)
        check(in_venues or in_days,
              f"place survived to the site: {expected} ({'venue' if in_venues else 'day plan'})",
              f"{expected!r} was in the document and is on no phase — neither a venue nor a day item")

    # Every venue link the site renders must be a real http(s) URL. `maps` and
    # `waze` are derived from the place name, so they are the ones that must
    # always be there and always be well-formed.
    for v in venues:
        for field in ("maps", "waze"):
            url = v.get(field)
            if url:
                check(url.startswith("https://"), f"{v['id']}.{field} is https",
                      f"{v['id']}.{field} is not a real URL: {url!r}")
    if venues:
        ok(f"{len(venues)} venue(s), links well-formed")
    ctx["planned_places"] = list(spec.get("expect_planned", []))


def stage_own_content(ctx: dict) -> None:
    """The other half of stage_content, for a trip nobody here scripted.

    A fixture run knows what the answers were, so it asserts on them by name.
    A person's run cannot: the destination is theirs and this script is told
    nothing about it. So the expectation is READ BACK from the intake version
    they confirmed — immutable, written at confirm — and checked against the
    config the container is actually serving. That is the same property the
    fixture scenarios test (what was answered reached the site), asserted
    without anyone here having to know the trip.

    Their answers are their own: the passing lines say THAT a thing matched,
    never what it was. A failure prints the values, because a mismatch cannot
    be diagnosed without them.
    """
    stage("Content — what YOU confirmed reached the site")
    data = json.loads(psql(
        f"SELECT data FROM control_plane.intake_versions "
        f"WHERE trip_id='{ctx['trip_id']}' ORDER BY version DESC LIMIT 1") or "{}")
    check(bool(data), "the confirmed intake was read back", "no intake version to check the site against")

    config = ctx["config"]
    meta = config.get("meta") or {}
    phases = config.get("phases") or []
    blob = json.dumps(config, ensure_ascii=False).lower()

    destination = _answer_text(data.get("destination")).strip()
    check(bool(destination), "you answered a destination", "the intake has no destination answer")
    check(destination.lower() in blob, "your destination is on the site",
          f"the destination you confirmed ({destination!r}) appears nowhere in the site's config")

    # Both date questions are required now, so absent means an older intake —
    # skipped rather than failed, since the transformer then legitimately
    # derives dates instead of carrying them.
    departure = _answer_text(data.get("departure_date")).strip()
    returning = _answer_text(data.get("return_date")).strip()
    if departure and returning:
        check(str(meta.get("departure", "")).startswith(departure),
              "your departure date is the site's departure date",
              f"you confirmed {departure} and the site departs {meta.get('departure')!r}")
        check(meta.get("returnDate") == returning,
              "your return date is the site's return date",
              f"you confirmed {returning} and the site returns {meta.get('returnDate')!r}")
    else:
        note("no explicit dates in the intake — the site's dates are derived, nothing to compare")

    # Every stop named in the interview has to be findable on some phase. Phases
    # with the same name collapse into one (_derive_phases), so this asks for
    # presence, never for a count.
    # The places the organizer named per leg — "Tokyo Skytree", "TeamLab
    # Planets". The transformer files them as venues (`_planned_as_venues`), and
    # a place that reaches neither a venue nor a day item has been dropped
    # between the interview and the site. Carried into ctx for stage_served,
    # which asks the SITE for them rather than the file.
    planned = [str(place).strip()
               for raw in _structured_items(data, "phases") if isinstance(raw, dict)
               for place in (raw.get("planned") or []) if str(place).strip()]
    ctx["planned_places"] = planned
    for place in planned:
        check(place.lower() in json.dumps(phases, ensure_ascii=False).lower(),
              f"a place you named is on the site: {place}",
              f"{place!r} was named in the interview and is on no phase")

    named = [n for n in (_phase_name(raw) for raw in _structured_items(data, "phases")) if n]
    check(bool(phases), f"{len(phases)} phase(s) on the site", "the site has no phases")
    missing = [n for n in named if n.lower() not in json.dumps(phases, ensure_ascii=False).lower()]
    if named:
        check(not missing, f"every stop you named has a phase ({len(named)})",
              f"named in the interview and on no phase: {missing}")
    else:
        note("you named no separate stops — the single phase above is the whole trip")


def _answer_text(answer: object) -> str:
    """The display value of one intake answer — transformer._text_value, which
    lives in the worker image and is not importable from here."""
    if not isinstance(answer, dict):
        return ""
    kind = answer.get("kind")
    if kind == "choice":
        return str(answer.get("option_id") or "")
    if kind == "choice_other":
        return str(answer.get("other_text") or "")
    if kind == "text":
        return str(answer.get("text") or "")
    return ""


def _structured_items(data: dict, question_id: str) -> list:
    """A structured answer's array payload — transformer._structured_list."""
    answer = data.get(question_id)
    if not isinstance(answer, dict) or answer.get("kind") != "structured":
        return []
    payload = answer.get("data")
    return payload if isinstance(payload, list) else []


def _phase_name(raw: object) -> str:
    if not isinstance(raw, dict):
        return ""
    return str(raw.get("name") or raw.get("name_en") or "").strip()


def stage_served(ctx: dict) -> None:
    """What a traveller actually gets, asked for the way a traveller asks.

    Every content check before this one read `trip.config.json` — off the disk,
    then out of the container. Both can be perfect while the site shows nothing,
    and on 2026-09-12 they were: five phases with their dates and their places
    sat in the config of a trip whose itinerary rendered empty, and the run had
    called it green. So this logs in and reads what the site serves.
    """
    stage("The site serves it — logged in, the way a traveller reads it")
    ip, slug = ctx["ip"], ctx["slug"]
    env = subprocess.run(
        ["ssh", "-i", os.path.expanduser("~/.ssh/id_ed25519_proxmox_hermes"), "root@192.168.0.40",
         f"pct exec {ctx['vmid']} -- cat /opt/kinerary/.env"],
        capture_output=True, text=True,
    ).stdout
    password = next((l.split("=", 1)[1].strip() for l in env.splitlines() if l.startswith("SEED_PASSWORD=")), "")
    check(bool(password), "the site has a shared password to log in with",
          "no SEED_PASSWORD in the container's .env — nobody can log in to this trip at all")

    username = next((p.get("username") for p in (ctx["config"].get("participants") or []) if p.get("username")), "")
    check(bool(username), f"a traveller to log in as ({username})", "the config has no participant with a username")

    def site(path: str, token: str = "") -> dict:
        out = subprocess.run(
            ["curl", "-s", "-m", "15", f"http://{ip}:8080{path}"]
            + (["-H", f"Authorization: Bearer {token}"] if token else []),
            capture_output=True, text=True,
        ).stdout
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            raise Failed(f"{path} did not answer JSON: {out[:200]!r}")

    # Logged out, the config is refused — the reason a locked site and a broken
    # one look identical from outside, and worth asserting rather than assuming.
    check(site("/api/config").get("error") == "unauthorized",
          "logged out, the trip's data is refused", "the site served its config to nobody in particular")

    login = subprocess.run(
        ["curl", "-s", "-m", "15", "-X", "POST", f"http://{ip}:8080/api/auth/login",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"username": username, "password": password})],
        capture_output=True, text=True,
    ).stdout
    token = (json.loads(login or "{}") or {}).get("token", "")
    check(bool(token), f"'{username}' can log in with the trip password",
          f"login refused for '{username}' — the credentials the introduction hands out do not work")

    served = site("/api/config", token)
    phases = served.get("phases") or []
    check(len(phases) == len(ctx["config"].get("phases") or []),
          f"the site serves all {len(phases)} phase(s)",
          f"the container holds {len(ctx['config'].get('phases') or [])} phases and the site serves {len(phases)}")

    # THE THING THE PAGE IS MADE OF. A phase with neither a day plan nor a place
    # renders as an empty tab, which is what "the site has no data" looked like.
    #
    # Per phase this is a note, not a failure: an organizer who names Hakone as
    # a stop and nothing to do there yet has said something true, and a test
    # that refuses it would refuse every honest interview. A trip where NO
    # phase has anything is the regression — that is a site showing nothing.
    bare = [p.get("id") for p in phases if not (p.get("days") or p.get("venues"))]
    if bare:
        note(f"{len(bare)} phase(s) carry no plan and no places yet: {', '.join(str(b) for b in bare)}")
    # An empty trip is only a regression when something was NAMED. The places an
    # organizer gave are checked one by one below, so a named place that fails to
    # reach the site still fails the run. A trip where nothing was named — the
    # `manual` scenario types stops and dates and no attractions — renders empty
    # because it IS empty, and failing it made a correct result permanently red.
    # Filling it is the companion's job, and only with approval (Dror,
    # 2026-09-13): it offers a draft and writes nothing until someone says yes.
    if ctx.get("planned_places"):
        check(any(p.get("days") or p.get("venues") for p in phases),
              "the phases have something on them — a day plan or the places they are planned around",
              "every phase the site serves is empty: the trip renders as nothing at all")
    elif not any(p.get("days") or p.get("venues") for p in phases):
        note("nothing was named, so nothing is served — the companion offers a draft, and writes only on approval")

    blob = json.dumps(served, ensure_ascii=False).lower()
    for place in ctx.get("planned_places", []):
        check(place.lower() in blob, f"the site serves a place you named: {place}",
              f"{place!r} was in the interview, is not in what the site serves")

    itinerary = site("/api/itinerary/active", token)
    check("days" in itinerary or "items" in itinerary,
          "the living itinerary answers for a signed-in traveller",
          f"/api/itinerary/active returned {str(itinerary)[:120]}")


def stage_companion(ctx: dict) -> None:
    stage("The companion — installed, rendered, running, routable")
    slug = ctx["slug"]
    profile = "".join(ch for ch in slug if ch.isalnum())
    home = HERMES_HOME / "profiles" / profile
    check(home.is_dir(), f"profile directory exists ({profile})", f"no profile at {home}")

    # A BARE `hermes profile create` skeleton is a directory too. The installer
    # could not tell the difference and reported success on an empty shell four
    # times, so this asks for the parts only a RENDERED companion has.
    for part in ("SOUL.md", "config.yaml", "profile.yaml"):
        check((home / part).is_file(), f"rendered: {part}",
              f"{part} missing — this is a skeleton, not a companion")
    soul = (home / "SOUL.md").read_text()
    check("trip companion for" in soul, "SOUL is this trip's, not stock Hermes boilerplate",
          "SOUL.md is the default Hermes persona — the profile was never rendered")

    # launchd runs `--profile X gateway run`; an s6 slot in the VM's Hermes
    # container runs `-p X gateway run`, visible to the host's pgrep.
    running = subprocess.run(["pgrep", "-f", f"(-p|--profile) {profile} gateway run"],
                             capture_output=True).returncode == 0
    check(running, "companion gateway is running", "the companion's gateway is not running")

    # Identity, not just connectivity. `socketsFor()` looks a gateway up BY
    # PROFILE NAME, so a gateway enrolled under any other id can only ever be
    # the fallback — which is how the interviewer ended up answering messages
    # meant for the companion.
    env = (home / ".env").read_text() if (home / ".env").is_file() else ""
    check(f"GATEWAY_RELAY_ID={profile}" in env,
          f"enrolled with the relay as '{profile}' (exact routing)",
          f"GATEWAY_RELAY_ID is not '{profile}' — messages will fall back to the interviewer")

    bound = psql(
        f"SELECT hermes_profile FROM control_plane.telegram_chat_bindings "
        f"WHERE trip_id='{ctx['trip_id']}' AND closed_at IS NULL LIMIT 1")
    check(bound == profile, f"chat bound to {profile}",
          f"no open binding for this trip (got {bound!r})")


def stage_mcp(ctx: dict) -> None:
    stage("MCP — the companion can actually read the trip")
    slug = ctx["slug"]
    profile = "".join(ch for ch in slug if ch.isalnum())
    home = HERMES_HOME / "profiles" / profile
    cfg = (home / "config.yaml").read_text() if (home / "config.yaml").is_file() else ""
    check("trip-mcp" in cfg, "trip-mcp registered in the profile",
          "no trip-mcp entry — setup-mcp.sh never completed")
    # `hermes mcp add` saves the entry DISABLED when its probe fails, which it
    # always does (Hermes speaks Streamable HTTP, mcp.js speaks SSE). The patch
    # that enables it is the step that died on a missing PyYAML, silently.
    check("disabled: true" not in cfg.replace(" ", ""),
          "the entry is enabled, not saved-and-disabled",
          "trip-mcp is present but DISABLED — the SSE transport patch did not run")

    out = subprocess.run(
        [*hermes_cli(), "--profile", profile, "mcp", "test", "trip-mcp"],
        capture_output=True, text=True, timeout=300,
    )
    blob = out.stdout + out.stderr
    check("get_phase_plan" in blob or "get_bookings" in blob,
          "trip-mcp answers and exposes the trip tools",
          f"`hermes mcp test trip-mcp` did not list trip tools:\n{blob[-400:]}")


TRIP_NAMES = {"japan": "Japan 2026", "multi": "Italy 2026", "manual": "Portugal 2026",
              # A placeholder the organizer would have typed on the signup form,
              # deliberately not a destination: naming it would be this script
              # deciding what an `own` run is about. --trip-name replaces it.
              OWN: "My trip"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenario", default="multi", choices=["japan", "multi", "manual", OWN, "all"],
                    help="a fixture (japan, multi, manual), or 'own' — a person's real trip, "
                         "checked against the intake they confirm")
    ap.add_argument("--trip-name", default=None)
    ap.add_argument("--wait-minutes", type=int, default=30,
                    help="how long to wait for the human half of the interview")
    ap.add_argument("--keep", action="store_true",
                    help="leave the trip running afterwards — the default; kept for old invocations")
    ap.add_argument("--teardown", action="store_true",
                    help="afterwards, tear down the trip THIS run created (scripts/teardown-trip.py), "
                         "whether the run passed or failed")
    ap.add_argument("--auto", action="store_true",
                    help="play the organizer automatically through a Telegram stand-in instead of a person")
    ap.add_argument("--stop-after", choices=["confirm"], default=None,
                    help="stop once the intake is confirmed, before the build — for a stack that must "
                         "not provision (the Proxmox VM while the Mac stack is live)")
    args = ap.parse_args()
    if not MAC_STACK and args.auto and not os.environ.get("KINERARY_RELAY_RESTART"):
        ap.error(f"--auto on {PROJECT} needs KINERARY_RELAY_RESTART: the default, scripts/relay-restart.sh, "
                 "restarts the Mac's live relay")
    if not MAC_STACK and args.teardown and not os.environ.get("KINERARY_TEARDOWN"):
        ap.error(f"--teardown on {PROJECT} needs KINERARY_TEARDOWN: scripts/teardown-trip.py's defaults "
                 "are the Mac's (~/kinerary-deploy, ~/.hermes); on the VM use "
                 "control-plane/deployment/vm-teardown-trip.sh")
    if args.scenario == OWN and args.auto:
        ap.error("--scenario own is a person answering about their own trip; the automated "
                 "organizer can only play a fixture (japan, multi, manual)")
    if args.scenario == "all" and not args.auto:
        ap.error("--scenario all needs --auto: three interviews back to back are not a thing to ask a person for")

    scenarios = ["japan", "multi", "manual"] if args.scenario == "all" else [args.scenario]
    results: list[tuple[str, int, dict]] = []
    try:
        stage_preflight()
    except Failed as exc:
        print(f"\n{RED}✗ FAILED{RESET}: {exc}\n")
        return 1
    # The scenario documents and the stand-in's log, in one place that goes
    # away with a passing run. /tmp, not $TMPDIR: a person running a manual
    # scenario has to find the documents in Telegram's file picker.
    work = Path(tempfile.mkdtemp(prefix="kinerary-e2e-", dir="/tmp"))
    auto = Auto(work) if args.auto else None
    try:
        if auto:
            auto.begin()
        for scenario in scenarios:
            ctx: dict = {}
            code = run_scenario(scenario, args, auto, ctx, work)
            if args.teardown:
                code = stage_teardown(ctx) or code
            elif ctx.get("trip_id"):
                print(f"  {DIM}left running — `scripts/teardown-trip.py --trip {ctx['trip_id']} --execute` removes it{RESET}")
            results.append((scenario, code, ctx))
    except KeyboardInterrupt:
        print(f"\n{YELLOW}interrupted{RESET} — nothing torn down.")
        finish_workdir(work, passed=False)
        return 130
    except Failed as exc:
        print(f"\n{RED}✗ FAILED{RESET}: {exc}\n")
        results.append(("setup", 1, {}))
    finally:
        if auto:
            try:
                auto.end()
            except Failed as exc:
                print(f"\n{RED}✗ THE RELAY IS NOT BACK ON REAL TELEGRAM{RESET}: {exc}\n")
                results.append(("restore", 1, {}))

    if len(results) > 1 or args.scenario == "all":
        print(f"\n{'scenario':<10} result")
        for name, code, ctx in results:
            print(f"{name:<10} {GREEN + 'green' + RESET if code == 0 else RED + 'FAILED' + RESET}  "
                  f"{ctx.get('trip_id', '')} {ctx.get('slug', '')}")
    passed = bool(results) and all(code == 0 for _, code, _ in results)
    finish_workdir(work, passed)
    return 0 if passed else 1


def run_scenario(scenario: str, args: argparse.Namespace, auto: "Auto | None", ctx: dict, work: Path) -> int:
    trip_name = args.trip_name if (args.trip_name and args.scenario != "all") else TRIP_NAMES[scenario]
    try:
        ctx.update(stage_signup(trip_name))
        stage_interview(ctx, scenario, work, auto)
        stage_confirm_and_build(ctx, args.wait_minutes, build=args.stop_after != "confirm")
        if args.stop_after == "confirm":
            print(f"\n{GREEN}✓ interview green ({scenario}){RESET}: signup, interview and confirm verified; "
                  "stopped before the build as asked.")
            print(f"  trip:  {ctx['trip_id']}")
            return 0
        stage_site(ctx)
        stage_own_content(ctx) if scenario == OWN else stage_content(ctx, scenario)
        stage_served(ctx)
        stage_companion(ctx)
        stage_mcp(ctx)
        print(f"\n{GREEN}✓ full cycle green ({scenario}){RESET}: site, content, companion and MCP all verified.")
        print(f"  trip:  {ctx['trip_id']}  ({ctx['slug']})")
        print(f"  login: {ctx['email']} / {ctx['password']}")
        return 0
    except Failed as exc:
        print(f"\n{RED}✗ FAILED ({scenario}){RESET}: {exc}\n")
        if ctx.get("trip_id"):
            print(f"  trip:  {ctx['trip_id']}  ({ctx.get('slug', 'no slug yet')})")
            print(f"  login: {ctx.get('email')} / {ctx.get('password')}")
        return 1


def stage_teardown(ctx: dict) -> int:
    """Only ever the trip this run signed up — its id came back from /v1/signup
    above. Anything that existed before the run is not this function's to touch."""
    stage("Teardown — remove what this run created")
    if not ctx.get("trip_id"):
        note("no trip was created — nothing to tear down")
        return 0
    # KINERARY_TEARDOWN names a twin with the same arguments for a non-Mac stack
    # (the VM: control-plane/deployment/vm-teardown-trip.sh).
    script = os.environ.get("KINERARY_TEARDOWN") or str(REPO / "scripts/teardown-trip.py")
    result = subprocess.run([script, "--trip", ctx["trip_id"], "--execute"])
    if result.returncode == 0:
        ok(f"{ctx['trip_id']} torn down")
    else:
        print(f"  {RED}✗{RESET} teardown exited {result.returncode} — see above; the trip may be half-removed")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
