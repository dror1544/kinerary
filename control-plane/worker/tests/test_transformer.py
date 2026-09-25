"""Tests for the intake transformer."""
from __future__ import annotations

import json
import re
import unittest
from datetime import date
from pathlib import Path

from control_plane_worker import transformer
from control_plane_worker.transformer import (
    _names_sound_alike,
    _resolve_organizers,
    _stable_id,
    derive_days_from_anchors,
    derive_bookings,
    derive_rsvp_activities,
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
    def test_planning_help_is_carried_to_the_companion(self) -> None:
        # The interview collects structure; what the organizer still wants help
        # with is work the trip companion does afterwards. Carrying it as a
        # standing instruction is what stops the ask being lost between the two
        # agents.
        intake = {**JAPAN_INTAKE, "planning_help": _text("we haven't worked out Kyoto yet")}
        config = transform_intake(intake)
        instructions = config["agent"]["standing_instructions"]
        carried = [i for i in instructions if "Kyoto" in i["text"]["en"]]
        self.assertEqual(len(carried), 1, "the organizer's ask reaches the companion")
        self.assertIn("Kyoto", carried[0]["text"]["he"], "both languages carry it")

    def test_planning_help_is_organizer_only(self) -> None:
        # It is the organizer's own words about what they have not sorted out —
        # not something to publish to the whole family.
        intake = {**JAPAN_INTAKE, "planning_help": _text("still need to book the ryokan")}
        config = transform_intake(intake)
        carried = [i for i in config["agent"]["standing_instructions"] if "ryokan" in i["text"]["en"]]
        self.assertEqual(carried[0]["visibility"], "organizer")

    def test_no_planning_help_adds_no_instruction(self) -> None:
        # Additive-optional: an intake without it must transform exactly as before.
        without = transform_intake(JAPAN_INTAKE)
        blank = transform_intake({**JAPAN_INTAKE, "planning_help": _text("   ")})
        self.assertEqual(
            (without.get("agent") or {}).get("standing_instructions"),
            (blank.get("agent") or {}).get("standing_instructions"),
        )



    def test_non_latin_destination_falls_back_to_a_phase_name(self) -> None:
        # "trip-2026" is a URL a family cannot tell from anyone else's; a
        # phase name is one they recognise (capture ledger, General #4).
        intake = {
            **JAPAN_INTAKE,
            "destination": _text("יפן"),
            "phases": _structured([
                {"name": "טוקיו", "name_en": "Tokyo"},
                {"name": "Kyoto"},
            ]),
        }
        self.assertEqual(derive_trip_slug(intake, today=date(2026, 8, 20)), "tokyo-2026")

    def test_phase_fallback_skips_phases_that_slugify_to_nothing(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "destination": _text("יפן"),
            "phases": _structured([{"name": "טוקיו"}, {"name": "Kyoto"}]),
        }
        self.assertEqual(derive_trip_slug(intake, today=date(2026, 8, 20)), "kyoto-2026")

    def test_generic_fallback_remains_when_nothing_is_latin(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "destination": _text("יפן"),
            "phases": _structured([{"name": "טוקיו"}]),
        }
        self.assertEqual(derive_trip_slug(intake, today=date(2026, 8, 20)), "trip-2026")



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

    def test_other_trip_type_reaches_the_companion_as_context(self) -> None:
        intake = {**JAPAN_INTAKE, "trip_type": _choice_other("Extended family reunion")}
        config = transform_intake(intake)
        instructions = config["agent"]["standing_instructions"]
        self.assertTrue(any(
            item["text"]["en"] == "The organizer describes this trip as: Extended family reunion"
            for item in instructions
        ))

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

    def test_missing_group_size_is_derived_from_the_roster(self) -> None:
        # The interview no longer asks headcount separately (capture ledger,
        # Step 3 #3): it is counted off `travelers`, which is required and
        # names each person, so the stat cannot disagree with the roster.
        intake = {k: v for k, v in JAPAN_INTAKE.items() if k != "group_size"}
        intake["travelers"] = _structured([
            {"name": "Eitan", "family": "Sagi"},
            {"name": "Noa", "family": "Sagi"},
            {"name": "Dana", "family": "Cohen"},
        ])
        config = transform_intake(intake)
        self.assertIn("3", {s["number"] for s in config["stats"]})

    def test_the_roster_wins_over_a_stored_group_size(self) -> None:
        # A legacy intake carries both. The roster is the precise one, and an
        # organizer who listed three people should never see "2".
        intake = {**JAPAN_INTAKE, "travelers": _structured([
            {"name": "Eitan", "family": "Sagi"},
            {"name": "Noa", "family": "Sagi"},
            {"name": "Dana", "family": "Cohen"},
        ])}
        self.assertEqual(intake["group_size"]["option_id"], "2")
        config = transform_intake(intake)
        stat_numbers = {s["number"] for s in config["stats"]}
        self.assertIn("3", stat_numbers)
        self.assertNotIn("2", stat_numbers)

    def test_a_stored_group_size_is_still_used_with_no_roster(self) -> None:
        # Intakes confirmed before the change carry group_size and an empty
        # roster; nothing rewrites a confirmed version, so they must not
        # regress to "0".
        config = transform_intake(JAPAN_INTAKE)
        self.assertIn("2", {s["number"] for s in config["stats"]})

    def test_missing_trip_duration_is_derived_from_the_dates(self) -> None:
        # Both date questions are required, so a new intake always has the
        # pair duration used to stand in for (capture ledger, Step 3 #4).
        intake = {k: v for k, v in JAPAN_INTAKE.items() if k != "trip_duration"}
        intake["departure_date"] = _text("2026-11-01")
        intake["return_date"] = _text("2026-11-15")
        config = transform_intake(intake)
        self.assertIn("14", {s["number"] for s in config["stats"]})

    def test_missing_trip_duration_and_dates_falls_back_to_a_default(self) -> None:
        # Neither asked nor derivable: the placeholder path the organizer
        # refines later must still produce a trip, not raise.
        intake = {
            k: v for k, v in JAPAN_INTAKE.items()
            if k not in ("trip_duration", "departure_date", "return_date")
        }
        config = transform_intake(intake)
        self.assertIn("7", {s["number"] for s in config["stats"]})

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

    def test_a_destination_leading_with_its_country_is_named_by_it(self) -> None:
        # 2026-09-14, automated manual run: "Portugal — Lisbon and Porto" was titled "Family Trip 2026" and got no currency.
        for destination, country, brand in [
            ("Portugal — Lisbon and Porto", "Portugal", "PORTUGAL 2026"),
            ("Japan: Tokyo, Kyoto", "Japan", "JAPAN 2026"),
        ]:
            with self.subTest(destination=destination):
                config = transform_intake({**JAPAN_INTAKE, "destination": _text(destination)}, today=date(2026, 8, 20))
                self.assertEqual(config["meta"]["brand"], brand)
                self.assertTrue(config["meta"]["title"].startswith(brand.title()))
                self.assertIn(country, config["travel_info"]["countries"])

    def test_cities_joined_by_and_with_no_leading_country_still_use_the_trip_type(self) -> None:
        config = transform_intake({**JAPAN_INTAKE, "destination": _text("Lisbon and Porto")}, today=date(2026, 8, 20))
        self.assertEqual(config["meta"]["brand"], "FAMILY TRIP 2026")

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
            {"type": "dietary", "severity": "firm", "visibility": "group", "text": {"he": "צמחוני/ת", "en": "Vegetarian"}},
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

    def test_a_first_name_scopes_a_need_to_a_traveller_listed_by_full_name(self) -> None:
        # 2026-09-14, automated multi run: the scope said "Omri", the roster "Omri Levi", and the need went group-wide.
        config = self._config(
            travelers=_structured([
                {"name": "Omri Levi", "age": 10, "family": "Levi"},
                {"name": "Yael Levi", "age": 8, "family": "Levi"},
            ]),
            dietary=_multi("vegetarian"),
            dietary_scope=_structured({"vegetarian": ["Omri"]}),
        )
        omri = next(p for p in config["participants"] if p["name"] == "Omri Levi")
        self.assertEqual([n["text"]["en"] for n in omri.get("needs", [])], ["Vegetarian"])
        self.assertNotIn("standing_instructions", config.get("agent") or {})

    def test_a_first_name_two_travellers_share_stays_group_wide(self) -> None:
        config = self._config(
            travelers=_structured([
                {"name": "Dana Levi", "age": 40, "family": "Levi"},
                {"name": "Dana Cohen", "age": 38, "family": "Cohen"},
            ]),
            dietary=_multi("nut_allergy"),
            dietary_scope=_structured({"nut_allergy": ["Dana"]}),
        )
        for participant in config["participants"]:
            self.assertNotIn("needs", participant, "an ambiguous name must not pick one of them")
        self.assertEqual(len(config["agent"]["standing_instructions"]), 1)

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

    def test_only_dietary_instructions_follow_the_sharing_choice(self) -> None:
        config = self._config(
            trip_pace=_choice("easygoing"),
            dietary=_multi("kosher"),
            dietary_scope=_structured({"kosher": "everyone"}),
            bot_limits=_structured([{"he": "להימנע מפוליטיקה", "en": "Avoid politics"}]),
        )
        instructions = config["agent"]["standing_instructions"]
        self.assertEqual(len(instructions), 3)
        by_text = {i["text"]["en"]: i["visibility"] for i in instructions}
        self.assertEqual([v for t, v in by_text.items() if "kosher" in t.lower()], ["group"],
                         "unanswered, a dietary instruction is shared")
        self.assertEqual({v for t, v in by_text.items() if "kosher" not in t.lower()}, {"organizer"},
                         "pace and limits are the organizer's own words and stay private")

    def test_allergies_are_shared_by_default(self) -> None:
        config = self._config(
            dietary=_multi("nut_allergy"),
            dietary_scope=_structured({"nut_allergy": ["Eitan"]}),
        )
        need = self._needs(config, "eitan")[0]
        self.assertEqual((need["type"], need["severity"], need["visibility"]), ("allergy", "critical", "group"))

    def test_the_organizer_can_keep_dietary_needs_to_themselves(self) -> None:
        config = self._config(
            dietary=_multi("vegetarian", "gluten_free"),
            dietary_scope=_structured({"vegetarian": ["Noa"]}),
            dietary_visibility=_choice("organizer"),
        )
        self.assertEqual(self._needs(config, "noa")[0]["visibility"], "organizer")
        self.assertEqual({i["visibility"] for i in config["agent"]["standing_instructions"]}, {"organizer"})

    def test_an_unrecognized_sharing_choice_fails_safe(self) -> None:
        config = self._config(
            dietary=_multi("nut_allergy"),
            dietary_scope=_structured({"nut_allergy": ["Eitan"]}),
            dietary_visibility=_choice("porcupine"),
        )
        self.assertEqual(self._needs(config, "eitan")[0]["visibility"], "organizer")

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

    def test_a_bilingual_name_is_split_into_both_fields(self) -> None:
        # A real answer from japan-2026. The organizer was asked for one name
        # and gave two, because their group types both. Before this split, BOTH
        # name and name_en held the whole string "בוטסאן / botsan", which is a
        # wake-word matching neither of the words anyone actually types.
        config = self._config(bot_name=_text("בוטסאן / botsan"))
        agent = config["agent"]
        self.assertEqual(agent["name"], "בוטסאן")
        self.assertEqual(agent["name_en"], "botsan")

    def test_the_split_does_not_depend_on_which_language_came_first(self) -> None:
        config = self._config(bot_name=_text("Botsan | בוטסאן"))
        agent = config["agent"]
        self.assertEqual(agent["name"], "בוטסאן")
        self.assertEqual(agent["name_en"], "Botsan")

    def test_a_single_name_is_left_whole_in_both_fields(self) -> None:
        # No transliteration is invented. Guessing the missing half would put a
        # name in front of the group that the organizer never chose.
        for single in ("ויקטור", "Victor"):
            with self.subTest(single=single):
                agent = self._config(bot_name=_text(single))["agent"]
                self.assertEqual(agent["name"], single)
                self.assertEqual(agent["name_en"], single)

    def test_a_hyphenated_latin_name_is_not_split(self) -> None:
        # The separator alone must not trigger a split — only a genuine
        # change of script does. "Jean-Luc" is one name.
        agent = self._config(bot_name=_text("Jean-Luc"))["agent"]
        self.assertEqual(agent["name"], "Jean-Luc")
        self.assertEqual(agent["name_en"], "Jean-Luc")

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

    # ── language ──────────────────────────────────────────────────────────────

    def test_the_interview_language_becomes_the_trip_language(self) -> None:
        """Run 14, live: the entire interview was held in Hebrew, the session
        recorded language='he' — and the trip came out with defaultLang 'en',
        because this value was hardcoded. The companion then greeted the
        organizer and the family in English, with a Hebrew assistant name
        embedded in it.

        The language is not a preference to re-ask for. It was established by
        the organizer's own first message and every message after it.
        """
        config = transform_intake(
            {**JAPAN_INTAKE, "travelers": TRAVELERS}, today=date(2026, 8, 20), language="he",
        )
        self.assertEqual(config["meta"]["defaultLang"], "he")

    def test_no_language_still_means_english(self) -> None:
        # Every intake version written before the language was carried has none,
        # and must keep transforming exactly as it did.
        config = transform_intake({**JAPAN_INTAKE, "travelers": TRAVELERS}, today=date(2026, 8, 20))
        self.assertEqual(config["meta"]["defaultLang"], "en")

    def test_an_unrecognised_language_falls_back_rather_than_propagating(self) -> None:
        # Fails safe, matching the shared schema rule: an unknown value resolves
        # to the most conservative option instead of reaching the site as a
        # language code nothing can render.
        for bogus in ("", "  ", "klingon", "EN-GB", None):
            with self.subTest(bogus=bogus):
                config = transform_intake(
                    {**JAPAN_INTAKE, "travelers": TRAVELERS}, today=date(2026, 8, 20), language=bogus,
                )
                self.assertEqual(config["meta"]["defaultLang"], "en")

    def test_the_language_is_case_and_space_insensitive(self) -> None:
        for supplied in ("HE", " he ", "He"):
            with self.subTest(supplied=supplied):
                config = transform_intake(
                    {**JAPAN_INTAKE, "travelers": TRAVELERS}, today=date(2026, 8, 20), language=supplied,
                )
                self.assertEqual(config["meta"]["defaultLang"], "he")

    # ── organizer ─────────────────────────────────────────────────────────────

    def test_organizer_identity_resolves_to_a_username(self) -> None:
        config = self._config(organizer_identity=_text("eitan"))
        self.assertEqual(config["agent"]["organizers"], ["eitan"])

    def test_a_hebrew_given_name_alone_resolves(self) -> None:
        """Run 14, live: the interview asked who the organizer is and the
        organizer typed "ניר". The roster held name="ניר סולומון",
        name_en="Nir", username="nir" — so the ENGLISH given name matched (it
        is already bare in name_en) and the HEBREW one did not, purely because
        `name` carries the full name and `name_en` carries only the first.

        The trip provisioned, the site came up, and the companion was never
        built: ORGANIZER_UNRESOLVED. Answering with your own first name, in the
        language the whole interview was conducted in, is not an edge case.
        """
        config = self._config(
            # The roster exactly as run 14 produced it: full Hebrew `name`,
            # given-name-only `name_en`.
            travelers=_structured([
                {"name": "ניר סולומון", "name_en": "Nir", "family": "סולומון", "family_en": "Solomon"},
                {"name": "אלה סולומון", "name_en": "Ela", "family": "סולומון", "family_en": "Solomon"},
            ]),
            organizer_identity=_text("ניר"),
        )
        self.assertEqual(config["agent"]["organizers"], ["nir"])

    def test_a_given_name_two_travelers_share_stays_unresolved(self) -> None:
        """The reason given names were not matched in the first place, and the
        reason adding them is still safe: ambiguity resolves to nobody, never
        to whoever the roster happens to list first."""
        config = self._config(
            travelers=_structured([
                {"name": "ניר סולומון", "name_en": "Nir S", "family": "סולומון"},
                {"name": "ניר כהן", "name_en": "Nir C", "family": "כהן"},
            ]),
            organizer_identity=_text("ניר"),
        )
        self.assertNotIn("agent", config)

    def test_a_full_name_still_wins_over_a_shared_given_name(self) -> None:
        # Adding given-name forms must not make a precise answer ambiguous.
        config = self._config(
            travelers=_structured([
                {"name": "ניר סולומון", "name_en": "Nir S", "family": "סולומון"},
                {"name": "ניר כהן", "name_en": "Nir C", "family": "כהן"},
            ]),
            organizer_identity=_text("ניר כהן"),
        )
        self.assertEqual(len(config["agent"]["organizers"]), 1)

    def test_the_household_label_alone_still_resolves_to_nobody(self) -> None:
        # A family name is not a person. Unchanged by given-name matching.
        config = self._config(
            travelers=_structured([
                {"name": "ניר סולומון", "name_en": "Nir", "family": "סולומון"},
                {"name": "אלה סולומון", "name_en": "Ela", "family": "סולומון"},
            ]),
            organizer_identity=_text("סולומון"),
        )
        self.assertNotIn("agent", config)

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

    def test_a_venue_named_with_a_plain_string_survives(self) -> None:
        """What the document extractor actually emits, from run 2026-09-09:
        `{"name": "Tokyo Skytree", "time": "..."}` — a plain string, not a
        {he,en} pair. `_bilingual_text` returns None for that, so every venue
        the interview captured was dropped at the last step. Six captured,
        zero survived."""
        p = self._phase([
            {"name": "Tokyo Skytree", "time": "2026-09-20T10:00"},
            {"name": "TeamLab Planets", "time": "2026-09-20T18:00"},
        ])
        self.assertEqual([v["id"] for v in p["venues"]], ["tokyo-skytree", "teamlab-planets"])
        self.assertEqual(p["venues"][0]["name"], {"he": "Tokyo Skytree", "en": "Tokyo Skytree"})

    def test_planned_places_become_venues_without_a_url(self) -> None:
        """A document-derived `phases[].planned` entry (never booked, so it
        has no url) must still reach the site as a venue — this is the
        Skytree-not-on-the-phase-page gap: `_derive_phases` used to drop the
        key entirely."""
        intake = {**JAPAN_INTAKE, "phases": _structured([
            {
                "name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
                "planned": ["Tokyo Skytree", "TeamLab Planets"],
            },
        ])}
        p = transform_intake(intake)["phases"][0]
        self.assertEqual([v["id"] for v in p["venues"]], ["tokyo-skytree", "teamlab-planets"])
        self.assertNotIn("url", p["venues"][0])

    def test_a_venue_with_a_url_wins_over_a_planned_duplicate(self) -> None:
        intake = {**JAPAN_INTAKE, "phases": _structured([
            {
                "name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
                "venues": [{"name": {"en": "Tokyo Skytree"}, "url": "https://www.tokyo-skytree.jp/en/"}],
                "planned": ["Tokyo Skytree"],
            },
        ])}
        p = transform_intake(intake)["phases"][0]
        self.assertEqual(len(p["venues"]), 1)
        self.assertEqual(p["venues"][0]["url"], "https://www.tokyo-skytree.jp/en/")


class PhasePackingTests(unittest.TestCase):
    """phase.packing — readiness.tsx expects each entry to be a
    [{he,en} category, {he,en} item] pair, exactly config.packing_general's
    shape (see trip-web/src/readiness.tsx and its own hardcoded fallback,
    which this deliberately does not touch).

    Since #167 (2026-09-25) a list is emitted only when the phase's place and
    season are confidently known; otherwise the key is absent and the reason
    is logged. The full acceptance table is tests/test_packing_climate.py.
    The tests below that used to rely on "everything unresolved is north",
    or on a country-level answer the audit rework (same day) withdrew, now
    name a phase the criterion keeps (Tokyo, Canberra) or state the
    abstention reason."""

    def _phase(self, destination: str, start: str, end: str, name: str = "Stop"):
        intake = {
            **JAPAN_INTAKE,
            "destination": _text(destination),
            "phases": _structured([{"name": name, "start": start, "end": end}]),
        }
        return transform_intake(intake)["phases"][0]

    def _reason(self, destination: str, start, name: str = "Stop"):
        from datetime import date as _date
        start_date = _date.fromisoformat(start) if start else None
        return transformer._phase_packing_decision(destination, start_date, None, (name,))[1]

    def test_northern_hemisphere_winter_phase_gets_cold_weather_items(self) -> None:
        # Was: bare "Japan" defaulted north. Japan runs from Hokkaido to
        # subtropical Okinawa, so the bare country now abstains; a phase that
        # names Tokyo is placed, and January is winter there.
        self.assertEqual("climate_varies_by_area", self._reason("Japan", "2027-01-10"))
        self.assertNotIn("packing", self._phase("Japan", "2027-01-10", "2027-01-17"))
        phase = self._phase("Japan", "2027-01-10", "2027-01-17", name="Tokyo")
        self.assertIn("packing", phase)
        for category, item in phase["packing"]:
            self.assertIn("he", category)
            self.assertIn("en", category)
            self.assertIn("he", item)
            self.assertIn("en", item)
        items_en = {item["en"] for _category, item in phase["packing"]}
        self.assertIn("Warm jacket", items_en)
        self.assertNotIn("Sunscreen", items_en)

    def test_southern_hemisphere_equivalent_month_gets_hot_weather_items(self) -> None:
        # Same calendar month, Canberra: January is high summer there. Was:
        # the bare country "Australia" -- tropical Cairns to Tasmania -- which
        # now abstains; so does Sydney, whose 12.5C July is no gloves winter.
        self.assertEqual("climate_varies_by_area", self._reason("Australia", "2027-01-10"))
        self.assertEqual("mild_winter", self._reason("Australia", "2027-07-10", name="Sydney"))
        phase = self._phase("Australia", "2027-01-10", "2027-01-17", name="Canberra")
        items_en = {item["en"] for _category, item in phase["packing"]}
        self.assertIn("Sunscreen", items_en)
        self.assertNotIn("Warm jacket", items_en)

    def test_a_phase_with_no_destination_gets_no_packing_additions(self) -> None:
        # destination is a required question, so an empty/whitespace-only
        # typed answer still transforms rather than raising -- falls back to
        # the "Unknown Destination" placeholder brand text elsewhere, but
        # must not fabricate a season for it here.
        intake = {
            **JAPAN_INTAKE,
            "destination": _text("   "),
            "phases": _structured([{"name": "Stop", "start": "2027-01-10", "end": "2027-01-17"}]),
        }
        phase = transform_intake(intake)["phases"][0]
        self.assertNotIn("packing", phase)
        self.assertEqual("no_destination", self._reason("   ", "2027-01-10"))

    def test_a_phase_with_no_dates_gets_no_packing_additions(self) -> None:
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([{"name": "Stop"}]),
        }
        phase = transform_intake(intake)["phases"][0]
        self.assertNotIn("packing", phase)
        self.assertEqual("no_dates", self._reason("Japan", None))

    def test_packing_shares_the_general_lists_bilingual_tuple_shape(self) -> None:
        # A named city: since the second audit no country is ever inherited.
        self.assertEqual("climate_varies_by_area", self._reason("Germany", "2027-07-05"))
        phase = self._phase("Germany", "2027-07-05", "2027-07-12", name="Berlin")
        self.assertTrue(phase["packing"])
        for pair in phase["packing"]:
            self.assertEqual(len(pair), 2)
            category, item = pair
            self.assertEqual(set(category.keys()), {"he", "en"})
            self.assertEqual(set(item.keys()), {"he", "en"})

    def test_a_hebrew_typed_southern_hemisphere_destination_still_flips_the_season(self) -> None:
        # "ניו זילנד" / "קווינסטאון" is New Zealand / Queenstown, typed in
        # Hebrew. An English-only lookup would miss it and (before #167)
        # default north, inverting the advice for a January (southern summer)
        # trip. The bare countries now abstain: Australia and New Zealand
        # both vary by area (Auckland's July is 10.9C).
        self.assertEqual("climate_varies_by_area", self._reason("אוסטרליה", "2027-01-10"))
        self.assertEqual("climate_varies_by_area", self._reason("ניו זילנד", "2027-01-10"))
        phase = self._phase("ניו זילנד", "2027-01-10", "2027-01-17", name="קווינסטאון")
        items_en = {item["en"] for _category, item in phase["packing"]}
        self.assertIn("Sunscreen", items_en)
        self.assertNotIn("Warm jacket", items_en)

    def test_a_hebrew_typed_northern_hemisphere_destination_keeps_its_season(self) -> None:
        # "יפן" is Japan, already aliased for currency/timezone; with a Hebrew
        # phase name "טוקיו" the phase is placed, and January is winter.
        self.assertEqual("climate_varies_by_area", self._reason("יפן", "2027-01-10"))
        phase = self._phase("יפן", "2027-01-10", "2027-01-17", name="טוקיו")
        items_en = {item["en"] for _category, item in phase["packing"]}
        self.assertIn("Warm jacket", items_en)
        self.assertNotIn("Sunscreen", items_en)

    def test_perugia_italy_is_not_mistaken_for_peru(self) -> None:
        # "peru" is a substring of "Perugia" — a real Italian city, not
        # Peru. A raw substring match on the typed text would read it as Peru
        # (tropical). It must resolve through an exact, segment-level lookup
        # to Italy -- which since the audit rework abstains as varying by
        # area (Sicily, Puglia), so the REASON is what proves it was Italy.
        self.assertEqual("climate_varies_by_area", self._reason("Perugia, Italy", "2027-01-10"))
        self.assertEqual("tropical", self._reason("Peru", "2027-01-10"))
        self.assertNotIn("packing", self._phase("Perugia, Italy", "2027-01-10", "2027-01-17"))

    def test_each_phase_is_placed_on_its_own(self) -> None:
        # One hemisphere per TRIP served every phase before #167. A trip to
        # two continents in one January gets winter for Munich, summer for
        # Christchurch, and nothing for a stop it cannot place.
        intake = {
            **JAPAN_INTAKE,
            "destination": _text("Germany, New Zealand"),
            "phases": _structured([
                {"name": "Munich", "start": "2027-01-03", "end": "2027-01-09"},
                {"name": "Christchurch", "start": "2027-01-10", "end": "2027-01-17"},
                {"name": "Road trip", "start": "2027-01-18", "end": "2027-01-20"},
            ]),
        }
        munich, christchurch, road_trip = transform_intake(intake)["phases"]
        self.assertIn("Warm jacket", {i["en"] for _c, i in munich["packing"]})
        self.assertIn("Sunscreen", {i["en"] for _c, i in christchurch["packing"]})
        self.assertNotIn("packing", road_trip)

    def test_the_full_phase_name_is_read_before_its_shortened_form(self) -> None:
        # "Perth, Scotland" shortens to "Perth" -- a city in Australia. Read
        # short-first, a July phase in the Highlands got the southern WINTER
        # list (audit, 2026-09-25). The full name demotes Perth as a namesake.
        phase = self._phase("Scottish Highlands", "2027-07-10", "2027-07-17", name="Perth, Scotland")
        self.assertEqual("Perth", phase["title"]["en"])
        self.assertNotIn("packing", phase)


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

    def test_a_structured_anchor_keeps_its_name_its_date_and_its_phase(self) -> None:
        # The automated full cycle, 2026-09-11: four ticketed Italy attractions
        # in the {type, name, date, confirmation} shape all became "Activity",
        # undated, parked on the FIRST phase — the Uffizi and the Doge's Palace
        # included, which are not in Rome.
        intake = {
            **self.PHASED_INTAKE,
            "travel_anchors": _structured([
                {"type": "attraction", "name": "Tokyo Skytree", "date": "2026-09-20", "confirmation": "TK-1"},
                {"type": "attraction", "name": "Kinkaku-ji", "date": "2026-09-25", "confirmation": "TK-2"},
            ]),
        }
        rows = {b["name"]: b for b in self._bookings(intake) if b["type"] == "attraction"}
        self.assertEqual(sorted(rows), ["Kinkaku-ji", "Tokyo Skytree"])
        self.assertEqual((rows["Tokyo Skytree"]["date_from"], rows["Tokyo Skytree"]["phase"]), ("2026-09-20", "tokyo"))
        self.assertEqual((rows["Kinkaku-ji"]["date_from"], rows["Kinkaku-ji"]["phase"]), ("2026-09-25", "kyoto"))
        self.assertEqual(rows["Kinkaku-ji"]["confirmation"], "TK-2")
        # Two rows, two keys: hashing the bare type gave both "activity" the
        # same seed_key and the site's INSERT OR IGNORE kept only one.
        self.assertEqual(len({r["seed_key"] for r in rows.values()}), 2)

    def test_every_kind_the_question_invites_is_typed_a_booking_not_other(self) -> None:
        # The question names these by name, so the model emits them verbatim.
        # Each one missing from _ANCHOR_TYPE_MAP fell to "other": the
        # confirmation survived, but a booked visit stopped reading as one.
        kinds = ["attraction", "tour", "activity", "event", "shuttle", "parking"]
        intake = {
            **self.PHASED_INTAKE,
            "travel_anchors": _structured([
                {"type": kind, "name": f"Booked {kind}", "date": "2026-09-20", "confirmation": f"C-{kind}"}
                for kind in kinds
            ]),
        }
        rows = {b["name"]: b for b in self._bookings(intake)}
        for kind in kinds:
            row = rows[f"Booked {kind}"]
            self.assertEqual(row["type"], "attraction", f"{kind!r} should type as a booked attraction")
            self.assertEqual(row["confirmation"], f"C-{kind}")
            self.assertEqual((row["date_from"], row["phase"]), ("2026-09-20", "tokyo"))

    def test_a_hotel_anchor_for_the_phases_own_hotel_is_one_row_not_two(self) -> None:
        # Same run: the organizer's documents gave each hotel twice — as the
        # phase's accommodation and as a dated anchor carrying the booking
        # number. The Bookings tab listed every hotel twice, one of them
        # without its confirmation.
        intake = {
            **self.PHASED_INTAKE,
            "travel_anchors": _structured([
                {"type": "hotel", "name": "OMO3 Asakusa, Tokyo", "date": "2026-09-19", "confirmation": "HTL-1"},
                {"type": "hotel", "name": "Cross Hotel Kyoto", "date": "2026-09-24", "confirmation": "OTHER"},
            ]),
        }
        hotels = [b for b in self._bookings(intake) if b["type"] == "hotel"]
        self.assertEqual([(h["phase"], h["name"], h["confirmation"]) for h in hotels],
                         [("tokyo", "OMO3 Asakusa", "HTL-1"),
                          # A confirmation the phase already had is not overwritten.
                          ("kyoto", "Cross Hotel Kyoto", "CH-88")])

    def test_a_second_hotel_in_the_same_phase_keeps_its_own_row(self) -> None:
        # A split stay is two bookings; folding only works on the same hotel.
        intake = {
            **self.PHASED_INTAKE,
            "travel_anchors": _structured([
                {"type": "hotel", "name": "Park Hyatt Tokyo", "date": "2026-09-21", "confirmation": "PH-7"},
            ]),
        }
        hotels = [(b["phase"], b["name"]) for b in self._bookings(intake) if b["type"] == "hotel"]
        self.assertEqual(hotels, [("tokyo", "OMO3 Asakusa"), ("kyoto", "Cross Hotel Kyoto"), ("tokyo", "Park Hyatt Tokyo")])

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


class ResolveOrganizersTests(unittest.TestCase):
    """Which of the travellers is the organizer, from what they typed.

    Load-bearing far past its size: no organizer means `_derive_agent` writes
    no `agent.organizers`, which means `build_companion_handoff` returns None,
    which means the companion profile is never installed and the provisioned
    trip has no chat binding. The organizer messages the bot and is told "I
    don't have a trip for this chat" — a trip that provisioned "successfully"
    and cannot be reached.
    """

    #: Run 13's actual roster, as transformed on 2026-09-06.
    SOLOMONS = [
        {"username": "nir", "name": "ניר", "name_en": "Nir", "family": "סולומון", "family_en": "Solomon"},
        {"username": "ella", "name": "אלה", "name_en": "Ella", "family": "סולומון", "family_en": "Solomon"},
        {"username": "noa", "name": "נעה", "name_en": "Noa", "family": "סולומון", "family_en": "Solomon"},
        {"username": "maya", "name": "מאיה", "name_en": "Maya", "family": "סולומון", "family_en": "Solomon"},
        {"username": "shai", "name": "שי", "name_en": "Shai", "family": "סולומון", "family_en": "Solomon"},
    ]

    def _resolve(self, stated: str, participants=None) -> list[str]:
        return _resolve_organizers(
            {"organizer_identity": _text(stated)}, participants or list(self.SOLOMONS)
        )

    def test_the_run_13_answer_that_matched_nobody(self) -> None:
        # Verbatim. This returned [] on 2026-09-06 and cost the trip its
        # companion; it is the whole reason this class exists.
        self.assertEqual(self._resolve("ניר סולומון"), ["nir"])

    def test_full_name_in_either_script(self) -> None:
        # Answering with your full name is the NORMAL case, not an edge one.
        self.assertEqual(self._resolve("Nir Solomon"), ["nir"])
        self.assertEqual(self._resolve("ניר סולומון"), ["nir"])

    def test_full_name_across_scripts(self) -> None:
        # Rosters are mixed in practice — a Hebrew given name whose household
        # label was only ever transliterated, or the reverse.
        self.assertEqual(self._resolve("ניר Solomon"), ["nir"])
        self.assertEqual(self._resolve("Nir סולומון"), ["nir"])

    def test_the_forms_that_already_worked_still_do(self) -> None:
        for stated in ("ניר", "Nir", "nir"):
            with self.subTest(stated=stated):
                self.assertEqual(self._resolve(stated), ["nir"])

    def test_case_and_spacing_do_not_decide_reachability(self) -> None:
        for stated in ("  nir  solomon ", "NIR SOLOMON", "Nir  Solomon"):
            with self.subTest(stated=stated):
                self.assertEqual(self._resolve(stated), ["nir"])

    def test_a_bare_family_name_names_a_household_not_a_person(self) -> None:
        # Five people share it. Matching would hand one of them — whichever
        # the roster listed first — the organizer's private channel.
        self.assertEqual(self._resolve("סולומון"), [])
        self.assertEqual(self._resolve("Solomon"), [])

    def test_an_ambiguous_answer_is_refused_rather_than_guessed(self) -> None:
        twins = [
            {"username": "shai_a", "name": "שי", "name_en": "Shai", "family": "כהן"},
            {"username": "shai_b", "name": "שי", "name_en": "Shai", "family": "לוי"},
        ]
        self.assertEqual(self._resolve("שי", twins), [])
        # ...and the family name is exactly what disambiguates them.
        self.assertEqual(self._resolve("שי כהן", twins), ["shai_a"])

    def test_someone_who_is_not_on_the_trip_matches_nobody(self) -> None:
        self.assertEqual(self._resolve("Dana Levi"), [])

    def test_no_answer_is_not_a_match(self) -> None:
        self.assertEqual(_resolve_organizers({}, list(self.SOLOMONS)), [])
        self.assertEqual(self._resolve("   "), [])

    def test_the_shape_the_transformer_actually_produces(self) -> None:
        # The tests above hand `_resolve_organizers` a roster carrying
        # `family: "סולומון"`. `_build_participants` does not produce that: it
        # SLUGIFIES family to "solomon" and drops `family_en` entirely. So a
        # fix verified only against the shape above still leaves the live path
        # broken — which is exactly what happened on the first attempt at this
        # fix, caught by the provisioner integration test rather than here.
        transformed = [
            {"username": "nir", "name": "ניר", "name_en": "Nir", "family": "solomon"},
            {"username": "noa", "name": "נעה", "name_en": "Noa", "family": "solomon"},
        ]
        intake = {
            "organizer_identity": _text("ניר סולומון"),
            "travelers": {"kind": "structured", "schema_version": 3, "data": [
                {"name": "ניר", "name_en": "Nir", "family": "סולומון", "family_en": "Solomon"},
                {"name": "נעה", "name_en": "Noa", "family": "סולומון", "family_en": "Solomon"},
            ]},
        }
        self.assertEqual(_resolve_organizers(intake, transformed), ["nir"])

        # And the English pair, which the slug happens to resemble but which
        # must resolve through the raw roster rather than by luck.
        intake["organizer_identity"] = _text("Nir Solomon")
        self.assertEqual(_resolve_organizers(intake, transformed), ["nir"])

    # 2026-09-11, the first automated full cycle: a natural answer to "which of
    # the travellers are you?" is a name WITH something around it, and every
    # one of these matched nobody — so the trip provisioned with no companion.
    def test_a_name_followed_by_a_description(self) -> None:
        for stated in ("ניר, אבא של המשפחה", "Nir - the dad", "Nir — organizing this", "Nir (the dad)"):
            with self.subTest(stated=stated):
                self.assertEqual(self._resolve(stated), ["nir"])

    def test_a_self_reference_in_front_of_the_name(self) -> None:
        for stated in ("אני ניר", "זה אני, ניר", "I'm Nir", "I am Nir Solomon", "me (Nir)", "it's me, Nir"):
            with self.subTest(stated=stated):
                self.assertEqual(self._resolve(stated), ["nir"])

    def test_the_tolerant_read_takes_the_leading_name_never_any_word(self) -> None:
        # "Nir's wife" is NOT Nir. Only the name the sentence starts with — after
        # an optional "I'm"/"אני" — is read; a name buried later is not.
        self.assertEqual(self._resolve("אשתו של ניר"), [])
        self.assertEqual(self._resolve("Nir's wife"), [])
        self.assertEqual(self._resolve("the dad"), [])
        self.assertEqual(self._resolve("Noa, Nir's wife"), ["noa"])

    def test_the_tolerant_read_still_refuses_to_guess(self) -> None:
        twins = [
            {"username": "shai_a", "name": "שי", "name_en": "Shai", "family": "כהן"},
            {"username": "shai_b", "name": "שי", "name_en": "Shai", "family": "לוי"},
        ]
        self.assertEqual(self._resolve("אני שי", twins), [])
        self.assertEqual(self._resolve("Shai, the older one", twins), [])
        self.assertEqual(self._resolve("אני שי כהן", twins), ["shai_a"])

    def test_a_roster_with_no_raw_travelers_still_resolves_a_bare_name(self) -> None:
        # Older intakes, and any path that hands over participants without the
        # structured travelers answer beside them, must not regress.
        transformed = [{"username": "nir", "name": "ניר", "name_en": "Nir", "family": "solomon"}]
        self.assertEqual(_resolve_organizers({"organizer_identity": _text("Nir")}, transformed), ["nir"])

    def test_a_hebrew_answer_finds_a_roster_spelled_only_in_english(self) -> None:
        """2026-09-15, live: every roster name was entered in English letters
        (`name` and `name_en` both), the organizer answered with their own name
        in Hebrew, nothing matched, and the trip provisioned with no companion.
        """
        english_only = [
            {"username": "nir", "name": "Nir", "name_en": "Nir"},
            {"username": "maya", "name": "Maya", "name_en": "Maya"},
        ]
        self.assertEqual(self._resolve("ניר", english_only), ["nir"])

    def test_sound_alike_never_breaks_a_tie_an_exact_reading_refused(self) -> None:
        twins = [
            {"username": "shai_a", "name": "שי", "name_en": "Shai", "family": "כהן"},
            {"username": "shai_b", "name": "שי", "name_en": "Shai", "family": "לוי"},
        ]
        self.assertEqual(self._resolve("Shai", twins), [])


class DeriveDaysFromAnchorsTests(unittest.TestCase):
    """A day-by-day built from the dated anchors, with no model involved.

    `phases[].days[]` had exactly one producer — `extract_itinerary`, an LLM
    pass over an uploaded document — which is unreachable from the chat-scoped
    interview (no `_for_chat` twin). So no control-plane trip has ever had a
    day-by-day, while the organizer's plan sat in `travel_anchors` already
    dated, timed and structured. Nothing about projecting that needs a model.
    """

    PHASES = [
        {"id": "tokyo", "dates": {"start": "2026-09-19", "end": "2026-09-23"}},
        {"id": "kyoto", "dates": {"start": "2026-09-24", "end": "2026-09-27"}},
    ]

    def _days(self, anchors):
        return derive_days_from_anchors(
            {"phases": self.PHASES},
            {"travel_anchors": {"kind": "structured", "schema_version": 3, "data": anchors}},
        )

    def test_run_13s_anchors_land_on_the_right_days_and_phases(self) -> None:
        out = self._days([
            {"type": "activity", "detail": "Tokyo Skytree e-ticket — 20 Sep 2026 at 10:00"},
            {"type": "activity", "detail": "TeamLab Planets — 20 Sep 2026 at 18:00"},
            {"type": "activity", "detail": "Sagano Romantic Train, one-way — 25 Sep 2026 at 14:02"},
        ])
        self.assertEqual(sorted(out), ["kyoto", "tokyo"])
        tokyo = out["tokyo"]
        self.assertEqual([d["date"] for d in tokyo], ["2026-09-20"])
        self.assertEqual(
            [(i["time"], i["text"]["en"]) for i in tokyo[0]["items"]],
            [("10:00", "Tokyo Skytree e-ticket"), ("18:00", "TeamLab Planets")],
        )

    def test_the_date_and_time_are_stripped_from_the_label(self) -> None:
        # They are represented structurally now; printing "at 10:00" beside a
        # 10:00 slot is the same fact twice.
        out = self._days([{"type": "activity", "detail": "Tokyo Skytree e-ticket — 20 Sep 2026 at 10:00"}])
        text = out["tokyo"][0]["items"][0]["text"]["en"]
        self.assertEqual(text, "Tokyo Skytree e-ticket")
        self.assertNotIn("2026", text)
        self.assertNotIn("10:00", text)

    def test_timed_items_sort_before_untimed_ones_within_a_day(self) -> None:
        out = self._days([
            {"type": "activity", "detail": "Something all day — 20 Sep 2026"},
            {"type": "activity", "detail": "Skytree — 20 Sep 2026 at 10:00"},
        ])
        times = [i["time"] for i in out["tokyo"][0]["items"]]
        self.assertEqual(times, ["10:00", None], "'some time that day' belongs last, not at 00:00")

    def test_hotels_and_proposals_are_not_itinerary_items(self) -> None:
        # A hotel is the phase's accommodation; a proposal is a whole-trip
        # quote whose dates are range endpoints, not a moment in the plan.
        out = self._days([
            {"type": "hotel", "detail": "OMO3 Asakusa — 19 Sep 2026 to 23 Sep 2026"},
            {"type": "car", "detail": "Rental — 20 Sep 2026"},
            {"type": "proposal", "detail": "Whole trip quote — 19 Sep 2026"},
        ])
        self.assertEqual(out, {})

    def test_an_undated_anchor_stays_a_booking(self) -> None:
        # It is still real and still shows on the Bookings tab; it just has no
        # day to sit on, and guessing one would be worse than omitting it.
        self.assertEqual(self._days([{"type": "activity", "detail": "Museum tickets, sometime"}]), {})

    # 2026-09-11, the automated full cycle: the interpret path files a ticketed
    # attraction in the travel_anchors question's OWN example shape —
    # {type, name, date, confirmation} — with no free-text `detail`. This read
    # only `detail`, so four ticketed Italy attractions reached no day and no
    # phase: the site showed none of them.
    def test_a_structured_anchor_lands_on_its_day(self) -> None:
        out = self._days([
            {"type": "activity", "name": "Tokyo Skytree", "date": "2026-09-20", "confirmation": "TK-1"},
            {"type": "activity", "name": "Fushimi Inari night walk", "date": "2026-09-25", "time": "19:30"},
        ])
        self.assertEqual([(d["date"], [(i["time"], i["text"]["en"]) for i in d["items"]]) for d in out["tokyo"]],
                         [("2026-09-20", [(None, "Tokyo Skytree")])])
        self.assertEqual(out["kyoto"][0]["items"][0], {"time": "19:30", "text": {"he": "Fushimi Inari night walk",
                                                                               "en": "Fushimi Inari night walk"}})

    def test_the_questions_own_example_shape_is_understood(self) -> None:
        # interview.ts travel_anchors dataExample, verbatim in shape.
        out = self._days([{"type": "flight", "name": "LY075 TLV-HND", "date": "2026-09-19", "confirmation": "ABC123"}])
        self.assertEqual(out["tokyo"][0]["date"], "2026-09-19")
        self.assertEqual(out["tokyo"][0]["items"][0]["text"]["en"], "LY075 TLV-HND")

    def test_structured_hotels_stay_out_of_the_day_plan(self) -> None:
        self.assertEqual(self._days([{"type": "hotel", "name": "OMO3 Asakusa", "date": "2026-09-19"}]), {})

    def test_a_structured_anchor_needs_a_real_date(self) -> None:
        for bad in ("next week", "2026-02-30", ""):
            with self.subTest(date=bad):
                self.assertEqual(self._days([{"type": "activity", "name": "Museum", "date": bad}]), {})

    def test_an_anchor_outside_every_phase_is_not_forced_into_one(self) -> None:
        # derive_bookings parks such a row on phase 1 because bookings.phase is
        # NOT NULL. A day-by-day has no such constraint, and putting a
        # 30 September event in the Tokyo tab would simply be wrong.
        self.assertEqual(self._days([{"type": "activity", "detail": "Something — 30 Sep 2026 at 09:00"}]), {})

    def test_extracted_days_win_over_derived_ones(self) -> None:
        # The precedence written the right way round: an uploaded document's
        # itinerary is richer than a list of bookings, so this fills empty
        # phases rather than competing for the slot.
        intake = dict(JAPAN_INTAKE)
        intake["phases"] = {"kind": "structured", "schema_version": 3, "data": [{
            "name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
            "days": [{"date": "2026-09-20", "items": [
                {"time": "09:00", "text": {"he": "מהמסמך", "en": "From the document"}}]}],
        }]}
        intake["travel_anchors"] = {"kind": "structured", "schema_version": 3, "data": [
            {"type": "activity", "detail": "Skytree — 20 Sep 2026 at 10:00"}]}
        cfg = transform_intake(intake)
        items = cfg["phases"][0]["days"][0]["items"]
        self.assertEqual([i["text"]["en"] for i in items], ["From the document"])


class DeriveRsvpActivitiesTests(unittest.TestCase):
    """`phases[].rsvp_activities[]` had no producer at all.

    The site has rendered RSVP cards since the hand-authored era (site/app.js
    `renderRsvpCard`, trip-web `GroupActivities`), `server/server.js` has stored
    the votes in `rsvps`, and the config schema has carried the field — and
    `transform_intake` never emitted it, so the whole vote surface was invisible
    on every provisioned trip. The live-trip report said it plainly: "RSVP /
    trivia features: unused".

    The source is the unconfirmed attraction-typed anchors: a confirmed one is
    already happening, an unconfirmed one is exactly the open question.
    """

    PHASED_INTAKE = {
        **JAPAN_INTAKE,
        "phases": _structured([
            {"name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23"},
            {"name": "Kyoto", "start": "2026-09-24", "end": "2026-09-27"},
        ]),
    }

    PHASES = [
        {"id": "tokyo", "dates": {"start": "2026-09-19", "end": "2026-09-23"}},
        {"id": "kyoto", "dates": {"start": "2026-09-24", "end": "2026-09-27"}},
    ]

    def _rsvps(self, anchors):
        return derive_rsvp_activities(
            {"phases": self.PHASES},
            {"travel_anchors": {"kind": "structured", "schema_version": 3, "data": anchors}},
        )

    def _intake(self, anchors):
        return {**self.PHASED_INTAKE, "travel_anchors": _structured(anchors)}

    def test_an_unconfirmed_attraction_becomes_a_votable_activity_on_its_phase(self) -> None:
        out = self._rsvps([{"type": "attraction", "name": "Sky Lagoon", "date": "2026-09-25"}])
        self.assertEqual(sorted(out), ["kyoto"])
        activity = out["kyoto"][0]
        self.assertEqual(activity["title"], {"he": "Sky Lagoon", "en": "Sky Lagoon"})
        self.assertEqual(activity["date"], "2026-09-25")
        self.assertTrue(activity["id"])

    def test_a_confirmed_attraction_is_a_booking_not_a_vote(self) -> None:
        # Tickets are bought and seats are held: "does everyone want this?" is a
        # question whose answer changes nothing. It stays on the Bookings tab.
        self.assertEqual(
            self._rsvps([{"type": "attraction", "name": "Sky Lagoon", "date": "2026-09-25",
                          "confirmation": "SL-58213"}]),
            {},
        )

    def test_a_placeholder_confirmation_is_not_a_confirmation(self) -> None:
        # Same rule _has_confirmation already applies to the hero stat: a site
        # that renders "–" for a missing confirmation must not read that anchor
        # as booked.
        for placeholder in ("", "  ", "-", "–", "TBD", "n/a", "none"):
            with self.subTest(confirmation=placeholder):
                out = self._rsvps([{"type": "attraction", "name": "Sky Lagoon",
                                    "date": "2026-09-25", "confirmation": placeholder}])
                self.assertEqual(len(out.get("kyoto", [])), 1, "a placeholder is not a booking")

    def test_only_things_you_do_are_votable(self) -> None:
        # Read through _ANCHOR_TYPE_MAP, never against a second word list, so
        # every member it gains arrives here too. A flight, a hotel, a car and a
        # whole-trip quote are not things the family votes on.
        votable = ["attraction", "activity", "tour", "reservation", "ticket",
                   "excursion", "event", "shuttle", "parking"]
        for kind in votable:
            with self.subTest(kind=kind):
                out = self._rsvps([{"type": kind, "name": f"A {kind}", "date": "2026-09-20"}])
                self.assertEqual([a["title"]["en"] for a in out.get("tokyo", [])], [f"A {kind}"])
        for kind in ("flight", "hotel", "accommodation", "car", "rental", "proposal", "booking", "mystery"):
            with self.subTest(kind=kind):
                self.assertEqual(self._rsvps([{"type": kind, "name": f"A {kind}", "date": "2026-09-20"}]), {})

    def test_the_id_is_stable_across_re_provisions(self) -> None:
        # `rsvps` is keyed by this string alone and knows nothing about
        # trip.config.json, so an id that changes on re-provision does not fail
        # loudly — it orphans every vote already cast and the card comes back
        # empty with nobody told.
        anchors = [
            {"type": "attraction", "name": "Sky Lagoon", "date": "2026-09-25"},
            {"type": "activity", "detail": "TeamLab Planets — 20 Sep 2026 at 18:00"},
        ]
        first, second = self._rsvps(anchors), self._rsvps(anchors)
        self.assertEqual(first, second)
        ids = [a["id"] for phase in first.values() for a in phase]
        self.assertEqual(len(ids), len(set(ids)), "one activity, one vote record")

    def test_two_anchors_of_the_same_type_do_not_share_one_vote_record(self) -> None:
        # The bug derive_bookings' seed_key already had and fixed: hashing the
        # bare type gave every "activity" the same key.
        out = self._rsvps([
            {"type": "activity", "name": "Kinkaku-ji", "date": "2026-09-25"},
            {"type": "activity", "name": "Fushimi Inari", "date": "2026-09-25"},
        ])
        self.assertEqual(len({a["id"] for a in out["kyoto"]}), 2)

    def test_two_anchors_sharing_a_notes_line_are_still_two_activities(self) -> None:
        # A structured anchor states name, date AND detail at once, and the
        # document pass writes all three. Keying on `detail` alone collided
        # these two onto one id, and the dedupe then dropped the second card
        # without a word — one family vote surface quietly short a question.
        out = self._rsvps([
            {"type": "attraction", "name": "Kinkaku-ji", "date": "2026-09-25",
             "detail": "Included in the city pass"},
            {"type": "attraction", "name": "Ginkaku-ji", "date": "2026-09-26",
             "detail": "Included in the city pass"},
        ])
        self.assertEqual([a["title"]["en"] for a in out["kyoto"]], ["Kinkaku-ji", "Ginkaku-ji"])
        self.assertEqual(len({a["id"] for a in out["kyoto"]}), 2)

    def test_the_same_activity_on_two_dates_is_two_questions(self) -> None:
        out = self._rsvps([
            {"type": "attraction", "name": "Onsen", "date": "2026-09-25"},
            {"type": "attraction", "name": "Onsen", "date": "2026-09-26"},
        ])
        self.assertEqual(len({a["id"] for a in out["kyoto"]}), 2)

    def test_the_date_counts_in_whichever_field_the_anchor_states_it(self) -> None:
        # _read_anchor accepts `date`, `date_from` and `start`. Keying on the
        # raw `date` field alone read the other two as blank, which collided
        # one activity's two dates onto a single vote record.
        out = self._rsvps([
            {"type": "attraction", "name": "Onsen", "date_from": "2026-09-25"},
            {"type": "attraction", "name": "Onsen", "start": "2026-09-26"},
        ])
        self.assertEqual([a["date"] for a in out["kyoto"]], ["2026-09-25", "2026-09-26"])
        self.assertEqual(len({a["id"] for a in out["kyoto"]}), 2)

    def test_the_same_date_written_two_ways_is_the_same_question(self) -> None:
        # The id is keyed on the parsed date, so a document re-read that spells
        # the date differently does not move a vote already cast.
        iso = self._rsvps([{"type": "attraction", "name": "Onsen", "date": "2026-09-25"}])
        spelled = self._rsvps([{"type": "attraction", "name": "Onsen", "date": "25 Sep 2026"}])
        self.assertEqual(iso["kyoto"][0]["id"], spelled["kyoto"][0]["id"])

    def test_a_synonym_of_the_same_type_does_not_move_the_vote(self) -> None:
        # Both words map to "attraction", so both describe the same activity;
        # the extraction pass picks between them run to run, and a vote already
        # cast must not move because it did.
        first = self._rsvps([{"type": "activity", "name": "Kinkaku-ji", "date": "2026-09-25"}])
        again = self._rsvps([{"type": "attraction", "name": "Kinkaku-ji", "date": "2026-09-25"}])
        self.assertEqual(first["kyoto"][0]["id"], again["kyoto"][0]["id"])

    def test_tidying_a_placeholder_confirmation_does_not_orphan_the_votes(self) -> None:
        # Every anchor here is unconfirmed by construction, so `confirmation`
        # can only hold "" or a placeholder — no discrimination to add, and
        # including it would move every vote to a new id the day an organizer
        # typed "TBD" into an empty field.
        blank = self._rsvps([{"type": "attraction", "name": "Sky Lagoon", "date": "2026-09-25"}])
        tidied = self._rsvps([{"type": "attraction", "name": "Sky Lagoon", "date": "2026-09-25",
                               "confirmation": "TBD"}])
        self.assertEqual(blank["kyoto"][0]["id"], tidied["kyoto"][0]["id"])

    def test_nothing_votable_produces_no_key_rather_than_an_empty_card(self) -> None:
        self.assertEqual(self._rsvps([]), {})
        self.assertEqual(self._rsvps([{"type": "flight", "name": "LY075", "date": "2026-09-19"}]), {})
        config = transform_intake(self._intake([
            {"type": "attraction", "name": "Sky Lagoon", "date": "2026-09-25", "confirmation": "SL-1"},
        ]))
        for phase in config["phases"]:
            self.assertNotIn("rsvp_activities", phase)

    def test_an_undated_anchor_parks_where_its_booking_row_already_parks(self) -> None:
        # derive_bookings puts it on the first phase (bookings.phase is NOT
        # NULL), so the family already sees it there. Dropping it here instead
        # would hide exactly the most vote-worthy case — an attraction nobody
        # has booked OR scheduled — from the surface built to ask about it.
        out = self._rsvps([{"type": "activity", "detail": "Museum pass, sometime"}])
        self.assertEqual(sorted(out), ["tokyo"])
        self.assertNotIn("date", out["tokyo"][0], "no date is absent, never a guessed one")

    def test_a_date_outside_every_phase_still_reaches_the_family(self) -> None:
        out = self._rsvps([{"type": "activity", "detail": "Something — 30 Sep 2026"}])
        self.assertEqual(out["tokyo"][0]["date"], "2026-09-30")

    def test_the_entry_carries_only_what_the_config_schema_names(self) -> None:
        # trip-web/src/parity-schema.ts phaseParityFields.rsvp_activities:
        # {id, item_uid?, title, name?, desc?, price?, date?}. item_uid stays
        # unset — there is no itinerary item to link an anchor to, and the
        # schema's own "legacy" case omits it.
        out = self._rsvps([
            {"type": "attraction", "name": "Sky Lagoon", "date": "2026-09-25",
             "detail": "Geothermal lagoon, evening slot"},
        ])
        activity = out["kyoto"][0]
        self.assertLessEqual(set(activity), {"id", "title", "desc", "date"})
        self.assertIsInstance(activity["id"], str)
        self.assertEqual(set(activity["title"]), {"he", "en"})
        self.assertEqual(activity["desc"], {"he": "Geothermal lagoon, evening slot",
                                            "en": "Geothermal lagoon, evening slot"})

    def test_the_description_never_just_repeats_the_title(self) -> None:
        # A free-text anchor has no separate name: the title IS the detail, so a
        # desc would print the same sentence twice under it.
        out = self._rsvps([{"type": "activity", "detail": "TeamLab Planets — 20 Sep 2026 at 18:00"}])
        self.assertNotIn("desc", out["tokyo"][0])

    def test_a_detail_that_only_echoes_the_name_is_not_a_description(self) -> None:
        # A document pass that copies the venue name into a notes field is the
        # ordinary case, not a freak one — printing the heading again directly
        # under the heading is not "extra context".
        for detail in ("Sky Lagoon", "  sky   lagoon  ", "Sky Lagoon — 25 Sep 2026",
                       "Sky Lagoon at 15:00"):
            with self.subTest(detail=detail):
                out = self._rsvps([{"type": "attraction", "name": "Sky Lagoon",
                                    "date": "2026-09-25", "detail": detail}])
                self.assertNotIn("desc", out["kyoto"][0])

    def test_a_detail_that_adds_something_is_kept(self) -> None:
        out = self._rsvps([{"type": "attraction", "name": "Sky Lagoon", "date": "2026-09-25",
                            "detail": "Sky Lagoon — bring a towel"}])
        self.assertEqual(out["kyoto"][0]["desc"]["en"], "Sky Lagoon — bring a towel")

    def test_the_title_matches_the_day_item_the_same_anchor_produces(self) -> None:
        # activity-rsvp.ts falls back to matching an activity to an itinerary
        # item by phase, date and EXACT title when there is no item_uid. Both
        # surfaces read the anchor through _read_anchor, so the Journey card for
        # this anchor opens its RSVP rather than showing an unlinked duplicate.
        anchors = [{"type": "activity", "detail": "TeamLab Planets — 20 Sep 2026 at 18:00"}]
        rsvp = self._rsvps(anchors)["tokyo"][0]
        day_item = derive_days_from_anchors(
            {"phases": self.PHASES},
            {"travel_anchors": {"kind": "structured", "schema_version": 3, "data": anchors}},
        )["tokyo"][0]["items"][0]
        self.assertEqual(rsvp["title"], day_item["text"])
        self.assertEqual(rsvp["date"], "2026-09-20")

    def test_markup_never_reaches_the_card(self) -> None:
        # site/app.js renderRsvpCard interpolates the title into an innerHTML
        # string, and these anchors come from a model reading an uploaded
        # document. Same backstop _plain already gives phases[].days[].
        out = self._rsvps([{"type": "attraction", "name": "<img src=x onerror=alert(1)>Tour",
                            "date": "2026-09-20"}])
        self.assertEqual(out["tokyo"][0]["title"]["en"], "img src=x onerror=alert(1)Tour")

    def test_an_anchor_with_no_readable_label_is_skipped(self) -> None:
        self.assertEqual(self._rsvps([{"type": "attraction", "date": "2026-09-20"}]), {})
        self.assertEqual(self._rsvps(["not a dict", None, 7]), {})

    def test_one_anchor_is_both_a_pending_booking_and_an_open_question(self) -> None:
        # Deliberately not exclusive, and not duplication to be removed:
        # Bookings is the organizer's tracking view ("what is still pending"),
        # RSVP is the family's interactive one ("does everyone want it").
        intake = self._intake([{"type": "attraction", "name": "Sky Lagoon", "date": "2026-09-25"}])
        config = transform_intake(intake)
        booking = next(b for b in derive_bookings(config, intake) if b["name"] == "Sky Lagoon")
        self.assertIsNone(booking["confirmation"])
        kyoto = next(p for p in config["phases"] if p["id"] == "kyoto")
        self.assertEqual([a["title"]["en"] for a in kyoto["rsvp_activities"]], ["Sky Lagoon"])
        # Different namespaces: a bookings seed_key is not an rsvps activity id.
        self.assertNotEqual(booking["seed_key"], kyoto["rsvp_activities"][0]["id"])

    def test_the_transformed_config_carries_the_activities_on_the_right_phases(self) -> None:
        config = transform_intake(self._intake([
            {"type": "activity", "detail": "Tokyo Skytree — 20 Sep 2026 at 10:00"},
            {"type": "attraction", "name": "Kinkaku-ji", "date": "2026-09-25"},
            {"type": "attraction", "name": "Fushimi Inari", "date": "2026-09-26", "confirmation": "FI-9"},
        ]))
        by_phase = {p["id"]: [a["title"]["en"] for a in p.get("rsvp_activities", [])] for p in config["phases"]}
        self.assertEqual(by_phase["tokyo"], ["Tokyo Skytree"])
        self.assertEqual(by_phase["kyoto"], ["Kinkaku-ji"])

    def test_activities_are_listed_in_date_order_with_the_undated_last(self) -> None:
        out = self._rsvps([
            {"type": "attraction", "name": "Whenever"},
            {"type": "attraction", "name": "Later", "date": "2026-09-22"},
            {"type": "attraction", "name": "Earlier", "date": "2026-09-20"},
        ])
        self.assertEqual([a["title"]["en"] for a in out["tokyo"]], ["Earlier", "Later", "Whenever"])

    def test_a_trip_with_no_phases_yields_nothing_rather_than_raising(self) -> None:
        self.assertEqual(
            derive_rsvp_activities(
                {"phases": []},
                {"travel_anchors": {"kind": "structured", "schema_version": 3,
                                    "data": [{"type": "attraction", "name": "Sky Lagoon"}]}},
            ),
            {},
        )


class StableIdTests(unittest.TestCase):
    """`_stable_id` is shared by both anchor derivations because both key
    something that lives OUTSIDE trip.config.json by what it returns — the
    site's `INSERT OR IGNORE ... seed_key` for a booking row, the `rsvps` table
    for a vote. Changing the scheme is a data migration wearing a one-line diff:
    every booking row re-inserted as a duplicate, every vote orphaned. So these
    pin the exact strings, not only their shape.
    """

    def _bookings(self, anchors):
        intake = {
            **JAPAN_INTAKE,
            "phases": _structured([{"name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23"}]),
            "travel_anchors": _structured(anchors),
        }
        return derive_bookings(transform_intake(intake), intake)

    def test_a_free_text_anchors_booking_key_is_the_one_it_has_always_had(self) -> None:
        # Read off the tree before `_stable_id` was extracted out of
        # derive_bookings. Live trips already hold these keys.
        rows = self._bookings([
            {"type": "activity", "detail": "Tokyo Skytree e-ticket - 20 Sep 2026 at 10:00"},
        ])
        self.assertEqual([b["seed_key"] for b in rows], ["anchor_433c6642c7"])

    def test_a_structured_anchors_booking_key_is_the_one_it_has_always_had(self) -> None:
        rows = self._bookings([
            {"type": "attraction", "name": "Kinkaku-ji", "date": "2026-09-25", "confirmation": "KJ-1"},
        ])
        self.assertEqual([b["seed_key"] for b in rows], ["anchor_a2f04cd0cc"])

    def test_the_helper_joins_its_parts_rather_than_concatenating_them(self) -> None:
        # "ab" + "" and "a" + "b" are different anchors and must not collide.
        self.assertNotEqual(_stable_id("x", "ab", ""), _stable_id("x", "a", "b"))

    def test_a_missing_part_reads_as_empty_rather_than_as_the_word_none(self) -> None:
        self.assertEqual(_stable_id("x", "a", None, "b"), _stable_id("x", "a", "", "b"))

    def test_the_prefix_is_the_namespace_and_the_hash_is_short(self) -> None:
        self.assertNotEqual(_stable_id("anchor", "a"), _stable_id("rsvp", "a"))
        self.assertEqual(_stable_id("rsvp", "a"), "rsvp_" + _stable_id("anchor", "a").split("_", 1)[1])
        self.assertTrue(re.fullmatch(r"rsvp_[0-9a-f]{10}", _stable_id("rsvp", "a")))


_NAME_CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "v1" / "name-matching-cases.json").read_text(encoding="utf-8")
)


class NameMatchingContractTests(unittest.TestCase):
    """The same cases the interview (api/src/organizer-identity.ts) is held to."""

    def test_alike(self) -> None:
        for a, b in _NAME_CASES["alike"]:
            with self.subTest(a=a, b=b):
                self.assertTrue(_names_sound_alike(a, b))
                self.assertTrue(_names_sound_alike(b, a))

    def test_not_alike(self) -> None:
        for a, b in _NAME_CASES["not_alike"]:
            with self.subTest(a=a, b=b):
                self.assertFalse(_names_sound_alike(a, b))

    def test_resolve(self) -> None:
        for case in _NAME_CASES["resolve"]:
            with self.subTest(why=case["why"]):
                travelers = _structured(case["roster"])
                participants = transform_intake(
                    {**JAPAN_INTAKE, "travelers": travelers}, today=date(2026, 8, 20),
                )["participants"]
                resolved = _resolve_organizers(
                    {"organizer_identity": _text(case["answer"]), "travelers": travelers}, participants,
                )
                expected = [] if case["expect"] is None else [participants[case["expect"]]["username"]]
                self.assertEqual(resolved, expected)


class DestinationTrailingCountryTests(unittest.TestCase):
    """A trip whose destination ENDS with its country is named by it.

    da66df8 taught the transformer the leading shape, "Portugal — Lisbon and
    Porto". The interview produces the other one: it normalises a spoken
    destination into a list of stops with the country last. So a real trip on
    2026-09-19 stored "Tokyo, Hakone, Kyoto, Osaka, Japan", was read as a plain
    city list, and was titled "Family Trip 2027" with the country nowhere.

    The phases decide which trailing element is a country, rather than a list
    of country names — the one this module carries holds fifteen entries and
    does not include Vietnam, so a list-based check would pass the case that
    was reported and fail the next one.
    """

    def title(self, destination, phases):
        from control_plane_worker.transformer import _derive_brand_and_title

        return _derive_brand_and_title(destination, "Family", 2028, phases)[1]

    def test_a_stop_list_ending_in_its_country_is_named_by_the_country(self):
        self.assertEqual(
            "Japan 2028 — Family",
            self.title("Tokyo, Hakone, Kyoto, Osaka, Japan", ["Tokyo", "Hakone", "Kyoto", "Osaka"]),
        )

    def test_it_does_not_depend_on_the_country_being_in_any_list(self):
        # Vietnam is absent from _KNOWN_COUNTRY_CURRENCY on purpose here.
        self.assertEqual(
            "Vietnam 2028 — Family",
            self.title("Hanoi, Ha Long, Hoi An, Saigon, Vietnam", ["Hanoi", "Ha Long", "Hoi An", "Saigon"]),
        )

    def test_a_city_list_with_no_country_still_falls_back(self):
        # Every element is a phase, so nothing trails as a country. Naming this
        # trip "Venice" would be worse than the generic fallback.
        self.assertEqual(
            "Family Trip 2028 — Family",
            self.title("Rome, Florence, Venice", ["Rome", "Florence", "Venice"]),
        )

    def test_the_leading_country_shape_is_unchanged(self):
        self.assertEqual(
            "Portugal 2028 — Family",
            self.title("Portugal — Lisbon and Porto", ["Lisbon", "Porto"]),
        )

    def test_matching_ignores_case_and_surrounding_space(self):
        self.assertEqual(
            "Family Trip 2028 — Family",
            self.title("Rome, Florence,  VENICE ", ["rome", "florence", "venice"]),
        )

    def test_no_phases_still_names_a_recognised_trailing_country(self):
        self.assertEqual("Japan 2028 — Family", self.title("Tokyo, Kyoto, Japan", []))

    def test_an_unrecognised_trailing_place_falls_back_rather_than_guessing(self):
        # The guard that matters. An earlier attempt treated "not one of the
        # phases" as proof of a country, and named trips OSAKA 2026 and
        # PORTO 2026 the moment the phases did not list every city mentioned.
        self.assertEqual("Family Trip 2028 — Family", self.title("Tokyo, Kyoto and Osaka", ["Tokyo"]))
        self.assertEqual("Family Trip 2028 — Family", self.title("Lisbon and Porto", []))

    def test_a_phase_named_like_a_country_is_still_not_the_country(self):
        # Japan as a STOP rather than the trailing country: the phase check
        # rules it out before the country list would wave it through.
        self.assertEqual("Family Trip 2028 — Family", self.title("Tokyo, Japan", ["Tokyo", "Japan"]))


class TripClockAndLanguage(unittest.TestCase):
    """The two `agent` fields that described a trip other than the one they
    were built from, until 2026-09-20."""

    def test_a_typed_zone_that_is_a_zone_is_kept(self):
        self.assertEqual("Asia/Tokyo", transformer._resolve_timezone("Asia/Tokyo", "Japan"))

    def test_a_country_name_typed_as_a_zone_is_replaced_by_the_real_one(self):
        # What an organizer actually typed when asked for a timezone. It
        # reached the config as `agent.timezone` and left a 07:30 briefing
        # scheduled in a zone no clock resolves.
        self.assertEqual("Asia/Ho_Chi_Minh", transformer._resolve_timezone("Vietnam", "Vietnam"))

    def test_the_zone_is_derived_when_nothing_was_typed(self):
        self.assertEqual("Europe/Lisbon", transformer._resolve_timezone("", "Portugal — Lisbon and Porto"))
        self.assertEqual("Asia/Tokyo", transformer._resolve_timezone("", "Tokyo, Japan"))

    def test_a_destination_written_in_hebrew_resolves_the_same_as_english(self):
        # The normal case for a Hebrew interview, and it silently lost BOTH
        # facts: on 2026-09-20 one run stored "Vietnam" and the next stored
        # "וייטנאם", and the Hebrew one produced no timezone and a null
        # travel_info — so the site's currency card and conversion feature were
        # simply absent, with nothing saying so.
        for written in ("וייטנאם", "ויאטנם"):
            with self.subTest(written):
                self.assertEqual("Asia/Ho_Chi_Minh", transformer._resolve_timezone("", written))
                self.assertEqual("VND", transformer._lookup_known_currency(written)["code"])

    def test_the_currency_and_the_zone_resolve_together_or_not_at_all(self):
        # They answer two questions about one place through one key list, so a
        # destination cannot resolve for one and not the other.
        for written in ("יפן", "Japan", "Tokyo, Japan", "Portugal — Lisbon and Porto"):
            with self.subTest(written):
                self.assertTrue(transformer._resolve_timezone("", written))
                self.assertIsNotNone(transformer._lookup_known_currency(written))

    def test_an_unmappable_destination_yields_nothing_rather_than_the_text(self):
        # Absent is a gap something can notice. "Narnia" sitting in a field
        # read as a zone looks answered and is not.
        self.assertEqual("", transformer._resolve_timezone("Narnia", "Narnia"))

    def test_a_derived_zone_alone_does_not_invent_an_agent_block(self):
        # An intake that answered none of the assistant questions must produce
        # exactly the config it did before those questions existed.
        agent = transformer._derive_agent({"destination": {"kind": "text", "text": "Japan"}}, [], [])
        self.assertIsNone(agent)

    def test_the_companion_speaks_the_language_the_interview_was_held_in(self):
        data = {
            "bot_name": {"kind": "text", "text": "פאם"},
            "destination": {"kind": "text", "text": "Vietnam"},
        }
        agent = transformer._derive_agent(data, [], [], "he")
        self.assertEqual("he", agent["default_language"])
        self.assertEqual("Asia/Ho_Chi_Minh", agent["timezone"])

    def test_an_unknown_interview_language_still_falls_back_to_english(self):
        data = {"bot_name": {"kind": "text", "text": "Sol"}}
        self.assertEqual("en", transformer._derive_agent(data, [], [], "kl")["default_language"])


class DaysOnNoPhaseAreShown(unittest.TestCase):
    """A day of the trip that no phase covers must not be invisible.

    On 2026-09-20 an organizer said ten of their sixteen days were undecided
    and asked for a proposal. The site showed the six that were decided and
    nothing at all for the rest — the trip simply appeared to be six days long,
    beside a return flight leaving a city no phase mentioned. Absent and
    undecided are different things and only one of them was true.
    """

    def _intake(self, phases, departure="2028-03-05", ret="2028-03-20"):
        return {
            **JAPAN_INTAKE,
            "destination": {"kind": "text", "schema_version": 3, "text": "Vietnam"},
            "departure_date": {"kind": "text", "schema_version": 3, "text": departure},
            "return_date": {"kind": "text", "schema_version": 3, "text": ret},
            "phases": _structured(phases),
        }

    def _build(self, phases, **kw):
        return transformer.transform_intake(self._intake(phases, **kw))["phases"]

    def test_the_days_after_the_last_phase_are_shown_as_open(self):
        built = self._build([
            {"name": "Hanoi", "start": "2028-03-05", "end": "2028-03-09"},
            {"name": "Ha Long", "start": "2028-03-09", "end": "2028-03-11"},
        ])
        open_phases = [p for p in built if p.get("unplanned")]
        self.assertEqual(1, len(open_phases))
        self.assertEqual({"start": "2028-03-12", "end": "2028-03-20"}, open_phases[0]["dates"])
        self.assertIn("9", open_phases[0]["note"]["en"])

    def test_every_day_of_the_trip_belongs_to_some_phase_once_they_are_added(self):
        # The property the site needs: no day of a stated trip is missing.
        import datetime as dt
        built = self._build([{"name": "Hanoi", "start": "2028-03-07", "end": "2028-03-09"}])
        covered = set()
        for phase in built:
            a = dt.date.fromisoformat(phase["dates"]["start"])
            b = dt.date.fromisoformat(phase["dates"]["end"])
            while a <= b:
                covered.add(a)
                a += dt.timedelta(days=1)
        day, last = dt.date(2028, 3, 5), dt.date(2028, 3, 20)
        while day <= last:
            self.assertIn(day, covered, f"{day} is on no phase")
            day += dt.timedelta(days=1)

    def test_a_gap_in_the_middle_and_one_at_the_end_are_separate_stretches(self):
        built = self._build([
            {"name": "Hanoi", "start": "2028-03-05", "end": "2028-03-07"},
            {"name": "Hue", "start": "2028-03-12", "end": "2028-03-14"},
        ])
        gaps = [p["dates"] for p in built if p.get("unplanned")]
        self.assertEqual(
            [{"start": "2028-03-08", "end": "2028-03-11"},
             {"start": "2028-03-15", "end": "2028-03-20"}],
            gaps,
        )

    def test_a_fully_covered_trip_gains_nothing(self):
        built = self._build([{"name": "Hanoi", "start": "2028-03-05", "end": "2028-03-20"}])
        self.assertEqual([], [p for p in built if p.get("unplanned")])

    def test_open_stretches_sit_in_trip_order_between_the_phases(self):
        built = self._build([
            {"name": "Hanoi", "start": "2028-03-05", "end": "2028-03-07"},
            {"name": "Hue", "start": "2028-03-12", "end": "2028-03-20"},
        ])
        self.assertEqual(["hanoi", "open-days", "hue"], [p["id"] for p in built])

    def test_a_trip_with_no_phases_at_all_gains_none(self):
        # A different state, not a gap: nobody has said anything about stops,
        # and the site already says so its own way.
        self.assertEqual([], self._build([]))

    def test_dates_the_organizer_never_gave_produce_no_gaps(self):
        # `_resolve_dates` falls back to today+90; a gap measured against an
        # invented range invents the days in it.
        intake = self._intake([{"name": "Hanoi", "start": "2028-03-05", "end": "2028-03-09"}])
        del intake["departure_date"]
        del intake["return_date"]
        built = transformer.transform_intake(intake)["phases"]
        self.assertEqual([], [p for p in built if p.get("unplanned")])

    def test_an_open_stretch_says_how_to_resolve_it(self):
        built = self._build([{"name": "Hanoi", "start": "2028-03-05", "end": "2028-03-09"}])
        note = [p for p in built if p.get("unplanned")][0]["note"]
        for side in ("he", "en"):
            self.assertTrue(note[side].strip(), f"{side} side is empty")
        self.assertIn("assistant", note["en"], "it must say where the organizer can fix it")


class ConfirmedBookingsAreConfirmed(unittest.TestCase):
    """A travel_anchor is a fixed point in the trip, not evidence of a booking.

    Counting every anchor told one family on their front page that four
    bookings were confirmed on a trip where nothing was booked — beside map
    stops rendered from the same anchors correctly showing no confirmation.
    """

    def test_an_anchor_with_a_confirmation_counts(self):
        self.assertTrue(transformer._has_confirmation({"confirmation": "PH-88213"}))

    def test_an_anchor_without_one_does_not(self):
        self.assertFalse(transformer._has_confirmation({"type": "flight", "name": "VN572"}))

    def test_a_placeholder_is_not_a_confirmation(self):
        # The site renders "–" for a missing confirmation; the count must not
        # read the same value as evidence.
        for placeholder in ("–", "-", "  ", "n/a", "TBD", "none"):
            with self.subTest(placeholder):
                self.assertFalse(transformer._has_confirmation({"confirmation": placeholder}))
