# An activity added at the same time as another raises a conflict the organizer can accept

Status: draft 2026-11-12 — behaviour decided by Dror in #550; approval at merge · Issue: #550 · Track: Sprint 8 staging-test fixes · Size: M · Tier: Normal
Security path: yes (organizer-only visibility on `GET /api/itinerary/active`; one new `organizerOrAgentRequired` write route) · Migration: no (one additive nullable column, `keep_both_with`, on `itinerary_plan_items` and `phase_plan_items` in the trip site's own SQLite, added by the site's usual guarded `ALTER TABLE ADD COLUMN`; no data is changed, no new table) · Live-trip behaviour: yes (reaches a trip on redeploy)

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
  triggers), but every item edit is a new revision that copies the item's fields
  forward, and the Classic rows (`phase_plan_items`) are projected from and back into
  it (`updateLegacyFromActive`, `rowsFromLegacyPlan`, `syncFromLegacy`). An acceptance
  can therefore live on the item like any other field, as long as that projection
  carries it. (An earlier draft of this spec used a separate table because the Classic
  rewrite did not carry unknown fields; Dror decided against the extra table, see
  Decisions 2.)

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
4. they are not one booking's own line shown twice: a shared `booking_id` skips a pair
   only when the wording is identical too (case and spacing aside), like rule 5. Two
   different activities that both link to one booking ("Opera" and "Dinner" on booking
   1) are two things at one time and still conflict;
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
  different times with no overlap, a rough time against anything, or one booking's
  own line twice (same `booking_id` AND identical wording) — then no `plan_conflicts`
  appears. Given two different activities at one time that both link to the same
  booking, a conflict is raised.
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
- AC-12 Given an accepted pair, when a Classic/agent write rewrites the plan (a
  `POST /api/phases/:id/plan` of another item, a `PATCH` of one of the two, moving it
  away and back), then the acceptance survives: the pair stays accepted while both
  times stand. Neither the Classic plan read, a member's itinerary, `/api/today`, nor
  the organizer's own itinerary payload ever contains the stored `keep_both_with`.

## Contracts

- `server/plan-conflicts.js` (new, pure): `findPlanConflicts(items)` (items may carry
  `booking: { type }`, which `living-journey.js` fills from the bookings table for the
  served payload and the accept route alike so both decide the same) returns, per
  item uid, the other items it conflicts with, each with `accepted` (true when either
  item carries the organizer's keep-both for this pair as it stands);
  `acknowledgement(item, other)` is the entry written on an item.
- **Where acceptance is stored: on the plan items themselves.** Each of the two items
  carries `keep_both_with`, a JSON list of `{ uid, date, time, other_time }`: `uid` is
  the OTHER item's `item_uid`; `date`, `time` (this item's) and `other_time` are what
  they were at when the organizer accepted. An entry matches only while all of those
  still hold, so moving either item is a different conflict, raised on its own terms
  (AC-7); one entry per other uid is kept (a later accept replaces it). Either item's
  entry is enough. No table.
- `server/living-journey.js`:
  - column `keep_both_with TEXT` (nullable) on `itinerary_plan_items`, added by a
    guarded `ALTER TABLE ADD COLUMN` in `schema()` (like `legacy_owns_config`), read and
    written with the item's other fields (`getVersionRows`, `toWritableRows`,
    `insertVersionRows`).
  - **Carried through the Classic projection like the item's other fields**:
    `rowsFromLegacyPlan` reads it from `phase_plan_items`, `updateLegacyFromActive`
    writes it there (insert and `ON CONFLICT` update), and `syncFromLegacy`'s
    comparison includes it (normalised, so a text and a parsed value compare equal and
    no spurious revision is made). `server/server.js` adds the nullable
    `keep_both_with` column to `phase_plan_items` in its existing column list.
  - `keep_both_with` is an internal, never served: `serializeItinerary` and the
    `/api/today` item decoration (`withHotelPlace`) drop it, and
    `server/seed-reconcile.js` `PLAN_INTERNALS` lists it so the Classic plan read
    (`shapePlanItem`) drops it. The organizer sees only the derived `plan_conflicts`.
  - `withPlanConflicts(db, payload, rows)` adds `plan_conflicts: [{ item_uid, text_he,
    text_en, time }]` to an item, unaccepted conflicts only, computed from the active
    revision's raw rows. Called from `GET /api/itinerary/active` under the same
    `isOrganizer(req)` guard as `withSeedFlags`; not called for a member, so the key is
    absent, not empty.
  - `POST /api/itinerary/items/:item_uid/keep-both`, `organizerOrAgentRequired`,
    body `{ with }`. Recomputes the conflict server-side. If not already accepted it
    writes the entry on both items as a normal item update (`cloneWith`: one new
    itinerary revision, projected into the Classic rows). Idempotent: a repeat makes no
    revision.
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
  back to the accepted times does not revive it (the entry matches again); there is no
  "reopen" button. Accepting makes a new itinerary revision, so an editor holding an
  older `If-Match` revision gets the usual "itinerary changed, reload" once.
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
- The stored `keep_both_with` names another item's uid and times, so it is itself
  organizer-private: every reader of a raw plan item drops it (the itinerary payload,
  `/api/today`, the Classic plan read), and AC-12's test asserts the string is absent
  from each of those bodies for a member.
- `GET /api/itinerary/active`'s ETag is over the served payload, so an organizer's
  and a member's responses never share one.

## Test plan

Write first (each fails before the change):

- `tests/plan-conflicts.test.js`
  - unit: `findPlanConflicts` — equal start; overlapping with duration; touching
    ranges (end == next start) are not a conflict; rough time never conflicts; other
    day / other stop; one booking's own line twice is skipped, two different
    activities on one booking are not (AC-8); the acknowledgement entry matches only
    while both times stand, on either item, as text or list, and garbage fails safe
    to "raised".
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
    the agent key can accept (AC-5); Opera and Dinner on one booking conflict, a
    booking's own line twice does not (AC-8); after accepting, a Classic POST and
    PATCH (a location edit, a move to 11:00 and back to 10:00) leave it accepted, and
    no member/agent/organizer body contains `keep_both_with` (AC-12), and `/api/today`
    for a member does not either (AC-12). Mutation-checked: dropping the carry-forward
    from `rowsFromLegacyPlan` fails the Classic-write test, and dropping the strip from
    `withHotelPlace` fails the `/api/today` test.
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
2. **Acceptance lives on the plan items, keyed by the other item's uid** (Dror,
   2026-11-12: "Each item has its own ID… it seems to me like unnecessary
   complication"). A first draft used a new table `plan_conflict_acks`; it was dropped
   because it was a second place to keep in step with the plan, for something an item
   can carry. Its reason, that a Classic rewrite (`syncFromLegacy` /
   `rowsFromLegacyPlan`) would not carry an unknown field, is fixed at the source
   instead: the projection now carries `keep_both_with` like every other item field
   (AC-12). The entry stores the date and both times so that moving either item is
   still a new conflict. Also rejected: `trip_quality_issues` 'ignored' (its
   fingerprint carries only the later item, so an acceptance would survive a move to a
   different conflict).
3. **Exact times only; rough times never conflict**, so two items both marked
   "morning" are not flagged.
4. **The same-flight skip is a server-side copy of #549's rule, not an import** from
   trip-web (coordinator, 2026-11-12). Rejected: relying on #549's board collapse, which
   is display-only and would still leave the conflict in the payload.
5. **A shared booking skips a pair only with identical wording** (boundary review,
   2026-11-12): "any two items on one booking" was too broad, because "Opera" and
   "Dinner" both linked to booking 1 at 18:00 raised nothing. Same rule as the flight
   skip: only a booking's own line shown twice is one claim on the time.

## Open questions

1. (Open — not decided.) Should a conflict also be surfaced to the companion so it
   can tell the organizer in chat? The agent key already receives `plan_conflicts`
   on the itinerary read; no tool or instruction uses it. No AC depends on it.
