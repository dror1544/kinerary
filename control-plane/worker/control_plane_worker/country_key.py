"""The primary key of control_plane.country_reference, on the READ side.

This is the Python half of a contract whose authoritative statement is
``control-plane/api/src/country-key.ts``. Read that file for why the rule exists;
this docstring is about why the rule needs a second implementation at all.

THREE PLACES DERIVE THIS KEY, IN TWO LANGUAGES:

  saveConsularContacts     interview.ts                INSERT … ON CONFLICT   (write)
  writeDestinationInfo     destination-info-store.ts   UPDATE … WHERE …       (write)
  _destination_info_lookup __main__.py                 SELECT … WHERE …       (read)

The two writers share one TypeScript function. The reader cannot import it — it
is a different runtime in a different container — so it is reimplemented here,
once, instead of being open-coded inline at the query. Inline was how it was
written first, and it silently omitted the 80-character truncation: a
destination longer than the bound is stored truncated by the writer and was
looked up in full by the reader, so the SELECT matched nothing and the trip
quietly shipped without its cached prose. Nothing would have reported that —
the miss path is indistinguishable from "this destination was never refreshed".

Reimplementation is a real cost, so it is guarded rather than trusted:
``tests/test_country_key.py`` reads country-key.ts and fails if the two sides
disagree on either the rule or the bound. That test is the only thing connecting
them; without it this file is a copy that drifts, which is the exact failure the
TypeScript side was extracted to prevent.

NOT APPLIED TO ``_consular_lookup``. The consular reader a few lines above in
__main__.py open-codes the same normalisation and has the same missing
truncation. That is pre-existing and reaches a live path, so it is deliberately
left alone here and reported instead; changing what an existing lookup matches
is not a side effect this change should carry.
"""
from __future__ import annotations

import re

# Must equal COUNTRY_KEY_MAX_CHARS in control-plane/api/src/country-key.ts.
# Asserted by tests/test_country_key.py, not merely documented here.
COUNTRY_KEY_MAX_CHARS = 80


def normalise_country_key(value: object) -> str:
    """Mirror of ``normaliseCountryKey`` — trim, lower-case, collapse internal
    whitespace, then bound the length. Order matters: truncating before
    collapsing whitespace would cut at a different character."""
    text = "" if value is None else str(value)
    return re.sub(r"\s+", " ", text.strip().lower())[:COUNTRY_KEY_MAX_CHARS]
