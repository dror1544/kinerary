"""Print the trip.config.json the provisioner would ship, as JSON on stdout.

Used by tests/config-allow-list.test.js (issue #172): the trip site serves a
config through an ALLOW-list (shared/config-visibility.js), so a field the
provisioner starts emitting that the list does not name would silently vanish
from every provisioned trip's site. The test feeds this output through the
allow-list and fails on anything it drops.

It runs the real producers, in the order the provisioner runs them
(control-plane/worker/control_plane_worker/provisioner.py): transform_intake,
then enrich_config — with every network lookup replaced by a canned answer, so
the run is deterministic and offline. Both are standard library only, so any
python3 that can run the worker's own tests can run this.

The intakes are deliberately wide rather than realistic: the point is to make
the producers emit every field they are able to, on BOTH of the paths that
reach transformer.py — the agentless interview (`phases[].planned: [str]`) and
the agent/document path (`phases[].venues: [{name, url, area}]`).
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

WORKER = Path(__file__).resolve().parents[2] / "control-plane" / "worker"
sys.path.insert(0, str(WORKER))

from control_plane_worker.enrichment import enrich_config  # noqa: E402
from control_plane_worker.transformer import transform_intake  # noqa: E402


def _choice(option_id):
    return {"kind": "choice", "option_id": option_id, "schema_version": 1, "other_text": None}


def _text(value):
    return {"kind": "text", "schema_version": 1, "text": value}


def _structured(value):
    return {"kind": "structured", "schema_version": 1, "data": value}


def _multi(*option_ids):
    return {"kind": "multi_choice", "option_ids": list(option_ids), "schema_version": 2, "other_text": None}


TRAVELERS = _structured([
    {"name": "Eitan Sagi", "age": 52, "family": "Sagi"},
    {"name": "Noa Sagi", "age": 19, "family": "Sagi"},
    {"name": "Omri Levi", "age": 10, "family": "Levi"},
    {"name": "Dana Levi", "age": 41, "family": "Levi"},
])

# Agent/document path: venues carry name/url/area; days are dated; a hotel with
# a confirmation.
PHASES_WITH_VENUES = _structured([
    {
        "name": "Tokyo", "name_en": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
        "accommodation": {"name": "Hotel Gracery", "name_en": "Hotel Gracery", "confirmation": "GR-1"},
        "days": [
            {"date": "2026-09-20", "label": {"he": "יום עיר", "en": "City day"},
             "items": [{"time": "10:00", "text": {"he": "סקייטרי", "en": "Tokyo Skytree"}},
                       {"text": {"he": "ארוחת ערב", "en": "Dinner"}}]},
        ],
        "venues": [
            {"name": {"he": "סקייטרי", "en": "Tokyo Skytree"}, "url": "https://www.tokyo-skytree.jp/en/", "area": "Sumida"},
            {"name": "TeamLab Planets"},
            {"name": "Senso-ji"},
        ],
    },
    {"name": "Kyoto", "start": "2026-09-24", "end": "2026-09-27",
     "accommodation": {"name": "Cross Hotel"}},
])

# Agentless path: `planned` place names, no venues, no days.
PHASES_WITH_PLANNED = _structured([
    {"name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23", "planned": ["Tokyo Skytree", "Meiji Shrine"]},
    {"name": "Osaka", "start": "2026-09-26", "end": "2026-09-29"},
])

COMMON = {
    "trip_type": _choice("group_of_families"),
    "destination": _text("Japan"),
    "group_size": _choice("4"),
    "departure_date": _text("2026-09-18"),
    "return_date": _text("2026-09-30"),
    "trip_interests": _text("temples, matcha, onsen"),
    "travelers": TRAVELERS,
    "home_country": _text("Israel"),
    "trip_pace": _choice("balanced"),
    "dietary": _multi("vegetarian", "nut_allergy", "kosher"),
    "dietary_scope": _structured({"vegetarian": ["Noa"], "nut_allergy": ["Omri"], "kosher": "everyone"}),
    "dietary_visibility": _choice("group"),
    "bot_name": _text("ויקטור"),
    "bot_gender": _choice("male"),
    "bot_tone": _choice("playful"),
    "bot_proactive": _multi("morning_briefing", "tomorrow_preview", "photo_recap", "flight_changes", "packing_reminders"),
    "bot_limits": _structured([{"he": "להימנע מפוליטיקה", "en": "Avoid politics"}]),
    "timezone": _text("Asia/Tokyo"),
    "organizer_identity": _text("Eitan"),
    "planning_help": _text("still need to book the ryokan"),
    "travel_anchors": _structured([
        {"type": "flight", "name": "TLV-NRT", "date": "2026-09-18", "confirmation": "LY-91"},
        {"type": "attraction", "name": "Tokyo Skytree", "date": "2026-09-20", "confirmation": "TK-1"},
        {"type": "attraction", "name": "Sky Lagoon", "date": "2026-09-25"},
    ]),
    "budget_detail": _structured({
        "currency": "USD", "party_size": 4,
        "items": [
            {"phase": "Kyoto", "category": "hotel", "description": "Cross Hotel x 3", "amount": 900},
            {"category": "flight", "description": "TLV-NRT x 4", "amount": 0, "estimate": True},
        ],
    }),
}


class FakeHttp:
    ROUTES = {
        "countries.dev": [{
            "name": "Japan", "capital": "Tokyo", "flag": "\U0001F1EF\U0001F1F5", "alpha2Code": "JP",
            "currencies": [{"code": "JPY", "name": "Japanese yen", "symbol": "¥"}],
            "callingCodes": ["81"],
        }],
        "emergencynumberapi.com": {"data": {
            "police": {"all": ["110"]}, "ambulance": {"all": ["119"]}, "fire": {"all": ["119"]},
            "dispatch": {"all": [""]}, "member_112": False,
        }},
        "nominatim.openstreetmap.org": [{
            "lat": "35.6764", "lon": "139.6500", "display_name": "1 Example St, Tokyo, Japan",
            "extratags": {"website": "https://example.org/place"},
        }],
        "wikipedia.org": {"originalimage": {"source": "https://upload.wikimedia.org/tokyo.jpg"}},
    }

    def __call__(self, url):
        for needle, payload in self.ROUTES.items():
            if needle in url:
                return payload
        return None


CONSULAR = [{"name": {"he": "שגרירות ישראל בטוקיו", "en": "Embassy of Israel in Tokyo"}, "phone": "+81-3-3264-0911"}]
DESTINATION_INFO = {
    "health": [{"he": "מים ברז בטוחים", "en": "Tap water is safe"}],
    "money": ["Cash is still widely used"],
    "communication": [{"he": "כרטיס SIM", "en": "Buy a SIM at the airport"}],
}


def provisioned(phases, language, **overrides):
    intake = {**COMMON, "phases": phases, **overrides}
    config = transform_intake(intake, today=date(2026, 8, 20), language=language)
    return enrich_config(
        config, "Japan", http=FakeHttp(), pause=0,
        consular_lookup=lambda dest, home: CONSULAR,
        venue_lookup=lambda dest, names: {"teamlab planets": "https://www.teamlab.art/e/planets/"},
        destination_info_lookup=lambda country: DESTINATION_INFO,
    )


if __name__ == "__main__":
    json.dump({
        "venues-path": provisioned(PHASES_WITH_VENUES, "en"),
        # Organizer-only dietary needs: exercises the WITHHELD half of the list.
        "planned-path": provisioned(PHASES_WITH_PLANNED, "he", dietary_visibility=_choice("organizer")),
    }, sys.stdout, ensure_ascii=False)
