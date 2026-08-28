"""Intake transformer: converts confirmed intake answers into trip.config.json.

This is a pure function module with no I/O. The provisioner feeds it the
answers dict from intake_versions.data and gets back a dict ready to be
serialized as trip.config.json for the Kinerary trip site.

Intake question IDs (INTAKE_SCHEMA_VERSION = 2):
  trip_type      choice: family / group_of_families / couple / other
  destination    text: free-form location
  group_size     choice: 2 / 3_to_5 / 6_to_10 / more_than_10 / other
  trip_duration  choice: weekend / week / two_weeks / month_or_more / other
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
  organizer_identity text: matched to a participant username for
                 agent.organizers; no match means no organizers key at all
  bot_name       text: assistant's display name; absent = no persona written
  bot_gender     choice: male/female/neutral (Hebrew verb conjugation)
  bot_tone       choice: warm/playful/dry
  bot_proactive  multi_choice: which unprompted messages it may send
  bot_limits     structured (array): [{he, en}] standing instructions

Everything the v2 questions write into `agent.standing_instructions[]` carries
`visibility: "organizer"` — see _instruction() for why that is blanket rather
than per-field.

Hero `meta.brand`/`meta.title` are derived from destination + trip type + the
departure year (e.g. "USA 2026"), not a fixed value — the site renders
`meta.brand` as its main, prominent heading (see server/server.js and
site/app.js's applyBrandFromConfig()). `meta.homeCurrency` and
`travel_info.countries[*].currency` are a small static stopgap for the site's
currency-conversion feature; see _lookup_known_currency's docstring for what's
still missing.
"""
from __future__ import annotations

import hashlib
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Mapping

# Required question IDs that must be present in the intake data.
REQUIRED_QUESTIONS = frozenset({"trip_type", "destination", "group_size", "trip_duration"})

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


def _resolve_group_size(answer: Mapping[str, Any]) -> str:
    """Returns a short stat number for the group size: the option label for a
    choice answer, or the leading digit run from 'other' free text (e.g. "17"
    out of "17 total; 7 for some parts of the trip") rather than the whole
    organizer sentence — the Hero stat strip shows a number, not a quote.
    """
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
    total_days = _resolve_duration_days(data["trip_duration"])
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


def _lookup_known_currency(destination: str) -> dict[str, str] | None:
    """Static country-name -> currency lookup for well-known destinations.

    This is a deliberately small stopgap, not the real fix: the actual
    destination-info enrichment (currency, health/money tips, hospitals,
    packing) was scoped as its own deterministic pass in
    `.hermes/plans/2026-08-06_063428-post-interview-enrichment-and-provisioning.md`
    and never implemented or wired into this provisioner. This lookup exists
    only so the site's currency-conversion feature (server/server.js's
    HOME_CURRENCY/destinationCurrencyCodes, gated on travel_info.countries)
    isn't unconditionally broken for every control-plane-provisioned trip
    until that enrichment pass exists for real.
    """
    return _KNOWN_COUNTRY_CURRENCY.get(destination.strip().lower())


_MULTI_PLACE_RE = re.compile(r",|&| and |/")


def _derive_brand_and_title(destination: str, trip_type_label: str, year: int) -> tuple[str, str]:
    """Derives a short Hero brand ("USA 2026") and a longer title ("USA 2026 —
    Group of Families") from the destination and trip type.

    A single, short destination becomes the brand subject directly. A
    destination that reads as multiple places (joined with a comma, "&", "/",
    or "and"), or is just long, falls back to the trip type as a thematic
    subject instead ("Family Trip 2026"), since a list of cities makes an
    unreadable brand.
    """
    is_multi_place = bool(_MULTI_PLACE_RE.search(destination))
    short_destination = _shorten_phase_name(destination, max_length=20)
    if not is_multi_place and short_destination == destination.strip() and short_destination:
        subject = short_destination
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
        # nothing; the year still distinguishes it and the caller de-duplicates.
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
_AGENT_TONES = frozenset({"warm", "playful", "dry"})


def _instruction(text: dict[str, str]) -> dict[str, Any]:
    """Wraps bilingual text as a standing instruction.

    Every instruction this transformer writes is organizer-only, without
    exception. shared/agent-schema.js makes that the blanket default so nobody
    has to judge, field by field, which instructions look harmless enough to
    publish — and the two failure modes are wildly lopsided: an over-hidden
    instruction is a slightly less chatty bot, an over-shared one puts a
    private fact about a named family member on an endpoint every logged-in
    member (children included) can read. The bot still reads and acts on
    organizer-only material, so nothing is actually lost by staying silent.
    """
    return {"visibility": "organizer", "text": text}


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

    scope = _structured_dict(data, "dietary_scope")
    by_name: dict[str, dict[str, Any]] = {}
    for p in participants:
        for key in (p.get("name"), p.get("name_en"), p.get("username")):
            if isinstance(key, str) and key.strip():
                by_name.setdefault(key.strip().casefold(), p)

    instructions: list[dict[str, Any]] = []
    for option_id in selected:
        mapped = _DIETARY_NEEDS.get(option_id)
        if mapped is None:
            continue
        need_type, severity, text = mapped
        who = scope.get(option_id)

        names = who if isinstance(who, list) else []
        matched = [p for name in names if (p := by_name.get(str(name).strip().casefold()))]

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
            }))
            continue

        for participant in matched:
            participant.setdefault("needs", []).append({
                "type": need_type,
                "severity": severity,
                "text": dict(text),
            })

    return instructions


def _resolve_organizers(data: Mapping[str, Any], participants: list[dict[str, Any]]) -> list[str]:
    """Matches the organizer_identity answer to a participant username.

    Returns [] rather than a best guess when nothing matches. driver.mjs hard
    fails on an organizer absent from participants[], so an invented username
    yields a config that cannot deploy at all; and a username that happens to
    belong to *someone else* silently hands them the organizer's private
    channel. No organizer block is the recoverable failure of the three.
    """
    answer = data.get("organizer_identity")
    stated = _text_value(answer).strip() if isinstance(answer, Mapping) else ""
    if not stated:
        return []
    needle = stated.casefold()
    for participant in participants:
        candidates = {
            str(participant.get("name", "")).strip().casefold(),
            str(participant.get("name_en", "")).strip().casefold(),
            str(participant.get("username", "")).strip().casefold(),
        }
        if needle in candidates and needle:
            return [participant["username"]]
    return []


def _derive_agent(
    data: Mapping[str, Any],
    participants: list[dict[str, Any]],
    dietary_instructions: list[dict[str, Any]],
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

    name = _text_value(data["bot_name"]).strip() if isinstance(data.get("bot_name"), Mapping) else ""
    if name:
        agent["name"] = name
        agent["name_en"] = name
        gender = _text_value(data["bot_gender"]) if isinstance(data.get("bot_gender"), Mapping) else ""
        # Hebrew conjugates by gender, so the assistant cannot build a sentence
        # without one. 'neutral' (gender-avoidant phrasing) is the honest
        # fallback for "wasn't asked"; guessing from the name would be wrong in
        # every message it got wrong.
        agent["gender"] = gender if gender in _AGENT_GENDERS else "neutral"
        tone = _text_value(data["bot_tone"]) if isinstance(data.get("bot_tone"), Mapping) else ""
        agent["tone"] = tone if tone in _AGENT_TONES else "warm"
        agent["default_language"] = "en"

    tz = _text_value(data["timezone"]).strip() if isinstance(data.get("timezone"), Mapping) else ""
    if tz:
        agent["timezone"] = tz

    proactive = {
        key: _PROACTIVE_VALUES[key]
        for key in _multi_choice_ids(data, "bot_proactive")
        if key in _PROACTIVE_VALUES
    }
    if proactive:
        agent["proactive"] = proactive

    instructions = list(dietary_instructions)
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
    if instructions:
        agent["standing_instructions"] = instructions

    return agent or None


def _phase_note_text(short: str, originals: list[str]) -> str:
    """Joins whichever original phase name(s) carried more than just the
    short label into one note. Context trimmed from the title (an event, a
    sub-group, a route detail) isn't discarded — it belongs in the site's
    phase detail view, not a nav tab, so it's kept here instead.
    """
    seen: set[str] = set()
    unique: list[str] = []
    for original in originals:
        text = original.strip()
        if not text or text.lower() == short.strip().lower() or text in seen:
            continue
        seen.add(text)
        unique.append(text)
    return "; ".join(unique)


def _derive_phases(phases: list[Any]) -> list[dict[str, Any]]:
    """Turns the phases[] intake answer into trip.config.json's phases[]
    shape — logistics fields only (id/title/dates/accommodation/note). Hero
    images, map coordinates and day-by-day itineraries need external lookups
    this transformer deliberately doesn't perform (see module docstring).

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

        note_he = _phase_note_text(entry["short_he"], entry["notes_he"])
        note_en = _phase_note_text(entry["short_en"], entry["notes_en"])
        if note_he or note_en:
            phase["note"] = {"he": note_he or note_en, "en": note_en or note_he}

        result.append(phase)
    return result


def transform_intake(
    data: Mapping[str, Any],
    today: date | None = None,
) -> dict[str, Any]:
    """Convert intake answers into a trip.config.json dict.

    Raises ValueError if any required question is missing.
    The departure date is set to 90 days from *today* (or the supplied
    reference date); this is a placeholder the organizer refines later via
    the intake correction path.
    """
    missing = REQUIRED_QUESTIONS - set(data.keys())
    if missing:
        raise ValueError(f"intake is missing required questions: {sorted(missing)}")

    today = today or date.today()
    destination = _text_value(data["destination"]).strip() or "Unknown Destination"
    trip_type_label = _resolve_trip_type(data["trip_type"])
    group_size_label = _resolve_group_size(data["group_size"])

    departure_date, return_date, total_days = _resolve_dates(data, today)

    brand, title = _derive_brand_and_title(destination, trip_type_label, departure_date.year)
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
    agent = _derive_agent(data, participants, dietary_instructions)

    phases = _derive_phases(_structured_list(data, "phases"))

    # Only a count, never the organizer's free text — same reasoning as above.
    travel_anchors = _structured_list(data, "travel_anchors")
    if travel_anchors:
        stats.append({
            "number": str(len(travel_anchors)),
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
            "defaultLang": "en",
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


def derive_bookings(config: Mapping[str, Any], data: Mapping[str, Any]) -> list[dict[str, Any]]:
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

    `bookings.phase` is `TEXT NOT NULL` on the site, so an anchor that maps to
    no phase (undated, or a whole-trip proposal) is parked on the first phase
    rather than dropped — it still shows on the Bookings tab, which is the
    point.
    """
    phases = list(config.get("phases") or [])
    fallback_phase = str(phases[0].get("id")) if phases and phases[0].get("id") else "trip"
    bookings: list[dict[str, Any]] = []

    for phase in phases:
        accommodation = phase.get("accommodation")
        if not isinstance(accommodation, dict) or not accommodation.get("name"):
            continue
        dates = phase.get("dates") or {}
        bookings.append({
            "phase": str(phase.get("id")) or None,
            "type": "hotel",
            "name": str(accommodation.get("name_en") or accommodation["name"]),
            "date_from": dates.get("start"),
            "date_to": dates.get("end"),
            "passengers": None,
            "confirmation": accommodation.get("confirmation"),
            "notes": None,
            "cost": 0,
            "seed_key": f"hotel_{phase.get('id')}",
        })

    for raw in _structured_list(data, "travel_anchors"):
        if not isinstance(raw, dict):
            continue
        detail = str(raw.get("detail") or raw.get("note") or raw.get("text") or "").strip()
        anchor_type = str(raw.get("type") or "").strip().lower()
        if not detail and not anchor_type:
            continue
        # A "proposal" is a whole-trip quote, not a dated item — any date inside
        # it is a range endpoint, so don't pin it to a single day or phase.
        when = None if anchor_type == "proposal" else _extract_anchor_date(detail)
        name = _shorten_phase_name(detail, max_length=60) if detail else ""
        phase_id = _phase_id_for_date(phases, when) if when else None
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
            "seed_key": "anchor_" + hashlib.sha1(
                (detail or anchor_type).encode("utf-8")
            ).hexdigest()[:10],
        })

    return bookings
