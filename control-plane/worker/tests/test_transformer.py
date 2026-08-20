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


if __name__ == "__main__":
    unittest.main()
