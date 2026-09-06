#!/usr/bin/env python3
"""Point a Telegram chat at a different trip. TEST TOOL — not the product.

The MVP is deliberately one active trip per chat, enforced in the database:

    telegram_chat_bindings_active_chat_idx  UNIQUE (chat_id) WHERE closed_at IS NULL

and `bind_chat_to_trip` REFUSES to move a chat between trips, because
reassignment is a reviewed organizer action a background job has no standing
to perform. That refusal is correct and stays.

The consequence during testing is that the system can enter a state it cannot
leave: one tester, one Telegram account, one DM, and every provisioning round
produces a new trip that cannot have the chat. On 2026-09-06 that is exactly
what happened — japan-2026-2 provisioned perfectly and finished
`unreachable / BINDING_REFUSED` because the DM still belonged to japan-2026.

This does the reassignment the product will eventually do through `/select`
(designed, unbuilt — see the Sprint 5 plan, "Not built"). It is a stand-in for
a person clicking a confirmed choice, NOT a preview of the feature: no signed
callback, no permission check, no organizer identity. Do not grow it into one,
and do not import it from anything.

    scripts/switch-trip-chat.py --list
    scripts/switch-trip-chat.py --chat 391627336 --to japan-2026-2
    scripts/switch-trip-chat.py --chat 391627336 --to japan-2026-2 --yes

WHAT IT PRESERVES
-----------------
The binding lifecycle. The old row is CLOSED with a reason, never overwritten
or deleted, so history survives exactly as migration 0029 intends — a closed
binding stays readable and every production reader already filters
`closed_at IS NULL`.

Reachability is corrected on BOTH sides, because a binding row is not a health
claim (migration 0042): the trip losing the chat stops claiming `reachable`,
and the trip gaining it only claims `reachable` if a companion profile is
actually behind it. Getting this wrong would leave a trip asserting it can be
talked to when nothing routes to it — the exact failure reachability exists to
make visible.

WHAT IT REFUSES TO DO
---------------------
Bind a chat to a trip that is not provisioned (`ready_private` or later): there
is no site and no companion, so the organizer would be routed to nothing. And
it will not run without `--yes` once it knows what it would change — the
summary is printed first, every time, because the chat being moved is somebody's
live trip.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys

PG_CONTAINER = os.environ.get("KINERARY_PG_CONTAINER", "kinerary-control-plane-local-postgres-1")
PG_USER = os.environ.get("KINERARY_PG_USER", "kinerary_control_plane")

# A chat may only be pointed at a trip that actually has something behind it.
BINDABLE = {"ready_private", "activation_approved", "active"}


class Refused(Exception):
    """A guard fired. The message is for the operator, not a stack trace."""


def psql(sql: str) -> str:
    proc = subprocess.run(
        ["docker", "exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_USER, "-tAc", sql],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise Refused(
            f"could not reach Postgres in container {PG_CONTAINER!r}:\n"
            f"  {proc.stderr.strip()}\n"
            "  Is the control-plane stack up? Set KINERARY_PG_CONTAINER to override."
        )
    return proc.stdout.strip()


def q(value: str) -> str:
    """Single-quote a literal for psql. Test tool, local database, but a slug
    with an apostrophe should still not be able to end the statement."""
    return "'" + value.replace("'", "''") + "'"


def resolve_trip(ref: str) -> tuple[str, str, str, bool]:
    """(trip_id, slug, lifecycle_state, has_companion) from a slug or a trip id."""
    row = psql(
        "SELECT id, slug, lifecycle_state, "
        "       COALESCE(array_length(assistant_names, 1), 0) > 0 "
        f"FROM control_plane.trips WHERE slug = {q(ref)} OR id = {q(ref)} LIMIT 1"
    )
    if not row:
        raise Refused(f"no trip matches {ref!r} — try --list")
    trip_id, slug, state, has_companion = row.split("|")
    return trip_id, slug, state, has_companion == "t"


def show_list() -> None:
    print("Open chat bindings:\n")
    rows = psql(
        "SELECT b.chat_id, t.slug, COALESCE(b.hermes_profile, '(no companion)'), t.reachability "
        "FROM control_plane.telegram_chat_bindings b "
        "JOIN control_plane.trips t ON t.id = b.trip_id "
        "WHERE b.closed_at IS NULL ORDER BY b.chat_id"
    )
    print("  (none)" if not rows else
          "\n".join(f"  chat {c:<12} -> {s:<28} {p:<22} {r}"
                    for c, s, p, r in (l.split("|") for l in rows.splitlines())))
    print("\nProvisioned trips you can switch to:\n")
    rows = psql(
        "SELECT slug, lifecycle_state, reachability, "
        "       COALESCE(array_to_string(assistant_names, ','), '(no companion)') "
        "FROM control_plane.trips "
        f"WHERE lifecycle_state IN ({','.join(q(s) for s in sorted(BINDABLE))}) "
        "ORDER BY updated_at DESC LIMIT 25"
    )
    print("  (none)" if not rows else
          "\n".join(f"  {s:<28} {ls:<16} {r:<12} {a}"
                    for s, ls, r, a in (l.split("|") for l in rows.splitlines())))


def switch(chat_id: str, target_ref: str, apply: bool) -> None:
    trip_id, slug, state, has_companion = resolve_trip(target_ref)
    if state not in BINDABLE:
        raise Refused(
            f"{slug} is {state!r}, not provisioned. Binding a chat to it would route "
            "the organizer to a trip with no site and no companion."
        )

    current = psql(
        "SELECT b.id, t.slug, t.id "
        "FROM control_plane.telegram_chat_bindings b "
        "JOIN control_plane.trips t ON t.id = b.trip_id "
        f"WHERE b.chat_id = {q(chat_id)} AND b.closed_at IS NULL LIMIT 1"
    )
    old_binding_id, old_slug, old_trip_id = (current.split("|") if current else (None, None, None))

    if old_trip_id == trip_id:
        print(f"chat {chat_id} is already bound to {slug} — nothing to do.")
        return

    print(f"  chat            {chat_id}")
    print(f"  currently       {old_slug or '(unbound)'}")
    print(f"  would become    {slug}")
    print(f"  companion       {'yes' if has_companion else 'NO — the trip will be bound but unreachable'}")
    if not apply:
        print("\nNothing changed. Re-run with --yes to apply.")
        return

    stmts = []
    if old_binding_id:
        stmts.append(
            "UPDATE control_plane.telegram_chat_bindings "
            "SET closed_at = now(), closed_reason = 'test_switch' "
            f"WHERE id = {q(old_binding_id)}"
        )
        # The trip losing its chat must stop claiming it can be reached. Left
        # alone, it would keep asserting `reachable` with nothing routed to it.
        stmts.append(
            "UPDATE control_plane.trips "
            "SET reachability = 'unreachable', unreachable_reason = 'NO_ORGANIZER_CHAT', "
            "    reachability_checked_at = now() "
            f"WHERE id = {q(old_trip_id)} AND NOT EXISTS ("
            "  SELECT 1 FROM control_plane.telegram_chat_bindings "
            f"  WHERE trip_id = {q(old_trip_id)} AND closed_at IS NULL)"
        )
    stmts.append(
        "INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile) "
        f"SELECT 'tcb_' || md5(random()::text), {q(chat_id)}, {q(trip_id)}, "
        "       (SELECT hermes_profile FROM control_plane.telegram_chat_bindings "
        f"        WHERE trip_id = {q(trip_id)} ORDER BY created_at DESC LIMIT 1)"
    )
    # Only a trip with a companion may claim reachable — same rule the
    # provisioner follows, for the same reason.
    stmts.append(
        "UPDATE control_plane.trips SET "
        "  reachability = CASE WHEN COALESCE(array_length(assistant_names, 1), 0) > 0 "
        "                      THEN 'reachable' ELSE 'unreachable' END, "
        "  unreachable_reason = CASE WHEN COALESCE(array_length(assistant_names, 1), 0) > 0 "
        "                            THEN NULL ELSE 'COMPANION_INSTALL_FAILED' END, "
        "  reachability_checked_at = now() "
        f"WHERE id = {q(trip_id)}"
    )
    psql("BEGIN; " + "; ".join(stmts) + "; COMMIT;")
    print(f"\nswitched: chat {chat_id} -> {slug}")
    print("  the old binding was closed (reason 'test_switch'), not deleted.")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--list", action="store_true", help="show open bindings and switchable trips")
    p.add_argument("--chat", help="Telegram chat id to move")
    p.add_argument("--to", help="target trip slug or id")
    p.add_argument("--yes", action="store_true", help="actually apply the change")
    args = p.parse_args()
    try:
        if args.list or not (args.chat and args.to):
            show_list()
            if not args.list:
                print("\nUsage: --chat <id> --to <slug> [--yes]")
            return 0
        switch(args.chat, args.to, apply=args.yes)
        return 0
    except Refused as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
