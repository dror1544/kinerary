# An activity added at the same time as another raises a conflict the organizer can accept

Status: draft 2026-11-12 — behaviour decided by Dror in #550; approval at merge · Issue: #550 · Track: Sprint 8 staging-test fixes · Size: M · Tier: Normal
Security path: yes (organizer-only visibility on `GET /api/itinerary/active`; one new `organizerOrAgentRequired` write route) · Migration: no (one additive `CREATE TABLE IF NOT EXISTS` in the trip site's own SQLite, the site's usual pattern; no data is changed) · Live-trip behaviour: yes (reaches a trip on redeploy)

## Problem

Sprint 8 staging test, 2026-11-12 (Mac staging, trip `gatecity-2026-2`), step 12:
adding an activity to the plan (not a reservation) at a time another plan item
already occupies raised **no conflict**. Only the "Booked, but not on the plan
yet" notice exists (#419, `trip-web/src/stops-editor.tsx`), and that is about a
hotel booking, not about two plan items.

What the code does today:

- The only overlap logic is `recomputeQualityIssues` in
  `server/living-journey.js` ("Overlapping events"). It writes a row to
  `trip_quality_issues`, which no screen reads. It also **cannot** flag two items
  at the same start time that carry no duration: it tests
  `previousEnd > current.time_sort`, and with no duration `previousEnd` equals
  `previous.time_sort`, so `10:00` and `10:00` compare equal and are skipped.
  That is exactly the staging case.
- The organizer-only "something needs your answer" notice already exists for
  another reason: the trip-file flag (#382). The server adds `seed_changed` /
  `seed_removed` to each item of `GET /api/itinerary/active` for an organizer
  only (`withSeedFlags`, `isOrganizer`), the Modern Journey renders
  `SeedFlagNotice` under the item, and the answer is a `POST` on
  `organizerOrAgentRequired` (`/api/itinerary/items/:item_uid/keep-seed`). A
  plan-conflict notice follows that pattern; it is not a second mechanism.
- Itinerary revisions are immutable (`itinerary_plan_items` has update/delete
  triggers), so an acceptance cannot live on an item row. It needs its own small
  table.

Dror's decision (#550): "it should if same time, however this conflict need to be
accepted if for example different family is sleeping on that place."

## Behaviour

When the organizer adds or edits a plan item so that it starts at a time another
plan item of the same stop and day already occupies, the Journey tab shows the
organizer a notice under both items: "Same time as <the other item>", with a
**Keep both** button. Pressing it records that the organizer accepted this
conflict; the notice goes away on both items and is not raised again for that
pair at those times. If either item later moves to a different time, that is a
different conflict and is raised on its own terms.

A member never receives the conflict, its wording, or the button: the field is not
in their payload and the accept route refuses them.

A conflict exists between two items when all of these hold:

1. same stop (`phase_id`) and same `date`;
2. both have an **exact** start time (`HH:MM`). A rough time ("morning") is a sort
   position, not a time, and never conflicts;
3. their time ranges meet: equal start times, or one starts before the other ends,
   where an item's end is its start plus `duration_minutes` (no duration = a point);
4. they are not the same booking (two items sharing a `booking_id`, e.g. a flight's
   own legs, are one reservation, not two claims on the same time);
5. they are not the same flight. Two couples who book separately on one flight make
   two bookings and two plan items at one time, but the group is on one plane. The
   rule mirrors the plan board's identity rule (#549, `trip-web/src/same-flight.ts`),
   kept self-contained in `server/plan-conflicts.js`: same flight number (an
   IATA-style designator and 1-4 digits at the start of the line, optionally after
   "flight"; "Museum 12" and unnumbered lines are not flights) + same date +
   identical wording, case and spacing aside. A line counts as a flight only with a
   route marker, a flight booking, or the travel type. Two different flights at one
   time, a flight and an activity, and two legs on one flight number (different
   wording) still conflict.

Both Modern (`POST /api/itinerary/items`) and Classic/agent
(`POST /api/phases/:id/plan`) writes land in the same active itinerary, so one check
on `GET /api/itinerary/active` covers every way an item gets on the plan.

## Acceptance criteria

- AC-1 Given a stop and day with an item at 10:00, when the organizer adds a second
  item at 10:00 on that day (Modern route), then `GET /api/itinerary/active` as the
  organizer carries `plan_conflicts` on both items, each naming the other (uid,
  text, time).
- AC-2 Same as AC-1 when the second item is added through the Classic route
  (`POST /api/phases/:phase_id/plan`, which is what the companion uses).
- AC-3 Given a conflict, when a **member** reads `GET /api/itinerary/active`, then no
  item carries `plan_conflicts` and the body does not contain that key at all.
- AC-4 Given a conflict, when a member `POST`s the accept route, then it is 403 and
  nothing is recorded; an unauthenticated call is 401.
- AC-5 Given a conflict, when the organizer (or the agent key) `POST`s
  `/api/itinerary/items/:item_uid/keep-both` with `{ "with": "<other uid>" }`, then
  it is 200 and neither item carries `plan_conflicts` afterwards, for the organizer
  too, on every later read.
- AC-6 Given an accepted pair, when a third item is added at the same time, then the
  third item conflicts with each of the two and the original pair stays accepted.
- AC-7 Given an accepted pair, when one item moves so that the pair meets at
  different times (e.g. a 60-minute item at 10:00 and the other moved to 10:30),
  then a new conflict is raised. When the item moves to a time where nothing
  meets, no conflict is shown.
- AC-8 Given two items that should not conflict — different day, different stop,
  different times with no overlap, a rough time against anything, both with the same
  `booking_id` — then no `plan_conflicts` appears.
- AC-9 Given the accept route with a pair that is not currently in conflict, then 409
  `no_conflict` and nothing is recorded; an unknown item uid is 404; a missing or
  non-string `with` is 400.
- AC-10 In the Modern Journey, an organizer sees the notice with a **Keep both**
  button that calls the accept route and refreshes the itinerary; with no
  `plan_conflicts` nothing renders; the notice is only rendered for an organizer.
- AC-11 Given two plan items for the same flight on the same day with identical
  wording (case and spacing aside) and different `booking_id`s (e.g. two `SL 482`
  bookings), then no conflict is raised and the accept route answers 409
  `no_conflict` for that pair. Given two different flights at the same time, or a
  flight and an activity at the same time, a conflict is raised. A line with no
  flight number ("Museum 12") is never skipped.

## Contracts

- `server/plan-conflicts.js` (new, pure): `findPlanConflicts(items)` (items may carry
  `booking: { type }`, which `living-journey.js` fills from the bookings table for the
  served payload and the accept route alike so both decide the same) returns, per
  item uid, the other items it conflicts with; `conflictKey(a, b)` is the identity of
  an accepted pair.
- `server/living-journey.js`:
  - table `plan_conflict_acks (pair_key TEXT PRIMARY KEY, accepted_by TEXT NOT NULL,
    accepted_at TEXT DEFAULT (datetime('now')))`, created `IF NOT EXISTS` in
    `schema()` like its siblings. **This is where acceptance is stored.** It is
    outside the immutable revision tables on purpose, and outside `phase_plan_items`
    so a Classic rewrite or a reconcile cannot clear it.
  - `pair_key` = `JSON.stringify([uidA, uidB, date, timeA, timeB])` with the two
    items ordered by uid, so the same pair at the same times is the same key whichever
    item is named first, and a time change is a different key (AC-7).
  - `withPlanConflicts(db, payload)` adds `plan_conflicts: [{ item_uid, text_he,
    text_en, time }]` to an item, unaccepted conflicts only. Called from
    `GET /api/itinerary/active` under the same `isOrganizer(req)` guard as
    `withSeedFlags`; not called for a member, so the key is absent, not empty.
  - `POST /api/itinerary/items/:item_uid/keep-both`, `organizerOrAgentRequired`,
    body `{ with }`. Recomputes the conflict server-side; the client does not say
    what the key is. Idempotent. Does not create an itinerary revision.
- `trip-web/src/api.ts`: `itemSchema` gains `plan_conflicts` (optional);
  `keepBothPlanItems(itemUid, withUid)`.
- `trip-web/src/App.tsx`: `PlanConflictNotice`, rendered under `SeedFlagNotice`,
  organizer only.
- No change to `sanitizeConfig()`, `/api/config`, or any member route.

## Non-goals

- Refusing the write. A conflict is a notice, not a block: the item is saved.
- Classic's own plan view (`site/app.js`). It does not render the #382 trip-file
  notice either; the organizer's Modern view is where the notice lives. The Classic
  routes still *feed* it (AC-2).
- Un-accepting a conflict from the screen. Moving either item to another time and
  back does not revive it (same key); there is no "reopen" button.
- The "Overlapping events" quality issue in `recomputeQualityIssues` is left as it
  is. It is a separate, unread signal; unifying the two is a later decision.
- Activity-type labels and de-duplicating the same flight on the plan (#545/#549).
  This change does not touch that code; it only mirrors #549's identity rule as a
  skip (AC-11), so the organizer is not told "SL 482 conflicts with SL 482". If the
  rule changes in `trip-web/src/same-flight.ts`, change `flightKey` in
  `server/plan-conflicts.js` with it.
- Conflicts between items of different stops on the same day (a travel day), and
  between a plan item and a booking that is not on the plan.

## Security notes

Organizer-only visibility is the point of this change, so:

- Visibility is decided **server-side** by the existing `isOrganizer(req)` predicate
  (`canReviewDrafts`: agent key, secondary organizer, the configured organizer). A
  member's `GET /api/itinerary/active` never has the key added. The UI hides the
  notice too, but is not the control.
- The write is `organizerOrAgentRequired`, never `authRequired`
  (`authRequired` accepts any member's JWT and is not an organizer check).
- Fails safe: an `isOrganizer` that is not wired adds nothing.
- The payload carries only item text and time that a member already sees on the
  plan; nothing from a booking (no PIN, notes or confirmation).
- `GET /api/itinerary/active`'s ETag is over the served payload, so an organizer's
  and a member's responses never share one.

## Test plan

Write first (each fails before the change):

- `tests/plan-conflicts.test.js`
  - unit: `findPlanConflicts` — equal start; overlapping with duration; touching
    ranges (end == next start) are not a conflict; rough time never conflicts; other
    day / other stop; same `booking_id` (AC-8).
  - AC-11 unit: two `SL 482` copies with different booking ids (also with case and
    spacing differences, the word "flight", and a flight booking with no arrow) raise
    nothing; two legs on one flight number, two different flights and a flight with an
    activity do; "Museum 12" and unnumbered lines are never skipped.
  - HTTP against a real trip server: AC-11 (two SL 482 copies raise nothing and are
    409 on accept; a different flight at that time conflicts with each); Modern add raises it for the organizer (AC-1);
    Classic add raises it (AC-2); a member's payload has no `plan_conflicts` key
    (AC-3); a member `POST` is 403, anonymous 401, nothing recorded (AC-4); accept
    clears it and it stays cleared after a reload and after an unrelated edit (AC-5);
    a third item conflicts, the pair stays accepted (AC-6); moving to an overlap at
    different times re-raises, moving away clears (AC-7); 409 / 404 / 400 (AC-9);
    the agent key can accept (AC-5).
- `trip-web/src/plan-conflict.test.tsx` (AC-10): the notice names the other item
  and posts to the route with `{ with }`; nothing renders without conflicts; the
  Journey renders it for an organizer and not for a member.

Suites: `cd tests && npm test`; `cd trip-web && npm test` and `npm run build`.

## Rollout and regression

Release payload (site + server) plus trip-web: reaches a trip only on redeploy; no
bridge or profile change. An existing trip's plan may already hold same-time pairs
(e.g. a check-out and an activity both at 11:00); on first load after redeploy the
organizer sees those too and accepts or fixes them once. A per-PR regression plan
is needed (organizer-only visibility on an authenticated route).

## Decisions

1. **A notice with an accept button, not a block** (Dror, #550).
2. **Acceptance in its own table keyed by the pair and their times**, not on the
   item rows (revisions are immutable) and not in `trip_quality_issues` (its
   fingerprint carries only the later item, so an acceptance would survive a move
   to a different conflict).
3. **Exact times only; rough times never conflict**, so two items both marked
   "morning" are not flagged.
4. **The same-flight skip is a server-side copy of #549's rule, not an import** from
   trip-web (coordinator, 2026-11-12). Rejected: relying on #549's board collapse, which
   is display-only and would still leave the conflict in the payload.

## Open questions

1. (Open — not decided.) Should a conflict also be surfaced to the companion so it
   can tell the organizer in chat? The agent key already receives `plan_conflicts`
   on the itinerary read; no tool or instruction uses it. No AC depends on it.
