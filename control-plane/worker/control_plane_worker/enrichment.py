"""Deterministic destination enrichment (onboarding-mvp-sprint-plan.md, Sprint 4.5).

Sits between transform_intake() and deploy: fills in the parts of a
trip.config.json that need an external lookup rather than a judgement call —
currency and emergency numbers for the destination country, map coordinates
for each phase, a hero photo per phase, per-phase map-app deep links plus the
weather-widget key (the site fetches the forecast itself, client-side), and
the top-level ``map`` object (centre + zoom + stops) the site's map tab needs
to open framed on the trip instead of on a world view. It is the "port, don't
design" half of Sprint 4.5; the AI phase-narrative/anchor-extraction half is
separate and still unscheduled.

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
import re
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
    place = _geocode_place(http, query)
    if not place:
        return None
    return place["lat"], place["lng"]


def _geocode_place(http: Http, query: str) -> dict[str, Any] | None:
    """Like _geocode but also returns Nominatim's `display_name` as `address`."""
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": query, "format": "jsonv2", "limit": "1"}
    )
    rows = http(url)
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        return None
    try:
        out: dict[str, Any] = {"lat": float(rows[0]["lat"]), "lng": float(rows[0]["lon"])}
    except (KeyError, TypeError, ValueError):
        return None
    display = str(rows[0].get("display_name") or "").strip()
    if display:
        out["address"] = display
    return out


def _accommodation_name(phase: dict[str, Any]) -> str:
    acc = phase.get("accommodation")
    if not isinstance(acc, dict):
        return ""
    name = acc.get("name_en") or acc.get("name")
    if isinstance(name, dict):
        name = name.get("en") or name.get("he")
    return str(name or "").strip()


def _hotel_queries(hotel: str, city_query: str):
    """Nominatim query variants for a hotel, most specific first. Long marketing
    names ("OMO3 Asakusa by Hoshino Resorts Tokyo") often miss where a trimmed
    one ("OMO3 Asakusa") hits."""
    hotel = hotel.strip()
    if not hotel:
        return
    seen: set[str] = set()
    trimmed = re.split(r"\s+(?:by|-|–|—|,)\s+", hotel, maxsplit=1)[0].strip()
    short = " ".join(hotel.split()[:3]).strip()
    for name in (hotel, trimmed, short):
        if name and name.lower() not in seen:
            seen.add(name.lower())
            yield f"{name}, {city_query}"


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

# (destination, home_country) -> [{"name": {"he","en"}, "phone"}] or None.
ConsularLookup = Callable[[str, str], Any]
# (destination, [venue name, ...]) -> {venue name (lower-cased): url} or None.
# Fills a venue's official/ticket URL from the cross-trip venue_links store when
# the interview-time search was rate-limited and a later drain resolved it.
VenueLookup = Callable[[str, list], Any]


def enrich_config(
    config: dict[str, Any],
    destination: str,
    *,
    http: Http | None = None,
    pause: float = 1.0,
    consular_lookup: ConsularLookup | None = None,
    venue_lookup: VenueLookup | None = None,
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

    try:
        _enrich_consular(out, destination, consular_lookup)
    except Exception:
        logger.warning("enrichment.consular_failed", exc_info=True)

    for phase in out.get("phases") or []:
        if not isinstance(phase, dict):
            continue
        label, lang = _phase_query(phase)
        if not label:
            continue
        city_query = f"{label}, {destination}".strip(", ")
        try:
            if "mapStop" not in phase:
                # Anchor the pin (and so the Maps/Waze links) on the hotel when
                # there is one — "where are we staying" is the question a phase
                # pin answers. Fall back to the city centre only if the hotel
                # doesn't resolve. Matches the hand-built trips.
                hotel = _accommodation_name(phase)
                place = None
                matched_hotel = False
                for hq in _hotel_queries(hotel, city_query):
                    place = _geocode_place(http, hq)
                    _sleep(pause)
                    if place:
                        matched_hotel = True
                        break
                if not place:
                    place = _geocode_place(http, city_query)
                    _sleep(pause)
                if place:
                    phase["mapStop"] = _map_stop(phase, (place["lat"], place["lng"]))
                    acc = phase.get("accommodation")
                    if matched_hotel and place.get("address") and isinstance(acc, dict):
                        acc.setdefault("address", place["address"])
        except Exception:
            logger.warning("enrichment.geocode_failed", extra={"phase": phase.get("id")}, exc_info=True)
        try:
            _add_phase_nav(phase, destination)
        except Exception:
            logger.warning("enrichment.nav_failed", extra={"phase": phase.get("id")}, exc_info=True)
        try:
            _enrich_venues(phase, label, destination, venue_lookup)
        except Exception:
            logger.warning("enrichment.venues_failed", extra={"phase": phase.get("id")}, exc_info=True)
        try:
            if "hero" not in phase:
                # A Hebrew-only phase title against en.wikipedia is a guaranteed
                # 404; query the wiki that matches the label's language.
                image = _wikipedia_image(http, label, lang=lang)
                if image:
                    # `cta` so the site renders its "View details" button rather
                    # than a bare one (an absent cta printed the literal word
                    # "undefined"). label/sub/blurb are marketing copy — left
                    # for a hand edit or a later content pass.
                    phase["hero"] = {
                        "photo": image,
                        "title": str(phase.get("tabLabel") or label).upper(),
                        "cta": {"he": "צפה בפרטים", "en": "View details"},
                    }
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


def _home_country(out: dict[str, Any]) -> str:
    """Whose embassy to look up. The intake's optional home_country answer,
    surfaced by the transformer at meta.home_country; Israel is the default
    (Hebrew-speaking organizers, one shared bot) until the landing-page account
    carries it per organizer."""
    meta = out.get("meta")
    if isinstance(meta, dict):
        value = str(meta.get("home_country") or "").strip()
        if value:
            return value
    return "Israel"


def _enrich_consular(
    out: dict[str, Any], destination: str, consular_lookup: "ConsularLookup | None",
) -> None:
    """Populate travel_info.emergency_contacts from the cross-trip
    country_reference store (via the injected reader). The generic country
    emergency numbers come from _enrich_country; this adds the named
    home-country embassy/consulate a traveler in trouble actually calls."""
    if consular_lookup is None or not destination or not destination.strip():
        return
    contacts = consular_lookup(destination.strip(), _home_country(out))
    if not isinstance(contacts, list) or not contacts:
        return
    cleaned: list[dict[str, Any]] = []
    for entry in contacts[:8]:
        if not isinstance(entry, dict):
            continue
        raw_name = entry.get("name")
        name = _bilingual_name(raw_name)
        phone = re.sub(r"[<>]", "", str(entry.get("phone") or "")).strip()
        if not name or not phone:
            continue
        cleaned.append({"name": name, "phone": phone})
    if not cleaned:
        return
    travel_info = out.setdefault("travel_info", {})
    if isinstance(travel_info, dict):
        travel_info["emergency_contacts"] = cleaned


def _bilingual_name(value: Any) -> dict[str, str] | None:
    if isinstance(value, dict):
        he = re.sub(r"[<>]", "", str(value.get("he") or "")).strip()
        en = re.sub(r"[<>]", "", str(value.get("en") or "")).strip()
    else:
        he = en = re.sub(r"[<>]", "", str(value or "")).strip()
    if not he and not en:
        return None
    return {"he": he or en, "en": en or he}


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


def _add_phase_nav(phase: dict[str, Any], destination: str = "") -> None:
    """Deep-link the phase to a map app and wire its weather widget.
    ``weatherKey`` is what lets the site's own client-side Open-Meteo call fire
    (site/app.js fetches the forecast live at render time — nothing is fetched
    here, so it is never stale). ``maps`` / ``waze`` search by the hotel *name*
    (Google/Waze resolve a name far better than OSM does, and coordinate
    templating on a shaky geocode drops the pin in the wrong district), falling
    back to the phase coordinates only when there is no name. All ``setdefault``
    — a hand-authored value always wins."""
    stop = phase.get("mapStop")
    key = str(phase.get("id") or "").strip()
    if isinstance(stop, dict) and key:
        stop.setdefault("weatherKey", key)
    acc = phase.get("accommodation")
    if not isinstance(acc, dict):
        return
    if key:
        acc.setdefault("weatherKey", key)
    hotel = _accommodation_name(phase)
    if hotel:
        # hotel name + city + country is the strongest Google/Waze query. NOT
        # acc["address"] — that is Nominatim's full display_name (street, ward,
        # postcode, 日本, …), which dilutes the search rather than sharpening it.
        query = ", ".join(p for p in (hotel, _phase_query(phase)[0], destination) if p)
        acc.setdefault("maps", _maps_search_url(query))
        acc.setdefault("waze", _waze_search_url(query))
    elif isinstance(stop, dict):
        try:
            lat, lng = float(stop["lat"]), float(stop["lng"])
            acc.setdefault("maps", _maps_url(lat, lng))
            acc.setdefault("waze", _waze_url(lat, lng))
        except (KeyError, TypeError, ValueError):
            pass


def _maps_url(lat: float, lng: float) -> str:
    return f"https://www.google.com/maps/search/?api=1&query={lat}%2C{lng}"


def _waze_url(lat: float, lng: float) -> str:
    return f"https://waze.com/ul?ll={lat}%2C{lng}&navigate=yes"


def _maps_search_url(query: str) -> str:
    return "https://www.google.com/maps/search/?api=1&query=" + urllib.parse.quote(query.strip())


def _waze_search_url(query: str) -> str:
    return "https://waze.com/ul?q=" + urllib.parse.quote(query.strip()) + "&navigate=yes"


def _enrich_venues(
    phase: dict[str, Any], label: str, destination: str,
    venue_lookup: "VenueLookup | None" = None,
) -> None:
    """Give each must-see venue a Google Maps + Waze link that searches by the
    venue *name* (reliable — no geocode needed). A venue's `url` (an official or
    ticket link) comes from the source document or the interview-time web
    search; where that was rate-limited, back-fill it here from the cross-trip
    venue_links store via the injected reader. `maps`/`waze`/`url` are all
    `setdefault` — a value already present wins."""
    venues = phase.get("venues")
    if not isinstance(venues, list):
        return

    def _venue_name(v: dict[str, Any]) -> str:
        n = v.get("name")
        if isinstance(n, dict):
            n = n.get("en") or n.get("he")
        return str(n or "").strip()

    resolved: dict[str, str] = {}
    if venue_lookup is not None and destination and destination.strip():
        wanted = [
            _venue_name(v) for v in venues
            if isinstance(v, dict) and not v.get("url") and _venue_name(v)
        ]
        if wanted:
            try:
                hit = venue_lookup(destination.strip(), wanted)
            except Exception:
                hit = None
            if isinstance(hit, dict):
                for k, val in hit.items():
                    url = str(val or "").strip()
                    if url.startswith("http"):
                        resolved[str(k).strip().lower()] = url

    for venue in venues:
        if not isinstance(venue, dict):
            continue
        name = _venue_name(venue)
        if not name:
            continue
        if not venue.get("url"):
            found = resolved.get(name.lower())
            if found:
                venue["url"] = found
        if "maps" in venue:
            continue
        query = ", ".join(p for p in (name, str(venue.get("area") or "").strip(), label, destination) if p)
        venue.setdefault("maps", _maps_search_url(query))
        venue.setdefault("waze", _waze_search_url(query))


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
