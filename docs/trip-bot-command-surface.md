# The Trip Bot's command surface, its menu, and a mini app

**Status: §3, §4, §5 and §9 are BUILT (2026-09-10). §6 and §8 are not.**
Written 2026-09-10 from Dror's request: the bot should answer a small set of
typed commands — list my trips, switch to one, start a new interview, get the
group-linking line, get the site URL — and those commands should appear in
Telegram's own command menu rather than being folk knowledge. A Telegram Mini
App for managing trips is raised in the same breath and is kept here as a
**discussion**, not a plan.

What shipped, and where it lives:

| § | | Where |
|---|---|---|
| 3 | Telegram → user identity | migration 0050, `organizer-trips.ts`, written in `startSession` |
| 4 | `/trips` | `listOrganizerTrips`, `renderTripList` |
| 5 | `/switch` (alias `/select`) | `switchChatToTrip`, buttons + exact-match argument |
| 9 | the ⌘ menu | `relay/command-menu.ts`, published at relay boot |

Still not built: `/interview` (§6) and `/url` (§8). `/group` (§7) already
worked and is now merely discoverable.

**§3 was built differently from the proposal below, and §3 records why** — the
`user_identities` route it recommended turned out to be blocked by that
table's own unique constraint.

## 1. What the bot answers today

Every inbound update goes through one dispatcher,
[dispatch.ts](../control-plane/api/src/relay/dispatch.ts), in a fixed order:
`/start <token>` first, then a chat mid-interview, then a chat bound to a
trip, then refusal. Three commands exist inside that:

| Command | Where | What it does |
|---|---|---|
| `/start <token>` | DM only | Exchanges a signed enrollment for an interview session. Never forwarded to an agent. |
| `/group` / `/bind` | DM issues, group redeems | Issues a group-binding token; posting it in a group binds that group to the trip. |
| `/done` / `/summary` | DM, mid-interview | Forces the intake recap, whatever the agent is doing. |

Two facts about the parse layer matter for everything below.

**Arguments are discarded.** `parseInbound`
([chat-router.ts:72](../control-plane/api/src/chat-router.ts#L72)) captures a
command's trailing text in the regex but only reads it for `start` —
`{ kind: "command", name }` carries no argument at all. `/switch <trip>` needs
that, so the parser changes shape before any of this is buildable.

**Command replies are not localised.** `DEFAULT_STRINGS`
([dispatch.ts:211](../control-plane/api/src/relay/dispatch.ts#L211)) is a flat
English object, while the interview localises through `intake-copy.ts`'s
`uiString`/`Language`. Commit f56f7b2 established that the bot answers in the
organizer's language; a command surface that replies in English regardless
would walk that back. New copy goes through `intake-copy.ts`, not
`DEFAULT_STRINGS`.

## 2. The rule all five commands inherit

The router's load-bearing invariant, stated at the top of
[chat-router.ts](../control-plane/api/src/chat-router.ts): **the model and the
message never choose the trip.** Every routing decision comes from the chat id
the router read off its own authenticated Telegram connection, plus rows the
control plane wrote itself.

A command surface is where that invariant is easiest to lose, because a
command *looks* like it is supposed to carry an argument. So, concretely:

- **Identity** comes from `message.from.id` on the update Telegram delivered —
  the same provenance `processApprovalCallback` already relies on
  ([app.ts:248](../control-plane/api/src/app.ts#L248),
  [poller.ts:307](../control-plane/api/src/relay/poller.ts#L307)). Never from
  anything in the body.
- **The set of trips a command may act on** is derived server-side from that
  identity. A `/switch` argument selects *within* that set; it never widens it.
- **Refusals are uniform.** `/switch tokyo-2027` from someone with no claim to
  that trip and `/switch tokyo-2027` for a trip that does not exist get the
  same sentence, for the reason `groupTokenRefused` already gives: a
  distinguishable refusal confirms a guess to whoever is guessing.

## 3. Prerequisite — the bot cannot identify the sender yet

This blocks `/trips`, `/switch` and `/interview`, and it is not a small thing.

`/trips` means "trips this person owns", which is
`trip_memberships → user_id`. To get from a Telegram sender to a `user_id`
the control plane needs a `user_identities` row with `provider = 'telegram'`
and `provider_subject_digest = digestTelegramId(from.id)`. **Nothing writes
that row.** The only writer was the Telegram Login Widget, and
`/v1/auth/telegram` now returns `410 TELEGRAM_WEB_AUTH_RETIRED`
([app.ts:1421](../control-plane/api/src/app.ts#L1421)) — Telegram SSO is ruled
out permanently, by decision, not by omission.

It is worse than a missing join. `startFromDeepLink`'s comment records an
empirical finding: *"two signups made minutes apart by the SAME physical
person on this deployment get two entirely different control-plane
`user_id`s"* ([chat-router.ts:349](../control-plane/api/src/chat-router.ts#L349)).
So even with the row, a `user_id`-keyed list answers "trips this *account*
owns", which is not the question the organizer asked.

**The fix, and it is cheap.** `startSession`
([interview.ts](../control-plane/api/src/interview.ts)) already holds both
halves in one transaction: `consumeEnrollmentInTx` returns the enrollment's
`userId`, and `verifiedTelegramChatId` is the chat id the router read off its
own connection. The link is written there. That is a *server-verified* link —
the enrollment was issued to that user and redeemed from that chat — and it
does not reintroduce a login widget or any client-supplied assertion.

**BUILT 2026-09-10, but NOT into `user_identities`.** The proposal above was
to add a `provider = 'telegram'` row to that table, and it does not work:

```
UNIQUE (provider, provider_subject_digest)
```

One Telegram id may therefore name exactly **one** `user_id` — which is the
opposite of what this feature needs, since the whole premise of this section
is that one person owns many. Relaxing the constraint was rejected: six
lookups in `app.ts` and `signup.ts` do `SELECT user_id … WHERE provider = $1
AND digest = $2` and then take `rows[0]`, and each would silently start
picking an arbitrary account. That is a worse failure than the one being
fixed, and an authentication-shaped one.

So `telegram_organizer_links` (migration 0050) is its own append-only,
many-`user_id`s-per-digest table, and `user_identities` is untouched. It is a
read model for routing, never a credential and never an authentication path —
Telegram SSO stays retired.

**The migration backfills from `intake_sessions`.** Without that the feature
would ship inert: a link is written when an enrollment is redeemed, and an
organizer whose interviews are all behind them never redeems another one.
`intake_sessions.telegram_chat_id` is the same verified id recorded by the
same code path, so the backfill recovers facts rather than guessing. On the
dev database it linked Dror's chat to both of his real trips immediately.

The many-`user_id`s-per-person problem then inverts usefully: the Telegram
digest is the stable key, and `/trips` lists every trip reachable through
**any** `user_id` sharing it. Account consolidation remains a separate,
larger question and was deliberately not attempted here.

`/interview` (§6) still needs the decisions in its own section. `/url` (§8)
needs none of this — it routes on chat id alone.

## 4. `/trips` — what am I organizing? — BUILT (2026-09-10)

**DM only.** In a group the answer would list trips the rest of the room has
no claim to.

**A note on the read model, because the obvious reuse is wrong.**
`GET /v1/trips` ([portal.ts](../control-plane/api/src/portal.ts)) selects
`trip_memberships WHERE user_id = $1 AND status = 'active' AND
dashboard_access = true`. That last predicate is the problem: on the dev
database **every** membership has `dashboard_access = false`, so reusing that
filter would have shipped a `/trips` that correctly returned nothing, forever,
and looked like a bug in the identity work instead of a mismatched filter.
`dashboard_access` gates the web console; it says nothing about whether a trip
is yours. `listOrganizerTrips` scopes on `status = 'active'` alone.

The rule the doc was reaching for still holds and is still followed: the bot
reads **in-process**, never by calling its own HTTP endpoint with a synthesised
session, which would put an unauthenticated caller behind an authenticated
route.

Each line needs: trip title, `lifecycle_state` rendered as something an
organizer recognises (not the raw enum), and a marker on the one **this chat
is currently bound to** — that last part is what makes `/switch` meaningful
rather than abstract. `reachability` (migration 0042) is worth showing where
it is not `reachable`, since that is precisely the state that produced "I
don't have a trip for this chat" about a perfectly provisioned site.

Empty list is a real case — a person who has never completed a signup — and
gets the existing `unbound` copy, not a blank message.

## 5. `/switch <trip>` — Sprint 5's `/select` — BUILT (2026-09-10)

The sprint plan already scopes this: *"Implement private `/select` over owned
trips with signed callbacks. Private selection is independent from group
routing, and reviewed reassignment preserves binding history."*
([onboarding-mvp-sprint-plan.md](onboarding-mvp-sprint-plan.md), Sprint 5's
Build list, as first written — see "Not signed" below for the amendment).
It is listed under "Not built". `/switch` is the same feature under the name
Dror actually reaches for; build one of them, alias the other.

**DM only, and this restriction is load-bearing.** A group's binding belongs
to the family, not to whoever typed. Letting `/switch` run in a group would
let one member move the room to another trip — and on a shared bot, "another
trip" can mean another organizer's. The sprint plan's own acceptance test says
private selection *"changes only the DM context; neither group binding
changes"*.

**Mechanically** it is a binding reassignment, and migration 0029 already
built the shape for it: bindings are append-only, "in force" is a partial
unique index over `closed_at IS NULL`, and a reassignment must **close** the
old row with a `closed_reason` rather than overwrite it. `/switch` closes with
its own reason (`organizer_switch`) so history distinguishes it from a
provisioner move. Note that the provisioner deliberately *refuses* to move a
chat bound to another trip; `/switch` is the reviewed path that may, and only
between trips the verified sender owns.

**Argument shape.** Free-text matching against trip titles invites the wrong
trip being selected by a near-match. Prefer buttons: `/switch` with no
argument renders the `/trips` list as inline buttons, and the callback carries
the trip id. `callbackDataFits`
([chat-router.ts:430](../control-plane/api/src/chat-router.ts#L430)) already
guards Telegram's 64-byte limit, and migration 0014's ref-expansion pattern
already exists for payloads that do not fit. A typed `/switch <slug>` can stay
as an exact-match-only convenience.

**Not signed, by decision (2026-09-13).** The plan and
`control-plane-implementation-guide.md` asked for signed, expiring callbacks,
and the buttons carry a plain `s:<trip_id>`. That was a contradiction, and it
was resolved by amending the requirement rather than the code: the payload only
names a row, and the callback branch re-authorizes every tap from
`callback.from.id` against that sender's own trips. A forged payload therefore
selects nothing a typed `/switch <slug>` could not, and a signature would
protect nothing. Signed, expiring actions remain the rule wherever the payload
itself carries authority — signup approval, enrollment.

**A live interview outranks a binding** (`resolveChatRoute`), so `/switch`
during an interview would appear to do nothing. Refuse it with a sentence
saying why, rather than silently succeeding into an invisible state.

## 6. `/interview` — start a new trip from the DM

The requirement is already recorded as a Sprint 5 known gap: *"The companion
profile for an existing organizer must also be able to re-enter interview mode
when they start a new trip, rather than requiring a second bot/profile."*

**The routing half is already built and already correct.** `resolveChatRoute`
puts a live interview *above* a companion binding, and its comment says this
ordering exists for exactly this case. Migration 0028's unique index is scoped
to `state <> 'confirmed'`, so one chat may hold many finished interviews and
one live one. So `/interview` does not need new routing — it needs a draft
trip and an enrollment.

Both exist. `POST /v1/trips` creates the draft plus an `owner` membership;
`POST /v1/trips/:id/interview-link` calls `issueEnrollment` and returns a
`t.me/...?start=<token>` deep link
([portal.ts:505](../control-plane/api/src/portal.ts#L505)). `/interview` is those
two service calls followed by the router redeeming the token against the chat
it is already sitting in — no round trip through Telegram needed, since the
chat id is already verified.

**Two things genuinely need deciding**, and neither is a detail:

1. **`POST /v1/trips` requires a destination.** From a DM there isn't one yet
   — the interview is where it gets asked. Either the draft is created with a
   placeholder and the first intake answer backfills it, or `/interview` asks
   one question before creating anything. The placeholder route collides with
   `derive_trip_slug`, which already has a known `"trip"`-fallback bug.
2. **Does trip #2 need approval?** Trip #1 arrives through signup with a
   super-admin approval gate. Nothing says whether an already-approved
   organizer starting their fifth trip re-enters that gate. This has no owner
   in the plan, so it is a decision for Dror, not an assumption to encode.

## 7. `/group` — built; the ask is the menu

`/group` and `/bind` already issue a binding token in the organizer's DM and
send the copyable line as its own message
([dispatch.ts:471](../control-plane/api/src/relay/dispatch.ts#L471)); posting it
in a group redeems it and triggers the arrival introduction. Router-owned
rather than agent-owned because the token is a credential.

So there is no feature to build here, only exposure — it appears in §8's menu
like everything else. Worth keeping when it does: the command form exists
because **Telegram privacy mode** means a non-admin bot in a group receives
only commands, replies and mentions. A bare token pasted as text would not
arrive at all, and the case that breaks is the recovery case ("post it again
now that I'm an admin"). Do not "simplify" this to a bare token.

## 8. `/url` — where is my site?

The smallest of the five and the only one buildable today: it routes on chat
id alone, so it needs neither §3's identity work nor an argument.

The URL lives in `trips.companion_intro` (migration 0044), which is also what
the group introduction is composed from, and 0034 derives `private_url` from
the succeeded provisioning job. Three states, three different true answers:

- **not bound** — the existing `unbound` copy;
- **bound, not yet provisioned** — the existing `companionPending` copy, which
  already says the honest thing;
- **provisioned** — the URL.

**Do not include the shared password by default.** `companion_intro` carries
it, `groupIntroText` already takes an explicit `includePassword` flag, and
migration 0044 states plainly that these facts are never served to a client.
A `/url` in a group typed by anyone should return the address, not the
credential — the credential went out once, in the pinned arrival message.

## 9. The graphical menu — BUILT (2026-09-10)

Built as `relay/command-menu.ts`. Before it, nothing in the tree called
`setMyCommands`; `setChatMenuButton` is still uncalled — it is the mini app's
hook (§10), not the command list's.

**Where it goes.** Once, at relay boot, right after the `getMe` call that
already resolves `BotIdentity` — not per message. Telegram rate-limits these
and the command list only changes when the code does.

**Scoped, not global.** The commands are not the same everywhere, and a menu
offering `/switch` in a family group advertises something that will be
refused. What shipped:

| Scope | Commands |
|---|---|
| `all_private_chats` — once unlabelled, once per language in `LANGUAGES` | `/trips`, `/switch`, `/group`, `/done` |
| groups, and the unscoped default | nothing — left as they are |

This design first offered `/interview` and `/url` privately and `/url` in groups
and by default. Those wait on the commands themselves (§6, §8); a menu entry
for a command the router cannot answer is the dead end this section exists to
avoid.

`/start` is deliberately absent — Telegram surfaces its own Start button, and
a menu entry for a command that is useless without a token is a dead end.

**Localised.** `setMyCommands` takes a `language_code`; the descriptions come
from `intake-copy.ts` for the same reason §1 gives. This is the second half of
the localisation point, and skipping it produces a Hebrew conversation under
an English menu.

**Failure is not fatal.** A failed `setMyCommands` means an undiscoverable but
fully working command surface. Log it; do not fail relay startup over it.

## 10. A mini app to manage trips — discussion, not a plan

Recorded because it was raised, and because there is one thing about it that
needs a ruling before anyone estimates it.

**Why it is tempting.** Most of it appears to exist. `web/` is a Vite/React
SPA with `TripsPage`, `NewTripPage`, `AuthPage`; `portal.ts` is mounted and
serves the organizer-scoped read model those pages consume; `profile.web
.public_origin` is a real configured origin. A Telegram Mini App is a webview
over an HTTPS URL — on the face of it, the same SPA in a different frame.

**The thing that needs a ruling first.** A mini app authenticates by verifying
`initData`, an HMAC over the bot token, which yields a verified Telegram user
id. That is *Telegram-derived web authentication*, and this deployment
retired exactly that: `/v1/auth/telegram` answers `410
TELEGRAM_WEB_AUTH_RETIRED`, and the shared-bot decision rules out Telegram SSO
permanently.

The two are arguably not the same thing. The retired path was a **per-trip
site** login widget, and it was ruled out because one shared bot routed to
many profiles cannot back a per-trip widget. A mini app is one bot, one
origin, one control plane — the structural objection does not obviously
apply. But "does not obviously apply" is not a decision, and this one belongs
to Dror rather than to whoever picks the work up. **If the answer is no, the
mini app needs a different auth story or does not happen** — and §3's
enrollment-time identity row is not a substitute, because it authenticates a
chat, not a browser session.

**If the answer is yes, the open questions are:**

- **Read-only or actions?** A read-only trip list is a nicer `/trips` and
  little else. Actions — request provisioning, approve a plan, invite members
  — are where it earns its keep, and every one of those already has an
  endpoint with its own authorization that would have to accept this new
  caller.
- **Does it replace the commands or sit beside them?** Both, probably: the
  commands work in a group and offline-ish, the mini app does not. But a
  duplicated surface is two places to keep honest, which is the cost.
- **What is publicly reachable?** The mini app's origin must be, which drags
  in the `mcp/provision.js` exposure rule's neighbourhood. Worth checking
  against `docs/per-trip-gateway-architecture.md` before assuming.
- **Where does it live?** Extending `web/` keeps one SPA and one API client;
  a separate bundle keeps the console's growth away from a webview's
  constraints.

`setChatMenuButton` is the bridge — the same call that configures the menu can
point at a mini app instead of the command list — which is why §9 and this
section are in the same document.

## 11. Open decisions

Collected so they are not lost in the prose. None of these should be guessed:

1. **Telegram identity linkage** (§3) — write the `user_identities` row at
   enrollment redemption, and key the trip list on the Telegram digest across
   every `user_id` sharing it? Or consolidate accounts instead?
2. **Approval for trip #2** (§6) — does an already-approved organizer starting
   another trip re-enter the super-admin gate? Unowned in the plan today.
3. **Draft creation without a destination** (§6) — placeholder, or ask one
   question first?
4. **Mini app auth** (§10) — does `initData` fall under the retired Telegram
   web auth decision, or outside it?

## 12. What the tests would have to show

Beyond the ordinary ones, these are the ones whose absence would let a real
leak through:

- `/trips` from a Telegram sender with **no** identity row refuses, and
  refuses identically to a sender with an empty trip list;
- `/switch` to a trip the verified sender does not own is refused with the
  same sentence as `/switch` to a trip that does not exist;
- `/switch` in a **group** changes no binding — the sprint plan's existing
  two-trip isolation matrix is the right harness, since it already asserts
  that neither group binding moves;
- `/switch` closes the prior binding with a reason and leaves it readable,
  rather than overwriting it (migration 0029's whole point);
- `/switch` during a live interview is refused, not silently applied;
- `/url` in a group returns the address and **not** the shared password;
- every command's reply renders in the organizer's language, driven from
  `intake-copy.ts` rather than `DEFAULT_STRINGS`;
- `setMyCommands` failing at boot leaves the commands working.
