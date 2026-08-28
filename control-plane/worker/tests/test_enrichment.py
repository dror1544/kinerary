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
