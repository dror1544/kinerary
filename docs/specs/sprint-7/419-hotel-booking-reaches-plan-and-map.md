# A hotel booking added in chat reaches Plan and Map

Status: draft (2026-10-19) · Issue: #419 · Track: T1 · Size: M · Tier: Normal
Security path: no (organizer-only stop routes are reused, not changed) · Migration: no · Live-trip behaviour: yes

## Problem

Owner's gate-3 run, 2026-10-18 (`main` @ `81cafd3`, trip `france-2026`; run note
`$KINERARY_NOTES_DIR/run-notes/2026-10-18-gate3-manual-test.md`): a hotel told to
the companion in chat appeared on Reservations, not on Plan, not on Map. Owner:
must-fix.

What the code does today:

- `POST /api/bookings` (`server/server.js:2638-2668`) inserts one `bookings` row
  and nothing else. No booking is ever turned into a plan item, a stop or a pin
  by the server.
- Plan and Map follow the **stop**, never the booking. The Modern Plan reads
  `/api/itinerary/active` (`server/living-journey.js:1299-1310`), joining a
  booking only onto items that already carry `booking_id` (`:645-672`); Classic
  reads `phase_plan_items` only (`server/server.js:2998-3008`). The Modern Map
  builds pins from `config.phases[].accommodation` / `mapStop` and itinerary
  items (`trip-web/src/App.tsx:1643-1688`, `:1886-1891`); Classic from
  `cfg.map.stops` / `phase.mapStop` (`site/app.js:3378-3404`).
- The only link is a **second** tool call, `set_stop_from_booking`
  (`mcp/mcp.js:1106-1125`, `server/trip-mcp/tools.js:369-384` →
  `POST /api/stops/:id/from-booking`, `server/trip-structure.js:988-1084`,
  route `:1342`). It sets the stop's dates and hotel and creates
  `booking_<id>_checkin` / `_checkout` items (`:1187-1224`).
- Whether that call happens is left to the model, and the instructions make it
  conditional on three things: the sender is the organizer, the chat is the
  organizer-private chat, and the stop is unambiguous (`SOUL.md.tpl:572-585`;
  operations `SKILL.md:31`, `:38-42`). **A hotel told in the family group is,
  by design, recorded and not linked.** The run note does not say which chat
  it was.
- PR #362's own record: "BEHAVIOUR NOT DEMONSTRATED". The eval cases in
  `profile-templates/familytrip-companion/eval/stop_editing_cases.json` were
  never run against a model (`docs/sprint6-tracks.md:871`).
- The call cannot be seen after the fact. `TOOL_NAMES` in
  `control-plane/api/src/analytics/contract.ts:120-139` lists `add_booking` but
  none of the five stop tools, so a `set_stop_from_booking` call records no
  `tool_call_completed` event.
- `france-2026` was built from `81cafd3`, so the tool and the instructions were
  present at render time. "Not refreshed" is unlikely. What remains is either a
  group-chat message (link refused by design) or a model miss.
- A Map pin needs coordinates even after linking. A search-style hotel link
  (`server/hotel-place.js:109-110`) has none, so the pin falls back to
  `phase.mapStop`.

## Behaviour

When the organizer tells the companion about a hotel in their private chat, the
Journey/Plan tab shows check-in on the first night and check-out on the last,
and the stop shows the hotel and its dates. The Map shows the stop's card with
the hotel name, with a pin wherever the stop has coordinates.

When a hotel arrives from the group or from another member, the booking is
recorded and the stop is left alone. In that same group reply the companion says
the organizer can confirm which stop it belongs to on the site, and it does not
promise a private follow-up (#418). The site then shows the organizer an
unlinked hotel booking as "not on the plan yet", with a one-tap link to its
stop. The hotel is never silently left off.

## Acceptance criteria

- AC-1 Given a provisioned trip with a stop Colmar 2–7 Dec and no hotel, when an
  approved hotel booking is created for phase Colmar with dates 2–7 Dec and
  `set_stop_from_booking` is called, then `GET /api/itinerary/active` has one
  check-in item on 2 Dec and one check-out item on 7 Dec carrying the booking
  id, `GET /api/config` shows Colmar's `accommodation.name` as the hotel, and
  the Map's stop list (`MapView`) includes Colmar with that hotel name. (The
  existing route proven end to end, through `mcp/mcp.js` against a real trip
  server.)
- AC-2 Given an approved hotel booking whose phase is a real stop and which no
  stop is set from, when an organizer loads the site, then `GET /api/stops`
  reports it under that stop as `unlinked_hotel_booking` (id, name, dates), and
  the Modern Stops editor offers "use this hotel for <stop>", which calls
  `from-booking`. Given a member (non-organizer) token, the field is absent.
- AC-3 Given the rendered companion profile, when SOUL and the operations skill
  are read, then the hotel procedure lists `set_stop_from_booking` as a required
  step after `add_booking` in the organizer-private chat, with no "if the
  organizer means" condition. The group/member case says the organizer can
  link it on the site, and does not say "privately".
- AC-4 Given `TOOL_NAMES`, then `get_stops`, `update_stop`, `split_stop`,
  `set_stop_from_booking` and `move_plan_day` are listed, so a live call
  emits `tool_call_completed`.
- AC-5 Given the eval cases `hotel_*` in `stop_editing_cases.json`, when they
  are run against the production companion model three times each, then each
  run calls `set_stop_from_booking` after `add_booking`. The runs are recorded
  in the PR with the model id. This is a manual or model gate; CI does not run
  it.

## Contracts

- `server/trip-structure.js`: `GET /api/stops` gains `unlinked_hotel_bookings`
  per stop (organizer/agent only; computed at serve time; no new table).
- `trip-web/src/stops-editor.tsx`, `trip-web/src/stops.ts`: the prompt and the
  call.
- `profile-templates/familytrip-companion/templates/SOUL.md.tpl` (Stops,
  `:565-593`) and `templates/skills/travel/familytrip-companion-operations/SKILL.md`
  (`:26-42`); `mcp/mcp.js:623-628` and `server/trip-mcp/tools.js:189-192`, the
  `add_booking` description; `.agents/skills/trip-site-operations/SKILL.md:64-71`,
  which has no stop step today.
- `control-plane/api/src/analytics/contract.ts:120-139`.
- No change to `sanitizeConfig()` or `/api/config`.

## Non-goals

- The server auto-linking a booking to a stop on create. This is open question 1.
- Geocoding a hotel to get a pin (`hotel-place.js` is unchanged).
- Writing stop edits back to the control-plane intake (PR #362 gap (a)).

## Security and boundary notes

`unlinked_hotel_bookings` is organizer/agent-only, like the rest of
`/api/stops`. It carries no PIN, notes or confirmation. `/api/config` is not
touched, so the allow-list invariant is not engaged. A member-token request in
the HTTP test proves the field is withheld.

## Test plan

Write first:
- `tests/trip-stops-http.test.js`:
  - `an approved hotel booking under a stop it does not set is listed as unlinked, to the organizer only`
  - `after from-booking the booking is no longer unlinked`
- `tests/mcp-trip-stops.test.js`: `add_booking then set_stop_from_booking puts check-in and check-out on the active itinerary and the hotel on the stop` (AC-1, against the real trip server).
- `trip-web/src/stops-editor.test.tsx`: `an unlinked hotel offers to set the stop and calls from-booking`.
- `profile-templates/familytrip-companion/tests/test_stop_editing.py`: `test_hotel_procedure_links_unconditionally_in_the_organizer_chat`, `test_group_hotel_reply_does_not_promise_a_private_follow_up`.
- `control-plane/api/test/assistant-events-contract.test.ts` (the test that reads `TOOL_NAMES`): `stop tools are on the tool allow-list`.

Suites: `tests/` (`cd tests && npm test`), `trip-web`, `profile-templates` unittest, and `control-plane/api` (unit, no database). Manual: AC-5 model runs, plus the `star` e2e scenario once (`docs/sprint6-tracks.md`, never run live).

## Rollout and regression

Three layers, each reaching a trip separately (`docs/control-plane-ops-runbook.md:29-60`):
- the site: on redeploy;
- the tool descriptions: on a bridge refresh (`setup-mcp.sh --restart-only`);
- the instructions: on a profile refresh (`scripts/companion-refresh-prompts.sh`).

Live trips on the VM carry PR #362 only once the sprint-6 release is on the VM. Until then the instructions refer to tools those trips lack, so no live trip should get the profile refresh before its bridge has the tools. A **per-PR regression plan is needed** (live-trip behaviour; companion instructions).

## Open questions

1. Should the server link a hotel booking to its stop by itself, instead of relying on the model? For example: when the booking's phase is a stop with no hotel and the dates fit, or always, with an undo. This would make AC-3 and AC-5 belt-and-braces rather than the fix. Today's rule (`FRAMEWORK.md:200`) is "a booking alone never changes a stop", and that rule was a #362 decision.
2. Which live trips get the redeploy plus the bridge and profile refresh for the PR #362 layer? This is Q3 in `docs/sprint6-tracks.md`, still unanswered.
3. Was the 2026-10-18 hotel sent in the group or in the organizer's DM? If you know, it decides whether the group case (AC-2) or the model miss (AC-3, AC-5) is the main fix.
