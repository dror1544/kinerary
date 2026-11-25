"""The `features` block of a trip's trip.config.json — per-trip feature switches
(issue #567, slice S2; docs/specs/sprint-9/567-feature-switches.md).

A trip's switches are decided by the control plane, in SQL
(`control_plane.feature_enabled(trip_id, switch)`: the trip's own setting, then
every trip, then future trips, then OFF). The trip's SITE cannot ask the database,
so the worker writes the answer into the trip's files when it provisions and when
`scripts/trip-rollout.py` rolls out: a `features` object holding EXACTLY the
registered switches that are on for the trip, each as the literal `true`, and
nothing else. The site reads it once at boot (server/server.js) and serves members
only the member-visible part (shared/config-visibility.js).

WHICH REGISTRY. The registry — the closed set of names — is
`shared/feature-switches.js`. This worker is Python and its image carries no
`shared/`, so `REGISTERED_SWITCHES` below is a mirror, and
tests/test_feature_block.py pins it to the JavaScript file (names and order) so the
two cannot drift unnoticed. Both ways of drifting fail safe: a name this mirror
does not know is never written (off); a name written that the site's registry does
not know is dropped at the site's boot and logged (AC-13).

WHICH ANSWER. The SQL function, never a recomputation. Callers check the registry
FIRST (this module does) because `feature_enabled` resolves a stored row for any
name as written — only the registry says which names exist
(control-plane/api/src/feature-switches.ts says the same).

FAIL SAFE. A provision must not fail over a switch read, and must not turn a switch
ON on a doubtful answer: a read that raises (a database older than migration
20261114120000_feature_switches, a dropped connection) logs
`feature_block.read_failed` and yields an EMPTY block — every switch off. A rollout,
which has an operator watching, does not use this fallback: it fails the step
instead (scripts/trip-rollout.py).

Standard library only, so scripts/trip-rollout.py can load it by path, as it loads
companion_profile.py.
"""
from __future__ import annotations

import logging
from typing import Any, Iterable, Mapping

logger = logging.getLogger(__name__)

# Mirror of shared/feature-switches.js FEATURE_SWITCHES, in the same order. Only the
# names: whether members may be told is the SITE's serving rule, not the worker's.
REGISTERED_SWITCHES: tuple[str, ...] = (
    "delivery_probe",
    "plan_change_marks",
    "plan_change_group_line",
    "whatsapp",
    "trip_logo",
    "chat_photos_to_album",
    "trip_moments_capture",
    "trip_group_photo",
)

# The subset of REGISTERED_SWITCHES whose registry entry says `memberVisible: true`:
# what a signed-in member's GET /api/config may carry. Used only to say what a site
# should serve back (scripts/trip-rollout.py reads it back after a switches step).
# Pinned to the JavaScript registry by tests/test_feature_block.py, like the names.
MEMBER_VISIBLE_SWITCHES: tuple[str, ...] = (
    "delivery_probe",
    "plan_change_marks",
    "plan_change_group_line",
    "trip_logo",
    "chat_photos_to_album",
    "trip_moments_capture",
    "trip_group_photo",
)

FEATURES_KEY = "features"


def build_features_block(enabled: Mapping[str, Any] | Iterable[str]) -> dict[str, bool]:
    """The block for a trip, from what is known to be on.

    `enabled` is either a mapping of switch name to answer or the names that are on.
    Only a REGISTERED name whose answer is the literal `True` appears, each as the
    literal `True`, in registry order — an unregistered name, `1`, "true", `None` and
    `False` are all off and absent. Nothing else is ever in the block.
    """
    if isinstance(enabled, Mapping):
        on = {name for name, answer in enabled.items() if answer is True}
    else:
        on = set(enabled)
    return {name: True for name in REGISTERED_SWITCHES if name in on}


def resolve_features(conn: Any, trip_id: str) -> dict[str, bool]:
    """The `features` block for one trip, read through a psycopg connection.

    Never raises: any failure is logged (the switch names asked for and nothing about
    the trip) and answered with an empty block — every switch off. The read runs in
    its own savepoint so a failure does not abort the caller's transaction.
    """
    if not isinstance(trip_id, str) or not trip_id or not REGISTERED_SWITCHES:
        return {}
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT s AS switch, control_plane.feature_enabled(%s, s) AS enabled "
                    "FROM unnest(%s::text[]) AS s",
                    (trip_id, list(REGISTERED_SWITCHES)),
                )
                rows = cur.fetchall()
    except Exception as exc:
        logger.warning(
            "feature_block.read_failed",
            # The trip id is named so an operator can tell WHICH trip was given an all-off
            # block; trip ids are not secret. The driver's message is not logged: it can
            # quote a connection string.
            extra={"trip_id": trip_id, "switches": ",".join(REGISTERED_SWITCHES),
                   "error_type": type(exc).__name__},
        )
        return {}
    answers: dict[str, Any] = {}
    for row in rows:
        name, answer = (row["switch"], row["enabled"]) if isinstance(row, Mapping) else (row[0], row[1])
        answers[name] = answer
    return build_features_block(answers)


def with_features(config: Mapping[str, Any], block: Mapping[str, bool]) -> dict[str, Any]:
    """A copy of `config` carrying `block` as its `features` key, replacing any
    `features` already there (an old block must not outlive the answer). The input
    is not modified; no other key is touched."""
    out = dict(config)
    out[FEATURES_KEY] = dict(block)
    return out
