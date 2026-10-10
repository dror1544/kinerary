"""The `star` e2e scenario: a couples trip from one base with day trips, then a
change of stops through the companion.

Nothing here talks to a stack. It tests the pure parts the live run is built
from — the fixture, the verdicts computed from a site's config / bookings /
plan, the deferral bookkeeping, the chat loop — with fabricated data, so a
wrong expectation is found on a laptop and not 40 minutes into a provisioning.

The shape of the rule being protected: an expectation that cannot pass today is
a NAMED, REASONED deferral (it still runs, reports as a known gap, and says so
the day it starts passing); it is never deleted, and a deferral with no reason
is a way of quietly deleting it.
"""
from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "e2e-full-cycle.py"
FIXTURES = REPO / "control-plane/api/test/fixtures"


def load():
    spec = importlib.util.spec_from_file_location("e2e_full_cycle", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixtures():
    sys.path.insert(0, str(FIXTURES))
    import make_documents  # noqa: E402
    return make_documents


def phase(pid, en, he, start, end, accommodation=None):
    p = {"id": pid, "title": {"en": en, "he": he}, "tabLabel": en.upper(),
         "dates": {"start": start, "end": end}}
    if accommodation:
        p["accommodation"] = {"name": accommodation, "name_en": accommodation}
    return p


COLMAR = phase("colmar", "Colmar", "קולמר", "2027-12-02", "2027-12-09")
FLIGHTS = [
    {"type": "flight", "name": "LY8801 Tel Aviv to Frankfurt", "date_from": "2027-12-02"},
    {"type": "flight", "name": "LY8802 Frankfurt to Tel Aviv", "date_from": "2027-12-09"},
]


class StarFixture(unittest.TestCase):
    """The scenario's facts: well formed, in the right year, with reasons."""

    def setUp(self) -> None:
        self.spec = fixtures().SCENARIOS["star"]

    def test_it_is_a_december_2027_trip_so_it_cannot_collide_with_a_live_one(self) -> None:
        # The owner's real trip is December 2026 in the same region. A fixture
        # that shares cities AND dates with a live trip collided once already
        # (the japan fixture, which is why the nightly refuses it).
        self.assertEqual(self.spec["departure_date"], "2027-12-02")
        self.assertEqual(self.spec["return_date"], "2027-12-09")
        def without_reasons(node):
            # The deferral reasons cite the dates they were decided on (2026-…).
            if isinstance(node, dict):
                return {k: without_reasons(v) for k, v in node.items() if k != "deferred"}
            return node

        trip = json.dumps(without_reasons(self.spec), ensure_ascii=False)
        self.assertNotIn("2026", trip)
        self.assertTrue(re.findall(r"2027-\d\d-\d\d", trip), "the trip's own dates are 2027")

    def test_it_has_no_documents_every_answer_is_typed(self) -> None:
        self.assertEqual(self.spec["documents"], {})

    def test_every_deferral_names_an_expectation_that_exists_and_says_why(self) -> None:
        for block in (self.spec["expect_site"], self.spec["after_companion"]["expect"]):
            deferred = block["deferred"]
            self.assertIsInstance(deferred, dict, "a deferral carries its reason, not just its name")
            for name, reason in deferred.items():
                self.assertIn(name, block, f"{name} is deferred but is not an expectation")
                self.assertGreater(len(reason.strip()), 20, f"{name}: a deferral with no reason is a deletion")

    def test_stop_editing_deferrals_carry_the_owners_wording(self) -> None:
        reason = ("stop editing after the interview not built "
                  "(owner decision pending; deferred past Sprint 6 on 2026-09-22)")
        deferred = self.spec["after_companion"]["expect"]["deferred"]
        self.assertEqual(deferred["base_stop_accommodation"], reason)
        self.assertEqual(deferred["stops_after_change"], reason)
        self.assertEqual(fixtures().STOP_EDITING_DEFERRED, reason)

    def test_the_checkout_item_has_its_own_reason(self) -> None:
        deferred = self.spec["after_companion"]["expect"]["deferred"]
        self.assertIn("checkout_plan_item", deferred)
        self.assertNotIn("stop editing", deferred["checkout_plan_item"])

    def test_the_interview_shape_expectations_are_hard_not_deferred(self) -> None:
        # They are expected to go green when fix/interview-trip-shape lands.
        # Deferring them would hide exactly the defects the scenario exists for.
        deferred = self.spec["expect_site"]["deferred"]
        for name in ("trip_type", "stops", "not_stops", "flight_anchors", "days_covered",
                     "typed_choice_understood"):
            self.assertIn(name, self.spec["expect_site"])
            self.assertNotIn(name, deferred)

    def test_the_car_is_reported_never_required(self) -> None:
        self.assertNotIn("car", self.spec["expect_site"])
        self.assertTrue(self.spec["expect_site"]["report"].count("car"))

    def test_the_trip_is_one_stop_dated_with_the_whole_trip(self) -> None:
        (stop,) = self.spec["expect_site"]["stops"]
        self.assertEqual((stop["start"], stop["end"]), (self.spec["departure_date"], self.spec["return_date"]))

    def test_the_change_splits_the_stay_in_two_with_the_right_dates(self) -> None:
        first, second = self.spec["after_companion"]["expect"]["stops_after_change"]
        self.assertEqual(first["start"], self.spec["departure_date"])
        self.assertEqual(first["end"], second["start"], "the airport night starts the day the base stop ends")
        self.assertEqual(second["end"], self.spec["return_date"])

    def test_no_real_person_is_named(self) -> None:
        # The two couples' surnames are made up for this fixture. A name from a
        # real roster (the owner's family, the tester families) must not appear.
        blob = json.dumps(self.spec, ensure_ascii=False)
        for real in ("אלול", "Elul", "כהן", "Cohen", "לוי", "Levi"):
            self.assertNotIn(real, blob)


class StarIsWired(unittest.TestCase):
    def test_help_lists_star(self) -> None:
        out = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("star", out.stdout)

    def test_star_has_a_signup_name_that_is_not_a_live_trips(self) -> None:
        names = load().TRIP_NAMES
        self.assertEqual(names["star"], "Alsace 2027")

    def test_all_does_not_include_star_and_neither_does_the_nightly_default(self) -> None:
        # `all` is what the nightly-adjacent hands-off runs use, and star cannot
        # go green yet — it must not be picked up by accident.
        mod = load()
        self.assertNotIn("star", mod.ALL_SCENARIOS)
        nightly = (REPO / "scripts/nightly-e2e.sh").read_text()
        self.assertIsNone(re.search(r"\bstar\b", nightly))

    def test_star_needs_the_automated_organizer(self) -> None:
        # The companion stage speaks as the organizer; a person cannot be asked to.
        out = subprocess.run([sys.executable, str(SCRIPT), "--scenario", "star"],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 2)
        self.assertIn("--auto", out.stderr)


class Deferrals(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = load()
        self.V = self.mod.Verdict

    def test_a_list_is_still_a_valid_deferral_with_no_reason(self) -> None:
        # vietnam's form: kept working, so no existing scenario changes meaning.
        self.assertEqual(self.mod.deferred_with_reasons({"deferred": ["confirmed_bookings"]}),
                         {"confirmed_bookings": ""})

    def test_a_dict_carries_the_reason(self) -> None:
        self.assertEqual(self.mod.deferred_with_reasons({"deferred": {"a": "because"}}), {"a": "because"})

    def test_nothing_deferred(self) -> None:
        self.assertEqual(self.mod.deferred_with_reasons({}), {})

    def test_a_hard_failure_is_a_failure_a_deferred_one_is_a_gap_and_a_deferred_pass_is_news(self) -> None:
        verdicts = [
            self.V("hard_bad", False, "ok", "hard thing broke"),
            self.V("hard_good", True, "fine", ""),
            self.V("gap", False, "ok", "not built"),
            self.V("fixed", True, "works now", ""),
        ]
        hard, gaps, now_passing = self.mod.sort_verdicts(verdicts, {"gap": "later", "fixed": "was broken"})
        self.assertEqual([v.name for v in hard], ["hard_bad"])
        self.assertEqual([(v.name, why) for v, why in gaps], [("gap", "later")])
        self.assertEqual([v.name for v, _ in now_passing], ["fixed"])

    def test_report_raises_on_a_hard_failure_naming_every_one(self) -> None:
        verdicts = [self.V("a", False, "", "a broke"), self.V("b", False, "", "b broke")]
        with self.assertRaises(self.mod.Failed) as caught:
            self.mod.report_verdicts(verdicts, {}, {})
        self.assertIn("a broke", str(caught.exception))
        self.assertIn("b broke", str(caught.exception))

    def test_report_records_known_gaps_on_the_run_and_does_not_raise(self) -> None:
        ctx: dict = {}
        self.mod.report_verdicts([self.V("gap", False, "", "not built")], {"gap": "later"}, ctx)
        self.assertEqual(ctx["known_gaps"], [("gap", "later")])


class Stops(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = load()
        self.want = [{"name": ["Colmar", "קולמר"], "start": "2027-12-02", "end": "2027-12-09"}]

    def test_one_stop_with_the_whole_trip_passes(self) -> None:
        self.assertTrue(self.mod.stops_verdict([COLMAR], self.want).passed)

    def test_the_gateway_as_extra_stops_fails_on_the_count(self) -> None:
        # What the owner's manual run produced: the gateway city became stops.
        frankfurt = phase("frankfurt", "Frankfurt", "פרנקפורט", "2027-12-02", "2027-12-02")
        back = phase("frankfurt1", "Frankfurt", "פרנקפורט", "2027-12-09", "2027-12-09")
        verdict = self.mod.stops_verdict([frankfurt, COLMAR, back], self.want)
        self.assertFalse(verdict.passed)
        self.assertIn("3", verdict.bad)

    def test_an_undated_stop_fails(self) -> None:
        undated = {"id": "colmar", "title": {"en": "Colmar", "he": "קולמר"}}
        self.assertFalse(self.mod.stops_verdict([undated], self.want).passed)

    def test_wrong_dates_fail(self) -> None:
        short = phase("colmar", "Colmar", "קולמר", "2027-12-02", "2027-12-08")
        self.assertFalse(self.mod.stops_verdict([short], self.want).passed)

    def test_either_spelling_names_the_stop(self) -> None:
        hebrew_only = phase("c", "", "קולמר", "2027-12-02", "2027-12-09")
        self.assertTrue(self.mod.stops_verdict([hebrew_only], self.want).passed)

    def test_the_gateway_is_not_a_stop(self) -> None:
        self.assertTrue(self.mod.not_stops_verdict([COLMAR], ["Frankfurt", "פרנקפורט"]).passed)
        airport = phase("fra", "Frankfurt Airport", "פרנקפורט", "2027-12-08", "2027-12-09")
        self.assertFalse(self.mod.not_stops_verdict([COLMAR, airport], ["Frankfurt", "פרנקפורט"]).passed)

    def test_a_gateway_in_a_notes_field_is_not_a_stop(self) -> None:
        # Only the stop's name counts; the note may mention the airport.
        noted = dict(COLMAR, note={"en": "land in Frankfurt, drive to Colmar"})
        self.assertTrue(self.mod.not_stops_verdict([noted], ["Frankfurt"]).passed)


class Days(unittest.TestCase):
    def test_uncovered_days_of_a_whole_trip_stop_is_empty(self) -> None:
        mod = load()
        config = {"meta": {"departure": "2027-12-02", "returnDate": "2027-12-09"}, "phases": [COLMAR]}
        covered, missing = mod.uncovered_days(config)
        self.assertEqual((len(covered), missing), (8, []))

    def test_a_shortened_stop_leaves_the_tail_uncovered(self) -> None:
        mod = load()
        short = phase("colmar", "Colmar", "קולמר", "2027-12-02", "2027-12-08")
        config = {"meta": {"departure": "2027-12-02", "returnDate": "2027-12-09"}, "phases": [short]}
        self.assertEqual(mod.uncovered_days(config)[1], ["2027-12-09"])


class Anchors(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = load()
        self.want = {"in": "2027-12-02", "out": "2027-12-09", "gateway": ["Frankfurt", "FRA", "פרנקפורט"]}

    def verdicts(self, bookings):
        return {v.name: v for v in self.mod.flight_verdicts(bookings, self.want)}

    def test_a_flight_in_and_out_with_the_gateway_passes(self) -> None:
        got = self.verdicts(FLIGHTS)
        self.assertTrue(got["flight_anchors"].passed)
        self.assertTrue(got["gateway_in_anchors"].passed)

    def test_no_flights_fails_both(self) -> None:
        got = self.verdicts([])
        self.assertFalse(got["flight_anchors"].passed)
        self.assertFalse(got["gateway_in_anchors"].passed)

    def test_an_undated_flight_does_not_count_as_arrival(self) -> None:
        undated = [dict(FLIGHTS[0], date_from=None), FLIGHTS[1]]
        self.assertFalse(self.verdicts(undated)["flight_anchors"].passed)

    def test_the_gateway_named_nowhere_fails_even_with_flights(self) -> None:
        bare = [dict(f, name=f["name"].replace("Frankfurt", "somewhere")) for f in FLIGHTS]
        got = self.verdicts(bare)
        self.assertTrue(got["flight_anchors"].passed)
        self.assertFalse(got["gateway_in_anchors"].passed)

    def test_the_car_is_reported_and_never_a_failure(self) -> None:
        none = self.mod.car_note([])
        self.assertIn("optional", none)
        car = self.mod.car_note([{"type": "car", "name": "Rental car, Frankfurt airport"}])
        self.assertIn("Rental car", car)
        by_text = self.mod.car_note([{"type": "other", "name": "Pickup", "notes": "רכב שכור אחד"}])
        self.assertIn("Pickup", by_text)


class Rooms(unittest.TestCase):
    def test_two_rooms_in_any_phrasing_on_the_site(self) -> None:
        mod = load()
        for text in ("Hotel X, two rooms", "Hotel X (2 rooms)", "מלון, שני חדרים", "מלון - 2 חדרים"):
            config = {"phases": [dict(COLMAR, note={"en": text})]}
            self.assertTrue(mod.rooms_verdict(config, []).passed, text)

    def test_a_trip_that_forgot_the_rooms_fails(self) -> None:
        self.assertFalse(load().rooms_verdict({"phases": [COLMAR]}, []).passed)

    def test_the_rooms_may_live_in_a_booking(self) -> None:
        bookings = [{"type": "hotel", "name": "Hotel X", "notes": "2 חדרים"}]
        self.assertTrue(load().rooms_verdict({"phases": [COLMAR]}, bookings).passed)


class TripType(unittest.TestCase):
    def test_the_option_is_what_counts_not_free_text(self) -> None:
        mod = load()
        good = {"trip_type": {"kind": "choice", "option_id": "couple"}}
        other = {"trip_type": {"kind": "choice_other", "other_text": "טיול זוגות"}}
        family = {"trip_type": {"kind": "choice", "option_id": "family"}}
        self.assertTrue(mod.trip_type_verdict(good, "couple").passed)
        self.assertFalse(mod.trip_type_verdict(other, "couple").passed)
        self.assertFalse(mod.trip_type_verdict(family, "couple").passed)
        self.assertFalse(mod.trip_type_verdict({}, "couple").passed)

    def test_a_button_fallback_is_a_failure_of_the_typed_answer(self) -> None:
        mod = load()
        self.assertTrue(mod.typed_choice_verdict({"typed_fallbacks": []}).passed)
        verdict = mod.typed_choice_verdict({"typed_fallbacks": [{"question": "trip_type", "tries": 2}]})
        self.assertFalse(verdict.passed)
        self.assertIn("trip_type", verdict.bad)

    def test_no_findings_file_is_a_failure_not_a_pass(self) -> None:
        # Silence must not read as success: if the organizer never wrote its
        # findings, nobody knows whether the typed answer was understood.
        self.assertFalse(load().typed_choice_verdict(None).passed)


class CompanionExpectations(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = load()
        self.hotel = {"name": "Hotel Vignoble Dore", "check_in": "2027-12-02", "check_out": "2027-12-09"}

    def test_the_hotel_booking_needs_its_name_and_both_dates(self) -> None:
        good = [{"type": "hotel", "name": "Hotel Vignoble Dore", "date_from": "2027-12-02", "date_to": "2027-12-09"}]
        self.assertTrue(self.mod.hotel_booking_verdict(good, self.hotel).passed)
        no_out = [dict(good[0], date_to=None)]
        self.assertFalse(self.mod.hotel_booking_verdict(no_out, self.hotel).passed)
        self.assertFalse(self.mod.hotel_booking_verdict([], self.hotel).passed)

    def test_the_hotel_may_be_spelt_in_a_notes_field(self) -> None:
        row = [{"type": "hotel", "name": "Colmar stay", "notes": "Hotel Vignoble Dore",
                "date_from": "2027-12-02", "date_to": "2027-12-09"}]
        self.assertTrue(self.mod.hotel_booking_verdict(row, self.hotel).passed)

    def test_the_stop_carries_the_hotel(self) -> None:
        with_hotel = phase("colmar", "Colmar", "קולמר", "2027-12-02", "2027-12-09", "Hotel Vignoble Dore")
        self.assertTrue(self.mod.stop_accommodation_verdict([with_hotel], self.hotel).passed)
        self.assertFalse(self.mod.stop_accommodation_verdict([COLMAR], self.hotel).passed)

    def test_check_in_and_check_out_items_are_told_apart(self) -> None:
        items = [
            {"date": "2027-12-02", "text_en": "Check-in at Hotel Vignoble Dore", "text_he": ""},
            {"date": "2027-12-09", "text_en": "", "text_he": "צ'ק-אאוט מהמלון"},
        ]
        self.assertTrue(self.mod.plan_item_verdict(items, "2027-12-02", "in").passed)
        self.assertTrue(self.mod.plan_item_verdict(items, "2027-12-09", "out").passed)
        self.assertFalse(self.mod.plan_item_verdict(items, "2027-12-09", "in").passed)
        self.assertFalse(self.mod.plan_item_verdict(items, "2027-12-02", "out").passed)

    def test_hebrew_spellings_of_check_in_are_read(self) -> None:
        for text in ("צ'ק-אין במלון", "צ׳ק אין", "צ'ק אין", "כניסה למלון", "Check in"):
            items = [{"date": "2027-12-02", "text_he": text, "text_en": None}]
            self.assertTrue(self.mod.plan_item_verdict(items, "2027-12-02", "in").passed, text)
        for text in ("צ'ק-אאוט", "צ׳ק אאוט", "עזיבת המלון", "Checkout", "Check-out"):
            items = [{"date": "2027-12-09", "text_he": text, "text_en": None}]
            self.assertTrue(self.mod.plan_item_verdict(items, "2027-12-09", "out").passed, text)

    def test_after_the_split_both_stops_are_dated(self) -> None:
        want = [{"name": ["Colmar", "קולמר"], "start": "2027-12-02", "end": "2027-12-08"},
                {"name": ["Frankfurt", "פרנקפורט"], "start": "2027-12-08", "end": "2027-12-09"}]
        split = [phase("colmar", "Colmar", "קולמר", "2027-12-02", "2027-12-08"),
                 phase("fra", "Frankfurt Airport", "פרנקפורט", "2027-12-08", "2027-12-09")]
        self.assertTrue(self.mod.stops_verdict(split, want, "stops_after_change").passed)
        self.assertFalse(self.mod.stops_verdict([COLMAR], want, "stops_after_change").passed)


class StarThroughTheChecker(unittest.TestCase):
    """The scenario's own expectations, run through the real checker with a
    fabricated site — the closest thing to the live run that needs no stack."""

    def setUp(self) -> None:
        self.mod = load()
        self.spec = fixtures().SCENARIOS["star"]
        self.config = {"meta": {"departure": "2027-12-02", "returnDate": "2027-12-09"}, "phases": [COLMAR]}

    def ctx(self, **over):
        base = {"config": self.config, "bookings": FLIGHTS,
                "intake": {"trip_type": {"kind": "choice", "option_id": "couple"}},
                "organizer_findings": {"typed_fallbacks": []}}
        base.update(over)
        return base

    def test_the_trip_the_scenario_wants_passes_and_the_rooms_gap_is_recorded(self) -> None:
        ctx = self.ctx()
        self.mod._check_site_expectations(ctx, self.spec["expect_site"])
        self.assertEqual([name for name, _ in ctx["known_gaps"]], ["rooms_visible"])

    def test_the_owners_manual_run_fails_loudly_on_every_shape_defect_at_once(self) -> None:
        # Gateway as two extra stops, all undated, trip type as free text, no
        # anchors, the typed answer needing the button.
        phases = [
            {"id": "frankfurt", "title": {"en": "Frankfurt", "he": "פרנקפורט"}},
            {"id": "colmar", "title": {"en": "Colmar", "he": "קולמר"}},
            {"id": "frankfurt1", "title": {"en": "Frankfurt", "he": "פרנקפורט"}},
        ]
        ctx = self.ctx(config={"meta": self.config["meta"], "phases": phases}, bookings=[],
                       intake={"trip_type": {"kind": "choice_other", "other_text": "טיול זוגות"}},
                       organizer_findings={"typed_fallbacks": [{"question": "trip_type", "tries": 2}]})
        with self.assertRaises(self.mod.Failed) as caught:
            self.mod._check_site_expectations(ctx, self.spec["expect_site"])
        message = str(caught.exception)
        for name in ("trip_type", "stops", "not_stops", "flight_anchors", "gateway_in_anchors",
                     "typed_choice_understood"):
            self.assertIn(f"{name}:", message)

    def test_vietnams_list_form_of_deferral_still_works(self) -> None:
        ctx = {"config": {"stats": [{"number": "4", "description": {"en": "4 bookings confirmed"}}]}}
        self.mod._check_site_expectations(ctx, {"confirmed_bookings": 0, "deferred": ["confirmed_bookings"]})
        self.assertEqual(ctx["known_gaps"][0][0], "confirmed_bookings")


class StarCompanionStage(unittest.TestCase):
    """stage_companion_changes with the chat and the site stubbed."""

    def setUp(self) -> None:
        self.mod = load()
        self.spec = fixtures().SCENARIOS["star"]
        self.hotel = self.spec["after_companion"]["hotel"]

    def run_stage(self, bookings, replies=True):
        mod = self.mod
        config = {"phases": [COLMAR]}
        mod.site_login = lambda ctx: ("http://x", "t")
        mod.served_state = lambda base, token: (config, bookings, [])
        mod.converse = lambda auto, chat, text, **kw: {
            "replies": ["ok"] if replies else [], "approvals": 0, "timed_out": not replies}
        ctx = {"chat": "9000", "config": config}
        mod.stage_companion_changes(ctx, object(), self.spec)
        return ctx

    def booking(self):
        return [{"type": "hotel", "name": self.hotel["name"], "date_from": self.hotel["check_in"],
                 "date_to": self.hotel["check_out"]}]

    def test_everything_the_companion_cannot_do_yet_is_a_known_gap_not_a_failure(self) -> None:
        ctx = self.run_stage(self.booking())
        self.assertEqual(sorted(name for name, _ in ctx["known_gaps"]),
                         ["base_stop_accommodation", "checkin_plan_item", "checkout_plan_item",
                          "stops_after_change"])

    def test_a_booking_the_companion_failed_to_record_is_a_real_failure(self) -> None:
        with self.assertRaises(self.mod.Failed) as caught:
            self.run_stage([])
        self.assertIn("hotel_booking_recorded", str(caught.exception))

    def test_a_companion_that_never_answers_is_a_failure(self) -> None:
        with self.assertRaises(self.mod.Failed):
            self.run_stage(self.booking(), replies=False)


class FakeAuto:
    """A chat the companion answers on a schedule. Time is a number the test moves."""

    def __init__(self, script):
        self.now = 0.0
        self.messages: list[dict] = []
        self.sent: list[str] = []
        self.script = script  # list of (seconds after the organizer's nth message, reply)

    def seq_now(self, chat):
        return max((m["seq"] for m in self.messages), default=0)

    def say(self, chat, text, from_id=None):
        n = len(self.sent)
        self.sent.append(text)
        for delay, reply in self.script.get(n, []):
            self.messages.append({"seq": len(self.messages) + 1, "kind": "send", "text": reply,
                                  "due": self.now + delay})

    def said(self, chat, after=0):
        return [m for m in self.messages if m["seq"] > after and m["due"] <= self.now]


class Conversation(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = load()

    def run_converse(self, auto, **kw):
        def sleep(s):
            auto.now += s

        return self.mod.converse(auto, "chat", "hello", sleep=sleep, clock=lambda: auto.now, **kw)

    def test_it_collects_the_replies_and_stops_when_the_chat_goes_quiet(self) -> None:
        auto = FakeAuto({0: [(5, "Done, I added the booking.")]})
        result = self.run_converse(auto, quiet_seconds=60, max_minutes=10, poll=10)
        self.assertEqual(result["replies"], ["Done, I added the booking."])
        self.assertFalse(result["timed_out"])
        self.assertEqual(auto.sent, ["hello"], "a statement is not answered with an approval")

    def test_a_question_is_answered_with_an_approval(self) -> None:
        auto = FakeAuto({0: [(5, "Shall I add it?")], 1: [(5, "Added.")]})
        result = self.run_converse(auto, quiet_seconds=60, max_minutes=10, poll=10)
        self.assertEqual(len(auto.sent), 2)
        self.assertIn("approve", auto.sent[1].lower())
        self.assertEqual(result["replies"], ["Shall I add it?", "Added."])

    def test_a_companion_that_never_answers_is_reported_not_waited_on_forever(self) -> None:
        auto = FakeAuto({})
        result = self.run_converse(auto, quiet_seconds=60, max_minutes=2, poll=10)
        self.assertEqual(result["replies"], [])
        self.assertTrue(result["timed_out"])

    def test_approvals_are_capped_so_two_chatty_parties_cannot_loop(self) -> None:
        script = {i: [(1, "Anything else?")] for i in range(50)}
        auto = FakeAuto(script)
        self.run_converse(auto, quiet_seconds=60, max_minutes=10, poll=10, max_approvals=3)
        self.assertEqual(len(auto.sent), 1 + 3)

    def test_a_question_mark_in_either_script_is_a_question(self) -> None:
        mod = self.mod
        self.assertTrue(mod.asks_permission("לאשר?"))
        self.assertTrue(mod.asks_permission("Shall I?"))
        self.assertFalse(mod.asks_permission("הוספתי."))


if __name__ == "__main__":
    unittest.main()
