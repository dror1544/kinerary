# Same flight, two bookings: one Journey entry listing both

Status: approved 2026-10-30 by Dror (decisions above) · refreshed against 4510301 · Issue: #415 · Track: T1 · Size: M · Tier: Normal
Security path: no · Migration: no · Live-trip behaviour: yes (newly built trips)

> **Sprint 8 (2026-10-30): decided — option B** (Dror, 2026-10-30; see Decisions). Built with or after #414: the line lists each booking's travellers from #414's `passengers`.

## Problem

Owner's gate-3 run, 2026-10-18 (`france-2026`): two couples booked separately
on the same flight. The Journey (day-by-day) shows the flight twice. On
Reservations the owner ruled that two entries are right (#414). For the Journey
he made no ruling.

Why there are two today:
- `derive_days_from_anchors` (`control-plane/worker/control_plane_worker/transformer.py:2592-2661`)
  appends one day item per booked anchor, with no dedupe. Flights are itinerary
  items (`_NON_ITINERARY_ANCHORS` excludes only hotel, car and proposal, `:2589`,
  `:2628`).
- The server imports config day items by position
  (`config_ref = phase|date|index`, `server/server.js:4041`), so both are kept.
- Each is matched to a booking by `findMatchingBooking` (`server/server.js:3494-3515`),
  which picks the best token hit, ties to the first. Both lines can show the
  **same** booking's confirmation.

## Options

**A. Two entries, one per booking.** Each line names its party ("AF 1621 Tel
Aviv → Paris — A & B", "… — C & D") and links its own booking.
- For: mirrors Reservations; each party sees its own confirmation.
- Against: the Journey describes what the trip *does*, and the group is on one
  plane; two identical lines read as a bug (the owner's first reaction).

**B. One entry per physical flight, listing every booking on it.** "AF 1621
Tel Aviv → Paris · 2 bookings", expandable to each party and confirmation.
- For: one event, shown once; still reaches each booking.
- Against: needs a "same physical flight" rule (flight number plus date plus
  route; a free-text name without a number cannot be grouped). The plan item
  links many bookings, while `phase_plan_items.booking_id` holds one.

**C. One entry, first booking only.** Collapse, and link nothing else.
- For: smallest change.
- Against: the second party's confirmation is unreachable from the Journey.
  This is the silent loss Guarantee B(c) warns about.

## Recommendation

**B.** The Journey says what happens, once. Reservations (#414) says who holds
which ticket, twice. To make B cheap:
- the worker emits one day item per `(type=flight, flight number, date)` group,
  carrying `booking_refs: [seed_key, …]`;
- the site joins each ref to its booking;
- `booking_id` stays as the first ref, for old readers;
- a flight anchor with no recognisable flight number is not grouped. It stays
  its own line, as in A.

## Acceptance criteria (option B, decided)

- AC-1 Given two flight anchors with the same flight number and date and
  different confirmations, then the transformer emits **one** day item with
  `booking_refs` naming both bookings' `seed_key`s.
- AC-2 Given two flight anchors with different flight numbers on the same day,
  then two items.
- AC-3 Given a flight anchor whose name holds no flight number, then it is never
  grouped.
- AC-4 Given the built site, then `GET /api/itinerary/active` serves that item
  once, with both bookings joined. The Modern Journey shows **one** line for the
  flight that lists each booking with its own travellers (the booking's
  `passengers`, #414), e.g. "AF 1621 Tel Aviv → Paris · A B, C D · E F, G H".
  The line and the traveller names are shown to members and the organizer
  alike. Confirmation numbers are shown exactly as today: organizer view
  only. Reservations still shows two entries, one per booking (#414).
- AC-6 Given a member token, when the Journey is loaded, then the member sees
  the one line with each booking's travellers, and no confirmation number
  appears in the line or in the member's `GET /api/itinerary/active` response.
  (Booking `passengers` already reach members through `GET /api/bookings`,
  `tests/write-validation.test.js`.)
- AC-5 Given an existing trip (built before this), then a re-provision adds or
  removes no plan items (the plan import runs once, `importPlanOnce`,
  `server/living-journey.js:855-868`).

## Contracts (for B)

- `transformer.py` `derive_days_from_anchors`.
- `server/server.js`: day-item import (`:4041`) and `joinBooking` (`:2940-2953`);
  `server/living-journey.js:641-675` (`serializeItinerary`), the booking join
  over a list.
- `trip-web/src/App.tsx`: the Journey line — one line per grouped item, each
  joined booking's `passengers` beside it; confirmations behind the existing
  organizer check.
- Additive config key `booking_refs` on a day item. **This is a
  `shared/config-visibility.js` allow-list decision**: it carries `seed_key`s
  only, never a confirmation, and must be entered on the list or it is
  withheld.

## Test plan

- `control-plane/worker/tests/test_transformer.py`:
  - `test_one_flight_two_bookings_is_one_day_item_with_both_refs`
  - `test_different_flights_same_day_stay_two`
  - `test_an_unnumbered_flight_is_never_grouped`
- `tests/config-allow-list.test.js`: `booking_refs is served and carries no confirmation`.
- `tests/living-journey.test.js`: `a grouped flight joins both bookings`.
- `trip-web/src/Journey.test.tsx`: `one line, two bookings, each with its travellers`;
  `a member sees the line and the travellers but no confirmation` (AC-6).

## Rollout and regression

Trips built after the worker and site release. Existing trips are unaffected
(AC-5). **Per-PR regression plan: needed** (a config shape plus an allow-list
entry).

## Decisions (Dror, 2026-10-30)

1. **Option B.** One Journey line per physical flight, listing both bookings
   and their travellers. Reservations still shows two entries (#414).
2. **Members see it too** (the spec's recommendation for the members
   question): the grouped line and each booking's travellers are shown to
   members as well as the organizer. Confirmation numbers keep today's
   organizer-only display (AC-4, AC-6).

## Open questions

1. (Open — no recommendation in the spec; not decided.) #382 proposes a
   boot-time reconcile of config-imported plan items (`reconcileConfigItems`).
   If #382 lands, AC-5 ("a re-provision adds or removes no plan items") no
   longer holds by itself for an *unedited* trip: a rebuilt config that groups
   two flights into one item would retire one positional `config_ref`. Should
   grouped items be excluded from #382's reconcile, or is the change
   acceptable for unedited rows? **AC-5 here, and #382's AC-4, depend on the
   answer**; it must be settled before whichever of #382 and #415 is built
   second.

Checked 2026-10-30: nothing on main since 03c0e1c changes the transformer's
day derivation, the positional import or `findMatchingBooking` (line shifts
only; the only transformer change is #201/#127's log message). No
`booking_refs` exists. Size: M (option B: worker, site join, allow-list entry,
Journey UI).
