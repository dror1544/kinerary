# A corrected booking or plan item reaches the live trip site

Status: approved 2026-10-30 by Dror (decisions above) · refreshed against 4510301 · Issue: #382 · Track: T1 · Size: L · Tier: High
Security path: yes (`server/server.js` boot seed; plan import) · Migration: no (site SQLite, additive columns) · Live-trip behaviour: yes

> **Sprint 8 (2026-10-30): in scope.**

## Problem

Guarantee A, scenarios A1, A2 and A4 (`docs/reliability-guarantees.md:35-38`):
once a correction is committed, every surface shows the new value. On a
**re-provision** the site does not.

- **The files are rewritten.** A re-provision rewrites `trip.config.json` and
  `bookings.json` in the trip dir (`control-plane/worker/control_plane_worker/provisioner.py:473-484`; the
  sidecar is built at `:1259-1302`) and restarts the server (`deploy.sh …
  --sync-config --restart`, `:539-545`).
- **The database is not.** The server's DB is `DATA_DIR/trip.db`
  (`server/server.js:145`, `:172`). `DATA_DIR` is on the trip's persistent data
  mount, and is wiped only on a first provision (`control-plane/worker/control_plane_worker/compute.py:190-206`;
  `provisioning/adapters.py:260-277`, `_reset_trip_data` `:630-652`).
- **Bookings: the seed never re-applies.** `INSERT OR IGNORE … seed_key`
  (`server/server.js:707-726`) is a no-op once the row exists. Only a NULL
  `location_url` is back-filled (`:714-718`, `:725`).
  - A hotel row's key is `hotel_<phase id>` (`transformer.py:2855`), so a
    corrected hotel date keeps its key and the old dates stay.
  - A structured anchor's key hashes `(type, name, date, confirmation)`
    (`:2896-2916`; a free-text anchor hashes its `detail` instead), so a
    corrected flight date makes a **new** key. A second row is inserted, the
    old one stays, and a seed row cannot be deleted (403,
    `server/server.js:2729-2733`).
- **The plan is imported from config once.** `importPlanOnce` latches
  `legacy_owns_config = 1`, "never cleared" (`server/living-journey.js:855-868`,
  `:261-262`). A corrected config day item never reaches the active plan.
- **The result is a split-brain.** `/api/config` (from the file, through
  `effectiveConfig()` → `hotelPlaces.hydrateConfig` → `sanitizeConfig`,
  `server/server.js:808-820`) shows the corrected value, while
  `/api/bookings` and the active plan show the old one. The companion's
  `get_config` (`mcp/mcp.js:411`, `server/trip-mcp/tools.js:170`) agrees with
  the file and disagrees with the tabs. That is an incident by MRD 5.3.
- **What is already right.** A booking edited with `PATCH` is joined live onto
  its linked plan item (`joinBooking`, `server/server.js:2940`;
  `serializeItinerary`, `living-journey.js:641-657`). Only text copied once by
  `import-from-bookings` (`server/server.js:4188-4221`) goes stale.
- **Checked 2026-10-30: nothing on main since 03c0e1c addresses this.** No
  `seed_hash`, `retired_at`, `seed_changed` or `accept-seed` exists in
  `server/`; the seed and `importPlanOnce` are unchanged except for line
  shifts. `docs/reliability-guarantees.md:35-38` still marks A1, A2 and A4
  `partial`. One adjacent change: `/api/config` now serves the stop layer
  merged over the file (`effectiveConfig()`, PR #362), so the "file" side of
  the split-brain is "file + stop overrides".

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
  (`listStops`, `server/trip-structure.js:1522-1535`). It is not silently moved.
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
    was taken from. `seed_hash` is independent of #383's `row_version`
    (Decisions, 3): #382 is built first;
  - the boot seed (`:707-726`) becomes reconcile: insert, update-if-unedited,
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

## Decisions (Dror, 2026-10-30)

1. **Retire an unedited seed row that is gone from the file** (AC-6, the
   spec's default); an edited one is kept and flagged `seed_removed`.
2. **A stop set from a seeded hotel is flagged `booking_out_of_sync`, never
   moved at boot** (AC-2 as written: "It is not silently moved"). This also
   follows Dror's #419 decision of the same day: a booking alone never moves a
   stop.
3. **`seed_hash` stays independent of #383's `row_version`.** The spec lets
   `row_version` serve only if #383 lands first; #383 is a stretch item after
   this one, so it does not.

## Open questions

1. (Open — no recommendation in the spec; not decided.) Should a live trip's
   first reconciling boot be gated by a flag (`SEED_RECONCILE=1`), so each
   trip is turned on one at a time after its dry run? A rollout choice for the
   High-tier regression plan; no AC depends on it.
2. (Open, shared with #415's open question 1.) Whether a grouped flight item
   (#415) is excluded from `reconcileConfigItems`. **AC-4 depends on it** for
   a trip whose rebuilt config groups two flights; settle it before whichever
   of #382 and #415 is built second.

Size: unchanged (L).
