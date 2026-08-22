"""Tests for the intake transformer."""
from __future__ import annotations

import unittest
from datetime import date

from control_plane_worker.transformer import transform_intake


def _choice(option_id: str) -> dict:
    return {"kind": "choice", "option_id": option_id, "schema_version": 1, "other_text": None}


def _choice_other(other_text: str) -> dict:
    return {"kind": "choice_other", "option_id": None, "schema_version": 1, "other_text": other_text}


def _text(value: str) -> dict:
    return {"kind": "text", "schema_version": 1, "text": value}


def _structured(value) -> dict:
    return {"kind": "structured", "schema_version": 1, "data": value}


JAPAN_INTAKE = {
    "trip_type": _choice("family"),
    "destination": _text("Japan"),
    "group_size": _choice("2"),
    "trip_duration": _choice("two_weeks"),
    "trip_interests": _text("temples, matcha, onsen"),
}


class TransformerTests(unittest.TestCase):
    def test_japan_fixture_produces_valid_meta(self) -> None:
        today = date(2026, 8, 20)
        config = transform_intake(JAPAN_INTAKE, today=today)

        meta = config["meta"]
        self.assertEqual(meta["title"], "Japan — Family")
        self.assertEqual(meta["title_en"], "Japan — Family")
        self.assertEqual(meta["totalDays"], 14)
        self.assertEqual(meta["returnDate"], "2026-12-02")
        # Departure should be 90 days from today.
        self.assertEqual(meta["departure"][:10], "2026-11-18")
        self.assertIn("+00:00", meta["departure"])
        self.assertEqual(meta["defaultLang"], "en")
        self.assertEqual(meta["brand"], "KINERARY")

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

    def test_interests_appear_in_stats_when_present(self) -> None:
        config = transform_intake(JAPAN_INTAKE)
        stat_texts = " ".join(
            s["description"].get("en", "") for s in config["stats"]
        )
        self.assertIn("temples", stat_texts)

    def test_interests_omitted_from_stats_when_absent(self) -> None:
        intake = {**JAPAN_INTAKE, "trip_interests": _text("")}
        config = transform_intake(intake)
        self.assertEqual(len(config["stats"]), 2)

    def test_other_trip_type_uses_free_text(self) -> None:
        intake = {**JAPAN_INTAKE, "trip_type": _choice_other("Extended family reunion")}
        config = transform_intake(intake)
        self.assertIn("Extended family reunion", config["meta"]["title"])

    def test_other_group_size_uses_free_text(self) -> None:
        intake = {**JAPAN_INTAKE, "group_size": _choice_other("15 people")}
        config = transform_intake(intake)
        stat_numbers = {s["number"] for s in config["stats"]}
        self.assertIn("15 people", stat_numbers)

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

    def test_travel_anchors_appear_in_stats_when_present(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "travel_anchors": _structured([{"type": "flight", "confirmation": "XYZ"}]),
        }
        config = transform_intake(intake)
        descriptions = " ".join(s["description"]["en"] for s in config["stats"])
        self.assertIn("booking(s)", descriptions)

    def test_constraints_appear_in_stats_when_present(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "constraints": _structured({"dietary": "vegetarian", "mobility": "wheelchair access needed"}),
        }
        config = transform_intake(intake)
        descriptions = " ".join(s["description"]["en"] for s in config["stats"])
        self.assertIn("vegetarian", descriptions)

    def test_empty_constraints_object_omitted_from_stats(self) -> None:
        intake = {**JAPAN_INTAKE, "constraints": _structured({})}
        config = transform_intake(intake)
        for stat in config["stats"]:
            self.assertNotIn("!", stat["number"])


if __name__ == "__main__":
    unittest.main()
