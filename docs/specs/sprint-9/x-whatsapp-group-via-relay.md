# The companion in a WhatsApp group, through the relay (first slice)

Status: draft (2026-11-20) · Issue: none yet (file one; this file is renamed to `<n>-whatsapp-group-via-relay.md` then) · Track: unowned (sprint to be named by Dror, open question 1) · Size: L (four slices) · Tier: High
Security path: yes (the relay's trust boundary: `control-plane/api/src/relay/`, chat-to-trip resolution, outbound scope) · Migration: yes · Live-trip behaviour: yes (relay behaviour; risk class), switched off by default

Related: `docs/per-trip-gateway-architecture.md` §4; `docs/specs/sprint-9/x-relay-chat-scope.md`
(outbound scope); `docs/specs/sprint-9/567-feature-switches.md`;
`.agents/skills/hermes-multiplex-relay/SKILL.md` (why direct platform adapters are off).

Decisions already taken by Dror (2026-11-20): WhatsApp connects through the relay, never
directly to a companion's gateway; the transport is the unofficial WhatsApp Web client (the
official Business API cannot join an existing group); the existing binding table is widened
to carry a platform, not duplicated.

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
for a trip whose `whatsapp_group` switch is on:

1. The main organizer asks for a WhatsApp code in their private Telegram chat with the
   bot with `/group whatsapp`. The bot answers with a short code and one sentence of
   instructions. (Plain `/group` keeps issuing the Telegram group link as today.)
2. Someone adds the deployment's WhatsApp number to the family's existing WhatsApp group
   and types the code there.
3. The bot answers in the WhatsApp group that it has asked the organizer, and asks the
   organizer on Telegram to approve, naming the group's title and participant count.
4. On approval the group is bound to the trip and the companion introduces itself in the
   WhatsApp group, including one line saying it reads the group's messages to know when it
   is addressed.
5. From then on the group behaves as a Telegram trip group does: the companion answers
   when addressed (its name, a reply to its message, a mention of the number, the
   conversation window, the group judge at the trip's proactive level), stays silent
   otherwise, receives photos and PDFs sent with or just before a question, and answers
   in plain WhatsApp text.
6. Everything else stays on Telegram: the interview, buttons, the command menu, the Mini
   App, organizer-gated actions, plan-change lines and scheduled messages.

Switched off, or with no WhatsApp number configured, nothing changes for anyone.

## Slices

| Slice | Content | Behaviour change |
|---|---|---|
| S1 | Extract the companion gate into one platform-neutral function | none (existing relay tests pass unmodified) |
| S2 | Migration, platform-aware chat kind, binding request and approval | none until a WhatsApp chat exists |
| S3 | WhatsApp bridge sidecar, relay client, inbound loop, outbound through the connector, stand-in for tests | behind the switch |
| S4 | Staging sitting on one test trip | staging only |

S1 merges first and alone. S2 and S3 may be built in parallel after it.

## Acceptance criteria

**AC-0 (spike, before S3 is briefed).** Against the Hermes version the deployment runs,
record in this file what a gateway that said `hello` as Telegram does with an inbound
event whose `source.platform` is `"whatsapp"`: session key, authorization (the gateway's
own WhatsApp allow-list settings must not apply to a relayed event), reply egress, and
which descriptor governs length and formatting. What is known from reading 0.21.5:
`"whatsapp"` is a valid platform value and is not folded to `relay`
(`gateway/relay/ws_transport.py`, `_event_from_wire`); the adapter remembers the platform
per chat and falls back to the primary descriptor when no descriptor was negotiated for
it. If the spike finds the gateway mistreats the event, the relay stamps the primary
platform instead and S3's contract is amended by a spec PR first. Either way the relay,
not the gateway, owns WhatsApp formatting (AC-17).

**S1: one gate**

- AC-1 Given the existing suites `relay-dispatch`, `relay-poller`, `relay-connector` and
  `relay-normalize`, when S1 is merged, then they pass with no edit to any assertion.
- AC-2 Given the companion gate, then addressing, the reply window, the conversation
  window, the group judge, overheard context, held attachments and the text marks are
  decided by one function whose input is `InboundTurn` (Contracts) and which imports no
  Telegram type. `dispatchUpdate` builds an `InboundTurn` from the `TelegramMessage` and
  calls it.

**S2: schema and binding**

- AC-3 Given the migration, then every existing binding row has `platform = 'telegram'`,
  the active-chat unique index keeps its name and definition, and the previous release's
  code runs unchanged against the new schema (header `-- rollback: compatible`).
- AC-4 Given any attempt to store a `whatsapp` binding whose `chat_id` is not a group JID,
  or a `telegram` binding inserted with a JID-shaped id, then the database refuses it.
- AC-5 Given `resolveChatRoute`, then a `companion` route carries `platform` from the
  binding row, and no caller passes a platform in: the chat id alone selects the row.
- AC-6 Given a trip with `whatsapp_group` off, when its main organizer sends
  `/group whatsapp`, then no code is issued and the reply says WhatsApp is not enabled for
  this trip. Given anyone who is not the trip's main organizer, or any chat that is not a
  private Telegram chat, then the existing `/group` refusals apply unchanged.
- AC-7 Given the switch on, then `/group whatsapp` issues a code that is single-use,
  expires after `relay.whatsapp.code_ttl_seconds` (default 900), is stored only as a
  digest, and replaces any earlier unredeemed WhatsApp code for the trip. The trip's
  Telegram group token is not touched.
- AC-8 Given a valid code typed in a WhatsApp group that has no open binding, then a
  request row becomes `pending` with the group's JID, title and participant count, the
  group gets one line saying the organizer was asked, and the organizer's private Telegram
  chat gets the approval question. The code cannot be used again.
- AC-9 Given a pending request, when the organizer who was issued the code approves it
  from the private Telegram chat it was issued in (button, or yes/no in words), then one
  binding row opens with `platform = 'whatsapp'`, the request becomes `approved`, and the
  introduction is sent to the WhatsApp group. Declined, or not answered within
  `relay.whatsapp.approval_ttl_seconds` (default 3600), then no binding opens, the group
  gets one line saying so, and the request is closed.
- AC-10 Given an approval answer from any other Telegram user or chat, then it is ignored
  and logged, as `answerLinkRequest` does today.
- AC-11 Given a code that is wrong, expired, already used, typed in a WhatsApp private
  chat, or typed in a group already bound to any trip, then no request is created, nothing
  is sent on Telegram, and the WhatsApp reply is at most one fixed line. More than
  `relay.whatsapp.code_attempts_per_hour` (default 5) failed attempts from one group
  silence that group for the rest of the hour.
- AC-12 Given `teardown-trip.py --execute` or a trip clear, then the trip's WhatsApp
  requests are expired before any other statement in the transaction (the lock order of
  `REVOKE_GROUP_TOKENS`), its WhatsApp bindings close with the same reason as its Telegram
  ones, and a restore from a clear archive reopens them with their platform intact.

**S3: transport**

- AC-13 Given no `relay.whatsapp` block in the architecture profile, then the relay starts
  no WhatsApp loop, opens no connection to a bridge, and behaves exactly as before.
- AC-14 Given a message in a WhatsApp chat with no open binding, then it is dropped
  without a reply and without reaching any gateway or any model, unless it is a code
  attempt (AC-8, AC-11). This includes every private chat with the number.
- AC-15 Given a bound WhatsApp group whose trip has the switch off, then inbound is
  dropped as in AC-14 and every outbound action for that chat is refused as
  `CHAT_NOT_IN_SCOPE`.
- AC-16 Given a bound group with the switch on, then a message reaches the trip's
  companion under exactly the conditions a Telegram group message would (AC-2's gate),
  with `source.platform = "whatsapp"` (subject to AC-0), `chat_type = "group"`, the
  group's JID as `chat_id`, an opaque sender id (Contracts) and the sender's WhatsApp
  display name; a message that is not addressed is held as overheard context exactly as on
  Telegram.
- AC-17 Given a gateway `send` to a bound WhatsApp group, then it passes the same scope
  check, silence verdict and leak filter as a Telegram send, is converted to WhatsApp
  formatting by the relay, and is delivered through the bridge; `edit`, `typing` and
  `get_chat_info` are performed through the bridge under the same scope check. The
  transport is chosen from the binding row's platform, never from the frame.
- AC-18 Given text that starts with `/` in a WhatsApp chat, then it never reaches a
  gateway (the catch-all of `dispatch.ts:1329` applies). No router command is offered on
  WhatsApp in this slice.
- AC-19 Given a photo or PDF with a caption that addresses the companion, or one sent
  without a caption and followed by an addressed message from the same sender within the
  existing hold window, then the companion receives it through the relay's media store.
  Media of a message that is never addressed is never downloaded by the relay.
- AC-20 Given any WhatsApp sender, then the sender's JID or phone number is not written
  to the database, not written to a log line, and not sent to a gateway; logs carry a
  digest. A WhatsApp sender is never passed to `resolveTripPerson`, `isTripOrganizer`,
  `isMainTripOrganizer` or any lookup keyed by a Telegram user id, and resolves to no trip
  person and no organizer role.
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
  with a question, and the same trip's Telegram group keeps working throughout.

## Contracts

### Chat ids are unique across platforms, and the platform comes from the row

An outbound frame carries only `chat_id` (`protocol.ts:208-242`) and nothing in a frame is
trusted, so the transport cannot be chosen from the frame. It is chosen from the binding
row. That requires a chat id to identify one chat on one platform:

- A WhatsApp chat id is stored and sent on the wire as the full group JID, suffix
  included (`<digits>@g.us`). The suffix is never stripped, anywhere.
- A Telegram chat id matches `^-?[0-9]{1,20}$`. The two shapes cannot overlap.
- `telegram_chat_bindings_active_chat_idx` (unique on `chat_id` where open) therefore
  stays as it is, name included (`group-binding.ts:410` matches the name).

### Migration (one file, `YYYYMMDDHHMMSS_chat_binding_platform.sql`)

`-- rollback: compatible — additive column with a default, one new table; the previous release never reads either`

- `telegram_chat_bindings.platform text NOT NULL DEFAULT 'telegram'`, CHECK in
  (`'telegram'`, `'whatsapp'`).
- CHECK: `platform = 'whatsapp'` implies `chat_id ~ '^[0-9]{5,40}@g\.us$'`; and
  `platform = 'telegram'` implies `chat_id !~ '@'`. (Not a full numeric CHECK on Telegram
  rows: legacy and test rows are not audited here.)
- New table `chat_binding_requests`: `id` (opaque), `trip_id` (FK), `platform`,
  `code_digest` (unique), `state` in (`issued`, `pending`, `approved`, `declined`,
  `expired`), `issued_to_digest` and `issued_in_chat_id` (the organizer's Telegram digest
  and private chat), `chat_id`, `chat_name`, `participant_count` (set when pending),
  `expires_at`, `created_at`, `decided_at`. Unique partial index: one row in `issued` or
  `pending` per (`trip_id`, `platform`).
- The table is platform-neutral by name; only `whatsapp` rows are written in this slice.
- The table and column are not renamed. A rename breaks the monitor role's column grants
  (`control-plane/deployment/monitor-db-role.sql:89`), about forty readers in four
  languages, and the `compatible` rollback. Renaming `telegram_chat_bindings` is a later,
  separate contract step.

**What "widen" covers in this slice:** `telegram_chat_bindings` only. Deferred, each to
the slice that first needs it: `intake_sessions.telegram_chat_id` and the interview tables
(WhatsApp interview), `trip_person_links.telegram_user_id` and the `telegram_*_links`
tables (WhatsApp identity), `telegram_group_binding_tokens` (replaced here by the request
table because a WhatsApp sender cannot be matched to `issued_to_telegram_user_id`),
`notification_outbox` targeting. `messaging_bindings` (migration 0001; `provider`,
`bot_ref`, `chat_ref`) stays unused: nothing reads or writes it, and moving routing onto
it would be the duplicate table this decision rules out.

### Chat kind: one predicate instead of the sign of the id

New `control-plane/api/src/chat-kind.ts`: `chatKind(chatId): "private" | "group" | "unknown"`
(Telegram: digits private, minus-digits group; WhatsApp: `@g.us` group; anything else
`unknown`, which every caller treats as the most restrictive answer). Intended result for
a WhatsApp group row at each reader that sniffs the sign today:

| Reader | Today | Required for a WhatsApp group row |
|---|---|---|
| `group-binding.ts:289` (`NOT_A_GROUP`) | `startsWith("-")` | unchanged; Telegram tokens are refused for a JID |
| `trip-audience.ts:34` (`isGroupChatId`) | minus-digits | excluded explicitly: `resolveTripAudience` and `confirmAudience` select `platform = 'telegram'` |
| `plan-change-poller.ts:347` | `~ '^-[0-9]{1,20}$'` | excluded explicitly by `platform = 'telegram'` |
| `analytics/store.ts:525` | `LIKE '-%'` | counted as a group (`chatKind`) |
| `telegram-mini-app.ts:887`, `organizer-trips.ts` private checks | digits-only | not private; unchanged |
| `relay/outbound-scope.ts:104`, `connector.ts:717`, `identity.ts:187` | digits-only | not private, so never `interview_handover`; unchanged |
| worker `gateway_reconcile.py:494` | digits-only | not private; add a test with a WhatsApp row |
| fleet monitor `fleet-mcp.mjs:1171,1939` | `LIKE '-%'` | shown as a group and not treated as an organizer private chat; `platform` added to the selected columns and to the monitor role's grant |

`trip-clear.ts` restores bindings by `UPDATE … WHERE id` (`trip-clear.ts:1508-1514`), so
the platform survives a restore without a change; AC-12 pins it with a test.

### `InboundTurn` and the gate (S1)

New `control-plane/api/src/relay/companion-gate.ts`. The body of `dispatch.ts:1355-1701`
moves here over this input; `dispatch.ts` keeps the Telegram-only work (callbacks, router
commands, the organizer document route) and builds the input.

```ts
export interface InboundTurn {
  platform: "telegram" | "whatsapp";
  chatId: string;
  chatType: ChatType;
  chatName: string | null;
  senderId: string | null;        // opaque per platform; see "Sender ids"
  senderName: string | null;
  text: string;
  messageId: string;
  replyToMessageId?: string;
  isReplyToAssistant: boolean;
  mentionsAssistantAccount: boolean; // @username on Telegram; a mention of the number on WhatsApp
  repliedToText?: string;            // for the reaction-answers-question rule
  attachment: AttachmentRef | null;  // { ref: string; kind; mime?; filename?; size? } — `ref` replaces Telegram's fileId
  repliedToAttachment: AttachmentRef | null;
}
```

`PendingAttachments` and `attachMedia` take `AttachmentRef` and a fetcher
`fetchAttachment(ref, maxBytes)` supplied per platform (`MediaDeps.telegram` is renamed).
The group judge's prompt takes the platform's name instead of the literal "Telegram"
(`group-judge.ts:150`); `addressedMark` is worded per platform (`stay-silent.ts:56-64`).

### Sender ids

WhatsApp gives a sender as a phone JID or a linked-identity id, sometimes both. The relay
derives one opaque id, `wa_` + the first 32 hex characters of HMAC-SHA256(relay secret,
canonical sender JID), preferring the phone form when both are present so the id is stable.
That value is `source.user_id`, the key of the conversation window
(`conversation_user_ids`) and of held attachments. The raw JID exists only in memory in
the bridge and the relay. `senderName` is the sender's WhatsApp display name: unverified,
shown to the model as a name, never used for a decision.

The number's own identity has two forms as well; reply-to-assistant and
mention-of-the-number compare against both, as reported by the bridge's `/health`.

### Bridge sidecar and `WhatsAppClient`

New package `control-plane/whatsapp-bridge/` (own `package.json`, so the WhatsApp Web
library does not enter the API's dependency tree; version pinned exactly). One process per
relay, one WhatsApp number per process. It binds loopback only and requires a bearer
secret on every request.

| Endpoint | Purpose |
|---|---|
| `GET /health` | connection state, own ids (both forms) |
| `GET /messages` | long-poll; returns events `{ chatId, isGroup, senderId, senderAltId, senderName, messageId, text, quotedMessageId?, quotedParticipant?, quotedText?, mentionedIds[], media?: { kind, mime, size, filename } }` |
| `GET /media/:chatId/:messageId` | bytes of a recent message's media, downloaded on demand; 404 after the bridge's bounded store has dropped it |
| `POST /send`, `/edit`, `/typing` | text out |
| `GET /chat/:id` | group title and participant count (ids are not returned) |
| `--pair-only` | print the QR, write the session, exit |

The bridge forwards group messages and private messages; it applies no allow-list and no
addressing rule of its own: the relay decides. It never forwards the number's own messages.
`relay/whatsapp/client.ts` defines `WhatsAppClient` (the calls above) with an HTTP
implementation; `relay/whatsapp/poller.ts` runs the loop and builds `InboundTurn`;
`relay/whatsapp/format.ts` converts the companion's Markdown to WhatsApp text.
`RelayConnector` receives `whatsapp?: WhatsAppClient` beside `telegram` and picks by
`route.platform` after `checkScope`.

Whether the sidecar is written fresh or adapted from the MIT-licensed bridge that ships
with Hermes is open question 3.

### Configuration

Architecture profile, `relay.whatsapp` (absent = feature not present):
`bridge_url` (loopback only, validated like `TELEGRAM_API_ROOT`), `bridge_secret_ref`,
`code_ttl_seconds`, `approval_ttl_seconds`, `code_attempts_per_hour`. The bridge's session
directory is the bridge's own argument and holds a credential: it lives in the
deployment's state, mode 0700, never in this repository. Starting and pairing the bridge
is deployment work (`kinerary-deploy`); this repository ships the generic package and a
runbook section in `docs/`.

Feature switch `whatsapp_group`: `surfaces: ["relay"]`, `memberVisible: false`, added to
`shared/feature-switches.js` and to the worker's mirror in `feature_block.py`. Read with
`featureEnabled(db, route.tripId, "whatsapp_group")` at three points: code issue, inbound
after the route resolves, outbound in `checkScope`.

### Files expected to change

`relay/dispatch.ts`, `relay/normalize.ts`, `relay/pending-attachments.ts`,
`relay/group-judge.ts`, `relay/stay-silent.ts`, `relay/connector.ts`,
`relay/outbound-scope.ts`, `relay/server.ts`, `relay/protocol.ts` (a WhatsApp descriptor
constant), `chat-router.ts` (`ChatRoute.platform`), `config.ts`, `trip-audience.ts`,
`plan-change-poller.ts`, `analytics/store.ts`, `trip-clear.ts` (requests),
`shared/feature-switches.js`, worker `feature_block.py` and `gateway_reconcile.py` (test
only), `scripts/teardown-trip.py`, `.agents/skills/trip-fleet-monitor/fleet-mcp.mjs`,
`control-plane/deployment/monitor-db-role.sql`. New: `relay/companion-gate.ts`,
`chat-kind.ts`, `chat-binding-requests.ts`, `relay/whatsapp/*`,
`control-plane/whatsapp-bridge/`, `control-plane/api/tools/fake-whatsapp.ts`.

## Non-goals

- The interview, signup, organizer approval flows or any button on WhatsApp.
- Private WhatsApp chats with the number (dropped silently, AC-14).
- Organizer or member identity on WhatsApp; organizer-gated actions from a WhatsApp group.
- Router commands on WhatsApp (`/trips`, `/proactive`, `/app`, …). The proactive level of
  a WhatsApp group is the default until a later slice.
- Plan-change lines, scheduled messages and outbox notifications to WhatsApp groups.
- Unbinding or moving a WhatsApp group other than by teardown or clear; leaving the group.
- The official WhatsApp Business API.
- Production. This slice is built and tried on staging; putting an unofficial client's
  number in a real family's group is a separate decision (open question 5).
- Renaming Telegram-named tables, columns, functions or triggers.

## Security and boundary notes

- **The relay stays the trust boundary.** `source.profile` is stamped from the binding row
  found by chat id; nothing in a WhatsApp message, a display name or a frame selects a
  trip, a profile or a transport. Unknown chat shape, unknown platform value, a failed
  lookup or an unreadable switch all resolve to "drop" inbound and "refuse" outbound,
  the same fail-safe direction as the visibility rules.
- **Binding is the one place a WhatsApp sender causes a privileged change**, and a
  WhatsApp sender is not a verified identity. The code proves only possession, so it does
  not bind anything by itself: the organizer approves on Telegram, where identity is
  verified, after seeing which group asks. Members see all of a trip's data through the
  companion, so a wrongly bound group is a disclosure; the code is single-use, short-lived
  and rate-limited for that reason.
- **Everyone in a bound group can talk to the companion**, as in a Telegram group. No
  WhatsApp participant has an organizer role (AC-20), so nothing organizer-gated can be
  triggered from WhatsApp.
- **Phone numbers.** A WhatsApp sender id is a phone number. It is never stored, logged or
  sent to a gateway (AC-20). Group JIDs are stored; they are not phone numbers.
- **The bridge receives every message of every group the number is in**, addressed or
  not, and the judge model reads group text at the trip's proactive level, as on Telegram.
  The introduction says so in one line (Behaviour 4). The privacy policy drafts in the
  notes folder do not mention WhatsApp (open question 4).
- **Lock order.** Approval takes: request row `FOR UPDATE`, then the open binding for the
  chat `FOR UPDATE`, then the binding insert. Teardown and clear expire requests first,
  the order `REVOKE_GROUP_TOKENS` already documents (issue #175).
- **The session directory is a credential** that gives full control of the WhatsApp
  account. It is deployment state, never in this repository, never in a container image.
- **Boundary review** is required for S2 and S3, with live request/response evidence for:
  an unbound group gets nothing; a bound group with the switch off gets nothing; a gateway
  cannot send to a WhatsApp chat that is not its own; a code typed by a stranger binds
  nothing without the organizer's approval.

## Test plan

Tests are written first, from the criteria.

- S1: no new assertions in the existing relay suites; new `companion-gate.test.ts` drives
  the gate with `InboundTurn` for both platforms over the same table of cases.
- S2: `chat-binding-requests.test.ts` (AC-6 to AC-11, the lock order under concurrent
  approve and teardown, as `group-binding`'s deadlock test does); a migration test for
  AC-3 and AC-4; `chat-kind.test.ts`; `tests/scripts/test_teardown_trip.py` and the
  trip-clear suite for AC-12; worker and fleet-monitor tests with a WhatsApp row.
- S3: `control-plane/api/tools/fake-whatsapp.ts`, a loopback stand-in for the bridge with a
  `/_control` API like `fake-telegram.ts`, so CI never needs the WhatsApp library or a
  number; `relay-whatsapp.test.ts` (AC-13 to AC-21); `relay-connector.test.ts` gains the
  cross-platform scope cases (AC-17); the bridge package has its own unit tests for event
  extraction and never connects out in CI.
- AC-22: the full existing relay and interview suites, unchanged.
- S4: the manual sitting, recorded as a run note in the notes folder.

## Rollout and regression

- Risk class on three counts: a migration, relay behaviour, a boundary path. A regression
  plan and the owner's manual test are required before each of S2 and S3 merges to `main`;
  S1 needs a regression plan as relay behaviour even though it changes none.
- Live trips feel nothing: the switch is off for every trip, no deployment has a
  `relay.whatsapp` block, and the migration is additive. The control-plane release that
  carries the migration to the production VM is after the Alsace freeze (not before
  2026-12-07) and needs the owner's own approval as any migration does.
- Staging gets it the usual way: merged to `main` switched off, picked up by the nightly
  redeploy. The staging bridge is started and paired by hand from the deployment
  repository. The S4 sitting uses a trip and a Telegram group that the PR #599 sitting
  does not use, and does not overlap it.
- Rollback: switch off per trip (immediate); remove the `relay.whatsapp` block and restart
  the relay (the loop is gone); the migration stays (compatible).

## Open questions

Decisions for Dror before approval.

1. **Which sprint owns this.** Sprint 9's scope is faster delivery. Proposed: its own
   track after Release 1, with S1 allowed earlier because it changes no behaviour.
2. **Proof at binding.** Recommended, and written into AC-8 to AC-10: code typed in the
   group, then the organizer approves on Telegram. The lighter alternative is code only,
   with a notice to the organizer and an undo; it is one step shorter and leaves a
   leaked code able to bind a stranger's group until someone notices.
3. **Bridge source.** Recommended: our own small sidecar, adapted from the MIT-licensed
   bridge that ships with Hermes, with the library version pinned. The alternative, running
   Hermes's bridge as it is, is faster but makes the relay's intake depend on a file inside
   another product's install, with its own allow-list and drop rules.
4. **Privacy wording.** The group introduction line, and whether the published privacy
   policy needs a WhatsApp paragraph before a group outside the owner's family is bound.
5. **Production.** The unofficial client breaks WhatsApp's terms and the number can be
   banned without notice. This spec stops at staging; whether and when a real family's
   group gets it is a later decision, with a dedicated number that is nobody's personal
   one.
6. **Product documents.** The MRD entry of 2026-10-30 says "WhatsApp Business", and the
   business plan and product spec price WhatsApp "per conversation"; Meta has billed per
   message since July 2025. Those documents are not edited by this spec. Should the
   doc-keeper update them to today's decision?
