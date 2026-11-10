# A hotel booking added in chat reaches Plan and Map

Status: approved 2026-10-30 by Dror (decisions above) · refreshed against 4510301 · Issue: #419 · Track: T1 · Size: M · Tier: Normal
Security path: no (organizer-only stop routes are reused, not changed) · Migration: no · Live-trip behaviour: yes

> **Sprint 8 (2026-10-30): in scope.**

## Problem

Owner's gate-3 run, 2026-10-18 (`main` @ `81cafd3`, trip `france-2026`; run note
`$KINERARY_NOTES_DIR/run-notes/2026-10-18-gate3-manual-test.md`): a hotel told to
the companion in chat appeared on Reservations, not on Plan, not on Map. Owner:
must-fix.

What the code does today:

- `POST /api/bookings` (`server/server.js:2665-2694`) inserts one `bookings` row
  and nothing else. No booking is ever turned into a plan item, a stop or a pin
  by the server.
- Plan and Map follow the **stop**, never the booking. The Modern Plan reads
  `/api/itinerary/active` (`server/living-journey.js:1305-1316`), joining a
  booking only onto items that already carry `booking_id` (`serializeItinerary`,
  `:641-675`); Classic reads `phase_plan_items` only (`server/server.js:3049-3059`).
  The Modern Map builds pins from `config.phases[].accommodation` / `mapStop` and
  itinerary items (`mapPins`, `trip-web/src/App.tsx:1644-1689`; `MapView`
  `:1887-1892`); Classic from `cfg.map.stops` / `phase.mapStop`
  (`site/app.js:3412-3437`).
- The only link is a **second** tool call, `set_stop_from_booking`
  (`mcp/mcp.js:1165-1184`, `server/trip-mcp/tools.js:406-420` →
  `POST /api/stops/:id/from-booking`, `ops.fromBooking` in
  `server/trip-structure.js:1232`, route `:1588-1589`). It sets the stop's dates
  and hotel and creates `booking_<id>_checkin` / `_checkout` items
  (`upsertBookingItems`, `:1431-1472`).
- Whether that call happens is left to the model, and the instructions make it
  conditional on three things: the sender is the organizer, the chat is the
  organizer-private chat, and the stop is unambiguous (`SOUL.md.tpl:572-589`;
  operations `SKILL.md:31`, `:35-42`). The `add_booking` tool descriptions
  add a fourth: "if the organizer means this hotel to be that stop's"
  (`mcp/mcp.js:633-638`, `server/trip-mcp/tools.js:214-217`). **A hotel told in the family group is,
  by design, recorded and not linked.** The run note does not say which chat
  it was.
- PR #362's own record: "BEHAVIOUR NOT DEMONSTRATED". The eval cases in
  `profile-templates/familytrip-companion/eval/stop_editing_cases.json` were
  never run against a model (`docs/sprint6-tracks.md:871`).
- The call cannot be seen after the fact. `TOOL_NAMES` in
  `control-plane/api/src/analytics/contract.ts:120-138` lists `add_booking` but
  none of the five stop tools, nor `plan_open_days` (added on main by #133,
  `f7a05e0`), so a `set_stop_from_booking` call records no
  `tool_call_completed` event. The list is mirrored by hand in
  `.agents/hermes-plugins/assistant-events/__init__.py` (`KNOWN_TOOL_NAMES`),
  which has the same gap.
- **New since the draft (#481, `6436c5b`, 2026-10-29): a model may never have
  seen the instruction.** `SOUL.md.tpl` is ~52K characters; unpinned, Hermes
  capped a context file at 6% of the model's window (48K on a 200K-window
  model, less on the smaller free fallbacks) and dropped the **middle** of the
  file. The Stops section sits at characters ~39K–41K
  (`SOUL.md.tpl:565-595`), inside the zone #481's own commit message lists as
  dropped. #481 pins `context_file_max_chars: 120000` in
  `templates/config.overlay.yaml.tpl` and `test_template.py` fails if SOUL
  outgrows it — so on any companion rendered from 4510301 on, the whole
  section is in the prompt. Whether `france-2026`'s companion ran on a
  window small enough to drop it on 2026-10-18 is not known (open question 3).
- `france-2026` was built from `81cafd3`, so the tool and the instructions were
  present at render time. "Not refreshed" is unlikely. What remains is either a
  group-chat message (link refused by design) or a model miss.
- A Map pin needs coordinates even after linking. A search-style hotel link
  (`server/hotel-place.js:109-111`) has none, so the pin falls back to
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
  the Modern Stops editor shows it to the organizer as "not on the plan yet"
  with a one-tap **link to stop** ("use this hotel for <stop>"), which calls
  `from-booking`. Nothing links it without that tap. A member (non-organizer) token gets 403 on `GET /api/stops`
  as today (the existing auth-matrix test), so the field never reaches one.
- AC-3 Given the rendered companion profile, when SOUL and the operations skill
  are read, then the hotel procedure lists `set_stop_from_booking` as a required
  step after `add_booking` in the organizer-private chat, with no "if the
  organizer means" condition. The group/member case says the organizer can
  link it on the site, and does not say "privately".
- AC-4 Given `TOOL_NAMES` and the plugin's `KNOWN_TOOL_NAMES`, then `get_stops`,
  `update_stop`, `split_stop`, `set_stop_from_booking`, `move_plan_day` and
  `plan_open_days` are listed in both, so a live call emits
  `tool_call_completed`.
- AC-6 (already met on main by #481 — kept as a regression pin, no new code)
  Given the rendered companion overlay, `context_file_max_chars` is larger than
  the rendered `SOUL.md`, so the Stops section reaches every model whole
  (`profile-templates/familytrip-companion/tests/test_template.py`).
- AC-5 Given the eval cases `hotel_*` in `stop_editing_cases.json`, when they
  are run against the production companion model three times each, then each
  run calls `set_stop_from_booking` after `add_booking`. The runs are recorded
  in the PR with the model id. This is a manual or model gate; CI does not run
  it.

## Contracts

- `server/trip-structure.js`: `GET /api/stops` (`listStops`, `:1505-1538`)
  gains `unlinked_hotel_bookings` per stop (organizer/agent only; computed at serve time; no new table).
- `trip-web/src/stops-editor.tsx`, `trip-web/src/stops.ts`: the prompt and the
  call.
- `profile-templates/familytrip-companion/templates/SOUL.md.tpl` (Stops,
  `:565-595`) and `templates/skills/travel/familytrip-companion-operations/SKILL.md`
  (`:26-42`); `mcp/mcp.js:633-638` and `server/trip-mcp/tools.js:214-217`, the
  `add_booking` description; `.agents/skills/trip-site-operations/SKILL.md:64-71`,
  which has no stop step today.
- `control-plane/api/src/analytics/contract.ts:120-138` and
  `.agents/hermes-plugins/assistant-events/__init__.py` (`KNOWN_TOOL_NAMES`).
- No change to `sanitizeConfig()` or `/api/config`.

## Non-goals

- The server auto-linking a booking to a stop on create. Decided against
  (Dror, 2026-10-30): today's rule stands, a booking alone never moves a stop
  (`FRAMEWORK.md:200`, the #362 decision).
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
- `control-plane/api/test/assistant-events-contract.test.ts` (the test that reads `TOOL_NAMES`): `stop tools are on the tool allow-list`; `.agents/hermes-plugins/assistant-events/test_assistant_events_plugin.py`: the same list on the plugin side.

Suites: `tests/` (`cd tests && npm test`), `trip-web`, `profile-templates` unittest, and `control-plane/api` (unit, no database). Manual: AC-5 model runs, plus the `star` e2e scenario once (`docs/sprint6-tracks.md`, never run live).

## Rollout and regression

Three layers, each reaching a trip separately (`docs/control-plane-ops-runbook.md:29-69`):
- the site: on redeploy;
- the tool descriptions: on a bridge refresh (`setup-mcp.sh --restart-only`);
- the instructions: on a profile refresh (`scripts/companion-refresh-prompts.sh`).

A fourth layer: the assistant-events plugin reaches a companion only when it is reinstalled into the profile. #481's `context_file_max_chars` pin reaches a companion only on a profile refresh too, so an older companion may still be dropping the Stops section.

Live trips on the VM carry PR #362 only once the sprint-6 release is on the VM. Until then the instructions refer to tools those trips lack, so no live trip should get the profile refresh before its bridge has the tools. A **per-PR regression plan is needed** (live-trip behaviour; companion instructions).

## Decisions (Dror, 2026-10-30)

1. **No server auto-link; today's rule stands** — a booking alone never moves
   a stop. The fix is two-sided instead: the companion **always** calls
   `set_stop_from_booking` after `add_booking` for a hotel in the organizer's
   own chat (AC-3, AC-5), and the site shows the organizer any unlinked hotel
   booking with a one-tap "link to stop" (AC-2). A hotel from the group or a
   member is recorded and left for that tap.

## Open questions

1. (Open — no recommendation in the spec; not decided.) Which live trips get
   the redeploy plus the bridge and profile refresh for the PR #362 layer?
   This is Q3 in `docs/sprint6-tracks.md`, still unanswered. A rollout
   decision for the regression plan; no AC depends on it.
2. (Open — factual, to be checked during build.) Was the 2026-10-18 hotel sent
   in the group or in the organizer's DM? No AC depends on it: decision 1
   keeps both the group case (AC-2) and the DM case (AC-3, AC-5).
3. (Open — factual, to be checked during build.) Which model answered on
   `france-2026` on 2026-10-18 — the Codex primary or a fallback / `/model`
   choice with a smaller window (#481's cut middle)? No AC's wording depends
   on it (decision 1 fixes AC-3's wording); AC-5's model runs are made on a
   profile rendered with #481's overlay either way.

Size: unchanged (M). AC-4 grows by one tool and one mirrored file; AC-6 is already met.
