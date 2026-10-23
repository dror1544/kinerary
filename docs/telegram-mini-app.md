# Telegram Mini App: entry shell and sign-in with the verified Telegram identity

The web SPA has a mobile-oriented entry shell for Telegram's Mini App (`/mini-app`).
Since #442 (2026-10-20) it signs a person in with the identity **Telegram itself
verified for that launch** — no password to type — and opens the trip the chat
belongs to. This document is the contract; `control-plane/api/src/telegram-webapp-auth.ts`
and `telegram-mini-app.ts` are the code, and the tests named below are what hold it.

## What a Telegram identity is worth here

Telegram's `initData` proves one thing: *this launch was made by Telegram user N,
recently, for our bot.* It does **not** say which Kinerary account N is. That comes
only from a **link**, written earlier by someone proving something Telegram cannot:

| Link | Written when | Scope |
|---|---|---|
| `telegram_organizer_trip_links` | an interview link for that trip is redeemed from a Telegram chat, **or** the signed-in organizer's dashboard issues a one-time link for that trip and a Telegram account redeems it (migration `20261021120000`) | that one trip |
| `telegram_member_links` | a member signs in with their **trip password** (or redeems a **site invite**) inside the Mini App, ticks "Next time, open with Telegram", and verified `initData` arrives in the same request | that one trip |

**Contract change of the organizer link.** Migration 0052 called `telegram_organizer_links` "never a
credential and never an authentication path". With this feature a link is a sign-in
path, so it is **revocable**, **owner-visible** (on the trip card) and **announced** (a notice on first use).
The reason is concrete: an interview link that is forwarded to someone else yields
a link to a Telegram account that is not the organizer's, and before this change that
cost only bot routing.

**The link is per trip (owner decision, 2026-10-20).** The first version kept 0052's account-wide row, so
Unlinking one trip took *every* trip of the organizer out of the bot's `/trips` and `/switch`, and a revoked
pair stayed revoked with no way back from the dashboard. Now one row = one (Telegram account, user, **trip**)
in `telegram_organizer_trip_links`, revoked in place (`revoked_at`). Every reader — the bot's `/trips`,
`/switch`, `hasEarlierBuiltTrip`, `isTripOrganizer` and the Mini App resolver — asks for the link **of the
trip in question**. 0052's account-wide table is no longer read or written by this release. Existing
account-wide rows were **expanded by the migration** into one live link per active membership (sign-in
history copied, so an announced link is not announced again), so an organizer keeps every trip until they
change one; the old rows themselves stay put so the previous release still runs after a rollback.

## Entry paths

- `/mini-app` or `/mini-app?startapp=account`: My trips.
- `/mini-app?startapp=trip_<opaque-id>` (or `tgWebAppStartParam`): redirects within the
  SPA to `/mini-app/trips/trip_<opaque-id>`. A selector is a routing hint on the client;
  the **server** reads the *signed* `start_param` from `initData` and decides.
- Invalid or conflicting selectors show an unavailable-link message.

## The sign-in exchange

`POST /v1/auth/telegram-mini-app`, body `{ initData, tripId?, embedded? }` (`tripId` only on the chooser's follow-up;
`embedded: true` only when the page finds itself in a frame on another site — Telegram Web — see "Telegram Web" below).

| Response | Meaning |
|---|---|
| `200 {kind:"session", appPath, notice?}` + the ordinary `kit_session` / `kit_csrf` cookies | signed in; go to `appPath` (`/mini-app` or `/mini-app/trips/<id>`) |
| `200 {kind:"choose", trips, notice?}` | the person has trips under several accounts; no cookie, no user ids; choose one and call again with `tripId` |
| `401 {error:"TELEGRAM_NOT_LINKED", fallback:"trip_password"\|"none", tripId?}` | verified, but no link opens anything. `trip_password` only when the *signed* `start_param` named a trip |
| `401 {error:"TELEGRAM_INIT_DATA_INVALID"}` | **one code for every verification failure** (bad signature, wrong bot, stale, future, malformed, duplicates, oversize, replay cap) |
| `400` malformed `tripId` · `403 ORIGIN_INVALID` · `415` · `429` · `503` (feature off) | structural refusals |

Every response is `private, no-store`. Order of checks (the order is the design): feature
on → per-IP budget (100/min) → `Origin` is exactly `web.public_origin` (**missing and the
literal `null` are refused**) → `Content-Type: application/json` only → **one HMAC** →
per-person budget (20/min, keyed only after verification so junk cannot fill the limiter
map) → database.

### Which trip opens

The trip in context is, in order: the chooser's `tripId`; the signed `start_param`
(`trip_…`); the person's open DM binding (only when Telegram signed no `start_param` and
the launch is from their own chat). **It only selects.** Membership of a linked account
grants. A trip the person cannot open — not a member, revoked, retired, destroyed,
nonexistent — is refused **identically** (`notice: "TRIP_UNAVAILABLE"` and the same body),
and the chooser's `tripId` can never widen the set.

Among accounts that can open the trip the pick is deterministic: role order
`owner > organizer > member` is an **allow-list** (`ROLE_RANK`; any other role is
excluded, never ranked last), then runtime access, then oldest membership.
No trip in context: one accessible trip opens directly; several trips under one account
open that account's My trips; trips under several accounts show the chooser.
A trip whose runtime route is not ready still signs the person in; the existing
"not ready" view explains.

### Verification (`telegram-webapp-auth.ts`)

```
secret_key        = HMAC_SHA256(key = "WebAppData", message = bot_token)
data_check_string = every field except `hash` (KEEP `signature`), values URL-decoded,
                    sorted by key CODE UNIT (not localeCompare), joined by "\n"
hash              = lowercase hex of HMAC_SHA256(key = secret_key, message = data_check_string)
```

Also required: `hash` is exactly 64 lowercase hex characters *before* comparison;
`timingSafeEqual` over the 32 bytes; no duplicate keys; at most 4096 bytes; `user` and
`auth_date` present; `auth_date` within `web.telegram_init_data_max_age_seconds` (default
300) and at most 60 s in the future; `user.id` a positive safe integer (a private-chat id).
This is **not** the Login Widget algorithm in `identity.ts` (that one keys on
`SHA256(token)`).

### Replay

`initData` is signed, not single-use, and a reloading WebView resends it. A launch may
mint **at most 3 sessions** inside its freshness window, counted on the digest of the
*computed HMAC* (so re-encoding the fields does not open a second bucket) in Postgres
(`telegram_mini_app_launches`, one atomic upsert — correct with more than one API process).
Launches that end in choose / NOT_LINKED mint nothing and use no slot. The client reuses
its session on reload through a `sessionStorage` marker tied to a digest of the
`initData` and strips `#tgWebAppData` from the address bar once the SDK has read it.

### Session

`createWebSession` + `setWebSessionCookies`: the same TTL (`web.session_ttl_seconds`, 7 days by default)
as an email or Google sign-in, **but not the same scope** (below). Any `kit_session` already in the WebView
is **revoked** when a verified launch mints a session or ends in choose / NOT_LINKED (a shared device must
not stay signed in as the previous person). A session minted through a link records
`web_sessions.telegram_link_id`, so unlinking ends it. *Not covered here:* the trip site's own gateway
cookie is not revoked by this (the runtime-gateway lane owns that).

### A Telegram session is scoped to the trips its Telegram account is linked to (owner decision, 2026-10-21)

A link proves a Telegram account, not a person at a keyboard, and a forwarded interview link makes a link for
someone who is not the organizer. So the session a Mini App sign-in mints sees and acts on **only the trips
that Telegram account is linked to for that user** (every live organizer-trip link and member link with the
same Telegram account and the same user as the link that minted it — derived from the link rows on every
request, so a new link widens it and an Unlink narrows it on the next call). The full dashboard — the account's
other trips, planning a new trip, anything account-level — needs a **password or Google sign-in**
(`/sign-in`, which a scoped session is not redirected away from). A trip-password sign-in inside the Mini App
is a password credential and mints a normal session.

Enforced in **one place**, `requireUser` (portal.ts), which every authenticated portal route goes through
(`requireMutation` calls it), by `scopeDecision` (`portal-scope.ts`) against `PORTAL_SCOPE_POLICY`:

| Policy | Routes | A scoped session gets |
|---|---|---|
| `trip` | `GET /v1/trips/:id`, `GET …/interview-link` (status only), `POST …/provisioning-request`, `POST …/plans/:planId/approve\|reject`, `POST …/launch` | its linked trip: as an organizer's/member's session does. Any other trip id, a nonexistent one included: the **same 404** `{"error":"NOT_FOUND"}` |
| `filtered` | `GET /v1/trips` | only the linked trips (filter in the SQL) |
| `link` | `DELETE /v1/account/telegram-links/:linkId` | may end only a link of **its own Telegram account** on a trip in scope (which ends the session). Another trip's link, and another account's link on an in-scope trip (the owner's phone), are the same 404 as an unknown id |
| `account` | `POST /v1/trips`, `POST /v1/site-invites/redeem`, and the four routes that **mint a way into the account**: `POST /v1/trips/:id/telegram-link`, `POST /v1/account/telegram-links/:linkId/restore`, `POST /v1/trips/:id/interview-link`, `POST /v1/trips/:id/interview-link/replace`, and — everything that **creates a credential or removes access** — `POST /v1/trips/:id/site-invites`, `DELETE /v1/trips/:id/site-invites/:inviteId`, `DELETE /v1/trips/:id/members/:membershipId` (boundary review M1, round 3 MF1: a link or a join URL a scoped session minted, redeemed by someone else, would outlive the Unlink of the session's own account; a forwardee must not remove people either) | `403 {"error":"ACCOUNT_SIGN_IN_REQUIRED","message":"Sign in with your password to do this."}` |
| `session` | `GET /v1/me` (reports `scope: "telegram"`), `POST /v1/logout` | allowed |
| `open` | sign-in routes, invite inspection, internal runtime routes | not session routes; a route marked `open` that asks for a user is refused |

**Order of checks on a mutation:** authenticated → Origin → CSRF → scope, so a foreign id and an unknown one get the same status. A present `Origin` that is not `web.public_origin` (including `null`) is refused with `403 ORIGIN_INVALID` on every `requireMutation` route and on a `POST /v1/site-invites/redeem` that rides a cookie session — a second wall behind the CSRF token now that the Mini App cookie can be `SameSite=None`; a missing `Origin` keeps CSRF-token-only behaviour.

**Fail closed.** A route with no row in the table makes the app **refuse to boot**
(`assertEveryRouteIsClassified`), and a scoped session on anything but an explicit allowance is refused. A
scope that cannot be read — a link id that is unknown, revoked, malformed, of the older account-wide shape,
or missing — is the empty scope: no trip, no account action, still reported as scoped. `/launch` is a trip route,
so the gateway handoff downstream of it only ever receives a trip in scope.

**Rollback fails closed.** A scoped session's row is stored under `sha256("telegram-scope:" + cookie)`,
not `sha256(cookie)`. This release looks up either; every older release looks up only the second, finds
nothing and answers 401, so a downgrade cannot turn a Telegram session into a full one (the person launches
again). A cookie that begins with the prefix is looked up under neither. Sessions the earlier build of this
feature minted (plain digest, `telegram_link_id` set, Mac staging only) are recognised as scoped by the link id.
No migration: the scope is derived from rows that already exist.

Held by `control-plane/api/test/portal-scope-db.test.ts` (the route sweep over `PORTAL_SCOPE_POLICY`, the
source-vs-table check, live widening/narrowing, fail-closed scopes, rollback lookup) and
`web/src/pages/ScopedSession.test.tsx`.

## Safeguards the owner asked for (2026-10-20)

- **See and remove, per trip:** each organizer trip card on My trips shows a Telegram status icon (linked / not
  linked) and a ⋮ menu. The menu lists the Telegram accounts linked to **that trip** — `linked on D`, how
  (the interview, an earlier interview, a link from the page, the trip password, an invitation), *last
  opened D* — each with **Unlink** (after a confirmation), plus **Link Telegram**. The data is the `telegram`
  field of `GET /v1/trips` / `GET /v1/trips/:id` (`links[]`: `id`, `via`, `linkedAt`, `firstSignedInAt`,
  `lastSignedInAt`); unlinking is `DELETE /v1/account/telegram-links/:id` (`requireMutation`). A runtime-only
  member sees the same status on their card and can end their own link, but is not offered Link. **Never**
  the Telegram id, its digest or any piece of either (a digest of a short numeric id is brute-forceable), and
  no Telegram-supplied name. This replaces the account-level "Telegram accounts that can sign in as you"
  section and `GET /v1/account/telegram-links` (removed: answers 404). Dates on the page are formatted in the
  **page's** language (`<html lang>`), never the browser's.
- **Restore — the way back for an account the owner Unlinked, with no Telegram round trip** (owner request,
  2026-10-23; `POST /v1/account/telegram-links/:linkId/restore`, `requireMutation`, policy `account`: a
  password or Google session only — a Telegram-minted session gets the 403 `ACCOUNT_SIGN_IN_REQUIRED`, and
  its trip card is never sent the list of Unlinked accounts). `:linkId` is the **revoked** row's opaque id;
  the Telegram account is the one on that row, never anything in the request. It works only when all of
  these hold, re-read under row locks, and every failure is the **same 404** (a foreign link, an unknown or
  malformed id, a member-link id, a non-organizer, a retired trip, an already-restored row all look alike):
  the row is the signed-in user's own; it was revoked by an **owner Unlink** (`membership_ended` is
  permanent, and a user who is gone has no card to click on); it is not restored yet and is the *newest*
  revoked row of its (Telegram account, user, trip) pair with no live row (a `lk_` relink already brought it
  back); and the user still **runs the trip** today — the same check as issuing and redeeming a `lk_` link
  (`tripTheUserRuns`: owner or organizer with dashboard access, active, trip not retired or destroyed).
  20/min per person. **A restore writes a NEW live row** (`verified_via = 'dashboard_restore'`), not a
  cleared `revoked_at`: the Unlink stays in the table that records it (the file's own rule since
  `20261021120000`: "relinking writes a NEW row"), nothing refers to the new id yet so **no session is
  revived** (the sessions the Unlink ended point at the old id and stay revoked; the person signs in fresh),
  and the new row has no first sign-in, so the notice below announces it again. History, kept on both
  rows (migration `20261023130000`): `revoked_by` (who unlinked; NULL for rows from before this release
  and for membership-end), and on the revoked row `restored_at` / `restored_by` / `restored_link_id`.
  The bot's organizer fact comes back through the **same helper the `lk_` relink uses**
  (`restoreDemotedOrganizerPersonLink`): only a `trip_person_links` row carrying the `demoted_from_role`
  marker, which is then cleared. Not restored: the interview session, interview binding and chat binding
  the Unlink closed (the Telegram account's hold on the trip — the next `/start` or interview link makes
  them again) and the previous release's account-wide row (it stays in the history table, so a rollback
  still fails closed). The card shows `telegram.unlinked[]` (`id`, `via`, `linkedAt`, `unlinkedAt`; no id,
  digest or name) and a **Restore Telegram** entry in the ⋮ menu for a full session of an owner or
  organizer. Held by `control-plane/api/test/telegram-link-restore-db.test.ts` and
  `web/src/pages/TripTelegram.test.tsx`.
- **Link — the way to add a Telegram account that was never linked** (`POST /v1/trips/:id/telegram-link`, `requireMutation`, owner or
  organizer with dashboard access; anyone else, a retired trip and a nonexistent one get the same 404;
  10/min per person). It returns `{ deepLink: "https://t.me/<bot>?start=lk_…", expiresAt }`. The token is
  the enrollment pattern (`enrollment.ts`) — 24 random bytes, only the sha256 stored in
  `telegram_link_tokens`, row-locked single use, at most one live token per (user, trip) — with a **15-minute**
  fuse. **Redeeming** is the bot's `/start lk_…` in a *private* chat (`telegram-link-token.ts`, claimed in
  `relay/dispatch.ts` before the enrollment path; a group redemption is refused without consuming): the
  sender id comes from the update Telegram delivered on the bot's own connection and the issuer from the
  token, so both halves are proven by different things — the signed-in session proves the account, the bot's
  update proves the Telegram identity. The link is written for **that user and that trip** and nothing else.
  Every refusal (expired, used, replaced, unknown, malformed, issuer no longer runs the trip) is **one
  sentence**, so a guess learns nothing. An interview link — which may have been forwarded — still cannot
  undo an Unlink (`linkTelegramOrganizerInTx` refuses a (Telegram account, user, trip) that has a revoked
  row); this is.
- **Notice:** the first Mini App sign-in through a link queues a Telegram message to **all of the account
  owner's private bot chats, including the one that signed in** (owner decision, 2026-10-20: the first
  version skipped the signer's chat and, for an organizer whose only chat is their own phone, the notice
  never arrived). Recipients: the open, private DM bindings of the trips the account is owner or organizer
  of, plus the signing Telegram account's own private chat. It says which account signed in, which trip it
  opened and when, and how to unlink (the trip card's three-dot menu). **Once per link, not per sign-in**
  (owner request, 2026-10-23; the stored fact is the link row's `first_signed_in_at`, set in the same
  transaction that queues the notice, so a second sign-in on the same link — however many — queues
  nothing): relinking a trip later, or restoring an Unlinked account, makes a NEW link row and announces
  that link's first sign-in again, which is the point when the relink was made with a link the organizer
  may have forwarded. One Telegram account opening N trips has N links, so N first sign-ins: N notices,
  once each. Held by `telegram-mini-app-db.test.ts` ("the notice is sent on a link's FIRST sign-in only…")
  and `telegram-link-restore-db.test.ts` ("a restored link announces its first sign-in again, once"). Outbox type `mini_app_sign_in_notice`, trip_id NULL, one row per chat, sent
  by the ordinary outbox dispatcher with its usual retries (which runs whenever the web block is configured,
  with or without `signup`); the raw Telegram id in the row is nulled once it is sent or has failed for good;
  never inline. Re-linking the same Telegram account to the same member and trip is never news.
- **Revocable:** an organizer link is flagged `revoked_at` / `owner_unlinked` in place (only this release
  reads that table), ends the sessions it minted, and closes that Telegram chat's hold **on that trip** outside
  the web: its live interview session is expired, its interview binding revoked and its open chat binding
  closed (`telegram_unlinked`) — nothing deleted; the organizer's other trips are untouched.
  **Rollback safety:** the previous release read only the account-wide `telegram_organizer_links` and cannot
  hide one trip out of it, so a per-trip Unlink also **moves that pair's account-wide row** into
  `telegram_organizer_link_revocations` (and ends the sessions it minted): after a rollback the older readers
  see none of the pair's trips — an Unlink can cost bot access until a relink, and can never leave behind
  access the owner took away. A membership that ends also revokes the trip's organizer links (trigger, so the
  link does not revive if the person is added back). **An Unlink also takes the bot's organizer powers**
  (boundary review R1, 2026-10-21): `trip_person_links` (migration 0051) says "this Telegram sender is the
  organizer" and is written at provisioning from whichever account ran the interview — a forwardee's, if the
  link was forwarded — and `isTripOrganizer` trusts it, so it used to survive an Unlink (`/proactive`, and
  any organizer-only command). The Unlink demotes that row to `participant` (the name stays), the
  membership-end trigger does the same (migration `20261022120000`), and `resolveTripPerson` reads an
  `organizer` row as `participant` whenever that Telegram account has a revoked link to the trip and no live
  one — so a re-provision, which upserts the role back, cannot undo it. A relink from the dashboard restores the stored role (only a row that an unlink or a membership end demoted, only when the issuer is still an owner/organizer of the trip), and the Unlink demotion has the same "no other live link of this Telegram account to the trip" guard as the trigger. The demotion is **recorded** (`trip_person_links.demoted_from_role`, migration `20261023120000`, written by the Unlink and by the membership-end trigger) and the relink restores only a row carrying that marker, then clears it — a person who was a participant all along is never promoted by an old Unlinked link of their Telegram account (round 3, MF2). Rows demoted before the column existed carry no marker and are not restored.
  Member links are flagged `revoked_at` and also end —
  with their sessions — when the trip password changes, when the membership ends, or when the invite is
  revoked. These are database triggers (migrations `20261020120000`, `20261021120000`), not route code,
  because none of the events has a single writer.
- **Remove member:** an owner or organizer removes a person from the trip's "People on this trip" panel
  (`DELETE /v1/trips/:id/members/:membershipId`, `requireMutation`; revoking a **redeemed** invite does
  the same). One transaction: membership to `revoked` (which fires the Telegram-link trigger), trip
  password deleted, the invite revoked, unused launch grants spent, and every portal session of theirs
  ended if they have no other active membership (otherwise their sessions stay, since every trip route
  checks membership on every request). Refused: yourself, an owner by a non-owner, the last owner or
  organizer (409); anyone who is not an owner/organizer of that trip, and any membership not on that trip,
  get the same 404. *Not covered:* the trip site's own gateway session (control plane has no call to end
  it; it runs out on its own clock).

### Phase 2: how a member gets linked

Only when **one request** carries (a) verified `initData` whose `auth_date` is at most 60 s old,
(b) a successful trip-password sign-in (`POST /v1/auth/password`) or a new-account invite
redemption (`POST /v1/site-invites/redeem`, `method: password`), and (c)
`telegramLink: {initData, consent: true}` from the "Next time, open with Telegram" control
(unticked by default). Never from an existing cookie session; one link per launch; a failed
password burns nothing and links nothing. A refusal never fails the sign-in it rode on — the
response says `telegramLink: "skipped"` and the page says so. `/v1/auth/password` now also
requires an `Origin` equal to `web.public_origin` and is rate limited (100/min/IP;
10/min/account, counted only for accounts that exist).

## A member's trip list

`GET /v1/trips` returns the full trip detail (invitees, invite ids, plan, interview session, lifecycle)
only for memberships with dashboard access. A runtime-only member gets a **summary**: id, title,
destination, dates, their own permissions and `runtimeReady` — nothing of the organizer's workbench.
`GET /v1/trips/:id` stays a 404 for them.

## Behind an ingress: `public_api.trust_proxy`

By default `request.ip` is the socket peer, so behind a reverse proxy every client shares the proxy's
address and the per-IP sign-in budgets (`/v1/auth/email-password`, `/v1/auth/password`,
`/v1/auth/telegram-mini-app`) become one global budget. `public_api.trust_proxy` in the architecture
profile (absent = off) lists the proxies that may speak for the client: a hop count (1-8) or a list of
addresses/CIDRs. Fastify then takes the client address from `X-Forwarded-For` **only** for requests
arriving from them; a caller outside the list cannot choose its own address with a header. Set it to
exactly the ingress in front of the API; a wrong list is worse than none.

## Configuration

`web.telegram_bot_token_secret_ref` (optional; absent means **off**, logged at boot as
`mini_app.disabled`, and `GET /v1/auth/capabilities` reports `telegramMiniApp: false`) and
`web.telegram_init_data_max_age_seconds` (60–3600, default 300). `web.public_origin` and `web.runtime_origin` are **normalised to the browser's Origin form** at config load (`new URL(x).origin`: lower case, default port and trailing slash dropped, any path removed), because the Origin check on every mutation compares the header with `public_origin` byte for byte; the isolation check compares the normalised values. At boot `getMe` on that token
must name `web.telegram_bot_username`, or the feature stays off (`mini_app.bot_token_mismatch`
— handles only, never the token); a network failure is retried every minute. Boot also logs
`has_main_web_app` from `getMe`. Nothing logs `initData`, a hash, a Telegram id or its digest.

A person who is not linked and whose launch names no trip sees a message (no email form).

### One-time setup: the bot's Main Mini App

The `t.me/<bot>?startapp=...` link behind the "Open trip" button opens the bot's
**Main Mini App**, which only exists once somebody sets it in BotFather. No code can
do that step, so a deployment that never did it has working sign-in and a button that
opens nothing.

1. In BotFather: `/mybots`, choose the bot, **Bot Settings**, **Configure Mini App**
   (or **Main Mini App** in newer clients), **Enable Mini App**.
2. URL: `<web.public_origin>/mini-app` — the portal origin from the architecture profile,
   plus `/mini-app`. Nothing else is needed; the trip rides in `startapp`.
3. It must be the **same bot** as `web.telegram_bot_username` (the boot check
   already refuses a token for another bot).

Then check it, without reading logs: `GET /readyz` reports
`telegram_mini_app.has_main_web_app` — `true` when Telegram says the bot has a Main
Mini App, `false` while the step above is not done, `null` while Telegram has not
answered yet. The check runs at boot and is repeated every minute while Telegram has not
answered, or answers `false`, so doing the step above shows on `/readyz` within a minute,
without a restart. Boot logs `mini_app.main_web_app_missing` once for `false`.
`has_main_web_app` is the bot's own `getMe` field, so the answer is Telegram's, not ours.

### The "Open trip" button and `/app`

**Only when the Mini App is ready for the bot** (owner decision, 2026-10-20). All of it —
the button, the pin, `/app` in the command menus, the plain-word replies — appears only when
(1) the profile has a `web` block with `telegram_bot_token_secret_ref`, and `getMe` on that
token names `web.telegram_bot_username` (the same check as sign-in), **and** (2) that `getMe`
says `has_main_web_app: true`. The relay is a separate process from the API, so it asks
Telegram itself (`relay/trip-app-readiness.ts`, the same `createBotCheckRound` the API uses):
at boot (it must be able to resolve the same `web.telegram_bot_token_secret_ref` as the API, or it logs `relay.trip_app_token_unresolved` and stays off), then every minute while the answer is not yes, so doing the BotFather step turns it on
**without a restart**, and the menus are republished when it flips. **Unknown is not ready**
(never checked, unreachable, a different bot's token, a field Telegram did not send). There is
no fallback to the relay's own bot handle: no `web` block means no Mini App. Not ready, the
group's introduction is exactly what it was before #443, `/app` typed anyway answers "not
available yet", and the words go on to the companion like any sentence. The relay logs
`relay.trip_app_ready` / `relay.trip_app_not_ready` at boot and `relay.trip_app_readiness_changed`
when it flips; the API's `/readyz` carries the same facts for its own token.

When ready, the relay posts and pins one message in a trip's group — when the group is bound
(`/group KIN-…`, or the one-tap add link) and again when the bot is re-added — carrying a
URL button to `https://t.me/<web.telegram_bot_username>?startapp=<trip id>`; `/app` (and
"open the app", "פתח את האפליקציה", addressed to the assistant) answers with the same button
for the chat's own trip.

The link **selects, it never grants**: the only thing in it is the trip id, which is
already in every trip URL; the Mini App signs the person in with the identity Telegram
verified for that launch and opens the trip only for an active member of it (above). A
URL button is used because an inline `web_app` button does not work in groups. If the
bot cannot pin (no admin right to pin messages), the group is told so once, with what to
do; the message works unpinned. A previous Open trip message of the bot's own at the top
of the pins is unpinned first, so a group moved to another trip does not keep pointing at
the old one. Command surface: [trip-bot-command-surface.md](trip-bot-command-surface.md).

## Telegram Web (`web.telegram.org`)

Telegram Web runs a Mini App in an **iframe on another site**, where the portal's `SameSite=Lax` cookies are
never sent. Supported since 2026-10-20, in two parts that must travel together:

- **A cookie variant for the Mini App session only.** When the page finds itself framed (`window.top`
  differs, or Telegram reports platform `web`/`weba`/`webk`) it sends `embedded: true` with the exchange (and
  with the trip-password sign-in). The response then sets `kit_session` and `kit_csrf` as
  `SameSite=None; Secure; Partitioned` ([CHIPS](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Privacy_sandbox/Partitioned_cookies)):
  the browser keys the cookie to the top-level site that framed us, so it is sent back only inside
  `web.telegram.org`'s frame — not to any other site that frames or requests the portal. The ordinary
  portal, and a native WebView (iOS, Android, desktop), keep the Lax cookies; an `http://` origin keeps Lax too
  (`None` needs `Secure`). `embedded` can only weaken the caller's own cookie. Logout and the shared-device
  clear expire **both** variants (a cookie's identity includes its partition). **CSRF and Origin rules are
  unchanged:** the exchange still requires `Origin` to equal `web.public_origin` (a fetch from inside the frame
  to the portal's own origin sends exactly that), and mutations still need the double-submit CSRF token.
- **Framing allowed for `/mini-app` only** (`web/nginx.conf`). Every response carries
  `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` (the portal had no
  framing header at all before this), except the shell served for `/mini-app` and `/mini-app/…`, which
  carries `frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org`
  and no `X-Frame-Options` (it cannot name an origin). nginx does not inherit `add_header` into a location
  that has its own, and a `try_files … /index.html` fallback is an internal redirect to `location =
  /index.html`, whose `'none'` would win — so the Mini App locations serve the shell from a named location
  with `rewrite … break`. `web/src/framing.test.ts` holds the shape; the real headers were captured from a
  throwaway nginx (recorded in the PR).

**Browsers that refuse the partitioned cookie** (Safari, a Chrome with third-party cookies blocked) accept
the exchange and then cannot read the session back. After a session answer inside a frame the page asks
`/v1/me` once; if it is unauthorised it says "Open Kinerary in the Telegram app" (and mentions third-party
cookies) instead of showing a blank page. Real acceptance on Telegram Web in Chrome and in Safari is still owed.

## Checking a captured `initData`

The unit test's reference vector was computed with `openssl`, which proves the algorithm.
Only a capture proves Telegram still sends what we expect. To check one against the real token:
capture `Telegram.WebApp.initData` from a real launch (Android: `chrome://inspect` with WebView
debugging; Telegram Desktop: turn on WebView inspecting under Settings, Advanced, Experimental settings — the name varies by version — and use the inspector), save it
exactly as printed to `initdata.txt`, put the token in `BOT_TOKEN` from your secret store
(never on a command line), and run:

```bash
python3 -I - <<'PY'
import hashlib, hmac, os
from urllib.parse import parse_qsl
pairs = parse_qsl(open("initdata.txt").read().strip(), keep_blank_values=True)
received = dict(pairs)["hash"]
check = "\n".join(f"{k}={v}" for k, v in sorted((k, v) for k, v in pairs if k != "hash"))
secret = hmac.new(b"WebAppData", os.environ["BOT_TOKEN"].encode(), hashlib.sha256).digest()
print("match" if hmac.compare_digest(hmac.new(secret, check.encode(), hashlib.sha256).hexdigest(), received) else "MISMATCH")
PY
```

A capture is a live credential for its freshness window: delete the file afterwards.

## Host presentation and fallback

The official Telegram Web App SDK script is loaded only while a Mini App entry is mounted. Optional
`ready`, `expand`, back-button and presentation event methods are guarded for hosts that lack them or
throw. The outer shell accepts only six-digit hex theme colors and finite safe-area insets between 0
and 256 pixels, taking the larger device/content inset on each side (the SDK documentation does not
specify a composition formula, so real mobile validation remains owed). `initData` is read in exactly
one place (`readLaunch` in `sdk.ts`), only to be sent to the exchange; `initDataUnsafe`, users and chats
are never read. If the SDK is missing, the page was not opened by Telegram, or the feature is off (503),
the existing web views and the ordinary sign-in page remain usable.

## Verification

- Verifier and reference vector: `control-plane/api/test/telegram-webapp-auth.test.ts`.
- Structural refusals, byte-identical failures, per-IP and per-person limits, boot check:
  `telegram-mini-app-route.test.ts`, `server-boot.test.ts`.
- Resolution, replay (including two pools), shared device, unlink, notice, phase 2, revocation,
  `/v1/auth/password` hardening, log redaction (needs a scratch database):
  `telegram-mini-app-db.test.ts`.
- The per-trip link, the dashboard link and the way back: `telegram-link-token-db.test.ts`,
  `organizer-trips.test.ts` ("a Telegram link is per trip").
- The button, `/app`, the words, the pin and the readiness field: `open-trip.test.ts`,
  `relay-open-trip.test.ts` (needs a scratch database), `mini-app-status.test.ts`,
  `server-boot.test.ts`, `command-menu.test.ts`, `trip-app-readiness.test.ts`.
- Client: `web/src/mini-app/MiniAppSignIn.test.tsx`, `web/src/pages/TripTelegram.test.tsx`,
  `web/src/pages/TripUsername.test.tsx`; framing headers: `web/src/framing.test.ts`.

Real Telegram acceptance remains required on mobile and desktop hosts: launch private and group
entries as linked and unlinked accounts, confirm refusal for non-members, check safe areas and back
behavior, and verify the runtime iframe under the deployment's cookie and framing policies.
