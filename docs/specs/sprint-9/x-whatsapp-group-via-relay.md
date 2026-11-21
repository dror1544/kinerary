# The companion on WhatsApp, in a group or a private chat, through the relay (first slice)

Status: draft (2026-11-21; consult review of 2026-11-20 applied; binding reworked the same day to the owner's dashboard-code and email-invitation design, not yet re-reviewed) · Issue: none yet (file one; this file is renamed to `<n>-whatsapp-group-via-relay.md` then) · Track: unowned (sprint to be named by Dror, open question 1) · Size: L (four slices) · Tier: High
Security path: yes (the relay's trust boundary: `control-plane/api/src/relay/`, chat-to-trip resolution, outbound scope) · Migration: yes · Live-trip behaviour: yes (relay behaviour; risk class), switched off by default

Related: `docs/per-trip-gateway-architecture.md` §4; `docs/specs/sprint-9/x-relay-chat-scope.md`
(outbound scope); `docs/specs/sprint-9/567-feature-switches.md`;
`.agents/skills/hermes-multiplex-relay/SKILL.md` (why direct platform adapters are off).

Decisions already taken by Dror (2026-11-20): WhatsApp connects through the relay, never
directly to a companion's gateway; the transport is the unofficial WhatsApp Web client (the
official Business API cannot join an existing group); the existing binding table is widened
to carry a platform, not duplicated. 2026-11-21: a WhatsApp chat is bound from the
organizer dashboard by a one-time code sent as a WhatsApp message, not through Telegram;
a private chat binds the sender's number to the trip, a group binds the group; several
codes may be live for one trip. A traveller's code is sent by Kinerary to the email
address the organizer puts in the invitation, and redeeming it binds the trip, the
traveller's number and that email; doing it again replaces the earlier binding. The
organizer gets a group link directly, with no invitation. Traveller invitations are in
this slice.

## Problem

Families coordinate in WhatsApp groups. The companion is reachable only on Telegram.

- The relay owns one platform connection. Everything before the wire event is written
  against Telegram's message shape: `dispatchUpdate` takes a `TelegramUpdate`
  (`relay/dispatch.ts:635`), the companion gate keeps reading the raw `TelegramMessage`
  after normalization (`dispatch.ts:1355-1701`), every send goes through `TelegramClient`
  (`relay/telegram-api.ts:135-215`), and the connector answers every `hello` with
  `TELEGRAM_DESCRIPTOR` (`relay/connector.ts:443-447`).
- The wire event is already neutral: `WireSessionSource.platform` is a string
  (`relay/protocol.ts:92-114`), hard-coded to `"telegram"` at `relay/normalize.ts:532`.
- A chat is tied to a trip by `control_plane.telegram_chat_bindings`, which has no platform
  column. Group or private is decided from the sign of the id in at least eight places
  (listed under Contracts).
- A gateway that runs behind the relay has its direct adapters disabled, so pairing
  WhatsApp on a companion's own gateway would bypass the router, the binding lookup, the
  group judge, the leak filter and the outbound scope check. That path is rejected.

## Behaviour

When this is done, on a deployment that has configured a WhatsApp number for its relay, and
for a trip whose `whatsapp_group` switch is on, the trip's page in the organizer dashboard
has a WhatsApp section with three actions and a list.

1. **Connect my WhatsApp.** The dashboard opens WhatsApp on a chat with the deployment's
   number, with a message already written that carries a one-time code. The organizer
   presses send. That private chat is now bound to the trip and to the organizer's
   account: the companion answers there, and treats the sender as the organizer they are.
2. **Connect a WhatsApp group.** The organizer adds the deployment's number to the
   family's existing group, then the dashboard opens WhatsApp's share screen with a coded
   message; the organizer picks the group and sends. The group is now bound to the trip
   and the companion introduces itself, including one line saying it reads the group's
   messages to know when it is addressed. The introduction never carries the trip site's
   password.
3. **Invite a traveller on WhatsApp.** The organizer picks an existing traveller and
   enters that person's email address. Kinerary sends the invitation to that address; the
   organizer never sees the link. The traveller taps it, WhatsApp opens on the bot's chat
   with the coded message, and they press send. Their private chat is bound to the trip
   as that traveller, and their number is tied to the account of that email address.
   Doing it again replaces what was there: a newer invitation redeemed from another
   number moves the traveller to that number, and a number that redeems a code for
   another trip moves to that trip.
4. **Connected chats.** The section lists the trip's WhatsApp groups (by title), people
   (by traveller name, email and the last four digits of the number) and invitations not
   yet used, each with Remove.
5. Every code works once. The organizer's own codes and group codes last 15 minutes; an
   emailed invitation lasts three days. Any number of codes can be issued for a trip
   over time, so more people and more groups can be added later.
6. In a bound group the companion behaves as in a Telegram trip group: it answers when
   addressed (its name, a reply to its message, a mention of the number, the conversation
   window, the group judge at the default proactive level) and stays silent otherwise. In
   a bound private chat every message is addressed to it. In both it receives a photo or
   PDF under the same rules as on Telegram and answers in plain WhatsApp text.
7. Telegram is not needed for any of this. The interview, buttons, the command menu, the
   Mini App, plan-change lines and scheduled messages stay on Telegram.

With the switch off, or with no WhatsApp number configured, the section is not shown and
nothing changes for anyone.

## Slices

| Slice | Content | Behaviour change |
|---|---|---|
| S1 | Extract the companion gate into one platform-neutral function | none (every existing test passes unedited) |
| S2 | Migration, chat kind by one predicate, binding codes, the dashboard section and its routes | none until the switch is on |
| S3 | WhatsApp bridge sidecar, relay client, inbound loop, outbound through the connector, stand-in for tests | behind the switch |
| S4 | Staging sitting on one test trip | staging only |

S1 merges first and alone. S2 and S3 may be built in parallel after it.

Sequencing against work in flight:

- PR #599 changes `relay/connector.ts`, `relay/protocol.ts` and `relay/server.ts`, which
  S3 also changes. S3 is briefed on a base that already has #599. S1 touches
  `relay/dispatch.ts` and `relay/poller.ts`, which #599 does not.
- `x-member-sign-in.md` (its S1, AC-2) requires "exactly one open group binding" and
  reads group-ness from a negative id. A WhatsApp binding must not count there; whichever
  of the two lands second adds the test that pins it.

## Acceptance criteria

**AC-0 (spike, before S3 is briefed).** Two things are read off real systems and recorded
in this file; if either contradicts a contract below, a spec PR amends it first.

- Against the Hermes version the deployment runs: what a gateway that said `hello` as
  Telegram does with an inbound event whose `source.platform` is `"whatsapp"`: session
  key, authorization (the gateway's own WhatsApp allow-list settings must not apply to a
  relayed event), reply egress, and which descriptor governs length and formatting. Known
  from reading 0.21.5: `"whatsapp"` is a valid platform value and is not folded to `relay`
  (`gateway/relay/ws_transport.py`, `_event_from_wire`); the adapter remembers the
  platform per chat and falls back to the primary descriptor when none was negotiated for
  it. If the gateway mistreats the event, the relay stamps the primary platform instead.
  Either way the relay, not the gateway, owns WhatsApp formatting (AC-17).
- From a staging bridge capture: the id shape of an old group and a new one, and how an
  @mention of a person appears in message text (the Sender ids contract assumes it is the
  person's number written out).

**S1: one gate**

- AC-1 Given every existing test under `control-plane/api/test`, when S1 is merged, then
  all pass with no edit to an assertion or a fixture, and every text the relay produces for
  a Telegram chat (marks, judge prompt, replies) is byte-identical to before. Names that
  tests touch (`MediaDeps.telegram`, `Attachment.fileId`) keep their names in S1; the
  renames and the per-platform wording below land in S3.
- AC-2 Given the companion path, then the pending-companion branch
  (`dispatch.ts:1742-1805`), addressing, the reply window, the conversation window, the
  group judge and its deferral, overheard context, held attachments and the text marks are
  decided by one function that imports no Telegram type. `dispatchUpdate` builds its input
  from the `TelegramMessage` and calls it, and the decisions it returns are applied through
  a per-platform sink.

**S2: schema and binding**

- AC-3 Given the migration, then every existing binding row and person link has
  `platform = 'telegram'`, the active-chat unique index keeps its name and definition, and
  the previous release's code runs unchanged against the new schema (header
  `-- rollback: compatible`).
- AC-4 Given any attempt to store a `whatsapp` binding whose `chat_id` is not a WhatsApp
  id of an accepted shape, or a `telegram` binding whose id contains `@`, then the
  database refuses it.
- AC-5 Given `resolveChatRoute`, then a `companion` route carries `platform` from the
  binding row, and no caller passes a platform in: the chat id alone selects the row.
  Given a database that does not have the column yet (new code, old schema), then routing
  for Telegram chats works exactly as before and no WhatsApp route can resolve.
- AC-6 Given a trip with `whatsapp_group` off, or a deployment with no WhatsApp number,
  then the dashboard shows no WhatsApp section and every route below answers 404.
- AC-7 Given the switch on, when the trip's owner, in a dashboard session signed in by
  password or Google (the "account" policy of `secondary-organizer-link`,
  `portal.ts`), asks for a code of kind `me` or `group`, then a code is issued that is
  single-use, expires after `relay.whatsapp.code_ttl_seconds` (default 900), and is stored
  only as a digest. The answer carries the link to open and the expiry, is `no-store`,
  and is rate-limited per user as the Telegram link route is. Earlier codes of the trip
  stay valid; at most 10 `me` and `group` codes are live per trip, and the oldest is
  expired to make room. Anyone else gets one 404.
- AC-7a Given the same caller, when they invite an existing traveller of the trip with an
  email address, then a `traveller` code is issued that expires after
  `relay.whatsapp.invite_ttl_seconds` (default 259200), one email carrying the link is
  sent to that address through the existing mailer in the trip's language, and the
  response carries neither the code nor the link. A newer invitation for the same
  traveller expires the older one. At most 20 invitation emails are sent per trip per
  day; the address is validated as the portal validates a sign-up address.
- AC-8 Given a valid code of kind `me` or `traveller` in a message sent in a WhatsApp
  private chat, then in one transaction: the code is spent; any open binding of that chat
  is closed (`rebound_by_code`), whatever trip it was for; one binding row opens for that
  chat with `platform = 'whatsapp'` and the trip's companion profile (the rule of
  `openBinding`, `group-binding.ts:422-439`); and one person link is written for the
  sender with the traveller and an account. For `me` the account is the issuing
  organizer's. For `traveller` it is the account of the invitation's email address,
  resolved through `resolveOrCreateEmailAccount` and nothing else, with a `member`
  membership of the trip ensured as a site-invite redemption ensures it today
  (`portal.ts`, invite redemption); it never raises an existing role and never lowers
  one. The chat gets one fixed confirmation line naming the trip.
- AC-8a Given a redemption for trip T and an account that already has a WhatsApp person
  link on T from a different number, then that earlier link is deleted and its private
  chat's binding is closed (`rebound_by_code`) in the same transaction: one account has
  one WhatsApp number per trip.
- AC-9 Given a valid code of kind `group` in a message sent in a WhatsApp group that has
  no open binding, then the code is spent, one binding row opens for the group, and the
  introduction is sent to the group. The introduction never includes the site password,
  whatever `groupIntroIncludesPassword` says. Who sent the message does not matter
  (owner's decision, 2026-11-21).
- AC-10 Given a code whose kind does not fit the chat (a `group` code in a private chat,
  a `me` or `traveller` code in a group), a code that is wrong, expired or already used,
  a `group` code in a group bound to a different trip, a group whose id is not of an
  accepted shape, or a trip that is retired or switched off at that moment, then nothing
  is bound, the code is not spent unless it was the right kind for the chat, and the
  WhatsApp reply is at most one fixed line. A `group` code in a group already bound to
  the same trip is spent and answered "already connected".
- AC-11 Given any message, then only a token of exactly the code shape (Contracts)
  anywhere in its text is a code attempt; everything else is never an attempt. More than
  `relay.whatsapp.code_attempts_per_hour` (default 5) failed attempts from one chat, or
  50 across all chats, silence code handling for that chat, or for all unbound chats, for
  the rest of the hour.
- AC-12 Given a WhatsApp sender in a bound chat of trip T, then that sender resolves to a
  trip person only through a WhatsApp person link of T, and is an organizer only while the
  link's account holds an owner or organizer membership of T at that moment; a link with
  no account is never more than a participant. A sender with no link resolves to nobody.
- AC-12a Given Remove in the dashboard, then the binding closes, the person link (for a
  private chat) is deleted, the next message from that chat is dropped (AC-14), and a
  group gets one fixed goodbye line.
- AC-12b Given `teardown-trip.py --execute`, then the trip's live codes are expired before
  any other statement in the transaction (the lock order of `REVOKE_GROUP_TOKENS`), and
  its WhatsApp bindings close with the same reason as its Telegram ones. A trip clear
  refuses a trip that ever had a binding, as today (`trip-clear.ts`, `EVER_PROVISIONED`),
  whichever platform the binding was on.

**S3: transport**

- AC-13 Given no `relay.whatsapp` block in the architecture profile, then the relay starts
  no WhatsApp loop, opens no connection to a bridge, and behaves exactly as before. Given
  an open binding whose platform is `whatsapp` while no WhatsApp client is configured,
  then every outbound action for it is refused with
  `{ success: false, error: "PLATFORM_UNAVAILABLE" }` and no Telegram call is made.
- AC-14 Given a message in a WhatsApp chat with no open binding, then it is dropped
  without a reply and without reaching any gateway or any model, unless it is a code
  attempt (AC-8 to AC-11). This includes every unbound private chat with the number.
- AC-15 Given a bound WhatsApp group whose trip has the switch off, then inbound is
  dropped as in AC-14 and every outbound action for that chat is refused as
  `CHAT_NOT_IN_SCOPE`.
- AC-16 Given a bound group with the switch on, then a message reaches the trip's
  companion under exactly the conditions a Telegram group message would (AC-2's gate),
  with `source.platform = "whatsapp"` (subject to AC-0), `chat_type = "group"`, the
  group's id as `chat_id`, an opaque sender id (Contracts) and the sender's WhatsApp
  display name; a message that is not addressed is held as overheard context exactly as on
  Telegram.
- AC-17 Given a gateway `send` to a bound WhatsApp group, then it passes the same scope
  check, silence verdict and leak filter as a Telegram send, is converted to WhatsApp
  formatting by the relay, and is delivered through the bridge; `edit`, `typing` and
  `get_chat_info` are performed through the bridge under the same scope check. The
  transport is chosen from the binding row's platform, never from the frame. A `reply_to`
  quotes only a message of the same chat, and an `edit` changes only a message the number
  itself sent in that chat.
- AC-18 Given text in a WhatsApp chat that `parseInbound` reads as a command, then it is
  dropped without a reply and never reaches a gateway. No router command exists on
  WhatsApp in this slice.
- AC-19 Given a photo or a document, then it joins a turn under the rules the gate applies
  on Telegram today: with a caption that addresses the companion, as the replied-to
  message of an addressed reply from the same sender, or (documents only) when held and
  followed by an addressed message from the same sender within the existing hold window.
  The relay never downloads media of a message that did not join a turn.
- AC-20 Given a WhatsApp participant who has not connected a private chat, then that
  person's id or phone number is not written to the database, not written to a log line,
  and not sent to a gateway or to the judge model, in an id field or inside message text.
  Given a person who connected, then their id is stored in exactly two places (the
  binding's `chat_id` and their person link) and appears on the wire only as the
  `chat_id` of their own private chat. For everyone, `source.user_id` and every log line
  carry the keyed opaque id, never a number. A WhatsApp id is never looked up in a column
  or table that holds Telegram identities other than through the platform-aware person
  link (AC-12).
- AC-21 Given the bridge is unreachable, logged out or restarted, then the relay logs one
  state change, keeps serving Telegram unaffected, and resumes WhatsApp when the bridge
  reports connected. A gateway action for a WhatsApp chat while the bridge is down gets
  one `outbound_result` with `success: false`.
- AC-22 Given the Telegram path, then inbound routing, outbound scope, the interview and
  their existing tests are unchanged.

**S4: staging sitting** (manual, on one test trip before `ready_private` or approved as a
staging rollout)

- AC-23 The companion is bound to a real WhatsApp group by the flow above, answers a trip
  question when named, stays silent on ordinary chatter for ten minutes, reads a PDF sent
  with a question, answers the organizer in a connected private chat, and the same trip's
  Telegram group keeps working throughout.

## Contracts

### Chat ids are unique across platforms, and the platform comes from the row

An outbound frame carries only `chat_id` (`protocol.ts:208-242`; `parseOutboundAction`
drops everything else) and nothing in a frame is trusted, so the transport cannot be
chosen from the frame. It is chosen from the binding row. That requires a chat id to
identify one chat on one platform:

- A WhatsApp chat id is stored and sent on the wire in full, suffix included: a group as
  `<digits>@g.us`, a private chat as the person's id (`<digits>@s.whatsapp.net`, or the
  linked-identity form if AC-0 finds private chats arrive that way). The suffix is never
  stripped, anywhere.
- A Telegram chat id matches `^-?[0-9]{1,20}$`. The two shapes cannot overlap.
- `telegram_chat_bindings_active_chat_idx` (unique on `chat_id` where open) therefore
  stays as it is, name included (`group-binding.ts:410` matches the name).
- Older WhatsApp groups carry their creator's phone number in the id
  (`<phone>-<timestamp>@g.us`). Those are not accepted in this slice: the code attempt
  gets one fixed line (AC-11) and nothing is stored. AC-0 confirms the shapes.

### Migration (one file, `YYYYMMDDHHMMSS_chat_binding_platform.sql`)

`-- rollback: compatible — additive column with a default and one new table; the previous release skips a WhatsApp-shaped row everywhere it reads bindings`

- `telegram_chat_bindings.platform text NOT NULL DEFAULT 'telegram'`, CHECK in
  (`'telegram'`, `'whatsapp'`).
- CHECK: `platform = 'whatsapp'` implies `chat_id` matches a group id
  (`^[0-9]{5,40}@g\.us$`) or a private id (`^[0-9]{5,20}@(s\.whatsapp\.net|lid)$`); and
  `platform = 'telegram'` implies `chat_id !~ '@'`. The second also stops a legacy writer
  that re-inserts a row without a platform from turning a WhatsApp id into a Telegram row.
  Staging holds no row that fails either (checked 2026-11-21: 125 rows, none); the
  production count is read before the release that carries the migration.
- `trip_person_links` gains `platform text NOT NULL DEFAULT 'telegram'` and a nullable
  `account_user_id` (FK to users). Its id-shape CHECK (`^[0-9]{1,20}$`) becomes
  per-platform, and `verified_via` gains `'dashboard_code'`. `telegram_user_id` keeps its
  name and holds the WhatsApp id on `whatsapp` rows. The Telegram-digest triggers do not
  match such rows; a WhatsApp person's role is derived at read time (AC-12), so no trigger
  is added.
- New table `chat_binding_codes`: `id` (opaque), `trip_id` (FK), `platform`, `kind` in
  (`me`, `traveller`, `group`), `issued_by_user_id`, `participant_username` (for `me` and
  `traveller`), `invited_email_digest` and `invited_user_id` (for `traveller`; the account
  is resolved when the invitation is created, so the address itself is not kept on the
  row), `code_digest`, `state` in (`issued`, `redeemed`, `expired`), `binding_id`
  (set when redeemed), `expires_at`, `created_at`, `redeemed_at`. Unique partial index on
  `code_digest` over `issued`; no one-per-trip index.
- The table is platform-neutral by name; only `whatsapp` rows are written in this slice.
- **Code shape.** `KWA-` plus 8 characters of the alphabet the group tokens use
  (`group-binding.ts:50-79`). The dashboard wraps it in a short sentence in the
  organizer's language; the relay reads only the token. Failed-attempt counts are kept in
  the relay's memory; a relay restart resets them.
- New binding close reasons: `dashboard_removed`, `rebound_by_code`. No existing reader
  branches on either.
- The table and column are not renamed. A rename breaks the monitor role's column grants
  (`control-plane/deployment/monitor-db-role.sql:89`), about forty readers in four
  languages, and the `compatible` rollback. Renaming `telegram_chat_bindings` is a later,
  separate contract step.
- **New code on the old schema.** Migrations are a separate step from a restart, and the
  production release that carries this one waits for the freeze to end. The route query
  therefore reads the platform in a form that does not fail when the column is absent
  (absent reads as `telegram`; for example `COALESCE(to_jsonb(b)->>'platform','telegram')`),
  and no other query in S2 or S3 selects the column on a path Telegram traffic uses (AC-5).

**What "widen" covers in this slice:** `telegram_chat_bindings` and `trip_person_links`.
Deferred, each to the slice that first needs it: `intake_sessions.telegram_chat_id` and
the interview tables (WhatsApp interview), the `telegram_*_links` tables (they model the
Telegram sign-in to the dashboard and Mini App, which WhatsApp does not have),
`telegram_group_binding_tokens` (a Telegram deep-link token tied to a Telegram sender;
the codes table serves WhatsApp), `notification_outbox` targeting. `messaging_bindings` (migration 0001; `provider`,
`bot_ref`, `chat_ref`) stays unused: nothing reads or writes it, and moving routing onto
it would be the duplicate table this decision rules out.

### Chat kind: one predicate instead of the sign of the id

`chatKind(chatId): "private" | "group" | "unknown"` in `identity.ts`, beside
`isPrivateChatId` (Telegram: digits private, minus-digits group; WhatsApp: `@g.us` group,
`@s.whatsapp.net` or `@lid` private; anything else `unknown`, which every caller treats as the most restrictive answer). It
reads the id's shape only, so no reader needs the new column. `isPrivateChatId` itself
keeps meaning "a Telegram private chat": a WhatsApp private chat is never an organizer's
notification chat, never an `interview_handover` and never a Mini App chat, and the
digits-only readers below exclude it without a change. Intended result for a WhatsApp
row at each reader that sniffs the sign today:

| Reader | Today | Required for a WhatsApp group row |
|---|---|---|
| `group-binding.ts:289` (`NOT_A_GROUP`) | `startsWith("-")` | unchanged; a Telegram token is refused for a WhatsApp id |
| `trip-audience.ts:34` (`isGroupChatId`) | minus-digits | excluded, stated in a comment and pinned by a test: no outbox message goes to a WhatsApp group |
| `plan-change-poller.ts:347` | `~ '^-[0-9]{1,20}$'` | excluded the same way |
| `analytics/store.ts:525` | `LIKE '-%'` | counted as a group (SQL form: `LIKE '-%' OR LIKE '%@g.us'`); `channelTypeOf` (`analytics/contract.ts:499-510`) classifies it as a group |
| `telegram-mini-app.ts`, `organizer-trips.ts` private checks | digits-only | not private; unchanged |
| `relay/outbound-scope.ts:104`, `connector.ts:717`, `identity.ts:187` | digits-only | not private, so never `interview_handover`; unchanged |
| worker `gateway_reconcile.py:494` | digits-only | not private; add a test with a WhatsApp row |
| worker `verification.py:359-372` | any open binding | unchanged: a WhatsApp-only trip passes "has a messaging binding" |
| fleet monitor `fleet-mcp.mjs:1171,1941` | `LIKE '-%'` | shown as a group and not treated as an organizer private chat, decided from the id's shape; no grant change |

Writers that insert a binding without naming a platform (`switch-trip-chat.py:191`,
`organizer-trips.ts:656`, `provisioner.py:892`, `group-binding.ts:424`) keep doing so and
get `telegram`; the CHECK refuses them a WhatsApp id.

### The gate (S1)

New `control-plane/api/src/relay/companion-gate.ts`. The companion path of `dispatch.ts`
(the pending-companion branch and `1355-1701`) moves here.

```ts
export interface InboundTurn {
  platform: "telegram" | "whatsapp";
  chatId: string;
  chatType: ChatType;
  rawChatType: string;               // for analytics' channel classification
  chatName: string | null;
  senderId: string | null;           // opaque per platform; see "Sender ids"
  senderName: string | null;
  text: string;                      // text, or the caption when there is no text
  caption?: string;
  messageId: string;
  replyToMessageId?: string;
  isReplyToAssistant: boolean;
  repliedToSenderId?: string;        // a replied-to document joins only for the same sender
  repliedToText?: string;            // for the reaction-answers-question rule
  attachment: AttachmentRef | null;  // S1: today's `Attachment` (with `fileId`). S3: { ref: string; kind; mime?; filename?; size? }
  repliedToAttachment: AttachmentRef | null;
}

export interface GateDeps {
  assistantHandle?: string;          // the bot's @username on Telegram; unset on WhatsApp
  resolvePerson(tripId: string, senderId: string): Promise<TripPerson | null>; // WhatsApp supplies the platform-aware lookup of AC-12
  beforeMarks?(turn: InboundTurn, route: CompanionRoute): Promise<GateDecision | null>; // Telegram supplies the organizer document route here, at its present position
  fetchAttachment(ref: string, maxBytes: number): Promise<FetchedFile | null>;
  /* plus the existing db, judge, group context, pending attachments, media store, log */
}

export function companionGate(turn: InboundTurn, outcome: NormalizeOutcome, deps: GateDeps): Promise<GateDecision>;
```

- The route (`tripId`, `hermesProfile`, `assistantNames`, `platform`) and the drop reasons
  arrive in `outcome`, produced by a platform-neutral `resolveInbound(chatId)` that
  `normalizeUpdate` now calls.
- `GateDecision` is the platform-neutral subset of `DispatchDecision`: `to_gateway`,
  `reply` (a fixed text to the chat), `judge_pending`, `drop`. Each platform's loop applies
  them through its own sink; `poller.ts`'s `applyDecision` keeps the Telegram sends. On
  `judge_pending` the loop keeps the `InboundTurn` and calls the gate again in the chat's
  lane, as the Telegram poller does with the raw update today.
- In S3, for WhatsApp turns only: the group judge's prompt names WhatsApp instead of
  Telegram (`group-judge.ts:150`), and `addressedMark` has a WhatsApp wording
  (`stay-silent.ts:56-64`) that keeps the pinned `[addressed to you directly` prefix. The
  Telegram wording of both is untouched. The companion template
  (`profile-templates/familytrip-companion/templates/SOUL.md.tpl`) is NOT changed in this
  slice: a template change reaches every Telegram companion at its next build or redeploy
  and is not behind the switch. The per-turn mark tells the companion it is in a WhatsApp
  group and to answer in plain text.

### Sender ids and phone numbers

WhatsApp gives a participant as a phone id or a linked-identity id, sometimes both. The
relay derives one opaque id, `wa_` + the first 32 hex characters of HMAC-SHA256(key,
canonical participant id), preferring the phone form when both are present so the id is
stable. The key is its own secret (`relay.whatsapp.sender_id_secret_ref`), so rotating a
gateway secret does not change every sender. The same derivation applies to the sender,
to the replied-to participant and to anything logged.

- A person who connected a private chat chose to give their number: it is stored in the
  binding's `chat_id` and in their person link, and nowhere else. Everyone else in a
  group stays opaque.
- The opaque id is `source.user_id` for every sender, connected or not, the key of the
  conversation window (`conversation_user_ids`) and of held attachments. In the relay a raw participant id
  exists only in memory. The bridge's session directory is the one place numbers rest on
  disk: the WhatsApp Web library keeps per-participant key files there (seen in an old
  session folder: file names carry participant ids). That directory is already a
  credential under the deployment's care (Configuration).
- Before message text, a caption or replied-to text is used for anything (the gate,
  overheard context, the judge, the wire), the relay rewrites every @mention of a number: the number's own mention becomes
  the assistant's first name, anyone else's becomes "someone". (Rewriting to a display
  name is a later refinement.)
- `senderName` is the sender's WhatsApp display name: unverified, shown to the model as a
  name, never used for a decision, and empty rather than a number when the name is absent.
- The number's own identity has two forms as well; reply-to-assistant and
  mention-of-the-number compare against both, as reported by the bridge's `/health`.
- The relay decides group or private from the chat id's shape and drops the number's own
  messages itself; it does not rely on the bridge's flags for either.

### Bridge sidecar and `WhatsAppClient`

New package `control-plane/whatsapp-bridge/` (own `package.json`, so the WhatsApp Web
library does not enter the API's dependency tree; version pinned exactly). One process per
relay, one WhatsApp number per process. It binds loopback only and requires a bearer
secret on every request.

| Endpoint | Purpose |
|---|---|
| `GET /health` | connection state, own ids (both forms) |
| `GET /messages` | long-poll; returns events `{ chatId, senderId, senderAltId, senderName, messageId, text, quotedMessageId?, quotedParticipant?, quotedText?, mentionedIds[], media?: { kind, mime, size, filename } }` |
| `GET /media/:chatId/:messageId` | bytes of a recent message's media, downloaded on demand; 404 after the bridge's bounded store has dropped it |
| `POST /send` | text out; a `replyTo` is honoured only for a message of the same chat |
| `POST /edit` | only a message the number sent in that chat |
| `POST /typing` | typing indicator |
| `GET /chat/:id` | group title (participant ids are not returned) |
| `--pair-only` | print the QR, write the session, exit |

The bridge applies no allow-list and no addressing rule of its own: the relay decides.
`relay/whatsapp/client.ts` defines `WhatsAppClient` (the calls above) with an HTTP
implementation; `relay/whatsapp/poller.ts` runs the loop and builds `InboundTurn`;
`relay/whatsapp/format.ts` converts the companion's Markdown to WhatsApp text.
`RelayConnector` receives `whatsapp?: WhatsAppClient` beside `telegram` and picks by
`route.platform` after `checkScope`.

Whether the sidecar is written fresh or adapted from the MIT-licensed bridge that ships
with Hermes is open question 3.

### Configuration

Architecture profile, `relay.whatsapp` (absent = feature not present):
`bridge_url`, `bridge_secret_ref`, `sender_id_secret_ref`, `number` (what the dashboard's
links open; read by the API as well), `code_ttl_seconds`, `invite_ttl_seconds`,
`code_attempts_per_hour`. `bridge_url` passes a new validator that
accepts loopback addresses only (`telegramApiRoot` is not reused: it accepts https to any
host). How a containerised relay shares loopback with the bridge is the deployment's
concern. The bridge's session directory is the bridge's own argument and holds a
credential: it lives in the deployment's state, mode 0700, never in this repository.
Starting and pairing the bridge is deployment work (`kinerary-deploy`); this repository
ships the generic package and a runbook section in `docs/`.

Feature switch `whatsapp_group`: `surfaces: ["relay"]`, `memberVisible: false`, added to
`shared/feature-switches.js` and to the worker's mirror in `feature_block.py`. It is read
with `featureEnabled(db, tripId, "whatsapp_group")` at four points: the dashboard
routes, code redemption, inbound after the route resolves, and outbound inside
`resolveOutboundRoute` (`outbound-scope.ts`; the connector holds no database handle by
design). The outbound read happens only when the route's platform is `whatsapp`: a
Telegram route never reads the switch, so an unreadable switch cannot refuse a Telegram
send. The relay's own messages to a WhatsApp chat (code replies, the confirmation, the
introduction, the goodbye) do not pass `checkScope` and are sent only from the code flow.

### Dashboard routes and page

All under the existing portal (`portal.ts`), `requireMutation` for writes, the "account"
session policy, the trip's owner only, one 404 for everything else:

| Route | Does |
|---|---|
| `POST /v1/trips/:id/whatsapp-codes` `{ kind }` (`me` or `group`) | issues a code; returns `{ link, expiresAt }` |
| `POST /v1/trips/:id/whatsapp-invitations` `{ participant, email }` | issues a `traveller` code and emails it; returns `{ expiresAt }` only |
| `GET /v1/trips/:id/whatsapp-connections` | open WhatsApp bindings of the trip (groups with title; people with traveller name, email and the number's last four digits) and unused invitations |
| `DELETE /v1/trips/:id/whatsapp-connections/:bindingId` | Remove (AC-12a) |
| `DELETE /v1/trips/:id/whatsapp-invitations/:codeId` | expires an unused invitation |

The invitation email is a new `PortalMail` kind in `portal-email-templates.ts`, sent
through `Mailer` (`mailer.ts`); it names the trip and the organizer, says what pressing
send will do, and carries the link and its expiry. A deployment with no mailer configured
refuses the invitation route with a clear error and does not issue a code.

Links: `me` and `traveller` open `https://wa.me/<number>?text=<message>`; `group` opens
`https://wa.me/?text=<message>`, WhatsApp's share screen, because a link cannot target a
group. The page (`web/src/pages/TripWhatsApp.tsx`, beside `TripTelegram.tsx`) shows the
number to add to the group before the group link. The removal reaches the relay through
the database (the binding is closed); the goodbye line is sent by the relay when it next
sees the closed binding's chat, or by an outbox row if AC-0 shows that is simpler.

### Files expected to change

`relay/dispatch.ts`, `relay/poller.ts`, `relay/normalize.ts`,
`relay/pending-attachments.ts`, `relay/group-judge.ts`, `relay/stay-silent.ts`,
`relay/connector.ts`, `relay/outbound-scope.ts`, `relay/server.ts`, `chat-router.ts`
(`ChatRoute.platform`, `resolveTripPerson`), `identity.ts`, `config.ts`, `portal.ts`,
`portal-email-templates.ts`, `web/src/api.ts`, `trip-audience.ts` and
`plan-change-poller.ts` (comment and test only), `analytics/store.ts`,
`analytics/contract.ts`, `shared/feature-switches.js`, worker `feature_block.py`, worker
tests for `gateway_reconcile.py`, `scripts/teardown-trip.py`,
`.agents/skills/trip-fleet-monitor/fleet-mcp.mjs`. New:
`relay/companion-gate.ts`, `chat-binding-codes.ts`, `web/src/pages/TripWhatsApp.tsx`,
`relay/whatsapp/*`,
`control-plane/whatsapp-bridge/`, `control-plane/api/tools/fake-whatsapp.ts`. Retired or
rewritten in S3: `.agents/skills/trip-bot-messaging-platform-setup/`, which teaches the
rejected direct pairing.

## Non-goals

- The interview, signup, organizer approval flows or any button on WhatsApp.
- Unbound private chats with the number (dropped silently, AC-14).
- Signing in to the dashboard or the trip site with WhatsApp. A WhatsApp person link gives
  a role inside the chat only.
- Switching a private chat between trips by command: sending a newer code rebinds it.
- Router commands on WhatsApp (`/trips`, `/proactive`, `/app`, …). The proactive level of
  a WhatsApp group is the default until a later slice.
- Plan-change lines, scheduled messages and outbox notifications to WhatsApp groups.
- Moving a bound group to another trip other than Remove, then a new code. After Remove
  or teardown the number is still a member of the family's group and the bridge still receives its messages; the
  relay drops them (AC-14). Leaving the group is a later slice.
- Old-style WhatsApp groups whose id carries a phone number.
- The official WhatsApp Business API.
- Production. This slice is built and tried on staging; putting an unofficial client's
  number in a real family's group is a separate decision (open question 5).
- Renaming Telegram-named tables, columns, functions or triggers.

## Security and boundary notes

- **The relay stays the trust boundary.** `source.profile` is stamped from the binding row
  found by chat id; nothing in a WhatsApp message, a display name or a frame selects a
  trip, a profile or a transport. Unknown chat shape, unknown platform value, a failed
  lookup, an unreadable switch or a missing client all resolve to "drop" inbound and
  "refuse" outbound, the same fail-safe direction as the visibility rules.
- **Binding is the one place a WhatsApp message causes a privileged change**, and a
  WhatsApp sender is not a verified identity. What is verified is the dashboard session
  that minted the code: the trip's owner, signed in by password or Google. The code then
  proves possession, once, for 15 minutes. This is the trust model the dashboard's
  Telegram link already uses (`POST /v1/trips/:id/telegram-link`, `telegram-link-token.ts`).
  Consequences that are accepted and stated:
  - A `me` code binds whoever sends it as the issuing organizer. The organizer sends it
    from their own phone seconds after it is minted; it is never meant to be forwarded.
  - A `traveller` invitation goes only to the email address the organizer typed, so
    redeeming it shows control of that mailbox, the same evidence an emailed sign-in link
    gives. A mistyped address, or a forwarded email, lets someone else become that
    traveller in the chat with a member's view of the trip, and members see all of a
    trip's data. The controls are: the organizer never holds the link, one use, three
    days, the list of unused invitations and connected people in the dashboard, and
    Remove.
  - The account for an invited address comes only from `resolveOrCreateEmailAccount`, so
    one address stays one `user_id`; the invitation never mints a user by itself and never
    touches an existing account's credential.
  - A `group` code is visible to the whole group once sent, and is already spent by then.
  - A wrongly bound chat is visible in the dashboard list at once.
- **Roles are derived, not stored.** A WhatsApp organizer is an organizer only while the
  linked account's membership says so (AC-12), so ending a membership ends the role with
  no trigger to forget.
- **A gateway sends only to its own chats**, by the rule of `x-relay-chat-scope.md`,
  including its declared exception: the multiplex gateway, while one is configured, may
  send to any companion chat on either platform.
- **Everyone in a bound group can talk to the companion**, as in a Telegram group. Only a
  sender with a person link has a role; an organizer-gated action from WhatsApp is allowed
  exactly when AC-12 says the sender is an organizer at that moment.
- **Phone numbers.** A WhatsApp participant id is a phone number, and an @mention writes
  one into message text. For people who did not connect, neither is stored in the
  database, logged or sent to a gateway or a model; for a person who connected, the id is
  stored in two named places (AC-20). The bridge's session directory also holds them. A plain hash of a phone number is reversible by enumeration, so the opaque id
  is keyed.
- **The bridge receives every message of every group the number is in**, addressed or
  not, and the judge model reads group text at the trip's proactive level, as on Telegram.
  The introduction says so in one line (Behaviour 2). The privacy policy drafts in the
  notes folder do not mention WhatsApp (open question 4).
- **Lock order.** Redemption takes: code row `FOR UPDATE`, then the open binding for the
  chat `FOR UPDATE`, then the binding insert. Teardown expires codes first, the order
  `REVOKE_GROUP_TOKENS` already documents (issue #175).
- **The session directory is a credential** that gives full control of the WhatsApp
  account. It is deployment state, never in this repository, never in a container image.
- **Boundary review** is required for S2 and S3, with live request/response evidence for:
  an unbound group gets nothing; a bound group with the switch off gets nothing; a
  companion's gateway cannot send to a WhatsApp chat that is not its own; a spent, expired
  or wrong-kind code binds nothing; the code routes refuse a non-owner, a Telegram-minted
  session and a switched-off trip with the same 404; no phone number of an unconnected
  person appears in a log line, a database row or an
  inbound frame after a turn with an @mention.

## Test plan

Tests are written first, from the criteria.

- S1: no edit to any existing test (AC-1); new `companion-gate.test.ts` drives the gate
  with `InboundTurn` for both platforms over the same table of cases.
- S2: `chat-binding-codes.test.ts` (AC-7 to AC-12a, the lock order under concurrent
  redeem and teardown, as `group-binding`'s deadlock test does); portal route tests for
  AC-6, AC-7 and AC-7a with a fake mailer (the response never carries the code; one
  address resolves to one account); `TripWhatsApp.test.tsx`; a migration test for
  AC-3 and AC-4; an old-schema test for AC-5 (the route query against a table without the
  column); `chatKind` cases; `tests/scripts/test_teardown_trip.py` for AC-12b; worker and
  fleet-monitor tests with a WhatsApp row.
- S3: `control-plane/api/tools/fake-whatsapp.ts`, a loopback stand-in for the bridge with a
  `/_control` API like `fake-telegram.ts`, so CI never needs the WhatsApp library or a
  number; `relay-whatsapp.test.ts` (AC-13 to AC-21, including a log and frame scan for
  digits of the fixture phone numbers); `relay-connector.test.ts` gains the cross-platform
  scope cases (AC-13, AC-17); the bridge package has its own unit tests for event
  extraction and never connects out in CI.
- AC-22: the full existing relay and interview suites, unchanged.
- S4: the manual sitting, recorded as a run note in the notes folder.

## Rollout and regression

- Risk class on three counts: a migration, relay behaviour, a boundary path. A regression
  plan and the owner's manual test are required before each of S2 and S3 merges to `main`;
  S1 needs a regression plan as relay behaviour even though it changes none.
- Live trips feel nothing: the switch is off for every trip, no deployment has a
  `relay.whatsapp` block, the migration is additive, and new code runs on the old schema
  (AC-5). The control-plane release that carries the migration to the production VM is
  after the Alsace freeze (not before 2026-12-07) and needs the owner's own approval as
  any migration does.
- Staging gets it the usual way: merged to `main` switched off, picked up by the nightly
  redeploy. The staging bridge is started and paired by hand from the deployment
  repository. The S4 sitting uses a trip and a Telegram group that the PR #599 sitting
  does not use, and does not overlap it.
- Rollback: switch off per trip (immediate); remove the `relay.whatsapp` block and restart
  the relay (the loop is gone and WhatsApp chats are refused, AC-13); the migration stays
  (compatible).

## Open questions

Decisions for Dror before approval.

1. **Which sprint owns this.** Sprint 9's scope is faster delivery. Proposed: its own
   track after Release 1, with S1 allowed earlier because it changes no behaviour.
2. **Decided 2026-11-21.** The organizer gets a group link directly in the dashboard, and
   whoever sends the coded message in the group binds it. Traveller invitations are in
   this slice and go by email. Still to confirm in that area:
   - the invitation lifetime (written as three days);
   - that an invited traveller's account gets a `member` membership of the trip, which is
     what "binds the trip, his number and the email" is read to mean, and which is also
     what the personal invite of `x-member-sign-in.md` creates. The two should share one
     code path; whichever is built second reuses the first.
3. **Bridge source.** Recommended: our own small sidecar, adapted from the MIT-licensed
   bridge that ships with Hermes, with the library version pinned. The alternative, running
   Hermes's bridge as it is, is faster but makes the relay's intake depend on a file inside
   another product's install, with its own allow-list and drop rules.
4. **Privacy wording.** The group introduction line, and whether the published privacy
   policy needs a WhatsApp paragraph before a group outside the owner's family is bound.
5. **Production.** The unofficial client breaks WhatsApp's terms and the number can be
   banned without notice; a ban now also cuts every connected private chat. This spec stops at staging; whether and when a real family's
   group gets it is a later decision, with a dedicated number that is nobody's personal
   one.
6. **Product documents.** The MRD entry of 2026-10-30 says "WhatsApp Business", and the
   business plan and product spec price WhatsApp "per conversation"; Meta has billed per
   message since July 2025. Those documents are not edited by this spec. Should the
   doc-keeper update them to today's decision?
