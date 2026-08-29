"""Tests for the deterministic destination-enrichment pass (Sprint 4.5).

The live HTTP layer (countries.dev, emergencynumberapi.com, Nominatim,
Wikipedia REST) is always faked here — same posture as scripts/country-info.js,
which is never tested against the real APIs. What matters is the merge into
trip.config.json and, above all, that any lookup failure is swallowed: an
enrichment error must never fail a provision job.
"""
from __future__ import annotations

import unittest

from control_plane_worker.enrichment import enrich_config


class FakeHttp:
    """Maps URL substrings to canned JSON payloads. A URL that matches nothing
    returns None, exactly as the real client does for a non-200 / timeout."""

    def __init__(self, routes: dict[str, object], *, boom: bool = False) -> None:
        self.routes = routes
        self.calls: list[str] = []
        self._boom = boom

    def __call__(self, url: str) -> object | None:
        self.calls.append(url)
        if self._boom:
            raise RuntimeError("network on fire")
        for needle, payload in self.routes.items():
            if needle in url:
                return payload
        return None


COUNTRIES_DEV_JAPAN = [
    {
        "name": "Japan", "capital": "Tokyo", "flag": "🇯🇵", "alpha2Code": "JP",
        "currencies": [{"code": "JPY", "name": "Japanese yen", "symbol": "¥"}],
        "callingCodes": ["81"],
    }
]

EMERGENCY_JP = {"data": {
    "police": {"all": ["110"]}, "ambulance": {"all": ["119"]}, "fire": {"all": ["119"]},
    "dispatch": {"all": [""]}, "member_112": False,
}}

NOMINATIM_TOKYO = [{"lat": "35.6764", "lon": "139.6500", "display_name": "Tokyo, Japan"}]
NOMINATIM_KYOTO = [{"lat": "35.0116", "lon": "135.7681", "display_name": "Kyoto, Japan"}]

WIKI_TOKYO = {
    "title": "Tokyo",
    "originalimage": {"source": "https://upload.wikimedia.org/tokyo.jpg"},
    "thumbnail": {"source": "https://upload.wikimedia.org/tokyo_thumb.jpg"},
    "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Tokyo"}},
}


def _config(**over):
    base = {
        "meta": {"title": "Japan 2026 — Family"},
        "phases": [
            {"id": "tokyo", "title": {"he": "Tokyo", "en": "Tokyo"}, "tabLabel": "TOKYO",
             "dates": {"start": "2026-09-19", "end": "2026-09-23"}},
            {"id": "kyoto", "title": {"he": "Kyoto", "en": "Kyoto"}, "tabLabel": "KYOTO",
             "dates": {"start": "2026-09-24", "end": "2026-09-27"}},
        ],
    }
    base.update(over)
    return base


class CountryDataTests(unittest.TestCase):
    def test_currency_and_emergency_land_under_the_live_country_name(self) -> None:
        http = FakeHttp({
            "countries.dev/name/Japan": COUNTRIES_DEV_JAPAN,
            "emergencynumberapi.com/api/country/JP": EMERGENCY_JP,
        })
        out = enrich_config(_config(), "Japan", http=http, pause=0)
        country = out["travel_info"]["countries"]["Japan"]
        self.assertEqual("JPY", country["currency"]["code"])
        self.assertEqual("¥", country["currency"]["symbol"])
        self.assertEqual("+81", country["callingCode"])
        self.assertEqual("🇯🇵", country["flag"])
        self.assertEqual("110", country["emergency"]["police"])
        self.assertEqual("119", country["emergency"]["ambulance"])
        self.assertFalse(country["emergency"]["unified112"])

    def test_live_lookup_replaces_the_static_currency_stub(self) -> None:
        # The transformer's _KNOWN_COUNTRY_CURRENCY may already have written a
        # bare currency entry under a slightly different name — one card, not two.
        stub = _config(travel_info={"countries": {"Japan": {"currency": {"code": "JPY"}}}})
        http = FakeHttp({
            "countries.dev/name/Japan": COUNTRIES_DEV_JAPAN,
            "emergencynumberapi.com/api/country/JP": EMERGENCY_JP,
        })
        out = enrich_config(stub, "Japan", http=http, pause=0)
        self.assertEqual(["Japan"], list(out["travel_info"]["countries"].keys()))
        self.assertIn("capital", out["travel_info"]["countries"]["Japan"])

    def test_single_dispatch_number_fills_all_services_and_general(self) -> None:
        http = FakeHttp({
            "countries.dev/name/United": [
                {"name": "United States of America", "alpha2Code": "US", "flag": "🇺🇸",
                 "capital": "Washington, D.C.",
                 "currencies": [{"code": "USD", "name": "US Dollar", "symbol": "$"}],
                 "callingCodes": ["1"]}
            ],
            "emergencynumberapi.com/api/country/US": {"data": {
                "police": {"all": [""]}, "ambulance": {"all": [""]}, "fire": {"all": [""]},
                "dispatch": {"all": ["911"]}, "member_112": False,
            }},
        })
        out = enrich_config(_config(), "United States", http=http, pause=0)
        e = out["travel_info"]["countries"]["United States of America"]["emergency"]
        self.assertEqual("911", e["general"])
        self.assertEqual("911", e["police"])
        self.assertEqual("911", e["fire"])

    def test_unknown_destination_leaves_config_untouched(self) -> None:
        before = _config()
        http = FakeHttp({})  # countries.dev returns None
        out = enrich_config(before, "Neverland", http=http, pause=0)
        self.assertNotIn("travel_info", out)

    def test_static_emergency_table_fills_in_when_the_live_api_is_dead(self) -> None:
        # emergencynumberapi.com stopped serving its API — only countries.dev
        # answers now. A known ISO still gets emergency numbers from the
        # hardcoded fallback table.
        http = FakeHttp({"countries.dev/name/Japan": COUNTRIES_DEV_JAPAN})  # no emergency route
        out = enrich_config(_config(), "Japan", http=http, pause=0)
        e = out["travel_info"]["countries"]["Japan"]["emergency"]
        self.assertEqual("110", e["police"])
        self.assertEqual("119", e["ambulance"])

    def test_eu_country_gets_112_and_the_unified_flag_from_the_fallback(self) -> None:
        http = FakeHttp({"countries.dev/name/France": [
            {"name": "France", "alpha2Code": "FR", "flag": "🇫🇷", "capital": "Paris",
             "currencies": [{"code": "EUR", "name": "Euro", "symbol": "€"}], "callingCodes": ["33"]}
        ]})
        out = enrich_config(_config(), "France", http=http, pause=0)
        e = out["travel_info"]["countries"]["France"]["emergency"]
        self.assertEqual("112", e["general"])
        self.assertTrue(e["unified112"])

    def test_country_with_no_emergency_data_at_all_still_gets_a_card(self) -> None:
        http = FakeHttp({"countries.dev/name/Narnia": [
            {"name": "Narnia", "alpha2Code": "ZZ", "flag": "🏳️",
             "currencies": [{"code": "NAR", "name": "Lion", "symbol": "N"}], "callingCodes": ["999"]}
        ]})
        out = enrich_config(_config(), "Narnia", http=http, pause=0)
        country = out["travel_info"]["countries"]["Narnia"]
        self.assertEqual("NAR", country["currency"]["code"])
        self.assertNotIn("emergency", country)


class GeocodeTests(unittest.TestCase):
    def test_each_phase_gets_a_mapstop_from_nominatim(self) -> None:
        http = FakeHttp({
            "q=Tokyo": NOMINATIM_TOKYO,
            "q=Kyoto": NOMINATIM_KYOTO,
        })
        out = enrich_config(_config(), "Japan", http=http, pause=0)
        tokyo = out["phases"][0]["mapStop"]
        self.assertAlmostEqual(35.6764, tokyo["lat"])
        self.assertAlmostEqual(139.65, tokyo["lng"])
        self.assertEqual({"he": "Tokyo", "en": "Tokyo"}, tokyo["name"])

    def test_existing_mapstop_is_not_overwritten(self) -> None:
        cfg = _config()
        cfg["phases"][0]["mapStop"] = {"lat": 1.0, "lng": 2.0}
        http = FakeHttp({"q=Tokyo": NOMINATIM_TOKYO, "q=Kyoto": NOMINATIM_KYOTO})
        out = enrich_config(cfg, "Japan", http=http, pause=0)
        self.assertEqual(1.0, out["phases"][0]["mapStop"]["lat"])

    def test_a_phase_that_does_not_geocode_is_simply_skipped(self) -> None:
        http = FakeHttp({"q=Kyoto": NOMINATIM_KYOTO})  # Tokyo misses
        out = enrich_config(_config(), "Japan", http=http, pause=0)
        self.assertNotIn("mapStop", out["phases"][0])
        self.assertIn("mapStop", out["phases"][1])

    def test_the_hotel_is_geocoded_in_preference_to_the_city(self) -> None:
        cfg = _config()
        cfg["phases"][0]["accommodation"] = {"name": "OMO3 Asakusa", "name_en": "OMO3 Asakusa"}
        http = FakeHttp({
            "q=OMO3+Asakusa": [{"lat": "35.7106", "lon": "139.7986", "display_name": "OMO3 Asakusa, Taito, Tokyo, Japan"}],
            "q=Tokyo": NOMINATIM_TOKYO,
            "q=Kyoto": NOMINATIM_KYOTO,
        })
        out = enrich_config(cfg, "Japan", http=http, pause=0)
        stop = out["phases"][0]["mapStop"]
        self.assertAlmostEqual(35.7106, stop["lat"])  # the hotel, not 35.6764 (Tokyo)
        self.assertEqual("OMO3 Asakusa, Taito, Tokyo, Japan", out["phases"][0]["accommodation"]["address"])

    def test_falls_back_to_the_city_when_the_hotel_does_not_resolve(self) -> None:
        cfg = _config()
        cfg["phases"][0]["accommodation"] = {"name": "Nonexistent Inn"}
        http = FakeHttp({"q=Tokyo": NOMINATIM_TOKYO, "q=Kyoto": NOMINATIM_KYOTO})
        out = enrich_config(cfg, "Japan", http=http, pause=0)
        self.assertAlmostEqual(35.6764, out["phases"][0]["mapStop"]["lat"])  # Tokyo centre
        self.assertNotIn("address", out["phases"][0]["accommodation"])


class HeroPhotoTests(unittest.TestCase):
    def test_phase_hero_photo_from_wikipedia_summary(self) -> None:
        http = FakeHttp({"page/summary/Tokyo": WIKI_TOKYO})
        out = enrich_config(_config(), "Japan", http=http, pause=0)
        hero = out["phases"][0]["hero"]
        self.assertEqual("https://upload.wikimedia.org/tokyo.jpg", hero["photo"])
        self.assertEqual("TOKYO", hero["title"])

    def test_no_wikipedia_image_means_no_hero(self) -> None:
        http = FakeHttp({"page/summary/Tokyo": {"title": "Tokyo"}})  # no image
        out = enrich_config(_config(), "Japan", http=http, pause=0)
        self.assertNotIn("hero", out["phases"][0])

    def test_existing_hero_is_left_alone(self) -> None:
        cfg = _config()
        cfg["phases"][0]["hero"] = {"photo": "https://example.com/mine.jpg"}
        http = FakeHttp({"page/summary/Tokyo": WIKI_TOKYO})
        out = enrich_config(cfg, "Japan", http=http, pause=0)
        self.assertEqual("https://example.com/mine.jpg", out["phases"][0]["hero"]["photo"])

    def test_hebrew_only_phase_title_queries_hebrew_wikipedia(self) -> None:
        # A phase with no English title must not be sent to en.wikipedia.org
        # (guaranteed 404 -> no hero). It should hit he.wikipedia.org instead.
        cfg = _config()
        cfg["phases"] = [{"id": "tokyo", "title": {"he": "טוקיו"}, "tabLabel": "טוקיו"}]
        http = FakeHttp({
            "he.wikipedia.org/api/rest_v1/page/summary/": {
                "title": "טוקיו", "originalimage": {"source": "https://upload.wikimedia.org/he-tokyo.jpg"},
            },
        })
        out = enrich_config(cfg, "Japan", http=http, pause=0)
        self.assertEqual("https://upload.wikimedia.org/he-tokyo.jpg", out["phases"][0]["hero"]["photo"])
        self.assertTrue(any("he.wikipedia.org" in u for u in http.calls))
        self.assertFalse(any("en.wikipedia.org" in u for u in http.calls))


class PhaseNavTests(unittest.TestCase):
    def _cfg_with_acc(self):
        cfg = _config()
        cfg["phases"][0]["accommodation"] = {"name": "OMO3 Asakusa", "name_en": "OMO3 Asakusa"}
        return cfg

    def test_a_geocoded_phase_gets_a_weather_key_on_its_map_stop(self) -> None:
        http = FakeHttp({"q=Tokyo": NOMINATIM_TOKYO, "q=Kyoto": NOMINATIM_KYOTO})
        out = enrich_config(_config(), "Japan", http=http, pause=0)
        self.assertEqual("tokyo", out["phases"][0]["mapStop"]["weatherKey"])

    def test_accommodation_gets_maps_waze_and_weather_key(self) -> None:
        http = FakeHttp({"q=Tokyo": NOMINATIM_TOKYO, "q=Kyoto": NOMINATIM_KYOTO})
        out = enrich_config(self._cfg_with_acc(), "Japan", http=http, pause=0)
        acc = out["phases"][0]["accommodation"]
        self.assertEqual("tokyo", acc["weatherKey"])
        self.assertIn("google.com/maps", acc["maps"])
        self.assertIn("35.6764", acc["maps"])
        self.assertIn("waze.com/ul", acc["waze"])
        self.assertIn("navigate=yes", acc["waze"])

    def test_nav_is_skipped_when_a_phase_never_geocoded(self) -> None:
        http = FakeHttp({"q=Kyoto": NOMINATIM_KYOTO})  # Tokyo misses
        out = enrich_config(self._cfg_with_acc(), "Japan", http=http, pause=0)
        self.assertNotIn("maps", out["phases"][0].get("accommodation", {}))
        self.assertIn("maps", out["phases"][1]["accommodation"]) if out["phases"][1].get("accommodation") else None

    def test_a_hand_authored_maps_link_is_kept(self) -> None:
        cfg = self._cfg_with_acc()
        cfg["phases"][0]["accommodation"]["maps"] = "https://maps.example/mine"
        http = FakeHttp({"q=Tokyo": NOMINATIM_TOKYO, "q=Kyoto": NOMINATIM_KYOTO})
        out = enrich_config(cfg, "Japan", http=http, pause=0)
        self.assertEqual("https://maps.example/mine", out["phases"][0]["accommodation"]["maps"])

    def test_weather_key_rides_through_to_the_top_level_map_stops(self) -> None:
        http = FakeHttp({"q=Tokyo": NOMINATIM_TOKYO, "q=Kyoto": NOMINATIM_KYOTO})
        out = enrich_config(_config(), "Japan", http=http, pause=0)
        self.assertEqual("tokyo", out["map"]["stops"][0]["weatherKey"])


class VenueEnrichmentTests(unittest.TestCase):
    def test_each_venue_gets_maps_and_waze_from_geocoding(self) -> None:
        cfg = _config()
        cfg["phases"][0]["venues"] = [
            {"id": "skytree", "name": {"he": "סקייטרי", "en": "Tokyo Skytree"},
             "url": "https://www.tokyo-skytree.jp/en/"},
        ]
        http = FakeHttp({
            "q=Tokyo+Skytree": [{"lat": "35.7101", "lon": "139.8107", "display_name": "Tokyo Skytree"}],
            "q=Tokyo": NOMINATIM_TOKYO, "q=Kyoto": NOMINATIM_KYOTO,
        })
        out = enrich_config(cfg, "Japan", http=http, pause=0)
        v = out["phases"][0]["venues"][0]
        self.assertIn("35.7101", v["maps"])
        self.assertIn("waze.com/ul", v["waze"])
        self.assertEqual("https://www.tokyo-skytree.jp/en/", v["url"])  # untouched

    def test_a_venue_that_does_not_geocode_keeps_its_url_and_gets_no_maps(self) -> None:
        cfg = _config()
        cfg["phases"][0]["venues"] = [{"id": "x", "name": {"en": "Nowhere"}, "url": "https://x"}]
        out = enrich_config(cfg, "Japan", http=FakeHttp({"q=Tokyo": NOMINATIM_TOKYO}), pause=0)
        v = out["phases"][0]["venues"][0]
        self.assertNotIn("maps", v)
        self.assertEqual("https://x", v["url"])


class MapObjectTests(unittest.TestCase):
    def _geocoded(self):
        http = FakeHttp({"q=Tokyo": NOMINATIM_TOKYO, "q=Kyoto": NOMINATIM_KYOTO})
        return enrich_config(_config(), "Japan", http=http, pause=0)

    def test_top_level_map_is_built_from_the_phase_mapstops(self) -> None:
        out = self._geocoded()
        self.assertIn("map", out)
        self.assertEqual(2, len(out["map"]["stops"]))
        self.assertEqual({"he": "Tokyo", "en": "Tokyo"}, out["map"]["stops"][0]["name"])

    def test_map_centre_is_the_centroid_of_the_stops(self) -> None:
        out = self._geocoded()
        self.assertAlmostEqual((35.6764 + 35.0116) / 2, out["map"]["center"][0], places=3)
        self.assertAlmostEqual((139.65 + 135.7681) / 2, out["map"]["center"][1], places=3)

    def test_zoom_frames_the_span(self) -> None:
        # Tokyo↔Kyoto is ~3.9° of longitude → zoom 6, same as the reference config.
        self.assertEqual(6, self._geocoded()["map"]["zoom"])

    def test_every_stop_carries_a_fallback_emoji(self) -> None:
        for stop in self._geocoded()["map"]["stops"]:
            self.assertEqual("📍", stop["emoji"])

    def test_a_single_stop_still_gets_a_map_with_a_close_zoom(self) -> None:
        cfg = _config()
        cfg["phases"] = [cfg["phases"][0]]
        http = FakeHttp({"q=Tokyo": NOMINATIM_TOKYO})
        out = enrich_config(cfg, "Japan", http=http, pause=0)
        self.assertEqual(1, len(out["map"]["stops"]))
        self.assertEqual(10, out["map"]["zoom"])

    def test_phases_that_do_not_geocode_are_left_out_of_the_stop_list(self) -> None:
        http = FakeHttp({"q=Kyoto": NOMINATIM_KYOTO})  # Tokyo misses
        out = enrich_config(_config(), "Japan", http=http, pause=0)
        self.assertEqual(1, len(out["map"]["stops"]))
        self.assertEqual("Kyoto", out["map"]["stops"][0]["name"]["en"])

    def test_no_geocoded_phases_means_no_map(self) -> None:
        out = enrich_config(_config(), "Japan", http=FakeHttp({}), pause=0)
        self.assertNotIn("map", out)

    def test_a_hand_authored_map_is_not_overwritten(self) -> None:
        cfg = _config()
        cfg["map"] = {"center": [1.0, 2.0], "zoom": 9, "stops": []}
        http = FakeHttp({"q=Tokyo": NOMINATIM_TOKYO, "q=Kyoto": NOMINATIM_KYOTO})
        out = enrich_config(cfg, "Japan", http=http, pause=0)
        self.assertEqual({"center": [1.0, 2.0], "zoom": 9, "stops": []}, out["map"])


class ConsularContactsTests(unittest.TestCase):
    JP_IL = [
        {"name": {"he": "שגרירות ישראל בטוקיו", "en": "Embassy of Israel in Tokyo"}, "phone": "+81-3-3264-0911"},
        {"name": {"en": "Consulate — emergency line"}, "phone": "+81 90 0000 0000"},
    ]

    def test_contacts_land_under_travel_info_emergency_contacts(self) -> None:
        out = enrich_config(_config(), "Japan", http=FakeHttp({}), pause=0,
                            consular_lookup=lambda dest, home: self.JP_IL)
        self.assertEqual(2, len(out["travel_info"]["emergency_contacts"]))
        self.assertEqual("Embassy of Israel in Tokyo", out["travel_info"]["emergency_contacts"][0]["name"]["en"])

    def test_the_missing_name_side_is_mirrored(self) -> None:
        out = enrich_config(_config(), "Japan", http=FakeHttp({}), pause=0,
                            consular_lookup=lambda dest, home: self.JP_IL)
        second = out["travel_info"]["emergency_contacts"][1]["name"]
        self.assertEqual(second["he"], second["en"])

    def test_home_country_comes_from_meta_and_defaults_to_israel(self) -> None:
        seen = {}
        def lookup(dest, home):
            seen["dest"], seen["home"] = dest, home
            return self.JP_IL
        enrich_config(_config(), "Japan", http=FakeHttp({}), pause=0, consular_lookup=lookup)
        self.assertEqual(("Japan", "Israel"), (seen["dest"], seen["home"]))
        cfg = _config(meta={"title": "x", "home_country": "United States"})
        enrich_config(cfg, "Japan", http=FakeHttp({}), pause=0, consular_lookup=lookup)
        self.assertEqual("United States", seen["home"])

    def test_markup_in_a_contact_is_stripped(self) -> None:
        poisoned = [{"name": {"en": "<img src=x onerror=alert(1)> Embassy"}, "phone": "+1<script>"}]
        out = enrich_config(_config(), "Japan", http=FakeHttp({}), pause=0,
                            consular_lookup=lambda d, h: poisoned)
        c = out["travel_info"]["emergency_contacts"][0]
        self.assertNotIn("<", c["name"]["en"] + c["phone"])

    def test_no_lookup_and_empty_result_leave_emergency_contacts_unset(self) -> None:
        out1 = enrich_config(_config(), "Japan", http=FakeHttp({}), pause=0)
        out2 = enrich_config(_config(), "Japan", http=FakeHttp({}), pause=0, consular_lookup=lambda d, h: [])
        self.assertNotIn("emergency_contacts", out1.get("travel_info", {}))
        self.assertNotIn("emergency_contacts", out2.get("travel_info", {}))

    def test_a_raising_lookup_never_propagates(self) -> None:
        def boom(dest, home):
            raise RuntimeError("search on fire")
        out = enrich_config(_config(), "Japan", http=FakeHttp({}), pause=0, consular_lookup=boom)
        self.assertNotIn("emergency_contacts", out.get("travel_info", {}))


class ResilienceTests(unittest.TestCase):
    def test_a_raising_http_client_never_propagates(self) -> None:
        http = FakeHttp({}, boom=True)
        before = _config()
        out = enrich_config(before, "Japan", http=http, pause=0)
        # Config comes back usable and unenriched, not an exception.
        self.assertEqual(before["phases"], out["phases"])
        self.assertNotIn("travel_info", out)

    def test_input_config_is_not_mutated_in_place(self) -> None:
        http = FakeHttp({
            "countries.dev/name/Japan": COUNTRIES_DEV_JAPAN,
            "emergencynumberapi.com/api/country/JP": EMERGENCY_JP,
            "q=Tokyo": NOMINATIM_TOKYO, "q=Kyoto": NOMINATIM_KYOTO,
        })
        before = _config()
        enrich_config(before, "Japan", http=http, pause=0)
        self.assertNotIn("travel_info", before)
        self.assertNotIn("mapStop", before["phases"][0])


if __name__ == "__main__":
    unittest.main()
