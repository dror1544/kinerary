# The bot sets the trip group's Telegram photo from the trip logo

Status: approved (2026-11-24, by Dror; D1 of x-trip-logo.md: on request) → in build after x-trip-logo · Issue: none yet · Track: video look · Size: M · Tier: High
Security path: yes (control plane acts in a family's Telegram group) · Migration: no (O2) ·
Live-trip behaviour: yes, once the switch is on for a trip

Depends on: `x-trip-logo.md` (the logo it uses). It is a separate PR because it is risk-class: control-plane
behaviour that writes into a family's group, so it needs a regression plan and the owner's manual test.

## Problem

After a trip has a logo, the family's Telegram group still shows whatever photo it had. Changing it means an
admin does it by hand on a phone. The bot that sits in the group (the shared trip bot, which the relay and the
outbox send as) could do it, but only if Telegram has made it an admin with the right to change group info.
Nothing in the product calls `setChatPhoto` today.

## Behaviour

- **On request, never as a side effect** (D1 in `x-trip-logo.md`). An organizer can ask in four places: after
  a logo change, the website offers "Also make it the Telegram group photo"; the companion offers it after
  uploading a logo; the organizer can ask the companion outright ("put the logo as the group photo"); and
  the trip connector has a tool for it.
- **The bot checks first, then acts, then tells the truth.** It looks up its own rights in the group. With
  `can_change_info` it sets the photo and reports "done". Without it, it says so in words a person can act on:
  "Make the bot an admin with 'Change group info', then ask again." With no group bound to the trip, it says
  there is no group.
- **Organizers only.** A member's request is refused by the companion, and the route refuses a member's
  session.
- **Only the trip logo.** The photo set is the logo as it is at the moment of the request. No other image goes
  this way.

## Acceptance criteria

- AC-1 Given switch `trip_group_photo` is on, a stored logo, an open group binding and the bot an admin with
  `can_change_info`, when an organizer requests it, then within two minutes the group's photo is the logo, and
  the request reads `done` on the site and through both MCPs.
- AC-2 Given the bot is a member but not an admin, or an admin without `can_change_info`, then nothing is sent
  to `setChatPhoto`, and the request reads `bot_lacks_rights` with the instruction above.
- AC-3 Given no open group binding for the trip, then the request reads `no_group`. Given no logo, the request
  is refused at once with `no_logo`.
- AC-4 Given a member's JWT, then 403. Given the switch off, then 409 `feature_off`. The website offer is not
  drawn, and the trip connector does not list the tools. The companion bridge (`mcp/mcp.js`) is one process that
  does not know the trip when it lists its tools, so its tools stay listed. They answer `feature_off` and request
  nothing, as the trip-logo tools do (x-trip-logo.md AC-9). Amended by the lead on 2026-11-25, at build time.
- AC-5 Given a request, then the chat is resolved by the control plane from the trip's own open
  `telegram_chat_bindings` row and re-checked at send time (`trip-audience.ts`). No caller supplies a chat id.
- AC-6 Given Telegram answers an error (rate limit, photo rejected), then the request reads `failed` with
  Telegram's description. It is retried at most as the outbox retries any send, never in a loop.
- AC-7 Given two requests in a row, then only the newest logo is sent. A request older than 24 hours that never
  ran is dropped as `expired`.

## Contracts

**The road is the one the plan-change group line already uses** (`control-plane/api/src/plan-change-poller.ts`):

1. The site records the request in trip SQLite (`trip_group_photo_requests`: id, logo_hash, requested_by,
   requested_at, status, detail). Routes: `POST /api/group-photo` and `GET /api/group-photo`, both
   `organizerOrAgentRequired` and switch-gated.
2. A control-plane poller asks each switched-on trip's site through the runtime gateway (per-trip key, K2 of
   `597-per-gateway-and-per-trip-keys.md`) for a pending request and the logo bytes (640×640 PNG, the size
   Telegram wants).
3. It enqueues one targeted outbox row (`target = trip_group`, new type `trip_group_photo`). The dispatcher
   resolves the chat from the binding, calls `getChatMember(chat, bot id)`, checks `status = administrator`
   and `can_change_info` (or `creator`), and then calls `setChatPhoto` with the PNG as multipart `InputFile`.
   That multipart call is a new method on the Telegram adapter.
4. The result goes back to the site through the gateway, and the site's request row takes `done` /
   `bot_lacks_rights` / `no_group` / `failed` / `expired`.

**Why not the site directly.** The site holds `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for older trips, but
the plan-change line deliberately keeps the site from calling out to Telegram for group writes. It also keeps
the chat resolved from the control plane's bindings, not from the site's env (AC-5). Open item O1 checks
whether any trip's group bot differs from the outbox's bot.

**Migration: none.** `notification_outbox.notification_type` has had no CHECK since `0013_sprint4.sql`, so
`trip_group_photo` is a new value, not a schema change. The request's state lives in the site's SQLite (step 1),
so the poller needs no cursor table: each poll asks the site for its oldest pending request, and the site marks
it `sending` when it hands it out. A request left `sending` for 10 minutes goes back to `pending`.

**Switch:** `trip_group_photo`, surfaces `site`, `companion`, `control_plane`, `memberVisible: true` (the
site's offer reads it).

**Tools:** `mcp/mcp.js` `set_group_photo_from_logo {}` and `get_group_photo_status {}`. The trip connector
gets the same two. The companion skill gets "offer after a logo change; ask before doing it; report the real
status".

**Files expected to change:** `server/server.js` (or a new `server/group-photo.js`), `server/living-journey.js`,
the runtime gateway's internal routes, a new `control-plane/api/src/group-photo-poller.ts`,
`control-plane/api/src/outbox-dispatcher.ts`, `control-plane/api/src/adapters/telegram.ts`, possibly a
migration, `shared/feature-switches.js`, both MCPs, `trip-web/src/App.tsx`, the companion skill, and tests.

## Non-goals

- Putting back the previous group photo. Telegram admins can do that in the app. The bot does not keep it.
- Setting the group's title or description.
- Any image other than the trip logo. Arbitrary group photos from chat are a different trust question.
- WhatsApp groups (`625-whatsapp-via-relay.md` has no group-photo path).

## Open items (resolved 2026-11-24, from the code)

- O1 **Same bot.** The outbox sends with the signup bot's token (`control-plane/api/src/server.ts`,
  `outboxBotToken`), and the signup bot is the trip bot that the relay runs in bound groups. A deployment whose
  outbox token is a different bot gets `bot_lacks_rights` from the `getChatMember` check, never a write from the
  wrong bot. The staging test confirms this on the Mac's bot pair.
- O2 **No migration** (see Contracts).

## Rollout and regression

Risk-class (control-plane behaviour that writes into a family's group), so it gets a regression plan
(`regression-planner`) and the owner's manual test on a staging trip's group before the merge to `main`. Ships
with `trip_group_photo` off. It goes on for a staging trip, then for one real trip on request.
