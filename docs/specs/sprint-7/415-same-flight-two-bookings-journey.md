# Same flight, two bookings: one Journey entry or two (decision)

Status: draft (2026-10-19) · **needs Dror's decision before approval** · Issue: #415 · Track: T1 · Size: S · Tier: Normal
Security path: no · Migration: no · Live-trip behaviour: yes (newly built trips)

## Problem

Owner's gate-3 run, 2026-10-18 (`france-2026`): two couples booked separately
on the same flight. The Journey (day-by-day) shows the flight twice. On
Reservations the owner ruled that two entries are right (#414). For the Journey
he made no ruling.

Why there are two today:
- `derive_days_from_anchors` (`control-plane/worker/control_plane_worker/transformer.py:2589-2647`)
  appends one day item per booked anchor, with no dedupe. Flights are itinerary
  items (`_NON_ITINERARY_ANCHORS` excludes only hotel, car and proposal, `:2586`,
  `:2625`).
- The server imports config day items by position
  (`config_ref = phase|date|index`, `server/server.js:3992`), so both are kept.
- Each is matched to a booking by `findMatchingBooking` (`server/server.js:3445-3466`),
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

## Acceptance criteria (for B; rewritten if A is chosen)

- AC-1 Given two flight anchors with the same flight number and date and
  different confirmations, then the transformer emits **one** day item with
  `booking_refs` naming both bookings' `seed_key`s.
- AC-2 Given two flight anchors with different flight numbers on the same day,
  then two items.
- AC-3 Given a flight anchor whose name holds no flight number, then it is never
  grouped.
- AC-4 Given the built site, then `GET /api/itinerary/active` serves that item
  once, with both bookings joined. The Modern Journey shows one line with "2
  bookings" and both confirmations on expand, organizer view only, as
  confirmations already are.
- AC-5 Given an existing trip (built before this), then a re-provision adds or
  removes no plan items (the plan import runs once, `server/living-journey.js:849-862`).

## Contracts (for B)

- `transformer.py` `derive_days_from_anchors`.
- `server/server.js`: day-item import and `joinBooking` (`:2890-2903`); `server/living-journey.js:645-672`,
  the booking join over a list.
- `trip-web/src/App.tsx`: the Journey line.
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
- `trip-web/src/Journey.test.tsx`: `one line, two bookings`.

## Rollout and regression

Trips built after the worker and site release. Existing trips are unaffected
(AC-5). **Per-PR regression plan: needed** (a config shape plus an allow-list
entry).

## Open questions

1. **Decision for Dror:** one Journey entry (B, recommended), two (A), or one
   with the first booking only (C)?
2. If B: should members see "2 bookings" at all, or only the organizer?
