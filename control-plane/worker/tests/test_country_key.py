"""The country_reference key is derived in two languages; this is the seam.

`control-plane/api/src/country-key.ts` writes the rows (two call paths share it);
`control_plane_worker/country_key.py` reads them. A Python process cannot import
a TypeScript function, so the rule exists twice — and a rule that exists twice
drifts unless something fails when it does. That something is this file.

The failure being guarded is silent by construction: a reader that normalises
differently from the writer simply finds no row, which is indistinguishable from
a destination nobody has refreshed yet. No exception, no log worth reading, just
a trip whose Info tab is thinner than it should be.
"""
from __future__ import annotations

import pathlib
import re
import unittest

from control_plane_worker.country_key import COUNTRY_KEY_MAX_CHARS, normalise_country_key

_TS_SOURCE = (
    pathlib.Path(__file__).resolve().parents[3]
    / "control-plane" / "api" / "src" / "country-key.ts"
)


class CrossLanguageContractTests(unittest.TestCase):
    def test_the_typescript_side_is_where_we_think_it_is(self) -> None:
        # A moved or renamed file would make every assertion below vacuous.
        self.assertTrue(_TS_SOURCE.is_file(), _TS_SOURCE)

    def test_the_length_bound_matches_the_typescript_writer(self) -> None:
        source = _TS_SOURCE.read_text(encoding="utf-8")
        match = re.search(r"COUNTRY_KEY_MAX_CHARS\s*=\s*(\d+)", source)
        self.assertIsNotNone(match, "COUNTRY_KEY_MAX_CHARS not found in country-key.ts")
        self.assertEqual(int(match.group(1)), COUNTRY_KEY_MAX_CHARS)

    def test_the_writer_still_applies_the_same_three_rules(self) -> None:
        """Not a proof of equivalence — a reminder that changing the TypeScript
        rule means changing this file too. If one of these disappears from
        country-key.ts, the Python mirror below is no longer a mirror."""
        source = _TS_SOURCE.read_text(encoding="utf-8")
        for rule in (".trim()", ".toLowerCase()", 'replace(/\\s+/g, " ")'):
            self.assertIn(rule, source, f"country-key.ts no longer does {rule}")
        self.assertIn("slice(0, COUNTRY_KEY_MAX_CHARS)", source)


class NormaliseCountryKeyTests(unittest.TestCase):
    def test_case_whitespace_and_padding_all_collapse_to_one_key(self) -> None:
        for written in ("United States", "  united   states  ", "UNITED STATES", "United  States\n"):
            self.assertEqual("united states", normalise_country_key(written), written)

    def test_absent_input_is_empty_not_the_string_none(self) -> None:
        # The caller tests the result for emptiness and bails; a key of "none"
        # would instead be a real lookup that can never match.
        self.assertEqual("", normalise_country_key(None))
        self.assertEqual("", normalise_country_key(""))
        self.assertEqual("", normalise_country_key("   "))

    def test_the_key_is_bounded_at_the_same_point_the_writer_cuts(self) -> None:
        """THE BUG THIS EXISTS FOR. The reader open-coded trim/lower/collapse and
        omitted the bound, so a destination longer than 80 characters was stored
        truncated and looked up in full — a SELECT that could never match."""
        self.assertEqual(COUNTRY_KEY_MAX_CHARS, len(normalise_country_key("a" * 500)))

    def test_whitespace_is_collapsed_before_the_cut_not_after(self) -> None:
        # Truncating first would cut at a different character than the writer,
        # which is the same mismatch by a subtler route.
        value = ("x " * 60).strip()          # 119 chars, single-spaced
        self.assertEqual(value.lower()[:COUNTRY_KEY_MAX_CHARS], normalise_country_key(value))
