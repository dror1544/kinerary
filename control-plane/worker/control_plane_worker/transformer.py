"""Intake transformer: converts confirmed intake answers into trip.config.json.

This is a pure function module with no I/O. The provisioner feeds it the
answers dict from intake_versions.data and gets back a dict ready to be
serialized as trip.config.json for the Kinerary trip site.

Intake question IDs (INTAKE_SCHEMA_VERSION = 1):
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
                 not-yet-built enrichment pass, not this transformer's job)
  travel_anchors structured (array): optional booked flights/hotels/cars;
                 folded into stats as a compact summary, not yet a
                 first-class trip.config.json section
  constraints    structured (object): optional mobility/dietary/budget/
                 family notes; folded into stats the same way
"""
from __future__ import annotations

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
    if answer.get("kind") == "choice":
        return _GROUP_SIZE_LABELS.get(answer.get("option_id", ""), str(answer.get("option_id", "")))
    return str(answer.get("other_text") or "")


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


def _parse_iso_date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None


_FAMILY_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "", value.strip().lower())
    return slug or "traveler"


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
        family_key = _slugify(str(raw.get("family") or "traveler"))

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
                "name": {"he": str(raw.get("family") or family_key), "en": str(raw.get("family") or family_key)},
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


def _derive_phases(phases: list[Any]) -> list[dict[str, Any]]:
    """Turns the phases[] intake answer into trip.config.json's phases[]
    shape — logistics fields only (id/title/dates/accommodation). Hero
    images, map coordinates and day-by-day itineraries need external lookups
    this transformer deliberately doesn't perform (see module docstring).
    """
    result: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for index, raw in enumerate(phases):
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or raw.get("name_en") or "").strip()
        if not name:
            continue
        name_en = str(raw.get("name_en") or name).strip()

        phase_id = _slugify(name_en or name)
        if phase_id in used_ids:
            phase_id = f"{phase_id}{index}"
        used_ids.add(phase_id)

        phase: dict[str, Any] = {
            "id": phase_id,
            "title": {"he": name, "en": name_en},
        }
        start = _parse_iso_date(raw.get("start"))
        end = _parse_iso_date(raw.get("end"))
        if start and end:
            phase["dates"] = {"start": start.isoformat(), "end": end.isoformat()}

        accommodation = raw.get("accommodation")
        if isinstance(accommodation, dict) and accommodation.get("name"):
            acc_name = str(accommodation["name"])
            phase["accommodation"] = {
                "name": acc_name,
                "name_en": str(accommodation.get("name_en") or acc_name),
            }
            if accommodation.get("confirmation"):
                phase["accommodation"]["confirmation"] = str(accommodation["confirmation"])

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

    # Precise dates from the interview take priority over the placeholder
    # duration-based guess — older confirmed intakes (pre-dating these
    # questions) fall back to the original 90-days-from-today logic.
    explicit_departure = _parse_iso_date(_text_value(data.get("departure_date", {})))
    explicit_return = _parse_iso_date(_text_value(data.get("return_date", {})))
    if explicit_departure and explicit_return and explicit_return > explicit_departure:
        departure_date = explicit_departure
        return_date = explicit_return
        total_days = (return_date - departure_date).days
    else:
        departure_date = today + timedelta(days=90)
        total_days = _resolve_duration_days(data["trip_duration"])
        return_date = departure_date + timedelta(days=total_days)

    title = f"{destination} — {trip_type_label}"
    departure_iso = datetime(
        departure_date.year, departure_date.month, departure_date.day,
        0, 0, 0, tzinfo=timezone.utc,
    ).isoformat()

    stats: list[dict[str, Any]] = [
        {
            "number": group_size_label,
            "description": {"en": f"{group_size_label} traveler(s)"},
        },
        {
            "number": str(total_days),
            "description": {"en": f"{total_days} days in {destination}"},
        },
    ]

    interests = _text_value(data.get("trip_interests", {})).strip()
    if interests:
        stats.append({
            "number": "✦",
            "description": {"en": interests[:120]},
        })

    travelers = _structured_list(data, "travelers")
    participants, families = _derive_participants_and_families(travelers)

    phases = _derive_phases(_structured_list(data, "phases"))

    travel_anchors = _structured_list(data, "travel_anchors")
    if travel_anchors:
        stats.append({
            "number": str(len(travel_anchors)),
            "description": {"en": "booking(s) already confirmed"},
        })

    constraints = _structured_dict(data, "constraints")
    constraint_notes = [str(v).strip() for v in constraints.values() if str(v or "").strip()]
    if constraint_notes:
        stats.append({
            "number": "!",
            "description": {"en": "; ".join(constraint_notes)[:120]},
        })

    return {
        "meta": {
            "title": title,
            "title_en": title,
            "brand": "KINERARY",
            "defaultLang": "en",
            "departure": departure_iso,
            "returnDate": return_date.strftime("%Y-%m-%d"),
            "totalDays": total_days,
            "homeCurrency": "USD",
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
