"""The trip's zone from where the trip actually is.

`transformer._resolve_timezone` answers from words: a zone the organizer typed,
or a country name it knows. A destination that is a REGION — "Alsace",
"אלזס", "Tuscany" — resolves to nothing there, and nothing noticed: the real
Alsace trip (built 2026-11-20) came out with no `meta.timezone` and no
`agent.timezone`, so the site's day-by-day ran an hour off on UTC
(server/living-journey.js `tripTimeZone()` falls through to 'UTC') until the
zone was set by hand.

The coordinates do not have that problem. By the time enrichment has run, every
phase that could be geocoded has a `mapStop`, and a point on the earth has one
zone. This module derives it, offline and deterministically (`timezonefinder`
ships its polygons; there is no network call here, so it cannot fail the way a
geocoder can), and `apply_timezone_from_coordinates` writes it into BOTH
`meta.timezone` and `agent.timezone`, the same two places the transformer
writes the zone it resolves from words.

It never overrides a zone that is already there — typed, or derived from the
country — and it never invents an `agent` block for a derived-only zone (the
contract `_derive_agent` documents). When nothing resolves, `warn_if_unresolved`
says so, with the trip id, because an absent zone is otherwise invisible.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from typing import Any

from .transformer import _is_iana_timezone, essence_phase_id

logger = logging.getLogger("control_plane_worker.trip_timezone")

_finder: Any = None
_finder_lock = threading.Lock()
_finder_failed = False


def _get_finder() -> Any:
    """One shared TimezoneFinder (it memory-maps its polygon file; building it
    per lookup would be wasteful). Loud, not silent, when the package is
    missing: that is a broken image, and every trip would quietly fall back to
    UTC again."""
    global _finder, _finder_failed
    if _finder is not None or _finder_failed:
        return _finder
    with _finder_lock:
        if _finder is None and not _finder_failed:
            try:
                from timezonefinder import TimezoneFinder
                _finder = TimezoneFinder()
            except Exception:
                _finder_failed = True
                logger.error("timezone.lookup_unavailable", exc_info=True)
    return _finder


def timezone_for_coordinates(lat: Any, lng: Any) -> str:
    """The IANA zone of a point on land, or "".

    "" for anything unusable: non-numeric, out of range, or open water (a
    geocoder that put a city in the sea is wrong, and the nautical `Etc/GMT±N`
    zones are not a clock anybody on the trip keeps)."""
    try:
        lat_f, lng_f = float(lat), float(lng)
    except (TypeError, ValueError):
        return ""
    if not (-90.0 <= lat_f <= 90.0 and -180.0 <= lng_f <= 180.0):
        return ""
    finder = _get_finder()
    if finder is None:
        return ""
    try:
        zone = finder.timezone_at_land(lat=lat_f, lng=lng_f)
    except Exception:
        logger.warning("timezone.lookup_failed", extra={"lat": lat_f, "lng": lng_f}, exc_info=True)
        return ""
    if not zone or zone.startswith("Etc/") or not _is_iana_timezone(zone):
        return ""
    return zone


def _point(raw: Any) -> tuple[Any, Any] | None:
    if isinstance(raw, Mapping):
        return raw.get("lat"), raw.get("lng")
    if isinstance(raw, (list, tuple)) and len(raw) >= 2:
        return raw[0], raw[1]
    return None


def candidate_points(config: Mapping[str, Any]) -> list[tuple[Any, Any]]:
    """Where the trip is, most representative first.

    The base stop (the one with the most nights — `essence_phase_id`) comes
    first, then the other phases' pins in trip order, then `map.center` and
    `map.stops`. The centre is deliberately NOT first: it is the mean of the
    stops, which for a trip spanning two zones (or two continents) is a point
    nobody visits, and averaging Paris with Tokyo lands in Russia."""
    phases = [p for p in (config.get("phases") or []) if isinstance(p, Mapping)]
    base_id = essence_phase_id(phases)
    ordered = sorted(phases, key=lambda p: 0 if base_id and p.get("id") == base_id else 1)
    points: list[tuple[Any, Any] | None] = [_point(p.get("mapStop")) for p in ordered]
    trip_map = config.get("map")
    if isinstance(trip_map, Mapping):
        points.append(_point(trip_map.get("center")))
        points.extend(_point(s) for s in (trip_map.get("stops") or []))
    return [p for p in points if p is not None]


def zone_from_config_coordinates(config: Mapping[str, Any]) -> str:
    for lat, lng in candidate_points(config):
        zone = timezone_for_coordinates(lat, lng)
        if zone:
            return zone
    return ""


def config_has_timezone(config: Mapping[str, Any]) -> bool:
    meta = config.get("meta")
    zone = meta.get("timezone") if isinstance(meta, Mapping) else None
    return isinstance(zone, str) and _is_iana_timezone(zone)


def apply_timezone_from_coordinates(config: dict[str, Any]) -> str:
    """Fill the trip's zone from its coordinates when nothing else has. Mutates
    *config*; returns the zone it wrote, or "" when it wrote nothing.

    Writes `meta.timezone` (what the site reads) and, when the config already
    has an `agent` block, `agent.timezone` (what the companion schedules by) —
    one value, so the two cannot disagree. A zone already in `meta.timezone`
    is the organizer's or the country's and stands."""
    if config_has_timezone(config):
        return ""
    zone = zone_from_config_coordinates(config)
    if not zone:
        return ""
    meta = config.get("meta")
    if not isinstance(meta, dict):
        meta = config["meta"] = {}
    meta["timezone"] = zone
    agent = config.get("agent")
    if isinstance(agent, dict):
        agent["timezone"] = zone
    return zone


def warn_if_unresolved(
    config: Mapping[str, Any], *, trip_id: str | None = None, destination: str | None = None,
) -> bool:
    """Log `timezone.unresolved` when the finished config has no usable zone.
    Returns whether it warned. The gap stays visible and is not guessed at: a
    trip on UTC looks complete and is an hour (or nine) off."""
    if config_has_timezone(config):
        return False
    meta = config.get("meta") if isinstance(config.get("meta"), Mapping) else {}
    logger.warning(
        "timezone.unresolved",
        extra={
            "trip_id": trip_id,
            "slug": meta.get("slug"),
            "destination": destination or meta.get("destination"),
            "mapped_phases": sum(
                1 for p in (config.get("phases") or [])
                if isinstance(p, Mapping) and isinstance(p.get("mapStop"), Mapping)
            ),
        },
    )
    return True
