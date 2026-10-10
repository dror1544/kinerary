"""Where is this phase, and is its season knowable? -- the gate in front of
`phase.packing` (issue #167, widened 2026-09-25, reworked after two audits the
same day).

The owner's rule, verbatim: "Seasons and areas have to be treated right -- if
not sure, better not to say anything than be unreasonable." A packing list
that says "Warm jacket, Gloves" for Thailand in January is worse than no list:
the site already shows a generic one when `phase.packing` is absent. So this
module does not pick a season. It answers one question -- is a hemisphere x
month season bucket RELIABLE for this phase, in every month it covers? -- and
says either which hemisphere, or why not. The worst error it can make is a
hemisphere flip (winter items in summer), and most of what follows exists to
make a flip impossible rather than unlikely.

THE BUCKETS IT GATES (`season_bucket`; the items live in the transformer):
winter (Dec-Feb north) -> "Warm jacket, Layers, Gloves"; spring (Mar-May) ->
"Umbrella or rain jacket, Waterproof footwear"; summer (Jun-Aug) ->
"Sunscreen, Light breathable clothing, Sunglasses and a hat"; autumn
(Sep-Nov) -> "A light layer". Southern months are shifted by six.

ONLY A NAMED CITY EVER GETS A LIST. A country is never precise enough: every
country here is `varies` or worse, and a phase that names no place the table
knows -- "Stop", "Road trip", an unlisted town or island -- abstains, whatever
the destination says. There is no inheritance from the trip. (Until the
second audit a phase could inherit a "temperate" country, and a Faroe Islands
phase got Denmark's summer list at 11 C; an island the table has never heard
of is exactly the place nobody can be sure about.)

THE CRITERION. A CITY is temperate only if all of these hold. Its figures are
1991-2020-style monthly mean temperatures (C) as published in the Wikipedia
climate box for the place, recorded per city below so a reviewer can check
each one; they are approximate, which is why every month threshold carries a
0.5 C margin of doubt (MARGIN_C).

  1. Not arid and not tropical: Koppen group B abstains as `arid`; Koppen
     group A, or |latitude| < 23.5, abstains as `tropical` -- wet/dry seasons,
     not winter/summer.
  2. No dry season: Koppen second letter "f" (fully humid) only. "s" (dry
     summer, wet winter -- Mediterranean) abstains as `mediterranean`; "w"
     (dry winter, summer rain -- the East Asian monsoon, summer-rainfall
     highlands) abstains as `summer_rain`: the rain the spring list promises
     arrives in summer.
  3. A real winter and a real summer somewhere in the year: coldest-month
     mean <= 8.0 C (else `mild_winter`), warmest-month mean >= 14.0 C, and not
     Koppen E or a subpolar c/d type (else `subpolar`). A city failing these
     never gets a list, even in a month that would pass on its own (Sydney in
     January: recovering those is carry-forward, not built).
  4. MONTH BY MONTH -- every month the phase covers (start to end, at most
     twelve) must fall in ONE season bucket (else `spans_seasons`) and pass
     that bucket's test, margin included:
       winter  ("cold")      mean <= 7.5 C   else `mild_winter`
       summer  ("hot")       mean >= 14.5 C  else `cool_summer`
       spring  ("rainy")     mean >= 5.0 C   else `shoulder_month`
       autumn  ("moderate")  mean >= 5.0 C   else `shoulder_month`
     `shoulder_month` is the generalised form of the first rework's March /
     November rule: a spring or autumn month that is still winter (Quebec City
     in April, Montreal in November), where "Umbrella" or "A light layer" is
     unreasonable by omission.

WHAT `decide()` DOES WITH A TRIP. The phase's own names are read, FULL names
before shortened ones, and every name that places something must agree; a
partly placed name ("Auckland - Rarotonga") abstains. The destination is
used only to reject a phase that contradicts it, to confirm a namesake, and to
give a phase that names nothing an informative reason.

NAMESAKES. A city name that is also a well-known place in another country
(Perth is in Scotland, Toronto in New South Wales, Vienna in Virginia...) is
believed only when something confirms it: the trip's destination names the
city's country (as a country or region) and none of the twins' countries, or
the phase's own text anchors it ("Perth, Western Australia", "Christchurch,
NZ"). A city immediately followed by a region, territory or country of
ANOTHER country is demoted outright ("Naples, Florida"), and a bracketed
qualifier counts as that evidence ("Toronto (NSW)"); a bracketed phrase that
names no place is description and is ignored. NAMESAKES holds the twins
recorded so far: the tests check it against a separately written list of
known twins and fail if a temperate city in that list is missing here.
Neither list is complete; an unrecorded twin under a destination that names
no country is still believed.

TERRITORIES. Islands and territories whose climate differs from their
sovereign's (Faroe Islands, Greenland, Gibraltar, the Dutch Caribbean,
Mallorca, Sicily, Shetland...) are named in TERRITORIES so that they resolve
-- to their own reason, or to a conflict with a destination in another
country -- instead of reading as unknown. The list is what is covered, not
all that exists; since nothing inherits any more, an unlisted one simply
abstains as `unresolved`.

WHY A STATIC TABLE AND NOT THE GEOCODER. `enrichment.py` geocodes every phase
through Nominatim, but it runs AFTER `transform_intake()`, where this is
derived; wiring a second pass means editing the provisioner and enrichment,
which other work owns (#159, #161, #132). It is also a network call, and this
module must be deterministic and offline-safe. A latitude alone would not
answer criteria 2-4 anyway.

HOW A NAME RESOLVES. Exact match on a normalised segment, never a substring
("peru" is inside "Perugia"). Segments come from commas, slashes, "&",
dashes, colons and brackets, and -- only when a segment does not resolve whole
-- from "and" or a Hebrew vav prefix. A Hebrew preposition (ל/ב/מ: "לאיטליה",
"בפורטוגל", "ממדריד") is dropped only when what remains resolves exactly.
Quote marks are dropped, which covers every way Chile's geresh arrives.

EXTENDING THE TABLE. Add a city with its Koppen type and, if it is fully
humid and might pass criterion 3, all twelve monthly means; the regime is
COMPUTED (`classify`), never typed. Add a territory with the regime that makes
it abstain. The tests check latitude against hemisphere, that every temperate
city carries twelve months, and that no spelling is claimed twice.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable, Sequence

# --- climate regimes --------------------------------------------------------
TEMPERATE_NORTH = "temperate_north"
TEMPERATE_SOUTH = "temperate_south"
TROPICAL = "tropical"
ARID = "arid"
MEDITERRANEAN = "mediterranean"
SUMMER_RAIN = "summer_rain"
MILD_WINTER = "mild_winter"
COOL_SUMMER = "cool_summer"
SUBPOLAR = "subpolar"
VARIES = "varies"

# --- abstention reasons -----------------------------------------------------
NO_DATES = "no_dates"
NO_DESTINATION = "no_destination"
UNRESOLVED = "unresolved"
AMBIGUOUS_MULTI_PLACE = "ambiguous_multi_place"
CONFLICTS_WITH_DESTINATION = "conflicts_with_destination"
NAMESAKE = "namesake"
CLIMATE_VARIES_BY_AREA = "climate_varies_by_area"
SHOULDER_MONTH = "shoulder_month"
SPANS_SEASONS = "spans_seasons"

REASONS: frozenset[str] = frozenset({
    NO_DATES,
    NO_DESTINATION,
    UNRESOLVED,
    AMBIGUOUS_MULTI_PLACE,
    CONFLICTS_WITH_DESTINATION,
    NAMESAKE,
    CLIMATE_VARIES_BY_AREA,
    SHOULDER_MONTH,
    SPANS_SEASONS,
    # A place the table knows, in a regime -- or a month -- the season bucket
    # is wrong for.
    TROPICAL,
    ARID,
    MEDITERRANEAN,
    SUMMER_RAIN,
    MILD_WINTER,
    COOL_SUMMER,
    SUBPOLAR,
})

_HEMISPHERE = {TEMPERATE_NORTH: "north", TEMPERATE_SOUTH: "south"}
_TEMPERATE = frozenset(_HEMISPHERE)

# Criterion thresholds (see the module docstring).
TROPIC_LAT = 23.5
MAX_COLDEST_C = 8.0
MIN_WARMEST_C = 14.0
MAX_SHOULDER_C = 4.5
MARGIN_C = 0.5

_SUBPOLAR_KOPPEN = frozenset({"Cfc", "Csc", "Cwc", "Dfc", "Dfd", "Dsc", "Dsd", "Dwc", "Dwd"})


def season_bucket(month: int, hemisphere: str) -> str:
    """A coarse meteorological-season bucket for one calendar month in one
    hemisphere -- "cold"/"rainy"/"hot"/"moderate". Southern months are
    shifted by six to reuse the northern mapping: south's December is north's
    June, both summer."""
    if hemisphere == "south":
        month = (month + 5) % 12 + 1
    if month in (12, 1, 2):
        return "cold"
    if month in (3, 4, 5):
        return "rainy"
    if month in (6, 7, 8):
        return "hot"
    return "moderate"


def month_verdict(mean: float, bucket: str) -> str | None:
    """Criterion 4 for one month: None if the bucket's list is reasonable at
    this monthly mean, else the reason it is not."""
    if bucket == "cold":
        return None if mean <= MAX_COLDEST_C - MARGIN_C else MILD_WINTER
    if bucket == "hot":
        return None if mean >= MIN_WARMEST_C + MARGIN_C else COOL_SUMMER
    return None if mean >= MAX_SHOULDER_C + MARGIN_C else SHOULDER_MONTH


def classify(lat: float, koppen: str, coldest: float | None, warmest: float | None) -> str:
    """Criteria 1-3, as code. Order matters only for which reason is given;
    every branch but the last abstains."""
    group = koppen[:1]
    if group == "B":
        return ARID
    if group == "A" or abs(lat) < TROPIC_LAT:
        return TROPICAL
    if group == "E" or koppen in _SUBPOLAR_KOPPEN:
        return SUBPOLAR
    if koppen[1:2] == "s":
        return MEDITERRANEAN
    if koppen[1:2] == "w":
        return SUMMER_RAIN
    if coldest is None or warmest is None:
        raise ValueError(f"a fully humid {koppen} place needs its temperatures")
    if coldest > MAX_COLDEST_C:
        return MILD_WINTER
    if warmest < MIN_WARMEST_C:
        return SUBPOLAR
    return TEMPERATE_NORTH if lat > 0 else TEMPERATE_SOUTH


# Country key -> (regime, other spellings). Keys are the English names the
# transformer's currency/timezone tables use ("usa", "uk"); the Hebrew
# spellings of `transformer._COUNTRY_ALIASES` must resolve here to the same
# key (tested). No country is temperate: the ones whose every region the
# first rework judged temperate are `varies` too now, because a country is
# never a place whose twelve months are known (see the module docstring).
# The non-temperate labels below only choose the REASON a bare country gives.
N, S, T, A, M, W, MW, CS, SP, V = (
    TEMPERATE_NORTH, TEMPERATE_SOUTH, TROPICAL, ARID, MEDITERRANEAN, SUMMER_RAIN,
    MILD_WINTER, COOL_SUMMER, SUBPOLAR, VARIES,
)
_COUNTRY_TABLE: dict[str, tuple[str, tuple[str, ...]]] = {
    # varies -- a country does not say which of its climates the trip is in
    "germany": (V, ("deutschland", "גרמניה")),
    "uk": (V, ("united kingdom", "great britain", "britain", "england", "scotland", "wales",
               "northern ireland", "אנגליה", "בריטניה", "אנגליה ובריטניה", "סקוטלנד",
               "הממלכה המאוחדת")),
    "ireland": (V, ("אירלנד",)),
    "netherlands": (V, ("holland", "הולנד")),
    "belgium": (V, ("בלגיה",)),
    "luxembourg": (V, ("לוקסמבורג",)),
    "czechia": (V, ("czech republic", "צכיה")),
    "poland": (V, ("פולין",)),
    "hungary": (V, ("הונגריה",)),
    "slovenia": (V, ("סלובניה",)),
    "denmark": (V, ("דנמרק",)),
    "romania": (V, ("רומניה",)),
    "bulgaria": (V, ("בולגריה",)),
    "italy": (V, ("italia", "איטליה")),
    "france": (V, ("צרפת",)),
    "spain": (V, ("espana", "ספרד")),
    "portugal": (V, ("פורטוגל",)),
    "greece": (V, ("hellas", "יוון")),
    "croatia": (V, ("קרואטיה",)),
    "montenegro": (V, ("מונטנגרו",)),
    "switzerland": (V, ("שווייץ", "שוויץ")),
    "austria": (V, ("אוסטריה",)),
    "slovakia": (V, ("סלובקיה",)),
    "new zealand": (V, ("aotearoa", "nz", "ניו זילנד")),
    "usa": (V, ("us", "united states", "united states of america", "america",
                "ארצות הברית", "ארהב", "אמריקה")),
    "canada": (V, ("קנדה",)),
    "mexico": (V, ("מקסיקו",)),
    "china": (V, ("סין",)),
    "india": (V, ("הודו",)),
    "russia": (V, ("רוסיה",)),
    "brazil": (V, ("ברזיל",)),
    "argentina": (V, ("ארגנטינה",)),
    "chile": (V, ("צילה",)),
    "australia": (V, ("aus", "אוסטרליה")),
    "japan": (V, ("nippon", "יפן")),
    "south africa": (V, ("דרום אפריקה",)),
    "turkey": (V, ("turkiye", "טורקיה")),
    "norway": (V, ("נורווגיה", "נורבגיה")),
    "sweden": (V, ("שוודיה",)),
    "finland": (V, ("פינלנד",)),
    "israel": (V, ("ישראל",)),
    "morocco": (V, ("מרוקו",)),
    # tropical -- the whole country lies inside the tropics
    "thailand": (T, ("תאילנד",)),
    "vietnam": (T, ("viet nam", "וייטנאם", "ויאטנם", "ויטנאם")),
    "cambodia": (T, ("קמבודיה",)),
    "laos": (T, ("לאוס",)),
    "philippines": (T, ("פיליפינים", "הפיליפינים")),
    "indonesia": (T, ("אינדונזיה",)),
    "malaysia": (T, ("מלזיה",)),
    "singapore": (T, ("סינגפור",)),
    "sri lanka": (T, ("סרי לנקה",)),
    "maldives": (T, ("מלדיביים", "האיים המלדיביים")),
    "peru": (T, ("פרו",)),         # 0-18.5 S: wet/dry seasons, and altitude, not month
    "bolivia": (T, ("בוליביה",)),
    "ecuador": (T, ("אקוודור",)),
    "colombia": (T, ("קולומביה",)),
    "costa rica": (T, ("קוסטה ריקה",)),
    "panama": (T, ("פנמה",)),
    "cuba": (T, ("קובה",)),
    "dominican republic": (T, ("הרפובליקה הדומיניקנית",)),
    "jamaica": (T, ("גמייקה",)),
    "trinidad and tobago": (T, ()),
    "kenya": (T, ("קניה",)),
    "tanzania": (T, ("טנזניה",)),
    "fiji": (T, ("פיגי",)),
    "seychelles": (T, ("סיישל",)),
    "mauritius": (T, ("מאוריציוס",)),
    # the rest of the criterion, country-wide
    "south korea": (W, ("korea", "republic of korea", "דרום קוריאה", "קוריאה")),  # Dwa/Cwa
    "paraguay": (MW, ("פרגוואי",)),
    "uruguay": (MW, ("אורוגוואי",)),          # Montevideo 10.9 C July
    "taiwan": (MW, ("טייוואן",)),
    "malta": (M, ("מלטה",)),
    "cyprus": (M, ("קפריסין",)),
    "uae": (A, ("united arab emirates", "emirates", "איחוד האמירויות", "האמירויות",
                "איחוד האמירויות הערביות")),
    "egypt": (A, ("מצרים",)),
    "jordan": (A, ("ירדן",)),
    "qatar": (A, ("קטאר",)),
    "oman": (A, ("עומאן",)),
    "namibia": (A, ("נמיביה",)),
    "iceland": (SP, ("איסלנד",)),
}

COUNTRIES: dict[str, str] = {key: regime for key, (regime, _names) in _COUNTRY_TABLE.items()}


@dataclass(frozen=True)
class City:
    """One place, with the figures the criterion reads.

    `months` -- twelve monthly mean temperatures (C), January first -- is
    required for any fully humid city that passes criterion 3 (the tests
    enforce it). A fully humid city that fails criterion 3 outright may give
    only `lo`/`hi` (coldest/warmest monthly mean); other climates need no
    figures, their Koppen type decides."""

    country: str
    lat: float
    koppen: str
    months: tuple[float, ...] | None = None
    names: tuple[str, ...] = ()
    lo: float | None = None
    hi: float | None = None
    regime: str = field(init=False)

    def __post_init__(self) -> None:
        coldest, warmest = self.lo, self.hi
        if self.months is not None:
            if len(self.months) != 12:
                raise ValueError("twelve monthly means, January first")
            coldest, warmest = min(self.months), max(self.months)
        object.__setattr__(self, "regime", classify(self.lat, self.koppen, coldest, warmest))


def C(country: str, lat: float, koppen: str, months: Sequence[float] | None = None,
      names: tuple[str, ...] = (), lo: float | None = None, hi: float | None = None) -> City:
    return City(country, lat, koppen, tuple(months) if months else None, names, lo, hi)


CITIES: dict[str, City] = {
    # Japan (Honshu Cfa). Hakone, Nikko (its figures depend on the station),
    # Hokkaido and Sapporo are deliberately absent: they abstain as unknown.
    "tokyo": C("japan", 35.7, "Cfa", (5.4, 6.1, 9.4, 14.3, 18.8, 21.9, 25.7, 26.9, 23.3, 18.0, 12.5, 7.7), ("טוקיו",)),
    "kyoto": C("japan", 35.0, "Cfa", (4.8, 5.4, 9.0, 14.9, 19.9, 23.6, 27.3, 28.5, 24.4, 18.4, 12.5, 7.2), ("קיוטו",)),
    "osaka": C("japan", 34.7, "Cfa", (6.2, 6.6, 9.8, 15.3, 20.2, 23.8, 27.7, 29.0, 25.2, 19.5, 13.8, 8.7), ("אוסקה", "אוסאקה")),
    "nara": C("japan", 34.7, "Cfa", (4.0, 4.6, 7.9, 13.6, 18.6, 22.3, 26.1, 27.0, 22.9, 16.9, 11.0, 6.2), ("נארה",)),
    "hiroshima": C("japan", 34.4, "Cfa", (5.4, 6.2, 9.4, 14.8, 19.5, 23.2, 27.1, 28.5, 24.7, 18.8, 12.9, 7.6), ("הירושימה",)),
    "nagoya": C("japan", 35.2, "Cfa", (4.8, 5.5, 9.2, 14.6, 19.4, 23.0, 26.9, 28.2, 24.5, 18.6, 12.6, 7.2)),
    "yokohama": C("japan", 35.4, "Cfa", (6.1, 6.7, 9.7, 14.6, 18.9, 22.1, 25.8, 27.2, 23.9, 18.6, 13.4, 8.6)),
    "kamakura": C("japan", 35.3, "Cfa", (6.0, 6.6, 9.6, 14.5, 18.8, 22.0, 25.7, 27.0, 23.8, 18.5, 13.4, 8.5)),
    "kanazawa": C("japan", 36.6, "Cfa", (4.0, 4.1, 7.1, 12.4, 17.4, 21.4, 25.6, 27.3, 23.2, 17.6, 11.9, 6.9)),
    "takayama": C("japan", 36.1, "Dfa", (-1.4, -0.8, 3.0, 9.4, 14.8, 19.1, 23.0, 24.2, 19.8, 12.9, 6.6, 1.3)),
    "okinawa": C("japan", 26.2, "Cfa", names=("אוקינאווה",), lo=17.0, hi=29.1),
    "naha": C("japan", 26.2, "Cfa", lo=17.0, hi=29.1),
    "ishigaki": C("japan", 24.3, "Af"),
    # Korea, China
    "seoul": C("south korea", 37.6, "Dwa", names=("סיאול",)),
    "busan": C("south korea", 35.2, "Cwa"),
    "beijing": C("china", 39.9, "Dwa", names=("בייגינג",)),
    "shanghai": C("china", 31.2, "Cfa", (4.8, 6.4, 10.1, 15.4, 20.4, 24.1, 28.6, 28.3, 24.6, 19.5, 13.8, 7.5), ("שנגחאי",)),
    "hong kong": C("china", 22.3, "Cwa", names=("הונג קונג",)),
    # USA
    "new york": C("usa", 40.7, "Cfa", (0.9, 1.9, 5.7, 11.5, 17.1, 22.4, 25.3, 24.7, 20.9, 14.8, 9.2, 3.7),
                  ("new york city", "nyc", "manhattan", "ניו יורק")),
    "boston": C("usa", 42.4, "Dfa", (-1.5, -0.6, 3.3, 8.8, 14.3, 19.7, 23.1, 22.4, 18.5, 12.3, 6.8, 1.9), ("בוסטון",)),
    "washington dc": C("usa", 38.9, "Cfa", (2.4, 3.9, 8.1, 13.8, 19.1, 24.3, 26.9, 26.0, 22.1, 15.7, 9.8, 4.5), ("dc",)),
    "chicago": C("usa", 41.9, "Dfa", (-3.2, -1.2, 4.4, 10.5, 16.6, 22.2, 24.8, 23.9, 19.9, 12.9, 5.8, -0.3), ("שיקגו",)),
    "philadelphia": C("usa", 40.0, "Cfa", (1.1, 2.4, 6.6, 12.6, 18.1, 23.4, 26.2, 25.3, 21.5, 15.1, 9.2, 3.9)),
    "seattle": C("usa", 47.6, "Csb", names=("סיאטל",)),
    "los angeles": C("usa", 34.1, "Csb", names=("לוס אנגלס",)),
    "san diego": C("usa", 32.7, "BSh"),
    "miami": C("usa", 25.8, "Am", names=("מיאמי",)),
    "orlando": C("usa", 28.5, "Cfa", names=("אורלנדו",), lo=16.0, hi=28.2),
    "new orleans": C("usa", 30.0, "Cfa", lo=11.9, hi=28.4),
    "houston": C("usa", 29.8, "Cfa", lo=11.8, hi=29.6),
    "las vegas": C("usa", 36.2, "BWh", names=("לאס וגאס",)),
    "phoenix": C("usa", 33.4, "BWh"),
    "honolulu": C("usa", 21.3, "As"),
    "maui": C("usa", 20.8, "As"),
    # Canada
    "toronto": C("canada", 43.7, "Dfa", (-3.7, -2.6, 1.4, 7.9, 14.1, 19.4, 22.3, 21.5, 17.2, 10.7, 4.9, -0.5), ("טורונטו",)),
    "montreal": C("canada", 45.5, "Dfb", (-9.7, -8.2, -2.5, 6.4, 13.4, 18.6, 21.2, 20.1, 15.5, 8.8, 2.4, -5.3), ("מונטריאול",)),
    "vancouver": C("canada", 49.3, "Csb", names=("ונקובר",)),
    "quebec city": C("canada", 46.8, "Dfb", (-12.8, -11.1, -4.8, 3.3, 10.8, 16.3, 19.3, 18.1, 13.0, 6.3, -0.4, -8.4)),
    "ottawa": C("canada", 45.4, "Dfb", (-10.3, -8.4, -2.4, 6.3, 13.4, 18.6, 21.2, 19.9, 15.1, 8.5, 1.9, -5.8)),
    # Mexico, Caribbean
    "mexico city": C("mexico", 19.4, "Cwb", names=("cdmx", "מקסיקו סיטי")),
    "cancun": C("mexico", 21.2, "Aw", names=("קנקון",)),
    "tulum": C("mexico", 20.2, "Aw"),
    "playa del carmen": C("mexico", 20.6, "Aw"),
    "havana": C("cuba", 23.1, "Aw", names=("habana", "הוואנה")),
    # South America. Cartagena is absent: Cartagena, Spain is the twin.
    "lima": C("peru", -12.0, "BWh", names=("לימה",)),
    "cusco": C("peru", -13.5, "Cwb", names=("cuzco", "קוסקו")),
    "machu picchu": C("peru", -13.2, "Cwb", names=("מאצו פיצו",)),
    "bogota": C("colombia", 4.7, "Cfb"),
    "medellin": C("colombia", 6.2, "Af"),
    "rio de janeiro": C("brazil", -22.9, "Aw", names=("ריו דה זניירו",)),
    "salvador": C("brazil", -13.0, "Af"),
    "manaus": C("brazil", -3.1, "Af"),
    "sao paulo": C("brazil", -23.55, "Cfa", names=("סאו פאולו",), lo=16.0, hi=22.6),
    "florianopolis": C("brazil", -27.6, "Cfa", lo=16.5, hi=25.0),
    "foz do iguacu": C("brazil", -25.5, "Cfa", lo=15.0, hi=26.5),
    "buenos aires": C("argentina", -34.6, "Cfa", names=("בואנוס איירס",), lo=11.0, hi=24.9),
    "mendoza": C("argentina", -32.9, "BWk", names=("מנדוסה",)),
    "bariloche": C("argentina", -41.1, "Csb", names=("ברילוצה",)),
    "iguazu": C("argentina", -25.7, "Cfa", names=("iguazu falls", "איגואסו"), lo=15.0, hi=26.5),
    "salta": C("argentina", -24.8, "Cwb"),
    "ushuaia": C("argentina", -54.8, "Cfc", names=("אושואיה",)),
    "el calafate": C("argentina", -50.3, "BSk"),
    "santiago de chile": C("chile", -33.4, "Csb", names=("סנטיאגו דה צילה",)),
    "valparaiso": C("chile", -33.0, "Csb", names=("ולפראיסו",)),
    "san pedro de atacama": C("chile", -22.9, "BWk", names=("atacama",)),
    "punta arenas": C("chile", -53.2, "Cfc"),
    "puerto natales": C("chile", -51.7, "Cfc"),
    "torres del paine": C("chile", -51.0, "Cfc"),
    "montevideo": C("uruguay", -34.9, "Cfa", lo=10.9, hi=22.9),
    # Europe. Florence is on the Cfa/Csa border (Peretola ~7 C January, a dry
    # July) -- not sure, so it is typed Csa and abstains.
    "rome": C("italy", 41.9, "Csa", names=("roma", "רומא")),
    "milan": C("italy", 45.5, "Cfa", (2.9, 4.6, 8.9, 12.8, 17.5, 21.8, 24.2, 23.6, 19.2, 13.9, 8.0, 3.6), ("milano", "מילאנו")),
    "florence": C("italy", 43.8, "Csa", names=("firenze", "פירנצה")),
    "venice": C("italy", 45.4, "Cfa", (3.3, 4.9, 8.6, 12.6, 17.3, 21.2, 23.6, 23.1, 19.0, 14.0, 8.8, 4.3), ("venezia", "ונציה")),
    "naples": C("italy", 40.9, "Csa", names=("napoli", "נאפולי")),
    "bologna": C("italy", 44.5, "Cfa", (2.9, 4.9, 9.4, 13.3, 18.2, 22.4, 25.3, 24.8, 20.3, 14.8, 8.8, 3.9)),
    "paris": C("france", 48.9, "Cfb", (5.0, 5.6, 8.8, 11.5, 15.2, 18.3, 20.5, 20.3, 16.9, 13.0, 8.3, 5.5), ("פריז",)),
    "nice": C("france", 43.7, "Csa", names=("ניס",)),
    "lyon": C("france", 45.8, "Cfb", (3.4, 4.6, 8.5, 11.6, 15.6, 19.4, 22.2, 21.7, 17.7, 13.3, 7.8, 4.3), ("ליון",)),
    "london": C("uk", 51.5, "Cfb", (5.2, 5.3, 7.6, 9.9, 13.3, 16.5, 18.7, 18.5, 15.7, 12.0, 8.0, 5.5), ("לונדון",)),
    "edinburgh": C("uk", 55.95, "Cfb", (4.2, 4.5, 5.9, 7.9, 10.6, 13.3, 15.3, 15.1, 13.1, 10.1, 6.6, 4.3), ("אדינבורו",)),
    "dublin": C("ireland", 53.3, "Cfb", (5.3, 5.5, 6.8, 8.4, 10.9, 13.6, 15.6, 15.3, 13.6, 10.8, 7.5, 5.8), ("דבלין",)),
    "amsterdam": C("netherlands", 52.4, "Cfb", (3.4, 3.6, 6.1, 9.3, 13.1, 15.6, 17.9, 17.7, 14.6, 10.9, 7.0, 4.2), ("אמסטרדם",)),
    "brussels": C("belgium", 50.8, "Cfb", (3.3, 3.7, 6.8, 9.8, 13.6, 16.2, 18.4, 18.0, 14.9, 11.1, 7.0, 3.9), ("בריסל",)),
    "berlin": C("germany", 52.5, "Cfb", (0.6, 1.4, 4.8, 9.3, 14.2, 17.5, 19.8, 19.3, 15.1, 10.0, 5.2, 1.6), ("ברלין",)),
    "munich": C("germany", 48.1, "Cfb", (-0.5, 0.8, 4.4, 8.9, 13.3, 16.9, 18.9, 18.4, 14.3, 9.4, 4.1, 0.6), ("munchen", "מינכן")),
    "vienna": C("austria", 48.2, "Cfb", (0.3, 1.9, 6.0, 11.3, 16.0, 19.4, 21.6, 21.2, 16.4, 10.9, 5.5, 1.5), ("wien", "וינה")),
    "prague": C("czechia", 50.1, "Cfb", (-0.7, 0.4, 3.9, 9.0, 13.8, 17.2, 19.2, 18.8, 14.5, 9.2, 4.2, 0.4), ("praha", "פראג")),
    "budapest": C("hungary", 47.5, "Cfa", (0.4, 2.2, 6.6, 12.1, 16.9, 20.4, 22.4, 22.0, 17.3, 11.5, 6.1, 1.3), ("בודפשט",)),
    "zurich": C("switzerland", 47.4, "Cfb", (0.3, 1.2, 4.9, 8.6, 13.0, 16.6, 18.6, 18.1, 14.2, 9.9, 4.6, 1.3), ("ציריך",)),
    "geneva": C("switzerland", 46.2, "Cfb", (1.5, 2.4, 6.1, 9.8, 14.1, 17.8, 20.2, 19.6, 15.8, 11.4, 5.8, 2.6), ("geneve", "זנבה")),
    "barcelona": C("spain", 41.4, "Csa", names=("ברצלונה",)),
    "madrid": C("spain", 40.4, "Csa", names=("מדריד",)),
    "seville": C("spain", 37.4, "Csa", names=("sevilla", "סביליה")),
    "lisbon": C("portugal", 38.7, "Csa", names=("lisboa", "ליסבון")),
    "porto": C("portugal", 41.1, "Csb", names=("פורטו",)),
    "athens": C("greece", 38.0, "Csa", names=("אתונה",)),
    "copenhagen": C("denmark", 55.7, "Cfb", (1.4, 1.1, 2.9, 7.0, 11.5, 15.1, 17.5, 17.2, 13.6, 9.6, 5.5, 2.7), ("קופנהגן",)),
    "krakow": C("poland", 50.1, "Dfb", (-2.0, -0.6, 3.1, 8.9, 14.1, 17.4, 19.3, 18.7, 13.9, 8.7, 3.7, -0.7), ("קרקוב",)),
    "warsaw": C("poland", 52.2, "Dfb", (-1.8, -0.6, 2.8, 8.7, 14.2, 17.0, 19.3, 18.7, 13.7, 8.5, 3.3, -0.8), ("ורשה",)),
    "stockholm": C("sweden", 59.3, "Dfb", (-1.6, -1.8, 0.7, 5.8, 11.2, 15.8, 18.0, 17.2, 12.7, 7.4, 3.3, 0.3), ("שטוקהולם",)),
    "oslo": C("norway", 59.9, "Dfb", (-4.3, -4.0, -0.2, 4.5, 10.8, 15.2, 16.4, 15.2, 10.8, 5.3, 0.3, -3.1), ("אוסלו",)),
    "helsinki": C("finland", 60.2, "Dfb", (-3.9, -4.7, -1.3, 4.1, 10.3, 14.9, 17.8, 16.6, 11.8, 6.4, 1.9, -1.4), ("הלסינקי",)),
    "istanbul": C("turkey", 41.0, "Csa", names=("איסטנבול",)),
    "reykjavik": C("iceland", 64.1, "Cfc", names=("רייקיאוויק",)),
    # Atlantic islands of Spain and Portugal
    "canary islands": C("spain", 28.3, "BWh", names=(
        "canaries", "האיים הקנריים", "santa cruz de tenerife", "la palma", "la gomera",
        "el hierro", "maspalomas", "costa adeje", "playa de las americas",
        "puerto de la cruz", "טנריפה")),
    "tenerife": C("spain", 28.3, "BWh", names=("טנריף",)),
    "gran canaria": C("spain", 28.0, "BWh"),
    "lanzarote": C("spain", 29.0, "BWh"),
    "fuerteventura": C("spain", 28.4, "BWh"),
    "las palmas": C("spain", 28.1, "BWh"),
    "madeira": C("portugal", 32.7, "Csa", names=("מדירה", "funchal")),
    "azores": C("portugal", 37.7, "Cfb", names=("האיים האזוריים",), lo=14.0, hi=22.5),
    # Middle East, Africa
    "tel aviv": C("israel", 32.1, "Csa", names=("תל אביב",)),
    "eilat": C("israel", 29.6, "BWh", names=("אילת",)),
    "dubai": C("uae", 25.2, "BWh", names=("דובאי",)),
    "abu dhabi": C("uae", 24.5, "BWh", names=("אבו דאבי",)),
    "cairo": C("egypt", 30.0, "BWh", names=("קהיר",)),
    "luxor": C("egypt", 25.7, "BWh"),
    "petra": C("jordan", 30.3, "BSk", names=("פטרה",)),
    "marrakech": C("morocco", 31.6, "BSh", names=("marrakesh", "מרקש")),
    "cape town": C("south africa", -33.9, "Csb", names=("קייפטאון", "קייפ טאון")),
    "johannesburg": C("south africa", -26.2, "Cwb", names=("יוהנסבורג",)),
    "durban": C("south africa", -29.9, "Cfa", lo=16.9, hi=24.4),
    "kruger": C("south africa", -24.0, "BSh", names=("kruger national park",)),
    # South and Southeast Asia
    "delhi": C("india", 28.6, "Cwa", names=("new delhi", "דלהי")),
    "mumbai": C("india", 19.1, "Aw", names=("מומבאי",)),
    "goa": C("india", 15.5, "Am", names=("גואה",)),
    "bangkok": C("thailand", 13.8, "Aw", names=("בנגקוק",)),
    "phuket": C("thailand", 7.9, "Am", names=("פוקט",)),
    "chiang mai": C("thailand", 18.8, "Aw", names=("ציאנג מאי",)),
    "koh samui": C("thailand", 9.5, "Af", names=("קו סמוי",)),
    "hanoi": C("vietnam", 21.0, "Cwa", names=("האנוי",)),
    "ho chi minh city": C("vietnam", 10.8, "Aw", names=("saigon", "סייגון")),
    "da nang": C("vietnam", 16.1, "Am"),
    "hoi an": C("vietnam", 15.9, "Am"),
    "bali": C("indonesia", -8.3, "Af", names=("באלי",)),
    "jakarta": C("indonesia", -6.2, "Am"),
    "manila": C("philippines", 14.6, "Aw"),
    # Australia, New Zealand (southern months: January is summer)
    "sydney": C("australia", -33.9, "Cfa", names=("סידני",), lo=12.5, hi=23.2),
    "melbourne": C("australia", -37.8, "Cfb", names=("מלבורן",), lo=10.3, hi=20.8),
    "adelaide": C("australia", -34.9, "Csa"),
    "perth": C("australia", -31.9, "Csa", names=("פרת",)),
    "hobart": C("australia", -42.9, "Cfb", lo=8.3, hi=17.3),
    "canberra": C("australia", -35.3, "Cfb", (20.9, 20.3, 17.9, 13.4, 9.5, 6.8, 5.8, 7.1, 9.6, 12.7, 15.9, 18.9), ("קנברה",)),
    "brisbane": C("australia", -27.5, "Cfa", names=("בריסביין",), lo=15.3, hi=25.8),
    "gold coast": C("australia", -28.0, "Cfa", lo=16.0, hi=25.0),
    "cairns": C("australia", -16.9, "Am"),
    "darwin": C("australia", -12.5, "Aw"),
    "auckland": C("new zealand", -36.8, "Cfb", names=("אוקלנד",), lo=10.9, hi=19.8),
    "wellington": C("new zealand", -41.3, "Cfb", lo=8.6, hi=16.9),
    "christchurch": C("new zealand", -43.5, "Cfb", (17.4, 17.1, 15.3, 12.4, 9.4, 6.9, 6.1, 7.2, 9.2, 11.5, 13.5, 15.7), ("קרייסטצרץ",)),
    "queenstown": C("new zealand", -45.0, "Cfb", (15.8, 15.6, 13.1, 9.6, 6.1, 3.2, 2.6, 4.4, 7.4, 9.5, 11.6, 14.0), ("קווינסטאון",)),
}

# City -> the OTHER countries where the same name is a well-known place. Such
# a city is believed only when something confirms it (see `_confirmed`). What
# this guarantees: every twin recorded here is enforced, and the tests fail if
# a temperate city on their separately written list of known twins is
# missing. It does NOT guarantee that every twin in the world is recorded.
NAMESAKES: dict[str, frozenset[str]] = {
    "perth": frozenset({"uk", "canada"}),
    "sydney": frozenset({"canada"}),
    "melbourne": frozenset({"usa"}),
    "wellington": frozenset({"usa", "uk"}),
    "christchurch": frozenset({"uk"}),
    "queenstown": frozenset({"australia", "south africa"}),
    "naples": frozenset({"usa"}),
    "athens": frozenset({"usa"}),
    "rome": frozenset({"usa"}),
    "paris": frozenset({"usa", "canada"}),
    "florence": frozenset({"usa"}),
    "venice": frozenset({"usa"}),
    "dublin": frozenset({"usa"}),
    "london": frozenset({"canada"}),
    "vancouver": frozenset({"usa"}),
    "berlin": frozenset({"usa"}),
    "madrid": frozenset({"usa"}),
    "lisbon": frozenset({"usa"}),
    "cairo": frozenset({"usa"}),
    "valparaiso": frozenset({"usa"}),
    "geneva": frozenset({"usa"}),
    "delhi": frozenset({"usa", "canada"}),
    "hobart": frozenset({"usa"}),
    "lima": frozenset({"usa"}),
    "amsterdam": frozenset({"usa"}),
    "havana": frozenset({"usa"}),
    # added after the second audit
    "toronto": frozenset({"australia", "usa"}),     # Toronto, New South Wales; Ohio
    "edinburgh": frozenset({"australia"}),          # Edinburgh, South Australia
    "vienna": frozenset({"usa"}),                   # Vienna, Virginia
    "boston": frozenset({"uk"}),                    # Boston, Lincolnshire
    "milan": frozenset({"usa"}),
    "warsaw": frozenset({"usa"}),
    "prague": frozenset({"usa"}),
    "budapest": frozenset({"usa"}),
    "stockholm": frozenset({"usa"}),
    "oslo": frozenset({"usa"}),
    "ottawa": frozenset({"usa"}),
}


@dataclass(frozen=True)
class Region:
    country: str
    regime: str
    names: tuple[str, ...] = ()


# Regions -- here so a namesake city can be told apart ("Naples, Florida"), and
# so a name next to one is anchored. Georgia is absent on purpose: it is also a
# country.
_VARIES_REGIONS: dict[str, tuple[str, ...]] = {
    "usa": (
        "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
        "connecticut", "delaware", "idaho", "illinois", "indiana", "iowa", "kansas",
        "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
        "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
        "new hampshire", "new jersey", "new mexico", "new york state", "north carolina",
        "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island",
        "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
        "virginia", "washington", "west virginia", "wisconsin", "wyoming",
        "קליפורניה", "טקסס", "נבדה", "אריזונה", "יוטה", "קולורדו", "אלסקה",
    ),
    "canada": (
        "ontario", "quebec", "british columbia", "alberta", "nova scotia", "manitoba",
        "saskatchewan", "new brunswick", "newfoundland", "prince edward island", "yukon",
    ),
    "australia": (
        "victoria", "western australia", "south australia", "northern territory",
    ),
}
REGIONS: dict[str, Region] = {
    name: Region(country, V) for country, names in _VARIES_REGIONS.items() for name in names
}
REGIONS["new south wales"] = Region("australia", V, ("nsw",))
REGIONS["queensland"] = Region("australia", V, ("qld",))
REGIONS["tasmania"] = Region("australia", V, ("טסמניה",))   # Hobart 8.3 C July; highlands
REGIONS["hawaii"] = Region("usa", T, ("הוואי",))
REGIONS["florida"] = Region("usa", MW, ("פלורידה",))

# Territories and islands whose climate is not their sovereign's. Every one
# abstains (tested); being here makes the name RESOLVE -- to its own reason,
# or to a conflict with a destination in another country. This is the list
# that is covered, not every such place; an unlisted one abstains as
# `unresolved`.
TERRITORIES: dict[str, Region] = {
    # Denmark
    "faroe islands": Region("denmark", SP, ("faroes", "torshavn", "איי פארו")),
    "greenland": Region("denmark", SP, ("nuuk", "גרינלנד")),
    # United Kingdom, Crown dependencies and overseas territories
    "shetland": Region("uk", SP, ("shetland islands", "lerwick")),                # ~12.3 C July
    "orkney": Region("uk", CS, ("orkney islands", "kirkwall")),                    # ~13 C July
    "hebrides": Region("uk", CS, ("outer hebrides", "inner hebrides", "western isles",
                                  "isle of skye", "skye", "stornoway", "portree")),  # ~13.5 C July
    "isle of man": Region("uk", CS),                                                # ~13.3 C June
    "channel islands": Region("uk", MW, ("jersey", "guernsey", "alderney", "sark")),
    "isles of scilly": Region("uk", MW, ("scilly",)),                              # 8.9 C January
    "gibraltar": Region("uk", M, ("גיברלטר",)),
    "falkland islands": Region("uk", SP, ("falklands", "איי פוקלנד")),             # south, ~9 C January
    "bermuda": Region("uk", MW, ("ברמודה",)),
    # Netherlands (the Caribbean)
    "aruba": Region("netherlands", T, ("ארובה",)),
    "curacao": Region("netherlands", T, ("קוראסאו",)),
    "bonaire": Region("netherlands", T),
    "sint maarten": Region("netherlands", T, ("st maarten", "saint martin")),
    "saba": Region("netherlands", T),
    "sint eustatius": Region("netherlands", T, ("statia",)),
    # Spain, France, Italy, Greece (Mediterranean islands)
    "mallorca": Region("spain", M, ("majorca", "palma de mallorca", "מיורקה")),
    "menorca": Region("spain", M, ("minorca",)),
    "ibiza": Region("spain", M, ("eivissa", "איביזה")),
    "formentera": Region("spain", M),
    "balearic islands": Region("spain", M, ("balearics", "האיים הבלאריים")),
    "corsica": Region("france", M, ("corse", "ajaccio", "קורסיקה")),
    "sardinia": Region("italy", M, ("sardegna", "cagliari", "סרדיניה")),
    "sicily": Region("italy", M, ("sicilia", "palermo", "taormina", "catania", "סיציליה")),
    "crete": Region("greece", M, ("heraklion", "chania", "כרתים")),
    "rhodes": Region("greece", M, ("רודוס",)),
    "santorini": Region("greece", M, ("סנטוריני",)),
    "mykonos": Region("greece", M, ("מיקונוס",)),
    # France overseas
    "reunion": Region("france", T, ("la reunion",)),
    "martinique": Region("france", T),
    "guadeloupe": Region("france", T),
    "french polynesia": Region("france", T, ("tahiti", "bora bora")),
    "new caledonia": Region("france", T),
    # Norway, Finland (Arctic)
    "svalbard": Region("norway", SP, ("longyearbyen", "spitsbergen")),
    "tromso": Region("norway", SP),
    "rovaniemi": Region("finland", SP, ("lapland",)),
    # USA
    "puerto rico": Region("usa", T, ("פוארטו ריקו",)),
    "guam": Region("usa", T),
    "us virgin islands": Region("usa", T),
    # China
    "macau": Region("china", T, ("macao",)),
}


# --- normalisation and lookup -----------------------------------------------

@dataclass(frozen=True)
class Place:
    key: str
    country: str
    regime: str
    level: str  # "country" | "region" | "city" (territories are regions)
    months: tuple[float, ...] | None = None


# Quote-like marks that arrive inside names: ASCII ' " `, Hebrew geresh and
# gershayim, typographic quotes, acute accent; plus full stops ("U.S.A."),
# and invisible direction/zero-width marks copied along with Hebrew text.
_DROP = {ord(ch): None for ch in "'\"`\u05f3\u05f4\u2018\u2019\u201a\u201b\u201c\u201d\u00b4.\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u2066\u2067\u2068\u2069"}


def normalise(text: object) -> str:
    """Case, accents, niqqud, quote marks and hyphens folded away; whitespace
    collapsed. "São Paulo" -> "sao paulo", "צ׳ילה" -> "צילה", "U.S.A." -> "usa"."""
    decomposed = unicodedata.normalize("NFKD", "" if text is None else str(text))
    folded = "".join(ch for ch in decomposed if not unicodedata.combining(ch)).casefold()
    folded = folded.translate(_DROP)
    folded = re.sub(r"[-_\u05be\u2010\u2011]", " ", folded)
    folded = re.sub(r"\s+", " ", folded).strip()
    if folded.startswith("the "):
        folded = folded[4:]
    return folded


def _all_entries() -> Iterable[tuple[str, Place]]:
    for key, (regime, names) in _COUNTRY_TABLE.items():
        place = Place(key, key, regime, "country")
        for name in (key, *names):
            yield normalise(name), place
    for table in (REGIONS, TERRITORIES):
        for key, region in table.items():
            place = Place(key, region.country, region.regime, "region")
            for name in (key, *region.names):
                yield normalise(name), place
    for key, city in CITIES.items():
        place = Place(key, city.country, city.regime, "city", city.months)
        for name in (key, *city.names):
            yield normalise(name), place


def duplicate_names() -> list[str]:
    """Spellings claimed by two different places -- must be empty."""
    seen: dict[str, Place] = {}
    dupes: list[str] = []
    for name, place in _all_entries():
        if name in seen and seen[name] != place:
            dupes.append(name)
        seen.setdefault(name, place)
    return dupes


_INDEX: dict[str, Place] = {}
for _name, _place in _all_entries():
    _INDEX.setdefault(_name, _place)

# Hebrew prepositions written as a prefix: to (ל), in (ב), from (מ).
_HEBREW_PREFIXES = ("\u05dc", "\u05d1", "\u05de")


def lookup(text: object) -> Place | None:
    """The one place a whole name means, or None. Never a substring match.

    A Hebrew preposition prefix is dropped only when the rest of the name then
    resolves exactly: "לאיטליה" is Italy, "ממדריד" is Madrid. A name that
    merely starts with one of those letters ("ברלין", "מדריד") resolves whole
    first, so the prefix is never stripped from it."""
    key = normalise(text)
    if not key:
        return None
    place = _INDEX.get(key)
    if place is None and len(key) > 2 and key[0] in _HEBREW_PREFIXES:
        place = _INDEX.get(key[1:])
    return place


# --- reading a free-text location -------------------------------------------

_BRACKET_RE = re.compile(r"(\([^()]*\)|\[[^\[\]]*\])")
_SEGMENT_RE = re.compile(r"[,;/&+|()\[\]\n:\u2014\u2013]| - ")
# English "and", or the Hebrew conjunction: a vav prefixed to the next word
# ("ארגנטינה וצ׳ילה"). A name that merely starts with vav ("וייטנאם") resolves
# whole before this is ever tried.
_CONJUNCTION_RE = re.compile(r"\s+and\s+|\s+\u05d5(?=\S)", re.IGNORECASE)


@dataclass(frozen=True)
class _Reading:
    places: tuple[Place, ...]
    unresolved: int       # segments that name nothing the table knows
    demoted: int          # cities read as namesakes of a place in another country

    @property
    def countries(self) -> frozenset[str]:
        return frozenset(p.country for p in self.places)

    @property
    def anchors(self) -> list[Place]:
        return [p for p in self.places if p.level in ("country", "region")]


def _segments(text: str) -> list[tuple[str, bool]]:
    """(segment, came from brackets) in reading order."""
    out: list[tuple[str, bool]] = []
    for piece in _BRACKET_RE.split(text or ""):
        bracketed = len(piece) >= 2 and piece[0] in "([" and piece[-1] in ")]"
        body = piece[1:-1] if bracketed else piece
        for segment in _SEGMENT_RE.split(body):
            if normalise(segment):
                out.append((segment, bracketed))
    return out


def _read(text: str) -> _Reading:
    items: list[Place | None] = []
    for segment, bracketed in _segments(text):
        whole = lookup(segment)
        if whole is not None:
            found: list[Place | None] = [whole]
        else:
            parts = [p for p in _CONJUNCTION_RE.split(segment) if normalise(p)]
            found = [lookup(p) for p in parts] if len(parts) > 1 else [None]
        if bracketed:
            # A bracketed place is evidence (it can demote or conflict); a
            # bracketed phrase that names nothing is description.
            found = [p for p in found if p is not None]
        items.extend(found)
    # A city followed by a region, territory or country of ANOTHER country is
    # a namesake: "Naples, Florida", "Toronto (NSW)", "Perth, Scotland". It is
    # also what a two-destination list looks like ("Bangkok, Italy"); either
    # way the city is not believed, and the reading is not fully resolved.
    demoted = 0
    for i in range(len(items) - 1):
        here, after = items[i], items[i + 1]
        if (here is not None and after is not None and here.level == "city"
                and after.level in ("region", "country") and here.country != after.country):
            items[i] = None
            demoted += 1
    places = tuple(p for p in items if p is not None)
    unresolved = sum(1 for p in items if p is None) - demoted
    return _Reading(places, unresolved, demoted)


@dataclass(frozen=True)
class ClimateDecision:
    """`hemisphere` is set only when a season bucket is reliable in every
    month the phase covers; otherwise `reason` says why not. `place` names
    what decided, for logs."""

    hemisphere: str | None
    reason: str | None
    place: str | None = None


def _abstain(reason: str, place: str | None = None) -> ClimateDecision:
    return ClimateDecision(None, reason, place)


def _judge(reading: _Reading, months: Sequence[int] | None) -> ClimateDecision:
    """What a reading says about the season in `months` (None: criteria 1-3
    only, no month test). Unknown segments are assumed to lie inside the most
    specific anchor (region, else country), which only ever makes the answer
    an abstention: no anchor is temperate."""
    if not reading.places:
        return _abstain(UNRESOLVED)
    if len(reading.countries) > 1:
        return _abstain(AMBIGUOUS_MULTI_PLACE)
    regions = [p for p in reading.places if p.level == "region"]
    anchors = regions or [p for p in reading.places if p.level == "country"]
    cities = [p for p in reading.places if p.level == "city"]
    gaps = reading.unresolved + reading.demoted
    if gaps and not anchors:
        # A known city beside a name we cannot place, with nothing saying
        # which country that name is in: not sure, so say nothing.
        return _abstain(UNRESOLVED)
    deciders = list(cities) if cities else list(anchors)
    if cities and gaps:
        deciders += anchors  # the unplaced names are somewhere in the anchor
    regimes = {p.regime for p in deciders}
    label = deciders[0].key
    if len(regimes) > 1:
        return _abstain(CLIMATE_VARIES_BY_AREA, label)
    regime = regimes.pop()
    if regime == VARIES:
        return _abstain(CLIMATE_VARIES_BY_AREA, label)
    if regime not in _TEMPERATE:
        return _abstain(regime, label)
    # Only cities are ever temperate, and every temperate city has months.
    hemisphere = _HEMISPHERE[regime]
    if months is None:
        return ClimateDecision(hemisphere, None, label)
    if len({season_bucket(m, hemisphere) for m in months}) > 1:
        return _abstain(SPANS_SEASONS, label)
    for month in months:
        bucket = season_bucket(month, hemisphere)
        for place in deciders:
            if place.months is None:  # pragma: no cover - the tests forbid it
                return _abstain(UNRESOLVED, place.key)
            verdict = month_verdict(place.months[month - 1], bucket)
            if verdict is not None:
                return _abstain(verdict, place.key)
    return ClimateDecision(hemisphere, None, label)


def _confirmed(city: Place, phase: _Reading, trip: _Reading) -> bool:
    """Is a namesake city really the one in the table? Only if the trip names
    its country -- as a country or region, not merely as the same ambiguous
    city again -- and none of its twins' countries, or the phase's own text
    anchors it in its country ("Perth, Western Australia", "Christchurch, NZ")."""
    twins = NAMESAKES.get(city.key)
    if not twins:
        return True
    if (any(a.country == city.country for a in trip.anchors)
            and not (trip.countries & twins)):
        return True
    return any(a.country == city.country for a in phase.anchors)


def _decide_phase_name(phase: _Reading, trip: _Reading, months: Sequence[int]) -> ClimateDecision:
    if phase.demoted:
        return _abstain(NAMESAKE)
    if phase.unresolved:
        # Partly placed ("Auckland - Rarotonga"): the unplaced part could be
        # anywhere, including somewhere with the opposite season.
        return _abstain(UNRESOLVED)
    if trip.countries and not phase.countries <= trip.countries:
        return _abstain(CONFLICTS_WITH_DESTINATION, phase.places[0].key)
    for place in phase.places:
        if place.level == "city" and not _confirmed(place, phase, trip):
            return _abstain(NAMESAKE, place.key)
    return _judge(phase, months)


def _as_months(months: int | Sequence[int] | None) -> list[int]:
    if months is None:
        return []
    if isinstance(months, int):
        return [months] if 1 <= months <= 12 else []
    return [m for m in list(months)[:12] if isinstance(m, int) and 1 <= m <= 12]


def _name_decisions(names: Sequence[str], trip: _Reading, months: Sequence[int]) -> list[ClimateDecision]:
    decisions: list[ClimateDecision] = []
    seen: set[str] = set()
    for name in names:
        key = normalise(name)
        if not key or key in seen:
            continue
        seen.add(key)
        phase = _read(str(name))
        if not phase.places and not phase.demoted:
            continue  # names nothing the table knows
        decisions.append(_decide_phase_name(phase, trip, months))
    return decisions


def decide(
    destination: str, phase_names: Sequence[str] = (), months: int | Sequence[int] | None = None,
    fallback_names: Sequence[str] = (),
) -> ClimateDecision:
    """Whether one phase's season is knowable in every month it covers, and in
    which hemisphere.

    `destination` is the trip's typed answer; `phase_names` are the phase's
    own FULL names (English, Hebrew); `fallback_names` are the shortened forms
    derived from them, read only when no full name placed anything -- so
    "Perth, Scotland" decides before the "Perth" it shortens to can, and
    "Christchurch, NZ" is not overruled by its own unqualified truncation.
    `months` are the calendar months the phase covers, start to end (a single
    month is accepted). Every name read that places something must agree --
    one abstaining name makes the phase abstain. A phase that names no place
    abstains: the destination is never inherited. Never raises.
    """
    try:
        if not normalise(destination):
            return _abstain(NO_DESTINATION)
        month_list = _as_months(months)
        if not month_list:
            return _abstain(NO_DATES)
        trip = _read(destination)
        decisions = (_name_decisions(phase_names, trip, month_list)
                     or _name_decisions(fallback_names, trip, month_list))
        if decisions:
            for decision in decisions:
                if decision.reason is not None:
                    return decision
            if len({d.hemisphere for d in decisions}) > 1:
                return _abstain(AMBIGUOUS_MULTI_PLACE)
            return decisions[0]
        # The phase names no place. Say why the trip could not have placed it
        # either, if it cannot (place-level only: the trip's own months say
        # nothing about an unnamed phase); otherwise it is simply unknown.
        verdict = _judge(trip, None)
        return verdict if verdict.reason is not None else _abstain(UNRESOLVED)
    except Exception:  # pragma: no cover - a table lookup should not raise
        return _abstain(UNRESOLVED)
