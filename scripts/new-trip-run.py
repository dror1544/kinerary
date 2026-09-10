#!/usr/bin/env python3
"""Start a brand-new trip end to end: signup -> approval -> interview link.

`fresh-interview.py` RESTARTS an existing draft trip. It refuses once a trip is
past `intake_in_progress`, which is correct — a confirmed intake is immutable
and there is a plan, a container and a site behind it. So it cannot give you a
clean run once a trip has been provisioned. This does the other half: a new
user, a new trip, a new interview, with nothing inherited.

WHY A NEW EMAIL EACH TIME. `startSignup` returns the existing row when the user
already has an approved signup request (signup.ts 2a) — so reusing a previous
test login hands back that OLD trip instead of making one. Every past run on
this stack used its own address for exactly this reason. The default below is
a +tag on your own inbox, unique per run.

Usage:
    scripts/new-trip-run.py                      # defaults, prompts before the relay
    scripts/new-trip-run.py --trip-name "Japan 2026"
    scripts/new-trip-run.py --email me+x@gmail.com --password ... --start-relay
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

DEFAULT_API = "http://127.0.0.1:4310"
# Same convention as bring-up.sh: the checkout whose code should actually run.
# This matters more than it looks — `provisionOnConfirm` (confirm starts the
# build) lives in the RELAY's poller, so a relay started from the wrong
# checkout silently gives you an interview that confirms and then does nothing.
REPO = os.environ.get("KINERARY_REPO") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELAY_PROFILE = os.path.join(
    REPO, "control-plane", "deployment", ".local-secrets", "architecture.relay-host.json"
)


class Stop(Exception):
    """Something the operator has to decide or fix — not a crash."""


# ── preflight ────────────────────────────────────────────────────────────────

def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(1.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def relay_pid() -> str:
    out = subprocess.run(["lsof", "-nP", "-iTCP:4312", "-sTCP:LISTEN", "-t"],
                         capture_output=True, text=True).stdout.strip()
    return out.splitlines()[0] if out else ""


def api_ready(api: str) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(f"{api}/readyz", timeout=5) as resp:
            body = json.load(resp)
            return body.get("status") == "ready", json.dumps(body)
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def start_relay() -> None:
    """The relay is what makes the bots answer at all. Deliberately manual in
    bring-up.sh because starting it puts the assistant into every bound group."""
    if not os.path.exists(RELAY_PROFILE):
        raise Stop(f"relay architecture profile not found at {RELAY_PROFILE}")
    env = {k: v for k, v in os.environ.items() if k != "RELAY_GATEWAY_SECRET"}
    env["CONTROL_PLANE_ARCHITECTURE_PROFILE"] = RELAY_PROFILE
    log = open("/tmp/relay.log", "ab")
    subprocess.Popen(
        ["npx", "tsx", "src/relay/server.ts"],
        cwd=os.path.join(REPO, "control-plane", "api"),
        stdout=log, stderr=log, start_new_session=True, env=env,
    )
    for _ in range(30):
        time.sleep(1)
        if port_open(4312):
            print("  relay up on :4312 (log: /tmp/relay.log)")
            return
    raise Stop("relay did not come up on :4312 — check /tmp/relay.log")


def check_running_code() -> None:
    """The containers mount a checkout from the host, so `docker compose up` in
    the wrong directory silently runs the wrong branch. That is not a theoretical
    failure: it happened on 2026-09-09 and the symptoms are all downstream —
    the bot cannot read a document, and confirming the intake builds nothing.
    Read it off the running containers rather than trusting the directory."""
    checks = [
        ("api", ["docker", "exec", "kinerary-control-plane-local-api-1",
                 "ls", "/app/dist/interpret.js"], "document reading (interpret.js)"),
        ("api", ["docker", "exec", "kinerary-control-plane-local-api-1",
                 "grep", "-l", "provisionOnConfirm", "/app/dist/relay/poller.js"],
         "confirm-starts-the-build (provisionOnConfirm)"),
        ("worker", ["docker", "exec", "kinerary-control-plane-local-worker-1",
                    "grep", "-l", "_planned_as_venues", "/app/control_plane_worker/transformer.py"],
         "planned places reach the site (_planned_as_venues)"),
    ]
    missing = [what for _, cmd, what in checks
               if subprocess.run(cmd, capture_output=True).returncode != 0]
    if missing:
        raise Stop(
            "the running stack is missing:\n    - " + "\n    - ".join(missing) +
            "\n  That means it was built from a checkout without this work. Rebuild from the"
            "\n  branch that has it:\n"
            "    cd /Users/elul/kinerary/.claude/worktrees/interview-interpret\n"
            "    (cd control-plane/api && npm run build)\n"
            "    set -a && . ~/kinerary-deploy/provisioning.env && set +a\n"
            "    WORKER_REPO_ROOT_HOST=$PWD BUILDX_CONFIG=~/.docker/buildx-local \\\n"
            "      docker compose -f control-plane/deployment/compose.local.yml up -d --build --wait"
        )
    print("  code       api + worker carry the interview work")


def check_interview_path(relay_pid: str) -> None:
    """The interview must run WITHOUT an agent, and the flag that decides it
    lives in the relay's environment — so it is lost on any restart from a
    shell that did not source provisioning.env.

    Unset is not an error, it is a downgrade: new sessions are created on the
    agent path, which is supported, so nothing warns. On 2026-09-09 that cost a
    whole run — English narration inside a Hebrew interview, and a turn that
    opened and never closed. Read it off the process rather than off the file
    that was supposed to have been sourced.
    """
    out = subprocess.run(["ps", "eww", relay_pid], capture_output=True, text=True).stdout
    env = dict(
        part.split("=", 1) for part in out.split() if "=" in part and part.split("=", 1)[0].isupper()
    )
    problems = []
    if env.get("INTERPRET_PATH_DEFAULT", "").lower() not in ("1", "true", "yes"):
        problems.append("INTERPRET_PATH_DEFAULT is not set — new sessions would run WITH the Hermes agent")
    for var in ("INTERPRET_RUNNER", "EXTRACT_RUNNER"):
        if not env.get(var):
            problems.append(f"{var} is unset — that task returns NOT_CONFIGURED and the router silently does less")
    if problems:
        raise Stop(
            "the relay is running without the interview's own configuration:\n    - "
            + "\n    - ".join(problems)
            + "\n  These live in ~/kinerary-deploy/provisioning.env. Restart the relay from a shell"
              "\n  that sourced it:\n"
              "    set -a && . ~/kinerary-deploy/provisioning.env && set +a\n"
              "    .agents/skills/interview-stack-deploy/deploy.sh"
        )
    print(f"  interview  agentless, {env.get('INTERPRET_RUNNER')}/{env.get('INTERPRET_MODEL', '?')}")


def preflight(api: str, want_relay: bool) -> None:
    print("== preflight ==")
    ready, detail = api_ready(api)
    if not ready:
        raise Stop(
            f"control-plane API not ready at {api}: {detail}\n"
            "  start it with:\n"
            "    set -a && . ~/kinerary-deploy/provisioning.env && set +a\n"
            "    BUILDX_CONFIG=~/.docker/buildx-local docker compose \\\n"
            "      -f control-plane/deployment/compose.local.yml up -d --build --wait"
        )
    print(f"  api        :4310 ready ({detail})")

    if not port_open(4311):
        raise Stop(
            "interview MCP sidecar is down on :4311 — start it against the right checkout:\n"
            f"    KINERARY_REPO={REPO} ~/kinerary-deploy/bring-up.sh"
        )
    print("  interview  :4311 up")

    check_running_code()

    if port_open(4312):
        print("  relay      :4312 up")
        check_interview_path(relay_pid())
        return
    if not want_relay:
        raise Stop(
            "the relay is DOWN on :4312, so the bot will not answer a single message.\n"
            "  Starting it is a live action — it puts the assistant into every bound group.\n"
            "  Re-run with --start-relay once you are happy with that."
        )
    print("  relay      :4312 down — starting it (live action)")
    start_relay()
    check_interview_path(relay_pid())


# ── signup ───────────────────────────────────────────────────────────────────

def b64(payload: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


def post(url: str, body: dict, headers: dict | None = None) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={"content-type": "application/json", **(headers or {})}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        raise Stop(f"{url} refused ({exc.code}): {exc.read().decode(errors='replace')[:300]}") from exc
    except urllib.error.URLError as exc:
        raise Stop(f"could not reach {url}: {exc.reason}") from exc


def signup_status(api: str, email: str, password: str) -> dict:
    url = f"{api}/v1/signup/status?password={b64({'email': email, 'password': password})}"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        raise Stop(f"status refused ({exc.code}): {exc.read().decode(errors='replace')[:200]}") from exc


def bot_username() -> str:
    override = os.environ.get("KINERARY_BOT_USERNAME")
    if override:
        return override.lstrip("@")
    token_path = os.environ.get("KINERARY_BOT_TOKEN_FILE") or os.path.join(
        REPO, "control-plane", "deployment", ".local-secrets", "telegram_creds"
    )
    if os.path.exists(token_path):
        token = open(token_path).read().strip()
        # curl, not urllib: urllib verifies against Python's own CA bundle,
        # which fails on this machine where the system store succeeds.
        out = subprocess.run(
            ["curl", "-s", "--max-time", "10", f"https://api.telegram.org/bot{token}/getMe"],
            capture_output=True, text=True,
        )
        if out.returncode == 0 and out.stdout:
            try:
                return json.loads(out.stdout)["result"]["username"]
            except Exception:  # noqa: BLE001
                pass
    return "<your-bot>"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trip-name", default="Japan 2026", help='trip name request (default "Japan 2026")')
    ap.add_argument("--email", default=None, help="signup email (default: a unique +tag on your inbox)")
    ap.add_argument("--password", default=None, help="signup password (default: generated, printed below)")
    ap.add_argument("--api", default=DEFAULT_API)
    ap.add_argument("--start-relay", action="store_true", help="start the relay if down (live action)")
    ap.add_argument("--wait-minutes", type=int, default=10, help="how long to wait for your approval tap")
    # Added after checking the preflight by running the whole thing, which
    # signed a real account up and put an approval prompt on someone's phone.
    # The preflight is the part worth running on its own; the signup is not.
    ap.add_argument("--preflight-only", action="store_true",
                    help="check the stack and exit, without signing anything up")
    args = ap.parse_args()

    stamp = datetime.now().strftime("%m%d%H%M")
    email = args.email or f"dror.elul+kin{stamp}@gmail.com"
    password = args.password or secrets.token_urlsafe(12)

    try:
        preflight(args.api, args.start_relay)
        if args.preflight_only:
            print("\npreflight only — nothing was signed up.")
            return 0

        print("\n== signup ==")
        print(f"  email    {email}")
        print(f"  password {password}")
        print(f"  trip     {args.trip_name}")
        result = post(f"{args.api}/v1/signup", {
            "password": {"email": email, "password": password},
            "trip_name_request": args.trip_name,
        })
        print(f"  -> {result.get('status')} ({result.get('requestId', '')})")

        if result.get("status") == "approved":
            raise Stop(
                "this account was ALREADY approved and points at an existing trip "
                f"({result.get('tripId')}). Re-run with a different --email for a clean trip."
            )

        print("\n== approval ==")
        print("  🧍 Tap APPROVE on the Telegram message that just arrived.")
        deadline = time.time() + args.wait_minutes * 60
        trip_id = None
        while time.time() < deadline:
            time.sleep(5)
            status = signup_status(args.api, email, password)
            if status.get("status") == "approved":
                trip_id = status.get("tripId")
                print(f"  approved -> {trip_id}")
                break
            if status.get("status") == "rejected":
                raise Stop("the signup was REJECTED.")
        if not trip_id:
            raise Stop(
                f"no approval within {args.wait_minutes} minutes. The request is still pending — "
                "tap Approve, then re-run with the SAME --email and --password to pick it up."
            )

        print("\n== interview link ==")
        enrollment = post(f"{args.api}/v1/trips/{trip_id}/enrollment", {},
                          {"X-Portal-Password-Login": b64({"email": email, "password": password})})
        print(f"  enrollment {enrollment['enrollmentId']} (expires {enrollment['expiresAt']})")
        print("\nTap this to start the interview:\n")
        print(f"https://t.me/{bot_username()}?start={enrollment['token']}")
        print(f"""
== keep these for the rest of the run ==
  TRIP_ID={trip_id}
  EMAIL={email}
  PASSWORD={password}

== after you finish and CONFIRM the interview ==
Confirming now triggers the build itself (planner.ts provisionOnConfirm), so a
site should appear with no further action. If it does not, drive it by hand:

  AUTH=$(python3 -c "import base64,json;print(base64.urlsafe_b64encode(json.dumps({{'email':'{email}','password':'{password}'}}).encode()).decode().rstrip('='))")
  curl -s -X POST {args.api}/v1/trips/{trip_id}/plan -H "X-Portal-Password-Login: $AUTH"
  curl -s -X POST {args.api}/v1/plans/<planId>/approve -H "X-Portal-Password-Login: $AUTH"

== watch it happen ==
  docker logs -f kinerary-control-plane-local-worker-1
  tail -f /tmp/relay.log
  docker exec kinerary-control-plane-local-postgres-1 psql -U kinerary_control_plane \\
    -d kinerary_control_plane -c "SELECT slug, lifecycle_state FROM control_plane.trips;"
""")
        return 0
    except Stop as exc:
        print(f"\nstopped: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
