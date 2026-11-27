# Telegram groups from the dashboard, like WhatsApp groups

Status: draft (2026-11-27) · Issue: #690 · Track: chat connection · Size: M · Tier: High
Security path: yes (three authenticated owner-only routes; a second way to bind a group to a trip) · Migration: no · Live-trip behaviour: yes (the relay's Telegram `/start` handling gains one branch)

Owner decision 2026-11-27 for #690: "yes add Telegram groups". PR #692 put the Telegram and WhatsApp cards side by side; the
WhatsApp card can add a group, list the linked groups and Unlink one. The Telegram card cannot, because a Telegram group is
bound only from the bot (`/group`, a `?startgroup=` link, a pasted `KIN-` token). This spec gives the Telegram card the same
three actions through the SAME binding mechanism.

## What exists today (read before building)

- **Binding a group.** `/group` in the organizer's private chat issues a `KIN-` token (`issueGroupBindingToken`, one live token
  per trip in `telegram_group_binding_tokens`, reusable, bound to the issuing Telegram user id). Posted in a group as `/group KIN-…`
  or arriving as the `?startgroup=<token>` payload (`/start@bot KIN-…`, posted by the person who added the bot),
  `redeemGroupBindingToken` opens a `telegram_chat_bindings` row, or MOVES a group bound to another trip when the sender is the main
  organizer of both (`senderMayMoveGroup`). Relay: `relay/dispatch.ts`, "A binding token posted in a group".
- **Unbinding a group.** There is none. The only closes are `group_moved`, `trip_destroyed` (teardown), `operator_cleared`, and
  `telegram_unlinked` (a private chat). The relay does not read a bot's removal from a group (`my_chat_member` is read only for a
  join). So there is no existing Telegram group unbind behaviour to keep; Unlink below defines it, and copies WhatsApp's (spec 625
  AC-15): the binding closes and nothing is posted to the group. Unlike WhatsApp it then also makes the bot leave (D6).
- **`chat_binding_codes`** (migration 20261122090000) is platform-neutral by name and its CHECK allows `telegram`, but only
  `whatsapp` rows are written today. Its codes are single-use, stored as a digest, ten live per trip, and carry the issuing account.
  #661 (named in the brief) is a flaky WhatsApp lock-order test, not a Telegram path.
- **The trip site's `/api/agent/telegram-group`** is a different thing: it stores the group's chat id in the trip site's own
  environment so the SITE can post there. It is not a binding and is untouched.

## Problem

A Telegram group can be bound only by an organizer who finds the bot's `/group` command in a private chat. The dashboard, where the
owner already links their own Telegram, cannot add the companion to a group, shows no groups, and cannot unlink one.

## Behaviour

On the trip page's Telegram card and in the trip card's Telegram menu, for the trip's OWNER with a full (password or Google) session:

1. **Add the companion to a Telegram group in one click.** A link `https://t.me/<bot>?startgroup=<code>&admin=change_info+pin_messages+invite_users`
   (the builder the greeting and `/group` already use, `groupAddUrl`) is ready before the click, minted by the same one-click rules as
   `one-click-link.tsx`. Telegram asks which group, adds the bot with the admin rights it needs and posts `/start@<bot> <code>` there
   from the person who added it. That redemption binds the group.
2. **See the linked groups**: the group's name and the day it was linked.
3. **Unlink one.** It asks first. It closes the binding and then the bot **leaves the group silently**: nothing is posted there
   (members see only Telegram's own "left" line). The card says so. It can be added again from the same page.

A co-organizer, a member, another owner and a Telegram-minted session see none of this and get 404 or 403 from every route.

## Design decisions (each a fork, recorded)

- **D1: the dashboard mints a `chat_binding_codes` row (`platform = 'telegram'`, `kind = 'group'`), not a `KIN-` token.** Rejected: minting
  into `telegram_group_binding_tokens`. That table holds one reusable token per trip bound to a raw Telegram user id. The dashboard has
  a user id and only a digest of the Telegram id, so it could not fill `issued_to_telegram_user_id`; a migration would be needed to
  make it nullable; and every mint (the card mints on view) would silently replace the token the owner holds in their private chat
  and the one in the greeting (`ON CONFLICT (trip_id)`), and the copy "works once" would be false for a reusable token. The code table
  is single-use, allows ten live per trip, already records the issuing account, and needs no migration. The binding itself (open, or
  move) is NOT duplicated: the body of `redeemGroupBindingToken` becomes one function, `bindGroupToTrip`, called by both redeemers.
- **D2: who may redeem is checked on the Telegram side, not trusted from the code.** The sender (Telegram's own `from.id`) must pass
  `isMainTripOrganizer` for the code's trip, the same proof `/group` asks for before it issues anything, and the code's issuing
  account must still be an active owner. A forwarded link redeemed by anyone else binds nothing and is not spent. This is
  stricter than WhatsApp's group code, which binds for whoever sends it (spec 625 AC-10), because a Telegram identity is checkable
  and WhatsApp's is not. It means the owner must have linked Telegram first; the card says so instead of minting a link that cannot work.
- **D3: Unlink closes with `closed_reason = 'dashboard_removed'`** (WhatsApp's), and posts nothing to the group. Rejected: `telegram_unlinked`, which
  Restore reopens (`telegram-link-token.ts`) and which means a private chat. A group's `/proactive` level and conversation window stay on the
  closed row; they are history.
- **D4: the group's name is stored in `telegram_chat_bindings.chat_title`** (the column 20261122090000 added), written by a statement of
  its own after the bind, never inside the bind's INSERT, so the Telegram bind keeps working on a database without the column. It
  is written when a group is bound and refreshed (change-only, remembered per process) from messages of a bound group, so groups bound
  before this release gain a name at their next message. Until then the list says "unnamed group". Titles are text people chose: cleaned
  (`cleanChatText`), shown as text, never acted on. **The write can never stall the relay** (regression plan, 2026-11-27): the poller
  handles one update at a time and the database has no lock or statement timeout of its own, so the write runs in a transaction with
  `lock_timeout` 500 ms and `statement_timeout` 2 s; on timeout it is logged (`trip_bot.group_title_not_recorded`, SQLSTATE only) and that
  chat is not tried again for 30 seconds. Rejected: fire-and-forget, which needs no timeout but leaves an unbounded write nobody awaits.
- **D5: no feature switch (confirmed by the owner, 2026-11-27).** The Faster-delivery rule says a new feature ships off. This is not a new capability: the owner has had it
  through `/group` since 2026-09; the dashboard is a second door onto the same lock, owner-only, and every route answers as if absent
  to anyone else. Recorded for the owner to overrule (a switch would be a change to `shared/feature-switches.js`, outside this task).
- **D6: Unlink makes the bot LEAVE the group (owner, 2026-11-27).** The relay's unbound-group answer is unchanged ("I don't have a trip
  for this chat yet"; `relay-dispatch.test.ts` "an unbound group is told so, not left in silence" pins that on purpose), and with the admin
  rights the add link asks for the bot sees every message, so a group that was Unlinked but still had the bot would be told so again and
  again. Leaving removes that. The route (1) closes the binding, then (2) calls the Bot API's `leaveChat` for that chat through the outbox's
  own Telegram adapter, the bot that is in the group and the credential path the group photo already uses (`portal.telegramGroups`, wired
  in `server.ts`); no new token. **Best effort:** a failure (the bot is already gone, Telegram or the network is down) is logged as
  `telegram_groups.leave_failed` with the HTTP status and no chat id, the Unlink still answers 200 and stays done, and nothing retries.
  A deployment with no real Telegram adapter closes the binding and logs `telegram_groups.leave_unavailable`.
  **Order, checked:** close first, because the closing statement is also what decides WHICH chat is left (`UPDATE … RETURNING chat_id`), so a
  group moved to another trip BEFORE the close is not found and the bot is not taken out of it. A bind AFTER the close and before the leave
  is caught by a check just before the call (`leaveClosedTelegramGroup` skips the leave when the chat has an open binding again). That
  check and the call are two steps, so a bind landing between them is not caught: the bot leaves a group another trip just bound, and
  nothing closes a binding when the bot leaves, so that trip's group has no bot until someone adds it back. It needs the owner's Unlink
  and another trip's main organizer binding the same group within milliseconds. Recorded, not closed.
  Rejected: leave first, which would need the binding row locked across an HTTP call to be safe against that race. The residue is one
  Telegram call's time (bounded at 5 s, normally well under a second) in which the bot is still in a group it has no trip for; a message in
  that window gets the unbound answer once. Nothing is posted by the leave itself.
- **D7: what the relay remembers for a group is cleared on every fresh bind** (regression plan, 2026-11-27), not only on a move. A group
  Unlinked from the dashboard has no open binding, so binding it to another trip is not a "move", yet overheard messages and held
  attachments (up to about 15 minutes) would reach the new trip's assistant. `dispatch.ts` clears them whenever a redemption did not
  re-bind the same trip, for both the `KIN-` and `KWA-` redeemers. A re-bind of the same trip keeps them.
- **D8: redeeming a code reads the issuer's membership `FOR SHARE`,** as the WhatsApp redeem does, so a concurrent `removeMember` and a
  redemption take turns. Lock order: code row, membership, the group's binding, `trips`.

## Acceptance criteria

Routes (all under policy `account` in `portal-scope.ts`; none uses `authRequired`):

- AC-1 Given the owner (active `owner` membership with dashboard access) on a full session, a `POST /v1/trips/:id/telegram-group-link`
  answers 201 with `{ link, expiresAt }`: `link` is `https://t.me/<bot>?startgroup=KWA-XXXXXXXX&admin=change_info+pin_messages+invite_users`, `expiresAt` is
  `telegramLinkTtlSeconds` ahead (default 900), the response is `no-store`, one `chat_binding_codes` row exists (`telegram`, `group`, the owner as issuer,
  state `issued`, digest only), and the trip's `KIN-` token is untouched.
- AC-2 Given a member, a co-organizer (`organizer` membership), another account that owns another trip, a user with no membership, a
  trip that does not exist, a retired trip, then the same route answers one 404 `NOT_FOUND`, and writes nothing.
- AC-3 Given a Telegram-minted (scoped) session, then every one of the three routes answers 403 `ACCOUNT_SIGN_IN_REQUIRED` before the handler.
- AC-4 Given the owner has no live Telegram link on the trip, then the mint answers 409 `TELEGRAM_NOT_LINKED` and writes nothing. Given the deployment
  has no bot username, then 503 `TELEGRAM_BOT_UNAVAILABLE` and one warn log line; never a link with an empty handle.
- AC-5 The mint is limited to 10 a minute per user (429 `RATE_LIMITED`, `retry-after: 60`), its own limiter. At most ten live codes per trip and
  PLATFORM; the oldest of that platform is expired to make room, and a WhatsApp code is never expired by a Telegram mint or the reverse.
- AC-6 `GET /v1/trips/:id/telegram-groups` answers `{ groups: [{ bindingId, name, connectedAt }] }` for the owner, `no-store`: open bindings of
  THIS trip, `platform = 'telegram'`, chat id a negative number (a group; never a private chat), oldest first. `name` is the cleaned
  title or null. No chat id, no sender id, no code. Anyone else: 404 (AC-2's matrix).
- AC-7 `DELETE /v1/trips/:id/telegram-groups/:bindingId` by the owner closes that binding (`dashboard_removed`) and answers `{ status: "removed" }`, with no chat id. Then the
  bot leaves that one chat, once (D6); a failure of the leave does not change the answer or the closed binding, and a refused request (any
  404 or 403 below) never reaches Telegram. Nothing is posted to the group. A binding id of another trip, of a private Telegram chat of this trip, of a WhatsApp binding of this trip, of a closed
  binding, or a malformed id: 404 and nothing changes. A later message from the group is handled as from any unbound group, and `/group KIN-…`
  or a new add link binds it again.
- AC-8 `GET /v1/trips/:id` carries `telegram.groups: { owner: boolean }` for an organizer-side viewer with dashboard access on a full session, and
  omits it otherwise. The page offers the group actions only when `owner` is true, and never shows a co-organizer a "no group" state.

Redemption (relay):

- AC-9 Given a `/start@bot KWA-…` in a group whose payload is exactly a live Telegram group code, sent by the trip's main organizer, then the group is
  bound to the code's trip through the same body as `/group KIN-…` (free group: opened; bound to another trip: moved only if the sender is main
  organizer of both; bound to this trip: re-bound, greeted again), the code is spent (`redeemed`, `binding_id` set), and the group gets the same
  introduction and pinned button as today.
- AC-10 Given the same message from anyone else (a member, a secondary organizer, a stranger holding a forwarded link), an expired, spent or unknown
  code, a retired trip, an issuer who is no longer owner, or a private chat, then nothing is bound, the group gets the same one refusal sentence as
  `/group` with a wrong token (or the move-refusal sentence for the move case), and the code is NOT spent unless the issuer was no longer entitled.
- AC-11 A `KWA-` code is never redeemable by the WhatsApp redeemer (it finds no `whatsapp` code), and a WhatsApp code is never redeemable here.
- AC-12 When a group is bound by either path, and when a bound group's messages arrive with a title the row does not hold, `chat_title` is updated
  (cleaned, change-only). A database without the column logs and carries on; binding is unaffected.
- AC-13 `/group` and the greeting are unchanged: the `KIN-` token, its reuse, its supersede rule and its sender check keep their tests.

Web:

- AC-14 The Telegram card (trip page) and menu (trip card) show, for the owner who has Telegram linked: "Add the companion to a group" as ONE link with
  the code already in it, not asked for until the card or menu is on screen, kept until it expires, never shown as text, replaced silently at most
  three times, and under its own client allowance ("telegram-group"). Without a link: "Link Telegram first", and no mint.
- AC-15 The list shows each group as "Unlink Telegram group · linked <day>" with its name (or "unnamed group"); choosing it asks first; "Confirm unlink"
  sends the DELETE; "Keep" does nothing. The question says the companion leaves the group quietly and posts nothing there; the card does not tell the owner to remove it by hand.
- AC-16 A co-organizer, a member and a Telegram-minted session see no group section and fetch nothing.

## Conflicts checked (reported, not resolved)

- **625 (WhatsApp).** No conflict; mirrored: owner-only, `account` policy, 404 for everyone else, Unlink word and "nothing sent" (AC-15), cap of ten
  live codes (AC-7; here counted per platform, which leaves WhatsApp's behaviour as written). Difference: Telegram's code is sender-bound (D2).
- **Sprint-8 519/523 (one organizer, main Telegram, secondary organizers).** Consistent: "group chats never redeem an organizer link" (519 AC-8)
  is unchanged, and a group code is main-organizer-only exactly as `/group` is (523, `isMainTripOrganizer`; a secondary organizer is refused).
- **Member sign-in (#617/#627, `x-member-sign-in.md`).** **Conflict in effect.** S1 AC-2/AC-3 give group sign-in only when the trip has EXACTLY ONE open
  group binding. The dashboard makes a second group a click away, and Unlink can take the only one away; either silently turns group sign-in off
  (AC-3's answer is the same as the switch being off) and AC-6's per-launch re-check would then find no group. The spec for member sign-in should
  say whether "one group" is the rule it wants, and the dashboard may need to say so. Not resolved here: the card does not mention member sign-in.
- **`docs/group-participation-design.md`.** No conflict found: it governs what the companion does inside a bound group, not how a group is bound.
  After Unlink the bot leaves the group (D6), so no unbound-group behaviour applies to it.

## Contracts

- No migration. `chat_binding_codes` and `telegram_chat_bindings.chat_title` exist (20261122090000, `compatible`).
- New routes: the three above, in `portal.ts`, listed in `PORTAL_SCOPE_POLICY`.
- `chat-binding-codes.ts`: `issueChatBindingCode` takes an optional `platform` (default `whatsapp`); for `telegram` it skips the WhatsApp switch,
  accepts only `kind: group` for the owner, and counts live codes per platform.
- `group-binding.ts`: `bindGroupToTrip` extracted from `redeemGroupBindingToken`, unchanged in behaviour.
- New `telegram-group-codes.ts`: `telegramGroupCodeFromStartPayload`, `redeemTelegramGroupCode`, `listTelegramGroups`, `removeTelegramGroup`, `recordTelegramGroupTitle`.
- `relay/dispatch.ts`: the group `/start` branch also recognises a Telegram group code; messages of a bound group refresh the title (bounded, D4); every fresh bind clears the chat's in-memory state (D7).
- `adapters/telegram.ts`: `leaveChat` (5 s timeout). `portal.ts`: `PortalDependencies.telegramGroups`, read by the Unlink route. `server.ts`: sets it to the outbox's Telegram adapter.
- Web: `api.ts`, `one-click-link.tsx` (limiter name), `TripTelegram.tsx`.

## Non-goals

- Reading the bot's removal from a group (`my_chat_member` left or kicked), and a quiet unbound group (D6: the bot leaves instead).
- Retrying a failed leave (D6), and any action on the group's side other than `leaveChat`.
- A feature switch (D5). Telling the owner in Telegram when a group is bound by the dashboard (WhatsApp's AC-18 notice).
- Clearing the trip site's own `TELEGRAM_CHAT_ID` on Unlink (the site setting `/api/agent/telegram-group` writes).
- Changing `/group`, the greeting, or the `KIN-` token table.
