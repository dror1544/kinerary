"""phase.packing abstains unless the place and the season are confidently known
(issue #167, widened 2026-09-25).

The owner's rule: "if not sure, better not to say anything than be unreasonable".
A phase gets a packing list only when its month is known, its location resolves
to ONE place, and that place's climate is one where a hemisphere x month season
bucket is reliable (temperate north or temperate south). Everything else leaves
`phase.packing` absent -- the site then shows only the general list -- and says
WHY through a machine-readable reason on the `transformer.packing_abstained` log
record, which the table below reads back.

The acceptance table drives the real `transform_intake` path, so it proves the
wiring (phase names reaching the resolver) as well as the resolver. No test
here reaches the network: the resolver is a static table by design.
"""
from __future__ import annotations

import logging
import unittest
from typing import Any

from control_plane_worker import packing_climate
from control_plane_worker.packing_climate import (
    CITIES,
    COUNTRIES,
    MAX_COLDEST_C,
    MIN_WARMEST_C,
    NAMESAKES,
    REASONS,
    TEMPERATE_NORTH,
    TEMPERATE_SOUTH,
    TERRITORIES,
    VARIES,
    decide,
)
from control_plane_worker.transformer import (
    _COUNTRY_ALIASES,
    _PACKING_ITEMS_BY_SEASON,
    transform_intake,
)


def _text(value: str) -> dict:
    return {"kind": "text", "schema_version": 1, "text": value}


def _choice(option_id: str) -> dict:
    return {"kind": "choice", "option_id": option_id, "schema_version": 1, "other_text": None}


def _structured(value: Any) -> dict:
    return {"kind": "structured", "schema_version": 1, "data": value}


def _intake(destination: str, phase: dict) -> dict:
    return {
        "trip_type": _choice("family"),
        "destination": _text(destination),
        "group_size": _choice("2"),
        "trip_duration": _choice("two_weeks"),
        "phases": _structured([phase]),
    }


class _Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def _run(destination: str, phase_name: str, month: int | None, phase_name_en: str | None = None,
         start: str | None = None, end: str | None = None):
    """transform_intake for one phase; returns (phase dict, abstention reasons logged).
    A one-week phase inside `month`, or exactly `start`..`end` when given."""
    phase: dict[str, Any] = {"name": phase_name}
    if phase_name_en:
        phase["name_en"] = phase_name_en
    if start:
        phase["start"], phase["end"] = start, end or start
    elif month is not None:
        phase["start"] = f"2027-{month:02d}-10"
        phase["end"] = f"2027-{month:02d}-17"
    log = logging.getLogger("control_plane_worker.transformer")
    capture = _Capture()
    previous = log.level
    log.addHandler(capture)
    log.setLevel(logging.DEBUG)
    try:
        config = transform_intake(_intake(destination, phase))
    finally:
        log.removeHandler(capture)
        log.setLevel(previous)
    reasons = [
        getattr(r, "reason", None)
        for r in capture.records
        if r.getMessage() == "transformer.packing_abstained"
    ]
    return config["phases"][0], reasons


# Expected outcome is a season bucket (a list is emitted, with exactly that
# bucket's items) or an abstention reason (no list, and that reason logged).
BUCKETS = {"cold", "hot", "rainy", "moderate"}
JAN, APR, JUL, OCT = 1, 4, 7, 10

MAR, MAY, NOV = 3, 5, 11

# (destination, phase name, month, expected)
ACCEPTANCE: list[tuple[str, str, int | None, str]] = [
    # --- the brief's named cases -------------------------------------------
    ("Thailand", "Stop", JAN, "tropical"),                     # was: Warm jacket, Gloves
    ("Sydney", "Stop", JAN, "mild_winter"),                    # 12.5C July; was north/cold
    ("Melbourne", "Stop", JUL, "mild_winter"),                 # 10.3C July
    ("Chile, Spain", "Stop", JAN, "ambiguous_multi_place"),    # was north (last segment)
    ("Spain, Chile", "Stop", JAN, "ambiguous_multi_place"),    # was south (last segment)
    ("Argentina and Chile", "Stop", JAN, "ambiguous_multi_place"),  # was never split: north
    ("צ׳ילה", "Stop", JAN, "climate_varies_by_area"),          # geresh U+05F3: resolves to Chile
    ("צ'ילה", "Stop", JAN, "climate_varies_by_area"),          # ASCII apostrophe: same place
    ("Perugia, Italy", "Stop", JAN, "climate_varies_by_area"),  # Italy -- NOT "peru" (tropical)
    ("Italy", "Stop", JUL, "climate_varies_by_area"),          # Sicily, Puglia, Sardinia
    ("Italy", "Stop", JAN, "climate_varies_by_area"),
    ("Italy", "Venice", JAN, "cold"),                          # a named Cfa city keeps its list
    ("Italy", "Milan", JUL, "hot"),
    ("Italy", "Florence", JAN, "mediterranean"),               # Cfa/Csa border: not sure
    ("Unknown Destination", "Stop", JAN, "unresolved"),        # was: defaulted north
    ("", "Stop", JAN, "no_destination"),
    ("   ", "Stop", JAN, "no_destination"),
    ("Italy", "Stop", None, "no_dates"),
    ("Peru", "Stop", JAN, "tropical"),                         # decision: tropical (0-18.5 S)
    ("איטליה", "Stop", JAN, "climate_varies_by_area"),         # Hebrew country, resolved
    ("גרמניה", "Stop", JAN, "climate_varies_by_area"),         # no country is ever inherited
    ("Japan", "Stop", JAN, "climate_varies_by_area"),          # Okinawa to Hokkaido
    ("USA", "Stop", JAN, "climate_varies_by_area"),
    # --- per-phase resolution refines a coarse or multi-place destination ---
    ("Japan", "Tokyo", JAN, "cold"),
    ("Japan", "Okinawa", JAN, "mild_winter"),
    ("יפן", "טוקיו", JAN, "cold"),                              # Hebrew country + Hebrew city
    ("USA", "New York", JAN, "cold"),
    ("USA", "Miami", JAN, "tropical"),                         # Koppen Am
    ("USA", "Honolulu", JAN, "tropical"),
    ("USA", "Boston", MAR, "shoulder_month"),
    ("Chile, Spain", "Madrid", JAN, "mediterranean"),          # placed, and Csa
    ("Argentina and Chile", "Buenos Aires", JAN, "mild_winter"),
    ("Chile", "Santiago de Chile", JUL, "mediterranean"),
    ("Tokyo, Hakone, Kyoto, Osaka, Japan", "Kyoto", APR, "rainy"),
    # Hakone is deliberately NOT in the table: an unknown town falls back to
    # the destination, and "Japan" abstains.
    ("Tokyo, Hakone, Kyoto, Osaka, Japan", "Hakone", JAN, "climate_varies_by_area"),
    ("Australia", "Stop", JAN, "climate_varies_by_area"),
    ("Australia", "Canberra", JAN, "hot"),
    ("Australia", "Canberra", JUL, "cold"),
    ("אוסטרליה", "סידני", JAN, "mild_winter"),
    ("New Zealand", "Christchurch", JAN, "hot"),               # a namesake the trip confirms
    ("ניו זילנד", "קווינסטאון", JUL, "cold"),
    ("Spain", "Tenerife", JAN, "arid"),                        # Canaries are BWh
    ("Canada", "Sydney", JAN, "conflicts_with_destination"),   # Sydney, Nova Scotia
    ("Somewhere nice", "Kyoto", JAN, "cold"),                  # unplaced trip, uniquely placed phase
    ("Somewhere nice", "Paris", JAN, "namesake"),              # Paris, Texas / Paris, Ontario
    ("France", "Paris", OCT, "moderate"),
    ("Paris, Texas", "Stop", JAN, "climate_varies_by_area"),   # Paris is Texas's here
    ("Paris, Texas", "Paris", JAN, "conflicts_with_destination"),
    ("Naples, Florida", "Naples", JAN, "conflicts_with_destination"),
    ("Tokyo, Hakone, Kyoto", "Stop", JAN, "unresolved"),       # Hakone unknown, no country named
    # --- the audit's structural cases (rework round 1) ----------------------
    ("Scottish Highlands", "Perth, Scotland", JUL, "namesake"),  # was: gloves in July
    ("Cape Breton", "Sydney, Nova Scotia", JAN, "namesake"),     # was: sunscreen in January
    ("Florida Gulf Coast", "Naples, Florida", JAN, "namesake"),
    ("Space Coast", "Melbourne", JUL, "namesake"),
    ("Germany, Malta", "Malta", JAN, "mediterranean"),         # was: Germany's list for Malta
    ("Germany, Cape Verde", "Praia", JAN, "climate_varies_by_area"),  # unknown: never inherits
    ("Italy, Malta", "Malta", JAN, "mediterranean"),
    ("Portugal, Cape Verde", "Praia", JAN, "climate_varies_by_area"),
    ("Denmark, Faroe Islands", "Stop", JAN, "subpolar"),
    ("Christchurch", "Auckland - Rarotonga", JUL, "unresolved"),  # partly placed phase
    ("Canberra", "Whitsundays", JUL, "unresolved"),            # city-only destination not extended
    ("Tokyo", "Miyakojima", JAN, "unresolved"),
    ("Bangkok, Germany", "Phi Phi", JAN, "climate_varies_by_area"),  # a list, not "Bangkok in Germany"
    ("Bangkok, Italy", "Bangkok", JAN, "conflicts_with_destination"),
    # --- the audit's content cases: the criterion, place by place ------------
    ("Portugal", "Lisbon", JAN, "mediterranean"),
    ("Greece", "Athens", MAY, "mediterranean"),
    ("Australia", "Perth", NOV, "mediterranean"),
    ("Spain", "Seville", MAY, "mediterranean"),
    ("South Africa", "Cape Town", JUL, "mediterranean"),
    ("China", "Beijing", APR, "summer_rain"),
    ("South Korea", "Seoul", APR, "summer_rain"),
    ("Argentina", "Mendoza", OCT, "arid"),
    ("Spain", "Santa Cruz de Tenerife", JAN, "arid"),
    ("UK", "Isles of Scilly", JAN, "mild_winter"),
    # --- the second audit (round 2) ------------------------------------------
    ("Denmark", "Faroe Islands", JUL, "subpolar"),             # was: Denmark's summer list at 11C
    ("Denmark", "Greenland", JUL, "subpolar"),
    ("Netherlands", "Curaçao", JAN, "tropical"),               # was: gloves
    ("UK", "Gibraltar", JAN, "mediterranean"),
    ("UK", "Falklands", JUL, "subpolar"),                      # was: a hemisphere flip
    ("UK", "Orkney", JUL, "cool_summer"),
    ("Germany", "Mallorca", JAN, "conflicts_with_destination"),
    ("UK", "Stop", JAN, "climate_varies_by_area"),
    ("Ireland", "Stop", JAN, "climate_varies_by_area"),
    ("Canada", "Quebec City", APR, "shoulder_month"),          # ~3.3C April
    ("UK", "Edinburgh", 6, "cool_summer"),                     # ~13.3C June
    ("UK", "Edinburgh", JUL, "hot"),
    ("New Zealand", "Queenstown", 12, "cool_summer"),          # ~14.0C December
    ("Japan", "Osaka", 12, "mild_winter"),                     # ~8.7C December
    ("Japan", "Osaka", JAN, "cold"),
    ("Japan", "Tokyo", 12, "mild_winter"),                     # 7.7C: inside the 0.5C margin
    ("Somewhere", "Toronto", JAN, "namesake"),                 # Toronto, New South Wales
    ("Somewhere", "Toronto (NSW)", JAN, "namesake"),           # a bracket demotes
    ("Somewhere", "Kyoto (Nova Scotia)", JAN, "namesake"),
    ("Somewhere", "Christchurch, NZ", JAN, "hot"),             # "NZ" anchors the namesake
    ("Somewhere", "Washington, DC", JAN, "cold"),
    ("Canada", "Montreal", MAR, "shoulder_month"),
    ("Canada", "Montreal", NOV, "shoulder_month"),
    ("Canada", "Montreal", JAN, "cold"),
    ("Canada", "Montreal", JUL, "hot"),
    ("Germany", "Stop", MAR, "climate_varies_by_area"),
    ("Germany", "Berlin", OCT, "moderate"),
    ("Germany", "Berlin", APR, "rainy"),
    # --- Hebrew prepositions: dropped only when the rest resolves exactly ---
    ("לאיטליה", "Stop", JAN, "climate_varies_by_area"),        # resolved as Italy
    ("בפורטוגל", "Stop", JAN, "climate_varies_by_area"),
    ("Spain", "ממדריד", JAN, "mediterranean"),
    ("לגרמניה", "Stop", JAN, "climate_varies_by_area"),      # resolved as Germany
    ("Germany", "לברלין", JAN, "cold"),
    ("טיול לאיטליה", "Stop", JAN, "unresolved"),               # a phrase, not a name
    # --- other regimes and shapes -------------------------------------------
    ("Vietnam", "Stop", JAN, "tropical"),
    ("וייטנאם", "Stop", JAN, "tropical"),
    ("Iceland", "Stop", JUL, "subpolar"),
    ("Dubai", "Stop", JAN, "arid"),
    ("Brazil", "Stop", JAN, "climate_varies_by_area"),
    ("Brazil", "Rio de Janeiro", JUL, "tropical"),
    ("New Zealand", "Stop", JAN, "climate_varies_by_area"),    # Auckland 10.9C July
    ("Trinidad and Tobago", "Stop", JAN, "tropical"),          # "and" inside ONE country's name
    ("Portugal — Lisbon and Porto", "Stop", JAN, "mediterranean"),
    ("ארגנטינה וצ׳ילה", "Stop", JAN, "ambiguous_multi_place"),  # Hebrew "and" (vav prefix)
    ("Tokyo, Okinawa", "Stop", JAN, "climate_varies_by_area"),
    ("Germany", "Berlin (Museum Island; zoo)", JAN, "cold"),   # a descriptive bracket is ignored
]


# The 2026-09-25 audit (rework round 1): places and structures for which the
# first cut still emitted a list. Reason-agnostic on purpose -- the question
# here is only "list or not"; the exact reasons are pinned in ACCEPTANCE.
AUDIT_MUST_ABSTAIN: list[tuple[str, str, int]] = [
    # climate content: a season bucket that is wrong for the place
    ("Portugal", "Lisbon", JAN),            # 11.6C mean January: not a gloves month
    ("Greece", "Athens", MAY),              # dry May: no waterproof footwear
    ("Australia", "Perth", 11),             # Mediterranean: dry spring
    ("Spain", "Seville", MAY),
    ("South Africa", "Cape Town", JUL),     # wet mild winter
    ("China", "Beijing", APR),              # dry spring, monsoon summer
    ("Argentina", "Mendoza", OCT),          # desert
    ("Spain", "Santa Cruz de Tenerife", JAN),  # a Canaries name outside the first six spellings
    ("Spain", "Maspalomas", JAN),
    ("Italy", "Stop", JAN),                 # Sicily, Puglia, Sardinia: ~10-12C January
    # namesakes when the destination does not place the trip
    ("Scottish Highlands", "Perth, Scotland", JUL),
    ("Scottish Highlands", "Perth, Scotland", JAN),
    ("Cape Breton", "Sydney, Nova Scotia", JAN),
    ("Florida Gulf Coast", "Naples, Florida", JAN),
    ("Somewhere", "Christchurch, Dorset", JAN),
    ("Somewhere", "Queenstown, Tasmania", JAN),
    ("Somewhere", "Wellington, Florida", JUL),
    ("Georgia", "Athens", JAN),
    ("Georgia", "Rome", JAN),
    ("Space Coast", "Melbourne", JUL),
    # unknown places absorbed into a known country or city
    ("Germany, Malta", "Malta", JAN),
    ("Italy, Malta", "Malta", JAN),
    ("Portugal, Cape Verde", "Praia", JAN),
    ("Denmark, Faroe Islands", "Torshavn", JAN),
    ("Denmark, Faroe Islands", "Stop", JAN),
    ("New Zealand and Cook Islands", "Rarotonga", JUL),
    ("Christchurch", "Auckland - Rarotonga", JUL),   # a partly placed phase
    ("Sydney", "Whitsundays", JUL),
    ("Canberra", "Whitsundays", JUL),       # a city-only destination is not extended
    ("Tokyo", "Miyakojima", JAN),
    ("Bangkok, Italy", "Phi Phi", JAN),
    ("Bangkok, Germany", "Phi Phi", JAN),
    # shoulder months in continental-cold places
    ("Canada", "Montreal", MAR),
    ("Canada", "Montreal", NOV),
    ("Canada", "Quebec City", NOV),
]
# Controls: the criterion keeps these, so they must still get a list.
AUDIT_MUST_KEEP: list[tuple[str, str, int]] = [
    ("Canada", "Montreal", JAN),
    ("Germany", "Berlin", JAN),       # was ("Germany", "Stop"): no country is inherited now
    ("Japan", "Tokyo", APR),
    ("New Zealand", "Christchurch", JAN),
    ("USA", "New York", JAN),
    ("Italy", "Venice", JUL),         # was Florence, which is not kept after round 2
]


# Round 2 of the audit (2026-09-25): holes the rework still had.
ROUND2_MUST_ABSTAIN: list[tuple[str, str, int]] = [
    # 1. an unknown territory inherited its sovereign's temperate list
    ("Denmark", "Faroe Islands", JUL),
    ("Denmark", "Greenland", JUL),
    ("Netherlands", "Curaçao", JAN),
    ("Netherlands", "Aruba", JAN),
    ("Netherlands", "Bonaire", JAN),
    ("UK", "Gibraltar", JAN),
    ("UK", "Falklands", JUL),              # a hemisphere flip
    ("UK", "Shetland", JUL),
    ("Germany", "Mallorca", JAN),
    # 2. the criterion checked one month; each list covers three
    ("Canada", "Quebec City", APR),        # ~3.3C April
    ("UK", "Edinburgh", 6),                # ~13.3C June
    ("New Zealand", "Queenstown", 12),     # ~14.0C December
    ("Japan", "Osaka", 12),                # ~8.7C December
    ("Japan", "Yokohama", 12),
    # 3. countries that fail with no margin, and Florence (Cfa/Csa border)
    ("UK", "Stop", JAN),
    ("Ireland", "Stop", JAN),
    ("Italy", "Florence", 2),
    ("Italy", "Florence", JUL),
    # 4. namesakes the first table missed
    ("Somewhere", "Toronto", JAN),         # Toronto, New South Wales
    ("Somewhere", "Edinburgh", JUL),       # Edinburgh, South Australia
    ("Somewhere", "Vienna", JAN),          # Vienna, Virginia
    ("Somewhere", "Boston", JAN),          # Boston, Lincolnshire
    # 5. a bracketed qualifier was deleted before it could demote
    ("Somewhere", "Toronto (NSW)", JAN),
    ("Somewhere", "Kyoto (Nova Scotia)", JAN),
]
# (destination, phase, start, end): a phase spanning more than one month
ROUND2_SPANS: list[tuple[str, str, str, str, str]] = [
    ("Canada", "Montreal", "2027-10-28", "2027-11-15", "shoulder_month"),  # November is winter
    ("Germany", "Berlin", "2027-02-10", "2027-04-10", "spans_seasons"),    # cold into rainy
]
ROUND2_MUST_KEEP: list[tuple[str, str, int]] = [
    ("Somewhere", "Christchurch, NZ", JAN),   # 6. "NZ" now anchors the namesake
    ("Italy", "Venice", JUL),
    ("Germany", "Berlin", JAN),
]


class RoundTwoAuditTests(unittest.TestCase):
    def test_round_two_holes_abstain(self) -> None:
        for destination, phase_name, month in ROUND2_MUST_ABSTAIN:
            with self.subTest(destination=destination, phase=phase_name, month=month):
                phase, _reasons = _run(destination, phase_name, month)
                self.assertNotIn("packing", phase, "must abstain, got a list")

    def test_every_month_of_a_phase_is_judged(self) -> None:
        for destination, phase_name, start, end, reason in ROUND2_SPANS:
            with self.subTest(destination=destination, phase=phase_name, start=start, end=end):
                phase, reasons = _run(destination, phase_name, None, start=start, end=end)
                self.assertNotIn("packing", phase, "must abstain, got a list")
                self.assertEqual([reason], reasons)

    def test_round_two_keeps(self) -> None:
        for destination, phase_name, month in ROUND2_MUST_KEEP:
            with self.subTest(destination=destination, phase=phase_name, month=month):
                phase, _reasons = _run(destination, phase_name, month)
                self.assertIn("packing", phase)


class AuditRegressionTests(unittest.TestCase):
    def test_places_and_structures_the_audit_found_abstain(self) -> None:
        for destination, phase_name, month in AUDIT_MUST_ABSTAIN:
            with self.subTest(destination=destination, phase=phase_name, month=month):
                phase, _reasons = _run(destination, phase_name, month)
                self.assertNotIn("packing", phase, "must abstain, got a list")

    def test_the_criterion_keeps_its_controls(self) -> None:
        for destination, phase_name, month in AUDIT_MUST_KEEP:
            with self.subTest(destination=destination, phase=phase_name, month=month):
                phase, _reasons = _run(destination, phase_name, month)
                self.assertIn("packing", phase)


class PackingAcceptanceTableTests(unittest.TestCase):
    def test_every_case_emits_exactly_what_is_known_and_nothing_else(self) -> None:
        self.assertGreaterEqual(len(ACCEPTANCE), 30)
        for destination, phase_name, month, expected in ACCEPTANCE:
            with self.subTest(destination=destination, phase=phase_name, month=month):
                phase, reasons = _run(destination, phase_name, month)
                if expected in BUCKETS:
                    self.assertIn("packing", phase, f"expected a {expected} list")
                    got = [(c["en"], i["en"]) for c, i in phase["packing"]]
                    want = [(c["en"], i["en"]) for c, i in _PACKING_ITEMS_BY_SEASON[expected]]
                    self.assertEqual(want, got)
                    self.assertEqual([], reasons)
                else:
                    self.assertIn(expected, REASONS)
                    self.assertNotIn("packing", phase, f"must abstain ({expected}), got a list")
                    self.assertEqual([expected], reasons)

    def test_every_abstention_reason_in_the_enum_is_exercised(self) -> None:
        used = {expected for *_rest, expected in ACCEPTANCE if expected not in BUCKETS}
        used |= {reason for *_rest, reason in ROUND2_SPANS}
        self.assertEqual(set(REASONS), used)

    def test_the_reason_is_never_written_into_the_trip_config(self) -> None:
        intake = _intake("Thailand", {"name": "Bangkok", "start": "2027-01-10", "end": "2027-01-17"})
        text = repr(transform_intake(intake))
        for reason in REASONS:
            self.assertNotIn(reason, text)


# City -> other countries with a well-known place of the same name. Written
# independently of packing_climate.NAMESAKES (see the test that uses it).
KNOWN_TWINS: dict[str, frozenset[str]] = {
    "perth": frozenset({"uk", "canada"}),          # Scotland; Ontario
    "sydney": frozenset({"canada"}),               # Nova Scotia
    "melbourne": frozenset({"usa"}),               # Florida
    "wellington": frozenset({"usa", "uk"}),        # Florida; Somerset
    "christchurch": frozenset({"uk"}),             # Dorset
    "queenstown": frozenset({"australia", "south africa"}),
    "toronto": frozenset({"australia"}),           # New South Wales
    "edinburgh": frozenset({"australia"}),         # South Australia
    "vienna": frozenset({"usa"}),                  # Virginia
    "boston": frozenset({"uk"}),                   # Lincolnshire
    "naples": frozenset({"usa"}),                  # Florida
    "athens": frozenset({"usa"}),                  # Georgia
    "rome": frozenset({"usa"}),                    # Georgia
    "paris": frozenset({"usa", "canada"}),         # Texas; Ontario
    "london": frozenset({"canada"}),               # Ontario
    "dublin": frozenset({"usa"}),                  # Ohio
    "berlin": frozenset({"usa"}),                  # New Hampshire
    "venice": frozenset({"usa"}),                  # Florida
    "florence": frozenset({"usa"}),                # Alabama
    "milan": frozenset({"usa"}),
    "warsaw": frozenset({"usa"}),
    "prague": frozenset({"usa"}),
    "vancouver": frozenset({"usa"}),               # Washington
}


class ResolverSafetyTests(unittest.TestCase):
    """Properties over the whole table: whatever a person types, a place the
    table does not call temperate can never produce a list, in any month."""

    def test_no_country_region_or_territory_ever_yields_a_hemisphere(self) -> None:
        # Only a named city is precise enough to know its months. A country,
        # region or territory -- as the destination, as the phase, or both --
        # never produces a list, in any month.
        names = list(COUNTRIES) + list(packing_climate.REGIONS) + list(TERRITORIES)
        for key in names:
            for month in range(1, 13):
                with self.subTest(place=key, month=month):
                    for destination, phases in ((key, ()), (key, (key,)), (key, ("Stop",))):
                        decision = decide(destination, phases, month)
                        self.assertIsNone(decision.hemisphere)
                        self.assertIn(decision.reason, REASONS)

    def test_a_phase_that_names_no_known_place_never_inherits(self) -> None:
        # The first rework let an unknown island inherit a temperate country
        # (Faroe Islands under Denmark). Now nothing inherits: under any
        # destination the table knows, an unknown phase name abstains.
        for destination in list(COUNTRIES) + list(CITIES):
            for month in (1, 4, 7, 10):
                with self.subTest(destination=destination, month=month):
                    self.assertIsNone(decide(destination, ("Xyzzy Island",), month).hemisphere)

    def test_a_temperate_city_is_on_its_own_side_of_the_tropics(self) -> None:
        # The latitude is the check on the hemisphere: a temperate city on the
        # wrong side of the equator would ship the opposite season.
        for key, city in CITIES.items():
            with self.subTest(city=key):
                if city.regime == TEMPERATE_NORTH:
                    self.assertGreater(city.lat, 23.5)
                elif city.regime == TEMPERATE_SOUTH:
                    self.assertLess(city.lat, -23.5)
                if abs(city.lat) < 23.5:
                    self.assertNotIn(city.regime, {TEMPERATE_NORTH, TEMPERATE_SOUTH})

    def test_a_temperate_city_carries_every_number_the_criterion_reads(self) -> None:
        # Criterion 4 is month by month: a temperate city without all twelve
        # means would have months nobody checked.
        for key, city in CITIES.items():
            if city.regime not in (TEMPERATE_NORTH, TEMPERATE_SOUTH):
                continue
            with self.subTest(city=key):
                self.assertEqual("f", city.koppen[1])
                self.assertIsNotNone(city.months)
                self.assertEqual(12, len(city.months))
                self.assertLessEqual(min(city.months), MAX_COLDEST_C)
                self.assertGreaterEqual(max(city.months), MIN_WARMEST_C)

    def test_every_month_that_gets_a_list_passes_its_buckets_test(self) -> None:
        # Exhaustive over the table: for every temperate city and every month,
        # a list is emitted exactly when that month's mean passes its bucket's
        # threshold with the margin -- never otherwise.
        for key, city in CITIES.items():
            if city.regime not in (TEMPERATE_NORTH, TEMPERATE_SOUTH):
                continue
            hemisphere = "north" if city.regime == TEMPERATE_NORTH else "south"
            anchor = city.country
            for month in range(1, 13):
                with self.subTest(city=key, month=month):
                    mean = city.months[month - 1]
                    bucket = packing_climate.season_bucket(month, hemisphere)
                    ok = {"cold": mean <= 7.5, "hot": mean >= 14.5}.get(bucket, mean >= 5.0)
                    decision = decide(anchor, (key,), month)
                    self.assertEqual(hemisphere if ok else None, decision.hemisphere)

    def test_the_covered_territories_are_exactly_these(self) -> None:
        # Pinned so nobody assumes completeness: these are the territories and
        # islands that resolve to their own climate. Anything else abstains as
        # an unknown name -- safely, since nothing inherits -- but with a less
        # precise reason.
        self.assertEqual(sorted(TERRITORIES), sorted([
            "faroe islands", "greenland", "shetland", "orkney", "hebrides", "isle of man",
            "channel islands", "isles of scilly", "gibraltar", "falkland islands", "bermuda",
            "aruba", "curacao", "bonaire", "sint maarten", "saba", "sint eustatius",
            "mallorca", "menorca", "ibiza", "formentera", "balearic islands", "corsica",
            "sardinia", "sicily", "crete", "rhodes", "santorini", "mykonos", "reunion",
            "martinique", "guadeloupe", "french polynesia", "new caledonia", "svalbard",
            "tromso", "rovaniemi", "puerto rico", "guam", "us virgin islands", "macau",
        ]))
        for key, territory in TERRITORIES.items():
            with self.subTest(territory=key):
                self.assertIn(territory.country, COUNTRIES)
                self.assertNotIn(territory.regime, {TEMPERATE_NORTH, TEMPERATE_SOUTH})

    def test_every_city_and_region_belongs_to_a_country_in_the_table(self) -> None:
        for key, city in CITIES.items():
            with self.subTest(city=key):
                self.assertIn(city.country, COUNTRIES)
        for key, region in packing_climate.REGIONS.items():
            with self.subTest(region=key):
                self.assertIn(region.country, COUNTRIES)

    def test_no_name_is_claimed_by_two_places(self) -> None:
        # Two entries sharing a spelling would make the lookup order decide.
        self.assertEqual([], packing_climate.duplicate_names())

    def test_the_brief_named_varies_by_area_countries_abstain(self) -> None:
        for key in ("usa", "canada", "china", "india", "brazil", "australia",
                    "russia", "chile", "argentina", "mexico", "japan",
                    "italy", "spain", "portugal", "greece", "croatia", "montenegro",
                    "uk", "ireland", "germany", "netherlands", "denmark"):
            with self.subTest(country=key):
                self.assertEqual(VARIES, COUNTRIES[key])
                self.assertEqual("climate_varies_by_area", decide(key, (), 1).reason)

    def test_every_known_twin_of_a_city_in_the_table_is_recorded(self) -> None:
        # KNOWN_TWINS is written separately from NAMESAKES, from the audits and
        # an atlas, so that a twin added to one and not the other is caught.
        # It is not complete either; it is a floor.
        for city, twins in KNOWN_TWINS.items():
            if city not in CITIES:
                continue
            with self.subTest(city=city):
                self.assertIn(city, NAMESAKES)
                self.assertLessEqual(twins, NAMESAKES[city])

    def test_no_namesake_reaches_a_list_unless_the_trip_confirms_it(self) -> None:
        # A hemisphere flip is the worst error this feature can make, and a
        # namesake is how it happens. For every namesake, in every month:
        # alone, under an unplaced destination, under each twin's country,
        # qualified by each twin's country, and as its own destination.
        for city, twins in NAMESAKES.items():
            self.assertIn(city, CITIES)
            for month in range(1, 13):
                shapes = [("Somewhere", (city,)), (city, (city,)), (city, ("Stop",))]
                for twin in twins:
                    self.assertIn(twin, COUNTRIES)
                    shapes.append((twin, (city,)))
                    shapes.append(("Somewhere", (f"{city}, {twin}", city)))
                for destination, names in shapes:
                    with self.subTest(city=city, destination=destination, names=names, month=month):
                        self.assertIsNone(decide(destination, names, month).hemisphere)

    def test_the_transformers_hebrew_country_aliases_resolve_to_the_same_country(self) -> None:
        # Two tables spell the same Hebrew countries: the transformer's (for
        # currency/timezone) and this one (for climate). A spelling added to
        # one and not the other is a silent miss, so hold them together.
        for hebrew, english in _COUNTRY_ALIASES.items():
            with self.subTest(hebrew=hebrew):
                place = packing_climate.lookup(hebrew)
                self.assertIsNotNone(place, f"{hebrew!r} ({english}) unknown to packing_climate")
                self.assertEqual(english, place.country)

    def test_a_hebrew_preposition_is_dropped_only_for_an_exact_remainder(self) -> None:
        for text, key in (("לאיטליה", "italy"), ("בפורטוגל", "portugal"), ("ממדריד", "madrid"),
                          ("בברלין", "berlin"), ("לגרמניה", "germany"), ("לברלין", "berlin")):
            with self.subTest(text=text):
                self.assertEqual(key, packing_climate.lookup(text).key)
        # Names that merely start with ל/ב/מ resolve whole, never stripped.
        for text, key in (("ברלין", "berlin"), ("מדריד", "madrid"), ("לונדון", "london"),
                          ("מלבורן", "melbourne"), ("ליסבון", "lisbon")):
            with self.subTest(text=text):
                self.assertEqual(key, packing_climate.lookup(text).key)
        for text in ("טיול לאיטליה", "לאיטלי", "ב", "לל"):
            with self.subTest(text=text):
                self.assertIsNone(packing_climate.lookup(text))

    def test_a_substring_never_matches(self) -> None:
        # "peru" in "Perugia", "chile" in "Chilean Andes", "india" in "Indian Ocean".
        for text in ("Perugia", "Chilean Andes", "Indian Ocean", "Oman Air lounge", "Romeo"):
            with self.subTest(text=text):
                self.assertIsNone(packing_climate.lookup(text))

    def test_quote_variants_normalise_to_one_spelling(self) -> None:
        for text in ("צ׳ילה", "צ'ילה", "צ’ילה", "צילה"):
            with self.subTest(text=text):
                place = packing_climate.lookup(text)
                self.assertIsNotNone(place)
                self.assertEqual("chile", place.country)

    def test_the_resolver_cannot_reach_the_network(self) -> None:
        # Offline-safe by construction: provisioning with no network must give
        # an abstention, never an exception and never a wrong list. Holding the
        # imports to the standard library's text tools keeps it that way.
        import ast
        from pathlib import Path

        tree = ast.parse(Path(packing_climate.__file__).read_text(encoding="utf-8"))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        self.assertLessEqual(imported, {"__future__", "re", "unicodedata", "dataclasses", "typing"})

    def test_garbage_input_abstains_rather_than_raising(self) -> None:
        for destination in ("", ",,,", " and ", "()", "—", "ו", "\u200f"):
            for month in (None, 1):
                with self.subTest(destination=destination, month=month):
                    decision = decide(destination, (destination,), month)
                    self.assertIsNone(decision.hemisphere)
                    self.assertIn(decision.reason, REASONS)


if __name__ == "__main__":
    unittest.main()
