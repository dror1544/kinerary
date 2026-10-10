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
the detailed evidence is in `test-reports/modern-trip-spa-code-review-session.md`.

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
| Family can log in | **works** | `ron` + seed password → 200; wrong password → 401 |
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
(`a2e51d1`), `provisioning/adapters.py` writes `TRIP_DESIGN_VARIANT=modern`
into a *fresh* container's first `.env` — the write sits inside an `if [ ! -f
{app_dir}/.env ]` guard, so it never touches a reused or retargeted
container's existing file, matching B2 below. `server/living-journey.js:246`
reads that env var exactly once, through `normalizeUiVariant`, via `INSERT OR
IGNORE` on the trip's very first `trip_ui_settings` row — a row created before
2026-09-09, `japan-2026-2`'s included, is never revisited by this code path.
Confirmed at `tests/provisioning/test_adapters.py`
(`test_proxmox_create_makes_the_nfs_dir_then_creates_and_starts_the_container`).
None of this has been re-measured against the live `japan-2026-2` site since
the 2026-09-06 run above; the "no" in the table is that one dated
measurement, not a claim about today.

*Line numbers re-checked 2026-09-22 against this tree, since the note above
is a currency claim ("the code has moved on"), not a historical one, and
citations to currently-true behavior rot as unrelated commits land: the
`if [ ! -f {app_dir}/.env ]` guard and the `TRIP_DESIGN_VARIANT=modern` write
it guards are now at `provisioning/adapters.py:309` and `:319` respectively
(were `:294`/`:303` when this note was written, per `git blame`) — 15 and 16
lines of unrelated commits respectively landed in between (`309-294=15`,
`319-303=16`). `server/living-journey.js:246` and
`normalizeUiVariant`'s `:95-96` are unchanged and still current.
`test_proxmox_create_makes_the_nfs_dir_then_creates_and_starts_the_container`
is now at `tests/provisioning/test_adapters.py:146` (was `:221`) — the test
itself and what it proves are unchanged, only its line moved. Line numbers
removed from the inline citations above rather than corrected in place, so
this file stops repeating a number that the next unrelated commit will
silently re-break; the exact current lines live here instead, dated, so a
reader can tell whether a re-check is due.*

**This is much further along than the ledger reads.** A family could use that
site today. Three things are missing, and only one of them is large.

*As a claim about 2026-09-06: true relative to that day's ledger, and it was
an unverified prediction, not a rerun — the §1 table's "no" rows were still
"no". As a claim about today (2026-09-22): §2 below now establishes, freshly
re-verified for this pass, that Phase A's A1–A4 all shipped in code
(confirmed by reading the commits, not by re-driving a live conversation).
§3's B1–B3 already carried "(implemented)"/"(merged)" markers from an
earlier pass (#137/PR #138, 2026-09-20) — not re-verified again here, except
for the note directly above this one (the `provisioning/adapters.py` line
citations it depended on had drifted; corrected 2026-09-22). Nobody has
re-run a real Telegram exchange against a freshly provisioned trip since
2026-09-06 to confirm an organizer message now gets a real reply end to
end — that is still the open acceptance check named at the end of §2. Read
"a family could use that site today" as "the code that would make that true
has shipped," not as a repeat of the 2026-09-06 measurement. The "three
things" named in that sentence are this table's three "no" rows — Modern as
front door, companion reachable, `runtime_routes` — and by the same
re-verification all three have since shipped in code: front door via B1+B2
(§3), companion reachable via A1–A4 (§2), and `runtime_routes` via B3 (§3).
The sentence is left as written rather than rewritten, matching this file's
policy of annotating historical framing instead of editing it; the acceptance
check named above is what still separates "shipped in code" from "actually
missing nothing."*

---

## 2. Phase A — make the trip reachable *(the only thing between here and a family)*

A provisioned trip whose companion never installed is a website, not the
product. The organizer messages the bot and is told "I don't have a trip for
this chat."

*All four items below (A1–A4) have since shipped in code — see each item's
note. This section's framing (as if the failure mode were still live) is
historical, kept intact rather than rewritten; the Acceptance line at the end
of this section is the check that has not been re-run live since 2026-09-06.*

**A1 — organizer full-name resolution (implemented, 2026-09-06).** `_resolve_organizers`
(pre-fix location `transformer.py:649-656` — checked 2026-09-22: that range
now holds unrelated content; the function has since moved to `:1046` and been
rewritten, see the note below) matches `organizer_identity` against `{name,
name_en, username}` and never `name + family`. Run 13's organizer answered
"רון מרגולין" against a participant `{name: רון, name_en: Ron, username: ron,
family: מרגולין}` — no match, so `agent.organizers` went unset,
`build_companion_handoff` returned `None`, and the companion was skipped.
Answering with a full name is the normal case. Match `"{name} {family}"` and
`"{name_en} {family_en}"` too, keeping the existing rule that no match yields
`[]` rather than a guess — handing the private organizer channel to the wrong
person is the failure this caution exists to prevent.

*Shipped as proposed. `8d22486` ("fix(provisioning): resolve an organizer by
full name, and record reachability", 2026-09-06) is an ancestor of this tree
(`git merge-base --is-ancestor 8d22486 HEAD` → exit 0). `_identity_forms`
(`transformer.py:849-899`) now builds `f"{n} {f}"` over every given-name form
against every household form (`:883`), exactly the `"{name} {family}"` /
`"{name_en} {family_en}"` match proposed here.*

**A2 — make the skip loud (implemented, different mechanism, 2026-09-20).**
The whole successful run emitted **one** log line.
The companion skip logs at `info`; the worker configures no logging, so the
root logger sits at `WARNING`. A trip that provisioned "successfully" and
cannot be reached must say so at `warning` or above, naming the consequence.
Cheapest high-value change in this document.

*Shipped, but not by raising the skip's own level to `warning` — instead the
worker's default log level was fixed. `602f450` ("fix(worker): configure
logging, so INFO actually reaches the log", 2026-09-20) is an ancestor of
this tree; it adds `logging.basicConfig` with `WORKER_LOG_LEVEL` defaulting
to `INFO` (falling back to `INFO`, never silence, on an unrecognised value),
so the existing `info`-level skip line now actually reaches the log instead
of being discarded by the unset root logger's `WARNING` default. Net effect
matches the goal (the skip is no longer silent); the specific mechanism
proposed (log the skip itself at `warning`) was not the one taken.*

**A3 — B1, the companion install (implemented, different fork, 2026-09-06 /
2026-09-11).** No `hermes`, no `node`, no `~/.hermes` in
the worker container, so `render_profile.py` cannot run. Fires the moment A1
lands. Full plan and the fork decision in `companion-install-plan.md`
(recommendation: tooled worker).

*Shipped, but via the other fork than this document and
`companion-install-plan.md` recommend. `d2b8817` ("feat(provisioning):
materialize a companion on the host, over a restricted key", 2026-09-06) and
`9a0139f` ("fix(companion): the trip-mcp bridge is wired where node and
Hermes are", 2026-09-11) are both ancestors of this tree. The worker SSHes
out to the host over a forced-command key
(`control_plane_worker/companion_profile.py:174-`) and runs
`scripts/companion-install-host.sh`, rather than running `render_profile.py`
inside a tooled worker container — the SSH-bridge fork, not the tooled-worker
recommendation. Wired into provisioning at `provisioner.py:1589`
(`build_companion_handoff`). `companion-install-plan.md` itself still reads
"Recommendation: the tooled worker" with no note that the other fork shipped
— that file is outside this brief's owned paths; flagged under "Outside
brief" in the handover rather than edited here.*

**A4 — un-gate the chat binding from the companion install (implemented,
2026-09-06).** The binding sits
inside `if hermes_profile`, so any companion failure silently takes routing
with it. It needs `recipient_chat_id` and the trip, not a rendered profile.

*Shipped. `565e579` ("feat(routing): a chat binds to its trip whether or not
the companion installed", 2026-09-06) is an ancestor of this tree.
`control-plane/db/migrations/0043_binding_without_companion.sql` drops the
`NOT NULL` constraint on `telegram_chat_bindings.hermes_profile` — its own
header comment names this item explicitly: "A4 of
docs/onboarding-to-active-plan.md".*

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
   either a working companion or a loud one. *(Both done: A1 in `8d22486`
   (full-name matching in `_resolve_organizers`); A2 in `602f450` (worker
   logging now defaults to INFO, a different mechanism reaching the same
   effect) — see §2, A1/A2.)*
2. **A3 + A4** — B1 and the binding un-gate. Then a family can be onboarded.
   *(Both done: A3 via the SSH-bridge fork in `d2b8817`/`9a0139f` — not the
   tooled-worker recommendation this item's own name points at; A4 via
   migration `0043_binding_without_companion.sql` (`565e579`) — see §2,
   A3/A4.)*
3. **B1 + B2** — merge the modern branch, decide the front door. *(Both done:
   B1 merged 2026-09-11 as PR #44 (`f2717c8`); B2 shipped in the same merge
   — see §3, B1/B2.)*
4. **D** — the one-writer change, once the pipeline is no longer the constraint.
   *(Not done as of 2026-09-22. The coordination surface this item names —
   floor, `pendingSay`/`pendingAsk`, handback — is still present and active in
   `control-plane/api/src/interview.ts` and
   `control-plane/api/src/relay/poller.ts`; no commit
   implementing "one structured decision out, the router renders exactly one
   message" was found (`git log --oneline --all | grep -i "117\b"` returns two
   lines: `56ad0f0`, which places #117 in the sprint plan — a doc commit, not
   a build — and `a22d117`, a coincidental commit-hash match with no #117 in
   its message; re-run expecting both, not one). A related-but-distinct change shipped instead and changes this
   item's premise: `docs/interview-without-an-agent.md` (approved 2026-09-07,
   live by default since 2026-09-09) removed the Hermes agent from the
   interview loop entirely for the default session path — this item's
   two-writer problem assumed an agent sharing the pen with the router, and
   by default there is now no agent in the loop to share it. Track 1's #117
   (`docs/sprint6-tracks.md:102-124`, placed there 2026-09-20) is a further,
   separate, still in-progress redesign of what the interview parks versus
   resolves — the brief that raised this item flagged the two as plausibly
   distinct, and this reading bears that out: #117 is about captured-but-
   unmapped answers, not about who holds the pen.)*
5. **B3, then C** — the managed organizer path, then what "active" means.
   *(B3 done — see §3, B3. C is unaffected; still open, see §4.)*

The single decision blocking nothing but worth making early is **B2**.
*(Decided — 2026-09-09, `a2e51d1`; see §3, B2.)* The single decision blocking
Phase A is the `companion-install-plan.md` fork.
*(Decided — 2026-09-06, the SSH-bridge fork in `d2b8817`/`9a0139f`, not this
document's or `companion-install-plan.md`'s tooled-worker recommendation —
see §2, A3.)*
