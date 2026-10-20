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
| `telegram_organizer_links` | an interview link issued to the account is redeemed from a Telegram chat (migration 0052) | every trip of that account |
| `telegram_member_links` | a member signs in with their **trip password** (or redeems a **site invite**) inside the Mini App, ticks "Next time, open with Telegram", and verified `initData` arrives in the same request | that one trip |

**Contract change of `telegram_organizer_links`.** Migration 0052 called it "never a
credential and never an authentication path". With this feature a row is a sign-in
path, so it is now **revocable** (`revoked_at`), **owner-visible** (the "Telegram
accounts that can sign in as you" list) and **announced** (a notice on first use).
The reason is concrete: an interview link that is forwarded to someone else yields
a link to a Telegram account that is not the organizer's, and before this change that
cost only bot routing.

## Entry paths

- `/mini-app` or `/mini-app?startapp=account`: My trips.
- `/mini-app?startapp=trip_<opaque-id>` (or `tgWebAppStartParam`): redirects within the
  SPA to `/mini-app/trips/trip_<opaque-id>`. A selector is a routing hint on the client;
  the **server** reads the *signed* `start_param` from `initData` and decides.
- Invalid or conflicting selectors show an unavailable-link message.

## The sign-in exchange

`POST /v1/auth/telegram-mini-app`, body `{ initData, tripId? }` (`tripId` only on the chooser's follow-up).

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

`createWebSession` + `setWebSessionCookies`, unchanged: same scope, same TTL
(`web.session_ttl_seconds`, 7 days by default) as an email or Google sign-in. Any
`kit_session` already in the WebView is **revoked** when a verified launch mints a session
or ends in choose / NOT_LINKED (a shared device must not stay signed in as the previous
person). A session minted through a link records `web_sessions.telegram_link_id`, so
unlinking ends it. *Not covered here:* the trip site's own gateway cookie is not revoked by
this (the runtime-gateway lane owns that).

## Safeguards the owner asked for (2026-10-20)

- **See and remove:** "Telegram accounts that can sign in as you" on My trips
  (`GET /v1/account/telegram-links`, `DELETE /v1/account/telegram-links/:id`; `requireUser` /
  `requireMutation`). It shows when it was linked, how, which trip for a trip-scoped
  link, and when it last signed in — **never** the Telegram id, its digest or any piece of
  either (a digest of a short numeric id is brute-forceable), and no Telegram-supplied name.
- **Notice:** the first Mini App sign-in through a link queues a Telegram DM to the
  signing-in account (outbox type `mini_app_sign_in_notice`, trip_id NULL, sent by the
  ordinary outbox dispatcher with its usual retries; the raw Telegram id in the row is nulled
  once it is sent or has failed for good; never inline) saying which account it signed in as and how to unlink. It goes to the account
  that signed in — the only chat the server can address from a digest; the list above is
  the owner's channel.
- **Revocable:** an unlinked or revoked link signs nobody in, and the bot stops honouring it
  too (`/trips`, `/switch`, the returning-organizer greeting and the organizer check all skip
  revoked links). A revoked organizer link stays revoked: redeeming another interview link does
  not re-open it. Member links also end —
  with their sessions — when the trip password changes, when the membership ends, or when
  the invite is revoked. These are database triggers (migration `20261020120000`), not
  route code, because none of the three events has a single writer.

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

## Configuration

`web.telegram_bot_token_secret_ref` (optional; absent means **off**, logged at boot as
`mini_app.disabled`, and `GET /v1/auth/capabilities` reports `telegramMiniApp: false`) and
`web.telegram_init_data_max_age_seconds` (60–3600, default 300). At boot `getMe` on that token
must name `web.telegram_bot_username`, or the feature stays off (`mini_app.bot_token_mismatch`
— handles only, never the token); a network failure is retried every minute. Boot also logs
`has_main_web_app` from `getMe`. Nothing logs `initData`, a hash, a Telegram id or its digest.

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

Unsupported in v1: Telegram Web (`web.telegram.org`, platforms `weba`/`webk`) runs Mini Apps
in a cross-site iframe where the session cookies are not sent; the page says "Open in the
Telegram app". A person who is not linked and whose launch names no trip sees a message
(no email form).

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
- The button, `/app`, the words, the pin and the readiness field: `open-trip.test.ts`,
  `relay-open-trip.test.ts` (needs a scratch database), `mini-app-status.test.ts`,
  `server-boot.test.ts`, `command-menu.test.ts`, `trip-app-readiness.test.ts`.
- Client: `web/src/mini-app/MiniAppSignIn.test.tsx`, `web/src/pages/TelegramAccounts.test.tsx`,
  `web/src/pages/TripUsername.test.tsx`.

Real Telegram acceptance remains required on mobile and desktop hosts: launch private and group
entries as linked and unlinked accounts, confirm refusal for non-members, check safe areas and back
behavior, and verify the runtime iframe under the deployment's cookie and framing policies.
