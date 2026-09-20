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

Activation B3 is now implemented locally: the real runtime exchanges a
trip-scoped portal identity for its existing local user's JWT. Disposable
browser checks covered portal → Modern → Classic, logout back to My trips,
and an MCP budget write appearing in two Modern tabs through the real gateway.
The control-plane grant/route responses were fixtures, so deployed acceptance
remains pending. Existing runtimes require a private identity sidecar and a
dedicated exchange key; see [the contract](runtime-session-exchange.md).

## Update — 2026-09-07

*(The commit/PR checkpoint mentioned below happened: `feat/modern-spa-next`
merged as PR #44 on 2026-09-11. See B1 in §3.)*

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
| **Modern is the trip's front door** | **no** | `/` served the legacy site (`<title>Family Trip</title>`) on `japan-2026-2`, 2026-09-06. The code has since changed for newly bootstrapped trips — see the note below the table. |
| **Trip companion reachable** | **no** | `assistant_names` empty, `telegram_chat_bindings` = 0 |
| `runtime_routes` | **no** | 0 rows; "Open trip", invites, participant lookup all dead |

**Why the row above says "no" but the code has moved on.** On 2026-09-06,
`provisioning/adapters.py` did not set `TRIP_DESIGN_VARIANT` at all —
`server/living-journey.js`'s own fallback, `normalizeUiVariant` (`:95-96`),
treats anything other than the literal string `'modern'` (an unset,
mis-cased, or empty env var included) as `'classic'`. That was a property of
the code as it stood that day, not of `japan-2026-2` specifically: every trip
bootstrapped before 2026-09-09 got the same fallback. Since 2026-09-09
(`a2e51d1`), `provisioning/adapters.py:303` writes `TRIP_DESIGN_VARIANT=modern`
into a *fresh* container's first `.env` — the write sits inside the `if [ ! -f
.env ]` guard at `:294`, so it never touches a reused or retargeted
container's existing file, matching B2 below. `server/living-journey.js:246`
reads that env var exactly once, through `normalizeUiVariant`, via `INSERT OR
IGNORE` on the trip's very first `trip_ui_settings` row — a row created before
2026-09-09, `japan-2026-2`'s included, is never revisited by this code path.
Confirmed at `tests/provisioning/test_adapters.py:221`
(`test_proxmox_create_makes_the_nfs_dir_then_creates_and_starts_the_container`).
None of this has been re-measured against the live `japan-2026-2` site since
the 2026-09-06 run above; the "no" in the table is that one dated
measurement, not a claim about today.

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

`site/modern/` already ships with every deploy. On `japan-2026-2`, measured
2026-09-06, it was live on the provisioned trip but not what the organizer's
link opened — a property of the code as it stood that day, not of that trip
specifically. See the note under the §1 table for the mechanism and the
2026-09-09 change.

**B1 — merge `feat/modern-spa-next` (merged).** `f2717c8` ("Merge pull request
#44 from dror1544/feat/modern-spa-next") is an ancestor of the current tree —
confirmed 2026-09-20 with `git merge-base --is-ancestor f2717c8
origin/integration/sprint-6` (exit 0). The feature branch carries the
interactive itinerary map, itinerary ordering, editor viewport fix,
enrichment for Modern itinerary additions, complete Bookings, Budget and
Photos modules, and its rebuilt production bundle. (This bullet read
"implemented; PR pending" as of 2026-09-09 (`a2e51d1`, per `git blame`); the
PR merged 2026-09-11.)

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
3. **B1 + B2** — merge the modern branch, decide the front door. *(Both done:
   B1 merged 2026-09-11 as PR #44 (`f2717c8`); B2 shipped in the same merge
   — see §3, B1/B2.)*
4. **D** — the one-writer change, once the pipeline is no longer the constraint.
5. **B3, then C** — the managed organizer path, then what "active" means.
   *(B3 done — see §3, B3. C is unaffected; still open, see §4.)*

The single decision blocking nothing but worth making early is **B2**.
*(Decided — 2026-09-09, `a2e51d1`; see §3, B2.)* The single decision blocking
Phase A is the `companion-install-plan.md` fork.
