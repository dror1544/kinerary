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
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
API = os.environ.get("KINERARY_API", "http://127.0.0.1:4310")
PG = "kinerary-control-plane-local-postgres-1"

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


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
        ("kinerary-control-plane-local-api-1", ["ls", "/app/dist/interpret.js"], "document reading"),
        ("kinerary-control-plane-local-api-1",
         ["grep", "-l", "provisionOnConfirm", "/app/dist/relay/poller.js"], "confirm starts the build"),
        ("kinerary-control-plane-local-worker-1",
         ["grep", "-l", "_planned_as_venues", "/app/control_plane_worker/transformer.py"],
         "planned places reach the site"),
    ]
    for container, cmd, what in markers:
        rc = subprocess.run(["docker", "exec", container, *cmd], capture_output=True).returncode
        check(rc == 0, f"deployed code carries: {what}", f"the running stack is missing: {what}")

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


def stage_interview(ctx: dict, scenario: str, auto: "Auto | None" = None) -> None:
    stage(f"Interview — scenario '{scenario}'" + (" (automated organizer)" if auto else ""))
    sys.path.insert(0, str(REPO / "control-plane/api/test/fixtures"))
    from make_documents import SCENARIOS, build  # noqa: E402

    spec = SCENARIOS[scenario]
    docs = None
    if spec["documents"]:
        docs = Path("/tmp") / f"kinerary-e2e-{scenario}"
        files = build(scenario, docs)
        ok(f"generated {len(files)} document(s): {', '.join(f.name for f in files)}")
    else:
        ok("no documents — every answer typed, which is the control case")

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

    def __init__(self) -> None:
        import socket
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.root = f"http://127.0.0.1:{self.port}"
        self.proc: subprocess.Popen | None = None
        self.log = Path("/tmp") / f"kinerary-e2e-fake-telegram-{self.port}.log"

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


def relay_restart(telegram_root: str | None) -> None:
    cmd = [str(REPO / "scripts/relay-restart.sh")] + (["--telegram-root", telegram_root] if telegram_root else [])
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


def stage_confirm_and_build(ctx: dict, wait_minutes: int) -> None:
    stage("Confirm → build (provisionOnConfirm)")
    trip = ctx["trip_id"]
    wait_for("the intake to be confirmed",
             lambda: psql(f"SELECT 1 FROM control_plane.intake_versions WHERE trip_id='{trip}' LIMIT 1") == "1",
             timeout=wait_minutes * 60, interval=15)
    ok("intake version written (immutable)")

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
    topology = Path.home() / "kinerary-deploy/trips" / slug / "topology.yaml"
    check(topology.exists(), f"topology written ({topology})", f"no topology.yaml for {slug}")
    ip = next((l.split("ipv4:")[1].strip().split("/")[0]
               for l in topology.read_text().splitlines() if "ipv4:" in l), "")
    check(bool(ip), f"container ip {ip}", "no ipv4 in topology")

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


def stage_companion(ctx: dict) -> None:
    stage("The companion — installed, rendered, running, routable")
    slug = ctx["slug"]
    profile = "".join(ch for ch in slug if ch.isalnum())
    home = Path.home() / ".hermes/profiles" / profile
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

    running = subprocess.run(["pgrep", "-f", f"profile {profile} gateway run"],
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
    home = Path.home() / ".hermes/profiles" / profile
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
        [os.path.expanduser("~/.hermes/hermes-agent/venv/bin/python"), "-m", "hermes_cli.main",
         "--profile", profile, "mcp", "test", "trip-mcp"],
        capture_output=True, text=True, timeout=300,
    )
    blob = out.stdout + out.stderr
    check("get_phase_plan" in blob or "get_bookings" in blob,
          "trip-mcp answers and exposes the trip tools",
          f"`hermes mcp test trip-mcp` did not list trip tools:\n{blob[-400:]}")


TRIP_NAMES = {"japan": "Japan 2026", "multi": "Italy 2026", "manual": "Portugal 2026"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenario", default="multi", choices=["japan", "multi", "manual", "all"])
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
    args = ap.parse_args()
    if args.scenario == "all" and not args.auto:
        ap.error("--scenario all needs --auto: three interviews back to back are not a thing to ask a person for")

    scenarios = ["japan", "multi", "manual"] if args.scenario == "all" else [args.scenario]
    results: list[tuple[str, int, dict]] = []
    try:
        stage_preflight()
    except Failed as exc:
        print(f"\n{RED}✗ FAILED{RESET}: {exc}\n")
        return 1
    auto = Auto() if args.auto else None
    try:
        if auto:
            auto.begin()
        for scenario in scenarios:
            ctx: dict = {}
            code = run_scenario(scenario, args, auto, ctx)
            if args.teardown:
                code = stage_teardown(ctx) or code
            elif ctx.get("trip_id"):
                print(f"  {DIM}left running — `scripts/teardown-trip.py --trip {ctx['trip_id']} --execute` removes it{RESET}")
            results.append((scenario, code, ctx))
    except KeyboardInterrupt:
        print(f"\n{YELLOW}interrupted{RESET} — nothing torn down.")
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
    return 0 if results and all(code == 0 for _, code, _ in results) else 1


def run_scenario(scenario: str, args: argparse.Namespace, auto: "Auto | None", ctx: dict) -> int:
    trip_name = args.trip_name if (args.trip_name and args.scenario != "all") else TRIP_NAMES[scenario]
    try:
        ctx.update(stage_signup(trip_name))
        stage_interview(ctx, scenario, auto)
        stage_confirm_and_build(ctx, args.wait_minutes)
        stage_site(ctx)
        stage_content(ctx, scenario)
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
    result = subprocess.run([str(REPO / "scripts/teardown-trip.py"), "--trip", ctx["trip_id"], "--execute"])
    if result.returncode == 0:
        ok(f"{ctx['trip_id']} torn down")
    else:
        print(f"  {RED}✗{RESET} teardown exited {result.returncode} — see above; the trip may be half-removed")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
