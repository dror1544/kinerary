# The companion on WhatsApp, in a group or a private chat, through the relay (first slice)

Status: draft (2026-11-21; two consult reviews applied, the second on the dashboard binding design; not yet approved) · Issue: none yet (file one; this file is renamed to `<n>-whatsapp-via-relay.md` then) · Track: unowned (sprint to be named by Dror, open question 1) · Size: L (five slices) · Tier: High
Security path: yes (the relay's trust boundary, chat-to-trip resolution, outbound scope, portal routes, and in S5 an account and membership path) · Migration: yes (S2 and S5) · Live-trip behaviour: yes (relay behaviour; risk class), switched off by default

Related: `docs/per-trip-gateway-architecture.md` §4; `docs/specs/sprint-9/x-relay-chat-scope.md`
(outbound scope); `docs/specs/sprint-9/567-feature-switches.md`;
`docs/specs/sprint-9/x-member-sign-in.md` (traveller list, invitations);
`.agents/skills/hermes-multiplex-relay/SKILL.md` (why direct platform adapters are off).

Decisions taken by Dror:

- 2026-11-20: WhatsApp connects through the relay, never directly to a companion's
  gateway. The transport is the unofficial WhatsApp Web client (the official Business API
  cannot join an existing group). The existing binding table is widened to carry a
  platform, not duplicated.
- 2026-11-21: a WhatsApp chat is bound from the organizer dashboard, not through
  Telegram. A one-time, time-limited code sent as a WhatsApp message binds a private chat
  (the sender's number, to the trip) or a group; several codes may be live for one trip.
- 2026-11-21: a connected organizer binds a group simply by adding the number to it, with
  the dashboard group code as the fallback, where whoever sends the code in the group
  binds it. A traveller who is in the trip's bound group connects by messaging the number
  privately. An emailed invitation, built last, opens a Kinerary page that signs the
  traveller in and offers Connect my WhatsApp.

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
for a trip whose `whatsapp` switch is on:

1. **Connect my WhatsApp.** The trip's page in the dashboard has a WhatsApp section. Its
   first action opens WhatsApp on a chat with the deployment's number, with a message
   already written that carries a one-time code. The person presses send. That private
   chat is now bound to the trip and to their account: the companion answers there, and
   treats the trip's owner as the organizer they are.
2. **Add the bot to the group.** The trip's owner, once connected, adds the deployment's
   number to the family's existing group. The group is bound to the trip their own
   WhatsApp chat is connected to, and the companion introduces itself, including one line
   saying it reads the group's messages to know when it is addressed. The introduction
   never carries the trip site's password.
3. **Group code, the fallback.** An owner who has not connected their own WhatsApp, or who
   wants the group on another of their trips, adds the number to the group and then uses
   the dashboard's group link: WhatsApp's share screen opens with a coded message, and
   they pick the group and send.
4. **Travellers connect themselves.** Anyone who is in the trip's bound group can message
   the number privately. The bot asks which traveller they are, from the names nobody has
   claimed, and their private chat is bound to the trip as that traveller. If they leave
   the group, the private chat ends.
5. **Invitation by email (built last).** For someone who is not in the group, or whose
   account should be tied to their number: the owner picks the traveller and enters an
   email address, and Kinerary sends the invitation. Its link opens a Kinerary page that
   names the trip and the traveller, signs them in on confirmation, and offers Connect my
   WhatsApp (action 1). Connecting again from another number replaces the earlier one.
6. **Connected chats.** The dashboard section lists the trip's WhatsApp groups (by title)
   and people (by traveller name, how they connected, and the last four digits of the
   number), each with Remove. The owner is told each time a group or a person connects.
7. Codes work once and for 15 minutes. Any number can be issued for a trip over time.
8. In a bound group the companion behaves as in a Telegram trip group: it answers when
   addressed (its name, a reply to its message, a mention of the number, the conversation
   window, the group judge at the default proactive level) and stays silent otherwise. In
   a bound private chat every message is addressed to it. In both it receives a photo or
   PDF under the same rules as on Telegram and answers in plain WhatsApp text.
9. Telegram is not needed for any of this. The interview, buttons, the command menu, the
   Mini App, plan-change lines and scheduled messages stay on Telegram.

With the switch off, or with no WhatsApp number configured, the section is not shown and
nothing changes for anyone.

## Slices

| Slice | Content | Behaviour change |
|---|---|---|
| S1 | Extract the companion gate into one platform-neutral function | none (every existing test passes unedited) |
| S2 | Migration, chat kind by one predicate, binding codes, the dashboard section and its routes | none until the switch is on |
| S3 | WhatsApp bridge sidecar, relay client, inbound loop, binding by adding the number, travellers connecting from the group, outbound through the connector, stand-in for tests | behind the switch |
| S4 | Staging sitting on one test trip | staging only |
| S5 | Invitation by email with its landing page | behind the switch |

S1 merges first and alone. S2 and S3 may be built in parallel after it.

Sequencing against work in flight:

- PR #599 changes `relay/connector.ts`, `relay/protocol.ts` and `relay/server.ts`, which
  S3 also changes. S3 is briefed on a base that already has #599. S1 touches
  `relay/dispatch.ts` and `relay/poller.ts`, which #599 does not.
- `x-member-sign-in.md` owns three things this spec uses and does not redefine: the list
  of a trip's travellers (`listParticipants` and the exclusions of its AC-4), the invite
  for an existing traveller (its S2), and the switch-registry exception for a switch that
  gates a sign-in path. AC-29 (travellers from the group) needs the first; S5 needs all
  three. Whichever spec is built second reuses the first's code; neither duplicates it.
- That spec's S1 (its AC-2) requires "exactly one open group binding" and reads
  group-ness from a negative id. A WhatsApp binding must not count there; whichever lands
  second adds the test that pins it.

## Acceptance criteria

**AC-0 (spike, before S3 is briefed).** Read off real systems and recorded in this file; if
a finding contradicts a contract below, a spec PR amends it first.

- Against the Hermes version the deployment runs: what a gateway that said `hello` as
  Telegram does with an inbound event whose `source.platform` is `"whatsapp"`: session
  key, authorization (the gateway's own WhatsApp allow-list settings must not apply to a
  relayed event), reply egress, which descriptor governs length and formatting, and where
  it stores or shows the wire `chat_id`. Known from reading 0.21.5: `"whatsapp"` is a
  valid platform value and is not folded to `relay` (`gateway/relay/ws_transport.py`,
  `_event_from_wire`); the adapter remembers the platform per chat and falls back to the
  primary descriptor when none was negotiated for it. If the gateway mistreats the event,
  the relay stamps the primary platform instead. Either way the relay, not the gateway,
  owns WhatsApp formatting (AC-19).
- From a staging bridge capture: whether the event for the number being added to a group
  names who added it; whether the sender of a private chat can be matched to that
  person's entry in a group's participant list (the two can arrive in different id forms);
  the id shape of an old group and a new one; and how an @mention of a person appears in
  message text (the Sender ids contract assumes it is the person's number written out).

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

**S2: schema, codes and the dashboard**

- AC-3 Given the migration, then every existing binding row and person link has
  `platform = 'telegram'`, the active-chat unique index keeps its name and definition, and
  the previous release's code runs unchanged against the new schema (header
  `-- rollback: compatible`).
- AC-4 Given any attempt to store a `whatsapp` binding whose `chat_id` is not of an
  accepted WhatsApp shape, a `telegram` binding whose id contains `@`, a
  `transport_address` on anything but a WhatsApp private binding, or a WhatsApp person
  link whose stored role is not `participant`, then the database refuses it.
- AC-5 Given `resolveChatRoute`, then a `companion` route carries `platform` from the
  binding row, and no caller passes a platform in: the chat id alone selects the row.
  Given a database that does not have the column yet (new code, old schema), then routing
  for Telegram chats works exactly as before and no WhatsApp route can resolve.
- AC-6 Given a trip with `whatsapp` off, or a deployment with no WhatsApp number, then the
  dashboard shows no WhatsApp section and every WhatsApp route answers 404.
- AC-7 Given the switch on and a portal session under the "account" policy
  (`portal-scope.ts`; a Telegram-minted scoped session is refused 403
  `ACCOUNT_SIGN_IN_REQUIRED` before the handler, as on the neighbouring link routes), then:
  - any account with an active membership of the trip may ask for a `me` code, for
    itself only;
  - only the trip's owner may ask for a `group` code, read the connections, or Remove.
  A code is single-use, expires after `relay.whatsapp.code_ttl_seconds` (default 900), and
  is stored only as a digest. The answer carries the link to open and the expiry, is
  `no-store`, and is rate-limited per user as the Telegram link route is. Earlier codes
  stay valid; at most 10 are live per trip, and the oldest is expired to make room. Not a
  member, not the owner where the owner is required, not a trip, retired: one 404.
- AC-8 Given a valid `me` code in a message sent in a WhatsApp private chat, then in one
  transaction: the code is spent; any open binding of that chat is closed
  (`rebound_by_code`), whatever trip it was for, and its person link deleted; one binding
  row opens for that chat with `platform = 'whatsapp'` and the trip's companion profile
  (the rule of `openBinding`, `group-binding.ts:422-439`); and one person link is written
  for the sender with the issuing account and that account's traveller on the trip when
  it has one (Contracts, "Travellers"). The chat gets one fixed confirmation line naming
  the trip.
- AC-9 Given that redemption for trip T, then in the same transaction any other WhatsApp
  person link on T that names the same account, or the same traveller, is deleted and
  its private chat's binding closed (`rebound_by_code`): one account has one WhatsApp
  number per trip, and one traveller has one WhatsApp claim per trip. A partial unique
  index backs each.
- AC-10 Given a valid `group` code in a message sent in a WhatsApp group that has no open
  binding, then the code is spent, one binding row opens for the group with its title,
  and the introduction is sent to the group. The introduction says in one line that the
  companion reads the group's messages to know when it is addressed, and never includes
  the site password, whatever `groupIntroIncludesPassword` says. Who sent the message does
  not matter (owner's decision, 2026-11-21).
- AC-11 Given a code whose kind does not fit the chat (a `group` code in a private chat,
  a `me` code in a group), a code that is wrong, expired or already used, a `group` code
  in a group bound to a different trip, a group whose id is not of an accepted shape, or
  a trip that is retired or switched off at that moment, then nothing is bound, the code
  is not spent unless it was the right kind for the chat, and the WhatsApp reply is at
  most one fixed line. A `group` code in a group already bound to the same trip is spent
  and answered "already connected".
- AC-12 Given any message, then only a token of exactly the code shape (Contracts)
  anywhere in its text is a code attempt. More than
  `relay.whatsapp.code_attempts_per_hour` (default 5) failed attempts from one chat
  silence code handling for that chat for the rest of the hour. More than 50 failures
  across all chats in an hour raise one alert log line and silence nothing: one global
  cut-off would let anyone who can message the number stop every family from connecting.
- AC-13 Given a WhatsApp sender in a bound chat of trip T, then that sender resolves to a
  trip person only through a WhatsApp person link of T, looked up by the sender's opaque
  id. The role is derived at that moment from the link's account and never read from the
  stored column: an active `owner` membership of T gives `organizer`; an active
  `organizer` membership gives `secondary_organizer` (the distinction
  `chat-router.ts:298-305` already keeps); anything else, and every link with no account,
  gives `participant`. A sender with no link resolves to nobody.
- AC-14 Given a WhatsApp private binding whose person link names an account, when that
  account no longer has an active membership of the trip, then the binding closes
  (`membership_ended`) and the link is deleted: inside `removeMember`'s transaction
  (`member-removal.ts`), and as a check before each private turn for every other way a
  membership can end.
- AC-15 Given Remove in the dashboard, then the binding closes (`dashboard_removed`), its
  `transport_address` is cleared, the person link (for a private chat) is deleted, and
  nothing is sent to the chat. A later message from that chat is handled as from any
  unbound chat, so a person who is still in the trip's group can connect again (AC-29).
- AC-16 Given the connections route, then each row carries only: binding id, kind, the
  group's title or the traveller's name, how it was made, when, and for a person the last
  four digits of the number. No response of any route carries a full number or a code.
- AC-17 Given `teardown-trip.py --execute`, then the trip's live codes are expired before
  any other statement in the transaction (the lock order of `REVOKE_GROUP_TOKENS`), and
  its WhatsApp bindings close with the same reason as its Telegram ones, with
  `transport_address` cleared. A trip clear expires the trip's live codes, and still
  refuses a trip that ever had a binding (`trip-clear.ts`, `EVER_PROVISIONED`), whichever
  platform the binding was on.
- AC-18 Given a new WhatsApp binding of a trip, however it was made, then the trip's
  owner is told once, naming the group's title or the traveller and never a number: in
  the owner's connected WhatsApp private chat when there is one; otherwise through the
  existing outbox to the owner's Telegram private chat when there is one; otherwise only
  the dashboard list shows it. The owner's own `me` connection is not announced to them.
- AC-19 Given the gateway reconciler (`gateway_reconcile.py`, `FACTS_SQL`), then an open
  WhatsApp private binding of the trip's owner counts as the organizer's private chat
  when it decides whether a trip's companion is current, so a trip whose organizer uses
  only WhatsApp keeps its companion running.

**S3: transport**

- AC-20 Given no `relay.whatsapp` block in the architecture profile, then the relay starts
  no WhatsApp loop, opens no connection to a bridge, and behaves exactly as before. Given
  an open binding whose platform is `whatsapp` while no WhatsApp client is configured,
  then every outbound action for it is refused with
  `{ success: false, error: "PLATFORM_UNAVAILABLE" }` and no Telegram call is made.
- AC-21 Given a message in a WhatsApp chat with no open binding, then it is dropped
  without a reply and without reaching any gateway or any model, with exactly three
  exceptions: a code attempt (AC-8 to AC-12), a private message that starts a traveller's
  connection (AC-29), and a reply inside that open exchange.
- AC-22 Given a bound WhatsApp chat, group or private, whose trip has the switch off,
  then inbound is dropped as in AC-21 and every outbound action for that chat is refused
  as `CHAT_NOT_IN_SCOPE`.
- AC-23 Given a bound chat with the switch on, then a message reaches the trip's
  companion under exactly the conditions a Telegram message would (AC-2's gate), with
  `source.platform = "whatsapp"` (subject to AC-0), the chat's id as `chat_id`
  (Contracts), an opaque sender id and the sender's WhatsApp display name; a group
  message that is not addressed is held as overheard context exactly as on Telegram.
- AC-24 Given a gateway `send` to a bound WhatsApp chat, then it passes the same scope
  check, silence verdict and leak filter as a Telegram send, is converted to WhatsApp
  formatting by the relay, and is delivered through the bridge; `edit`, `typing` and
  `get_chat_info` are performed through the bridge under the same scope check. The
  transport is chosen from the binding row's platform, never from the frame. A `reply_to`
  quotes only a message of the same chat, and an `edit` changes only a message the number
  itself sent in that chat.
- AC-25 Given text in a WhatsApp chat that `parseInbound` reads as a command, then it is
  dropped without a reply and never reaches a gateway. No router command exists on
  WhatsApp in this slice.
- AC-26 Given a photo or a document, then it joins a turn under the rules the gate applies
  on Telegram today: with a caption that addresses the companion, as the replied-to
  message of an addressed reply from the same sender, or (documents only) when held and
  followed by an addressed message from the same sender within the existing hold window.
  The relay never downloads media of a message that did not join a turn.
- AC-27 Given any WhatsApp participant, connected or not, then that person's WhatsApp id
  or phone number is not written to a log line, not sent to a gateway or to the judge
  model in any field or inside message text, and not written to the database, with one
  exception: the `transport_address` of an open private binding, which the relay needs in
  order to send. It is cleared when the binding closes, is not readable by the monitor's
  database role, and is the only column that holds one.
- AC-28 Given the number is added to a group that has no open binding, by a participant
  whose WhatsApp person link names an account that is at that moment the active owner of
  trip T, where T is the trip that participant's own private chat is bound to, and T is
  not retired and has the switch on, then one binding row opens for the group on T and
  the introduction is sent (as AC-10). In every other case (added by anyone else, by a
  secondary organizer, by an owner with no connected private chat, or an event that does
  not say by whom) nothing is bound and nothing is sent; the group code still works.
- AC-29 Given a private message from a chat with no open binding, whose sender is at that
  moment a participant of a WhatsApp group bound to a trip with the switch on, then the
  bot answers with the trip's name and a numbered list of that trip's unclaimed
  travellers (Contracts, "Travellers") and asks which one they are. A reply naming one
  within 15 minutes opens a binding for the private chat and writes a person link with
  that traveller, no account and `verified_via = 'group_membership'`. Given the sender is
  in bound groups of more than one trip, the bot asks which trip first. A reply that
  names nothing on the list binds nothing; three misses end the exchange. One sender
  starts at most three exchanges an hour; beyond that the message is dropped.
- AC-30 Given a person link with `verified_via = 'group_membership'`, when that person is
  no longer a participant of any group bound to the trip (seen as a participant-left
  event, or on the membership check that precedes each private turn, cached for at most
  ten minutes), then the private chat's binding is closed (`left_group`) and the link is
  deleted, with one fixed line to the chat. Links made by a `me` code are not affected.
- AC-31 Given a membership check that cannot be made (bridge down, group metadata
  unavailable, id forms that cannot be matched), then for AC-29 it counts as "not a
  participant" and nothing is offered; for AC-30 the turn is not forwarded, the chat gets
  one fixed line saying the companion is unavailable for the moment, nothing is closed,
  and after 24 hours of failed checks the binding closes as in AC-30.
- AC-32 Given the bridge is unreachable, logged out or restarted, then the relay logs one
  state change, keeps serving Telegram unaffected, and resumes WhatsApp when the bridge
  reports connected. A gateway action for a WhatsApp chat while the bridge is down gets
  one `outbound_result` with `success: false`.
- AC-33 Given the Telegram path, then inbound routing, outbound scope, the interview and
  their existing tests are unchanged.

**S4: staging sitting** (manual, on one test trip before `ready_private` or approved as a
staging rollout)

- AC-34 The owner connects their WhatsApp from the dashboard, binds a real WhatsApp group
  by adding the number to it, and a second person in that group connects privately and
  claims a traveller. The companion answers a trip question in the group when named,
  stays silent on ordinary chatter for ten minutes, reads a PDF sent with a question,
  answers in both private chats, and the same trip's Telegram group keeps working
  throughout.

**S5: invitation by email**

- AC-35 Given the trip's owner invites an existing traveller with an email address, then
  the invite of `x-member-sign-in.md` S2 is created for that traveller carrying the
  address's digest, one email with its link is sent to that address through the existing
  mailer in the trip's language, and the response carries no link. At most 20 invitation
  emails are sent per trip per day; the address is validated as the portal validates a
  sign-up address. With no mailer configured the route refuses and creates nothing.
- AC-36 Given the email's link, then it opens a page on the dashboard origin that names
  the trip and the traveller and changes nothing (`/v1/site-invites/inspect` is already
  read-only), so a mail scanner that fetches it spends nothing. Confirming it, in one
  transaction: resolves the account of the invitation's address through
  `resolveOrCreateEmailAccountByDigest`; writes that account's unknown-password
  credential if it has none (a digest form of `ensureUnknownPasswordCredential`), so the
  account cannot be claimed by whoever signs up with the address first; ensures a
  `member` membership of the trip tied to that traveller, never raising or lowering an
  existing role; and starts a portal session for that account. The page then shows
  Connect my WhatsApp, which is AC-7's `me` code.
- AC-37 Given an invitation that carries an address, then it is redeemed only by that
  confirmation: the password and Google methods of the ordinary invite redemption refuse
  it, and whatever session the browser already holds is ignored and replaced, so opening
  the link on the organizer's own device cannot tie the traveller to the organizer's
  account.
- AC-38 Given a traveller whose invitation was already redeemed, when the owner invites
  them again with the same address, then no new invite row is made: the email carries a
  single-use sign-in link for that account that lands on the same page. A different
  address is refused until the owner releases the traveller.

## Contracts

### Chat ids: unique across platforms, and never a phone number

An outbound frame carries only `chat_id` (`protocol.ts:208-242`; `parseOutboundAction`
drops everything else) and nothing in a frame is trusted, so the transport cannot be
chosen from the frame. It is chosen from the binding row. That requires a chat id to
identify one chat on one platform:

| Chat | `chat_id`, as stored and as sent on the wire |
|---|---|
| Telegram | `^-?[0-9]{1,20}$`, as today |
| WhatsApp group | the group's id, `^[0-9]{5,40}@g\.us$`, suffix never stripped |
| WhatsApp private chat | an alias, `^wa_[0-9a-f]{32}@p$`: the person's opaque id (below) plus `@p` |

- The shapes cannot overlap, so `telegram_chat_bindings_active_chat_idx` (unique on
  `chat_id` where open) stays as it is, name included (`group-binding.ts:410` matches the
  name).
- A private chat's real WhatsApp address is kept only in `transport_address` on its open
  binding row. The relay maps alias to address when it sends and address to alias when it
  receives; a gateway, a log line and the monitor see only the alias.
- Older WhatsApp groups carry their creator's phone number in the id
  (`<phone>-<timestamp>@g.us`). Those are not accepted in this slice: a code there gets
  one fixed line (AC-11), adding the number binds nothing, and nothing is stored. AC-0
  confirms the shapes.

### Migration, S2 (one file, `YYYYMMDDHHMMSS_chat_binding_platform.sql`)

`-- rollback: compatible — additive columns with defaults and one new table; the previous release never routes a WhatsApp-shaped row (its fleet monitor would mislabel one as a private chat, which a rollback note covers)`

`telegram_chat_bindings`:

- `platform text NOT NULL DEFAULT 'telegram'`, CHECK in (`'telegram'`, `'whatsapp'`).
- `transport_address text` and `chat_title text`, both nullable.
- CHECK: `platform = 'whatsapp'` implies `chat_id` matches the group shape or the alias
  shape; `platform = 'telegram'` implies `chat_id !~ '@'`. The second also stops a legacy
  writer that re-inserts a row without a platform from turning a WhatsApp id into a
  Telegram row. Staging holds no row that fails either (checked 2026-11-21: 125 rows,
  none); the production count is read before the release that carries the migration.
- CHECK: `transport_address` is NULL unless the row is a WhatsApp private binding, and is
  NULL on every closed row.
- New close reasons: `dashboard_removed`, `rebound_by_code`, `left_group`,
  `membership_ended`. `closed_reason` has no enum (`0029`), and no existing reader
  branches on any of them.

`trip_person_links`:

- `platform text NOT NULL DEFAULT 'telegram'`; `account_user_id` nullable, FK to users.
- On `whatsapp` rows: `telegram_user_id` (the column keeps its name) holds the opaque
  sender id, shape `^wa_[0-9a-f]{32}$`; the existing `^[0-9]{1,20}$` CHECK becomes
  per-platform. `participant_username` may be NULL (an owner with no traveller). `role` is
  always stored as `participant` and never read (AC-13); no trigger is added, and the
  Telegram-digest triggers do not match these rows (`20261023120000:53`).
- `verified_via` gains `'dashboard_code'` and `'group_membership'`.
- Partial unique indexes over `whatsapp` rows: (`trip_id`, `account_user_id`) where the
  account is set, and (`trip_id`, `participant_username`) where the traveller is set
  (AC-9).

New table `chat_binding_codes`: `id` (opaque), `trip_id` (FK), `platform`, `kind` in
(`me`, `group`), `issued_by_user_id`, `code_digest`, `state` in (`issued`, `redeemed`,
`expired`), `binding_id` (set when redeemed), `expires_at`, `created_at`, `redeemed_at`.
Unique partial index on `code_digest` over `issued`; no one-per-trip index. The table is
platform-neutral by name; only `whatsapp` rows are written in this slice.

- **Code shape.** `KWA-` plus 8 characters of the alphabet the group tokens use
  (`group-binding.ts:50-79`). The dashboard wraps it in a short sentence in the person's
  language; the relay reads only the token. Failed-attempt counts are kept in the relay's
  memory; a relay restart resets them.
- **Nothing is renamed.** A rename breaks the monitor role's column grants
  (`control-plane/deployment/monitor-db-role.sql:89`), about forty readers in four
  languages, and the `compatible` rollback. Renaming `telegram_chat_bindings` is a later,
  separate contract step.
- **The monitor's grants do not change.** It already reads `chat_id`, which now never
  holds a number; `transport_address` is not granted, and a test pins that.
- **New code on the old schema.** Migrations are a separate step from a restart, and the
  production release that carries this one waits for the freeze to end. The route query
  therefore reads the platform in a form that does not fail when the column is absent
  (absent reads as `telegram`; for example `COALESCE(to_jsonb(b)->>'platform','telegram')`),
  and no query on a path that Telegram traffic uses selects a new column (AC-5).

**What "widen" covers:** `telegram_chat_bindings` and `trip_person_links`. Deferred, each
to the slice that first needs it: `intake_sessions.telegram_chat_id` and the interview
tables (WhatsApp interview), the `telegram_*_links` tables (they model the Telegram
sign-in to the dashboard and Mini App, which WhatsApp does not have),
`telegram_group_binding_tokens` (a Telegram deep-link token tied to a Telegram sender; the
codes table serves WhatsApp), `notification_outbox` targeting. `messaging_bindings`
(migration 0001) stays unused: nothing reads or writes it, and moving routing onto it
would be the duplicate table this decision rules out.

### Migration, S5

`site_invites.email_digest text`, nullable (`-- rollback: compatible`). A row that has it
is an emailed invitation (AC-37). Its lifetime is the site invite's own (seven days today,
`portal.ts:1709`); this spec adds no second lifetime.

### Chat kind: one predicate instead of the sign of the id

`chatKind(chatId): "private" | "group" | "unknown"` in `identity.ts`, beside
`isPrivateChatId` (Telegram: digits private, minus-digits group; WhatsApp: `@g.us` group,
`@p` private; anything else `unknown`, which every caller treats as the most restrictive
answer). It reads the id's shape only, so no reader needs the new column.
`isPrivateChatId` itself keeps meaning "a Telegram private chat": a WhatsApp private chat
is never an `interview_handover` and never a Mini App chat, and the digits-only readers
exclude it without a change. Intended result for a WhatsApp row at each reader that
sniffs the sign today:

| Reader | Today | Required for a WhatsApp row |
|---|---|---|
| `group-binding.ts:289` (`NOT_A_GROUP`) | `startsWith("-")` | unchanged; a Telegram token is refused for a WhatsApp id |
| `trip-audience.ts:34` (`isGroupChatId`) | minus-digits | excluded, stated in a comment and pinned by a test: no outbox message goes to a WhatsApp group |
| `plan-change-poller.ts:347` | `~ '^-[0-9]{1,20}$'` | excluded the same way |
| `analytics/store.ts:525` | `LIKE '-%'` | a group counts as a group (SQL form of `chatKind`); `channelTypeOf` (`analytics/contract.ts:499-510`) classifies both kinds |
| `telegram-mini-app.ts`, `organizer-trips.ts` private checks | digits-only | not a Telegram private chat; unchanged |
| `relay/outbound-scope.ts:104`, `identity.ts:187` | digits-only | never `interview_handover`; unchanged |
| `relay/connector.ts:717` (`chat_kind` in the refusal log) | digits-only | uses `chatKind`, so a WhatsApp private chat is logged as private |
| worker `gateway_reconcile.py:494` | digits-only | an owner's WhatsApp private binding counts (AC-19) |
| worker `verification.py:359-372` | any open binding | unchanged: a WhatsApp-only trip passes "has a messaging binding" |
| fleet monitor `fleet-mcp.mjs:1171,1941` | `LIKE '-%'` | group shown as a group, private as private, and a WhatsApp private chat does not satisfy "the organizer has a Telegram private chat"; decided from the id's shape |

Writers that insert a binding without naming a platform (`switch-trip-chat.py:191`,
`organizer-trips.ts:656`, `provisioner.py:892`, `group-binding.ts:424`) keep doing so and
get `telegram`; the CHECK refuses them a WhatsApp id.

### Travellers

- **The trip's travellers** come from `listParticipants` on the runtime account adapter,
  which `x-member-sign-in.md` defines; this spec adds no second source. "Unclaimed"
  (AC-29) applies that spec's AC-4 exclusions (organizers, owners, travellers already
  mapped to an account) and also excludes any traveller with a WhatsApp person link.
- **An account's traveller** (AC-8) is the one its redeemed site invite or web credential
  maps it to (`portal.ts:1891-1893`). An owner usually has none; their link then carries
  no traveller and the companion sees their WhatsApp display name.
- A `me` connection outranks a claim from the group: it replaces a `group_membership`
  link that names the same traveller (AC-9).

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
  senderId: string | null;           // Telegram user id, or the WhatsApp opaque id
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
  resolvePerson(tripId: string, senderId: string): Promise<TripPerson | null>; // WhatsApp supplies the lookup of AC-13, keyed by the opaque id
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
  and is not behind the switch. The per-turn mark tells the companion it is on WhatsApp
  and to answer in plain text.

### Sender ids and phone numbers

WhatsApp gives a participant as a phone id or a linked-identity id, sometimes both. The
bridge reduces it to one canonical form, preferring the phone form when both are present.
The relay derives one opaque id from it: `wa_` + the first 32 hex characters of
HMAC-SHA256(key, canonical id).

- The opaque id is `source.user_id` for every sender, the key of the person link
  (AC-13), of the conversation window (`conversation_user_ids`) and of held attachments.
  With `@p` appended it is the `chat_id` of that person's private chat.
- The key is its own secret (`relay.whatsapp.sender_id_secret_ref`). It is not rotated in
  place: a new key orphans every WhatsApp private binding and person link, so rotation
  means everyone connects again. The runbook says so.
- A raw participant id is held in the relay's memory, and in `transport_address` for an
  open private binding. The bridge's session directory also holds them on disk: the
  WhatsApp Web library keeps per-participant key files there. That directory is a
  credential under the deployment's care (Configuration).
- Before message text, a caption or replied-to text is used for anything (the gate,
  overheard context, the judge, the wire), the relay rewrites every @mention of a number:
  the number's own mention becomes the assistant's first name, anyone else's becomes
  "someone". (Rewriting to a display name is a later refinement.)
- `senderName` is the sender's WhatsApp display name: unverified, shown to the model as a
  name, never used for a decision, and empty rather than a number when the name is absent.
- The number's own identity has two forms as well; reply-to-assistant and
  mention-of-the-number compare against both, as reported by the bridge's `/health`.
- The relay decides group or private from the chat id's shape and drops the number's own
  messages itself; it does not rely on the bridge's flags for either.

### What the relay says by itself on WhatsApp

These are sent by the relay's WhatsApp loop, do not pass `checkScope`, and are the
complete list: the fixed reply to a code attempt (AC-8, AC-10, AC-11); the introduction
(AC-10, AC-28); the traveller exchange's questions and its result (AC-29); the two fixed
lines of AC-30 and AC-31; the owner's notice in the owner's own private chat (AC-18).
Remove and teardown send nothing.

**Open exchanges.** The traveller exchange of AC-29 is the only conversation the relay
holds. Its state lives in the relay's memory, keyed by the private chat's alias, for 15
minutes. It is consulted before code handling and before the unbound-chat drop (AC-21);
it never exists for a bound chat, so no reply can be mistaken for a message to the
companion. A relay restart forgets it and the person simply writes again.

### Bridge sidecar and `WhatsAppClient`

New package `control-plane/whatsapp-bridge/` (own `package.json`, so the WhatsApp Web
library does not enter the API's dependency tree; version pinned exactly). One process per
relay, one WhatsApp number per process. It binds loopback only and requires a bearer
secret on every request.

| Endpoint | Purpose |
|---|---|
| `GET /health` | connection state, own ids (both forms) |
| `GET /messages` | long-poll; returns messages and three group events (`added_to_group` with `addedBy` when known, `participant_left`, `title_changed`). A message is `{ chatId, senderId, senderName, messageId, text, quotedMessageId?, quotedParticipant?, quotedText?, mentionedIds[], media?: { kind, mime, size, filename } }`, ids in canonical form |
| `GET /media/:chatId/:messageId` | bytes of a recent message's media, downloaded on demand; 404 after the bridge's bounded store has dropped it |
| `POST /send` | text out; a `replyTo` is honoured only for a message of the same chat |
| `POST /edit` | only a message the number sent in that chat |
| `POST /typing` | typing indicator |
| `GET /chat/:id` | group title (participant ids are not returned) |
| `GET /chat/:id/participant/:participantId` | whether that id is in the group now; the bridge does the matching across id forms |
| `--pair-only` | print the QR, write the session, exit |

The bridge applies no allow-list and no addressing rule of its own: the relay decides.
`relay/whatsapp/client.ts` defines `WhatsAppClient` (the calls above) with an HTTP
implementation; `relay/whatsapp/poller.ts` runs the loop and builds `InboundTurn`;
`relay/whatsapp/format.ts` converts the companion's Markdown to WhatsApp text.
`RelayConnector` receives `whatsapp?: WhatsAppClient` beside `telegram` and picks by
`route.platform` after `checkScope`. A group's title is written to `chat_title` when the
group is bound and again on `title_changed`; the API reads it from the row, since only
the relay can reach the bridge.

Whether the sidecar is written fresh or adapted from the MIT-licensed bridge that ships
with Hermes is open question 3.

### Configuration

Architecture profile, `relay.whatsapp` (absent = feature not present): `bridge_url`,
`bridge_secret_ref`, `sender_id_secret_ref`, `number` (what the dashboard's links open;
read by the API as well), `code_ttl_seconds`, `code_attempts_per_hour`. `bridge_url`
passes a new validator that accepts loopback addresses only (`telegramApiRoot` is not
reused: it accepts https to any host). How a containerised relay shares loopback with the
bridge is the deployment's concern. The bridge's session directory is the bridge's own
argument and holds a credential: it lives in the deployment's state, mode 0700, never in
this repository. Starting and pairing the bridge is deployment work (`kinerary-deploy`);
this repository ships the generic package and a runbook section in `docs/`.

Feature switch `whatsapp`: `surfaces: ["relay", "control_plane"]`, `memberVisible: false`,
added to `shared/feature-switches.js` and to the worker's mirror in `feature_block.py`.
The registry's rule is that a switch never widens visibility or permission; this one
gates new ways to bind a chat and, in S5, to sign in, so it needs the recorded exception
`x-member-sign-in.md` asks for its own switch (open question 7). It is read with
`featureEnabled(db, tripId, "whatsapp")` at: the portal routes, code redemption, the two
no-code bindings (AC-28, AC-29), inbound after the route resolves, and outbound inside
`resolveOutboundRoute` (`outbound-scope.ts`; the connector holds no database handle by
design). The outbound read happens only when the route's platform is `whatsapp`: a
Telegram route never reads the switch, so an unreadable switch cannot refuse a Telegram
send.

### Dashboard routes and page

All under the existing portal (`portal.ts`), `requireMutation` for writes, the "account"
session policy, each with its row in `PORTAL_SCOPE_POLICY` (`portal-scope.ts:142-148`
throws at boot without one):

| Route | Who | Does |
|---|---|---|
| `POST /v1/trips/:id/whatsapp-codes` `{ kind }` | `me`: any active member, for itself; `group`: owner | issues a code; returns `{ link, expiresAt }` |
| `GET /v1/trips/:id/whatsapp-connections` | owner | AC-16 |
| `DELETE /v1/trips/:id/whatsapp-connections/:bindingId` | owner | Remove (AC-15) |
| S5: `POST /v1/trips/:id/traveller-invitations` `{ participant, email }` | owner | AC-35; returns `{ expiresAt }` only |
| S5: confirm an emailed invitation | whoever holds the link | AC-36, AC-37 |

Links: `me` opens `https://wa.me/<number>?text=<message>`; `group` opens
`https://wa.me/?text=<message>`, WhatsApp's share screen, because a link cannot target a
group. The page (`web/src/pages/TripWhatsApp.tsx`, beside `TripTelegram.tsx`) shows the
number to add to the group. A member has no dashboard trip page today (`portal.ts`), so
until S5 only owners and organizers reach the `me` action; S5's landing page is how a
traveller reaches it. The invitation email is a new `PortalMail` kind in
`portal-email-templates.ts`, sent through `Mailer` (`mailer.ts`).

### Lock order

- Code redemption: code row `FOR UPDATE`, then the open binding for the chat
  `FOR UPDATE`, then the binding insert. Where two binding rows are closed in one
  transaction (AC-8, AC-9) they are locked in `chat_id` order.
- No-code bindings (AC-28, AC-29): the open binding for the chat `FOR UPDATE`, then an
  insert that selects the trip only if it is not retired. That leaves the residual race
  `group-binding.ts:260-278` already documents for Telegram, a binding opened beside an
  uncommitted teardown; it is not made worse.
- Teardown and clear expire codes first, the order `REVOKE_GROUP_TOKENS` documents
  (issue #175).

### Files expected to change

`relay/dispatch.ts`, `relay/poller.ts`, `relay/normalize.ts`,
`relay/pending-attachments.ts`, `relay/group-judge.ts`, `relay/stay-silent.ts`,
`relay/connector.ts`, `relay/outbound-scope.ts`, `relay/server.ts`, `chat-router.ts`
(`ChatRoute.platform`, the WhatsApp person lookup), `identity.ts`, `config.ts`,
`portal.ts`, `portal-scope.ts`, `member-removal.ts`, `trip-clear.ts`, `web/src/api.ts`,
`trip-audience.ts` and `plan-change-poller.ts` (comment and test only),
`analytics/store.ts`, `analytics/contract.ts`, `shared/feature-switches.js`, worker
`feature_block.py` and `gateway_reconcile.py`, `scripts/teardown-trip.py`,
`.agents/skills/trip-fleet-monitor/fleet-mcp.mjs`. S5: `password-identity.ts`,
`portal-email-templates.ts`. New: `relay/companion-gate.ts`, `chat-binding-codes.ts`,
`web/src/pages/TripWhatsApp.tsx`, `relay/whatsapp/*`, `control-plane/whatsapp-bridge/`,
`control-plane/api/tools/fake-whatsapp.ts`. Retired or rewritten in S3:
`.agents/skills/trip-bot-messaging-platform-setup/`, which teaches the rejected direct
pairing.

## Non-goals

- The interview, signup, organizer approval flows or any button on WhatsApp.
- A reply to a private chat that is neither bound nor from someone in a bound group.
- Signing in to the dashboard or the trip site with WhatsApp. A WhatsApp person link gives
  a role inside the chat only.
- Switching a private chat between trips by command. A newer `me` code rebinds it; a
  traveller who connected from the group and is in two trips' groups reaches one of them
  until they are removed and connect again.
- Router commands on WhatsApp (`/trips`, `/proactive`, `/app`, …). The proactive level of
  a WhatsApp group is the default until a later slice.
- Plan-change lines, scheduled messages and outbox notifications to WhatsApp chats.
- Moving a bound group to another trip other than Remove, then a new code. After Remove
  or teardown the number is still a member of the family's group and the bridge still
  receives its messages; the relay drops them. Leaving the group is a later slice.
- Old-style WhatsApp groups whose id carries a phone number.
- Storing an owner's email address for notices (the control plane keeps digests only).
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
- **What proves what at binding.** A WhatsApp sender is not a verified identity. The
  verified thing is a portal session:
  - A `me` code is minted in the session of an active member and binds whoever sends it
    as that account, once, within 15 minutes. It is sent from the person's own phone
    seconds after it is minted and is never meant to be forwarded. This is the trust
    model of the dashboard's Telegram link (`POST /v1/trips/:id/telegram-link`).
  - A `group` code is minted in the owner's session. It is visible to the whole group
    once sent, and already spent by then.
  - Adding the number binds a group only when the WhatsApp client reports that the
    trip's connected owner did the adding (AC-28). That report comes from the unofficial
    client, the same source that says who sent a message; an absent or unmatched report
    binds nothing.
  - A traveller who connects from the group proves one thing: that they are in a group
    the owner bound. Which traveller they are is their own claim, so such a link never
    carries an account or a role above participant, the owner is told (AC-18), and
    Remove releases the name.
  - An emailed invitation (S5) goes only to the address the owner typed, so confirming it
    shows control of that mailbox, the same evidence an emailed sign-in link gives.
- **Risks that are accepted and stated.**
  - *The wrong group.* An owner who adds the number to a group that is not the family's
    binds it at once. Everyone there can ask the companion about the trip, and members
    see all of a trip's data, and each can connect privately as an unclaimed traveller.
    The owner's notice and the dashboard list are the control. After Remove the number is
    still in that group until a person takes it out.
  - *Remove does not keep out someone who is still in the group* (AC-15, AC-29).
    Removing them from the group does (AC-30).
  - *A mistyped or forwarded invitation email* lets someone else become that traveller.
    The session it starts is an ordinary portal session for the address's account, so for
    an address that already has an account it is that whole account, other trips
    included, exactly as an emailed sign-in link is.
- **Roles are derived, never stored** (AC-13), and a secondary organizer stays a
  secondary organizer on WhatsApp. Ending a membership ends the chat (AC-14).
- **A gateway sends only to its own chats**, by the rule of `x-relay-chat-scope.md`,
  including its declared exception: the multiplex gateway, while one is configured, may
  send to any companion chat on either platform.
- **Everyone in a bound group can talk to the companion**, as in a Telegram group. An
  organizer-gated action from WhatsApp is allowed exactly when AC-13 gives the sender
  the role that action needs on Telegram.
- **Phone numbers** rest in one database column, `transport_address` of open private
  bindings, and in the bridge's session directory (AC-27). An @mention writes a number
  into message text, so text is rewritten before use. A plain hash of a phone number is
  reversible by enumeration, so the opaque id is keyed.
- **The bridge receives every message of every group the number is in**, addressed or
  not, and the judge model reads group text at the trip's proactive level, as on Telegram.
  The introduction says so in one line (AC-10). The privacy policy drafts in the notes
  folder do not mention WhatsApp (open question 4).
- **The session directory is a credential** that gives full control of the WhatsApp
  account. It is deployment state, never in this repository, never in a container image.
- **Boundary review** is required for S2, S3 and S5, with live request/response evidence
  for: an unbound chat gets nothing; a bound chat with the switch off gets nothing; a
  companion's gateway cannot send to a WhatsApp chat that is not its own; a spent,
  expired or wrong-kind code binds nothing; the routes answer a non-member and a
  non-owner with 404 and a Telegram-minted session with 403; a secondary organizer
  resolves as one and cannot bind a group by adding the number; a removed member's
  private chat is closed; no response, log line, inbound frame or monitor-readable column
  carries a phone number after a turn with an @mention; and for S5, an invited address
  cannot be claimed by signing up with it, and confirming on a device signed in as
  someone else does not join that account.

## Test plan

Tests are written first, from the criteria.

- S1: no edit to any existing test (AC-1); new `companion-gate.test.ts` drives the gate
  with `InboundTurn` for both platforms over the same table of cases.
- S2: a migration test (AC-3, AC-4); an old-schema test for AC-5 (the route query against
  a table without the column); `chatKind` cases; `chat-binding-codes.test.ts` (AC-8 to
  AC-12, AC-15, the lock order under concurrent redeem and teardown, as
  `group-binding`'s deadlock test does, and the two unique indexes of AC-9 under
  concurrent redemptions); a role table for AC-13 (owner, secondary organizer, member,
  ended membership, no account); AC-14 through `removeMember`; portal route tests for
  AC-6, AC-7 and AC-16, including the 403 and the 404; AC-18 for each of its three
  cases; `TripWhatsApp.test.tsx`; `tests/scripts/test_teardown_trip.py` and the trip-clear
  suite for AC-17; worker tests for AC-19; the fleet-monitor and
  `test_monitor_db_role.py` tests with WhatsApp rows (the role cannot read
  `transport_address`).
- S3: `control-plane/api/tools/fake-whatsapp.ts`, a loopback stand-in for the bridge with a
  `/_control` API like `fake-telegram.ts`, so CI never needs the WhatsApp library or a
  number; `relay-whatsapp.test.ts` (AC-20 to AC-27 and AC-32, including a scan of logs,
  frames and database rows for the digits of the fixture phone numbers);
  `whatsapp-binding.test.ts` for AC-28 to AC-31, driving the stand-in's added-to-group and
  participant-left events and its membership answer, including an event with no
  `addedBy`; `relay-connector.test.ts` gains the cross-platform scope cases (AC-20,
  AC-24); the bridge package has its own unit tests for event extraction and id
  canonicalisation and never connects out in CI.
- AC-33: the full existing relay and interview suites, unchanged.
- S4: the manual sitting, recorded as a run note in the notes folder.
- S5: portal route tests with a fake mailer (AC-35 to AC-38: the response never carries
  the link; opening without confirming changes nothing; the account holds a credential
  after confirmation and a later sign-up with that address cannot take it; an existing
  session is replaced, not joined); a page test.

## Rollout and regression

- Risk class on three counts: migrations, relay behaviour, boundary and account paths. A
  regression plan and the owner's manual test are required before each of S2, S3 and S5
  merges to `main`; S1 needs a regression plan as relay behaviour even though it changes
  none.
- Live trips feel nothing: the switch is off for every trip, no deployment has a
  `relay.whatsapp` block, the migrations are additive, and new code runs on the old
  schema (AC-5). The control-plane release that carries the S2 migration to the
  production VM is after the Alsace freeze (not before 2026-12-07) and needs the owner's
  own approval as any migration does.
- Staging gets it the usual way: merged to `main` switched off, picked up by the nightly
  redeploy. The staging bridge is started and paired by hand from the deployment
  repository. The S4 sitting uses a trip and a Telegram group that the PR #599 sitting
  does not use, and does not overlap it.
- Rollback: switch off per trip (immediate); remove the `relay.whatsapp` block and restart
  the relay (the loop is gone and WhatsApp chats are refused, AC-20); the migration stays
  (compatible). A release rolled back past S2 while WhatsApp rows exist leaves the old
  fleet monitor labelling them as private chats until it is rolled forward.

## Open questions

Decisions for Dror before approval.

1. **Which sprint owns this.** Sprint 9's scope is faster delivery. Proposed: its own
   track after Release 1, with S1 allowed earlier because it changes no behaviour.
2. **Three places where the review made a choice for you.** Each is written into the
   criteria; say if you want it otherwise.
   - Adding the number binds the group only for the trip's owner, not a secondary
     organizer, as on Telegram (AC-28). The group lands on the trip the owner's own
     WhatsApp chat is connected to; another trip needs the group code.
   - Remove sends nothing to the chat (AC-15).
   - With no connected WhatsApp, the owner's notice goes to their Telegram chat if they
     have one, otherwise only the dashboard shows it (AC-18). An email notice would need
     the control plane to start storing addresses, which it does not today.
3. **Bridge source.** Recommended: our own small sidecar, adapted from the MIT-licensed
   bridge that ships with Hermes, with the library version pinned. The alternative, running
   Hermes's bridge as it is, is faster but makes the relay's intake depend on a file inside
   another product's install, with its own allow-list and drop rules.
4. **Privacy wording.** The group introduction line, and whether the published privacy
   policy needs a WhatsApp paragraph before a group outside the owner's family is bound.
5. **Production.** The unofficial client breaks WhatsApp's terms and the number can be
   banned without notice; a ban also cuts every connected private chat. This spec stops
   at staging; whether and when a real family's group gets it is a later decision, with a
   dedicated number that is nobody's personal one.
6. **Product documents.** The MRD entry of 2026-10-30 says "WhatsApp Business", and the
   business plan and product spec price WhatsApp "per conversation"; Meta has billed per
   message since July 2025. Those documents are not edited by this spec. Should the
   doc-keeper update them to today's decision?
7. **The switch gates a sign-in path.** The switch registry says a switch never widens
   permission. `x-member-sign-in.md` asks for a recorded exception for its switch; this
   one needs the same, or S5 gets a switch of its own.
8. **Dependence on member sign-in.** Travellers connecting from the group (AC-29) need
   that spec's traveller list, and S5 is its invitation delivered by email. If WhatsApp is
   built first, S3 builds the traveller list to that spec's contract. Agreed?
