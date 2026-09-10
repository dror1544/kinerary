# Interview → active modern site → trip companion

**Written 2026-09-06**, the day the first provisioning run succeeded. Sequenced
against what was verified on the running stack that day, not against what the
sprint plan says should exist.

Companion pieces: `activation-scope.md` (what activation *is* — still open),
`companion-install-plan.md` (B1), `onboarding-mvp-sprint-plan.md` (the sprints).
This file is the journey, end to end, and where it actually breaks.

## Verification update — 2026-09-10

PR #44 contains the Modern work; the local parent integration branch was
merged into it at `27a38bd`. The September 7 commit checkpoint below is
historical. Map and direct-runtime MCP updates have been browser-verified;
the detailed evidence is in `modern-trip-spa-code-review-session.md`.

The complete gateway handoff is still blocked by activation B3: the real
trip server returns HTTP 404 for `POST /api/internal/control-plane/session`.
Passing gateway tests use a stub for that endpoint. Do not treat route
registration or a passing Modern build as proof that portal launch works.

## Update — 2026-09-07

Phase B is implemented on `feat/modern-spa-next` and is waiting for the explicit
commit/PR checkpoint:

- the current Sprint 5 integration tree has been overlaid cleanly onto the
  feature worktree;
- fresh provisioned runtimes default to Modern at `/`, while existing runtimes
  keep their current choice because their `.env` is not overwritten;
- successful provisioning now creates or readies `runtime_routes`, and the
  portal fails closed until that route exists instead of inferring readiness
  from `ready_private`;
- Modern now has working Budget and Photos modules, including budget CRUD,
  photo upload/delete, albums, reactions, and comments;
- the trip MCP now exposes budget writes as well as reads, completing the
  Budget surface the companion will need in Sprint 5;
- Account/avatar/sign-in management, Tasks/Packing, RSVP/Ratings/Comments,
  Lost & Found, and Trivia remain the established Classic implementations.
  They are labeled as such in Modern, remain available to every traveler, and
  share the same browser session.

The historical run evidence below is intentionally preserved; its `no` rows
describe the 2026-09-06 deployment, not the feature branch after this update.

---

## 1. Where the journey stands

Measured against trip `japan-2026-2` (`trip_7834be4af8791e4ff3b8e4552b85e89d`),
provisioned 2026-09-06 from run 13's confirmed intake.

| Step | State | Evidence |
|---|---|---|
| Deep link → interview → `intake_confirmed` | **works** | 4 clean confirmations in a row; 18 answers, `intk_69c89de5` |
| Plan → organizer approval → job | **works** | first ever: `plans` and `jobs` both 0 → 1 |
| Transform → slug promotion | **works** | `draft-sreq-b5293…` → `japan-2026-2`, deduped against `japan-2026` |
| LXC + NPM + Cloudflare | **works** | vmid 104, 192.168.0.61, job succeeded attempt 1 |
| Site serving | **works** | `192.168.0.61:8080` and `japan-2026-2.ara-united.store` → HTTP 200 |
| Modern SPA present | **works** | `/modern/` → HTTP 200, `<title>Kinerary Modern Trip</title>` |
| Family can log in | **works** | `nir` + seed password → 200; wrong password → 401 |
| **Modern is the trip's front door** | **no** | `/` serves the legacy site (`<title>Family Trip</title>`) |
| **Trip companion reachable** | **no** | `assistant_names` empty, `telegram_chat_bindings` = 0 |
| `runtime_routes` | **no** | 0 rows; "Open trip", invites, participant lookup all dead |

**This is much further along than the ledger reads.** A family could use that
site today. Three things are missing, and only one of them is large.

---

## 2. Phase A — make the trip reachable *(the only thing between here and a family)*

A provisioned trip whose companion never installed is a website, not the
product. The organizer messages the bot and is told "I don't have a trip for
this chat."

**A1 — organizer full-name resolution.** `_resolve_organizers`
(`transformer.py:649-656`) matches `organizer_identity` against `{name,
name_en, username}` and never `name + family`. Run 13's organizer answered
"ניר סולומון" against a participant `{name: ניר, name_en: Nir, username: nir,
family: סולומון}` — no match, so `agent.organizers` went unset,
`build_companion_handoff` returned `None`, and the companion was skipped.
Answering with a full name is the normal case. Match `"{name} {family}"` and
`"{name_en} {family_en}"` too, keeping the existing rule that no match yields
`[]` rather than a guess — handing the private organizer channel to the wrong
person is the failure this caution exists to prevent.

**A2 — make the skip loud.** The whole successful run emitted **one** log line.
The companion skip logs at `info`; the worker configures no logging, so the
root logger sits at `WARNING`. A trip that provisioned "successfully" and
cannot be reached must say so at `warning` or above, naming the consequence.
Cheapest high-value change in this document.

**A3 — B1, the companion install.** No `hermes`, no `node`, no `~/.hermes` in
the worker container, so `render_profile.py` cannot run. Fires the moment A1
lands. Full plan and the fork decision in `companion-install-plan.md`
(recommendation: tooled worker).

**A4 — un-gate the chat binding from the companion install.** The binding sits
inside `if hermes_profile`, so any companion failure silently takes routing
with it. It needs `recipient_chat_id` and the trip, not a rendered profile.

**Acceptance:** the organizer messages the bot about `japan-2026-2` and gets a
real answer. Not a log line — the actual reply.

---

## 3. Phase B — make the modern SPA the trip's front door

`site/modern/` already ships with every deploy and is live on the provisioned
trip. What is missing is that it is not what the organizer's link opens.

**B1 — merge `feat/modern-spa-next` (implemented; PR pending).** The feature
branch now carries the interactive itinerary map, itinerary ordering, editor
viewport fix, enrichment for Modern itinerary additions, complete Bookings,
Budget and Photos modules, and its rebuilt production bundle. The current
Sprint 5 integration tree overlays cleanly; the remaining step is the explicit
commit/PR/merge checkpoint.

**B2 — front door (implemented).** Freshly provisioned trips set
`TRIP_DESIGN_VARIANT=modern`, so `/` opens Modern. Existing hand-built trips
retain their current front door because the bootstrap never overwrites an
existing `.env`. Classic remains at `/classic.html` for established group
utilities and as an organizer fallback.

**B3 — `runtime_routes` (implemented).** The successful provisioning
transaction now creates or readies the route while keeping its stable
`route_ref` on reprovision. The portal and web dashboard require that ready
route; `ready_private` alone no longer masks a missing runtime.

**Acceptance:** the link delivered after provisioning opens the modern SPA,
signed in, showing that trip's itinerary.

---

## 4. Phase C — decide what "active" means *(scoping, not building)*

`activation-scope.md` stands: **do not implement `activation_approved` and
`active` because they exist in an enum.** For the MVP a provisioned
`ready_private` trip is an acceptable endpoint, and today's run supports that —
a family could use `japan-2026-2` now.

Today adds one piece of evidence to that scoping. Sprint 6's verification
aggregator lists "messaging binding" among the things required before
`ready_private`; this run reached `ready_private` and reported success while
having no companion, no binding and no runtime route. So whatever "active"
turns out to mean, **"reachable" has to be checked somewhere**, and A2 is the
cheap version of that check.

Open until you answer §1 of `activation-scope.md`. Nothing in Phases A or B
depends on the answer.

---

## 5. Phase D — the interview's remaining bug supply *(parallel, independent)*

Thirteen runs, and every conversational failure has been the same class: two
independent parties writing to one conversation and arbitrating at runtime.
The coordination surface is 84 references across `src/` — floor, turns,
pendingSay/pendingAsk/lastPrompt, settle windows, dedupe keys, handbacks.

The change that removes the class rather than the instance: **the agent keeps
judgment and loses the pen.** Each organizer message in, one structured
decision out (an acknowledgement, and a next move); the router renders exactly
one message, always. That deletes the floor, the settle window, the watchdog's
guessed timeouts (Track 6's remaining work disappears rather than getting a
heartbeat), `pendingSay`, the raw-send fallback, the handback, and most of the
leak filter. Track 7 dissolves too: if the agent can only *name* a question,
asking one in prose stops being expressible.

Independent of Phases A–C — different files, no overlap. Sequenced after A
because a clunky interview that produces a working trip beats a polished one
that produces an unreachable site.

---

## 6. Order, and why

1. **A1 + A2** — small, and together they turn the current silent failure into
   either a working companion or a loud one.
2. **A3 + A4** — B1 and the binding un-gate. Then a family can be onboarded.
3. **B1 + B2** — merge the modern branch, decide the front door.
4. **D** — the one-writer change, once the pipeline is no longer the constraint.
5. **B3, then C** — the managed organizer path, then what "active" means.

The single decision blocking nothing but worth making early is **B2**. The
single decision blocking Phase A is the `companion-install-plan.md` fork.
