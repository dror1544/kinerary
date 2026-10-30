# Each flight reservation carries its own travellers and ticket

Status: approved 2026-10-30 by Dror (decisions above) · refreshed against 4510301 · Issue: #414 · Track: T1 · Size: M · Tier: Normal
Security path: no · Migration: no (site column exists) · Live-trip behaviour: yes (newly built and rebuilt trips)

> **Sprint 8 (2026-10-30): in scope.**

Related: #412 (extraction; separate cause). #415 (decided 2026-10-30: one
Journey line per physical flight) lists the same per-booking travellers this
spec adds, so this item is built first or together with it.

## Problem

Owner's gate-3 run, 2026-10-18 (`france-2026`): two tickets, same dates,
different couples. Reservations showed the flight twice, "but without the
tickets", and "It was fine if was added twice and stating the names of each"
(run note, verbatim). **Owner's ruling: two entries are correct; each must
carry its own names and ticket.**

Root cause: **structural**, and independent of #412.

- Reservations shows names from `booking.passengers` only (Modern
  `trip-web/src/App.tsx:1554`; Classic `site/app.js:2924`), and the ticket from
  `conf_file` (`App.tsx:1256-1265`).
- The worker never fills `passengers`. `derive_bookings` writes
  `"passengers": None` on every row (`control-plane/worker/control_plane_worker/transformer.py:2844`
  hotels, `:2909` anchors). So **neither** flight row can show names. #414's
  "unlike the first" likely overstates it; the owner's note says both lacked
  tickets.
- Nothing ties travellers to a booking. A `travel_anchors` entry is
  `{type, name, date, time, confirmation}` (`control-plane/api/src/interview.ts:775`;
  document prompt `interpret.ts:1895-1926`). Travellers are one trip-wide list
  (`interview.ts:680-707`).
- The ticket link (`conf_file`) comes from `documents.for_anchor(index)`
  (`document_handoff.py:259-260`, `:322-323`; called at
  `transformer.py:2889`), the anchor index the confirmed
  manifest names. The link is skipped unless exactly one entry matches the
  identity key recorded at upload (`interview.ts:57-60`; key built at
  `answer-merge.ts:251-252`). Two ways it can fail for the second ticket:
  - `withoutFlightNumbersAsConfirmations` (`interview.ts:1215-1235`, wired at `:779`) strips a
    confirmation after the key was recorded;
  - two flights with the same name and date and no confirmation share a key.
- Identity of a flight row: `seed_key = _stable_id("anchor", type, name, date, confirmation)`
  (`transformer.py:2900-2902`, `:2916`). Two same-flight anchors with no
  confirmation collide, and the site's `INSERT OR IGNORE` keeps one
  (`server/server.js:707-730`).

**Refresh against 4510301 (2026-10-30).** Every claim above still holds; only
line numbers moved (`transformer.py` +3 from #201, `App.tsx` +1, `site/app.js`
+34, `interpret.ts` +23 from #339). Nothing on main fills `passengers`, ties
travellers to an anchor, or changes the anchor `seed_key`. #339 changed only
how an *unsure* structured reading is offered (merged into what is held); for
`travel_anchors` that means a Yes on a later upload's unsure anchor now goes
through `matchEntry`, so AC-3's "different passengers = different bookings"
rule also governs what that tap writes.

## Behaviour

A booked flight read from a ticket remembers who is on it. On the built site,
two tickets for two parties are two Reservations entries. Each shows its own
travellers (as printed), its own confirmation and its own ticket PDF.

## Acceptance criteria

- AC-1 Given the document prompt and the `travel_anchors` example, then a
  booked item may carry `passengers: ["<name as printed>", …]`, the names that
  item's document ties to it. The prompt says so, and says to leave it out when
  the document names no one for that item.
- AC-2 Given two documents for the same flight and date with different PNRs and
  different passengers, when gated, then `travel_anchors` holds two entries,
  each with its own `confirmation` and `passengers`.
- AC-3 Given two anchors for the same flight and date with **no**
  confirmations but different `passengers`, then they are two entries (not
  merged, not ambiguous), and `derive_bookings` gives them distinct `seed_key`s.
- AC-4 Given an anchor with `passengers`, then `derive_bookings` writes
  `"passengers": "A B, C D"` (the site's text column), in the order printed.
- AC-5 Given two flight anchors each sourced from its own document, then each
  row's `conf_file` is its own document. A confirmation stripped by
  `withoutFlightNumbersAsConfirmations` still links (the key is recorded after
  sanitizing, or the match ignores a stripped field). This holds also for two
  **confirmation-less** same-flight anchors whose `passengers` differ:
  `entryIdentity` includes `passengers` when present (Decisions, 2), so each
  links its own PDF.
- AC-6 Given the built site seeded from AC-4's `bookings.json`, then
  `GET /api/bookings` returns both rows with their passengers and `conf_file`,
  and the Modern Reservations list renders each row's names (`App.tsx:1554`).
- AC-7 Given an existing anchor with no `passengers` (every trip built so far),
  then its `seed_key` is unchanged. The new field joins the identity only when
  present, so a re-provision of an existing trip adds no duplicate row.

## Contracts

- `control-plane/api/src/interview.ts` (`travel_anchors.dataExample` `:775`,
  sanitize `:1215-1235`, link key `:57-60`); `interpret.ts` (`:1895-1926`);
  `answer-merge.ts` `matchEntry` (`:266-306`), `entryIdentity` (`:245-254`): `passengers` disagreeing with
  no references on either side is "different bookings" for segment types, and
  `entryIdentity` joins non-empty `passengers` to a confirmation-less
  segment's key (the upload link key, `interview.ts:57-60`).
- `control-plane/worker/control_plane_worker/transformer.py` `derive_bookings`
  (`:2799-2921`): `passengers`; identity `(type, name, date, confirmation)` plus
  `passengers` **only when non-empty** (AC-7).
- `control-plane/worker/control_plane_worker/document_handoff.py`: no shape
  change.
- Site: none needed (`passengers` already stored and rendered).
- The interview's confirmed-intake JSON gains an optional key. No migration:
  the answer lives in `dataJson`.

## Non-goals

- Whether the Journey shows one flight or two (#415).
- Back-filling passengers onto live trips' existing rows (a seed row is never
  updated, see #382).
- Validating passengers against the `travelers` roster.

## Security and boundary notes

`passengers` is already served to members by `GET /api/bookings` (owner:
intended, `tests/write-validation.test.js`). It is not added to `/api/config`,
so `sanitizeConfig()` is untouched. The fixture uses invented names.

## Test plan

Write first:
- `control-plane/api/test/answer-merge.test.ts`:
  `two parties on one flight with no booking codes are two bookings when their passengers differ`.
- `control-plane/api/test/document-reconcile.test.ts`:
  `two tickets keep their own passengers and confirmation` (AC-2, on the
  #412 fixture).
- `control-plane/api/test/interpret.test.ts`:
  `the document prompt asks for a booked item's passengers`.
- `control-plane/worker/tests/test_transformer.py`:
  - `test_a_flight_anchor_carries_its_passengers_to_the_booking`
  - `test_two_same_flight_anchors_for_two_parties_get_two_seed_keys`
  - `test_an_anchor_without_passengers_keeps_its_seed_key` (AC-7)
- `control-plane/worker/tests/test_document_handoff.py`:
  `test_each_of_two_same_flight_anchors_links_its_own_ticket` (AC-5).
- `control-plane/api/test/answer-merge.test.ts`:
  `a confirmation-less segment's identity includes its passengers` (AC-5).
- `tests/server.test.js`: `seeded passengers are served on the booking` (AC-6).

Suites: `control-plane/api` (unit plus DB where noted), worker
(`preflight-deploy.sh` provides the venv), `tests/`.

## Rollout and regression

The relay restart carries the extraction change; the worker restart carries
`derive_bookings`. Effect: trips built afterwards. Existing trips are unchanged
(AC-7). **Per-PR regression plan: needed** (`seed_key` derivation is
re-provision-sensitive; AC-7 is the guard).

## Decisions (Dror, 2026-10-30)

1. **A ticket that prints passengers but no PNR: two same-flight entries are
   two bookings** (this spec's position, AC-3), not one booking needing a
   question.
2. **`passengers` joins `entryIdentity` for a confirmation-less segment** (the
   spec's assumption), so two confirmation-less same-flight entries each link
   their own PDF; AC-5 is not limited to tickets with a PNR.

## Open questions

None open.

Size: unchanged (M). Nothing in scope was built on main.
