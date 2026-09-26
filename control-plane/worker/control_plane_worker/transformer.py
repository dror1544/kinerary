"""Intake transformer: converts confirmed intake answers into trip.config.json.

This is a pure function module with no I/O. The provisioner feeds it the
answers dict from intake_versions.data and gets back a dict ready to be
serialized as trip.config.json for the Kinerary trip site.

Intake question IDs (INTAKE_SCHEMA_VERSION = 2):
  trip_type      choice: family / group_of_families / couple / other
  destination    text: free-form location
  group_size     choice: 2 / 3_to_5 / 6_to_10 / more_than_10 / other — LEGACY.
                 Read only when no `travelers` roster is present; the headcount
                 stat is otherwise counted off that roster (see
                 _resolve_group_size), which is exact where this is a range.
  trip_duration  choice: weekend / week / two_weeks / month_or_more / other —
                 LEGACY, and only a fallback for an intake with no usable date
                 pair. Both date questions are required, so duration is
                 normally the difference between them.
  trip_interests text: optional free-form interests
  departure_date text: optional "YYYY-MM-DD" — precise departure, preferred
                 over the trip_duration placeholder logic when present
  return_date    text: optional "YYYY-MM-DD" — precise return
  timezone       text: optional, not yet projected into trip.config.json
  travelers      structured (array): [{name, name_en?, age?, family}, ...] —
                 populates participants[]/families[]
  phases         structured (array): [{name, name_en?, start, end,
                 accommodation?: {name, name_en?, confirmation?}}, ...] —
                 populates phases[] (logistics fields only; hero images, map
                 coordinates and day-by-day itineraries are a separate,
                 not-yet-built enrichment pass, not this transformer's job).
                 `name`/`name_en` are shortened to a light location/theme
                 label (see _shorten_phase_name) — the site displays this
                 text directly as a nav tab, so verbose organizer prose here
                 becomes an unreadable label, not just a cosmetic wart.
  travel_anchors structured (array): optional booked flights/hotels/cars;
                 folded into stats as a compact count, not yet a first-class
                 trip.config.json section
  constraints    structured (object): optional mobility/budget/family notes;
                 kept in intake_versions.data but deliberately NOT projected
                 into stats — see the comment in transform_intake for why

Schema v2 added the following, all optional. Every one of them is absent from
a v1 intake, and an intake that answers none of them must transform to exactly
the config it did before they existed — that equivalence is what lets one
release serve both schema versions (see migration 0018).

  trip_pace      choice: easygoing/balanced/intense — one standing instruction
  dietary        multi_choice: kosher/kosher_style/vegetarian/vegan/
                 lactose_free/gluten_free/nut_allergy
  dietary_scope  structured (object): option id -> "everyone" | [names]. Named
                 people get participants[].needs[] entries; anything group-wide
                 or unattributable becomes a standing instruction instead
  dietary_visibility choice: group/organizer — who may see those needs;
                 unanswered means group
  organizer_identity text: matched to a participant username for
                 agent.organizers; no match means no organizers key at all
  bot_name       text: assistant's display name; absent = no persona written
  bot_gender     choice: male/female/neutral (Hebrew verb conjugation)
  bot_tone       choice: warm/playful/dry
  bot_proactive  multi_choice: which unprompted messages it may send
  bot_limits     structured (array): [{he, en}] standing instructions
  planning_help  text: optional. What the organizer wants help planning AFTER
                 setup. Not acted on here — projected into
                 agent.standing_instructions[] so the trip companion picks it
                 up on its first turn rather than the ask being lost between
                 the two agents. Additive-optional; no schema bump.

Everything the v2 questions write into `agent.standing_instructions[]` carries
`visibility: "organizer"` — see _instruction() — except dietary entries, which
carry the organizer's own `dietary_visibility` choice, as participant needs do.

Hero `meta.brand`/`meta.title` are derived from destination + trip type + the
departure year (e.g. "USA 2026"), not a fixed value — the site renders
`meta.brand` as its main, prominent heading (see server/server.js and
site/app.js's applyBrandFromConfig()). `meta.homeCurrency` and
`travel_info.countries[*].currency` are a small static floor for the site's
currency-conversion feature — `enrichment` replaces them with a live
countries.dev hit when one resolves, and adds the Info tab's Health / Money /
Communication lists on top (issue #156); see _lookup_known_currency's docstring
for what this floor still covers on its own.
"""
from __future__ import annotations

import hashlib
import logging
import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
from typing import Any, Mapping, Sequence

from . import packing_climate

logger = logging.getLogger(__name__)

# Required question IDs that must be present in the intake data.
# `group_size` and `trip_duration` are deliberately NOT here: both are derived
# from questions the interview already requires — the traveler roster and the
# two date questions — rather than asked for separately (capture ledger, Step 3
# #3 and #4). Intakes confirmed before that change still carry both, and both
# resolvers still read them when present.
REQUIRED_QUESTIONS = frozenset({"trip_type", "destination"})

_TRIP_TYPE_LABELS: dict[str, str] = {
    "family": "Family",
    "group_of_families": "Group of Families",
    "couple": "Couple",
}

_GROUP_SIZE_LABELS: dict[str, str] = {
    "2": "2",
    "3_to_5": "3–5",
    "6_to_10": "6–10",
    "more_than_10": "10+",
}

_DURATION_DAYS: dict[str, int] = {
    "weekend": 3,
    "week": 7,
    "two_weeks": 14,
    "month_or_more": 30,
}


def _text_value(answer: Mapping[str, Any]) -> str:
    """Extract the display value from any answer variant."""
    kind = answer.get("kind")
    if kind == "choice":
        return str(answer.get("option_id", ""))
    if kind == "choice_other":
        return str(answer.get("other_text") or "")
    if kind == "text":
        return str(answer.get("text") or "")
    return ""


def _resolve_trip_type(answer: Mapping[str, Any]) -> str:
    if answer.get("kind") == "choice":
        return _TRIP_TYPE_LABELS.get(answer.get("option_id", ""), str(answer.get("option_id", "")))
    return str(answer.get("other_text") or "Trip")


def _resolve_group_size(data: Mapping[str, Any]) -> str:
    """Returns a short stat number for the group size, for the Hero strip.

    The roster wins when there is one. Asking "how many people?" as its own
    question was confusing to a real organizer (capture ledger, Step 3 #3) and
    it asks for something the interview already collects precisely: `travelers`
    is a required question listing each person. A count off that roster is both
    exact and impossible to contradict, where the separate question could
    disagree with the names actually given.

    A stored `group_size` answer is still honoured beneath it, because intakes
    confirmed before this change carry one and nothing rewrites a confirmed
    version. That path keeps its original behaviour: the option label for a
    choice answer, or the leading digit run from 'other' free text (e.g. "17"
    out of "17 total; 7 for some parts of the trip") rather than the whole
    organizer sentence — the Hero strip shows a number, not a quote.
    """
    travelers = _structured_list(data, "travelers")
    if travelers:
        return str(len(travelers))

    answer = data.get("group_size")
    if not answer:
        return "0"
    if answer.get("kind") == "choice":
        return _GROUP_SIZE_LABELS.get(answer.get("option_id", ""), str(answer.get("option_id", "")))
    text = str(answer.get("other_text") or "")
    match = re.search(r"\d+", text)
    return match.group() if match else text[:12]


def _resolve_duration_days(answer: Mapping[str, Any]) -> int:
    if answer.get("kind") == "choice":
        return _DURATION_DAYS.get(answer.get("option_id", ""), 7)
    # 'other' text: try to parse the first number from the free text.
    text = str(answer.get("other_text") or "")
    match = re.search(r"\d+", text)
    return int(match.group()) if match else 7


def _structured_list(data: Mapping[str, Any], question_id: str) -> list[Any]:
    """Extracts a "structured" answer's array payload, or [] if absent/wrong shape."""
    answer = data.get(question_id)
    if not answer or answer.get("kind") != "structured":
        return []
    payload = answer.get("data")
    return payload if isinstance(payload, list) else []


def _structured_dict(data: Mapping[str, Any], question_id: str) -> dict[str, Any]:
    """Extracts a "structured" answer's object payload, or {} if absent/wrong shape."""
    answer = data.get(question_id)
    if not answer or answer.get("kind") != "structured":
        return {}
    payload = answer.get("data")
    return payload if isinstance(payload, dict) else {}


def _multi_choice_ids(data: Mapping[str, Any], question_id: str) -> list[str]:
    """Extracts a "multi_choice" answer's selected option ids, or [] if absent.

    "none" is dropped here rather than at every call site: it is the organizer
    explicitly saying "I looked and none of these apply", which is a different
    conversation state from never having been asked, but produces the same
    empty config either way.
    """
    answer = data.get(question_id)
    if not answer or answer.get("kind") != "multi_choice":
        return []
    ids = answer.get("option_ids")
    if not isinstance(ids, list):
        return []
    return [str(i) for i in ids if isinstance(i, str) and i != "none"]


def _parse_iso_date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None


def _resolve_dates(data: Mapping[str, Any], today: date) -> tuple[date, date, int]:
    """Resolve (departure, return, total_days) from the intake.

    Precise dates from the interview take priority over the placeholder
    duration-based guess — older confirmed intakes (pre-dating those questions)
    fall back to the original 90-days-from-today logic.
    """
    explicit_departure = _parse_iso_date(_text_value(data.get("departure_date", {})))
    explicit_return = _parse_iso_date(_text_value(data.get("return_date", {})))
    if explicit_departure and explicit_return and explicit_return > explicit_departure:
        return (
            explicit_departure,
            explicit_return,
            (explicit_return - explicit_departure).days,
        )

    departure_date = today + timedelta(days=90)
    # `trip_duration` is a fallback for an intake that has no usable dates, and
    # is no longer a question every intake carries — both date questions are
    # required, so duration is normally derived above rather than asked for
    # (capture ledger, Step 3 #4). Absent it, _resolve_duration_days's own
    # default stands.
    total_days = _resolve_duration_days(data.get("trip_duration") or {})
    return departure_date, departure_date + timedelta(days=total_days), total_days


_FAMILY_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "", value.strip().lower())
    return slug or "traveler"


def _slug_words(value: str) -> str:
    """Lowercase into dash-separated alphanumeric segments.

    Distinct from _slugify, which strips separators entirely because usernames
    and phase ids have to be single tokens. Here the dashes are exactly what
    makes the slug readable in a URL.
    """
    return re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")


_PHASE_NAME_CUT_RE = re.compile(r"[(:;—,]| - ")


def _shorten_phase_name(name: str, max_length: int = 30) -> str:
    """Reduces a phase name to a light, location/theme-only label.

    Organizers (and the interviewer conducting the intake) often fold context
    into a phase name that belongs in conversation, not in a persisted label —
    "Dallas (boys; Mavericks game September 6)" instead of "Dallas". The site
    displays this text directly as a nav tab and section header, so anything
    past the first parenthetical/qualifier clause gets dropped rather than
    shown verbatim. A hard length cap is the last-resort backstop for
    anything that slips through without one of those delimiters.
    """
    cut = _PHASE_NAME_CUT_RE.search(name)
    short = name[: cut.start()] if cut else name
    short = short.strip(" ,.-")
    if len(short) > max_length:
        truncated = short[:max_length].rsplit(" ", 1)[0]
        short = (truncated or short[:max_length]).rstrip(" ,.-")
    return short or name.strip()


_KNOWN_COUNTRY_CURRENCY: dict[str, dict[str, str]] = {
    "usa": {"country": "United States", "code": "USD", "symbol": "$", "currency_name": "US Dollar"},
    "us": {"country": "United States", "code": "USD", "symbol": "$", "currency_name": "US Dollar"},
    "united states": {"country": "United States", "code": "USD", "symbol": "$", "currency_name": "US Dollar"},
    "america": {"country": "United States", "code": "USD", "symbol": "$", "currency_name": "US Dollar"},
    "japan": {"country": "Japan", "code": "JPY", "symbol": "¥", "currency_name": "Japanese Yen"},
    "vietnam": {"country": "Vietnam", "code": "VND", "symbol": "₫", "currency_name": "Vietnamese Dong"},
    "italy": {"country": "Italy", "code": "EUR", "symbol": "€", "currency_name": "Euro"},
    "france": {"country": "France", "code": "EUR", "symbol": "€", "currency_name": "Euro"},
    "spain": {"country": "Spain", "code": "EUR", "symbol": "€", "currency_name": "Euro"},
    "greece": {"country": "Greece", "code": "EUR", "symbol": "€", "currency_name": "Euro"},
    "portugal": {"country": "Portugal", "code": "EUR", "symbol": "€", "currency_name": "Euro"},
    "germany": {"country": "Germany", "code": "EUR", "symbol": "€", "currency_name": "Euro"},
    "uk": {"country": "United Kingdom", "code": "GBP", "symbol": "£", "currency_name": "British Pound"},
    "united kingdom": {"country": "United Kingdom", "code": "GBP", "symbol": "£", "currency_name": "British Pound"},
    "england": {"country": "United Kingdom", "code": "GBP", "symbol": "£", "currency_name": "British Pound"},
    "thailand": {"country": "Thailand", "code": "THB", "symbol": "฿", "currency_name": "Thai Baht"},
}


# The zone the trip is IN, keyed the same way as the currency map above and
# deliberately sharing its country vocabulary — one destination, two facts.
#
# The interview asks for a timezone as free text, and an organizer who has not
# been to the country cannot answer it: on 2026-09-20 the answer was the string
# "Vietnam", which reached the config as `agent.timezone` and left a 07:30
# briefing scheduled in a zone no clock resolves. Deriving beats asking, so the
# typed answer is now only accepted when it is a real zone.
#
# A country spanning several zones is given the one its capital keeps, which is
# where a trip's own clock realistically sits; anything genuinely ambiguous is
# better left absent than guessed.
_KNOWN_COUNTRY_TIMEZONE: dict[str, str] = {
    "usa": "America/New_York",
    "us": "America/New_York",
    "united states": "America/New_York",
    "america": "America/New_York",
    "japan": "Asia/Tokyo",
    "vietnam": "Asia/Ho_Chi_Minh",
    "italy": "Europe/Rome",
    "france": "Europe/Paris",
    "spain": "Europe/Madrid",
    "greece": "Europe/Athens",
    "portugal": "Europe/Lisbon",
    "germany": "Europe/Berlin",
    "uk": "Europe/London",
    "united kingdom": "Europe/London",
    "england": "Europe/London",
    "thailand": "Asia/Bangkok",
    "israel": "Asia/Jerusalem",
}


# The destination as the ORGANIZER wrote it, mapped to the one key the tables
# above are written in.
#
# Both tables key on English country names, and the interview stores the
# destination in whatever language it was typed. Which language that is depends
# on whether the interpreter happened to normalise it: on 2026-09-20 the same
# scenario produced "Vietnam" on one run and "וייטנאם" on the next. The Hebrew
# run lost BOTH facts — `travel_info` came out null, so the site's currency
# card and its conversion feature were simply absent, and `agent.timezone` was
# empty. Neither failure says anything; they are missing fields on a site that
# otherwise looks complete.
#
# A Hebrew interview is the normal case here, so this is not an edge.
_COUNTRY_ALIASES: dict[str, str] = {
    "ארצות הברית": "usa", "ארהב": "usa", "אמריקה": "usa",
    "יפן": "japan",
    "וייטנאם": "vietnam", "ויאטנם": "vietnam", "ויטנאם": "vietnam",
    "איטליה": "italy",
    "צרפת": "france",
    "ספרד": "spain",
    "יוון": "greece",
    "פורטוגל": "portugal",
    "גרמניה": "germany",
    "אנגליה": "uk", "בריטניה": "uk", "אנגליה ובריטניה": "uk",
    "תאילנד": "thailand",
    "ישראל": "israel",
    # The hemisphere-only spellings that used to follow (Australia, Chile,
    # Peru, ...) moved with the climate lookup to `packing_climate`, which
    # keeps its own Hebrew names; tests/test_packing_climate.py holds every
    # entry here to resolve there to the same country, so the two cannot
    # drift apart silently.
}


def _country_keys(destination: str) -> list[str]:
    """Every key worth trying for a destination, best first.

    Deliberately shared by the currency and timezone lookups: they answer two
    questions about one place, and a destination either resolves for both or
    for neither. Keeping two spellings tables in step by hand is how one of
    them silently stops matching."""
    raw = (destination or "").strip()
    tail = [part.strip() for part in raw.split(",") if part.strip()]
    candidates = [raw, _destination_head(raw), tail[-1] if tail else ""]
    keys: list[str] = []
    for candidate in candidates:
        lowered = candidate.strip().lower()
        if not lowered:
            continue
        for key in (lowered, _COUNTRY_ALIASES.get(lowered.replace('"', "").replace("'", ""), "")):
            if key and key not in keys:
                keys.append(key)
    return keys


def _is_iana_timezone(value: str) -> bool:
    """Whether something can actually be used as a clock."""
    candidate = (value or "").strip()
    if not candidate:
        return False
    try:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        ZoneInfo(candidate)
        return True
    except (ImportError, ZoneInfoNotFoundError, ValueError):
        return False


def _resolve_timezone(typed: str, destination: str) -> str:
    """The trip's zone: what the organizer typed if it is one, else derived
    from the destination, else nothing.

    Returning "" rather than the unusable text is the point. A field that is
    absent is a gap something can notice; a field holding "Vietnam" looks
    answered and is read as a zone by everything downstream.
    """
    typed = (typed or "").strip()
    if _is_iana_timezone(typed):
        return typed
    for key in _country_keys(destination):
        zone = _KNOWN_COUNTRY_TIMEZONE.get(key)
        if zone:
            return zone
    return ""


def _has_confirmation(anchor: Any) -> bool:
    """Whether a travel_anchor carries actual evidence of a booking.

    Placeholders count as absent. A site that renders "–" for a missing
    confirmation must not also count that anchor as confirmed — the two were
    reading the same data and disagreeing on one page.
    """
    if not isinstance(anchor, Mapping):
        return False
    value = str(anchor.get("confirmation") or "").strip()
    return bool(value) and value.lower() not in {"-", "\u2013", "\u2014", "none", "n/a", "tbd", "-"}


def _lookup_known_currency(destination: str) -> dict[str, str] | None:
    """Static country-name -> currency lookup for well-known destinations.

    A pre-enrichment floor, not the whole story. The destination-info pass
    scoped in
    `.hermes/plans/2026-08-06_063428-post-interview-enrichment-and-provisioning.md`
    now EXISTS (issue #156): `enrichment._enrich_country` replaces this stub
    with a live countries.dev hit whenever one resolves, and
    `enrichment._enrich_destination_info` adds the Info tab's Health / Money /
    Communication lists. Hospitals were dropped from that scope deliberately
    (Dror, 2026-09-19) and are not coming — a wrong hospital name is worse than
    no hospital name, and the emergency numbers are real.

    This lookup still runs, and still matters, because it is the only source
    reached when enrichment is disabled or countries.dev does not resolve the
    destination: without it the site's currency-conversion feature
    (server/server.js's HOME_CURRENCY/destinationCurrencyCodes, gated on
    travel_info.countries) is unconditionally broken for that trip. It is also
    what `_api_info_lines` reads in that case, so a fallback trip still gets its
    Money line.
    """
    for key in _country_keys(destination):
        found = _KNOWN_COUNTRY_CURRENCY.get(key)
        if found:
            return found
    return None


_MULTI_PLACE_RE = re.compile(r",|&| and |/")
# Only a heading separator: commas and "and" join places, they do not introduce details.
_DESTINATION_HEAD_RE = re.compile(r"[—–:]| - ")


def _destination_head(destination: str) -> str:
    """The place a destination leads with — "Portugal" from "Portugal — Lisbon and Porto" — or the whole text."""
    head = _DESTINATION_HEAD_RE.split(destination, maxsplit=1)[0].strip()
    return head or destination.strip()


def _destination_country(destination: str, phase_names: "Sequence[str]") -> str:
    """The country a destination TRAILS with — "Japan" from "Tokyo, Hakone,
    Kyoto, Osaka, Japan".

    `_destination_head` reads the other shape, "Portugal — Lisbon and Porto",
    where the country leads. Both occur, and the trailing one is what the
    interview actually produces: it normalises a spoken destination into a list
    of stops with the country last. A real trip on 2026-09-19 stored
    "Tokyo, Hakone, Kyoto, Osaka, Japan", was read as a plain city list, and
    was titled "Family Trip 2027" with the country nowhere.

    It has to be RECOGNISED as a country, not merely trailing. "Rome,
    Florence, Venice" has the same shape and ends in a city; naming that trip
    "Venice" is worse than the generic fallback. An earlier attempt here used
    "not one of the phases" as the test, which named a trip OSAKA 2026 as soon
    as the phases did not happen to list every city the destination mentions —
    caught by two existing tests, and the reason this asks a country list
    instead.

    That list is the same fifteen-entry stopgap `_lookup_known_currency` uses,
    so this inherits its limit: an unlisted country falls back to the trip
    type rather than being named. Being wrong about which places are countries
    is worse than being incomplete, and the real answer is the enrichment
    pass, which resolves countries properly and runs after this.
    """
    parts = [p.strip() for p in _MULTI_PLACE_RE.split(destination) if p.strip()]
    if len(parts) < 2:
        return ""
    trailing = parts[-1]
    known_phases = {str(n).strip().casefold() for n in phase_names if str(n or "").strip()}
    if trailing.casefold() in known_phases:
        return ""  # it is one of the stops, so it is not the country
    return trailing if trailing.strip().lower() in _KNOWN_COUNTRY_CURRENCY else ""




def _derive_brand_and_title(
    destination: str, trip_type_label: str, year: int, phase_names: "Sequence[str]" = (),
) -> tuple[str, str]:
    """Derives a short Hero brand ("USA 2026") and a longer title ("USA 2026 —
    Group of Families") from the destination and trip type.

    A single, short destination becomes the brand subject directly. A
    destination that reads as multiple places (joined with a comma, "&", "/",
    or "and"), or is just long, falls back to the trip type as a thematic
    subject instead ("Family Trip 2026"), since a list of cities makes an
    unreadable brand. A destination that leads with one place before a dash
    or colon ("Portugal — Lisbon and Porto") is judged by that place alone.
    """
    place = _destination_head(destination)
    is_multi_place = bool(_MULTI_PLACE_RE.search(place))
    short_destination = _shorten_phase_name(place, max_length=20)
    trailing = _destination_country(destination, phase_names)
    short_trailing = _shorten_phase_name(trailing, max_length=20) if trailing else ""
    if not is_multi_place and short_destination == place and short_destination:
        subject = short_destination
    elif trailing and short_trailing == trailing:
        # A list of stops that ends with its country is named by the country.
        subject = trailing
    else:
        subject = trip_type_label if "trip" in trip_type_label.lower() else f"{trip_type_label} Trip"
    brand = f"{subject} {year}".upper()
    title = f"{subject} {year} — {trip_type_label}"
    return brand, title


def intake_destination(data: Mapping[str, Any]) -> str:
    """The organizer's raw destination answer, e.g. "Japan" or "Tokyo, Kyoto &
    Osaka". Empty string if unanswered. The enrichment pass needs this and the
    transformed config doesn't keep it verbatim."""
    return _text_value(data.get("destination", {})).strip()


def derive_trip_slug(data: Mapping[str, Any], today: date | None = None) -> str:
    """Derive a human-readable trip slug from the confirmed intake.

    The control plane assigns `draft-<signup-request-id>` when the organizer
    approves signup — before the interview has revealed where or when the trip
    is. Once the intake is confirmed this produces the slug the family actually
    sees in their URL: `japan-2026`, not `draft-sreq-acbfb02b84e46cd5...`.

    The result always satisfies the trips.slug CHECK constraint
    (^[a-z0-9]+(-[a-z0-9]+)*$). Uniqueness is the caller's responsibility.
    """
    today = today or date.today()
    departure_date, _, _ = _resolve_dates(data, today)

    destination = _slug_words(_text_value(data.get("destination", {})))
    if len(destination) > 40:
        destination = destination[:40].rstrip("-")
    if not destination:
        # A destination written entirely in non-latin script slugifies to
        # nothing. Before falling back to a generic word, try the phase names:
        # a trip whose destination is "יפן" usually still has a phase called
        # "Tokyo", and "tokyo-2026" is a URL the family recognises where
        # "trip-2026" is one they cannot tell from anyone else's (capture
        # ledger, General #4). Phases are checked in order and the first one
        # that slugifies to anything wins.
        for phase in _structured_list(data, "phases"):
            if not isinstance(phase, Mapping):
                continue
            for key in ("name_en", "name"):
                candidate = _slug_words(str(phase.get(key) or ""))
                if candidate:
                    destination = candidate[:40].rstrip("-")
                    break
            if destination:
                break

    if not destination:
        # Nothing latin anywhere in the intake; the year still distinguishes
        # it and the caller de-duplicates.
        destination = "trip"

    return f"{destination}-{departure_date.year}"


def _derive_participants_and_families(travelers: list[Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Turns the travelers[] intake answer into trip.config.json's
    participants[]/families[] shape. Colors cycle per family (not per
    person), matching how the site's real configs assign them; family
    letters are assigned in first-seen order rather than guessed at
    alphabetization, since that's locale-specific and not this transformer's
    job to get right.
    """
    palette = ["#3B82F6", "#8B5CF6", "#10B981", "#F59E0B", "#EF4444", "#06B6D4"]
    participants: list[dict[str, Any]] = []
    families_by_key: dict[str, dict[str, Any]] = {}
    used_usernames: set[str] = set()

    for index, raw in enumerate(travelers):
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not name:
            continue
        name_en = str(raw.get("name_en") or name).strip()
        # family_en mirrors name_en. Without it a Hebrew-only household name
        # slugified to nothing (so the family id fell back to the literal
        # "traveler") and its English label was the Hebrew string.
        family_raw = str(raw.get("family") or "traveler")
        family_en = str(raw.get("family_en") or family_raw).strip()
        family_key = _slugify(family_en)

        username = _slugify(name_en or name)
        if username in used_usernames:
            username = f"{username}{index}"
        used_usernames.add(username)

        if family_key not in families_by_key:
            letter = _FAMILY_LETTERS[len(families_by_key) % len(_FAMILY_LETTERS)]
            color = palette[len(families_by_key) % len(palette)]
            families_by_key[family_key] = {
                "id": family_key,
                "letter": letter,
                "name": {"he": family_raw, "en": family_en},
                "members": [],
                "phases": "all",
                "_color": color,
            }
        family = families_by_key[family_key]
        family["members"].append(username)

        participant: dict[str, Any] = {
            "username": username,
            "name": name,
            "name_en": name_en,
            "family": family_key,
            "color": family["_color"],
        }
        age = raw.get("age")
        if isinstance(age, (int, float)):
            participant["age"] = int(age)
        participants.append(participant)

    families = []
    for family in families_by_key.values():
        family = dict(family)
        family.pop("_color", None)
        families.append(family)

    return participants, families


# Bilingual copy for the fixed-option answers. The interview deliberately
# offers no free-text "other" on these questions precisely so this table can
# exist: needs[].text and standing_instructions[].text are {he,en} in
# trip.config.json, and organizer free text would only ever be one language.
#
# Severity is 'firm', not 'preference', for every dietary option: the menu only
# lists real restrictions (nobody taps "kosher" to mean "would rather"), and
# the failure directions are not symmetric — an over-firm reading books a
# restaurant more carefully than needed, an under-firm one hands someone food
# they can't eat.
_DIETARY_NEEDS: dict[str, tuple[str, str, dict[str, str]]] = {
    "kosher": ("dietary", "firm", {"he": "שומר/ת כשרות", "en": "Keeps kosher"}),
    "kosher_style": ("dietary", "firm", {
        "he": "לא אוכל/ת חזיר ופירות ים; בשר ועוף רגילים בסדר",
        "en": "No pork or shellfish; regular beef and chicken is fine",
    }),
    "vegetarian": ("dietary", "firm", {"he": "צמחוני/ת", "en": "Vegetarian"}),
    "vegan": ("dietary", "firm", {"he": "טבעוני/ת", "en": "Vegan"}),
    "lactose_free": ("dietary", "firm", {"he": "אי-סבילות ללקטוז", "en": "Lactose intolerant"}),
    "gluten_free": ("dietary", "firm", {"he": "ללא גלוטן / צליאק", "en": "Gluten-free / celiac"}),
    # An allergy, not a preference — and 'allergy' is what makes
    # shared/needs-schema.js default it to organizer-only visibility.
    "nut_allergy": ("allergy", "critical", {"he": "אלרגיה לאגוזים", "en": "Nut allergy"}),
}

_PACE_TEXT: dict[str, dict[str, str]] = {
    "easygoing": {
        "he": "קצב רגוע — התחלות מאוחרות, מעט פעילויות ביום",
        "en": "Easygoing pace — late starts, few activities a day",
    },
    "balanced": {
        "he": "קצב מאוזן — פעילות מרכזית אחת ביום, עם מקום לספונטניות",
        "en": "Balanced pace — one main plan a day, with room to drift",
    },
    "intense": {
        "he": "קצב אינטנסיבי — התחלות מוקדמות, יום עמוס",
        "en": "Intense pace — early starts, a packed day",
    },
}

# Times are local to the trip's timezone (travellers' morning, not the
# server's). Asked as on/off taps rather than a clock, so the defaults live
# here — a bot that talks too much gets muted in week one.
_PROACTIVE_VALUES: dict[str, Any] = {
    "morning_briefing": "07:30",
    "tomorrow_preview": "21:00",
    "photo_recap": "21:00",
    "flight_changes": True,
    "packing_reminders": True,
}

_AGENT_GENDERS = frozenset({"male", "female", "neutral"})


# An organizer whose group writes in two languages types both names into the
# one field they are given — "בוטסאן / botsan" is a real answer from japan-2026.
# Splitting them matters beyond tidiness: `name` and `name_en` are what a
# bilingual group's wake-words are built from, and a field holding BOTH names at
# once matches neither when someone types just one of them.
_BILINGUAL_SEPARATORS = ("/", "|", "־", "-", ",")


def _is_hebrew(text: str) -> bool:
    """True when the string carries Hebrew letters. Script detection, not a
    language guess — the Hebrew block is unambiguous."""
    return any("\u0590" <= ch <= "\u05ff" for ch in text)


def _is_latin(text: str) -> bool:
    return any(("a" <= ch <= "z") or ("A" <= ch <= "Z") for ch in text)


def split_bilingual_name(raw: str) -> tuple[str, str]:
    """Splits a single free-text assistant name into (name, name_en).

    Returns the same string twice when there is only one name to find — a
    Hebrew-only or Latin-only answer is not a pair, and inventing a
    transliteration for the missing half would put a name in front of the
    group that the organizer never chose.

    Only splits when the two sides are in DIFFERENT scripts. That is what makes
    it safe on a name that merely contains a separator: "Jean-Luc" is one Latin
    name on both sides of its hyphen, so it stays whole.
    """
    text = (raw or "").strip()
    if not text:
        return "", ""

    for sep in _BILINGUAL_SEPARATORS:
        if sep not in text:
            continue
        parts = [part.strip() for part in text.split(sep) if part.strip()]
        if len(parts) != 2:
            continue
        first, second = parts
        if _is_hebrew(first) and _is_latin(second) and not _is_hebrew(second):
            return first, second
        if _is_latin(first) and not _is_hebrew(first) and _is_hebrew(second):
            return second, first

    return text, text
_AGENT_TONES = frozenset({"warm", "playful", "dry"})


def _instruction(text: dict[str, str], visibility: str = "organizer") -> dict[str, Any]:
    """Wraps bilingual text as a standing instruction.

    Organizer-only unless the caller carries the organizer's own sharing
    choice (dietary). Nobody judges field by field which instructions look
    harmless enough to publish: an over-hidden one is a slightly less chatty
    bot, an over-shared one puts a private fact on an endpoint every logged-in
    member (children included) can read. The bot acts on organizer-only
    material either way.
    """
    return {"visibility": visibility, "text": text}


def _dietary_visibility(data: Mapping[str, Any]) -> str:
    """The organizer's sharing choice for dietary and allergy needs; unanswered means shared."""
    answer = data.get("dietary_visibility")
    if not isinstance(answer, Mapping):
        return "group"
    choice = _text_value(answer)
    # An unrecognized answer fails safe, like shared/needs-schema.js.
    return choice if choice in ("group", "organizer") else "organizer"


def _apply_dietary(
    data: Mapping[str, Any],
    participants: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Attaches dietary/allergy needs to the named participants and returns the
    standing instructions for anything that applies group-wide.

    `dietary_scope` maps each ticked option id to either "everyone" or a list of
    traveler names. A whole-group restriction becomes one instruction rather
    than the same need copied onto every participant, which would be noise in
    the config and in the bot's brief alike.
    """
    selected = _multi_choice_ids(data, "dietary")
    if not selected:
        return []

    visibility = _dietary_visibility(data)
    scope = _structured_dict(data, "dietary_scope")
    # The same forms organizer_identity accepts, first name included; a name two travellers share matches nobody.
    forms = [(p, _identity_forms(p)) for p in participants]

    instructions: list[dict[str, Any]] = []
    for option_id in selected:
        mapped = _DIETARY_NEEDS.get(option_id)
        if mapped is None:
            continue
        need_type, severity, text = mapped
        who = scope.get(option_id)

        names = who if isinstance(who, list) else []
        matched: list[dict[str, Any]] = []
        for name in names:
            needle = _normalize_identity(name)
            hits = [p for p, person_forms in forms if needle in person_forms]
            if len(hits) == 1 and hits[0] not in matched:
                matched.append(hits[0])

        # Everything that isn't a resolvable list of people becomes a
        # group-wide instruction: an explicit "everyone", and equally an
        # option the organizer ticked but never scoped, or scoped to a name
        # that isn't on the roster. Silently dropping the unattributable case
        # would lose a nut allergy because a nickname didn't match.
        if not matched:
            prefix_he, prefix_en = ("כל הנוסעים", "Everyone travelling") if who == "everyone" else ("בקבוצה", "In the group")
            instructions.append(_instruction({
                "he": f"{prefix_he}: {text['he']}",
                "en": f"{prefix_en}: {text['en']}",
            }, visibility))
            continue

        for participant in matched:
            participant.setdefault("needs", []).append({
                "type": need_type,
                "severity": severity,
                "visibility": visibility,
                "text": dict(text),
            })

    return instructions


def _normalize_identity(value: Any) -> str:
    """Casefolded, whitespace-collapsed form used to compare stated names.

    Internal whitespace is collapsed rather than merely stripped so "רון
    מרגולין" and "רון  מרגולין" are the same needle. A name is typed by a
    person, once, into a chat.
    """
    return " ".join(str(value or "").split()).casefold()


def _identity_forms(
    participant: Mapping[str, Any], *aliases: Mapping[str, Any], include_username: bool = True,
) -> set[str]:
    """Every way an organizer might write THIS participant's own name.

    `aliases` carries the raw intake traveler entry for the same person, and
    is not optional decoration: `_build_participants` SLUGIFIES `family`
    ("מרגולין" becomes "margolin") and drops `family_en` altogether, so by the
    time a participant exists the roster no longer holds the household label
    in the form the organizer actually typed. Matching the transformed
    participant alone finds "רון margolin" and misses "רון מרגולין" — which is
    the same bug in a second dimension, found while fixing the first.

    Deliberately excludes the bare family/household label: "מרגולין" names a
    household of five, not a person, and matching it would pick whichever of
    them the roster happened to list first — precisely the silent
    wrong-person failure `_resolve_organizers` exists to avoid.
    """
    sources = (participant, *aliases)
    names = {_normalize_identity(src.get("name")) for src in sources}
    names |= {_normalize_identity(src.get("name_en")) for src in sources}
    families = {_normalize_identity(src.get("family")) for src in sources}
    families |= {_normalize_identity(src.get("family_en")) for src in sources}
    names.discard("")
    families.discard("")

    forms = set(names)
    # A username is derived from a name, never typed by anyone, so the
    # sound-alike fallback leaves it out and compares names only.
    if include_username:
        forms.add(_normalize_identity(participant.get("username")))
    # Every given-name form against every household form, which covers the
    # mixed-script rosters that happen in practice — a Hebrew given name whose
    # household label was only ever transliterated, or the reverse.
    forms |= {f"{n} {f}" for n in names for f in families}
    # The GIVEN NAME on its own, taken as the first token of any multi-part
    # name. Run 14, live: the organizer answered "ניר" and matched nothing,
    # while "Nir" would have matched — not because English is privileged, but
    # because `name_en` happens to hold only the given name while `name` holds
    # the full one. The organizer answered with their own first name, in the
    # language the entire interview was conducted in, and the companion was
    # never built.
    #
    # Safe to add precisely because ambiguity already fails closed: two
    # travellers sharing a given name resolve to nobody rather than to whoever
    # the roster lists first, which is the guarantee `_resolve_organizers`
    # exists to keep. This widens what can match, never what happens when more
    # than one does.
    forms |= {n.split(" ", 1)[0] for n in names if " " in n}
    forms.discard("")
    return forms


#: How a name SOUNDS, as consonants, so one name written in Hebrew and in
#: English letters can be recognised as the same name. 2026-09-15, live: every
#: roster name was entered in English letters, the organizer answered "which of
#: the travellers are you?" with their own name in Hebrew, nothing matched, and
#: the trip provisioned without a companion.
#:
#: A FALLBACK, never the first reading: `_resolve_organizers` tries it only when
#: nothing matched as written, only across alphabets, and a sound-alike that
#: names two travellers still names nobody. The interview asks with roster
#: buttons; this is for answers that arrived as text anyway.
#:
#: The same rules live in control-plane/api/src/organizer-identity.ts, and both
#: are held to control-plane/contracts/v1/name-matching-cases.json.
_HEBREW_SOUNDS: dict[str, tuple[str, ...]] = {
    "א": ("",), "ע": ("",), "י": ("",), "ו": ("", "b"),
    "ה": ("k",), "ח": ("k",), "כ": ("k",), "ך": ("k",), "ק": ("k",),
    "ב": ("b",), "ג": ("g",), "ד": ("d",), "ז": ("z",), "ט": ("t",), "ת": ("t",),
    "ל": ("l",), "מ": ("m",), "ם": ("m",), "נ": ("n",), "ן": ("n",), "ס": ("s",),
    "ש": ("S", "s"), "צ": ("C", "z"), "ץ": ("C", "z"), "פ": ("p", "f"), "ף": ("f",), "ר": ("r",),
}
_LATIN_DIGRAPHS = {"sh": "S", "ch": "k", "kh": "k", "tz": "C", "ts": "C", "th": "t", "ph": "f"}
_LATIN_SOUNDS = {
    **{letter: "" for letter in "aeiouyj"},
    "b": "b", "v": "b", "w": "b", "c": "k", "k": "k", "q": "k", "h": "k", "x": "ks",
    **{letter: letter for letter in "dfglmnprstz"},
}
#: One consonant ("Noa", "Ella", "Shai") cannot tell people apart; those are
#: exactly the names the roster buttons are for.
_MIN_SKELETON_CONSONANTS = 2
_SKELETON_VARIANT_CAP = 64
_HEBREW_LETTER = re.compile(r"[\u05d0-\u05ea]")
_LATIN_LETTER = re.compile(r"[a-z]")


def _alphabet(text: str) -> str | None:
    hebrew, latin = bool(_HEBREW_LETTER.search(text)), bool(_LATIN_LETTER.search(text))
    if hebrew and not latin:
        return "he"
    if latin and not hebrew:
        return "latin"
    return None


def _collapse_repeats(skeleton: str) -> str:
    out: list[str] = []
    for ch in skeleton:
        if not out or out[-1] != ch:
            out.append(ch)
    return "".join(out)


def _capped(variants: set[str]) -> set[str]:
    return variants if len(variants) <= _SKELETON_VARIANT_CAP else set(sorted(variants)[:_SKELETON_VARIANT_CAP])


def _hebrew_word_skeletons(word: str) -> set[str]:
    letters = [ch for ch in word if ch in _HEBREW_SOUNDS]
    variants = {""}
    for i, ch in enumerate(letters):
        # A word-final ה is a vowel ("נועה", "שרה"), not a consonant.
        sounds = ("",) if ch == "ה" and i == len(letters) - 1 else _HEBREW_SOUNDS[ch]
        variants = _capped({v + sound for v in variants for sound in sounds})
    return {_collapse_repeats(v) for v in variants}


def _latin_word_skeleton(word: str) -> str:
    letters = "".join(ch for ch in unicodedata.normalize("NFKD", word) if "a" <= ch <= "z")
    if len(letters) > 1 and letters.endswith("h"):
        letters = letters[:-1]  # "Sarah", "Noah": a silent final h
    out: list[str] = []
    i = 0
    while i < len(letters):
        pair = letters[i:i + 2]
        if pair in _LATIN_DIGRAPHS:
            out.append(_LATIN_DIGRAPHS[pair])
            i += 2
            continue
        out.append(_LATIN_SOUNDS.get(letters[i], ""))
        i += 1
    return _collapse_repeats("".join(out))


def _name_skeletons(name: str) -> set[str]:
    text = _normalize_identity(name)
    alphabet = _alphabet(text)
    if alphabet is None:
        return set()
    per_word = [
        _hebrew_word_skeletons(word) if alphabet == "he" else {_latin_word_skeleton(word)}
        for word in text.split(" ")
    ]
    combos = {""}
    for options in per_word:
        combos = _capped({" ".join(part for part in (combo, option) if part) for combo in combos for option in options})
    return {c for c in combos if len(c.replace(" ", "")) >= _MIN_SKELETON_CONSONANTS}


def _names_sound_alike(a: str, b: str) -> bool:
    """The same name written in the other alphabet — never the same alphabet."""
    alphabet_a = _alphabet(_normalize_identity(a))
    alphabet_b = _alphabet(_normalize_identity(b))
    if alphabet_a is None or alphabet_b is None or alphabet_a == alphabet_b:
        return False
    return bool(_name_skeletons(a) & _name_skeletons(b))


#: A self-reference someone puts in front of their own name: "I'm Nir", "אני
#: ניר", "it's me, Nir". Only ever stripped from the START of the answer.
_SELF_REFERENCE = re.compile(
    r"^(?:it'?s\s+me|i\s+am|i'?m|me|myself|זה\s+אני|זאת\s+אני|אני)(?=[\s,:(]|$)[\s,:]*",
    re.IGNORECASE,
)
#: What separates a name from what someone says about themselves after it:
#: "ניר, אבא של המשפחה", "Nir - the dad", "Nir (the dad)". A hyphen counts
#: only with spaces around it, so "Anne-Marie" stays one name.
_AFTER_NAME = re.compile(r"\s*[,;(—–]\s*|\s+-\s+")


def _stated_name_candidates(answer: str) -> list[str]:
    """The answer as typed, then the NAME at the front of it.

    2026-09-11, the first automated full cycle: "which of the travellers are
    you?" is answered in a sentence — "ניר, אבא של המשפחה", "I'm Nir", "me
    (Nir)" — and matching the whole sentence found nobody, so the trip
    provisioned with no companion. This reads the leading name out of such an
    answer and NOTHING else: never a name buried later ("Nir's wife" is not
    Nir), and never a word from the description. The candidate still has to
    match exactly one traveller; see `_resolve_organizers`.
    """
    full = _normalize_identity(answer)
    if not full:
        return []
    candidates = [full]
    rest = _SELF_REFERENCE.sub("", full, count=1)
    parts = _AFTER_NAME.split(rest, maxsplit=1)
    head = parts[0].strip(" )")
    if head:
        candidates.append(head)
    elif len(parts) > 1:
        # "me (Nir)": the self-reference WAS the head, so the name is next.
        candidates.append(_AFTER_NAME.split(parts[1], maxsplit=1)[0].strip(" )"))
    return list(dict.fromkeys(c for c in candidates if c))


def _resolve_organizers(data: Mapping[str, Any], participants: list[dict[str, Any]]) -> list[str]:
    """Matches the organizer_identity answer to a participant username.

    Returns [] rather than a best guess when nothing matches. driver.mjs hard
    fails on an organizer absent from participants[], so an invented username
    yields a config that cannot deploy at all; and a username that happens to
    belong to *someone else* silently hands them the organizer's private
    channel. No organizer block is the recoverable failure of the three.

    An AMBIGUOUS answer is treated the same way as no answer, for the same
    reason: two participants matching "שי" means the roster cannot tell which
    of them is speaking, and picking the first is the wrong-person failure
    with extra steps.
    """
    answer = data.get("organizer_identity")
    candidates = _stated_name_candidates(_text_value(answer)) if isinstance(answer, Mapping) else []
    if not candidates:
        return []

    # The raw roster, keyed by every given-name form it carries, so a
    # participant can be matched back to the entry the organizer actually
    # typed — the one that still holds the household label unslugified.
    raw_by_name: dict[str, Mapping[str, Any]] = {}
    travelers = data.get("travelers")
    entries = travelers.get("data") if isinstance(travelers, Mapping) else None
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, Mapping):
            continue
        for key in ("name", "name_en"):
            form = _normalize_identity(entry.get(key))
            if form:
                raw_by_name.setdefault(form, entry)

    forms_by_username: dict[str, set[str]] = {}
    names_by_username: dict[str, set[str]] = {}
    for participant in participants:
        username = participant.get("username")
        if not username:
            continue
        aliases = [
            raw for raw in (
                raw_by_name.get(_normalize_identity(participant.get("name"))),
                raw_by_name.get(_normalize_identity(participant.get("name_en"))),
            ) if raw is not None
        ]
        forms_by_username.setdefault(username, set()).update(_identity_forms(participant, *aliases))
        names_by_username.setdefault(username, set()).update(
            _identity_forms(participant, *aliases, include_username=False))

    # The answer as typed first, then the name at the front of it. The first
    # reading that names exactly ONE traveller wins; a reading that names two
    # ends the search — a looser read must never break a tie a stricter one
    # could not.
    for needle in candidates:
        matched = [u for u, forms in forms_by_username.items() if needle in forms]
        if len(matched) == 1:
            return matched
        if len(matched) > 1:
            return []

    # Nothing matched as written. The same name in the OTHER alphabet — "ניר"
    # for a roster that only ever spelled it "Nir" — under the same rule: one
    # traveller or nobody. Reached only when every stricter reading found no one,
    # so it can never break a tie those readings refused.
    for needle in candidates:
        matched = [
            u for u, names in names_by_username.items()
            if any(_names_sound_alike(needle, name) for name in names)
        ]
        if len(matched) == 1:
            return matched
        if len(matched) > 1:
            return []
    return []


def _derive_agent(
    data: Mapping[str, Any],
    participants: list[dict[str, Any]],
    dietary_instructions: list[dict[str, Any]],
    language: str | None = None,
) -> dict[str, Any] | None:
    """Builds trip.config.json's `agent` block from the assistant questions.

    Returns None when the organizer answered none of them, so an intake that
    skipped the whole assistant section produces exactly the config it did
    before these questions existed.
    """
    agent: dict[str, Any] = {}

    organizers = _resolve_organizers(data, participants)
    if organizers:
        agent["organizers"] = organizers

    raw_name = _text_value(data["bot_name"]).strip() if isinstance(data.get("bot_name"), Mapping) else ""
    name, name_en = split_bilingual_name(raw_name)
    if name:
        agent["name"] = name
        agent["name_en"] = name_en
        gender = _text_value(data["bot_gender"]) if isinstance(data.get("bot_gender"), Mapping) else ""
        # Hebrew conjugates by gender, so the assistant cannot build a sentence
        # without one. 'neutral' (gender-avoidant phrasing) is the honest
        # fallback for "wasn't asked"; guessing from the name would be wrong in
        # every message it got wrong.
        agent["gender"] = gender if gender in _AGENT_GENDERS else "neutral"
        tone = _text_value(data["bot_tone"]) if isinstance(data.get("bot_tone"), Mapping) else ""
        agent["tone"] = tone if tone in _AGENT_TONES else "warm"
        # The language the interview was actually held in — the same value
        # meta.defaultLang gets, through the same resolver, so the two halves
        # of one file cannot disagree.
        #
        # This was hardcoded to "en" until 2026-09-20, when a Hebrew interview
        # produced a config whose meta said `he` and whose companion said `en`.
        # Nothing failed; the assistant simply answered a Hebrew family in
        # English, which reads as the product being wrong rather than
        # misconfigured.
        agent["default_language"] = _resolve_language(language)

    typed_tz = _text_value(data["timezone"]).strip() if isinstance(data.get("timezone"), Mapping) else ""
    destination = _text_value(data["destination"]) if isinstance(data.get("destination"), Mapping) else ""
    # A DERIVED zone must not be the thing that brings an agent block into
    # existence: an intake that answered none of the assistant questions still
    # has to produce exactly the config it did before those questions existed
    # (see this function's contract, and the two tests that assert it). A zone
    # the organizer TYPED is an answer, so it may.
    tz = _resolve_timezone(typed_tz, destination) if (typed_tz or agent) else ""
    if tz:
        agent["timezone"] = tz
    elif typed_tz:
        # Dropped rather than carried: see _resolve_timezone. Logged because a
        # destination nobody has mapped yet is the only way to get here, and
        # that is worth knowing rather than discovering from a briefing that
        # never arrives.
        logger.warning(
            "transformer.timezone_unresolved",
            extra={"typed": typed_tz, "destination": destination},
        )

    proactive = {
        key: _PROACTIVE_VALUES[key]
        for key in _multi_choice_ids(data, "bot_proactive")
        if key in _PROACTIVE_VALUES
    }
    if proactive:
        agent["proactive"] = proactive

    instructions = list(dietary_instructions)
    # A custom trip type is more than branding. The companion needs the
    # organizer's actual framing — e.g. an extended-family reunion behaves
    # differently from the preset "Family" trip — when it makes suggestions.
    # It is kept verbatim in both language slots: it was reviewed by the
    # interviewer before storage, but translating a personal description would
    # still put words in the organizer's mouth.
    trip_type = data.get("trip_type")
    if isinstance(trip_type, Mapping) and trip_type.get("kind") == "choice_other":
        custom_type = str(trip_type.get("other_text") or "").strip()
        if custom_type:
            instructions.append(_instruction({
                "en": f"The organizer describes this trip as: {custom_type}",
                "he": f"המארגן מתאר את הטיול כך: {custom_type}",
            }))
    pace = _text_value(data["trip_pace"]) if isinstance(data.get("trip_pace"), Mapping) else ""
    if pace in _PACE_TEXT:
        instructions.append(_instruction(_PACE_TEXT[pace]))
    for raw in _structured_list(data, "bot_limits"):
        # The interviewer supplies both languages; an entry missing either is
        # dropped rather than half-rendered, since site/app.js's bilingual span
        # helper emits an empty element for a missing side.
        if not isinstance(raw, dict):
            continue
        he, en = raw.get("he"), raw.get("en")
        if isinstance(he, str) and he.strip() and isinstance(en, str) and en.strip():
            instructions.append(_instruction({"he": he.strip(), "en": en.strip()}))
    # What the organizer asked for help with, handed to the companion.
    #
    # The interview collects STRUCTURE; an organizer who says "we haven't
    # worked out Kyoto yet" is describing work that happens after the site
    # exists. Carrying it as a standing instruction is what stops that ask
    # being lost between the two agents — the companion reads it on its first
    # turn instead of the organizer having to say it twice.
    #
    # Organizer-only like every instruction here (see _instruction): it is the
    # organizer's own words about what they have not sorted out, which is not
    # something to publish to the whole family.
    planning_help = _text_value(data.get("planning_help", {})).strip()
    if planning_help:
        instructions.append(_instruction({
            "en": f"The organizer asked for help with this after setup: {planning_help}",
            "he": f"המארגן ביקש עזרה בזה אחרי ההקמה: {planning_help}",
        }))

    if instructions:
        agent["standing_instructions"] = instructions

    return agent or None


def _phase_extra_context(short: str, originals: list[str]) -> str:
    """Whatever the original phase name(s) carried beyond the short label — an
    event, a sub-group, a route detail. Not discarded: it belongs in the phase
    detail view, appended to the blurb below."""
    seen: set[str] = set()
    unique: list[str] = []
    for original in originals:
        text = original.strip()
        if not text or text.lower() == short.strip().lower() or text in seen:
            continue
        seen.add(text)
        unique.append(text)
    return "; ".join(unique)


def _fmt_phase_day(value: date, he: bool) -> str:
    if he:
        return f"{value.day}.{value.month}"
    return value.strftime("%-d %b")


def _phase_note_text(
    short: str,
    originals: list[str],
    *,
    start: date | None = None,
    end: date | None = None,
    hotel: str = "",
    day_count: int = 0,
    lang: str = "en",
) -> str:
    """A short readable phase-detail blurb instead of a raw name dump: leads
    with the stay (nights + dates), names the hotel, says how many days are
    planned, and appends any real context trimmed from the phase name."""
    he = lang == "he"
    parts: list[str] = []
    if start and end:
        nights = (end - start).days
        if nights >= 1:
            span = f"{_fmt_phase_day(start, he)}–{_fmt_phase_day(end, he)}"
            parts.append(
                f"{nights} לילות ב{short}, {span}" if he
                else f"{nights} night{'s' if nights != 1 else ''} in {short}, {span}"
            )
    if hotel:
        parts.append(f"לינה ב{hotel}" if he else f"Staying at {hotel}")
    if day_count:
        parts.append(
            f"{day_count} ימים מתוכננים" if he
            else f"{day_count} day{'s' if day_count != 1 else ''} planned"
        )
    extra = _phase_extra_context(short, originals)
    if extra:
        parts.append(extra)
    return ". ".join(p for p in parts if p)


_TIME_RE = re.compile(r"^\d{2}:\d{2}$")


def _plain(value: Any) -> str:
    """Angle brackets stripped. The site renders config `days` text through
    `_biSpan`, which emits it as raw HTML (deliberate for hand-authored config),
    so anything that reaches `phases[].days[]` from an LLM must not carry markup.
    The `extract_itinerary` MCP tool sanitises first; this is the backstop for a
    `days` payload that arrives some other way (e.g. `intake/correct`).
    """
    return re.sub(r"[<>]", "", str(value or "")).strip()


def _bilingual_text(obj: Any) -> dict[str, str] | None:
    """Normalise a {he,en} pair: strip markup, mirror the present side onto the
    missing one, and return None when both sides are empty.

    A PLAIN STRING is accepted and mirrored onto both sides. The document
    extractor emits venue names that way (`{"name": "Tokyo Skytree"}`), and
    requiring the pair meant every such venue was read as nameless and dropped
    — on the 2026-09-09 run, all six of them. One language is not a reason to
    discard a place; it is a reason to show the same name on both sides.
    """
    if isinstance(obj, str):
        text = _plain(obj)
        return {"he": text, "en": text} if text else None
    if not isinstance(obj, Mapping):
        return None
    he, en = _plain(obj.get("he")), _plain(obj.get("en"))
    if not he and not en:
        return None
    return {"he": he or en, "en": en or he}


def _normalise_days(
    raw_days: Any, start: date | None, end: date | None,
) -> list[dict[str, Any]]:
    """Turn a phases[].days intake payload into the site's config shape:
    [{date, label?:{he,en}, items:[{time:"HH:MM"|None, text:{he,en}}]}].

    Drops a day whose date is unparseable or (when the phase has a range)
    outside it, and a day left with no valid items. An item keeps its `time`
    only if it is exactly HH:MM, and is dropped if its text is empty in both
    languages.
    """
    if not isinstance(raw_days, list):
        return []
    out: list[dict[str, Any]] = []
    for raw in raw_days:
        if not isinstance(raw, Mapping):
            continue
        when = _parse_iso_date(raw.get("date"))
        if not when:
            continue
        if start and end and not (start <= when <= end):
            continue
        items: list[dict[str, Any]] = []
        for raw_item in raw.get("items") or []:
            if not isinstance(raw_item, Mapping):
                continue
            text = _bilingual_text(raw_item.get("text"))
            if not text:
                continue
            raw_time = str(raw_item.get("time") or "").strip()
            items.append({
                "time": raw_time if _TIME_RE.match(raw_time) else None,
                "text": text,
            })
        if not items:
            continue
        day: dict[str, Any] = {"date": when.isoformat(), "items": items}
        label = _bilingual_text(raw.get("label"))
        if label:
            day["label"] = label
        out.append(day)
    out.sort(key=lambda d: d["date"])
    return out


_HTTP_URL_RE = re.compile(r"^https?://\S+$", re.IGNORECASE)


def _planned_as_venues(raw_planned: Any) -> list[dict[str, Any]]:
    """Turn a phases[].planned intake payload — plain place-name strings the
    interview proposed from a document but that were never booked — into the
    same shape `_normalise_venues` expects, so a place like "Tokyo Skytree"
    reaches the site's phase page the same way a `venues[]` entry from
    `extract_itinerary` does, just without a url/area."""
    if not isinstance(raw_planned, list):
        return []
    out: list[dict[str, Any]] = []
    for raw in raw_planned:
        name = _plain(raw)
        if name:
            out.append({"name": {"he": name, "en": name}})
    return out


def _normalise_venues(raw_venues: Any) -> list[dict[str, Any]]:
    """Turn a phases[].venues intake payload into the site's config shape:
    [{id, name:{he,en}, url?, area?}]. Deduped by english name, capped, `url`
    kept only if it is a real http(s) link."""
    if not isinstance(raw_venues, list):
        return []
    out: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    for raw in raw_venues:
        if not isinstance(raw, Mapping) or len(out) >= 12:
            continue
        name = _bilingual_text(raw.get("name"))
        if not name or name["en"].lower() in seen_names:
            continue
        seen_names.add(name["en"].lower())
        vid = _slug_words(name["en"])[:40] or f"venue{len(out)}"
        if vid in seen_ids:
            vid = f"{vid}-{len(out)}"
        seen_ids.add(vid)
        venue: dict[str, Any] = {"id": vid, "name": name}
        url = _plain(raw.get("url"))
        if _HTTP_URL_RE.match(url):
            venue["url"] = url
        area = _plain(raw.get("area"))
        if area:
            venue["area"] = area
        out.append(venue)
    return out


def _open_day_phases(
    phases: list[dict[str, Any]], departure: str, ret: str,
) -> list[dict[str, Any]]:
    """Phases for the days of the trip that no phase covers.

    A DAY OF THE TRIP THAT IS ON NO PHASE MUST NOT BE INVISIBLE. On 2026-09-20
    an organizer said, in as many words, that ten of their sixteen days were
    undecided and asked for a proposal. The site showed the six that were
    decided and nothing at all for the rest — no gap, no note, no sign that
    nine days existed. The trip simply appeared to be six days long, beside a
    return flight departing a city no phase mentioned.

    Absent and undecided are different things, and only one of them is true.
    These phases say the second out loud: the days are real, they belong to the
    trip, and nothing is planned on them yet.

    `unplanned: true` marks them as the site's own inference rather than
    something the organizer said, so a later pass — the companion, or the
    editing surface this is the placeholder for — can replace or shrink one
    without guessing which phases were authored.

    Contiguous gaps become one phase each: three separate open days in a row
    are one open stretch, not three tabs.
    """
    # A trip with NO phases at all is a different state, not a gap: nobody has
    # said anything about stops yet, and the site already says so its own way
    # ("nothing was named, so nothing is served — the companion offers a
    # draft"). Filling it with one open stretch spanning the whole trip would
    # be this function answering a question it was not asked.
    if not phases or not departure or not ret:
        return []
    try:
        first, last = date.fromisoformat(departure[:10]), date.fromisoformat(ret[:10])
    except ValueError:
        return []
    if last < first:
        return []

    covered: set[date] = set()
    for phase in phases:
        dates = phase.get("dates") or {}
        try:
            start = date.fromisoformat(str(dates.get("start") or "")[:10])
            end = date.fromisoformat(str(dates.get("end") or "")[:10])
        except ValueError:
            continue
        day = start
        while day <= end:
            covered.add(day)
            day += timedelta(days=1)

    gaps: list[list[date]] = []
    day = first
    while day <= last:
        if day not in covered:
            if gaps and gaps[-1][-1] == day - timedelta(days=1):
                gaps[-1].append(day)
            else:
                gaps.append([day])
        day += timedelta(days=1)

    out: list[dict[str, Any]] = []
    for index, gap in enumerate(gaps, start=1):
        suffix = "" if len(gaps) == 1 else f"-{index}"
        out.append({
            "id": f"open-days{suffix}",
            "unplanned": True,
            "title": {"he": "ימים שעוד לא תוכננו", "en": "Days not planned yet"},
            "tabLabel": "?",
            "dates": {"start": gap[0].isoformat(), "end": gap[-1].isoformat()},
            "note": {
                "he": f"{len(gap)} ימים בטיול שעוד לא שויכו לתחנה. אפשר לדבר עם "
                      f"העוזר כדי לשבץ אותם לתחנה קיימת או לפתוח תחנה חדשה.",
                "en": f"{len(gap)} day(s) of this trip do not belong to a stop yet. "
                      f"Talk to your assistant to add them to one, or open a new stop.",
            },
        })
    return out


# Whether a phase's season is knowable at all -- and in which hemisphere -- is
# `packing_climate.decide()`'s question, not this module's (issue #167). Until
# 2026-09-25 it was answered here by a southern-country list with everything
# else defaulting north: Thailand in January got "Warm jacket, Gloves", a trip
# to "Sydney" was read as northern, "Chile, Spain" and "Spain, Chile" landed in
# opposite hemispheres, and one hemisphere served every phase of a trip. The
# owner's rule replaced the default: if not sure, say nothing.


def _season_bucket(month: int, hemisphere: str) -> str:
    """A coarse meteorological-season bucket for one calendar month in one
    hemisphere -- "cold"/"hot"/"rainy"/"moderate". It lives in
    `packing_climate.season_bucket`, because the gate that decides whether a
    bucket is reasonable for a place has to test the SAME months against it;
    this name stays for the callers and tests that use it.

    Winter -> cold and summer -> hot swap between hemispheres, as real
    seasons do. Spring keeps "rainy" and autumn keeps "moderate" in BOTH
    hemispheres -- there is no equally-ordinary idiom for "rainy autumn" to
    swap to instead, and inventing one would be exactly the destination-
    specific guessing this bucket is deliberately not doing.
    """
    return packing_climate.season_bucket(month, hemisphere)


def _phase_months(start: date | None, end: date | None) -> list[int]:
    """Every calendar month a phase touches, start to end, at most twelve.
    Each list covers three months and a phase can straddle two lists, so the
    gate has to see all of them, not the start month alone."""
    if start is None:
        return []
    if end is None or end < start:
        end = start
    months: list[int] = []
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month) and len(months) < 12:
        months.append(month)
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return months


# [{he,en} category, {he,en} item] pairs, the exact tuple shape
# readiness.tsx's packing renderer expects for `config.packing_general` and
# every `phase.packing` alike. "moderate" deliberately stays short -- nothing
# specific to add on top of the trip-level general list readiness.tsx already
# falls back to on its own (documents/passport/insurance/charger/meds).
_PACKING_ITEMS_BY_SEASON: dict[str, list[tuple[dict[str, str], dict[str, str]]]] = {
    "hot": [
        ({"he": "בריאות", "en": "Health"}, {"he": "קרם הגנה", "en": "Sunscreen"}),
        ({"he": "ביגוד", "en": "Clothing"}, {"he": "בגדים קלים ונושמים", "en": "Light, breathable clothing"}),
        ({"he": "אביזרים", "en": "Accessories"}, {"he": "משקפי שמש וכובע", "en": "Sunglasses and a hat"}),
    ],
    "cold": [
        ({"he": "ביגוד", "en": "Clothing"}, {"he": "מעיל חם", "en": "Warm jacket"}),
        ({"he": "ביגוד", "en": "Clothing"}, {"he": "שכבות לבוש", "en": "Layers"}),
        ({"he": "אביזרים", "en": "Accessories"}, {"he": "כפפות", "en": "Gloves"}),
    ],
    "rainy": [
        ({"he": "אביזרים", "en": "Accessories"}, {"he": "מטריה או מעיל גשם", "en": "Umbrella or rain jacket"}),
        ({"he": "ביגוד", "en": "Clothing"}, {"he": "נעליים אטומות למים", "en": "Waterproof footwear"}),
    ],
    "moderate": [
        ({"he": "ביגוד", "en": "Clothing"}, {"he": "שכבה קלה נוספת", "en": "A light layer"}),
    ],
}


def _phase_packing_decision(
    destination: str, start: date | None, end: date | None, phase_names: Sequence[str] = (),
    fallback_names: Sequence[str] = (),
) -> tuple[list[list[dict[str, str]]], str | None]:
    """A phase's climate-appropriate packing additions AND, when there are
    none, why: `(items, None)` or `([], reason)`, the reason drawn from
    `packing_climate.REASONS`. The reason is for logs and tests only; it is
    never written into the trip config.

    The additions layer on top of the trip-level general list (readiness.tsx's
    `config.packing_general`, which has its own frontend fallback and is out
    of this function's scope). Deterministic only: a small fixed item table
    keyed on a coarse season bucket (hemisphere x month) -- never a live
    weather call, never a model call, never a network call.

    Emitted ONLY when `packing_climate.decide()` is sure of the place and its
    season in EVERY month the phase covers (issue #167): a phase that
    straddles two season buckets, or has one month the bucket is wrong for,
    abstains. `phase_names` are the phase's FULL names and `fallback_names`
    the shortened forms, read only when no full name places anything -- so
    "Perth, Scotland" decides before the "Perth" it shortens to can. A Tokyo
    phase in a trip to "Japan" gets a list; a phase that names no known city
    never does, whatever the destination. Everything else abstains, and an absent
    `phase.packing` is what both sites already degrade to: readiness.tsx and
    classic app.js render a phase's packing only when it has items.
    """
    decision = packing_climate.decide(
        destination, phase_names, _phase_months(start, end), fallback_names=fallback_names,
    )
    if decision.reason is not None or decision.hemisphere is None or start is None:
        return [], decision.reason or packing_climate.UNRESOLVED
    bucket = _season_bucket(start.month, decision.hemisphere)
    items = _PACKING_ITEMS_BY_SEASON.get(bucket) or []
    return [[dict(category), dict(item)] for category, item in items], None


def _derive_phase_packing(
    destination: str, start: date | None, end: date | None, phase_names: Sequence[str] = (),
    fallback_names: Sequence[str] = (),
) -> list[list[dict[str, str]]]:
    """The items half of `_phase_packing_decision` -- `[]` means abstain."""
    return _phase_packing_decision(destination, start, end, phase_names, fallback_names)[0]


def _derive_phases(phases: list[Any], destination: str = "") -> list[dict[str, Any]]:
    """Turns the phases[] intake answer into trip.config.json's phases[]
    shape — logistics fields, plus a day-by-day `days[]` when the intake
    carries one (extracted from an uploaded plan document at interview time).
    Hero images and map coordinates still need external lookups this
    transformer deliberately doesn't perform (see module docstring).

    `destination` is the trip's raw (pre-"Unknown Destination"-fallback)
    typed answer, threaded through only so each phase's `packing` additions
    (see _phase_packing_decision) can place the phase; nothing else here reads
    it. Passing "" is the "no destination" case that suppresses packing.

    Consecutive stops that shorten to the same location (a group split like
    "Dallas (boys...)" immediately followed by "Dallas (all travelers)") are
    one real stop, not two identical nav tabs — they're merged into a single
    phase spanning the full date range. Two visits to the same city at
    different points in the trip (e.g. New York at the start and again at
    the end) are NOT adjacent in the list, so they stay separate.
    """
    parsed: list[dict[str, Any]] = []
    for raw in phases:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or raw.get("name_en") or "").strip()
        if not name:
            continue
        name_en = str(raw.get("name_en") or name).strip()
        parsed.append({
            "short_he": _shorten_phase_name(name),
            "short_en": _shorten_phase_name(name_en),
            "full_he": name,
            "full_en": name_en,
            "start": _parse_iso_date(raw.get("start")),
            "end": _parse_iso_date(raw.get("end")),
            "accommodation": raw.get("accommodation"),
            "days": raw.get("days") if isinstance(raw.get("days"), list) else [],
            "venues": (raw.get("venues") if isinstance(raw.get("venues"), list) else [])
            + _planned_as_venues(raw.get("planned")),
        })

    merged: list[dict[str, Any]] = []
    for entry in parsed:
        prev = merged[-1] if merged else None
        if prev and prev["short_en"].lower() == entry["short_en"].lower() and prev["short_en"]:
            if entry["start"] and (not prev["start"] or entry["start"] < prev["start"]):
                prev["start"] = entry["start"]
            if entry["end"] and (not prev["end"] or entry["end"] > prev["end"]):
                prev["end"] = entry["end"]
            prev["accommodation"] = prev["accommodation"] or entry["accommodation"]
            prev["notes_he"].append(entry["full_he"])
            prev["notes_en"].append(entry["full_en"])
            prev["days"] = prev["days"] + entry["days"]
            prev["venues"] = prev["venues"] + entry["venues"]
        else:
            entry["notes_he"] = [entry["full_he"]]
            entry["notes_en"] = [entry["full_en"]]
            merged.append(entry)

    result: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for index, entry in enumerate(merged):
        phase_id = _slugify(entry["short_en"] or entry["short_he"])
        if phase_id in used_ids:
            phase_id = f"{phase_id}{index}"
        used_ids.add(phase_id)

        phase: dict[str, Any] = {
            "id": phase_id,
            "title": {"he": entry["short_he"], "en": entry["short_en"]},
            "tabLabel": (entry["short_en"] or entry["short_he"]).upper(),
        }
        if entry["start"] and entry["end"]:
            phase["dates"] = {"start": entry["start"].isoformat(), "end": entry["end"].isoformat()}

        accommodation = entry["accommodation"]
        if isinstance(accommodation, dict) and accommodation.get("name"):
            acc_name = str(accommodation["name"])
            phase["accommodation"] = {
                "name": acc_name,
                "name_en": str(accommodation.get("name_en") or acc_name),
            }
            if accommodation.get("confirmation"):
                phase["accommodation"]["confirmation"] = str(accommodation["confirmation"])

        days = _normalise_days(entry["days"], entry["start"], entry["end"])
        if days:
            phase["days"] = days

        venues = _normalise_venues(entry["venues"])
        if venues:
            phase["venues"] = venues

        packing, abstained = _phase_packing_decision(
            destination, entry["start"], entry["end"],
            # Full names decide: shortening cuts at the comma, and "Perth,
            # Scotland" shortened is a city on the other side of the world.
            phase_names=(entry["full_en"], entry["full_he"]),
            fallback_names=(entry["short_en"], entry["short_he"]),
        )
        if packing:
            phase["packing"] = packing
        else:
            # The only trace of an abstention: the site simply shows no
            # per-phase list, which is also what a bug would look like.
            logger.info(
                "transformer.packing_abstained",
                extra={"phase": phase_id, "reason": abstained},
            )

        acc_for_note = phase.get("accommodation") or {}
        hotel_he = str(acc_for_note.get("name") or "")
        hotel_en = str(acc_for_note.get("name_en") or acc_for_note.get("name") or "")
        note_he = _phase_note_text(
            entry["short_he"], entry["notes_he"],
            start=entry["start"], end=entry["end"],
            hotel=hotel_he, day_count=len(days), lang="he",
        )
        note_en = _phase_note_text(
            entry["short_en"], entry["notes_en"],
            start=entry["start"], end=entry["end"],
            hotel=hotel_en, day_count=len(days), lang="en",
        )
        if note_he or note_en:
            phase["note"] = {"he": note_he or note_en, "en": note_en or note_he}

        result.append(phase)
    return result


_BUDGET_CATEGORIES = {"flight", "hotel", "car", "attraction", "food", "insurance", "other"}


def _derive_budget(
    data: Mapping[str, Any], phases: list[dict[str, Any]], default_party_size: int,
) -> dict[str, Any] | None:
    """Project the optional budget_detail answer into config.budget — the shape
    server.js seeds budget_items from (seed_items[]) plus the phase_labels /
    phases / party_size the site's Budget tab needs. Returns None when the
    organizer didn't give a budget."""
    raw = _structured_dict(data, "budget_detail")
    items = raw.get("items")
    if not isinstance(items, list) or not items:
        return None

    # Match a free-text phase reference to a real phase id, its title, or the
    # two synthetic buckets the reference config also uses.
    by_key: dict[str, str] = {}
    labels: dict[str, dict[str, str]] = {}
    for phase in phases:
        pid = phase["id"]
        title = phase.get("title") or {}
        labels[pid] = {"he": str(title.get("he") or pid), "en": str(title.get("en") or pid)}
        for key in (pid, str(title.get("en") or ""), str(title.get("he") or "")):
            if key.strip():
                by_key[key.strip().lower()] = pid
    labels["intl_flights"] = {"he": "✈️ טיסות", "en": "✈️ Flights"}
    labels["other"] = {"he": "שונות", "en": "Other"}

    seed_items: list[dict[str, Any]] = []
    used: list[str] = []
    seen_keys: set[str] = set()
    for entry in items:
        if not isinstance(entry, Mapping):
            continue
        category = str(entry.get("category") or "").strip().lower()
        if category not in _BUDGET_CATEGORIES:
            category = "other"
        description = _plain(entry.get("description"))[:200]
        if not description:
            continue
        try:
            amount = max(0.0, float(entry.get("amount") or 0))
        except (TypeError, ValueError):
            amount = 0.0
        is_estimate = bool(entry.get("estimate")) or amount == 0

        ref = str(entry.get("phase") or "").strip().lower()
        phase_id = by_key.get(ref)
        if not phase_id:
            phase_id = "intl_flights" if category == "flight" else (
                phases[0]["id"] if phases else "other"
            )
        if phase_id not in used:
            used.append(phase_id)

        seed_key = f"intake-{phase_id}-{category}-{_slugify(description)[:24] or 'x'}"
        if seed_key in seen_keys:
            seed_key = f"{seed_key}-{len(seed_items)}"
        seen_keys.add(seed_key)
        seed_items.append({
            "phase": phase_id,
            "category": category,
            "description": description,
            "amount": amount,
            "is_estimate": is_estimate,
            "seed_key": seed_key,
        })

    if not seed_items:
        return None

    # Order: flights first, real phases in trip order, "other" last.
    order = [p for p in (["intl_flights"] + [ph["id"] for ph in phases] + ["other"]) if p in used]
    try:
        party_size = int(raw.get("party_size"))
    except (TypeError, ValueError):
        party_size = default_party_size or 0

    budget: dict[str, Any] = {
        "party_size": party_size or 1,
        "phases": order,
        "phase_labels": {pid: labels[pid] for pid in order},
        "seed_items": seed_items,
    }
    currency = _plain(raw.get("currency"))[:8]
    if currency:
        budget["currency"] = currency
    return budget


SUPPORTED_LANGUAGES = ("en", "he")


def _resolve_language(language: str | None) -> str:
    """The trip's language, or English when there is nothing usable.

    Fails safe in the same direction as `shared/needs-schema.js`: an
    unrecognised value resolves to the conservative option rather than
    propagating. A language code nothing can render reaches the site as broken
    text in every string at once.
    """
    candidate = (language or "").strip().lower()
    return candidate if candidate in SUPPORTED_LANGUAGES else "en"


def transform_intake(
    data: Mapping[str, Any],
    today: date | None = None,
    language: str | None = None,
) -> dict[str, Any]:
    """Convert intake answers into a trip.config.json dict.

    Raises ValueError if any required question is missing.
    The departure date is set to 90 days from *today* (or the supplied
    reference date); this is a placeholder the organizer refines later via
    the intake correction path.

    `language` is the language the INTERVIEW was held in, carried on the intake
    version. It is not a preference anyone is asked for: it was established by
    the organizer's first message and every message after it. Until 2026-09-07
    it was not carried at all and this function hardcoded English, so an
    interview conducted entirely in Hebrew produced a trip whose companion
    greeted the family in English — with a Hebrew assistant name embedded in
    the English sentence. Absent still means English, because every intake
    version written before this carries nothing.
    """
    missing = REQUIRED_QUESTIONS - set(data.keys())
    if missing:
        raise ValueError(f"intake is missing required questions: {sorted(missing)}")

    today = today or date.today()
    destination_raw = _text_value(data["destination"]).strip()
    destination = destination_raw or "Unknown Destination"
    trip_type_label = _resolve_trip_type(data["trip_type"])
    group_size_label = _resolve_group_size(data)

    departure_date, return_date, total_days = _resolve_dates(data, today)

    brand, title = _derive_brand_and_title(
        destination, trip_type_label, departure_date.year,
        [str(ph.get("name") or ph.get("name_en") or "") for ph in _structured_list(data, "phases")
         if isinstance(ph, Mapping)],
    )
    departure_iso = datetime(
        departure_date.year, departure_date.month, departure_date.day,
        0, 0, 0, tzinfo=timezone.utc,
    ).isoformat()

    # Hero stats are a short, exciting strip, not a place to echo organizer
    # free text verbatim — group_size_label is already just a number (see
    # _resolve_group_size), and both stats always carry an 'he' description
    # (even a generic one) since a bilingual field missing 'he' renders as a
    # silent blank in the site's Hebrew view, not a fallback to English.
    stats: list[dict[str, Any]] = [
        {
            "number": group_size_label,
            "description": {"en": "travelers on this adventure", "he": "מטיילים בטיול"},
        },
        {
            "number": str(total_days),
            "description": {"en": f"days in {destination}", "he": "ימים בטיול"},
        },
    ]

    travelers = _structured_list(data, "travelers")
    participants, families = _derive_participants_and_families(travelers)

    # Mutates participants in place to attach needs[], and hands back whatever
    # applies to the whole group for the agent block to carry instead.
    dietary_instructions = _apply_dietary(data, participants)
    agent = _derive_agent(data, participants, dietary_instructions, language)

    phases = _derive_phases(_structured_list(data, "phases"), destination_raw)

    # A day-by-day from the dated anchors, for every phase that does not
    # already have one. Extracted days WIN: `extract_itinerary`'s pass over an
    # uploaded document is richer than anything derivable from a list of
    # bookings, so this fills empty phases rather than competing for the slot.
    # It exists because that extraction is unreachable from the chat-scoped
    # interview, so in practice the slot is always empty — but the precedence
    # is written the right way round so it stays correct when that is fixed.
    anchor_days = derive_days_from_anchors({"phases": phases}, data)
    for phase in phases:
        derived = anchor_days.get(str(phase.get("id")))
        if derived and not phase.get("days"):
            phase["days"] = derived

    # The votable half of the same anchors, from the same reading of them: the
    # unconfirmed attractions, which are the ones still open to a "shall we?".
    # Same insertion point and same reason as the days above — it needs the real
    # phases with their ids and date ranges, which `_derive_phases` has just
    # settled. Absent rather than empty when a phase has none: an empty
    # `rsvp_activities` is a heading over no cards, not a statement.
    anchor_rsvps = derive_rsvp_activities({"phases": phases}, data)
    for phase in phases:
        derived = anchor_rsvps.get(str(phase.get("id")))
        if derived and not phase.get("rsvp_activities"):
            phase["rsvp_activities"] = derived

    # AFTER the real phases are settled, and in trip order. A day of the trip
    # that belongs to no phase is shown as an open stretch rather than not
    # shown at all — see _open_day_phases for the run that made this necessary.
    #
    # ONLY AGAINST DATES THE ORGANIZER GAVE. `_resolve_dates` falls back to
    # `today + 90 days` when they did not, and a gap measured against an
    # invented range invents the days in it: a test fixture with no dates and
    # phases in September produced a fortnight of "unplanned" days three months
    # away. A day is missing only if the trip is known to contain it.
    stated_departure = _parse_iso_date(_text_value(data.get("departure_date", {})))
    stated_return = _parse_iso_date(_text_value(data.get("return_date", {})))
    if stated_departure and stated_return:
        phases = sorted(
            phases + _open_day_phases(
                phases, stated_departure.isoformat(), stated_return.isoformat(),
            ),
            key=lambda ph: str((ph.get("dates") or {}).get("start") or ""),
        )

    # Only a count, never the organizer's free text — same reasoning as above.
    #
    # CONFIRMED means confirmed. This counted every travel_anchor until
    # 2026-09-20, when a trip with nothing booked told its family on the front
    # page that four bookings were confirmed — while the map stops rendered
    # from the same anchors correctly showed `conf: "–"` beside it.
    #
    # An anchor is a fixed point in the trip, not evidence of a booking; the
    # schema's own rule is that a confirmation is what makes it one. With none,
    # the stat is dropped rather than shown as zero: "0 bookings confirmed" is
    # a true sentence nobody needs on a hero strip.
    travel_anchors = _structured_list(data, "travel_anchors")
    confirmed = [a for a in travel_anchors if _has_confirmation(a)]
    if confirmed:
        stats.append({
            "number": str(len(confirmed)),
            "description": {"en": "booking(s) already confirmed", "he": "הזמנות מאושרות"},
        })

    # trip_interests and constraints are intentionally NOT projected into
    # stats: they're organizer free text of arbitrary length, and the Hero
    # strip needs short/generic copy, not a paragraph. They remain available
    # in intake_versions.data for a future, real destination-info enrichment
    # pass (see _lookup_known_currency's docstring) rather than being
    # (mis)summarized here.

    config: dict[str, Any] = {
        "meta": {
            "title": title,
            "title_en": title,
            "brand": brand,
            "defaultLang": _resolve_language(language),
            "departure": departure_iso,
            "returnDate": return_date.strftime("%Y-%m-%d"),
            "totalDays": total_days,
            # Not derived from the intake — there's no "organizer's home
            # currency" question yet. Every real trip on this platform so far
            # is an Israeli family traveling elsewhere, so ILS is the
            # correct default today, not a guess parallel to the old "USD"
            # placeholder (which silently disabled the currency feature for
            # any USD-destination trip, home == destination).
            "homeCurrency": "ILS",
        },

        "theme": {
            "palette": "blue",
            "font": "inter",
            "rtlDefault": False,
        },
        "stats": stats,
        "participants": participants,
        "families": families,
        "phases": phases,
    }

    # Omitted entirely, not written empty, when the assistant section was
    # skipped — shared/agent-schema.js treats an absent block and an empty one
    # as different statements about the trip.
    if agent:
        config["agent"] = agent

    currency = _lookup_known_currency(destination)
    if currency:
        config["travel_info"] = {
            "countries": {
                currency["country"]: {
                    "currency": {
                        "code": currency["code"],
                        "symbol": currency["symbol"],
                        "name": currency["currency_name"],
                    },
                },
            },
        }

    # meta.home_country drives enrich_config's consular lookup (whose embassy).
    # Israel is the default there; only written when the organizer answered the
    # optional question.
    home_country = _text_value(data.get("home_country", {})).strip()
    if home_country:
        config["meta"]["home_country"] = home_country[:80]

    budget = _derive_budget(data, phases, len(participants))
    if budget:
        config["budget"] = budget

    return config


_ANCHOR_MONTHS: dict[str, int] = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}

_ANCHOR_DATE_RE = re.compile(
    r"\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b"      # 20 Sep 2026
    r"|\b(\d{4})-(\d{2})-(\d{2})\b"                       # 2026-09-25
)

# Interview anchor `type` values are free-ish; map the ones seen in real
# intakes onto the site's bookings table vocabulary, which is a hard
# CHECK(type IN ('flight','hotel','car','attraction','other')) — anything
# outside it is silently dropped by the seed's INSERT OR IGNORE, so an
# unrecognised type must fall through to "other", never pass straight through.
_BOOKING_TYPES = frozenset({"flight", "hotel", "car", "attraction", "other"})
_ANCHOR_TYPE_MAP: dict[str, str] = {
    "flight": "flight",
    "hotel": "hotel",
    "accommodation": "hotel",
    "car": "car",
    "rental": "car",
    "activity": "attraction",
    "attraction": "attraction",
    "tour": "attraction",
    "reservation": "attraction",
    "ticket": "attraction",
    "excursion": "attraction",
    # The question invites these three by name, so the model emits them; without
    # a row here they fall to "other" and a booked visit stops reading as one.
    "event": "attraction",
    "shuttle": "attraction",
    "parking": "attraction",
    "proposal": "other",
    "booking": "other",
}


def _extract_anchor_date(text: str) -> date | None:
    """First date mentioned in an anchor's free-text detail, or None.

    Recognises "20 Sep 2026" and "2026-09-25"; anything else (a bare "next
    spring", a date with no year) stays undated rather than guessed.
    """
    match = _ANCHOR_DATE_RE.search(text or "")
    if not match:
        return None
    if match.group(1):
        month = _ANCHOR_MONTHS.get(match.group(2).lower())
        if not month:
            return None
        try:
            return date(int(match.group(3)), month, int(match.group(1)))
        except ValueError:
            return None
    try:
        return date(int(match.group(4)), int(match.group(5)), int(match.group(6)))
    except ValueError:
        return None


def _first_http(*candidates: Any) -> str | None:
    """First argument that is a real http(s) URL, or None."""
    for candidate in candidates:
        text = str(candidate or "").strip()
        if _HTTP_URL_RE.match(text):
            return text
    return None


def _config_venue_link(text: Any, phases: list[Any]) -> str | None:
    """A maps / official URL for a booking row whose name or notes names one of
    the config venues. ``derive_bookings`` runs after enrichment has linked
    ``phases[].venues[]``, so this just reads those links back out — the longest
    venue-name match wins so a specific place beats a city-name collision."""
    hay = str(text or "").lower()
    if len(hay) < 4:
        return None
    best_len = 0
    best_url: str | None = None
    for phase in phases:
        if not isinstance(phase, Mapping):
            continue
        for venue in phase.get("venues") or []:
            if not isinstance(venue, Mapping):
                continue
            link = _first_http(venue.get("url"), venue.get("maps"))
            if not link:
                continue
            name = venue.get("name")
            sides = [name.get("en"), name.get("he")] if isinstance(name, Mapping) else [name]
            for side in sides:
                needle = str(side or "").strip().lower()
                if len(needle) >= 4 and needle in hay and len(needle) > best_len:
                    best_len, best_url = len(needle), link
    return best_url


def _phase_id_for_date(phases: list[dict[str, Any]], when: date) -> str | None:
    """The id of the phase whose date range contains `when`.

    Phases share boundary dates (one ends the day the next begins), so the
    range is treated half-open at the end, then inclusive as a fallback for a
    date landing on the very last day of the trip.
    """
    for closed_end in (False, True):
        for phase in phases:
            dates = phase.get("dates") or {}
            start = _parse_iso_date(dates.get("start"))
            end = _parse_iso_date(dates.get("end"))
            if not start or not end:
                continue
            if start <= when < end or (closed_end and start <= when <= end):
                return str(phase.get("id")) or None
    return None


def _stable_id(prefix: str, *parts: Any) -> str:
    """A short, deterministic id for a derived row, hashed from what the row IS.

    Both callers key something that lives OUTSIDE trip.config.json by the string
    this returns — the site's `INSERT OR IGNORE ... seed_key` for a booking row,
    the `rsvps` table for a vote — so re-provisioning the same intake has to
    produce the same string again or the row is duplicated and the votes are
    orphaned. Neither failure is loud.

    One helper rather than the same three lines twice, so a change to the
    scheme cannot be made in one caller and forgotten in the other. The joined
    parts are the caller's business; the hashing is not.
    """
    identity = "|".join(str(part or "") for part in parts)
    return f"{prefix}_{hashlib.sha1(identity.encode('utf-8')).hexdigest()[:10]}"


def _first_phase_id(phases: list[Any], default: str) -> str:
    """The phase an anchor parks on when its own date maps to none of them.

    Both anchor derivations need somewhere to put an undated item rather than
    dropping it — `bookings.phase` is `TEXT NOT NULL`, and a vote card nobody
    can see is a question nobody gets asked. `default` is what to say when the
    trip has no phases at all: a literal the site will accept for bookings,
    and "" for callers that would rather emit nothing.
    """
    return str(phases[0].get("id")) if phases and phases[0].get("id") else default


# These two are the only pieces pulled out of the walk `derive_days_from_anchors`,
# `derive_bookings` and `derive_rsvp_activities` otherwise each repeat in full:
# read `travel_anchors`, run each entry through `_read_anchor`, map its date to
# a phase, decide what to keep. Three call sites sharing a loop shape is not
# yet unified into one traversal — deliberately, a carry-forward from #169's
# review rather than an oversight. Revisit if a FOURTH consumer of
# `travel_anchors` needs the same shape; three is a coincidence, four is a
# pattern worth the indirection a shared walker would cost.


_ANCHOR_TIME_RE = re.compile(r"\bat\s+([0-2]?\d:[0-5]\d)\b", re.IGNORECASE)
_CLOCK_RE = re.compile(r"^([01]?\d|2[0-3]):[0-5]\d$")


def _anchor_label_text(text: Any) -> str:
    """An anchor's free text as it should be SHOWN: the date and the time taken
    out, because both are carried structurally beside it — printing "at 10:00"
    next to a 10:00 slot is the same fact twice.

    Split out of `_read_anchor` so the vote card's title and the detail it is
    compared against are produced by one function, rather than by two that can
    disagree about whether they are the same text.
    """
    stripped = _ANCHOR_TIME_RE.sub("", _ANCHOR_DATE_RE.sub("", str(text or "")))
    return stripped.strip(" —-—,;:").strip()


def _squash(text: Any) -> str:
    """Text reduced to what it SAYS — case folded, runs of whitespace collapsed.
    For asking whether two strings are the same sentence; never for display."""
    return " ".join(str(text or "").casefold().split())


def _read_anchor(raw: Mapping[str, Any]) -> dict[str, Any]:
    """One reading of a `travel_anchors` entry, whichever shape it arrived in.

    Two shapes reach here. The agent path writes free text —
    ``{type, detail: "Tokyo Skytree e-ticket — 20 Sep 2026 at 10:00"}`` — and
    the interpret path writes the question's own example shape (interview.ts
    `travel_anchors.dataExample`) — ``{type, name, date: "2026-09-20",
    confirmation}``, optionally ``time``. Reading only ``detail`` turned every
    anchor of the second shape into an undated "Activity" on the first phase,
    which is how four ticketed Italy attractions reached no day on 2026-09-11.

    Structured fields win where present; the free text fills what they leave
    out. Both callers read through here so they cannot disagree about what an
    anchor says.
    """
    anchor_type = str(raw.get("type") or "").strip().lower()
    detail = str(raw.get("detail") or raw.get("note") or raw.get("text") or "").strip()
    name = str(raw.get("name") or raw.get("title") or "").strip()
    stated_date = str(raw.get("date") or raw.get("date_from") or raw.get("start") or "").strip()
    when = (
        _parse_iso_date(stated_date)
        or _extract_anchor_date(stated_date)
        or _extract_anchor_date(detail)
        or _extract_anchor_date(name)
    )
    stated_time = str(raw.get("time") or "").strip()
    time_match = _ANCHOR_TIME_RE.search(f"{name} {detail}")
    clock = stated_time if _CLOCK_RE.match(stated_time) else (time_match.group(1) if time_match else None)
    # The date and time are represented structurally, so strip them from the
    # label rather than printing "at 10:00" beside a 10:00 slot.
    label = _anchor_label_text(name or detail)
    return {"type": anchor_type, "detail": detail, "name": name, "when": when,
            "time": clock, "label": label}


#: Anchor types that describe WHERE you sleep or WHAT a quote costs, not
#: something that happens at a time on a day. Hotels already own the phase's
#: `accommodation`; a proposal is a whole-trip figure.
_NON_ITINERARY_ANCHORS = {"hotel", "car", "proposal"}


def derive_days_from_anchors(
    config: Mapping[str, Any], data: Mapping[str, Any]
) -> dict[str, list[dict[str, Any]]]:
    """A day-by-day built from the anchors, deterministically. No model.

    `phases[].days[]` had exactly one producer — `extract_itinerary`, an LLM
    pass over an uploaded document — and it is unreachable from the chat-scoped
    interview (no `_for_chat` twin), so no control-plane trip has ever had one.
    Meanwhile the organizer's plan was already sitting in `travel_anchors`,
    dated, timed and structured:

        activity | Tokyo Skytree e-ticket — 20 Sep 2026 at 10:00
        activity | TeamLab Planets — 20 Sep 2026 at 18:00
        activity | Sagano Romantic Train, one-way — 25 Sep 2026 at 14:02

    Nothing about turning that into days needs a model. The date parsing and
    the date→phase mapping are the same ones `derive_bookings` has been using
    correctly all along; this reuses them rather than adding a second parser
    that can disagree with the first.

    Returns {phase_id: days[]}. Only anchors that are events are used —
    a hotel is the phase's `accommodation`, not a thing you do at 10:00.

    DELIBERATELY NOT a replacement for document extraction. This can only
    surface what the organizer stated as a discrete dated item; a PDF's prose
    itinerary is richer and still wants `extract_itinerary`. When both exist
    the extracted days win (see the caller) — this fills the gap, it does not
    compete for the slot.
    """
    phases = list(config.get("phases") or [])
    by_phase: dict[str, dict[str, list[dict[str, Any]]]] = {}

    for raw in _structured_list(data, "travel_anchors"):
        if not isinstance(raw, dict):
            continue
        anchor = _read_anchor(raw)
        if anchor["type"] in _NON_ITINERARY_ANCHORS:
            continue
        when = anchor["when"]
        if not when:
            continue  # undated: it is a booking, not a moment in the plan
        phase_id = _phase_id_for_date(phases, when)
        if not phase_id:
            continue  # outside every phase — the Bookings tab still shows it
        label = anchor["label"]
        if not label:
            continue
        day = by_phase.setdefault(phase_id, {}).setdefault(when.isoformat(), [])
        day.append({"time": anchor["time"], "text": {"he": label, "en": label}})

    out: dict[str, list[dict[str, Any]]] = {}
    for phase_id, days in by_phase.items():
        rendered = []
        for iso, items in sorted(days.items()):
            # Timed items first in clock order, undated-within-the-day last —
            # "some time that day" reads correctly at the bottom, not at 00:00.
            items.sort(key=lambda i: (i["time"] is None, i["time"] or ""))
            rendered.append({"date": iso, "items": items})
        out[phase_id] = rendered
    return out


#: The canonical anchor type that names something you DO, rather than where you
#: sleep, how you get there, or what a quote costs. Read through
#: _ANCHOR_TYPE_MAP rather than against a second list of words, so every member
#: that map gains ("event", "shuttle" and "parking" arrived in #109) arrives
#: here the same day — a taxonomy short a member is the shape of #115.
_VOTABLE_ANCHOR_TYPE = "attraction"


def derive_rsvp_activities(
    config: Mapping[str, Any], data: Mapping[str, Any]
) -> dict[str, list[dict[str, Any]]]:
    """The family's "shall we actually do this?" list, per phase, from the
    anchors. No model.

    `phases[].rsvp_activities[]` had no producer at all. The site has rendered
    vote cards since the hand-authored era (`site/app.js` renderRsvpCard;
    trip-web's `GroupActivities`), `server/server.js` has stored the answers in
    `rsvps`, and the config schema has carried the field — and this transformer
    never wrote it, so the whole RSVP surface was invisible on every provisioned
    trip. The live-trip report put it as "RSVP/trivia features: unused".

    WHICH ANCHORS. Attraction-typed ones carrying NO confirmation. That is this
    file's own existing line rather than a new one: an anchor is a fixed point
    in the trip, not evidence of a booking, and the schema's rule is that a
    confirmation is what makes it one (see the confirmed-count stat in
    `transform_intake`, and `_has_confirmation`, which already reads a
    placeholder as absent). A CONFIRMED attraction is already happening —
    tickets bought, seats held — so asking the family to vote on it is asking a
    question whose answer changes nothing; it belongs on the Bookings tab only.
    An UNCONFIRMED one is exactly where "does everyone want this?" is real.

    DELIBERATELY NOT EXCLUSIVE with `derive_bookings`. The same unconfirmed
    anchor stays a Bookings row AND becomes a vote. Two views of one fact, not
    duplication to be removed: Bookings is the organizer's tracking view ("what
    is still pending"), RSVP is the family-facing interactive one ("does
    everyone want it"). Changing either to hide the other loses a real surface.

    THE ID IS THE VOTE'S PRIMARY KEY. `rsvps` is keyed by the activity id string
    alone (`/api/rsvps/:activityId`) and knows nothing about trip.config.json,
    so an id that moves on re-provision does not fail loudly — it orphans every
    vote already cast and the card comes back empty with nobody told. So it is a
    hash of what the anchor IS, through the same `_stable_id` `derive_bookings`
    keys its rows with — over the name, the stated date and the free text
    TOGETHER, because a structured anchor states all three and keying on any one
    of them lets two different activities collide on one vote record.

    Two fields are deliberately left out of that identity, for the same reason
    in both cases: they cannot tell two of these anchors apart, and they CAN
    change under one. The confirmation, because everything here is unconfirmed
    by construction and so it holds only "" or a placeholder — an organizer
    tidying an empty field into "TBD" must not move a live vote. And the type
    word, because the filter above has already fixed the canonical type at
    "attraction", so all the raw word could contribute is the synonym drift
    between two extraction runs of one document ("activity" this time,
    "attraction" the next).

    `item_uid` is left unset: there is no itinerary item an anchor is a link to
    (the field exists for a day-plan item marked votable), and the schema's own
    legacy case omits it. `activity-rsvp.ts` then matches by phase, date and
    exact title — which lines up, because the title here is the same `_read_anchor`
    label `derive_days_from_anchors` puts on the day.

    Returns {phase_id: activities[]}, date order with the undated last.
    """
    phases = list(config.get("phases") or [])
    fallback_phase = _first_phase_id(phases, "")
    by_phase: dict[str, list[dict[str, Any]]] = {}
    seen: set[str] = set()

    for raw in _structured_list(data, "travel_anchors"):
        if not isinstance(raw, dict):
            continue
        anchor = _read_anchor(raw)
        if _ANCHOR_TYPE_MAP.get(anchor["type"]) != _VOTABLE_ANCHOR_TYPE:
            continue
        if _has_confirmation(raw):
            continue
        title = _bilingual_text(anchor["label"])
        if not title:
            continue  # nothing to put on the card; a bare type is not a question
        when = anchor["when"]
        # Undated, or dated outside every phase: parked on the first phase,
        # exactly where `derive_bookings` already parks the same anchor's row.
        # Dropping it instead would hide the MOST vote-worthy case — an
        # attraction nobody has booked or even scheduled — from the surface
        # built to ask about it, and the family already sees it on phase 1.
        phase_id = (_phase_id_for_date(phases, when) if when else None) or fallback_phase
        if not phase_id:
            continue
        # EVERY field the anchor states, not the first one that is non-empty.
        # A structured anchor can carry name, date AND detail at once (the
        # document-extraction path writes all three), so keying on `detail`
        # alone would give two different activities that happen to share a notes
        # line one id — and the dedupe below would then silently drop the second
        # one's card.
        #
        # The date is `_read_anchor`'s PARSED one, not the raw field: it is the
        # same date whether the organizer's document said "20 Sep 2026" or
        # "2026-09-20", and it is still there when the anchor states it as
        # `date_from` or `start` — both shapes this file already reads, and
        # both of which a raw `date` lookup would read as blank, colliding one
        # activity's two dates onto one vote.
        #
        # Two fields are deliberately absent, for one reason twice: neither can
        # tell two of THESE anchors apart, and both can change under one. The
        # canonical type, because the filter above has already fixed it at
        # "attraction", so all the raw word could add is the synonym drift
        # between two extraction runs ("activity" this time, "attraction" the
        # next). The confirmation, because everything here is unconfirmed.
        activity_id = _stable_id(
            "rsvp", anchor["name"], when.isoformat() if when else "", anchor["detail"],
        )
        if activity_id in seen:
            continue  # one activity, one vote record — never two cards sharing one
        seen.add(activity_id)
        activity: dict[str, Any] = {"id": activity_id, "title": title}
        # Only when it says something the title does not. A free-text anchor's
        # label IS its detail, and a document pass that copies the venue name
        # into a notes field produces the same text twice — either way a desc
        # would print the heading again directly under the heading. Compared
        # after the same date/time stripping the title had, so "Sky Lagoon" and
        # "Sky Lagoon — 5 Mar 2027" are recognised as the one sentence they are.
        desc = _bilingual_text(_anchor_label_text(anchor["detail"]))
        if desc and _squash(desc["en"]) == _squash(title["en"]):
            desc = None
        if desc:
            activity["desc"] = desc
        if when:
            activity["date"] = when.isoformat()
        by_phase.setdefault(phase_id, []).append(activity)

    for activities in by_phase.values():
        activities.sort(key=lambda a: ("date" not in a, a.get("date") or ""))
    return by_phase


def _same_place(a: str, b: str) -> bool:
    """Whether two booking names name the same place: "Hotel Artemide" and
    "Hotel Artemide, Rome" do; "OMO3 Asakusa" and "Park Hyatt Tokyo" do not."""
    def norm(text: str) -> str:
        return " ".join(re.sub(r"[^\w\s]", " ", text.casefold()).split())
    x, y = norm(a), norm(b)
    return bool(x and y) and (x in y or y in x)


def derive_bookings(
    config: Mapping[str, Any],
    data: Mapping[str, Any],
    documents: Any = None,
) -> list[dict[str, Any]]:
    """Build bookings.json rows from an already-transformed config plus the raw
    intake answers.

    Two sources, both otherwise lost to the site:
      * one `hotel` row per phase that has an accommodation — carrying whatever
        confirmation the intake had, or `null` so the row still shows as
        "not confirmed" rather than being omitted;
      * one row per `travel_anchors[]` entry (dated activity tickets, a tour
        proposal), typed via _ANCHOR_TYPE_MAP, with any date parsed out of the
        free text and mapped back to the phase it falls in.

    Every row carries a deterministic `seed_key` so re-provisioning the same
    intake is idempotent against the site's `INSERT OR IGNORE ... seed_key`.

    `documents` (a `document_handoff.DocumentLinks`) adds `conf_file` — the
    published source document — to a row whose provenance names one. Without it
    no row carries the key at all, exactly as before.

    `bookings.phase` is `TEXT NOT NULL` on the site, so an anchor that maps to
    no phase (undated, or a whole-trip proposal) is parked on the first phase
    rather than dropped — it still shows on the Bookings tab, which is the
    point.
    """
    phases = list(config.get("phases") or [])
    fallback_phase = _first_phase_id(phases, "trip")
    bookings: list[dict[str, Any]] = []
    hotel_row: dict[str, dict[str, Any]] = {}

    for phase in phases:
        accommodation = phase.get("accommodation")
        if not isinstance(accommodation, dict) or not accommodation.get("name"):
            continue
        dates = phase.get("dates") or {}
        hotel_name = str(accommodation.get("name_en") or accommodation["name"])
        bookings.append({
            "phase": str(phase.get("id")) or None,
            "type": "hotel",
            "name": hotel_name,
            "date_from": dates.get("start"),
            "date_to": dates.get("end"),
            "passengers": None,
            "confirmation": accommodation.get("confirmation"),
            "notes": None,
            "cost": 0,
            # The map link enrichment already anchored on this hotel (name
            # search, so it survives a shaky geocode) — carry it so the
            # Bookings tab's 📍 badge points somewhere.
            "location_url": (
                _first_http(accommodation.get("mapsUrl"), accommodation.get("maps"))
                or _config_venue_link(hotel_name, phases)
            ),
            "seed_key": f"hotel_{phase.get('id')}",
        })
        hotel_row[str(phase.get("id"))] = bookings[-1]
        stay_file = documents.for_phase(str(phase.get("id"))) if documents is not None else None
        if stay_file:
            bookings[-1]["conf_file"] = stay_file

    for index, raw in enumerate(_structured_list(data, "travel_anchors")):
        if not isinstance(raw, dict):
            continue
        anchor = _read_anchor(raw)
        detail, anchor_type = anchor["detail"], anchor["type"]
        if not detail and not anchor_type and not anchor["name"]:
            continue
        # A "proposal" is a whole-trip quote, not a dated item — any date inside
        # it is a range endpoint, so don't pin it to a single day or phase.
        when = None if anchor_type == "proposal" else anchor["when"]
        name = _shorten_phase_name(anchor["name"] or detail, max_length=60) if (anchor["name"] or detail) else ""
        phase_id = _phase_id_for_date(phases, when) if when else None
        # The same hotel often arrives twice — as the phase's accommodation and
        # as a dated anchor holding the booking number. One row, carrying the
        # number; a different hotel in the same phase is a split stay and keeps
        # its own.
        own = hotel_row.get(phase_id or "")
        anchor_file = documents.for_anchor(index) if documents is not None else None
        if own and _ANCHOR_TYPE_MAP.get(anchor_type) == "hotel" and _same_place(own["name"], name):
            own["confirmation"] = own["confirmation"] or raw.get("confirmation")
            # The voucher behind the anchor is the voucher behind the stay.
            if anchor_file and not own.get("conf_file"):
                own["conf_file"] = anchor_file
            continue
        # A free-text anchor keeps the key it has always had, so re-provisioning
        # an existing trip stays idempotent. A structured one has no `detail`;
        # hashing the type alone gave every "activity" the SAME key, and the
        # site's INSERT OR IGNORE kept one of them.
        identity = (detail,) if detail else (
            anchor_type, anchor["name"], raw.get("date") or "", raw.get("confirmation") or "",
        )
        bookings.append({
            "phase": phase_id or fallback_phase,
            "type": _ANCHOR_TYPE_MAP.get(anchor_type, "other"),
            "name": name or anchor_type.title() or "Booking",
            "date_from": when.isoformat() if when else None,
            "date_to": None,
            "passengers": None,
            "confirmation": raw.get("confirmation"),
            "notes": detail or None,
            "cost": 0,
            # If the anchor names a venue the itinerary already links, reuse
            # that link rather than leaving the row with a bare 📍.
            "location_url": _config_venue_link(f"{name} {detail}", phases),
            "seed_key": _stable_id("anchor", *identity),
        })
        if anchor_file:
            bookings[-1]["conf_file"] = anchor_file

    return bookings
