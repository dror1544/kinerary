#!/usr/bin/env python3
"""Give a real organizer an account and a Telegram interview link, in one call.

`new-trip-run.py` does this for a TEST stack, with a throwaway `+tag` address
and a relay it may start itself. This does it for a person: one email in, one
greeting message out, ready to paste into whatever you talk to them on.

It is idempotent by design. `startSignup` returns the existing row when the
user already has an approved signup (signup.ts step 2a), so a second call for
the same address does NOT create a second trip — it re-mints the interview link
for the trip they already have. That is the common case: enrollment links live
24h and production has real signups whose links expired unopened.

WHY THE PASSWORD IS STORED. Minting a link needs `X-Portal-Password-Login`,
i.e. the organizer's own email+password — the control plane keeps only a scrypt
hash and has no password reset anywhere. Lose the password and that address can
never be re-linked, and cannot sign up for itself either (user_identities is
unique on (provider, digest)). So the credential is written to
KINERARY_ORGANIZER_STORE on first use and read back on every later one. Treat
that directory as a secret store: keep it out of git, 0600.

This half knows no host, no container, no bot and no path — it REFUSES when
they are unset rather than guessing. A private wrapper supplies them; see
CLAUDE.md, "Two repositories".

    KINERARY_CP_SSH           user@host of the control-plane host, or `local`
                              to call the API from this machine
    KINERARY_CP_SSH_KEY       identity file for that ssh (optional)
    KINERARY_CP_API           API base URL AS SEEN ON THAT HOST
                              (default http://127.0.0.1:4310)
    KINERARY_BOT_USERNAME     the Telegram bot the deep link points at
    KINERARY_ORGANIZER_STORE  directory holding issued organizer credentials
    KINERARY_CP_PSQL          psql command prefix on that host, needed ONLY by
                              --new-link (there is no API route that revokes an
                              enrollment)

stdout is the greeting, and nothing else, so it pipes into a clipboard.
Everything the operator needs to know goes to stderr.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ENROLLMENT_TTL_NOTE_HOURS = 24


class Stop(Exception):
    """Something the operator has to decide or fix — not a crash."""


# ── the two halves of "where" ────────────────────────────────────────────────

def required_env(name: str, why: str) -> str:
    value = (os.environ.get(name) or "").strip()
    if not value:
        raise Stop(f"{name} is not set — {why}.\n"
                   f"  This script deliberately has no default for it: a default that names\n"
                   f"  one deployment is how a second one silently points at the first.")
    return value


def call(path: str, *, method: str = "GET", body: dict | None = None,
         headers: dict[str, str] | None = None) -> tuple[int, str]:
    """One API call, run either here or on the control-plane host over ssh."""
    api = (os.environ.get("KINERARY_CP_API") or "http://127.0.0.1:4310").rstrip("/")
    target = required_env("KINERARY_CP_SSH",
                          "it names the control-plane host (or `local` to call the API from here)")
    url = f"{api}{path}"
    payload = json.dumps(body).encode() if body is not None else None

    if target == "local":
        request = urllib.request.Request(url, data=payload, method=method)
        # Only when there IS a body: Fastify rejects a POST that declares JSON
        # and sends nothing, and the enrollment call carries its auth in a
        # header with no body at all.
        if payload is not None:
            request.add_header("content-type", "application/json")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()
        except Exception as error:  # noqa: BLE001
            raise Stop(f"{method} {path} failed: {error}") from error

    # The API listens on loopback on that host on purpose, so the request is
    # made THERE. The body goes over stdin base64'd rather than through the
    # remote shell's argv — it carries a password.
    remote = ["curl", "-sS", "-X", method, "-w", r"\n%{http_code}", url]
    for key, value in (headers or {}).items():
        remote += ["-H", f"{key}: {value}"]
    if payload is not None:
        remote += ["-H", "content-type: application/json", "--data-binary", "@-"]
        stdin = base64.b64encode(payload).decode()
        command = f"printf %s {shlex.quote(stdin)} | base64 -d | " + " ".join(shlex.quote(a) for a in remote)
    else:
        command = " ".join(shlex.quote(a) for a in remote)

    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
    key = (os.environ.get("KINERARY_CP_SSH_KEY") or "").strip()
    if key:
        ssh += ["-i", os.path.expanduser(key)]
    result = subprocess.run(ssh + [target, command], capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise Stop(f"ssh to the control-plane host failed: {result.stderr.strip() or result.returncode}")
    text = result.stdout.rstrip("\n")
    body_text, _, status = text.rpartition("\n")
    if not status.isdigit():
        raise Stop(f"unreadable response from {method} {path}: {text!r}")
    return int(status), body_text


def psql(sql: str) -> str:
    """One statement against the control-plane database, on that same host.

    Only --new-link needs this. A live enrollment can only be REPLACED, never
    re-read: the row keeps a digest, so nobody — including this script — can
    recover a token that was already handed out. Revoking is therefore the only
    honest way to produce a second link, and it is a deliberate act.
    """
    prefix = required_env("KINERARY_CP_PSQL",
                          "it is the psql command that reaches the control-plane database")
    target = required_env("KINERARY_CP_SSH", "it names the control-plane host")
    remote = f"{prefix} -tAc {shlex.quote(sql)}"
    if target == "local":
        result = subprocess.run(["sh", "-c", remote], capture_output=True, text=True, timeout=60)
    else:
        ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
        key = (os.environ.get("KINERARY_CP_SSH_KEY") or "").strip()
        if key:
            ssh += ["-i", os.path.expanduser(key)]
        result = subprocess.run(ssh + [target, remote], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise Stop(f"psql failed: {result.stderr.strip() or result.returncode}")
    return result.stdout.strip()


# ── the credential store ─────────────────────────────────────────────────────

def store_path(email: str) -> str:
    directory = required_env("KINERARY_ORGANIZER_STORE",
                             "it is where issued organizer credentials are kept")
    directory = os.path.expanduser(directory)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    safe = re.sub(r"[^a-z0-9]+", "-", email.strip().lower()).strip("-")
    return os.path.join(directory, f"{safe}.json")


def load_credential(email: str) -> dict | None:
    path = store_path(email)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def save_credential(email: str, record: dict) -> str:
    path = store_path(email)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return path


# ── the greeting ─────────────────────────────────────────────────────────────

def greeting(link: str, name: str | None, lang: str) -> str:
    if lang == "en":
        hello = f"Hi {name}! 👋" if name else "Hi there! 👋"
        return "\n".join([
            hello,
            "",
            "I'm Kinerary — the assistant that turns your trip into a site your whole group can use.",
            "Your account is ready, so we can start whenever you are.",
            "",
            "How it works:",
            "• A short interview right here in Telegram — where you're going, when, and who's coming",
            "• Answer in your own words. You can also send documents (flight tickets, hotel confirmations) and I'll read them",
            "• At the end I build your trip site: a day-by-day plan, maps, and everything in one place",
            "",
            "Here's your link — tap it and we'll start:",
            link,
            "",
            f"⚠️ The link is personal and valid for {ENROLLMENT_TTL_NOTE_HOURS} hours. If it expires, just tell me and I'll send a new one.",
            "",
            "Looking forward to hearing about the trip! ✈️",
        ])

    hello = f"שלום {name}! 👋" if name else "שלום! 👋"
    return "\n".join([
        hello,
        "",
        "נעים להכיר — אני Kinerary, העוזר שהופך את הטיול שלכם לאתר אישי לכל המשפחה או החבורה.",
        "פתחתי לך חשבון, ואפשר להתחיל מתי שנוח לך.",
        "",
        "איך זה עובד:",
        "• ריאיון קצר כאן בטלגרם — לאן נוסעים, מתי, ומי מגיע",
        "• עונים בחופשיות, במילים שלך. אפשר גם לשלוח מסמכים (כרטיסי טיסה, אישורי מלון) ואני אקרא אותם",
        "• בסוף אני בונה לכם אתר טיול: תוכנית יום-יום, מפות, והכול במקום אחד",
        "",
        "הנה הקישור שלך — פשוט לוחצים ומתחילים:",
        link,
        "",
        f"⚠️ הקישור אישי ותקף ל-{ENROLLMENT_TTL_NOTE_HOURS} שעות. אם פג תוקפו — תגיד לי ואשלח לך קישור חדש.",
        "",
        "מחכה לשמוע על הטיול! ✈️",
    ])


# ── the run ──────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create (or re-link) an organizer account and print a ready-to-send greeting.")
    parser.add_argument("email", help="the organizer's email address")
    parser.add_argument("--name", help="what to call them in the greeting (e.g. ירון). Omitted: no name.")
    parser.add_argument("--lang", choices=["he", "en"], default="he",
                        help="language of the GREETING only — the interview follows their own phone (default: he)")
    parser.add_argument("--trip-name", dest="trip_name",
                        help="label for the signup request (default: the email's local part)")
    parser.add_argument("--adopt-password", dest="adopt", action="store_true",
                        help="read an EXISTING organizer password from stdin and put it in the "
                             "store, for an account that was created before this script existed. "
                             "Never takes it on argv.")
    parser.add_argument("--new-link", dest="new_link", action="store_true",
                        help="revoke the link this trip already has and issue a fresh one "
                             "(the old one stops working)")
    parser.add_argument("--json", action="store_true", help="also print the operator facts as JSON on stderr")
    args = parser.parse_args()

    email = args.email.strip()
    if not EMAIL_RE.match(email):
        raise Stop(f"{email!r} does not look like an email address")

    bot = required_env("KINERARY_BOT_USERNAME", "it names the Telegram bot the link points at").lstrip("@")

    status, body = call("/readyz")
    if status != 200:
        raise Stop(f"the control plane is not ready (HTTP {status}): {body}")
    ready = json.loads(body)
    if ready.get("status") != "ready":
        raise Stop(f"the control plane is not ready: {body}")
    print(f"control plane ready · schema {ready.get('schema_migrations')}", file=sys.stderr)

    existing = load_credential(email)
    if args.adopt:
        if sys.stdin.isatty():
            raise Stop("--adopt-password reads the password from stdin, so it never lands in a\n"
                       "  shell history or a process list. Pipe it in, e.g.\n"
                       "  `pbpaste | create-trip-link <email> --adopt-password`")
        adopted = sys.stdin.read().strip()
        if len(adopted) < 8:
            raise Stop("that is not a password the control plane would have accepted (min 8 chars)")
        existing = {**(existing or {}), "password": adopted}
        print("adopted an existing password into the store", file=sys.stderr)

    password = existing["password"] if existing else "K" + secrets.token_urlsafe(18)
    if existing:
        print("known address — re-minting the link for the trip it already has", file=sys.stderr)

    trip_name = args.trip_name or f"{email.split('@')[0]} trip"
    status, body = call("/v1/signup", method="POST",
                        body={"password": {"email": email, "password": password},
                              "trip_name_request": trip_name[:120]})
    if status == 401:
        raise Stop("the control plane already knows this address with a DIFFERENT password.\n"
                   "  There is no password reset. Recover the credential from whoever issued it,\n"
                   f"  drop it into {store_path(email)} as {{\"password\": \"...\"}}, and run this again.\n"
                   f"  (server said: {body})")
    if status != 200:
        raise Stop(f"signup failed (HTTP {status}): {body}")
    signup = json.loads(body)
    if signup.get("status") == "awaiting_approval":
        raise Stop("this deployment does not auto-approve signups: the request is now waiting for the\n"
                   f"  super-admin to tap Approve in Telegram (request {signup.get('requestId')}).\n"
                   "  Approve it, then run this again — it will pick up the trip and mint the link.")
    if signup.get("status") != "approved" or not signup.get("tripId"):
        raise Stop(f"signup did not produce a trip: {body}")
    trip_id = signup["tripId"]
    print(f"trip {trip_id} ({'existing' if existing else 'new'})", file=sys.stderr)

    # Save the credential HERE, not after the link is minted. Signup returning
    # 200 is proof the password is the one the control plane holds, and minting
    # can still legitimately fail (a live link already exists, the trip has
    # moved past draft). Losing a verified password to one of those is how an
    # address becomes permanently unreachable — there is no password reset.
    record = {
        "email": email,
        "password": password,
        "trip_id": trip_id,
        "display_name": args.name or (existing or {}).get("display_name"),
        "created_at": (existing or {}).get("created_at") or datetime.now(timezone.utc).isoformat(),
        "note": "password kept because minting a link needs it and there is no password reset",
    }
    saved = save_credential(email, record)

    if args.new_link:
        revoked = psql(
            "WITH r AS (UPDATE control_plane.interview_enrollments SET state = 'revoked' "
            f"WHERE trip_id = '{trip_id}' AND state = 'issued' RETURNING 1) "
            "SELECT count(*) FROM r")
        print(f"revoked {revoked} live link(s) — they stop working now", file=sys.stderr)

    header = base64.urlsafe_b64encode(
        json.dumps({"email": email, "password": password}).encode()).decode().rstrip("=")
    status, body = call(f"/v1/trips/{trip_id}/enrollment", method="POST",
                        headers={"X-Portal-Password-Login": header})
    if status == 409 and "ACTIVE_ENROLLMENT_EXISTS" in body:
        raise Stop("this trip already has a live interview link, and it is still valid.\n"
                   "  Its token cannot be reprinted — the control plane stores only a digest,\n"
                   "  so nobody can recover a link that was already handed out.\n"
                   "  Send them the one you already have, or run again with --new-link to\n"
                   "  revoke it and issue a fresh one (the old link stops working).")
    if status == 409 and "TRIP_NOT_DRAFT" in body:
        raise Stop("this organizer's trip is past `draft` — the interview has already been\n"
                   "  answered, or the site is built. A new link would not be a fresh start.\n"
                   "  Use scripts/fresh-interview.py, which knows what it is allowed to reset.")
    if status != 201:
        raise Stop(f"could not mint the interview link (HTTP {status}): {body}")
    enrollment = json.loads(body)
    link = f"https://t.me/{bot}?start={enrollment['token']}"

    record.update({
        "last_link_issued_at": datetime.now(timezone.utc).isoformat(),
        "last_enrollment_id": enrollment["enrollmentId"],
        "last_link_expires_at": enrollment["expiresAt"],
    })
    saved = save_credential(email, record)

    expires = datetime.fromisoformat(enrollment["expiresAt"].replace("Z", "+00:00")).astimezone()
    print(f"link expires {expires:%Y-%m-%d %H:%M %Z} · credential at {saved}", file=sys.stderr)
    if args.json:
        print(json.dumps({k: v for k, v in record.items() if k != "password"}, indent=2), file=sys.stderr)

    print(greeting(link, args.name, args.lang))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Stop as stop:
        print(f"\n✗ {stop}\n", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)
