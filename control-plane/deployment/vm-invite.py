#!/usr/bin/env python3
"""kinerary-invite — hand somebody an interview link, from the control-plane host.

WHAT THIS IS FOR. Every other way to get an interview link needs the
organizer's own credentials, so inviting a person who has never contacted this
deployment meant inventing a password on their behalf or writing SQL. This
calls the control plane's operator route instead, which creates the trip and
issues the same single-use link the organizer's own request would have.

TWO CALLERS, ONE IMPLEMENTATION.
  a person        `kinerary-invite preview <email>` then `... create <email> …`
  the monitor     `gate preview …` / `gate create …`, arriving over SSH as the
                  `cpinvite` user's forced command, which hands validated
                  tokens to `gate` and never opens a shell.

WHAT IT NEVER DOES. It does not read, reset or set anybody's password; there is
no such route. It does not send the invitation — it prints it, and a person
decides who to send it to. And it refuses rather than guessing whenever the
control plane says the address is in the middle of something: `gate` exists to
be a smaller door than a shell, not a faster one.

WHERE THE FACTS LIVE. Nothing here knows an address, a key or a bot: the API's
location, the operator key and the bot token are read from the deployment's own
env file (kinerary-deploy), because this repo is public.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

ENV = os.environ


def _required_env(name: str) -> str:
    value = ENV.get(name)
    if not value:
        raise ValueError(f"environment variable {name} is required")
    return value


# No default: this repo names no deployment's own paths (hard rule 6). Both
# live in the deployment's own env file, exactly like every other operator
# script's real host/path facts.
#
# Read lazily, inside the functions that need them, not at import time —
# `control_plane_worker/__main__.py` established the pattern: a module-level
# `_required_env()` call raises the moment the module is imported, before any
# caller gets a chance to set the environment first. That broke this file's
# own test (`tests/scripts/test_vm_invite.py`), which imports it directly via
# `importlib` to test `parse_gate` and never sets either variable, since most
# of what it tests needs neither.
DEFAULT_API = "http://127.0.0.1:4310"


def _deploy_env_path() -> Path:
    return Path(_required_env("KINERARY_INVITE_ENV"))


def _secrets_dir() -> Path:
    return Path(_required_env("KINERARY_SECRETS_DIR"))

# The gate's charset. Wider than the release gate's by exactly one character —
# '@' — because an address is the one argument this tool takes. Nothing here is
# ever handed to a shell; the gate execs an argv.
GATE_TOKEN = re.compile(r"^[A-Za-z0-9._:@+-]{1,120}$")
EMAIL = re.compile(r"^[^@\s]{1,64}@[A-Za-z0-9.-]{1,120}\.[A-Za-z]{2,24}$")
LANGUAGES = ("en", "he")


class Refusal(Exception):
    """Something the caller asked for that this tool will not do."""


def read_env_text(text: str) -> Dict[str, str]:
    """KEY=value lines; comments, blanks and `export ` prefixes ignored."""
    values: Dict[str, str] = {}
    for raw in text.split("\n"):
        line = raw.strip()
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def deployment_facts() -> Dict[str, str]:
    deploy_env = _deploy_env_path()
    if not deploy_env.exists():
        raise Refusal(
            f"{deploy_env} does not exist — the API's address and the operator key live in the "
            "deployment's own env file, not in this repo"
        )
    return read_env_text(deploy_env.read_text())


def bot_username(facts: Dict[str, str]) -> str:
    """The handle the link points at, from the bot itself wherever possible.

    A handle written down somewhere is a handle that survives a rename, and a
    renamed bot's link opens a chat with nothing at all. The token's own
    `getMe` cannot be stale, so it wins; the configured value is the fallback
    for a host that holds no token.
    """
    token_file = facts.get("TELEGRAM_BOT_TOKEN_FILE") or str(_secrets_dir() / "telegram_creds")
    path = Path(token_file)
    if path.exists():
        token = path.read_text().strip()
        try:
            with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/getMe", timeout=15) as response:
                payload = json.loads(response.read().decode())
            username = (payload.get("result") or {}).get("username")
            if username:
                return str(username)
        except Exception:  # noqa: BLE001 — the error text can carry the URL, and with it the token
            pass
    configured = facts.get("KINERARY_BOT_USERNAME", "")
    if not configured:
        raise Refusal(
            "could not work out which bot the link should point at: no reachable bot token and no "
            "KINERARY_BOT_USERNAME in the deployment's env file"
        )
    return configured


def call_api(facts: Dict[str, str], path: str, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
    key = facts.get("CONTROL_PLANE_OPERATOR_KEY", "")
    if not key:
        raise Refusal(
            "CONTROL_PLANE_OPERATOR_KEY is not set in the deployment's env file, so the control plane "
            "has no operator routes mounted — set it on both sides and restart the API"
        )
    api = facts.get("KINERARY_API", DEFAULT_API).rstrip("/")
    request = urllib.request.Request(
        f"{api}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-API-Key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        raw = error.read().decode() or "{}"
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, {"error": "UNREADABLE_RESPONSE", "detail": raw[:200]}
    except urllib.error.URLError as error:
        raise Refusal(f"the control plane at {api} could not be reached: {error.reason}") from None


def validate_email(email: str) -> str:
    address = email.strip()
    if not EMAIL.match(address):
        raise Refusal(f"{address[:60]!r} is not an email address")
    return address


def validate_language(language: str) -> str:
    if language not in LANGUAGES:
        raise Refusal(f"the interview speaks {' and '.join(LANGUAGES)}; {language[:20]!r} is neither")
    return language


def render_plan(plan: Optional[Dict[str, Any]]) -> List[str]:
    if not plan:
        return []
    lines = []
    kind = plan.get("kind")
    lines.append({
        "new": "Nobody here holds that address. An account and a first trip would be created.",
        "resume": f"They already have a draft trip ({plan.get('tripSlug')}) they have not started. "
                  "Its old link would be revoked and replaced — no second trip.",
        "returning": "They have had a trip built before. A second trip would be created beside it, "
                     "and the interview would greet them as a returning organizer.",
    }.get(str(kind), f"kind: {kind}"))
    existing = plan.get("existing") or []
    if existing:
        lines.append("Their trips:")
        for trip in existing:
            lines.append(f"  {trip.get('slug')}  {trip.get('lifecycleState')}")
    return lines


def cmd_preview(facts: Dict[str, str], email: str) -> int:
    status, payload = call_api(facts, "/internal/operator/invitations/preview", {"email": email})
    if status != 200:
        print(f"refused: {payload.get('error')} {payload.get('detail', '')}".strip())
        return 1
    if payload.get("ok"):
        for line in render_plan(payload.get("plan")):
            print(line)
        print("\nNothing has been created. `create` is what does that.")
        return 0
    print(f"cannot invite this address: {payload.get('reason')}")
    print(payload.get("detail", ""))
    for line in render_plan(payload.get("plan")):
        print(line)
    return 1


def cmd_create(facts: Dict[str, str], email: str, language: str, invited_by: str) -> int:
    status, payload = call_api(facts, "/internal/operator/invitations", {
        "email": email,
        "language": language,
        "botUsername": bot_username(facts),
        "invitedBy": invited_by,
    })
    if status != 201:
        print(f"refused: {payload.get('error')}")
        if payload.get("detail"):
            print(payload["detail"])
        return 1
    print(f"kind: {payload['kind']}   trip: {payload['tripId']}   expires: {payload['expiresAt']}")
    print("")
    # The message and nothing else between the markers, so a person — or an
    # agent relaying this into a chat — can forward exactly what was written
    # rather than a paraphrase of it.
    print("--- send this ---")
    print(payload["message"])
    print("--- end ---")
    return 0


def parse_gate(tokens: Sequence[str]) -> Tuple[str, List[str]]:
    """Validate what arrived over SSH. Returns (verb, args), or refuses.

    Everything the gate accepts is checked here rather than in the shell
    wrapper, so there is one place that decides what the monitor may ask for.
    """
    if not tokens:
        raise Refusal("no verb — try: preview <email> | create <email> <en|he> <who-asked>")
    for token in tokens:
        if not GATE_TOKEN.match(token):
            raise Refusal(f"refused token {token[:20]!r}: letters, digits, . _ : @ + - only")
    verb, rest = tokens[0], list(tokens[1:])
    if verb == "preview":
        if len(rest) != 1:
            raise Refusal("preview <email>")
        return verb, [validate_email(rest[0])]
    if verb == "create":
        if len(rest) != 3:
            raise Refusal("create <email> <en|he> <who-asked>")
        return verb, [validate_email(rest[0]), validate_language(rest[1]), rest[2]]
    if verb == "help":
        return verb, []
    raise Refusal(f"unknown verb {verb!r} — try: preview, create, help")


GATE_HELP = """kinerary-invite, through the gate:
  preview <email>                      what an invitation would do. Changes nothing.
  create <email> <en|he> <who-asked>   create it and print the message to send.

`who-asked` is recorded with the invitation. The link is printed here and sent
to nobody: a person decides who receives it.
"""


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Hand somebody an interview link.")
    sub = parser.add_subparsers(dest="command", required=True)

    preview = sub.add_parser("preview", help="what an invitation would do (changes nothing)")
    preview.add_argument("email")

    create = sub.add_parser("create", help="create the trip and the link")
    create.add_argument("email")
    create.add_argument("--language", default="en", choices=list(LANGUAGES))
    create.add_argument("--invited-by", default=os.environ.get("USER", "an operator"))

    gate = sub.add_parser("gate", help="the forced command's entry point")
    gate.add_argument("tokens", nargs="*")

    args = parser.parse_args(list(argv) if argv is not None else None)

    try:
        if args.command == "gate":
            verb, rest = parse_gate(args.tokens)
            if verb == "help":
                print(GATE_HELP)
                return 0
            facts = deployment_facts()
            if verb == "preview":
                return cmd_preview(facts, rest[0])
            return cmd_create(facts, rest[0], rest[1], rest[2])

        facts = deployment_facts()
        if args.command == "preview":
            return cmd_preview(facts, validate_email(args.email))
        return cmd_create(
            facts, validate_email(args.email), validate_language(args.language), args.invited_by,
        )
    except Refusal as refusal:
        print(f"refused: {refusal}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
