"""The trip's zone from its coordinates (trip_timezone.py).

Background: the real Alsace trip (built 2026-11-20) came out with no
`meta.timezone` / `agent.timezone` because its destination was a region, not a
country, and the transformer can only answer from words. The coordinates the
enrichment pass geocodes are the second source; these tests hold the order
(typed zone, country, THEN coordinates) and the loud gap when nothing resolves.

Geocoding is faked, as in test_enrichment.py. The zone lookup itself is NOT
faked: timezonefinder is offline and deterministic, and a stub there would
prove nothing about the answer a real trip gets.
"""
from __future__ import annotations

import logging
import unittest
from datetime import date

from control_plane_worker import trip_timezone
from control_plane_worker.enrichment import enrich_config
from control_plane_worker.transformer import transform_intake

from tests.test_enrichment import FakeHttp

NOMINATIM_STRASBOURG = [{"lat": "48.5734", "lon": "7.7521", "display_name": "Strasbourg, Alsace, France"}]
NOMINATIM_COLMAR = [{"lat": "48.0794", "lon": "7.3585", "display_name": "Colmar, Alsace, France"}]
NOMINATIM_TOKYO = [{"lat": "35.6764", "lon": "139.6500", "display_name": "Tokyo, Japan"}]
NOMINATIM_SEA = [{"lat": "0.0", "lon": "-30.0", "display_name": "Atlantic Ocean"}]


def _phase(pid: str, en: str, he: str, start: str, end: str) -> dict:
    return {"id": pid, "title": {"he": he, "en": en}, "tabLabel": en.upper(),
            "dates": {"start": start, "end": end}}


def _alsace_config(*, agent: bool = True) -> dict:
    # What the transformer produced for the real trip: no meta.timezone, no
    # meta.destination, an agent block with no timezone.
    config: dict = {
        "meta": {"title": "Alsace 2026"},
        "phases": [
            _phase("strasbourg", "Strasbourg", "שטרסבורג", "2026-12-02", "2026-12-03"),
            _phase("colmar", "Colmar", "קולמר", "2026-12-03", "2026-12-06"),
        ],
    }
    if agent:
        config["agent"] = {"name": "Sol", "default_language": "he"}
    return config


class FromCoordinatesTests(unittest.TestCase):
    def test_an_english_region_resolves_to_paris_from_its_stops(self) -> None:
        http = FakeHttp({"q=Strasbourg": NOMINATIM_STRASBOURG, "q=Colmar": NOMINATIM_COLMAR})
        out = enrich_config(_alsace_config(), "Alsace", http=http, pause=0)
        self.assertEqual("Europe/Paris", out["meta"]["timezone"])
        self.assertEqual("Europe/Paris", out["agent"]["timezone"])

    def test_a_hebrew_region_resolves_the_same_way(self) -> None:
        # Hebrew destination AND Hebrew-only phase titles: nothing in the
        # words is a country the tables know, so only the pins can answer.
        config = _alsace_config()
        for phase in config["phases"]:
            phase["title"] = {"he": phase["title"]["he"]}
            phase["tabLabel"] = phase["title"]["he"]
        http = FakeHttp({"nominatim": NOMINATIM_COLMAR})
        out = enrich_config(config, "אלזס", http=http, pause=0)
        self.assertEqual("Europe/Paris", out["meta"]["timezone"])
        self.assertEqual("Europe/Paris", out["agent"]["timezone"])

    def test_japan_coordinates_give_tokyo(self) -> None:
        config = {"meta": {"title": "Somewhere"},
                  "phases": [_phase("a", "Tokyo", "טוקיו", "2026-09-19", "2026-09-23")],
                  "agent": {"name": "Sol"}}
        out = enrich_config(config, "Honshu", http=FakeHttp({"q=Tokyo": NOMINATIM_TOKYO}), pause=0)
        self.assertEqual("Asia/Tokyo", out["meta"]["timezone"])
        self.assertEqual("Asia/Tokyo", out["agent"]["timezone"])

    def test_a_derived_zone_does_not_invent_an_agent_block(self) -> None:
        # The contract _derive_agent documents: a derived zone alone must not
        # bring an agent block into existence.
        http = FakeHttp({"q=Strasbourg": NOMINATIM_STRASBOURG, "q=Colmar": NOMINATIM_COLMAR})
        out = enrich_config(_alsace_config(agent=False), "Alsace", http=http, pause=0)
        self.assertEqual("Europe/Paris", out["meta"]["timezone"])
        self.assertNotIn("agent", out)

    def test_a_typed_zone_wins_over_the_coordinates(self) -> None:
        # Full pipeline: the organizer TYPED a real zone for a region the
        # tables do not know; Alsace pins (Europe/Paris) must not replace it.
        config = transform_intake({
            "trip_type": {"kind": "choice", "value": "family"},
            "destination": {"kind": "text", "text": "Alsace"},
            "bot_name": {"kind": "text", "text": "Sol"},
            "timezone": {"kind": "text", "text": "America/New_York"},
        }, today=date(2026, 8, 20))
        self.assertEqual("America/New_York", config["meta"]["timezone"])
        config["phases"] = _alsace_config()["phases"]
        http = FakeHttp({"q=Strasbourg": NOMINATIM_STRASBOURG, "q=Colmar": NOMINATIM_COLMAR})
        out = enrich_config(config, "Alsace", http=http, pause=0)
        self.assertEqual("America/New_York", out["meta"]["timezone"])
        self.assertEqual("America/New_York", out["agent"]["timezone"])

    def test_a_country_zone_from_the_transformer_wins_over_the_coordinates(self) -> None:
        # Full pipeline: a country name resolves in the transformer; the pins
        # (here deliberately in Paris) must not replace it.
        config = transform_intake({
            "trip_type": {"kind": "choice", "value": "family"},
            "destination": {"kind": "text", "text": "Japan"},
            "bot_name": {"kind": "text", "text": "Sol"},
        }, today=date(2026, 8, 20))
        self.assertEqual("Asia/Tokyo", config["meta"]["timezone"])
        config["phases"] = [_phase("x", "Strasbourg", "שטרסבורג", "2026-12-02", "2026-12-03")]
        out = enrich_config(config, "Japan", http=FakeHttp({"q=Strasbourg": NOMINATIM_STRASBOURG}), pause=0)
        self.assertEqual("Asia/Tokyo", out["meta"]["timezone"])
        self.assertEqual("Asia/Tokyo", out["agent"]["timezone"])

    def test_a_trip_spanning_zones_takes_the_base_stop_not_the_midpoint(self) -> None:
        # Paris (2 nights) + Tokyo (10): the centroid of the two pins falls in
        # Russia. The base is where most of the nights are.
        config = {"meta": {"title": "Two worlds"}, "agent": {"name": "Sol"}, "phases": [
            _phase("paris", "Paris", "פריז", "2026-12-01", "2026-12-03"),
            _phase("tokyo", "Tokyo", "טוקיו", "2026-12-03", "2026-12-13"),
        ]}
        http = FakeHttp({"q=Paris": [{"lat": "48.8566", "lon": "2.3522", "display_name": "Paris"}],
                         "q=Tokyo": NOMINATIM_TOKYO})
        out = enrich_config(config, "Paris and Tokyo", http=http, pause=0)
        self.assertEqual("Asia/Tokyo", out["meta"]["timezone"])

    def test_a_pin_in_the_sea_is_not_a_zone(self) -> None:
        self.assertEqual("", trip_timezone.timezone_for_coordinates(0.0, -30.0))
        self.assertEqual("", trip_timezone.timezone_for_coordinates("x", None))
        self.assertEqual("", trip_timezone.timezone_for_coordinates(95, 10))


class UnresolvedIsLoudTests(unittest.TestCase):
    def test_nothing_geocoded_leaves_no_zone_and_warns_with_the_trip_id(self) -> None:
        out = enrich_config(_alsace_config(), "Alsace", http=FakeHttp({}), pause=0)
        self.assertNotIn("timezone", out["meta"])
        self.assertNotIn("timezone", out["agent"])
        with self.assertLogs("control_plane_worker.trip_timezone", level="WARNING") as logs:
            warned = trip_timezone.warn_if_unresolved(out, trip_id="trip-123", destination="Alsace")
        self.assertTrue(warned)
        record = logs.records[0]
        self.assertEqual("timezone.unresolved", record.getMessage())
        self.assertEqual("trip-123", record.trip_id)
        self.assertEqual("Alsace", record.destination)
        self.assertEqual(0, record.mapped_phases)

    def test_a_pin_in_the_sea_leaves_the_gap_and_warns(self) -> None:
        config = _alsace_config()
        out = enrich_config(config, "Alsace", http=FakeHttp({"nominatim": NOMINATIM_SEA}), pause=0)
        self.assertNotIn("timezone", out["meta"])
        with self.assertLogs("control_plane_worker.trip_timezone", level="WARNING"):
            self.assertTrue(trip_timezone.warn_if_unresolved(out, trip_id="t"))

    def test_a_resolved_zone_does_not_warn(self) -> None:
        with self.assertNoLogs("control_plane_worker.trip_timezone", level="WARNING"):
            self.assertFalse(trip_timezone.warn_if_unresolved({"meta": {"timezone": "Europe/Paris"}}, trip_id="t"))

    def test_a_missing_timezonefinder_is_an_error_not_a_silent_utc(self) -> None:
        saved = (trip_timezone._finder, trip_timezone._finder_failed)
        trip_timezone._finder, trip_timezone._finder_failed = None, False
        real_import = __import__

        def no_tzf(name, *args, **kwargs):
            if name == "timezonefinder":
                raise ImportError("no timezonefinder")
            return real_import(name, *args, **kwargs)

        try:
            from unittest import mock
            with mock.patch("builtins.__import__", no_tzf):
                with self.assertLogs("control_plane_worker.trip_timezone", level="ERROR") as logs:
                    self.assertEqual("", trip_timezone.timezone_for_coordinates(48.57, 7.75))
            self.assertEqual("timezone.lookup_unavailable", logs.records[0].getMessage())
        finally:
            trip_timezone._finder, trip_timezone._finder_failed = saved


if __name__ == "__main__":
    unittest.main()
