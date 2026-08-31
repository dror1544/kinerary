"""Tests for the intake transformer."""
from __future__ import annotations

import re
import unittest
from datetime import date

from control_plane_worker.transformer import (
    derive_bookings,
    derive_trip_slug,
    transform_intake,
)


def _choice(option_id: str) -> dict:
    return {"kind": "choice", "option_id": option_id, "schema_version": 1, "other_text": None}


def _choice_other(other_text: str) -> dict:
    return {"kind": "choice_other", "option_id": None, "schema_version": 1, "other_text": other_text}


def _text(value: str) -> dict:
    return {"kind": "text", "schema_version": 1, "text": value}


def _structured(value) -> dict:
    return {"kind": "structured", "schema_version": 1, "data": value}


def _multi(*option_ids: str) -> dict:
    return {"kind": "multi_choice", "option_ids": list(option_ids), "schema_version": 2, "other_text": None}


TRAVELERS = _structured([
    {"name": "Eitan", "age": 52, "family": "Sagi"},
    {"name": "Noa", "age": 19, "family": "Sagi"},
])


JAPAN_INTAKE = {
    "trip_type": _choice("family"),
    "destination": _text("Japan"),
    "group_size": _choice("2"),
    "trip_duration": _choice("two_weeks"),
    "trip_interests": _text("temples, matcha, onsen"),
}


class DeriveTripSlugTests(unittest.TestCase):
    SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

    def test_uses_destination_and_departure_year(self) -> None:
        slug = derive_trip_slug(JAPAN_INTAKE, today=date(2026, 8, 20))
        # Departure falls 90 days out, in November 2026.
        self.assertEqual(slug, "japan-2026")

    def test_explicit_dates_drive_the_year(self) -> None:
        intake = dict(JAPAN_INTAKE)
        intake["departure_date"] = _text("2027-03-04")
        intake["return_date"] = _text("2027-03-18")
        self.assertEqual(derive_trip_slug(intake, today=date(2026, 8, 20)), "japan-2027")

    def test_multiword_destination_keeps_word_boundaries(self) -> None:
        intake = dict(JAPAN_INTAKE)
        intake["destination"] = _text("New York, Boston & DC")
        self.assertEqual(
            derive_trip_slug(intake, today=date(2026, 8, 20)),
            "new-york-boston-dc-2026",
        )

    def test_non_latin_destination_falls_back(self) -> None:
        intake = dict(JAPAN_INTAKE)
        intake["destination"] = _text("日本")
        self.assertEqual(derive_trip_slug(intake, today=date(2026, 8, 20)), "trip-2026")

    def test_result_always_satisfies_the_db_constraint(self) -> None:
        for destination in (
            "Japan", "New York, Boston & DC", "日本", "  --Spain--  ",
            "A" * 120, "Côte d'Azur", "3", "!!!",
        ):
            intake = dict(JAPAN_INTAKE)
            intake["destination"] = _text(destination)
            slug = derive_trip_slug(intake, today=date(2026, 8, 20))
            self.assertRegex(slug, self.SLUG_RE, f"invalid slug for {destination!r}")

    def test_never_produces_a_draft_placeholder(self) -> None:
        slug = derive_trip_slug(JAPAN_INTAKE, today=date(2026, 8, 20))
        self.assertFalse(slug.startswith("draft-"))


class TransformerTests(unittest.TestCase):
    def test_japan_fixture_produces_valid_meta(self) -> None:
        today = date(2026, 8, 20)
        config = transform_intake(JAPAN_INTAKE, today=today)

        meta = config["meta"]
        self.assertEqual(meta["title"], "Japan 2026 — Family")
        self.assertEqual(meta["title_en"], "Japan 2026 — Family")
        self.assertEqual(meta["totalDays"], 14)
        self.assertEqual(meta["returnDate"], "2026-12-02")
        # Departure should be 90 days from today.
        self.assertEqual(meta["departure"][:10], "2026-11-18")
        self.assertIn("+00:00", meta["departure"])
        self.assertEqual(meta["defaultLang"], "en")
        # brand is the short Hero headline: destination + departure year,
        # not a fixed placeholder — see _derive_brand_and_title.
        self.assertEqual(meta["brand"], "JAPAN 2026")
        self.assertEqual(meta["homeCurrency"], "ILS")

    def test_japan_fixture_has_required_top_level_keys(self) -> None:
        config = transform_intake(JAPAN_INTAKE)
        for key in ("meta", "theme", "stats", "participants", "families", "phases"):
            self.assertIn(key, config, f"missing top-level key: {key}")

    def test_participants_and_families_are_empty_lists(self) -> None:
        config = transform_intake(JAPAN_INTAKE)
        self.assertEqual(config["participants"], [])
        self.assertEqual(config["families"], [])

    def test_stats_contains_group_size_and_duration(self) -> None:
        config = transform_intake(JAPAN_INTAKE)
        stat_numbers = {s["number"] for s in config["stats"]}
        self.assertIn("2", stat_numbers)
        self.assertIn("14", stat_numbers)

    def test_interests_never_appear_verbatim_in_stats(self) -> None:
        # The Hero stat strip is short/generic by design — trip_interests is
        # organizer free text of arbitrary length and must never land there,
        # present or absent.
        config = transform_intake(JAPAN_INTAKE)
        self.assertEqual(len(config["stats"]), 2)
        stat_texts = " ".join(s["description"].get("en", "") for s in config["stats"])
        self.assertNotIn("temples", stat_texts)

    def test_stats_always_carry_an_he_description(self) -> None:
        config = transform_intake(JAPAN_INTAKE)
        for stat in config["stats"]:
            self.assertTrue(stat["description"].get("he"), stat)

    def test_other_trip_type_uses_free_text(self) -> None:
        intake = {**JAPAN_INTAKE, "trip_type": _choice_other("Extended family reunion")}
        config = transform_intake(intake)
        self.assertIn("Extended family reunion", config["meta"]["title"])

    def test_other_group_size_extracts_the_leading_number(self) -> None:
        # A stat "number" must actually be a number, not the organizer's
        # whole sentence — see _resolve_group_size.
        intake = {**JAPAN_INTAKE, "group_size": _choice_other("15 people")}
        config = transform_intake(intake)
        stat_numbers = {s["number"] for s in config["stats"]}
        self.assertIn("15", stat_numbers)

    def test_other_group_size_with_no_number_falls_back_to_short_text(self) -> None:
        intake = {**JAPAN_INTAKE, "group_size": _choice_other("a big family")}
        config = transform_intake(intake)
        stat_numbers = {s["number"] for s in config["stats"]}
        self.assertIn("a big family", stat_numbers)

    def test_weekend_duration_maps_to_3_days(self) -> None:
        intake = {**JAPAN_INTAKE, "trip_duration": _choice("weekend")}
        config = transform_intake(intake)
        self.assertEqual(config["meta"]["totalDays"], 3)

    def test_week_duration_maps_to_7_days(self) -> None:
        intake = {**JAPAN_INTAKE, "trip_duration": _choice("week")}
        config = transform_intake(intake)
        self.assertEqual(config["meta"]["totalDays"], 7)

    def test_month_or_more_maps_to_30_days(self) -> None:
        intake = {**JAPAN_INTAKE, "trip_duration": _choice("month_or_more")}
        config = transform_intake(intake)
        self.assertEqual(config["meta"]["totalDays"], 30)

    def test_other_duration_parses_first_number(self) -> None:
        intake = {**JAPAN_INTAKE, "trip_duration": _choice_other("10 nights")}
        config = transform_intake(intake)
        self.assertEqual(config["meta"]["totalDays"], 10)

    def test_other_duration_defaults_to_7_when_no_number(self) -> None:
        intake = {**JAPAN_INTAKE, "trip_duration": _choice_other("undecided")}
        config = transform_intake(intake)
        self.assertEqual(config["meta"]["totalDays"], 7)

    def test_rejects_missing_destination(self) -> None:
        intake = {k: v for k, v in JAPAN_INTAKE.items() if k != "destination"}
        with self.assertRaises(ValueError) as ctx:
            transform_intake(intake)
        self.assertIn("destination", str(ctx.exception))

    def test_rejects_missing_trip_type(self) -> None:
        intake = {k: v for k, v in JAPAN_INTAKE.items() if k != "trip_type"}
        with self.assertRaises(ValueError):
            transform_intake(intake)

    def test_rejects_missing_group_size(self) -> None:
        intake = {k: v for k, v in JAPAN_INTAKE.items() if k != "group_size"}
        with self.assertRaises(ValueError):
            transform_intake(intake)

    def test_rejects_missing_trip_duration(self) -> None:
        intake = {k: v for k, v in JAPAN_INTAKE.items() if k != "trip_duration"}
        with self.assertRaises(ValueError):
            transform_intake(intake)

    def test_group_of_families_label(self) -> None:
        intake = {**JAPAN_INTAKE, "trip_type": _choice("group_of_families")}
        config = transform_intake(intake)
        self.assertIn("Group of Families", config["meta"]["title"])

    def test_couple_label(self) -> None:
        intake = {**JAPAN_INTAKE, "trip_type": _choice("couple")}
        config = transform_intake(intake)
        self.assertIn("Couple", config["meta"]["title"])

    def test_group_size_3_to_5_label(self) -> None:
        intake = {**JAPAN_INTAKE, "group_size": _choice("3_to_5")}
        config = transform_intake(intake)
        stat_numbers = {s["number"] for s in config["stats"]}
        self.assertIn("3–5", stat_numbers)

    def test_group_size_more_than_10_label(self) -> None:
        intake = {**JAPAN_INTAKE, "group_size": _choice("more_than_10")}
        config = transform_intake(intake)
        stat_numbers = {s["number"] for s in config["stats"]}
        self.assertIn("10+", stat_numbers)

    def test_theme_fields_present(self) -> None:
        config = transform_intake(JAPAN_INTAKE)
        self.assertEqual(config["theme"]["palette"], "blue")
        self.assertEqual(config["theme"]["rtlDefault"], False)

    def test_phases_is_empty_list(self) -> None:
        config = transform_intake(JAPAN_INTAKE)
        self.assertEqual(config["phases"], [])

    # ── Sprint 4 gap-closing fields ──────────────────────────────────────────

    def test_explicit_dates_override_the_placeholder_logic(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "departure_date": _text("2026-09-06"),
            "return_date": _text("2026-09-20"),
        }
        config = transform_intake(intake, today=date(2026, 8, 20))
        self.assertEqual(config["meta"]["departure"][:10], "2026-09-06")
        self.assertEqual(config["meta"]["returnDate"], "2026-09-20")
        self.assertEqual(config["meta"]["totalDays"], 14)

    def test_missing_explicit_dates_falls_back_to_duration_placeholder(self) -> None:
        config = transform_intake(JAPAN_INTAKE, today=date(2026, 8, 20))
        self.assertEqual(config["meta"]["departure"][:10], "2026-11-18")

    def test_invalid_explicit_dates_fall_back_to_placeholder(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "departure_date": _text("not-a-date"),
            "return_date": _text("2026-09-20"),
        }
        config = transform_intake(intake, today=date(2026, 8, 20))
        self.assertEqual(config["meta"]["departure"][:10], "2026-11-18")

    def test_return_before_departure_falls_back_to_placeholder(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "departure_date": _text("2026-09-20"),
            "return_date": _text("2026-09-06"),
        }
        config = transform_intake(intake, today=date(2026, 8, 20))
        self.assertEqual(config["meta"]["departure"][:10], "2026-11-18")

    def test_travelers_populate_participants_and_families(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "travelers": _structured([
                {"name": "Eitan", "age": 52, "family": "Sagi"},
                {"name": "Noa", "age": 19, "family": "Sagi"},
                {"name": "Dana", "age": 41, "family": "Cohen"},
            ]),
        }
        config = transform_intake(intake)
        self.assertEqual(len(config["participants"]), 3)
        self.assertEqual(len(config["families"]), 2)
        eitan = next(p for p in config["participants"] if p["name"] == "Eitan")
        self.assertEqual(eitan["username"], "eitan")
        self.assertEqual(eitan["age"], 52)
        sagi_family = next(f for f in config["families"] if f["id"] == eitan["family"])
        self.assertIn("eitan", sagi_family["members"])
        self.assertIn("noa", sagi_family["members"])

    def test_duplicate_traveler_usernames_are_disambiguated(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "travelers": _structured([
                {"name": "Alex", "family": "Smith"},
                {"name": "Alex", "family": "Jones"},
            ]),
        }
        config = transform_intake(intake)
        usernames = {p["username"] for p in config["participants"]}
        self.assertEqual(len(usernames), 2)

    def test_travelers_missing_or_malformed_yields_empty_participants(self) -> None:
        config = transform_intake(JAPAN_INTAKE)
        self.assertEqual(config["participants"], [])
        self.assertEqual(config["families"], [])

    def test_phases_populate_id_title_dates_accommodation(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {
                    "name": "Tokyo", "start": "2026-09-06", "end": "2026-09-10",
                    "accommodation": {"name": "Tokyo Hotel", "confirmation": "ABC123"},
                },
                {"name": "Kyoto", "start": "2026-09-10", "end": "2026-09-14"},
            ]),
        }
        config = transform_intake(intake)
        self.assertEqual(len(config["phases"]), 2)
        tokyo = config["phases"][0]
        self.assertEqual(tokyo["id"], "tokyo")
        self.assertEqual(tokyo["title"]["en"], "Tokyo")
        self.assertEqual(tokyo["dates"], {"start": "2026-09-06", "end": "2026-09-10"})
        self.assertEqual(tokyo["accommodation"]["confirmation"], "ABC123")
        self.assertNotIn("accommodation", config["phases"][1])
        self.assertEqual(tokyo["tabLabel"], "TOKYO")

    def test_verbose_phase_name_is_shortened_to_a_light_label(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {
                    "name": "Dallas (boys; Mavericks game September 6)",
                    "start": "2026-09-05", "end": "2026-09-08",
                },
                {
                    "name": "Elul family road trip: Orlando to New York, route flexible "
                             "(via Washington, D.C. and the Smokies planned)",
                    "start": "2026-09-24", "end": "2026-09-28",
                },
            ]),
        }
        config = transform_intake(intake)
        dallas, road_trip = config["phases"]
        self.assertEqual(dallas["title"]["en"], "Dallas")
        self.assertEqual(dallas["tabLabel"], "DALLAS")
        self.assertNotIn(";", dallas["title"]["en"])
        self.assertLessEqual(len(road_trip["title"]["en"]), 30)
        self.assertNotIn("Washington", road_trip["title"]["en"])

    def test_verbose_name_keeps_the_trimmed_context_in_the_note_blurb(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {"name": "Orlando — Disney and Universal (all travelers)", "start": "2026-09-22", "end": "2026-09-24"},
            ]),
        }
        config = transform_intake(intake)
        phase = config["phases"][0]
        self.assertEqual(phase["title"]["en"], "Orlando")
        self.assertIn("2 nights in Orlando", phase["note"]["en"])
        self.assertIn("Disney and Universal (all travelers)", phase["note"]["en"])

    def test_a_plain_dated_phase_gets_a_stay_blurb_not_a_name_dump(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([{"name": "Tokyo", "start": "2026-09-06", "end": "2026-09-10"}]),
        }
        phase = transform_intake(intake)["phases"][0]
        self.assertEqual(phase["note"]["en"], "4 nights in Tokyo, 6 Sep–10 Sep")
        self.assertIn("4 לילות", phase["note"]["he"])

    def test_a_phase_with_no_dates_and_a_plain_name_has_no_note(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([{"name": "Tokyo"}]),
        }
        self.assertNotIn("note", transform_intake(intake)["phases"][0])

    def test_adjacent_same_named_phases_are_merged(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {"name": "Dallas (boys; Mavericks game September 6)", "start": "2026-09-05", "end": "2026-09-08"},
                {"name": "Dallas (all travelers)", "start": "2026-09-08", "end": "2026-09-10"},
            ]),
        }
        config = transform_intake(intake)
        self.assertEqual(len(config["phases"]), 1)
        dallas = config["phases"][0]
        self.assertEqual(dallas["title"]["en"], "Dallas")
        self.assertEqual(dallas["dates"], {"start": "2026-09-05", "end": "2026-09-10"})
        self.assertIn("boys", dallas["note"]["en"])
        self.assertIn("all travelers", dallas["note"]["en"])

    def test_non_adjacent_same_named_phases_stay_separate(self) -> None:
        # Two visits to New York at different points in the trip must not
        # collapse into one phase just because they share a short name.
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {"name": "New York (girls)", "start": "2026-09-05", "end": "2026-09-08"},
                {"name": "Dallas", "start": "2026-09-08", "end": "2026-09-10"},
                {"name": "New York (hotel booked)", "start": "2026-09-28", "end": "2026-09-30"},
            ]),
        }
        config = transform_intake(intake)
        self.assertEqual(len(config["phases"]), 3)
        ny_titles = [p["title"]["en"] for p in config["phases"] if p["title"]["en"] == "New York"]
        self.assertEqual(len(ny_titles), 2)
        ny_ids = {p["id"] for p in config["phases"] if p["title"]["en"] == "New York"}
        self.assertEqual(len(ny_ids), 2)

    def test_city_state_name_drops_the_state_from_the_title(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {"name": "Clearwater, Florida (all travelers)", "start": "2026-09-10", "end": "2026-09-16"},
            ]),
        }
        config = transform_intake(intake)
        phase = config["phases"][0]
        self.assertEqual(phase["title"]["en"], "Clearwater")
        self.assertIn("Florida", phase["note"]["en"])

    def test_phase_id_is_derived_from_the_shortened_name(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {"name": "Dallas (boys; Mavericks game September 6)", "start": "2026-09-05", "end": "2026-09-08"},
            ]),
        }
        config = transform_intake(intake)
        self.assertEqual(config["phases"][0]["id"], "dallas")

    def test_phase_days_are_projected_when_the_intake_carries_them(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {
                    "name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
                    "days": [
                        {
                            "date": "2026-09-20",
                            "label": {"he": "יום 1", "en": "Arrival & Asakusa"},
                            "items": [
                                {"time": "10:00", "text": {"he": "סקייטרי", "en": "Tokyo Skytree"}},
                                {"time": None, "text": {"he": "אסקוסה", "en": "Evening in Asakusa"}},
                            ],
                        },
                    ],
                },
            ]),
        }
        phase = transform_intake(intake)["phases"][0]
        self.assertEqual(1, len(phase["days"]))
        day = phase["days"][0]
        self.assertEqual("2026-09-20", day["date"])
        self.assertEqual({"he": "יום 1", "en": "Arrival & Asakusa"}, day["label"])
        self.assertEqual("10:00", day["items"][0]["time"])
        self.assertIsNone(day["items"][1]["time"])
        self.assertEqual({"he": "אסקוסה", "en": "Evening in Asakusa"}, day["items"][1]["text"])

    def test_a_phase_with_no_days_has_no_days_key(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([{"name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23"}]),
        }
        self.assertNotIn("days", transform_intake(intake)["phases"][0])

    def test_days_outside_the_phase_range_are_dropped(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {
                    "name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
                    "days": [
                        {"date": "2026-09-20", "items": [{"text": {"en": "in range"}}]},
                        {"date": "2026-10-05", "items": [{"text": {"en": "out of range"}}]},
                        {"date": "not-a-date", "items": [{"text": {"en": "unparseable"}}]},
                    ],
                },
            ]),
        }
        days = transform_intake(intake)["phases"][0]["days"]
        self.assertEqual(["2026-09-20"], [d["date"] for d in days])

    def test_item_language_is_mirrored_and_empty_items_dropped(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {
                    "name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
                    "days": [
                        {"date": "2026-09-20", "items": [
                            {"text": {"en": "English only"}},
                            {"text": {"he": "עברית בלבד"}},
                            {"text": {"he": "", "en": ""}},
                            {"text": {}},
                        ]},
                    ],
                },
            ]),
        }
        items = transform_intake(intake)["phases"][0]["days"][0]["items"]
        self.assertEqual(2, len(items))
        self.assertEqual({"he": "English only", "en": "English only"}, items[0]["text"])
        self.assertEqual({"he": "עברית בלבד", "en": "עברית בלבד"}, items[1]["text"])

    def test_a_day_with_no_valid_items_is_dropped_and_all_bad_means_no_days_key(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {
                    "name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
                    "days": [
                        {"date": "2026-09-20", "items": [{"text": {}}]},
                        {"date": "2026-09-21", "items": []},
                    ],
                },
            ]),
        }
        self.assertNotIn("days", transform_intake(intake)["phases"][0])

    def test_a_bad_time_is_coerced_to_null(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {
                    "name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
                    "days": [{"date": "2026-09-20", "items": [
                        {"time": "morning", "text": {"en": "loose time"}},
                        {"time": "9am", "text": {"en": "also loose"}},
                    ]}],
                },
            ]),
        }
        items = transform_intake(intake)["phases"][0]["days"][0]["items"]
        self.assertTrue(all(i["time"] is None for i in items))

    def test_html_in_day_label_and_item_text_is_stripped(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {
                    "name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
                    "days": [{
                        "date": "2026-09-20",
                        "label": {"en": "<b>Day 1</b>", "he": "יום 1"},
                        "items": [{"text": {"en": "<img src=x onerror=alert(1)> museum"}}],
                    }],
                },
            ]),
        }
        day = transform_intake(intake)["phases"][0]["days"][0]
        self.assertNotIn("<", day["label"]["en"])
        self.assertNotIn(">", day["label"]["en"])
        self.assertNotIn("<", day["items"][0]["text"]["en"])
        self.assertNotIn(">", day["items"][0]["text"]["en"])

    def test_merged_adjacent_phases_concatenate_and_sort_their_days(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([
                {"name": "Tokyo (boys)", "start": "2026-09-19", "end": "2026-09-21",
                 "days": [{"date": "2026-09-20", "items": [{"text": {"en": "day A"}}]}]},
                {"name": "Tokyo (all)", "start": "2026-09-21", "end": "2026-09-23",
                 "days": [{"date": "2026-09-22", "items": [{"text": {"en": "day B"}}]}]},
            ]),
        }
        phases = transform_intake(intake)["phases"]
        self.assertEqual(1, len(phases))
        self.assertEqual(["2026-09-20", "2026-09-22"], [d["date"] for d in phases[0]["days"]])

    def test_travel_anchors_appear_in_stats_when_present(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "travel_anchors": _structured([{"type": "flight", "confirmation": "XYZ"}]),
        }
        config = transform_intake(intake)
        descriptions = " ".join(s["description"]["en"] for s in config["stats"])
        self.assertIn("booking(s)", descriptions)

    def test_multi_place_destination_uses_trip_type_as_brand_theme(self) -> None:
        # A comma/list-like destination can't become a readable short brand,
        # so the brand falls back to a theme derived from the trip type
        # instead of the raw destination list.
        intake = {**JAPAN_INTAKE, "destination": _text("Tokyo, Kyoto & Osaka")}
        config = transform_intake(intake, today=date(2026, 8, 20))
        self.assertEqual(config["meta"]["brand"], "FAMILY TRIP 2026")
        self.assertIn("Family Trip 2026", config["meta"]["title"])

    def test_single_word_destination_becomes_the_brand_directly(self) -> None:
        intake = {**JAPAN_INTAKE, "destination": _text("USA")}
        config = transform_intake(intake, today=date(2026, 8, 20))
        self.assertEqual(config["meta"]["brand"], "USA 2026")
        self.assertTrue(config["meta"]["title"].startswith("USA 2026"))

    def test_known_destination_gets_a_travel_info_currency_entry(self) -> None:
        intake = {**JAPAN_INTAKE, "destination": _text("USA")}
        config = transform_intake(intake)
        countries = config["travel_info"]["countries"]
        self.assertEqual(countries["United States"]["currency"]["code"], "USD")
        self.assertEqual(countries["United States"]["currency"]["symbol"], "$")

    def test_unknown_destination_has_no_travel_info(self) -> None:
        intake = {**JAPAN_INTAKE, "destination": _text("Neverland")}
        config = transform_intake(intake)
        self.assertNotIn("travel_info", config)

    def test_constraints_never_appear_in_stats(self) -> None:
        # constraints is organizer free text kept in the raw intake, not
        # summarized into the Hero strip — same reasoning as trip_interests.
        intake = {
            **JAPAN_INTAKE,
            "constraints": _structured({"dietary": "vegetarian", "mobility": "wheelchair access needed"}),
        }
        config = transform_intake(intake)
        self.assertEqual(len(config["stats"]), 2)
        descriptions = " ".join(s["description"]["en"] for s in config["stats"])
        self.assertNotIn("vegetarian", descriptions)


class SchemaV2Tests(unittest.TestCase):
    """The optional v2 questions: dietary, pace and the assistant persona."""

    def _config(self, **extra) -> dict:
        return transform_intake({**JAPAN_INTAKE, "travelers": TRAVELERS, **extra}, today=date(2026, 8, 20))

    def _needs(self, config: dict, username: str) -> list[dict]:
        for p in config["participants"]:
            if p["username"] == username:
                return p.get("needs", [])
        raise AssertionError(f"no participant {username!r}")

    # ── v1 equivalence ────────────────────────────────────────────────────────

    def test_intake_without_any_v2_answers_is_unchanged(self) -> None:
        # The whole reason one release can serve schema 1 and 2 (migration
        # 0018): an intake that answers none of the new questions must produce
        # byte-identical output to the intake that could not have answered them.
        baseline = transform_intake({**JAPAN_INTAKE, "travelers": TRAVELERS}, today=date(2026, 8, 20))
        self.assertNotIn("agent", baseline)
        for participant in baseline["participants"]:
            self.assertNotIn("needs", participant)

    def test_all_none_answers_produce_no_agent_block(self) -> None:
        config = self._config(dietary=_multi("none"), bot_proactive=_multi("none"))
        self.assertNotIn("agent", config)

    # ── dietary ───────────────────────────────────────────────────────────────

    def test_named_person_gets_a_dietary_need(self) -> None:
        config = self._config(
            dietary=_multi("vegetarian"),
            dietary_scope=_structured({"vegetarian": ["Noa"]}),
        )
        self.assertEqual(self._needs(config, "noa"), [
            {"type": "dietary", "severity": "firm", "text": {"he": "צמחוני/ת", "en": "Vegetarian"}},
        ])
        # Scoped to one person means exactly one person.
        self.assertEqual(self._needs(config, "eitan"), [])
        self.assertNotIn("standing_instructions", config.get("agent", {}))

    def test_everyone_scope_is_one_instruction_not_a_need_per_person(self) -> None:
        config = self._config(
            dietary=_multi("kosher"),
            dietary_scope=_structured({"kosher": "everyone"}),
        )
        for participant in config["participants"]:
            self.assertNotIn("needs", participant)
        instructions = config["agent"]["standing_instructions"]
        self.assertEqual(len(instructions), 1)
        self.assertIn("Everyone travelling", instructions[0]["text"]["en"])
        self.assertIn("Keeps kosher", instructions[0]["text"]["en"])

    def test_nut_allergy_is_an_allergy_not_a_dietary_preference(self) -> None:
        # 'allergy' + 'critical' is what makes shared/needs-schema.js default it
        # to organizer-only; classifying it as dietary would publish it to every
        # logged-in family member instead.
        config = self._config(
            dietary=_multi("nut_allergy"),
            dietary_scope=_structured({"nut_allergy": ["Eitan"]}),
        )
        need = self._needs(config, "eitan")[0]
        self.assertEqual(need["type"], "allergy")
        self.assertEqual(need["severity"], "critical")

    def test_unscoped_restriction_survives_as_a_group_instruction(self) -> None:
        # Ticked but never scoped, and scoped to someone not on the roster:
        # both are unattributable, and both must still reach the assistant
        # rather than being silently dropped.
        config = self._config(
            dietary=_multi("gluten_free", "vegan"),
            dietary_scope=_structured({"vegan": ["Somebody Not On The Trip"]}),
        )
        for participant in config["participants"]:
            self.assertNotIn("needs", participant)
        english = [i["text"]["en"] for i in config["agent"]["standing_instructions"]]
        self.assertEqual(len(english), 2)
        self.assertTrue(any("Gluten-free" in t for t in english), english)
        self.assertTrue(any("Vegan" in t for t in english), english)

    def test_every_dietary_option_is_bilingual(self) -> None:
        config = self._config(dietary=_multi(
            "kosher", "kosher_style", "vegetarian", "vegan",
            "lactose_free", "gluten_free", "nut_allergy",
        ))
        instructions = config["agent"]["standing_instructions"]
        self.assertEqual(len(instructions), 7)
        for entry in instructions:
            # A missing side renders as a silent blank in the site's bilingual
            # span helper, not a fallback to the other language.
            self.assertTrue(entry["text"]["he"].strip(), entry)
            self.assertTrue(entry["text"]["en"].strip(), entry)

    # ── visibility ────────────────────────────────────────────────────────────

    def test_every_standing_instruction_is_organizer_only(self) -> None:
        config = self._config(
            trip_pace=_choice("easygoing"),
            dietary=_multi("kosher"),
            dietary_scope=_structured({"kosher": "everyone"}),
            bot_limits=_structured([{"he": "להימנע מפוליטיקה", "en": "Avoid politics"}]),
        )
        instructions = config["agent"]["standing_instructions"]
        self.assertEqual(len(instructions), 3)
        for entry in instructions:
            self.assertEqual(entry["visibility"], "organizer", entry)

    # ── pace ──────────────────────────────────────────────────────────────────

    def test_pace_becomes_a_standing_instruction(self) -> None:
        config = self._config(trip_pace=_choice("intense"))
        instruction = config["agent"]["standing_instructions"][0]
        self.assertIn("Intense pace", instruction["text"]["en"])

    def test_unknown_pace_option_is_ignored(self) -> None:
        config = self._config(trip_pace=_choice("frantic"))
        self.assertNotIn("agent", config)

    # ── assistant persona ─────────────────────────────────────────────────────

    def test_persona_block(self) -> None:
        config = self._config(
            bot_name=_text("ויקטור"),
            bot_gender=_choice("male"),
            bot_tone=_choice("playful"),
            timezone=_text("Asia/Tokyo"),
            bot_proactive=_multi("morning_briefing", "flight_changes"),
        )
        agent = config["agent"]
        self.assertEqual(agent["name"], "ויקטור")
        self.assertEqual(agent["gender"], "male")
        self.assertEqual(agent["tone"], "playful")
        self.assertEqual(agent["timezone"], "Asia/Tokyo")
        self.assertEqual(agent["proactive"], {"morning_briefing": "07:30", "flight_changes": True})

    def test_named_assistant_without_gender_falls_back_to_neutral(self) -> None:
        # Hebrew conjugates by gender; 'neutral' is gender-avoidant phrasing,
        # which is the honest answer for "wasn't asked". Guessing from the name
        # would be wrong in every single message it got wrong.
        config = self._config(bot_name=_text("Victor"))
        self.assertEqual(config["agent"]["gender"], "neutral")
        self.assertEqual(config["agent"]["tone"], "warm")

    def test_no_bot_name_writes_no_persona(self) -> None:
        config = self._config(bot_tone=_choice("dry"), bot_gender=_choice("female"))
        self.assertNotIn("agent", config)

    def test_bot_limits_missing_a_language_is_dropped(self) -> None:
        config = self._config(bot_limits=_structured([
            {"he": "רק עברית"},
            {"en": "English only"},
            {"he": "שניהם", "en": "Both"},
            "not a dict",
        ]))
        instructions = config["agent"]["standing_instructions"]
        self.assertEqual(len(instructions), 1)
        self.assertEqual(instructions[0]["text"], {"he": "שניהם", "en": "Both"})

    # ── organizer ─────────────────────────────────────────────────────────────

    def test_organizer_identity_resolves_to_a_username(self) -> None:
        config = self._config(organizer_identity=_text("eitan"))
        self.assertEqual(config["agent"]["organizers"], ["eitan"])

    def test_unmatched_organizer_identity_writes_no_organizers(self) -> None:
        # driver.mjs hard-fails on an organizer absent from participants[], and
        # a username belonging to someone else would silently hand them the
        # organizer's private channel. Omitting is the recoverable failure.
        config = self._config(organizer_identity=_text("Grandma Ruth"))
        self.assertNotIn("agent", config)


if __name__ == "__main__":
    unittest.main()


class NonLatinNameTests(unittest.TestCase):
    """Hebrew-only traveler names produced usernames traveler/traveler1..4 and a
    family whose `en` was Hebrew, because _slugify strips every non-[a-z0-9]
    character and name_en/family fall back to the original. Confirmed on the
    first pipeline-built site (japan-2026, 2026-08-28). The transformer must at
    least honour explicitly supplied English names.
    """

    def _config(self, travelers: list[dict]) -> dict:
        return transform_intake({**JAPAN_INTAKE, "travelers": _structured(travelers)})

    def test_supplied_english_names_become_the_usernames(self) -> None:
        config = self._config([
            {"name": "ניר", "name_en": "Nir", "age": 56, "family": "סולומון", "family_en": "Solomon"},
            {"name": "אלה", "name_en": "Ella", "age": 53, "family": "סולומון", "family_en": "Solomon"},
        ])

        self.assertEqual(["nir", "ella"], [p["username"] for p in config["participants"]])

    def test_family_keeps_hebrew_display_but_uses_english_where_given(self) -> None:
        config = self._config([
            {"name": "ניר", "name_en": "Nir", "age": 56, "family": "סולומון", "family_en": "Solomon"},
        ])

        family = config["families"][0]
        self.assertEqual("סולומון", family["name"]["he"])
        self.assertEqual("Solomon", family["name"]["en"])


class PhaseVenuesTests(unittest.TestCase):
    def _phase(self, venues):
        intake = {**JAPAN_INTAKE, "phases": _structured([
            {"name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23", "venues": venues},
        ])}
        return transform_intake(intake)["phases"][0]

    def test_venues_project_with_slug_ids_and_kept_urls(self) -> None:
        p = self._phase([
            {"name": {"he": "סקייטרי", "en": "Tokyo Skytree"}, "url": "https://www.tokyo-skytree.jp/en/"},
            {"name": {"en": "TeamLab Planets"}, "url": "javascript:alert(1)"},
        ])
        self.assertEqual([v["id"] for v in p["venues"]], ["tokyo-skytree", "teamlab-planets"])
        self.assertEqual(p["venues"][0]["url"], "https://www.tokyo-skytree.jp/en/")
        self.assertNotIn("url", p["venues"][1])  # non-http dropped

    def test_venues_dedupe_by_name_and_empty_names_drop(self) -> None:
        p = self._phase([
            {"name": {"en": "Senso-ji"}},
            {"name": {"en": "senso-ji"}},
            {"name": {}},
        ])
        self.assertEqual(len(p["venues"]), 1)

    def test_a_phase_with_no_venues_has_no_venues_key(self) -> None:
        p = self._phase([])
        self.assertNotIn("venues", p)


class HomeCountryTests(unittest.TestCase):
    def test_answer_is_written_to_meta_home_country(self) -> None:
        intake = {**JAPAN_INTAKE, "home_country": _text("United States")}
        self.assertEqual("United States", transform_intake(intake)["meta"]["home_country"])

    def test_absent_answer_leaves_no_meta_key(self) -> None:
        self.assertNotIn("home_country", transform_intake(dict(JAPAN_INTAKE))["meta"])


class DeriveBudgetTests(unittest.TestCase):
    BASE = {
        **JAPAN_INTAKE,
        "phases": _structured([
            {"name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23"},
            {"name": "Kyoto", "start": "2026-09-24", "end": "2026-09-27"},
        ]),
    }

    def _budget(self, detail: dict) -> dict:
        intake = {**self.BASE, "budget_detail": _structured(detail)}
        return transform_intake(intake).get("budget")

    def test_no_answer_means_no_budget_block(self) -> None:
        self.assertIsNone(transform_intake(dict(self.BASE)).get("budget"))

    def test_items_become_seed_items_matched_to_phases(self) -> None:
        budget = self._budget({
            "currency": "USD", "party_size": 4,
            "items": [
                {"phase": "Kyoto", "category": "hotel", "description": "Cross Hotel × 3", "amount": 900},
                {"category": "flight", "description": "TLV-NRT × 4", "amount": 0, "estimate": True},
            ],
        })
        self.assertEqual(4, budget["party_size"])
        self.assertEqual("USD", budget["currency"])
        self.assertEqual(["intl_flights", "kyoto"], budget["phases"])
        kyoto = next(s for s in budget["seed_items"] if s["phase"] == "kyoto")
        self.assertEqual(900, kyoto["amount"])
        self.assertFalse(kyoto["is_estimate"])
        flight = next(s for s in budget["seed_items"] if s["phase"] == "intl_flights")
        self.assertTrue(flight["is_estimate"])

    def test_unknown_category_falls_back_to_other_and_seed_keys_are_unique(self) -> None:
        budget = self._budget({"items": [
            {"phase": "Tokyo", "category": "spa", "description": "onsen", "amount": 50},
            {"phase": "Tokyo", "category": "spa", "description": "onsen", "amount": 50},
        ]})
        cats = {s["category"] for s in budget["seed_items"]}
        self.assertEqual({"other"}, cats)
        keys = [s["seed_key"] for s in budget["seed_items"]]
        self.assertEqual(len(keys), len(set(keys)))

    def test_party_size_defaults_to_the_traveler_count(self) -> None:
        intake = {
            **self.BASE,
            "travelers": _structured([
                {"name": "A", "family": "X"}, {"name": "B", "family": "X"}, {"name": "C", "family": "X"},
            ]),
            "budget_detail": _structured({"items": [
                {"category": "food", "description": "meals", "amount": 400},
            ]}),
        }
        self.assertEqual(3, transform_intake(intake)["budget"]["party_size"])

    def test_markup_in_a_description_is_stripped(self) -> None:
        budget = self._budget({"items": [
            {"category": "attraction", "description": "<b>Disney</b> tickets", "amount": 300},
        ]})
        self.assertNotIn("<", budget["seed_items"][0]["description"])


class DeriveBookingsTests(unittest.TestCase):
    """travel_anchors[] used to be collapsed into a single stat number and then
    thrown away — the interview's most concrete output (dated activity tickets,
    a tour proposal) never reached the site. derive_bookings turns them, plus
    each phase's accommodation, into bookings.json rows so the site's Bookings
    tab has real content. Confirmed missing on japan-2026 (2026-08-28).
    """

    PHASED_INTAKE = {
        **JAPAN_INTAKE,
        "phases": _structured([
            {
                "name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
                "accommodation": {"name": "OMO3 Asakusa"},
            },
            {
                "name": "Kyoto", "start": "2026-09-24", "end": "2026-09-27",
                "accommodation": {"name": "Cross Hotel Kyoto", "confirmation": "CH-88"},
            },
        ]),
    }

    def _bookings(self, intake: dict) -> list[dict]:
        config = transform_intake(intake)
        return derive_bookings(config, intake)

    def test_each_phase_accommodation_becomes_a_hotel_booking(self) -> None:
        bookings = self._bookings(self.PHASED_INTAKE)
        hotels = [b for b in bookings if b["type"] == "hotel"]
        self.assertEqual(2, len(hotels))
        tokyo = next(b for b in hotels if b["phase"] == "tokyo")
        self.assertEqual("OMO3 Asakusa", tokyo["name"])
        self.assertEqual("2026-09-19", tokyo["date_from"])
        self.assertEqual("2026-09-23", tokyo["date_to"])
        # No confirmation given → surfaced as unconfirmed, never dropped.
        self.assertIsNone(tokyo["confirmation"])
        kyoto = next(b for b in hotels if b["phase"] == "kyoto")
        self.assertEqual("CH-88", kyoto["confirmation"])

    def test_travel_anchor_becomes_a_dated_booking_mapped_to_its_phase(self) -> None:
        intake = {
            **self.PHASED_INTAKE,
            "travel_anchors": _structured([
                {"type": "activity", "detail": "Tokyo Skytree E-ticket — 20 Sep 2026 10:00"},
            ]),
        }
        bookings = self._bookings(intake)
        # "activity" is not a valid site booking type — it must land as "attraction".
        anchor = next(b for b in bookings if b["type"] == "attraction")
        self.assertEqual("Tokyo Skytree E-ticket", anchor["name"])
        self.assertEqual("2026-09-20", anchor["date_from"])
        self.assertEqual("tokyo", anchor["phase"])
        self.assertEqual("Tokyo Skytree E-ticket — 20 Sep 2026 10:00", anchor["notes"])
        self.assertIsNone(anchor["confirmation"])

    def test_iso_dates_in_anchor_text_are_recognised(self) -> None:
        intake = {
            **self.PHASED_INTAKE,
            "travel_anchors": _structured([
                {"type": "reservation", "detail": "Sumo hall 2026-09-25 17:00"},
            ]),
        }
        anchor = self._bookings(intake)[-1]
        self.assertEqual("2026-09-25", anchor["date_from"])
        self.assertEqual("kyoto", anchor["phase"])

    def test_every_anchor_type_maps_into_the_sites_allowed_set(self) -> None:
        allowed = {"flight", "hotel", "car", "attraction", "other"}
        intake = {
            **self.PHASED_INTAKE,
            "travel_anchors": _structured([
                {"type": t, "detail": f"{t} thing"}
                for t in ("flight", "hotel", "car", "activity", "tour", "reservation",
                          "ticket", "excursion", "proposal", "booking", "wibble", "")
            ]),
        }
        anchors = [b for b in self._bookings(intake) if b["seed_key"].startswith("anchor_")]
        self.assertTrue(anchors)
        self.assertTrue(all(b["type"] in allowed for b in anchors))

    def test_proposal_is_undated_and_parked_on_the_first_phase(self) -> None:
        # The detail carries a date *range*, so it gets no date. But
        # bookings.phase is NOT NULL on the site, so it can't be dropped —
        # it parks on the first phase and still shows on the Bookings tab.
        intake = {
            **self.PHASED_INTAKE,
            "travel_anchors": _structured([
                {"type": "proposal",
                 "detail": "Japan Tours quote #100665 for 5 adults, 19 Sep–03 Oct 2026"},
            ]),
        }
        proposal = next(b for b in self._bookings(intake) if b["seed_key"].startswith("anchor_"))
        self.assertEqual("other", proposal["type"])
        self.assertIsNone(proposal["date_from"])
        self.assertEqual("tokyo", proposal["phase"])
        self.assertIn("Japan Tours quote", proposal["notes"])

    def test_no_anchor_row_ever_has_a_null_phase(self) -> None:
        intake = {
            **self.PHASED_INTAKE,
            "travel_anchors": _structured([
                {"type": "proposal", "detail": "whole-trip quote, no dates"},
                {"type": "activity", "detail": "undated museum pass"},
                {"type": "flight", "detail": "DL123 on 20 Sep 2026"},
            ]),
        }
        self.assertTrue(all(b["phase"] for b in self._bookings(intake)))

    def test_every_row_carries_a_stable_seed_key(self) -> None:
        intake = {
            **self.PHASED_INTAKE,
            "travel_anchors": _structured([
                {"type": "activity", "detail": "TeamLab Planets — 20 Sep 2026 18:00"},
            ]),
        }
        first = self._bookings(intake)
        second = self._bookings(intake)
        self.assertEqual([b["seed_key"] for b in first], [b["seed_key"] for b in second])
        self.assertEqual(len(first), len({b["seed_key"] for b in first}))

    def test_no_phases_and_no_anchors_yields_no_bookings(self) -> None:
        self.assertEqual([], self._bookings(JAPAN_INTAKE))

    def test_hotel_row_has_a_null_location_url_when_the_config_was_not_enriched(self) -> None:
        hotel = next(b for b in self._bookings(self.PHASED_INTAKE) if b["type"] == "hotel")
        self.assertIn("location_url", hotel)
        self.assertIsNone(hotel["location_url"])


class DeriveBookingsLinkTests(unittest.TestCase):
    """Sprint 4.7: derive_bookings() runs on the already-enriched config, so a
    hotel row can carry the map link enrichment anchored on that hotel, and an
    anchor row can reuse a link the itinerary venues already resolved."""

    def _enriched_config(self) -> dict:
        return {
            "phases": [{
                "id": "tokyo",
                "dates": {"start": "2026-09-19", "end": "2026-09-23"},
                "accommodation": {
                    "name": "OMO3 Asakusa", "name_en": "OMO3 Asakusa",
                    "maps": "https://www.google.com/maps/search/?api=1&query=OMO3%20Asakusa",
                },
                "venues": [
                    {"id": "skytree", "name": {"en": "Tokyo Skytree"},
                     "url": "https://www.tokyo-skytree.jp/en/"},
                ],
            }],
        }

    def test_hotel_row_takes_its_location_url_from_the_enriched_accommodation(self) -> None:
        rows = derive_bookings(self._enriched_config(), JAPAN_INTAKE)
        hotel = next(b for b in rows if b["type"] == "hotel")
        self.assertIn("OMO3%20Asakusa", hotel["location_url"])

    def test_anchor_row_reuses_a_link_from_a_venue_it_names(self) -> None:
        data = {
            **JAPAN_INTAKE,
            "travel_anchors": _structured([
                {"type": "activity", "detail": "Tokyo Skytree e-ticket — 20 Sep 2026 10:00"},
            ]),
        }
        rows = derive_bookings(self._enriched_config(), data)
        anchor = next(b for b in rows if b["seed_key"].startswith("anchor_"))
        self.assertEqual("https://www.tokyo-skytree.jp/en/", anchor["location_url"])

    def test_an_anchor_that_names_no_venue_gets_no_link(self) -> None:
        data = {
            **JAPAN_INTAKE,
            "travel_anchors": _structured([{"type": "other", "detail": "misc reservation"}]),
        }
        rows = derive_bookings(self._enriched_config(), data)
        anchor = next(b for b in rows if b["seed_key"].startswith("anchor_"))
        self.assertIsNone(anchor["location_url"])

    def test_a_non_http_accommodation_maps_value_is_ignored(self) -> None:
        cfg = self._enriched_config()
        cfg["phases"][0]["accommodation"]["maps"] = "javascript:alert(1)"
        cfg["phases"][0]["venues"] = []
        hotel = next(b for b in derive_bookings(cfg, JAPAN_INTAKE) if b["type"] == "hotel")
        self.assertIsNone(hotel["location_url"])
