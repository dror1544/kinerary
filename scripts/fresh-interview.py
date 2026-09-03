#!/usr/bin/env python3
"""Reset a draft trip's interview and print a fresh Telegram deep link.

Testing the Trip Bot router end to end means starting the interview over,
repeatedly. Doing that by hand is four steps across three data stores, and the
order matters — which is exactly the kind of thing that gets done wrong at
11pm. This does it in one command, and refuses when it would destroy something
real.

    scripts/fresh-interview.py --trip japan-2026
    scripts/fresh-interview.py --trip trip_3e35f81... --yes

What it does, in order:

  1. Deletes the trip's live interview session and any agent turns for its chat.
  2. Clears that chat's Hermes gateway conversation, so the interviewer starts
     with no inherited history. Skipping this is how the first live run ended
     up narrating a different family's trip: three profiles shared one session
     for that DM, created identical to the microsecond.
  3. Resets the trip to `draft` — `issueEnrollment` accepts no other state, and
     starting an interview moves it to `intake_in_progress`.
  4. Issues a new enrollment through the real HTTP endpoint (not a direct DB
     write, so the path under test is the path exercised) and prints the link.

WHAT IT REFUSES TO DO
---------------------
It will not touch a trip that has a confirmed intake version, and it will not
touch one past `intake_in_progress` in its lifecycle. Both mean somebody's real
answers are on the other side of this, and an intake version is immutable by
design. There is no --force: if you genuinely mean to discard confirmed work,
do it deliberately by hand rather than through a convenience script.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

DEFAULT_API = os.environ.get("KINERARY_API", "http://127.0.0.1:4310")
DEFAULT_PG_CONTAINER = os.environ.get("KINERARY_PG_CONTAINER", "kinerary-control-plane-local-postgres-1")
DEFAULT_PG_USER = os.environ.get("KINERARY_PG_USER", "kinerary_control_plane")
HERMES_HOME = os.path.expanduser(os.environ.get("HERMES_HOME", "~/.hermes"))

# Lifecycle states from which restarting an interview is non-destructive.
# Anything further along has downstream artifacts (a plan, a container, a live
# site) that this script has no business invalidating.
RESETTABLE = {"draft", "intake_in_progress"}


class Refused(Exception):
    """A guard fired. The message is for the operator, not a stack trace."""


def psql(sql: str) -> str:
    """One-shot query against the local control-plane Postgres."""
    proc = subprocess.run(
        ["docker", "exec", DEFAULT_PG_CONTAINER, "psql",
         "-U", DEFAULT_PG_USER, "-d", DEFAULT_PG_USER, "-tAc", sql],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise Refused(
            f"could not reach Postgres in container {DEFAULT_PG_CONTAINER!r}:\n"
            f"  {proc.stderr.strip()}\n"
            "  Is the control-plane stack up? Set KINERARY_PG_CONTAINER to override."
        )
    return proc.stdout.strip()


def resolve_trip(ref: str) -> tuple[str, str, str]:
    """Accepts a trip id or a slug. Returns (id, slug, lifecycle_state)."""
    escaped = ref.replace("'", "''")
    row = psql(
        "SELECT id||'|'||slug||'|'||lifecycle_state FROM control_plane.trips "
        f"WHERE id = '{escaped}' OR slug = '{escaped}' LIMIT 1"
    )
    if not row:
        raise Refused(f"no trip with id or slug {ref!r}")
    trip_id, slug, state = row.split("|", 2)
    return trip_id, slug, state


def guard(trip_id: str, slug: str, state: str) -> None:
    if state not in RESETTABLE:
        raise Refused(
            f"trip {slug!r} is in lifecycle state {state!r}, not one of "
            f"{sorted(RESETTABLE)}.\n"
            "  Past intake there is a plan, a container or a live site behind "
            "this trip; restarting its interview would strand them."
        )
    confirmed = psql(
        "SELECT count(*) FROM control_plane.intake_versions "
        f"WHERE trip_id = '{trip_id}'"
    )
    if confirmed != "0":
        raise Refused(
            f"trip {slug!r} has {confirmed} confirmed intake version(s).\n"
            "  Those are immutable and hold a real organizer's answers. "
            "Refusing — there is no --force for this on purpose."
        )


def clear_hermes_conversation(chat_id: str) -> int:
    """Drops the chat's gateway routing entries so the agent starts fresh.

    Best-effort: a missing state.db is not a reason to fail the reset, it just
    means the interviewer may resume an old conversation. Says so rather than
    failing silently, because that symptom is confusing to diagnose later.
    """
    import glob
    import sqlite3

    # EVERY state.db, not just the top-level one. Each profile carries its own,
    # and the routing entry that decides which conversation the interviewer
    # resumes lives in the SERVING profile's database — not in ~/.hermes/state.db.
    # Clearing only the latter looks like it worked and changes nothing: four
    # consecutive "fresh" interviews on 2026-09-03 all resumed the same
    # conversation, so the agent kept reading its own earlier "everything is
    # approved" replies and stopped calling any tool at all.
    #
    # Routing rows only. The session's MESSAGES are deliberately left alone,
    # because the session id is not namespaced per profile — one id is shared
    # by several profiles on this install, so deleting its messages would erase
    # unrelated conversations. Dropping the routing row is enough: the next
    # inbound turn starts a new session.
    candidates = [os.path.join(HERMES_HOME, "state.db")]
    candidates += sorted(glob.glob(os.path.join(HERMES_HOME, "profiles", "*", "state.db")))
    removed = 0
    touched = 0
    for db in candidates:
        if not os.path.exists(db):
            continue
        try:
            conn = sqlite3.connect(db)
            cur = conn.execute(
                "DELETE FROM gateway_routing WHERE session_key LIKE ?", (f"%{chat_id}%",)
            )
            conn.commit()
            if cur.rowcount and cur.rowcount > 0:
                removed += cur.rowcount
                touched += 1
            conn.close()
        except Exception as exc:  # noqa: BLE001 - operator-facing tool
            print(f"  ! could not clear conversations in {db}: {exc}")
    if not candidates:
        print("  ! no Hermes state.db found — the interviewer may inherit an "
              "earlier conversation")
    return removed


def bot_username() -> str:
    """Deep links need the bot's @name. Ask Telegram if a token is reachable."""
    override = os.environ.get("KINERARY_BOT_USERNAME")
    if override:
        return override.lstrip("@")
    token_path = os.environ.get("KINERARY_BOT_TOKEN_FILE")
    if token_path and os.path.exists(token_path):
        token = open(token_path).read().strip()
        url = f"https://api.telegram.org/bot{token}/getMe"
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                return json.load(resp)["result"]["username"]
        except Exception:  # noqa: BLE001
            # urllib verifies against Python's own CA bundle, which on some
            # machines here fails with a self-signed cert in the chain while
            # curl succeeds against the system store. The bot name is not
            # secret and this is a dev tool, so fall back rather than print a
            # placeholder into a link somebody is about to tap.
            try:
                out = subprocess.run(["curl", "-s", "--max-time", "10", url],
                                     capture_output=True, text=True)
                if out.returncode == 0 and out.stdout:
                    return json.loads(out.stdout)["result"]["username"]
            except Exception:  # noqa: BLE001
                pass
    print("  ! could not resolve the bot username — set KINERARY_BOT_USERNAME "
          "or KINERARY_BOT_TOKEN_FILE; the link below needs it filled in")
    return "<your-bot>"


def issue_enrollment(api: str, trip_id: str, email: str, password: str) -> dict:
    auth = base64.urlsafe_b64encode(
        json.dumps({"email": email, "password": password}).encode()
    ).decode().rstrip("=")
    req = urllib.request.Request(
        f"{api}/v1/trips/{trip_id}/enrollment",
        data=b"{}",
        headers={"content-type": "application/json", "X-Portal-Password-Login": auth},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:300]
        raise Refused(f"enrollment refused ({exc.code}): {body}") from exc
    except urllib.error.URLError as exc:
        raise Refused(f"could not reach the control-plane API at {api}: {exc.reason}") from exc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trip", required=True, help="trip id or slug")
    ap.add_argument("--api", default=DEFAULT_API, help=f"control-plane API base (default {DEFAULT_API})")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    ap.add_argument("--email", default=os.environ.get("KINERARY_TEST_LOGIN_EMAIL"),
                    help="organizer login (KINERARY_TEST_LOGIN_EMAIL)")
    ap.add_argument("--password", default=os.environ.get("KINERARY_TEST_LOGIN_PASSWORD"),
                    help="organizer password (KINERARY_TEST_LOGIN_PASSWORD)")
    args = ap.parse_args()

    if not args.email or not args.password:
        print("error: organizer credentials are required to issue an enrollment.\n"
              "  Set KINERARY_TEST_LOGIN_EMAIL and KINERARY_TEST_LOGIN_PASSWORD, "
              "or pass --email/--password.\n"
              "  (They are the same credentials the trip was signed up with; they are "
              "deliberately not stored in the repo.)", file=sys.stderr)
        return 2

    try:
        trip_id, slug, state = resolve_trip(args.trip)
        guard(trip_id, slug, state)

        sessions = psql(
            "SELECT coalesce(string_agg(id||' ('||state||', chat '||coalesce(telegram_chat_id,'-')||')', '; '), '') "
            f"FROM control_plane.intake_sessions WHERE trip_id = '{trip_id}'"
        )
        chat_ids = [c for c in psql(
            "SELECT coalesce(string_agg(DISTINCT telegram_chat_id, ','), '') "
            f"FROM control_plane.intake_sessions WHERE trip_id = '{trip_id}'"
        ).split(",") if c]

        print(f"trip     {slug}  ({trip_id})")
        print(f"state    {state}")
        print(f"sessions {sessions or '(none)'}")
        if not args.yes:
            reply = input("\nDelete the above and issue a fresh link? [y/N] ").strip().lower()
            if reply not in {"y", "yes"}:
                print("aborted.")
                return 1

        print()
        for chat in chat_ids:
            n = clear_hermes_conversation(chat)
            print(f"  cleared {n} gateway conversation binding(s) for chat {chat} "
                  "across all Hermes profiles")
        psql(f"DELETE FROM control_plane.interview_agent_turns WHERE session_id IN "
             f"(SELECT id FROM control_plane.intake_sessions WHERE trip_id = '{trip_id}')")
        psql(f"DELETE FROM control_plane.intake_sessions WHERE trip_id = '{trip_id}'")
        print("  deleted interview session(s) and agent turns")
        psql(f"UPDATE control_plane.trips SET lifecycle_state = 'draft' WHERE id = '{trip_id}'")
        print("  trip reset to draft")

        # issueEnrollment refuses to mint a second link while one is still
        # live (ACTIVE_ENROLLMENT_EXISTS) — deliberately, so an organizer
        # mid-interview cannot be handed a competing link. A reset is exactly
        # the case where the old link SHOULD stop working, so revoke it rather
        # than leaving a second valid entry point to a wiped interview.
        revoked = psql(
            "WITH r AS (UPDATE control_plane.interview_enrollments "
            "SET state = 'revoked' "
            f"WHERE trip_id = '{trip_id}' AND state = 'issued' RETURNING 1) "
            "SELECT count(*) FROM r"
        )
        if revoked != "0":
            print(f"  revoked {revoked} previously-issued link(s) — they will no longer work")

        result = issue_enrollment(args.api, trip_id, args.email, args.password)
        print(f"  enrollment {result['enrollmentId']} (expires {result['expiresAt']})")
        print()
        print(f"https://t.me/{bot_username()}?start={result['token']}")
        return 0
    except Refused as exc:
        print(f"\nrefused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
