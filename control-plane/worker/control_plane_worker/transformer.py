"""Intake transformer: converts confirmed intake answers into trip.config.json.

This is a pure function module with no I/O. The provisioner feeds it the
answers dict from intake_versions.data and gets back a dict ready to be
serialized as trip.config.json for the Kinerary trip site.

Intake question IDs (INTAKE_SCHEMA_VERSION = 1):
  trip_type     choice: family / group_of_families / couple / other
  destination   text: free-form location
  group_size    choice: 2 / 3_to_5 / 6_to_10 / more_than_10 / other
  trip_duration choice: weekend / week / two_weeks / month_or_more / other
  trip_interests text: optional free-form interests
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
    departure_date = today + timedelta(days=90)
    destination = _text_value(data["destination"]).strip() or "Unknown Destination"
    trip_type_label = _resolve_trip_type(data["trip_type"])
    group_size_label = _resolve_group_size(data["group_size"])
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
        "participants": [],
        "families": [],
        "phases": [],
    }
