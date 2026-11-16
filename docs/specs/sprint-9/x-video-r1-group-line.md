# Video Release 1, part 1C: one line to the group when the plan changes

Status: approved (2026-11-16, by Dror: all open questions answered) · Issue: none yet (`x-` until filed) · Track: video plan, Release 1 · Size: L (two slices) · Tier: High
Security path: yes (a new sending path; a new site route behind `internal()`; `adapters/telegram.ts` gains a configurable API root that receives the bot token; one entry and one surface in `shared/feature-switches.js`) · Migration: yes · Live-trip behaviour: no, until the switch is turned on for a trip

Decision behind it: the approved plan "Make Kinerary match the marketing video" (Dror, 2026-11-14),
"Architecture choices" and Release 1 part 1C; the owner's spec v0.2
(`$KINERARY_NOTES_DIR/specs/2026-11-14-video-to-product-plan.md`), section 4 (defaults: "what changed" on by
default, the organizer can turn it off on the site and in words, nothing sent at night) and section 9 (check the
relay observation before proactive sending ships). It builds on `x-video-r1-site-look.md` (1B's `recent_change`)
and is delivered through `567-feature-switches.md` and `568-trip-rollout.md`.

## Problem

The video (23–30s and 45–50s) promises that when plans change, everyone stays together: the change shows on the
site, and the group hears about it. After 1B the site shows it. Nothing tells the group, and nothing in the
product can.

**Nothing sends on its own.**

- The control plane's only sender is the outbox dispatcher (`control-plane/api/src/outbox-dispatcher.ts`),
  started every 10 s in the API process (`control-plane/api/src/server.ts:313-348`). It sends the provisioning,
  sign-in and companion-introduction notices to an operator or an organizer (`messageTextFor`,
  `outbox-dispatcher.ts:90-147`). None of them goes to a group.
- The recipient is a chat id the enqueuer wrote into `notification_outbox.recipient`
  (`0013_sprint4.sql:25-29`; enqueuers in `plan-approval.ts:127-147`, `telegram-mini-app.ts:441-448`,
  `provisioner.py:1599-1623, 1963-1972, 2431-2481, 2622-2633`). The dispatcher sends to it as given
  (`outbox-dispatcher.ts:278`, `adapters/telegram.ts:113`). Nothing re-checks, at send time, that the chat
  still belongs to the trip.
- There is no lookup from a trip to its group. Every existing helper goes from a chat to a trip
  (`resolveChatRoute`, `control-plane/api/src/chat-router.ts:377-425`). A trip may bind several groups
  (`group-binding.ts:378-381`, owner decision 2026-10-16). Group and private chat are told apart only by the
  sign of the chat id (`0051_trip_person_links.sql:8-10`; `isPrivateChatId`, `identity.ts:188-190`).
- There is no idempotency key on the outbox, and the dispatcher assumes one caller and claims nothing
  (`outbox-dispatcher.ts:155-158, 198-205`).
- `TelegramNotificationAdapter` hard-codes `https://api.telegram.org` (`adapters/telegram.ts:6`). Only the relay
  honours `TELEGRAM_API_ROOT` (`relay/server.ts:163`, validator `relay/telegram-api.ts:28-42`). An outbox send
  therefore cannot be pointed at the fake Telegram (`control-plane/api/tools/fake-telegram.ts`) today.

**The control plane does not see plan changes.**

- Every plan write happens on the trip site and makes an immutable version: `cloneWith`
  (`server/living-journey.js:833-856`) writes an `itinerary_plan_versions` row with its parent and moves
  `trip_itinerary_state.active_version_id` (schema 156-166, 204-209). All writes are organizer-or-agent
  (`living-journey.js:1455-1671`). The control plane is not in that path.
- The site holds no key for calling the control plane. It holds `CONTROL_PLANE_EXCHANGE_KEY` for checking calls
  *into* it: `internal()` (`server/control-plane-auth.js:121-146`) takes the key from `x-api-key`, requires the
  trip id (header `x-control-plane-trip-id` on a GET, body `tripId` otherwise) to equal the site's own identity
  manifest (`control-plane.identity.json`, 66-72), and answers `TRIP_MISMATCH` otherwise.
- The runtime gateway uses that route family today: it resolves a trip's upstream through
  `GET /internal/runtime-routes/:tripId` (`control-plane/runtime-gateway/server.js:110-116`) and calls the site
  with the key (218-221, 241-243, 254-256). The control plane answers the route lookup from `runtime_routes`
  (state `ready`) and the trip's last succeeded job's `private_url`, against the
  `runtime_upstream_host_suffixes` allow-list (`control-plane/api/src/portal.ts:1940-1961`). The provisioner
  writes that row (`provisioner.py:1859`).

**So polling works without giving the site anything.** The control plane already knows each trip's private
address and already holds the key the site checks (`portal.ts:320`, `server.ts:130`). A GET from the control
plane to a new `internal()` route on the site needs no new credential on either side. The opposite direction,
the site pushing to the control plane, would need one, which the approved plan rules out.

**The relay observation was checked** (v0.2 section 9 asked for it). The finding is recorded in the
owner's private security notes, not here. The new path does not go through the relay (AC-29), so it neither
uses nor widens it; its fix is tracked separately (open question 1).

## Behaviour

The control plane looks at each switched-on trip about once a minute. When the plan has changed, it waits until
the changes settle, and then posts **one line** to the trip's group, in the trip's language. It does not post at
night. Site and group always agree, because both are worked out from the same plan versions by the same code.

**Gate.** A line is sent for a trip only when all four of these hold:

1. the switch `plan_change_group_line` is on for the trip (`featureEnabled`, per #567);
2. the trip's own setting `group_change_line` is on. It is **on by default**;
3. the trip has at least one open group binding;
4. the site answered the poll.

Anything uncertain counts as off, and nothing is sent.

**What counts as a change.** It is the net difference between the plan the group last heard about and the active
plan, item by item. Items are matched exactly as 1B and `markProvenance` match them (`source_ref`, then
`item_uid`, `living-journey.js:643-658`).

- **Updated.** One of the tracked fields changed. These are 1B's closed set: `time`, `date`, `title`
  (`text_he`/`text_en`), `place` (`location_url`/`waze_url`) and `type`.
- **Added.** The item is new.
- **Removed.** The item is gone. 1B cannot mark a removed item on the site, so its non-goals leave this to 1C.
- An item changed and then changed back is no change. Bookings, links, durations and ordering are not tracked
  (1B AC-18).
- Only items dated today or later in trip time count. A change to a day already past is not news.

**Merging.** A burst of edits becomes one line.

- The poller sends once the plan has been quiet for **5 minutes**: no new version for that long.
- During continuous editing it sends anyway once the oldest unsent change is **15 minutes** old.
- What it sends is the net difference at that moment. Three edits to the dinner time become "Dinner moved to
  19:00 (was 20:00)", and an edit undone inside the window sends nothing.

**Night.** Nothing is sent between **22:00 and 08:00 trip time**. The timezone is the site's own `tripTimeZone`
(`living-journey.js:1052-1055`): the organizer's override, then the config's, then UTC.

- A change made at night is held. At 08:00 its net difference is sent as one line.
- Items whose time has already passed by then are dropped from it, and when nothing remains, nothing is sent.

**The line.** It uses fixed templates, written by the control plane, in the trip's language. The language is the
site's `agent.default_language || meta.defaultLang || 'he'` (`server/server.js:1264`), returned by the poll.

| Change | English | Hebrew |
|---|---|---|
| time | Dinner moved to 19:00 (was 20:00) | ארוחת ערב עברה ל־19:00 (במקום 20:00) |
| date | Dinner moved to Friday (was Thursday) | ארוחת ערב עברה ליום שישי (במקום חמישי) |
| date and time | Dinner moved to Friday 19:00 (was Thursday 20:00) | ארוחת ערב עברה לשישי 19:00 (במקום חמישי 20:00) |
| added | Added: Winery visit, Thursday 16:00 | נוסף: ביקור ביקב, חמישי 16:00 |
| removed | Removed: Winery visit (Thursday) | בוטל: ביקור ביקב (חמישי) |
| title, place or type | Updated: Winery visit (Thursday) | עודכן: ביקור ביקב (חמישי) |

- The title is the item's text in the trip's language, falling back to the other language.
- "Today" and "tomorrow" replace the weekday when they apply.
- Times are 24-hour, and a rough-time word is used as `itineraryTimeLabel` gives it.
- **One change** is the line alone. **Several** are one message: a heading ("Plan updated" / "התוכנית עודכנה")
  and one line each, in plan order. After five lines comes "+N more on the trip site" ("ועוד N באתר הטיול").
- **Never in the line:** who made the change, a version note, a booking, a cost, a confirmation number,
  anything with organizer visibility, or any personal need. The line says what changed, never who changed it or
  why.

**Who receives it.** Every open group binding of the trip receives it. The chat is resolved by the control plane
from `telegram_chat_bindings`: this trip, `closed_at IS NULL`, a group chat id. It is re-checked at the moment of
sending, so a group that left in between gets nothing. No caller passes a chat id in.

**The setting.**

- **On the site.** When the switch is on, the organizer sees one toggle in the site's More menu, under trip
  settings: "Tell the group when the plan changes" / "לעדכן את הקבוצה כשהתוכנית משתנה". It is on. Members do not
  see it.
- **In words.** The organizer tells the companion, for example "stop posting plan changes to the group". The
  companion calls a new trip tool, `set_group_change_line`, and confirms what it did. The companion already
  honours a trip-settings request only where only the organizer can speak, which is the organizer's private chat
  (`profile-templates/familytrip-companion/templates/SOUL.md.tpl:232-238`). In the group it says the organizer
  handles that, and changes nothing. Words always work. The toggle is a shortcut.
- **Turning it off** stops sending at the next poll and does not save up a backlog: turning it back on starts
  from the plan as it is then.

**The way the group sees "Updated for everyone ✓".** 1B's line under the Today card means the change is in the
plan everyone's site serves. Once 1C is on for the trip, it also means the line went to the group. Nobody's
reading is tracked (Dror, 2026-11-14).

**Two slices**, each useful alone:

- **G1: the outbound path.**
  - The outbox gains a *target* ("this trip's group" | "this trip's organizer"). A target resolves to chats only
    from the trip's own open bindings, and is re-checked at send time.
  - The Telegram adapter honours the validated `TELEGRAM_API_ROOT`.
  - One message type, `trip_plan_changed`, is rendered from a structured payload.
  - G1 has no trigger of its own. 1D and Release 2 reuse it.
- **G2: the trigger.**
  - The site route and the shared diff.
  - The setting, on the site and as a trip tool.
  - The poller, with merging and night hold.
  - The switch.

## Acceptance criteria

G1: the outbound path

- AC-1 Given an outbox row of type `trip_plan_changed` with target `trip_group` for trip A, where A has one open
  group binding, when the dispatcher runs, then exactly one message reaches that group's chat id and no other
  chat.
- AC-2 Given that trip A's group binding was closed after the row was enqueued, when the dispatcher runs, then
  nothing is sent, and the row ends `skipped` with reason `binding_closed`.
- AC-3 Given a row with target `trip_group` whose binding names trip B (enqueued for A by a bug), when the
  dispatcher runs, then nothing is sent and the row ends `skipped` with reason `binding_trip_mismatch`.
- AC-4 Given a row with a target, then the dispatcher never reads `recipient` for it. Given a row with a target
  and a non-null `recipient`, the database refuses the insert (CHECK).
- AC-5 Given target `trip_organizer` for trip A, then the message goes only to an open private binding of A whose
  chat is the Telegram identity of A's owner. Given none, the row is `skipped` with reason `no_audience`.
- AC-6 Given two enqueues with the same `dedupe_key`, then the second is a no-op. Given a dispatcher crash after
  the send and before the state update, a rerun sends at most once more. This is today's documented at-least-once
  behaviour, and the dedupe key stops a duplicate *enqueue*, not a resend.
- AC-7 Given `TELEGRAM_API_ROOT` set to a loopback http URL, then `TelegramNotificationAdapter` sends there.
  Given it set to a non-https, non-loopback URL, then the API refuses to start with the existing validator's
  message. Given it unset, then it sends to `https://api.telegram.org` as today.
- AC-8 Given rows of every existing notification type, then their recipients, text and states are unchanged
  (the existing `outbox-dispatcher.test.ts` passes unmodified).

G2: the trigger

- AC-9 Given a trip with `plan_change_group_line` off, then the poller makes no request to its site and enqueues
  nothing.
- AC-10 Given the switch on and the trip's `group_change_line` off, when the plan changes, then nothing is
  enqueued and the cursor moves to the active revision. Given the setting is then turned on, then only changes
  made after that are sent.
- AC-11 Given the switch on, the setting on, an open group binding, and dinner changed 20:00 → 19:00 at 14:00
  trip time, when 5 minutes pass with no further version, then within the next poll exactly one message reaches
  the group: "Dinner moved to 19:00 (was 20:00)" for an English trip, "ארוחת ערב עברה ל־19:00 (במקום 20:00)" for
  a Hebrew one.
- AC-12 Given three edits within 4 minutes (dinner 20:00 → 19:30 → 19:00, and a winery visit added), then one
  message is sent after the plan is quiet for 5 minutes, holding the dinner line once (20:00 → 19:00) and the
  added line.
- AC-13 Given an item changed and changed back within the quiet period, then nothing is sent and the cursor
  advances.
- AC-14 Given edits every 3 minutes without pause, then a message is sent no later than 15 minutes after the
  first unsent change, and the edits after it are sent in a later message.
- AC-15 Given a change at 23:10 trip time to tomorrow's lunch, then nothing is sent before 08:00 trip time, and
  at the first poll at or after 08:00 one message carries it. Given a change at 23:10 to tonight's 23:30 item,
  then at 08:00 it is dropped, and with nothing else pending nothing is sent.
- AC-16 Given the trip timezone `Europe/Paris` and a control plane running in another timezone, then the night
  window is computed in `Europe/Paris`.
- AC-17 Given a trip seen by the poller for the first time, then the cursor is set to the active revision and
  nothing is sent, so a switch turned on never replays a trip's history.
- AC-18 Given a removed item, then the line reads "Removed: <title> (<weekday>)". Given an item on a past day
  changed, then it is not in the line.
- AC-19 Given more than five changes, then the message holds five lines and "+N more on the trip site".
- AC-20 Given the site unreachable, answering non-2xx, or returning a body that fails the schema, then nothing is
  enqueued, the cursor does not move, and one line `plan_change_poll.failed` is logged with the trip id and the
  error code only. The next successful poll sends the net difference.
- AC-21 Given the same plan, then the set of items with `recent_change` that 1B serves on `/api/itinerary/active`
  equals the set the poll reports as updated or added between the same two revisions. One function
  (`diffPlanVersions`) produces both.

The setting

- AC-22 Given an organizer, when they `PATCH /api/settings` with `{ "group_change_line": false }`, then it is
  stored, `GET /api/settings` returns it, and the timezone is unchanged. Given a body with only `timezone`, then
  `group_change_line` is unchanged. Given a non-boolean, then 400.
- AC-23 Given a member's session, when they `PATCH /api/settings`, then 403 (`organizerOrAgentRequired`, as
  today). Given the switch on, then the More menu shows the toggle to an organizer and not to a member.
- AC-24 Given the trip tool `set_group_change_line` with `enabled: false` on a write connection, then the setting
  is off and the tool returns the stored value. Given a read-only connection, then the tool is not listed
  (`server/trip-mcp/tools.js:150-151`).
- AC-25 Given a fresh trip site, then `group_change_line` reads true (on by default).

Boundary

- AC-26 Given `GET /api/internal/control-plane/plan-changes` without the exchange key, with a wrong key, or with
  `x-control-plane-trip-id` naming another trip, then 401, 401 and 403 `TRIP_MISMATCH` respectively, and no plan
  data is in the body.
- AC-27 Given the route answering, then no item in it carries `author`, `note`, `created_by`, `keep_both_with`, a
  revision's author, a booking field, or any key outside the contract below.
- AC-28 Given a sent line, then its text contains no participant name or username, unless one is part of an
  item's own title, and no `participant_needs` value. Proven by rendering a plan whose items sit beside
  organizer-only needs and a named author.
- AC-29 Given the relay's companion connection, then nothing in this work adds or changes a relay outbound path.
  The diff touches no file under `control-plane/api/src/relay/`.

Verification (from the approved plan)

- AC-30 Given the Alsace trip on Mac staging with the switch on, when dinner is changed 20:00 → 19:00 through the
  trip's connector during the day, then the trip's group gets exactly one line, and the site shows the Updated
  row (1B AC-27). Changing it back within 5 minutes sends nothing.

## Contracts

**Switch registry: `shared/feature-switches.js`.**

- The surface list `SURFACES` (`shared/feature-switches.js:30`) gains `control_plane`. The sender runs in the API
  process, which none of `relay`, `site` and `companion` names.
- One entry is added:

```js
{ name: 'plan_change_group_line', summary: 'Control plane posts one merged line to the trip group when the plan changes; organizer toggle on the site', surfaces: ['control_plane', 'site', 'companion'], memberVisible: true },
```

`memberVisible: true` is needed because the site's organizer toggle reads `features.plan_change_group_line`, and
#567 S2 serves only member-visible names. The name is harmless once the feature ships.

**Migration: `20261117090000_trip_audience_outbox.sql`**, header
`-- rollback: compatible — one new table and three nullable columns; the prior dispatcher marks a targeted row skipped (unknown type) and never sends it`.

- `control_plane.notification_outbox` gains:
  - `target text NULL CHECK (target IN ('trip_group','trip_organizer'))`;
  - `binding_id text NULL REFERENCES control_plane.telegram_chat_bindings(id)`;
  - `dedupe_key text NULL`.

  It also gains a CHECK `(target IS NULL OR (recipient IS NULL AND trip_id IS NOT NULL))` and a partial unique
  index on `(dedupe_key) WHERE dedupe_key IS NOT NULL`.
- `control_plane.plan_change_cursors`:
  - `trip_id text PRIMARY KEY REFERENCES control_plane.trips(id)`;
  - `revision_id text NOT NULL`, the plan the group last heard about, or the one first seen;
  - `pending_since timestamptz NULL`, when an unsent change was first seen;
  - `held_for_night boolean NOT NULL DEFAULT false`;
  - `last_polled_at timestamptz`, `last_sent_at timestamptz`, `updated_at timestamptz NOT NULL DEFAULT now()`.

  It holds no plan text: the site is the source and is asked again each time.

**Control plane API (`control-plane/api/src/`)**

- `trip-audience.ts` (new). `resolveTripAudience(db, tripId, target)` returns
  `Array<{ channel: 'telegram', bindingId, chatId }>`.
  - `trip_group`: open bindings of the trip whose chat id is a group id (not `isPrivateChatId`).
  - `trip_organizer`: the open private binding of the trip whose chat id is the owner's Telegram identity
    (`user_identities`, provider `telegram`, joined through `trip_memberships` role `owner`).
  - `confirmAudience(db, row)` re-reads `binding_id` at send time and requires `closed_at IS NULL` and
    `trip_id = row.trip_id`.
  - Telegram is the only channel today. WhatsApp later adds a source here, and no caller changes.
- `outbox-dispatcher.ts`:
  - For a row with `target`, the chat is `confirmAudience(...)`, never `recipient`. A failure is `skipped` with
    the AC-2/3/5 reason in a structured log, with no chat id.
  - `messageTextFor` gains `trip_plan_changed`, rendered by `plan-change-line.ts`.
- `plan-change-line.ts` (new). `renderPlanChangeLine(changes, { language, timeZone, now })` holds the fixed
  en/he templates above, and is pure and unit-tested.
- `enqueueTripMessage(db, { tripId, type, target, payload, dedupeKey })`.
  - It inserts one row per audience binding resolved at enqueue, with `binding_id` set, `recipient` NULL and
    `adapter` `'control-plane'`.
  - It is the only writer of targeted rows.
- `adapters/telegram.ts`. `TelegramNotificationAdapter` takes `apiRoot` in its config. `server.ts` passes
  `telegramApiRoot(process.env.TELEGRAM_API_ROOT)` (`relay/telegram-api.ts:28-42`, moved to a shared module if
  importing it from `relay/` crosses a boundary the build forbids).
- `plan-change-poller.ts` (new), started in `server.ts` beside the outbox loop.
  - It runs every 60 s with an in-process overlap guard, `unref`'d, and only when an adapter, a bot token and a
    `runtimeExchangeKey` exist.
  - **Which trips:** `featureEnabled(db, trip, 'plan_change_group_line')`, an open group binding, and a
    `runtime_routes` row in state `ready`.
  - **Resolving the site:** one helper, `runtimeUpstreamFor(db, tripId, suffixes)`, factored out of
    `portal.ts:1940-1961` so the gateway lookup and the poller apply the same allow-list.
  - **The request:** `GET <upstream>/api/internal/control-plane/plan-changes?since=<cursor.revision_id>`, with
    `x-api-key` and `x-control-plane-trip-id`, a 5 s timeout, and the body checked with zod.
  - **Each tick:**
    1. No cursor: store the active revision and stop.
    2. Active equals the cursor: clear `pending_since`.
    3. Setting off: move the cursor and stop.
    4. Otherwise set `pending_since` if unset, and wait while the newest version is under 5 minutes old and
       `pending_since` is under 15 minutes old.
    5. Night in trip time: set `held_for_night` and wait.
    6. Otherwise drop past items. If anything remains, enqueue with dedupe key
       `plan-change:<trip_id>:<active_revision_id>`. Move the cursor in the same transaction.

**Site (`server/`)**

- `server/recent-changes.js`, from 1B, exports `diffPlanVersions(db, fromRevisionId, toRevisionId)`. It returns
  `{ updated, added, removed }` with the item's `item_uid`, `date`, `time`, `text_he`, `text_en`, `fields` and
  previous `date`/`time`/`text_*` values. 1B's `recentChanges` becomes a call to it with the window's baseline.
  This is the one place a change is worked out (AC-21). If 1B is not merged first, G2 adds the module and 1B
  builds on it.
- `server/control-plane-auth.js` stays unchanged except that it exports `internal`, so a second module can
  mount a route behind it.
- `GET /api/internal/control-plane/plan-changes?since=<revision_id>` (new, in `living-journey.js`, behind
  `internal`):

```json
{
  "active_revision_id": "rev_…",
  "active_created_at": "2026-12-03T13:05:00Z",
  "since_known": true,
  "group_change_line": true,
  "time_zone": "Europe/Paris",
  "language": "he",
  "today": "2026-12-03",
  "now_local": "14:10",
  "changes": [
    { "kind": "updated", "fields": ["time"], "date": "2026-12-03", "time": "19:00",
      "previous_time": "20:00", "text_he": "ארוחת ערב", "text_en": "Dinner" }
  ]
}
```

  - `since` must be a revision in the active plan's parent chain. When it is not (an unknown id, or a
    restore-original that left the chain), `since_known` is false and `changes` is empty. The poller then moves
    the cursor and sends nothing, rather than describing an unrelated plan.
  - `changes` holds only items dated today or later in trip time.
  - The keys are closed: `kind`, `fields`, `date`, `time`, `previous_date`, `previous_time`, `text_he`, `text_en`,
    `previous_text_he`, `previous_text_en`.
  - The response carries `Cache-Control: no-store` (as `internal()` sets).
- `trip_settings` (`living-journey.js:151-156`) gains
  `group_change_line INTEGER NOT NULL DEFAULT 1 CHECK (group_change_line IN (0,1))`, added by an idempotent
  `ALTER` in `schema()`.
- `PATCH /api/settings` (1324-1340) becomes a partial update. `timezone` is validated only when present,
  `group_change_line` is a boolean, and `updated_by` is recorded as today. `GET /api/settings` returns it.
- `server/trip-mcp/tools.js` gains the write tool `set_group_change_line({ enabled: boolean })`, which calls
  `PATCH /api/settings`. Its description says it is a trip setting the organizer changes in their own chat.
- `trip-web`: one organizer-only toggle in the More menu, shown when `features.plan_change_group_line`.
  `site/modern/` is rebuilt and committed in the same PR, as in 1A/1B.

**Companion template.** `SOUL.md.tpl` is unchanged. The existing rule (232-238) already covers the setting. One
line is added to the trip-tools list naming `set_group_change_line`, so the model knows the tool exists. It
reaches a companion at its next rollout `companion` step (#568).

**Dependencies.**

- #567 S1 is built (`control-plane/api/src/feature-switches.ts:94`).
- #567 S2 is needed for the site toggle to render. The sender itself needs only S1.
- #568 R1 carries the site to the trip.
- 1B's `server/recent-changes.js` is shared (see above).

## Non-goals

- **The relay finding itself** (open question 1). This work must not route through it (AC-29).
- **The morning briefing (1D) and flight alerts (Release 2).** They will reuse G1's target and
  `enqueueTripMessage`. A held night line and a 1D briefing are not merged here.
- **A link in the line.** The trip site is one tap away in the group's pinned message. A per-trip deep link is a
  later decision.
- **Who changed it, why, and who read it.** Nothing about the author, the version note or reading is sent or
  stored.
- **Wording by a model.** Fixed templates only (approved plan: a bounded model call for wording, later).
- **Bookings, budget, photos, comments, day labels.** Only plan items, and only the tracked fields.
- **`proactive_level`.** That setting is how much the companion talks in a room
  (`20261016130000_group_proactive_level.sql:6-14`). The control plane's line is a notice, governed by its own
  setting.
- **WhatsApp.** The target is channel-neutral. No second channel is built.
- **Changing how the exchange key is shared** (open question 4).

## Security and boundary notes

- **The chat is never an input.**
  - A targeted row has no `recipient` (CHECK).
  - The dispatcher re-reads the binding by id at send time and requires it open and on the row's own trip
    (AC-2, AC-3).
  - Nothing outside the control plane can create a targeted row. No route, companion tool or site route
    enqueues one, and `enqueueTripMessage` is called only by the poller (and later by 1D and Release 2).
- **No new credential anywhere.**
  - The site gains no key and no outbound call.
  - The control plane uses the key it already holds for the gateway's lookups.
  - The new site route sits behind the existing `internal()` (key, trip-id match, owner mapping).
- **The line carries only member-visible plan facts.** These are an item's title, date, time and kind, which
  every member already reads on the site. There is no author, `note`, `created_by`, booking or need (AC-27,
  AC-28). The route's keys are a closed list, so a future column does not ride along.
- **Fail safe.** No switch, no setting, an unknown cursor, an unreachable site, an invalid body or a closed
  binding all mean nothing is sent. The poll never fails open into "send what we have".
- **The bot token's new reach.**
  - `TELEGRAM_API_ROOT` now also steers the API's adapter.
  - It goes through the relay's existing validator (https, or http to loopback only), so the token cannot be
    sent in clear to another host (AC-7).
- **Pre-existing, found while writing this spec (not widened here):**
  - **The relay observation** above (owner's private security notes).
  - **A finding about how the exchange key is shared**, also in the owner's private security notes. The poll
    adds one more read-only `internal()` route of the existing kind, adds no control-plane route accepting the
    key, and widens nothing (open question 4).
- **Boundary review is required.** It needs real request and response pairs:
  - the plan-changes route with no key, a wrong key, a wrong trip id and the right one;
  - the rendered line for a plan beside organizer-only needs and a named author;
  - the dispatcher refusing a closed binding and a cross-trip binding, against the fake Telegram's
    `/_control/sent`.

## Test plan

Tests are written first, from the criteria.

- `control-plane/api/test/trip-audience-db.test.ts`: AC-1 to AC-6. It runs against the caller's own
  `cptest_<name>` database in the shared test Postgres (hard rule 7), and never against `cptest` itself.
- `control-plane/api/test/plan-change-line.test.ts`: the en/he templates, merging, the "+N more" cap,
  today/tomorrow, rough times, and AC-28's no-names check.
- `control-plane/api/test/plan-change-poller-db.test.ts`: AC-9 to AC-20. It uses a stub site (a local HTTP
  server answering the route), an injected clock, and a timezone different from the process's for AC-16.
- `control-plane/api/test/outbox-dispatcher.test.ts`: unchanged, as AC-8's proof. Plus one case for
  `trip_plan_changed`.
- `control-plane/api/test/telegram-api-root.test.ts`: extended for the adapter (AC-7).
- `control-plane/api/test/plan-change-group-line.e2e.test.ts`, the sending proof from the approved plan.
  - It spawns `tools/fake-telegram.ts` as `group-conversation-window.e2e.test.ts:264` does, points
    `TELEGRAM_API_ROOT` at it, and sets up two trips. Each has a stub site and an open group binding (negative
    chat ids).
  - It reads `/_control/sent?chatId=` for each chat to assert:
    - only trip A's group gets A's line, and B's group gets nothing;
    - with A's setting off, nothing is sent;
    - at 23:00 in A's timezone nothing is sent, and at 08:00 one line is sent;
    - three edits inside the quiet period arrive as one message;
    - a closed binding gets nothing.
- `tests/` (trip-site suite):
  - `plan-changes-route.test.js`: AC-21, AC-26, AC-27, and the `since_known` rule. It is the boundary review's
    evidence.
  - `settings-group-line.test.js`: AC-22, AC-23, AC-25.
  - `trip-mcp-group-line.test.js`: AC-24.
- `trip-web` (vitest): the toggle renders for an organizer with the switch on, and not for a member or with the
  switch off.
- The registry's own test covers the new surface and entry.
- `scripts/preflight-deploy.sh` runs before the merge to `main`.
- Manual, on Mac staging (AC-30), with the switch on for `colmar-2026-2` only:
  - the organizer changes dinner 20:00 → 19:00 through the connector at a daytime hour in `Europe/Paris`;
  - the group gets one line;
  - the organizer changes it back inside 5 minutes, and nothing is sent;
  - the organizer says "stop posting plan changes" in his private chat, makes a change, and nothing is sent;
  - he turns it back on from the site.

  The trip is the organizer's own, and every change is reverted in the same session.

## Rollout and regression

- **Risk class: yes.** It adds a migration, a new sending path, a new `internal()` route, `shared/`, and the
  adapter's handling of the bot token. A regression plan and the owner's manual test go before the merge to
  `main`.
- **No live trip feels it on merge.** The switch is off for every trip. The migration adds a table and nullable
  columns, and changes no existing row. An existing outbox row has no target, so it keeps today's path (AC-8).
- **Target: Alsace (`colmar-2026-2`, bound to the staging control plane on the Mac), live for December 2.** It is
  second in the Release 1 cut order, after the site look (Dror, 2026-11-16). The path:
  1. **Preconditions, read-only, before build is briefed.** On staging:
     - the API has a web profile with `runtime_exchange_key_secret_ref` (`server.ts:130`), or the poller cannot
       start;
     - `colmar-2026-2` has a `runtime_routes` row in state `ready` whose `private_url` passes
       `runtime_upstream_host_suffixes`;
     - its site has `control-plane.identity.json` and `CONTROL_PLANE_EXCHANGE_KEY`;
     - it has an open group binding.

     Whichever is missing is set up by the operator as part of this work, not by a code change.
  2. G1 and G2 merged to `main`, with `site/modern/` rebuilt. 1B's `server/recent-changes.js` merged first, or
     carried here.
  3. A staging release made `available`, then `scripts/trip-rollout.py plan --trip colmar-2026-2`, then
     `execute`. The steps are site and companion (the new tool and its one template line). This is a deploy
     under hard rule 2, with one approval naming the commit, the trip and the steps.
  4. The staging API restarted on the same commit, for the poller and the migration. This is the staging
     control plane's own deploy, named in the same approval.
  5. `npm run feature -- set plan_change_group_line on --trip colmar-2026-2`, with `--live` if the trip is at
     `ready_private` or later.
  6. AC-30 on that trip.
- **Way back.** Switch the trip off; the next poll sends nothing. Or the organizer turns the setting off. Or
  roll the site back through `trip-rollout.py`. The migration is compatible: a rolled-back API skips targeted
  rows rather than sending them.

## Decisions

Taken by Dror, carried here:

1. The control plane sends, not the companion. There is one outbound path, its chat comes from the trip's own
   open binding and is never passed in, and the site holds no control-plane credential (approved plan,
   2026-11-14).
2. "What changed" is on by default, and the organizer can turn it off on the site and in words. Nothing is sent
   at night (v0.2 section 4).
3. "Updated for everyone ✓" means delivered to site and group, and nobody's reading is tracked (2026-11-14).
4. Release 1 order if time runs short: site look and Updated, then this line (2026-11-16).

Proposed in this draft:

5. The control plane polls the site, once a minute, through a new `internal()` route, and the site never calls
   out. This is confirmed workable above.
6. Both 1B's marks and this line come from one function, `diffPlanVersions`.
7. Merging uses a 5-minute quiet period with a 15-minute cap. The night window is 22:00–08:00 trip time, and
   past items are dropped at 08:00.
8. Every open group of the trip receives the line. Removed items are named.
9. The setting lives on the site (`trip_settings.group_change_line`). The companion changes it only in the
   organizer's private chat, by the rule it already has.
10. The registry gains the surface `control_plane`.

Answered by Dror, 2026-11-16:

11. **The relay finding is fixed on its own** (spec `x-relay-chat-scope.md`, approved 2026-11-16), in parallel
    and not a gate for 1C. 1C does not use the relay.
12. **A trip gets lines from the moment its group is connected**, not only from shortly before the trip. There
    is no date check: an open group binding with the setting and the switch on is enough.
13. **The night window is 22:00–08:00 trip time**, one constant for every trip.

14. **The exchange-key finding is handled on its own after the Alsace trip** (from 2026-12-07), with no change
    in 1C.

## Open questions

None open.
