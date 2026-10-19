# An older booking or plan-item edit cannot overwrite a newer one

Status: draft (2026-10-19) · Issue: #383 · Track: T1 · Size: M · Tier: Normal
Security path: yes (`server/server.js` write routes; `server/trip-mcp/`) · Migration: no (site SQLite, additive column) · Live-trip behaviour: yes

## Problem

Guarantee A, scenario A3 (`docs/reliability-guarantees.md:37`): "Bookings and
classic plan items have no ordering guard."

- `PATCH /api/bookings/:id` (`server/server.js:2670-2699`) is a bare
  `UPDATE … WHERE id = ?`. It has no precondition, and an unknown id still
  answers `{ok:true}`.
- `PATCH /api/phases/:p/plan/:id` (`server/server.js:3112-3184`) is
  last-write-wins too.
- Neither table has `updated_at` or a version (`bookings` `:367-383`,
  `:396-447`; `phase_plan_items` `:463-526`).
- `If-Match` exists only on Modern itinerary routes (`server/living-journey.js:1335-1344`)
  and stop routes (`server/trip-structure.js:820-823`), and is **optional** on
  both: no header, no check.
- No caller of the two routes sends it:
  - `mcp/mcp.js` `update_booking` (`:644-668`, `writeApi` `:234`) and
    `update_plan_item` (`:924-942`, `apiPatch` `:99-105`);
  - the trip-site connector (`server/trip-mcp/tools.js:203-212`, `:249-258`;
    `siteClient` `index.js:319-342` sends only auth and content-type);
  - trip-web `updateBooking` (`trip-web/src/api.ts:372`);
  - Classic (`site/app.js:3097`).
- So a companion that read a booking, then saved an edit after the organizer
  corrected it on the site, silently puts the old value back. An incident by
  the MRD 5.3 definition.

## Behaviour

Every booking and classic plan item carries a revision. A write that names a
revision older than the row's is refused with 409 and changes nothing. The
caller re-reads and decides. Agent writes (both MCP servers) always name the
revision they read. The site's own forms send it too. A write naming no
revision is still accepted from a person's browser for one release, and logged.

## Acceptance criteria

- AC-1 Given booking B at revision r1, when a PATCH with `If-Match: "r1"`
  changes `date_from`, then it succeeds, B is now at r2, and the response
  carries `revision: "r2"`.
- AC-2 Given booking B at r2, when a PATCH with `If-Match: "r1"` arrives (the
  older edit), then the response is 409 `booking_changed_reload_before_retry`
  with the current row, and `GET /api/bookings` still shows r2's values.
- AC-3 The same as AC-1 and AC-2 for `PATCH /api/phases/:p/plan/:id`, with 409
  `plan_item_changed_reload_before_retry`.
- AC-4 Given an agent token (the API key, or a trip-site connector JWT), when it
  PATCHes either route without `If-Match`, then 428 `revision_required`
  (refused, nothing written).
- AC-5 Given `update_booking` / `update_plan_item` on `mcp/mcp.js` and on
  `server/trip-mcp/tools.js`, when called without a `revision` argument, then
  the tool reads the row first and sends that revision. When a `revision` is
  given, it is sent as is. A 409 is returned to the model with a hint to
  re-read (`STOP_REFUSAL_HINTS` pattern, `mcp/mcp.js:150-175`).
- AC-6 Given a sequence "companion reads B (r1) → organizer PATCHes B on the site
  (r2) → companion PATCHes with r1", then the companion's write is 409 and the
  organizer's value stands. This is scenario A3 end to end, against a real trip
  server.
- AC-7 Given a family-member JWT PATCH with no `If-Match`, then it is accepted
  for now and a `write_without_revision` line is logged with the route.
- AC-8 Given `GET /api/bookings`, `GET /api/phases/:p/plan` and
  `GET /api/itinerary/active`, then each booking and plan item carries its
  `revision`.

## Contracts

- `server/server.js`: an additive column `row_version INTEGER NOT NULL DEFAULT 1`
  on `bookings` and `phase_plan_items`, added in the same guarded `ALTER TABLE`
  loops (`:396-400`, `:507-527`). It is bumped in the same `UPDATE`
  (`row_version = row_version + 1 WHERE id = ? AND row_version = ?`), so the
  check and the write are one statement. 0 rows changed means 409.
  `revision` = `"bk-<id>-<n>"` / `"pi-<id>-<n>"`.
- Every other writer of those rows bumps `row_version` too:
  - `tripStructure.onBookingChanged` (`server/server.js:2697`);
  - `from-booking`'s items, which go to the Modern itinerary and already carry
    its revision;
  - `promoteConfigDays` back-fills (`:3939-3945`);
  - enrichment and review writes.
  - Whether to use a trigger instead of call sites is a build decision.
    `server/trip-events.js:4-30` already has triggers per table.
- `mcp/mcp.js`, `server/trip-mcp/tools.js`: `revision` argument; read-then-write
  as `update_stop` does (`mcp/mcp.js:1033-1060`).
- `trip-web/src/api.ts:372`, `site/app.js:3097`: send the revision the form was
  opened with.
- `docs/reliability-guarantees.md` A3 row: updated by doc-keeper when built.

## Non-goals

- Making `If-Match` mandatory for people's browsers (open question 1).
- Guards on `DELETE` (a delete of a changed row is a separate call).
- The Modern itinerary and stop routes' own optional `If-Match`.

## Security and boundary notes

`authRequired` vs `organizerOrAgentRequired` is unchanged; the routes stay
`organizerOrAgentRequired`. AC-4 distinguishes "agent" by the auth path
(API key / connector JWT) that `organizerOrAgentRequired` already resolves; no
new identity claim is trusted from the body. `sanitizeConfig()` is not touched.
`server/server.js` is a security path: boundary review, and the request and
response evidence for AC-2, AC-4 and AC-7.

## Test plan

Write first:
- `tests/server.test.js`:
  - `a booking PATCH with the current revision succeeds and returns the next`
  - `a booking PATCH with an older revision is 409 and changes nothing`
  - `an agent PATCH without a revision is 428`
  - `a member PATCH without a revision is accepted and logged`
- `tests/plan-single-source.test.js` (or a new `tests/plan-item-revision.test.js`):
  the same four for plan items.
- `tests/mcp-booking-confirmation.test.js` / `tests/mcp-phase-plan.test.js`:
  - `update_booking reads the revision when none is given`
  - `a 409 is relayed with the re-read hint`
- `tests/trip-mcp.test.js`: the connector's two tools send a revision.
- `tests/reliability-a3-site.test.js`:
  `an older companion edit cannot overwrite the organizer's newer one` (AC-6).
- `trip-web/src/booking-retry.test.tsx`: `the edit form sends the revision it was opened with; a 409 reloads`.

Suites: `tests/`, `trip-web`. No control-plane change.

## Rollout and regression

Site plus bridge. Each live trip needs a **redeploy** (site), then a **bridge
refresh**, in that order. A bridge that sends `If-Match` to an old site is
harmless: the old site ignores the header. An old bridge against a new site
gets 428 on agent writes. So deploy the site and the bridge together per trip,
and never the site alone. **Per-PR regression plan: needed** (write semantics
on live trips; boundary path).

## Open questions

1. What form should the guard take? This spec proposes a row version (not
   `updated_at`, which has second resolution in SQLite's `datetime('now')`),
   required for agent writes and optional for a person in the site UI, for one
   release. Then make it required for everyone?
2. Should a stale agent write (409) be reported to the fleet monitor as a
   metric for "stale-state incidents per trip" (Guarantee A's KPI), or only
   logged?
