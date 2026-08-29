"""Deterministic destination enrichment (onboarding-mvp-sprint-plan.md, Sprint 4.5).

Sits between transform_intake() and deploy: fills in the parts of a
trip.config.json that need an external lookup rather than a judgement call —
currency and emergency numbers for the destination country, map coordinates
for each phase, a hero photo per phase, and the top-level ``map`` object
(centre + zoom + stops) the site's map tab needs to open framed on the trip
instead of on a world view. It is the "port, don't design" half of Sprint
4.5; the AI phase-narrative/anchor-extraction half is separate and still
unscheduled.

Two hard rules, both from the plan's own test list:

  * enrichment failure must never block a deploy — every lookup is wrapped, a
    miss just leaves that slice of the config as transform_intake() left it;
  * this module does not invent facts — a phase that will not geocode gets no
    mapStop, a country that will not resolve gets no travel_info, full stop.

Live sources, all keyless, matching scripts/country-info.js:
  countries.dev              name -> currency / calling code / capital / ISO
  emergencynumberapi.com     ISO  -> police / ambulance / fire
  nominatim.openstreetmap.org  free-text place -> lat / lon
  <lang>.wikipedia.org REST   page title -> lead image
"""
from __future__ import annotations

import copy
import json
import logging
import time
import urllib.parse
import urllib.request
from typing import Any, Callable

logger = logging.getLogger("control_plane_worker.enrichment")

# A callable that takes a URL and returns parsed JSON, or None for any
# non-success (bad status, timeout, unparseable body). Injected in tests.
Http = Callable[[str], Any]

_USER_AGENT = "kinerary-control-plane/1.0 (+https://ara-united.store)"
_TIMEOUT = 12


def _default_http(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode("utf-8"))
    except Exception:  # network error, HTTP error, decode error — all "no data"
        return None


# ── country data ─────────────────────────────────────────────────────────────

def _find_country(http: Http, query: str) -> dict | None:
    """countries.dev name lookup with the same disambiguation as country-info.js:
    exact match, else the shortest name among prefix matches, else the shortest
    match overall (sovereign states have shorter canonical names than the
    dependent territories that share their prefix)."""
    matches = http(f"https://countries.dev/name/{urllib.parse.quote(query)}")
    if not isinstance(matches, list) or not matches:
        return None
    q = query.strip().lower()
    exact = next((c for c in matches if str(c.get("name", "")).lower() == q), None)
    prefix = sorted(
        (c for c in matches if str(c.get("name", "")).lower().startswith(q)),
        key=lambda c: len(str(c.get("name", ""))),
    )
    return exact or (prefix[0] if prefix else min(matches, key=lambda c: len(str(c.get("name", "")))))


# emergencynumberapi.com — the source scripts/country-info.js used — stopped
# serving its API sometime before 2026-08 (the domain now hosts an unrelated
# personal site, every /api path 404s). Kept as a first try in case a mirror
# or replacement appears at the same shape; the static table below is what
# actually fills the Info tab today. Emergency numbers barely change, so a
# small hardcoded table is a legitimate stopgap here — the same call the
# transformer makes with _KNOWN_COUNTRY_CURRENCY.
_EU_112 = frozenset(
    "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split()
)
_EMERGENCY_BY_ISO: dict[str, dict[str, Any]] = {
    "US": {"general": "911"}, "CA": {"general": "911"},
    "GB": {"general": "999", "unified112": True},
    "IE": {"general": "999", "unified112": True},
    "AU": {"general": "000", "unified112": True}, "NZ": {"general": "111"},
    "IL": {"police": "100", "ambulance": "101", "fire": "102"},
    "JP": {"police": "110", "ambulance": "119", "fire": "119"},
    "CN": {"police": "110", "ambulance": "120", "fire": "119"},
    "IN": {"general": "112"}, "TH": {"general": "191", "ambulance": "1669"},
    "AE": {"police": "999", "ambulance": "998", "fire": "997"},
    "TR": {"general": "112"}, "CH": {"police": "117", "ambulance": "144", "fire": "118"},
    "MX": {"general": "911"}, "BR": {"police": "190", "ambulance": "192", "fire": "193"},
    "ZA": {"police": "10111", "ambulance": "10177"},
    "EG": {"police": "122", "ambulance": "123", "fire": "180"},
    "MA": {"police": "190", "ambulance": "150"},
}


def _static_emergency(alpha2: str) -> dict | None:
    code = alpha2.strip().upper()
    base = dict(_EMERGENCY_BY_ISO.get(code, {}))
    if code in _EU_112:
        base.setdefault("general", "112")
        base["unified112"] = True
    if not base:
        return None
    general = base.get("general")
    return {
        "police": base.get("police") or general,
        "ambulance": base.get("ambulance") or general,
        "fire": base.get("fire") or general,
        "general": general,
        "unified112": bool(base.get("unified112")) or code in _EU_112,
    }


def _emergency_numbers(http: Http, alpha2: str) -> dict | None:
    payload = http(f"https://emergencynumberapi.com/api/country/{urllib.parse.quote(alpha2)}")
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return _static_emergency(alpha2)

    def pick(svc: Any) -> str | None:
        if not isinstance(svc, dict):
            return None
        for key in ("all", "gsm", "fixed"):
            seq = svc.get(key)
            if isinstance(seq, list) and seq and str(seq[0]).strip():
                return str(seq[0]).strip()
        return None

    general = pick(data.get("dispatch"))
    live = {
        "police": pick(data.get("police")) or general,
        "ambulance": pick(data.get("ambulance")) or general,
        "fire": pick(data.get("fire")) or general,
        "general": general,
        "unified112": bool(data.get("member_112")),
    }
    return live if any(live[k] for k in ("police", "ambulance", "fire", "general")) else _static_emergency(alpha2)


def _country_entry(http: Http, destination: str) -> tuple[str, dict] | None:
    chosen = _find_country(http, destination)
    if not chosen:
        return None
    name = str(chosen.get("name") or "").strip()
    if not name:
        return None
    entry: dict[str, Any] = {}
    if chosen.get("flag"):
        entry["flag"] = chosen["flag"]
    if chosen.get("capital"):
        entry["capital"] = chosen["capital"]
    currencies = chosen.get("currencies")
    if isinstance(currencies, list) and currencies and isinstance(currencies[0], dict):
        cur = currencies[0]
        entry["currency"] = {
            "code": cur.get("code"),
            "name": cur.get("name"),
            "symbol": cur.get("symbol"),
        }
    codes = chosen.get("callingCodes")
    if isinstance(codes, list) and codes and str(codes[0]).strip():
        entry["callingCode"] = f"+{str(codes[0]).strip().lstrip('+')}"
    emergency = _emergency_numbers(http, str(chosen.get("alpha2Code") or "").strip())
    if emergency:
        entry["emergency"] = emergency
    return (name, entry) if entry else None


# ── geocoding ────────────────────────────────────────────────────────────────

def _geocode(http: Http, query: str) -> tuple[float, float] | None:
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": query, "format": "jsonv2", "limit": "1"}
    )
    rows = http(url)
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        return None
    try:
        return float(rows[0]["lat"]), float(rows[0]["lon"])
    except (KeyError, TypeError, ValueError):
        return None


# ── hero photo ───────────────────────────────────────────────────────────────

def _wikipedia_image(http: Http, title: str, lang: str = "en") -> str | None:
    url = f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{urllib.parse.quote(title)}"
    summary = http(url)
    if not isinstance(summary, dict):
        return None
    for key in ("originalimage", "thumbnail"):
        node = summary.get(key)
        if isinstance(node, dict) and node.get("source"):
            return str(node["source"])
    return None


# ── entry point ──────────────────────────────────────────────────────────────

def enrich_config(
    config: dict[str, Any],
    destination: str,
    *,
    http: Http | None = None,
    pause: float = 1.0,
) -> dict[str, Any]:
    """Return a copy of *config* with destination data, phase coordinates and
    phase hero photos filled in where a lookup succeeds. Never raises; a copy
    is always returned even if every lookup fails."""
    http = http or _default_http
    out = copy.deepcopy(config)

    try:
        _enrich_country(out, destination, http)
    except Exception:
        logger.warning("enrichment.country_failed", exc_info=True)

    for phase in out.get("phases") or []:
        if not isinstance(phase, dict):
            continue
        label, lang = _phase_query(phase)
        if not label:
            continue
        query = f"{label}, {destination}".strip(", ")
        try:
            if "mapStop" not in phase:
                coords = _geocode(http, query)
                if coords:
                    phase["mapStop"] = _map_stop(phase, coords)
                _sleep(pause)
        except Exception:
            logger.warning("enrichment.geocode_failed", extra={"phase": phase.get("id")}, exc_info=True)
        try:
            if "hero" not in phase:
                # A Hebrew-only phase title against en.wikipedia is a guaranteed
                # 404; query the wiki that matches the label's language.
                image = _wikipedia_image(http, label, lang=lang)
                if image:
                    phase["hero"] = {"photo": image, "title": str(phase.get("tabLabel") or label).upper()}
        except Exception:
            logger.warning("enrichment.hero_failed", extra={"phase": phase.get("id")}, exc_info=True)

    try:
        _build_map(out)
    except Exception:
        logger.warning("enrichment.map_failed", exc_info=True)

    return out


def _enrich_country(out: dict[str, Any], destination: str, http: Http) -> None:
    if not destination or not destination.strip():
        return
    result = _country_entry(http, destination.strip())
    if not result:
        return
    name, entry = result
    # A live hit is the single source of truth: drop the transformer's static
    # currency stub (which may sit under a slightly different name) so the Info
    # tab shows one country card, not two.
    out["travel_info"] = {"countries": {name: entry}}


def _phase_query(phase: dict[str, Any]) -> tuple[str, str]:
    """The best label to search a phase by, and the Wikipedia language edition
    that label belongs to. Prefer the English title (→ en.wikipedia); fall back
    to the Hebrew one (→ he.wikipedia) rather than sending Hebrew to en."""
    title = phase.get("title")
    if isinstance(title, dict):
        en = str(title.get("en") or "").strip()
        if en:
            return en, "en"
        he = str(title.get("he") or "").strip()
        if he:
            return he, "he"
    plain = str(title or phase.get("tabLabel") or "").strip()
    return plain, "en"


def _map_stop(phase: dict[str, Any], coords: tuple[float, float]) -> dict[str, Any]:
    lat, lng = coords
    stop: dict[str, Any] = {"lat": lat, "lng": lng}
    if isinstance(phase.get("title"), dict):
        stop["name"] = dict(phase["title"])
    dates = phase.get("dates")
    if isinstance(dates, dict) and dates.get("start") and dates.get("end"):
        stop["dates"] = f"{dates['start']}–{dates['end']}"
    acc = phase.get("accommodation")
    if isinstance(acc, dict) and acc.get("name"):
        stop["hotel"] = str(acc.get("name_en") or acc["name"])
        stop["conf"] = str(acc.get("confirmation") or "–")
    return stop


def _build_map(out: dict[str, Any]) -> None:
    """Assemble the top-level ``map`` object from the per-phase ``mapStop``s:
    a centre, a zoom that frames every stop, and the stop list itself. Without
    it the map tab opens on ``[30, 10]`` zoom 3 — a world view with the phase
    pins off-screen. A hand-authored ``map`` is left untouched."""
    if isinstance(out.get("map"), dict):
        return
    stops: list[dict[str, Any]] = []
    for phase in out.get("phases") or []:
        if not isinstance(phase, dict):
            continue
        raw = phase.get("mapStop")
        if not isinstance(raw, dict):
            continue
        try:
            lat, lng = float(raw["lat"]), float(raw["lng"])
        except (KeyError, TypeError, ValueError):
            continue
        stop = dict(raw)
        stop["lat"], stop["lng"] = lat, lng
        stop.setdefault("emoji", "📍")
        stops.append(stop)
    if not stops:
        return
    lats = [s["lat"] for s in stops]
    lngs = [s["lng"] for s in stops]
    center = [round(sum(lats) / len(lats), 4), round(sum(lngs) / len(lngs), 4)]
    span = max(max(lats) - min(lats), max(lngs) - min(lngs))
    out["map"] = {"center": center, "zoom": _zoom_for_span(span), "stops": stops}


def _zoom_for_span(span: float) -> int:
    """A Leaflet zoom level that keeps a bounding box *span* degrees wide in view."""
    for limit, zoom in ((0.5, 10), (1.5, 9), (3.0, 7), (6.0, 6), (12.0, 5), (30.0, 4)):
        if span <= limit:
            return zoom
    return 3


def _sleep(seconds: float) -> None:
    if seconds and seconds > 0:
        time.sleep(seconds)
