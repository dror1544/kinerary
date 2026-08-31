# Setup test plan — Phase H live acceptance run

## Legend

Every step below is tagged with who/what actually does it, so it's clear
which parts are real production code just missing a caller, which parts are
genuinely unbuilt, and which parts are already fully live and unmodified.

| Tag | Meaning |
|---|---|
| 🧍 **HUMAN** | Only you can do this — a real decision or a real tap on your phone. |
| 🤖 **AI (stand-in)** | The endpoint/logic is real, finished production code. There's just no UI/router/script calling it yet (landing-spa, an approve button, an invite flow), so I call it directly — usually only after you say go. |
| 🕳️ **AI (gap-fill)** | The capability itself doesn't exist yet. This is a workaround to get past it for the test, not real code being exercised. |
| 🏭 **PRODUCTION** | Already-built, unmodified, running on its own — Hermes's bot, a background dispatch loop, the poller. Nothing I do drives it. |
| 🚀 **DEPLOY** | Touches real, persistent infrastructure (stacks on top of whichever tag above applies). |

---

## Setup (before the test starts)

1. 🤖 AI (dev-env prep) — rebuild and restart the local control-plane stack (api/worker containers on your Mac) with today's changes. No production equivalent yet (there's no CI/CD pipeline either) — this is just "get today's code running."
2. 🤖 AI (dev-env prep) 🚀-adjacent — reconfigure the worker container to mount kinerary-deploy + your SSH keys and pass real NPM/Cloudflare/Proxmox credentials as env vars at `docker compose up` time (never written to disk, same pattern as the smoke test).
3. 🧍 HUMAN — gives me a trip name and an email+password to use for this test account (since there's no real login page, "signing up" is an API call — see step 4).

## Step 1–2: Signup + approval

4. 🤖 AI (stand-in for landing-spa's signup form, doesn't exist yet) — calls `POST /v1/signup` with your email/password + trip name. Creates the account and a pending approval request. This is real production signup code (`signup.ts`) — only the caller is missing.
5. 🏭 PRODUCTION 🚀 — the outbox dispatcher (already running, unmodified background loop in the API process) sends a real Telegram DM to your phone (chat 391627336) via the Kinerary Bot, with Approve/Reject buttons.
6. 🧍 HUMAN — taps Approve on your phone, for real.
7. 🏭 PRODUCTION — **RESOLVED, was the open question in the last revision.** Telegram delivers your tap as a `callback_query`. The API process has been running a long-polling loop (`startTelegramApprovalPoller`, `telegram-poller.ts`) since it started up in step 1 — it calls Telegram's `getUpdates` every 3 seconds, exactly like Hermes and the RPi bot already do, and picks your tap up on the next poll. **No public URL, no subdomain, no manual DB read** — the fix built earlier today closes this for real, and it's about to get its first live Telegram round-trip. (The webhook route, `POST /v1/signup/callback`, stays in the codebase for later — see the poller's module doc — but isn't what fires here.)

## Step 3: Interview

8. 🧍 HUMAN + 🏭 PRODUCTION — you talk to the Hermes trip-intake bot on Telegram to complete the interview and confirm. One addition since the last revision: the interviewer skill now offers `telegramChatId` on `start_interview` if it knows your numeric Telegram id from its platform context — see **"Built: the chat-id hint"** below for what this can and can't do today.

## Step 4: Plan

9. 🤖 AI (stand-in for an approve-button UI that doesn't exist yet) — calls `POST /v1/trips/:id/plan` then `POST /v1/plans/:planId/approve`, authenticated with your password credential. The endpoints are real production code; the *decision* to approve is still yours — I only place the call once you say go, each time.

## Step 5: Provisioning

10. 🏭 PRODUCTION 🚀 — the worker's own already-running poll loop (`provision`, polling every 10s, started in setup step 2) picks up the approved plan **on its own** and creates a real Proxmox LXC, bootstraps it (nginx/Node/systemd — today's other fix), creates a real NPM host + Cloudflare DNS/ingress, then runs the real `kinerary-deploy/deploy.sh` (code sync, npm install, restart, health check). Nothing here is manually triggered by me beyond the plan being approved in step 9 — this is a genuinely new, publicly reachable trip site, built by the same loop that will run in production.
11. 🤖 AI (stand-in, best-effort) / 🕳️ AI (gap-fill if the hint didn't land) — see **"Built: the chat-id hint"** below. If your interview conversation supplied `telegramChatId`, the DM should actually send this time; if it didn't (most likely today — see below for why), it's marked `skipped`, not stuck, and I verify the URL directly instead.

## Step 6: Family access

12. 🕳️ AI (gap-fill) — verifies the real site loads, then (with your OK) adds a family participant via the *trip site's own* existing agent API (`server/server.js` — a different system from the control-plane pipeline entirely). Control-plane itself has no invite automation at all yet — this is a real, logged gap, not a stand-in for something that exists.

## Step 7: Correction

13. 🤖 AI (stand-in for a "resubmit corrections" UI that doesn't exist yet) 🚀 — calls the correction endpoint, confirms old version preserved + re-plan + re-deploy succeeds.

## Teardown

14. 🧍 HUMAN + 🤖 AI 🚀 — with your go-ahead, tears down the real container/NPM host/DNS (or we keep it — your call).

---

## Resolved: the public-URL / webhook question (was step 7)

You were right to push back — Hermes and the RPi bot never needed a public URL,
because they use long polling (outbound `getUpdates`), not a webhook (inbound
push). I'd wrongly assumed the approval tap needed a webhook. That's fixed:
`telegram-poller.ts` now does the same outbound long-polling Hermes does, and
it's wired into `server.ts` to start automatically whenever signup is
configured. The original webhook route is kept in the codebase (your
instruction — "keep this implementation also") for whoever eventually runs
this behind a real public endpoint, but it's not what handles step 7 today.

## Built: the chat-id hint (was "Resolved: the chat-id question")

You asked me to build the fallback rather than defer it. Here's exactly what
exists now, and — importantly — its real limit for *today's* test.

**What's built** (migration `0022_interview_chat_id_hint.sql`):

- `interview-mcp.ts`'s `start_interview` tool gained an optional
  `telegramChatId` argument — a best-effort delivery hint, explicitly
  documented as never-guess/omit-if-unknown.
- `interview.ts`'s `startSession()` validates it (digits only, 1–20 chars)
  and writes it to a **new** column, `trips.notification_chat_id_hint` —
  deliberately *not* `user_identities` (see the migration's header: that
  table's `provider = 'telegram'` rows are also read as an *authentication*
  source in `resolveWebAuth` — `app.ts:330,530,581,628,679`. Writing an
  LLM-relayed value there would let a mis-relayed id grant login capability,
  not just a delivery hint — a real bypass, not a hypothetical one. This hint
  column can only ever be read for notification delivery, never for auth).
- `provisioner.py`'s two recipient lookups (`_complete`, `_fail`) now
  `COALESCE`-fall-back to this hint whenever the verified
  `user_identities.provider_subject_id` is absent — verified identity always
  wins when both are present.
- The trip-intake-interviewer skill (both the repo copy and the live
  `~/.hermes/profiles/trip-intake` profile — confirmed byte-for-byte in
  sync) now tells the agent to pass `telegramChatId` "if your platform
  context surfaces" it.

**The real limit, found while building this:** I checked Hermes's gateway
directly (`~/.hermes/hermes-agent/gateway/`) rather than assuming. Your
numeric chat id *does* exist as a verified, gateway-held value per
conversation (`HERMES_SESSION_CHAT_ID`, a context var read via
`get_session_env()` — already used internally by several native tools). But
that value lives in the *gateway's* Python process; it isn't currently
surfaced into the LLM's own context or exposed as a callable tool, and
interview-mcp's SSE connection is a static, per-profile URL
(`~/.hermes/profiles/trip-intake/config.yaml`), not something the gateway
attaches a per-conversation chat id to today. So in practice, the agent has
no reliable way yet to actually know its own chat id to pass along — this
build closes the *receiving* end (control-plane + skill instruction), but
the *verified source* side is still open. Expect the hint to be absent most
of the time until that's built, which means step 11 will likely still land
on `skipped` today, same as before this change — but the plumbing is now
real and ready for whenever the source side lands.

**Future-sprint item, logged per your instruction** (`docs/onboarding-mvp-sprint-plan.md`,
Sprint 5's Build list): fold `trip-intake` into the same shared Trip Bot
router that sprint already builds — route to interviewer mode when a chat id
isn't yet bound to a trip, and let an existing organizer's own companion
re-enter interview mode for a new trip, instead of a separate bot/profile
per purpose. Once that lands, the hint above becomes unnecessary — the
verified `user_identities` path (migration 0017) covers it properly, same as
any Telegram-authenticated organizer today.
