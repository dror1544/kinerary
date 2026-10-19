# A corrected booking or plan item reaches the live trip site

Status: draft (2026-10-19) · Issue: #382 · Track: T1 · Size: L · Tier: High
Security path: yes (`server/server.js` boot seed; plan import) · Migration: no (site SQLite, additive columns) · Live-trip behaviour: yes

## Problem

Guarantee A, scenarios A1, A2 and A4 (`docs/reliability-guarantees.md:35-38`):
once a correction is committed, every surface shows the new value. On a
**re-provision** the site does not.

- **The files are rewritten.** A re-provision rewrites `trip.config.json` and
  `bookings.json` in the trip dir (`control-plane/worker/control_plane_worker/provisioner.py:472-483`,
  `:1225-1236`) and restarts the server (`:538-543`).
- **The database is not.** The server's DB is `DATA_DIR/trip.db`
  (`server/server.js:145`, `:172`). `DATA_DIR` is on the trip's persistent data
  mount, and is wiped only on a first provision (`control-plane/worker/control_plane_worker/compute.py:190-203`;
  `provisioning/adapters.py:260-276`, `:439-452`).
- **Bookings: the seed never re-applies.** `INSERT OR IGNORE … seed_key`
  (`server/server.js:706-724`) is a no-op once the row exists. Only a NULL
  `location_url` is back-filled (`:717`).
  - A hotel row's key is `hotel_<phase id>` (`transformer.py:2852`), so a
    corrected hotel date keeps its key and the old dates stay.
  - A structured anchor's key hashes `(type, name, date, confirmation)`
    (`:2906-2913`), so a corrected flight date makes a **new** key. A second row
    is inserted, the old one stays, and a seed row cannot be deleted (403,
    `:2702-2706`).
- **The plan is imported from config once.** `importPlanOnce` latches
  `legacy_owns_config = 1`, "never cleared" (`server/living-journey.js:849-862`,
  `:261-262`). A corrected config day item never reaches the active plan.
- **The result is a split-brain.** `/api/config` (from the file, through
  `sanitizeConfig`, `server/server.js:807-819`) shows the corrected value, while
  `/api/bookings` and the active plan show the old one. The companion's
  `get_config` (`mcp/mcp.js:401`, `server/trip-mcp/tools.js:166`) agrees with
  the file and disagrees with the tabs. That is an incident by MRD 5.3.
- **What is already right.** A booking edited with `PATCH` is joined live onto
  its linked plan item (`joinBooking`, `server/server.js:2891`;
  `living-journey.js:645`). Only text copied once by `import-from-bookings`
  (`:4139-4172`) goes stale.

## Behaviour

On every boot the site reconciles the seed with the files:

- A seeded booking or config-imported plan item that **nobody has edited on the
  site** takes the file's current values.
- One a person or agent **has** edited keeps its edit. The organizer sees it
  flagged "the trip file changed this booking — keep mine / use the new one".
  This is the stop editor's existing pattern for a rebuild under an override
  (`docs/sprint6-tracks.md`, PR #362 gap (c)).
- A seeded row whose key no longer appears in the file is **retired**, not
  deleted, if unedited. It is hidden from the tabs and kept in the DB. If it
  was edited, it is kept and flagged.

## Acceptance criteria

- AC-1 (A1, flight) Given a trip booted with flight anchor F on 3 Dec, when
  `bookings.json` is rewritten with F on 4 Dec (a new `seed_key`) and the server
  restarts on the same `DATA_DIR`, then `GET /api/bookings` shows one F, on 4
  Dec, and no row on 3 Dec. `/api/config`, `mcp/mcp.js get_config` and the
  trip-site connector's `get_config` show only 4 Dec.
- AC-2 (A1, hotel) Given hotel row `hotel_colmar` seeded 2–7 Dec and never
  edited, when the file says 2–6 Dec and the server restarts, then the row is
  2–6 Dec. If the hotel is linked to a stop, the stop is `booking_out_of_sync`
  (`server/trip-structure.js:1278-1291`). It is not silently moved.
- AC-3 (A2) Given a seeded booking edited on the site (`PATCH`), when the file
  changes the same field and the server restarts, then the edit stands, and
  `GET /api/bookings` (organizer) carries `seed_changed: {field: new value}`.
  Choosing "use the new one" (`POST /api/bookings/:id/accept-seed`) applies it.
- AC-4 (A4) Given a config day item imported to the plan and never edited, when
  the file corrects its time and the server restarts, then
  `GET /api/phases/:p/plan` and `GET /api/itinerary/active` show the new time
  in the same revision. If edited, the edit stands and the item is flagged as
  in AC-3.
- AC-5 Given a restart with **unchanged** files, then no row changes, no
  revision bumps, and no flag appears (idempotent; `plan-single-source.test.js`
  stays green).
- AC-6 Given a seeded row that is unedited and whose key is gone from the file,
  then it is absent from `GET /api/bookings` and still in the table with
  `retired_at` set. If it was edited, it is present and flagged
  `seed_removed: true`.
- AC-7 Given a member token, then `seed_changed` / `seed_removed` are absent.

## Contracts

- `server/server.js`:
  - additive columns on `bookings`: `seed_hash` (hash of the seeded field
    values at last apply) and `retired_at`;
  - additive columns on `phase_plan_items`: `config_hash`;
  - "edited" means the row's current values differ from the values its hash
    was taken from. #383's `row_version` can serve if it lands first;
  - the boot seed (`:706-724`) becomes reconcile: insert, update-if-unedited,
    flag, retire;
  - a new organizer-only `POST /api/bookings/:id/accept-seed` and its plan-item
    twin.
- `server/living-journey.js`: `importPlanOnce` keeps its latch for **adding**
  items (a deleted item stays deleted, `plan-single-source.test.js:133`). A new
  `reconcileConfigItems` updates unedited `config_ref` items in one itinerary
  revision.
- `control-plane/worker/.../transformer.py`: no change needed. Stable keys
  already exist, and AC-1 relies on retiring the old one.
- `trip-web/src`: the keep/use flag on a booking and a plan item (organizer view).
- `docs/reliability-guarantees.md`: A1, A2 and A4 rows updated when built.

## Non-goals

- Ordering between live edits (#383).
- Writing site edits back to the control-plane intake.
- Detecting staleness in the companion's own memory (#385 cross-boundary check).

## Security and boundary notes

- `sanitizeConfig()` is unchanged; `/api/config` already reads the file.
- The new flags and the accept route are organizer/agent-only
  (`organizerOrAgentRequired`, never `authRequired`) and carry no PIN or notes.
- `server/server.js` is a security path: boundary review with the request and
  response for AC-3 and AC-7.

## Test plan

Write first, against a real server restarted on the same `DATA_DIR` (the
`plan-single-source.test.js` harness):
- `tests/reliability-a-reprovision.test.js`:
  - `a corrected flight date replaces the old row on the next boot` (AC-1)
  - `an unedited hotel takes the corrected dates; a linked stop is flagged out of sync` (AC-2)
  - `a site edit survives a changed file and is flagged` (AC-3)
  - `an unedited plan item takes the corrected time in one revision` (AC-4)
  - `an unchanged file changes nothing` (AC-5)
  - `a row gone from the file is retired, not deleted` (AC-6)
  - `members never see the seed flags` (AC-7)
- `tests/mcp-trip-timezone.test.js`-style: `get_config on both MCP servers shows only the corrected value` (AC-1).
- `trip-web/src/booking-retry.test.tsx`: `keep mine / use the new one`.

Suites: `tests/`, `trip-web`. Worker: none.

## Rollout and regression

Site only. Every live trip feels it on its **next redeploy**. That boot
reconciles against whatever `bookings.json` it already has, so a trip whose
file drifted from its DB (old seeds, hand fixes) will retire or flag rows on
that first boot. **The regression plan must dry-run the reconcile on a copy of
each live trip's DB first** (read-only, metadata only, under the alpha-tester
policy). **Regression plan: needed, and High tier.**

## Open questions

1. Is retiring an unedited seed row that is gone from the file (AC-6) the right
   default, or should it always be flagged for the organizer instead?
2. Should a live trip's first reconciling boot be gated by a flag
   (`SEED_RECONCILE=1`), so each trip is turned on one at a time after its
   dry run?
