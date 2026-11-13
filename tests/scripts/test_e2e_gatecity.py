"""The `gatecity` e2e scenario: Dror's manual Sprint 8 staging test, with the two
flight tickets sent as PHOTOS in one album.

Nothing here talks to a stack. It tests the parts a live run is built from —
the ticket drawing and its JPEG encoder, the checks computed from what the bot
said and what the finished trip serves, the scorecard, the wiring — with
fabricated data, so a wrong expectation is found on a laptop and not an hour
into a provisioning.

The shape of the rule being protected: each check is its own named verdict, and
the name says which issue's fix regressed. A run that is red today is red
because of those fixes, and says so check by check instead of crashing.
"""
from __future__ import annotations

import importlib.util
import io
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "e2e-full-cycle.py"
TOOLS = REPO / "control-plane/api/tools"


def load():
    spec = importlib.util.spec_from_file_location("e2e_full_cycle", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def photos():
    sys.path.insert(0, str(TOOLS))
    import ticket_photos  # noqa: E402
    return ticket_photos


E2E = load()
TP = photos()
FACTS = TP.GATECITY
TICKETS = [{"ref": t["ref"], "sha": f"sha-{t['ref']}", "surnames": t["surnames"]} for t in TP.TICKETS]


# ── The tickets, drawn ───────────────────────────────────────────────────────

def _segments(blob: bytes) -> dict:
    """Marker -> payload for the segments before the scan, and the scan's bytes."""
    assert blob[:2] == b"\xff\xd8", "starts with SOI"
    assert blob[-2:] == b"\xff\xd9", "ends with EOI"
    out, i = {"DHT": []}, 2
    while i < len(blob):
        assert blob[i] == 0xFF, f"a marker at {i}"
        marker, size = blob[i + 1], int.from_bytes(blob[i + 2:i + 4], "big")
        payload = blob[i + 4:i + 2 + size]
        name = {0xE0: "APP0", 0xDB: "DQT", 0xC0: "SOF0", 0xC4: "DHT", 0xDA: "SOS"}[marker]
        if name == "DHT":
            out["DHT"].append(payload)
        else:
            out[name] = payload
        i += 2 + size
        if name == "SOS":
            out["scan"] = blob[i:-2]
            break
    return out


def _decode(blob: bytes) -> "tuple[int, int, list[int]]":
    """A tiny baseline decoder for exactly the files the encoder writes: an
    independent reading of the bit stream, so the encoder is checked against
    something other than itself."""
    seg = _segments(blob)
    height, width = int.from_bytes(seg["SOF0"][1:3], "big"), int.from_bytes(seg["SOF0"][3:5], "big")
    quant = seg["DQT"][1]
    codes = {}
    for table in seg["DHT"]:
        klass = table[0] >> 4  # Tc in the high nibble: 0 = DC, 1 = AC
        counts, symbols = table[1:17], list(table[17:])
        code, k, mapping = 0, 0, {}
        for length in range(1, 17):
            for _ in range(counts[length - 1]):
                mapping[(length, code)] = symbols[k]
                code, k = code + 1, k + 1
            code <<= 1
        codes[klass] = mapping
    data, bits = seg["scan"].replace(b"\xff\x00", b"\xff"), []
    for byte in data:
        bits.extend((byte >> s) & 1 for s in range(7, -1, -1))
    pos = 0

    def read(n):
        nonlocal pos
        value = 0
        for _ in range(n):
            value = (value << 1) | bits[pos]
            pos += 1
        return value

    def symbol(table):
        length, code = 0, 0
        while True:
            code, length = (code << 1) | read(1), length + 1
            if (length, code) in table:
                return table[(length, code)]
            assert length < 17, "no such code"

    def value(size):
        if not size:
            return 0
        v = read(size)
        return v if v >> (size - 1) else v - (1 << size) + 1

    pixels = [0] * (width * height)
    previous = 0
    for by in range(0, height, 8):
        for bx in range(0, width, 8):
            coef = [0] * 64
            previous += value(symbol(codes[0]))
            coef[0] = previous
            k = 1
            while k < 64:
                s = symbol(codes[1])
                if s == 0x00:
                    break
                if s == 0xF0:
                    k += 16
                    continue
                k += s >> 4
                coef[k] = value(s & 15)
                k += 1
            block = [0.0] * 64
            for index, zig in enumerate(TP._ZIGZAG):
                block[zig] = coef[index] * quant
            for y in range(8):
                for x in range(8):
                    total = sum(TP._COS[u][x] * TP._COS[v][y] * block[v * 8 + u]
                                for v in range(8) for u in range(8))
                    px, py = bx + x, by + y
                    if px < width and py < height:
                        pixels[py * width + px] = max(0, min(255, round(total + 128)))
    return width, height, pixels


class TicketPhotos(unittest.TestCase):
    def test_every_character_a_ticket_prints_has_a_glyph(self) -> None:
        for ticket in TP.TICKETS:
            for text, _ in TP.ticket_lines(ticket):
                self.assertFalse({c for c in text if c not in TP.FONT}, text)

    def test_every_glyph_is_five_by_seven(self) -> None:
        for ch, rows in TP.FONT.items():
            self.assertEqual(len(rows), 7, ch)
            self.assertTrue(all(len(r) == 5 and set(r) <= set("#.") for r in rows), ch)

    def test_an_unprintable_character_is_refused_not_dropped(self) -> None:
        with self.assertRaises(ValueError):
            TP.render([("é", 4)])

    def test_the_ticket_says_what_the_scenario_asserts(self) -> None:
        # The picture and the expectation come from one set of facts: a drift
        # between them would make the run pass or fail on the fixture, not the product.
        for ticket in TP.TICKETS:
            printed = "\n".join(text for text, _ in TP.ticket_lines(ticket))
            for needle in (ticket["ref"], *ticket["passengers"], "SL 482", "14 NOV 2026", "09:40", "12:05",
                           "HARBORTOWN (HBT)", "GATECITY (GCY)", "SKYLINE AIR"):
                self.assertIn(needle, printed)

    def test_each_jpeg_is_a_real_baseline_file_of_the_size_it_says(self) -> None:
        for ticket in TP.TICKETS:
            blob = TP.ticket_jpeg(ticket)
            seg = _segments(blob)
            width, height, _ = TP.render(TP.ticket_lines(ticket))
            self.assertEqual(int.from_bytes(seg["SOF0"][1:3], "big"), height)
            self.assertEqual(int.from_bytes(seg["SOF0"][3:5], "big"), width)
            self.assertEqual(seg["SOF0"][0], 8, "8-bit samples")
            self.assertLess(len(blob), 200_000, "a phone photo, far below the vision reader's 5 MB limit")

    def test_the_bit_stream_decodes_back_to_the_picture(self) -> None:
        # Mean error is quantisation only (flat step 3); a wrong Huffman code or
        # a stuffing slip would make it garbage.
        # A slice of the ticket: the decoder is pure Python and the full picture takes a quarter of a minute.
        width, height, original = TP.render(TP.ticket_lines(TP.TICKETS[0])[:3] + [("BOOKING REFERENCE: QX7P2M", 4)])
        w2, h2, decoded = _decode(TP.encode_jpeg(width, height, original))
        self.assertEqual((w2, h2), (width, height))
        errors = [abs(a - b) for a, b in zip(original, decoded)]
        self.assertLess(sum(errors) / len(errors), 1.5)
        self.assertLess(max(errors), 40)

    @unittest.skipUnless(shutil.which("sips"), "macOS image tool not present")
    def test_the_operating_system_reads_it_too(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            paths = TP.build(Path(tmp))
            out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "format", str(paths[0])],
                                 capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertIn("jpeg", out.stdout)

    def test_the_two_tickets_differ_and_the_same_ticket_is_stable(self) -> None:
        first, second = (TP.ticket_jpeg(t) for t in TP.TICKETS)
        self.assertNotEqual(first, second)
        self.assertEqual(first, TP.ticket_jpeg(TP.TICKETS[0]))

    def test_build_writes_the_files_it_names_into_the_directory_it_is_given_and_nowhere_else(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            paths = TP.build(Path(tmp) / "nested")
            self.assertEqual([p.name for p in paths], [t["file"] for t in TP.TICKETS])
            self.assertEqual(sorted(p.name for p in (Path(tmp) / "nested").iterdir()), sorted(p.name for p in paths))
            self.assertTrue(all(p.read_bytes()[:3] == b"\xff\xd8\xff" for p in paths))

    def test_no_picture_is_committed_beside_the_generator(self) -> None:
        # Hard rule 3: the images exist only at run time.
        self.assertEqual([p.name for p in TOOLS.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"}], [])


class Facts(unittest.TestCase):
    def test_one_flight_two_bookings_four_passengers(self) -> None:
        self.assertEqual(len(TP.TICKETS), 2)
        self.assertEqual(len({t["ref"] for t in TP.TICKETS}), 2)
        self.assertEqual(sum(len(t["passengers"]) for t in TP.TICKETS), FACTS["travellers"])
        self.assertEqual(FACTS["flight"]["date"], "2026-11-14")

    def test_the_dashboard_seeds_a_return_one_day_short_so_the_correction_is_a_change(self) -> None:
        self.assertEqual(FACTS["departure_date"], "2026-11-14")
        self.assertEqual(FACTS["seed_return_date"], "2026-11-21")
        self.assertEqual(FACTS["return_date"], "2026-11-22")
        self.assertNotEqual(FACTS["seed_return_date"], FACTS["return_date"])

    def test_the_gatecity_trip_cannot_collide_with_a_live_trip(self) -> None:
        # The japan fixture shares cities and dates with a real trip; this one is invented end to end.
        self.assertNotIn("japan", str(FACTS).lower())


# ── The checks, on fabricated transcripts ────────────────────────────────────

def say(seq, text, *buttons, kind="send"):
    return {"seq": seq, "kind": kind, "messageId": 1000 + seq, "text": text,
            "buttons": [{"text": t, "data": d} for t, d in buttons]}


GREETING = ("היי ארלו 👋\nאני עוזר הטיולים שלכם מבית Kinerary, ואשמח לעזור לכם לתכנן את הטיול לגייטסיטי בנובמבר. איזה כיף! 🎉\n\n"
            "כדי שנתכנן את הטיול שהכי מתאים לכם, נעבור על כמה שאלות קצרות. אם יש לכם תוכנית טיול, כרטיסי טיסה או כל הזמנה אחרת, "
            "שלחו לי אותם כאן בצ׳אט ואלמד מהם עוד על הטיול. אז בואו נתחיל!")
START = ("בואו נתחיל", "c:nodoc")
OLD_OFFER = ("לפני שנתחיל בפרטים — אם כבר יש לכם תוכנית, אישור הזמנה או כרטיסים, שלחו אותו לכאן.",
             ("אין לי מסמך", "c:nodoc"))


class GreetingChecks(unittest.TestCase):
    def verdicts(self, messages):
        return {v.name: v for v in E2E.greeting_verdicts(messages, "Arlo", "Gatecity")}

    def test_the_intended_greeting_passes_all_three(self) -> None:
        got = self.verdicts([say(1, GREETING, START), say(2, "שאלה ראשונה?")])
        self.assertTrue(all(v.passed for v in got.values()), [v.bad for v in got.values() if not v.passed])

    def test_the_old_greeting_after_the_opening_fails_the_shape_check(self) -> None:
        # The 2026-11-12 staging run: the right opening, then the whole previous greeting body.
        long_body = GREETING + "\n\n" + "היי 👋 אני עוזר הטיולים שלכם מבית Kinerary.\n\nתנו לי שיחה אחת. " * 6
        got = self.verdicts([say(1, long_body, START)])
        self.assertFalse(got["greeting_shape_548"].passed)
        self.assertIn("characters", got["greeting_shape_548"].bad)

    def test_the_two_message_shape_of_11_12_fails_the_shape_check(self) -> None:
        got = self.verdicts([say(1, "היי ארלו, גייטסיטי בנובמבר. איזה כיף! 🎉\nכמה שאלות קצרות."), say(2, OLD_OFFER[0], OLD_OFFER[1])])
        self.assertFalse(got["greeting_shape_548"].passed)
        self.assertIn("buttons", got["greeting_shape_548"].bad)
        self.assertIn("separate document offer", got["greeting_shape_548"].bad)

    def test_an_opening_with_no_button_fails_the_shape_check(self) -> None:
        got = self.verdicts([say(1, GREETING), say(2, "שאלה ראשונה?")])
        self.assertFalse(got["greeting_shape_548"].passed)

    def test_english_names_in_a_hebrew_greeting_fail_the_names_check_and_say_which(self) -> None:
        text = "היי Arlo 👋\nאשמח לעזור לכם לתכנן את הטיול לGatecity בנובמבר. איזה כיף!\n\nכמה שאלות קצרות."
        got = self.verdicts([say(1, text, START)])
        self.assertFalse(got["greeting_names_in_hebrew_546"].passed)
        self.assertIn("Arlo", got["greeting_names_in_hebrew_546"].bad)
        self.assertIn("Gatecity", got["greeting_names_in_hebrew_546"].bad)
        self.assertTrue(got["greeting_shape_548"].passed, "shape and names are separate checks")

    def test_welcome_back_and_an_iso_date_fail_the_clean_check(self) -> None:
        for text in ("ברוכים השבים ארלו! גייטסיטי\nכמה שאלות.", "היי ארלו, גייטסיטי 2026-11-14\nכמה שאלות."):
            got = self.verdicts([say(1, text, START)])
            self.assertFalse(got["greeting_clean_548"].passed, text)

    def test_a_chat_with_nothing_in_it_fails_all_three_instead_of_crashing(self) -> None:
        got = self.verdicts([])
        self.assertEqual(len(got), 3)
        self.assertFalse(any(v.passed for v in got.values()))

    def test_edits_are_not_the_greeting(self) -> None:
        got = self.verdicts([say(1, "x", kind="edit"), say(2, GREETING, START)])
        self.assertTrue(got["greeting_shape_548"].passed)


class DuplicateChecks(unittest.TestCase):
    def test_every_message_once_passes(self) -> None:
        msgs = [say(5, "קראתי את הכרטיס הראשון ומצאתי טיסה אחת"), say(6, "קראתי את הכרטיס השני ומצאתי טיסה אחת")]
        self.assertTrue(E2E.duplicate_reply_verdict(msgs, 4).passed)

    def test_a_reply_sent_twice_after_the_album_fails_and_names_both(self) -> None:
        same = "קראתי את הכרטיס הראשון ומצאתי טיסה אחת"
        got = E2E.duplicate_reply_verdict([say(5, same), say(6, same), say(7, "שאלה אחרת לגמרי של הראיון")], 4)
        self.assertFalse(got.passed)
        self.assertIn("2x", got.bad)
        self.assertIn("seq 5, 6", got.bad)

    def test_a_duplicate_before_the_album_is_not_this_checks_business(self) -> None:
        same = "הודעה ארוכה מספיק כדי להיחשב הודעה"
        self.assertTrue(E2E.duplicate_reply_verdict([say(1, same), say(2, same), say(9, "אחרי האלבום, פעם אחת")], 4).passed)

    def test_short_acknowledgements_may_repeat(self) -> None:
        self.assertTrue(E2E.duplicate_reply_verdict([say(5, "Updated."), say(6, "Updated.")], 4).passed)

    def test_the_same_text_with_different_buttons_is_a_different_message(self) -> None:
        text = "האם להוסיף את הנוסעים האלה לרשימה?"
        got = E2E.duplicate_reply_verdict([say(5, text, ("כן", "y:travelers")), say(6, text, ("כן", "y:phases"))], 4)
        self.assertTrue(got.passed)

    def test_no_album_position_or_no_reply_fails_loudly(self) -> None:
        self.assertFalse(E2E.duplicate_reply_verdict([say(1, "x" * 30)], None).passed)
        self.assertFalse(E2E.duplicate_reply_verdict([say(1, "x" * 30)], 1).passed)


class ConfirmationChecks(unittest.TestCase):
    TEXT = "זהו, יש לי הכול — תודה. אני מקים לכם עכשיו את אתר הטיול, וזה לוקח קצת זמן."

    def test_once_passes_in_either_language(self) -> None:
        self.assertTrue(E2E.confirmation_once_verdict([say(1, self.TEXT)]).passed)
        self.assertTrue(E2E.confirmation_once_verdict([say(1, "That's everything. I'm building your trip site now.")]).passed)

    def test_twice_fails_and_says_when(self) -> None:
        got = E2E.confirmation_once_verdict([say(8, self.TEXT), say(9, self.TEXT)])
        self.assertFalse(got.passed)
        self.assertIn("2 times", got.bad)
        self.assertIn("8, 9", got.bad)

    def test_never_fails(self) -> None:
        self.assertFalse(E2E.confirmation_once_verdict([say(1, "שלום")]).passed)


class SeededChecks(unittest.TestCase):
    def test_asking_for_the_dashboards_values_again_fails_and_names_them(self) -> None:
        got = E2E.seeded_not_reasked_verdict({"asked": ["destination", "bot_name", "return_date"]})
        self.assertFalse(got.passed)
        self.assertIn("destination, return_date", got.bad)

    def test_not_asking_passes(self) -> None:
        self.assertTrue(E2E.seeded_not_reasked_verdict({"asked": ["bot_name", "organizer_identity"]}).passed)

    def test_no_report_from_the_organizer_fails_rather_than_passing_by_default(self) -> None:
        self.assertFalse(E2E.seeded_not_reasked_verdict(None).passed)
        self.assertFalse(E2E.seeded_not_reasked_verdict({"typed_fallbacks": []}).passed)


def row(name, ref, passengers="", conf_file=None, type="flight"):
    return {"type": type, "name": name, "confirmation": ref, "passengers": passengers, "conf_file": conf_file}


GOOD_ROWS = [row("SL 482 Harbortown to Gatecity", "QX7P2M", "ARLO VESPER, LENA VESPER", "a.jpg"),
             row("SL 482 Harbortown to Gatecity", "ZT3K9D", "BRIA TALLIS, COLE TALLIS", "b.jpg")]
PLAN_ONCE = [{"date": "2026-11-14", "text_en": "Flight SL 482 Harbortown to Gatecity", "text_he": ""},
             {"date": "2026-11-14", "text_en": "Check in", "text_he": ""}]


class PhotoChecks(unittest.TestCase):
    def test_each_photo_attached_byte_for_byte_passes_by_reference(self) -> None:
        got = E2E.ticket_photo_verdicts(GOOD_ROWS, {"a.jpg": "sha-QX7P2M", "b.jpg": "sha-ZT3K9D"}, TICKETS)
        self.assertEqual([v.name for v in got], ["photo_QX7P2M_attached_544", "photo_ZT3K9D_attached_544"])
        self.assertTrue(all(v.passed for v in got))

    def test_a_reservation_with_no_ticket_is_the_544_symptom(self) -> None:
        rows = [row("SL 482", "QX7P2M"), row("SL 482", "ZT3K9D")]
        got = E2E.ticket_photo_verdicts(rows, {}, TICKETS)
        self.assertFalse(any(v.passed for v in got))
        self.assertIn("read and not kept", got[0].bad)

    def test_a_photo_attached_to_the_wrong_reservation_fails_it(self) -> None:
        # Swapped: each reservation carries the OTHER ticket's photo.
        got = E2E.ticket_photo_verdicts(GOOD_ROWS, {"a.jpg": "sha-ZT3K9D", "b.jpg": "sha-QX7P2M"}, TICKETS)
        self.assertFalse(any(v.passed for v in got))
        self.assertIn("not the photo that was sent", got[0].bad)

    def test_one_photo_kept_and_one_not_is_one_red_and_one_green(self) -> None:
        rows = [GOOD_ROWS[0], row("SL 482", "ZT3K9D")]
        got = E2E.ticket_photo_verdicts(rows, {"a.jpg": "sha-QX7P2M"}, TICKETS)
        self.assertEqual([v.passed for v in got], [True, False])

    def test_no_reservation_at_all_for_a_reference_says_so(self) -> None:
        got = E2E.ticket_photo_verdicts([], {}, TICKETS)
        self.assertIn("no reservation carries QX7P2M", got[0].bad)


class SameFlightChecks(unittest.TestCase):
    FLIGHT = FACTS["flight"]

    def verdicts(self, rows, plan):
        return {v.name: v for v in E2E.same_flight_verdicts(rows, plan, self.FLIGHT, TICKETS)}

    def test_two_rows_with_their_own_passengers_and_one_plan_entry_pass(self) -> None:
        got = self.verdicts(GOOD_ROWS, PLAN_ONCE)
        self.assertTrue(all(v.passed for v in got.values()), [v.bad for v in got.values() if not v.passed])

    def test_two_rows_that_say_nothing_about_whose_they_are_fail_only_the_tell_apart_check(self) -> None:
        rows = [row("SL 482", "QX7P2M"), row("SL 482", "ZT3K9D")]
        got = self.verdicts(rows, PLAN_ONCE)
        self.assertTrue(got["flight_twice_on_reservations_549"].passed)
        self.assertFalse(got["reservations_tell_bookings_apart_549"].passed)
        self.assertIn("QX7P2M", got["reservations_tell_bookings_apart_549"].bad)

    def test_a_row_naming_both_couples_is_not_telling_them_apart(self) -> None:
        rows = [row("SL 482", "QX7P2M", "ARLO VESPER, BRIA TALLIS"), GOOD_ROWS[1]]
        self.assertFalse(self.verdicts(rows, PLAN_ONCE)["reservations_tell_bookings_apart_549"].passed)

    def test_the_flight_twice_on_the_plan_is_the_549_symptom(self) -> None:
        plan = PLAN_ONCE + [{"date": "2026-11-14", "text_en": "Flight SL482 to Gatecity", "text_he": ""}]
        got = self.verdicts(GOOD_ROWS, plan)
        self.assertFalse(got["flight_once_on_plan_549"].passed)
        self.assertIn("2 time(s)", got["flight_once_on_plan_549"].bad)

    def test_a_merged_reservation_row_fails_the_twice_check(self) -> None:
        self.assertFalse(self.verdicts(GOOD_ROWS[:1], PLAN_ONCE)["flight_twice_on_reservations_549"].passed)

    def test_the_flight_missing_from_the_plan_fails_too(self) -> None:
        self.assertFalse(self.verdicts(GOOD_ROWS, [])["flight_once_on_plan_549"].passed)

    def test_a_flight_on_another_day_is_not_this_one(self) -> None:
        plan = [{"date": "2026-11-22", "text_en": "Flight SL 482 back", "text_he": ""}]
        self.assertFalse(self.verdicts(GOOD_ROWS, plan)["flight_once_on_plan_549"].passed)


class TripChecks(unittest.TestCase):
    def test_dates_as_corrected_pass(self) -> None:
        cfg = {"meta": {"departure": "2026-11-14T09:40:00", "returnDate": "2026-11-22"}}
        self.assertTrue(E2E.trip_dates_verdict(cfg, "2026-11-14", "2026-11-22").passed)

    def test_the_uncorrected_return_date_fails_and_shows_what_it_is(self) -> None:
        got = E2E.trip_dates_verdict({"meta": {"departure": "2026-11-14", "returnDate": "2026-11-21"}},
                                     "2026-11-14", "2026-11-22")
        self.assertFalse(got.passed)
        self.assertIn("2026-11-21", got.bad)

    def test_a_config_with_no_meta_fails_instead_of_raising(self) -> None:
        self.assertFalse(E2E.trip_dates_verdict({}, "2026-11-14", "2026-11-22").passed)

    def test_four_travellers_from_two_tickets(self) -> None:
        def intake(n):
            return {"travelers": {"kind": "structured", "data": [{"name": f"p{i}"} for i in range(n)]}}
        self.assertTrue(E2E.travellers_verdict(intake(4), 4).passed)
        self.assertFalse(E2E.travellers_verdict(intake(2), 4).passed)
        self.assertFalse(E2E.travellers_verdict({}, 4).passed)


# ── Reporting: every check named, none hidden, nothing raised before the end ──

class Scorecard(unittest.TestCase):
    def test_a_red_run_lists_every_failing_check_by_name_and_raises_once_at_the_end(self) -> None:
        passing = E2E.Verdict("greeting_shape_548", True, "ok", "")
        failing = [E2E.Verdict("photo_QX7P2M_attached_544", False, "", "no ticket attached"),
                   E2E.Verdict("flight_once_on_plan_549", False, "", "twice")]
        ctx = {"gatecity_verdicts": [passing, *failing]}
        out = io.StringIO()
        with redirect_stdout(out), self.assertRaises(E2E.Failed) as raised:
            E2E.finish_gatecity(ctx)
        text = out.getvalue()
        self.assertIn("photo_QX7P2M_attached_544", text)
        self.assertIn("flight_once_on_plan_549", text)
        self.assertIn("1 of 3 checks pass, 2 fail", text)
        self.assertIn("2 of 3 gatecity check(s) failed", str(raised.exception))

    def test_a_green_run_does_not_raise(self) -> None:
        with redirect_stdout(io.StringIO()):
            E2E.finish_gatecity({"gatecity_verdicts": [E2E.Verdict("x_543", True, "ok", "")]})

    def test_reporting_prints_every_verdict_before_anything_is_raised(self) -> None:
        verdicts = [E2E.Verdict("a_543", False, "", "bad a"), E2E.Verdict("b_544", False, "", "bad b")]
        out = io.StringIO()
        with redirect_stdout(out):
            hard = E2E.report_verdicts(verdicts, {}, {}, raise_on_hard=False)
        self.assertEqual(len(hard), 2)
        self.assertIn("a_543", out.getvalue())
        self.assertIn("b_544", out.getvalue())

    def test_a_chat_with_nothing_in_it_is_judged_not_crashed_on(self) -> None:
        verdicts = E2E.chat_verdicts([], None, FACTS)
        self.assertTrue(verdicts)
        self.assertFalse(any(v.passed for v in verdicts))

    def test_every_verdict_is_named_by_the_issue_it_protects_where_there_is_one(self) -> None:
        names = [v.name for v in E2E.chat_verdicts([], None, FACTS)]
        names += [v.name for v in E2E.ticket_photo_verdicts([], {}, TICKETS)]
        names += [v.name for v in E2E.same_flight_verdicts([], [], FACTS["flight"], TICKETS)]
        self.assertTrue(all(re.search(r"_\d{3}$", n) for n in names), names)
        issues = {re.search(r"(\d{3})$", n).group(1) for n in names}
        self.assertEqual(issues, {"543", "544", "546", "548", "549", "438"})


class Wiring(unittest.TestCase):
    def test_it_is_selectable_but_not_part_of_all(self) -> None:
        self.assertEqual(E2E.GATECITY, "gatecity")
        self.assertNotIn("gatecity", E2E.ALL_SCENARIOS)
        self.assertIn("gatecity", E2E.TRIP_NAMES)

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)

    def test_it_needs_auto(self) -> None:
        out = self.run_cli("--scenario", "gatecity")
        self.assertEqual(out.returncode, 2)
        self.assertIn("needs --auto", out.stderr)

    def test_dry_run_is_for_gatecity_only(self) -> None:
        out = self.run_cli("--scenario", "japan", "--dry-run")
        self.assertEqual(out.returncode, 2)
        self.assertIn("gatecity", out.stderr)

    def test_the_deploy_script_accepts_it_and_requires_auto(self) -> None:
        text = next((REPO / "scripts").glob("preflight-d*.sh")).read_text()
        # The help text, the missing-argument error, the case that validates it and its error message.
        self.assertGreaterEqual(text.count("gatecity|all|none"), 4)
        self.assertRegex(text, r'\[ "\$SCENARIO" = gatecity \] && \[ "\$AUTO" = 0 \]')

    def test_the_organizer_has_the_same_scenario(self) -> None:
        source = (TOOLS / "auto-organizer.ts").read_text()
        self.assertIn("gatecity: GATECITY_SCENARIO", source)
        self.assertIn('"--photos"', (SCRIPT).read_text())

    def test_the_dashboard_half_does_what_the_dashboard_does(self) -> None:
        source = SCRIPT.read_text()
        for route in ("/v1/auth/email-password", "/v1/account/name", "/v1/trips\"", "/interview-link"):
            self.assertIn(route, source)


if __name__ == "__main__":
    unittest.main()
