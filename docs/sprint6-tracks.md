# Sprint 6 — the five tracks

`docs/onboarding-mvp-sprint-plan.md:1438-1552` stays the authority on **what**
Sprint 6 builds and what its exit gate is. This document is the authority on
**how that work is organised** — five tracks with different goals, audiences and
shipping cadences — and on which items were added to the sprint or taken out of
it on 2026-09-19.

Read the sprint-plan section first; read this one before picking anything up.

Why the split exists: the sprint section as written is operator-facing end to
end. Nothing in its build list is a trip-site change, and nothing in it touches
model cost — yet both are real work this sprint. Slicing by delivery cadence
makes that visible, and makes it obvious which items can ship to live trips as
they land and which must wait for the end-of-sprint VM upgrade.

Every claim below about what does or does not exist in the code was verified on
2026-09-19; the checks are at the end of this file. Where a document contradicts
it, that document is stale and is listed under track 4.

---
---

## Where Sprint 6's own build list lands

| Track | Goal | In Sprint 6 as written? | Ships |
|---|---|---|---|
| 1 — Trip UI/UX | Day-of usefulness for the traveler | **Nothing.** Sprint 6 is operator-facing end to end. | site items continuously; transformer items pilot-then-fleet |
| 2 — Landing/accounts/monitoring/data | Does the product actually work? | **Almost all of it.** 6 of the 7 build bullets. | VM at sprint end, via the release tooling |
| 3 — Model efficiency / cost | Make spend real, predictable, attributable | **Nothing.** Entirely net-new. | harness → recommendation → instrumentation |
| 4 — Housekeeping | Truthful backlog, live trips stop breaking, clean tree, docs aligned | **Nothing written**; the carry-forward ledger and 35 open issues are real work. | front-loaded, then small |
| 5 — Exit gate | Prove the lifecycle end to end | The demo rehearsal and full-cycle re-provision. | last |

So tracks 1, 3 and 4 fill from *outside* the sprint text: the Sprint 5
carry-forward (`docs/sprint5-closeout-handoff.md:148`), §4.5 enrichment residue,
and the open issue list. Track 2 *is* Sprint 6.

---

## Track 1 — Trip UI/UX

> **Goal: day-of usefulness for the traveler** — the person holding the phone,
> before and during the trip. Not feature coverage for its own sake; what fails
> in the moment.
>
> **Ships:** site-cadence items continuously. Transformer items go to **one pilot
> trip, then the fleet**. **Priority: biggest blank first.** **Done: the named
> list ships** — no outcome bar, this track is an ordered backlog.

Nothing here comes from the Sprint 6 section.

### 1a. The blanks — transformer change + re-provision (pilot, then fleet)
Ordered biggest-blank-first. Item 1 is also the content source for 1c phase 2,
which is why it leads.

1. **Destination info is blank** — Health, Money, Communication, Hospitals, Age notes are rendered (`trip-web/src/readiness.tsx:26-28,197,208`) and never populated. `transformer.py:304-315` states the enrichment pass "was never implemented or wired into this provisioner"; `enrichment._country_entry` emits only flag/capital/currency/callingCode/emergency.

   **Decided 2026-09-19.** Four things, and the third is what makes this cheap:

   - **Deterministic first, a model only at the gaps.** Facts from APIs as `enrichment.py` already does (countries.dev, Nominatim, Wikipedia, emergencynumberapi — it is deliberately model-free today); prose from a model only where no API can answer. Mark which is which in the data, so the site can show provenance and a wrong model line is traceable to its source.
   - **Hospitals are dropped.** `info.hospitals` stays unrendered. Emergency numbers already come from a real source and are what actually matters in an emergency; a plausible-but-wrong hospital is a failure mode not worth carrying. Health, money and communication stay — they are advisory and lower-stakes.
   - **The content is shared across trips, not built per trip.** The first trip to a country pays for it; every later trip to the same country reads the stored row. **This store already exists**: `control_plane.country_reference` (`db/migrations/0023_country_reference.sql`) was built as exactly this — *"facts that are true of a destination country regardless of which trip is asking"*, filled once by a web search at interview time and *"reused: every later trip to the same pair reads the row instead of searching again"*, read by `enrich_config` at provision time (`worker/__main__.py:281-291`, `enrichment.py:380`). It carries `fetched_at` already. It simply holds nothing but consular contacts today. Extend it rather than building a second cache.
   - **Re-verify monthly.** `fetched_at` makes staleness visible and **nothing refreshes it** — there is no job, anywhere, that revisits a `country_reference` row. That refresh is part of this item, not a follow-on.
   - **Granularity: country base with phase overrides.** National facts once; phase-level additions where they genuinely differ.

   **Open schema question to settle first.** `country_reference`'s primary key is
   `(destination_country, home_country)`, because which embassy matters depends
   on the traveler's nationality. Health, money and communication are
   destination-only, so storing them in that table duplicates them once per home
   country and invites the copies to drift apart. Either a second table keyed by
   destination alone, or a deliberate acceptance of the duplication — decide
   before writing the migration, not after.

   **Cost note, for track 3:** this design makes the model spend
   *per-country-per-month* rather than per-trip, which is the difference between
   a cost that grows with customers and one that grows with the world.
2. **No pre-trip tasks** — Readiness reads `config.tasks`; the transformer never emits it. FRAMEWORK feature #8. Undocumented anywhere until now.
3. **No per-phase packing lists** — `phase.packing` never emitted; a hardcoded 4-item fallback shows. FRAMEWORK #16.
4. **No RSVP activities** — `phase.rsvp_activities` never emitted, so the whole RSVP surface is invisible. FRAMEWORK #11. Corroborated by the live-trip report: *"RSVP/trivia features: unused"*.
5. **#62** — `travel_anchors` offers only flight/hotel/car, so booked tickets and attractions lose their confirmations. The transformer already accepts them; the interview question contract does not offer them.
6. **#77** — companion never sees `trip_interests`.

### 1b. Day-of correctness — MCP prompt or site redeploy
The release payload is exactly `site/ server/ shared/`
(`release_source.py:23`), so these reach a live trip with no re-provision.

- **#68** — plan items about a neighbourhood or several places get no map link (7 of 25 items on the live `japan-2026` site). Root cause is the prompt at `mcp/mcp.js:930-963`. MCP-service change.
- **#67 — still open, verified 2026-09-19.** `add_plan_item` (`mcp/mcp.js:595`) is a bare `apiPost`; the route (`server/server.js:2304`) is a straight INSERT with no check. What exists nearby and is *not* this: a booking duplicate check by confirmation string (`mcp/mcp.js:903-909`), and two unique indexes on `config_ref` / `itinerary_item_uid` (`server/server.js:474-475`) that are **partial** (`WHERE ... IS NOT NULL`), so they guard imported and config-derived items only. A free-text item the companion adds carries neither.
- **#69** — English place name in parentheses on Hebrew plan items, so a line can be pasted into Maps. `trip-web/src/App.tsx` + `site/app.js`.
- **Trivia empty state** — every provisioned trip gets `trivia_questions.json = []` (`provisioner.py:755-761`); the organizer can seed it in-UI but is never told so.
- **Classic retirement** — the acceptance matrix in `docs/modern-classic-parity-plan.md` is unrun, so organizers still see a Classic fallback link. Verification, not build.

### 1c. Today, before the trip starts — in two phases
Today currently shows `next` — **the first itinerary item** — as its headline
(`trip-web/src/App.tsx:676`), so before departure a family sees day 1's schedule
plus a countdown line (`:677-678`). The only thing it links to is "Tasks, packing
and useful information" (`:703`), which are three of the four blanks in 1a.

- **Phase 1 — preparation progress.** What is booked, what is missing, what to pack, what to do before departure. Falls out of 1a items 2–3 and the existing confirmations query (`:665`), so it needs no new content source.
- **Phase 2 — destination tips and insights**, sourced from 1a item 1's destination-info pass.

### 1d. Telegram handoff from the site (conversation deferred)
**Decision: handoff now, conversation later.** The in-site surface stays an async
message board; making it a real conversation is recorded as separate, later work
with its own design.

What the board actually is today, for the record: `CompanionPanel.tsx` posts a
question into per-trip SQLite (`server/companion-conversation.js:31-36`), the
browser polls every 15s (`CompanionPanel.tsx:17`), and the companion's **cron
picks it up every five minutes** (`familytrip-companion/templates/SOUL.md.tpl:636-648`).
One reply per question, no follow-up turn (`companion-conversation.js:46-48`).
There is no synchronous path from the trip site to the companion at all.

- **Capture the group invite link at bind time** (decided). `exportChatInviteLink` is implemented at `control-plane/api/src/relay/telegram-api.ts:285-290` and **nothing calls it**. Needs: a column on `telegram_chat_bindings` (none today — `0029`/`0043`/`0053` have no invite field), a call in `bind_chat_to_trip` (`provisioner.py:371-467`), and a path to the site. The site half already exists: `CompanionPanel.tsx:26,62` renders `connection.group_url`, today writable only by hand through MCP `set_companion_connection` (`mcp/mcp.js:276-282`). **Prerequisite:** the bot must be an admin in the group to export a link, which provisioning does not arrange.
- **Make the handoff affordances clear** — the per-item "Ask" deep link already exists (`trip-web/src/App.tsx:228-232`, used at `:526`).

### 1e. Group addressing — test what is merged, before building more
**Decision: verify first.** PR #64 (`1946849`) landed the *receiving* half on
`integration/sprint-6`: migration `0053` adds `awaiting_reply_since` to the
bindings and a 150-second one-shot window (`chat-router.ts:383`, `:425-440`).

Two facts that decide the work:
- **Nothing in this repo ever stamps `metadata.expects_reply`.** The commit says so: the Hermes-side change is "a separate, cross-repo follow-up." So the window never opens and the feature is **inert in production**.
- It is **not on `main`**, and `docs/test-reports/plan-review-vs-enrich-comparison-2026-09-15.md:70-78` records it as "Not run in this session".

So today's rule is unchanged and is the friction itself: in a group, every message
must be an `@mention`, a name-mention, or a tap-to-reply (`relay/addressing.ts:83`).
The task is to verify the merged half against a stand-in that stamps
`expects_reply`, and decide from that evidence whether the cross-repo Hermes
change is the right next step.

*Note on cadence:* this is relay/control-plane work, so it does not ship on the
site cadence with the rest of track 1.

### Parked
- **Plan-review queue surface.** `planReviewQueue`/`decidePlanProposal` (`plan-review-store.ts:154,196`) are referenced only by their own test; 33 evidence-backed proposals sit unqueried on the `japan-2025` fixture. Needs a control-plane route *and* a site surface. Out of track 1 (2026-09-19).
- **A synchronous in-site conversation.** Deferred by decision above.

### ⚠️ Stale source — do not work from it
The "data gaps in the generated site" table at
`docs/signup-test-execution-capture (Manual).md:131-144` lists **seven rows as
Open/Partial that are all built**: phase map stops, per-phase itinerary from PDF,
structured budget, embassy/police numbers, family-name transliteration, the trip
bot wiring, hero photos. Likewise `docs/onboarding-to-active-plan.md:81-94`
(Modern *is* the front door now) and "thin phases" generally (fixed 2026-09-12/13
in `0daf16a`, `078237c`, `f184cd3`, `947aa2d`).

---

## Track 2 — Landing page, accounts, monitoring, data gathering

> **Goal: does the product actually work?** The audience is the business, not
> primarily the operator. Data gathering leads, and the dashboard exists to read
> that data — the daily control-plan report and the derived rates are its
> first-class content, not ops rows with a report bolted on.
>
> **First question to answer: is the assistant actually helping?** — the outcome
> events from plan `:1479`, measured against the model in
> `.agents/skills/trip-assistant-experience-evaluation/`.
>
> **Real data comes first.** There is one real active trip (Nir's). The
> evaluation runs on it **by hand, early** — the model needs no instrumentation,
> and scoring a real trip is what tells us which events to build.
>
> **Dashboard: built as specified** (`:1466`), not as a wrapper over the fleet
> monitor. **Accounts: organizer web signup only.**
>
> **Ships: to the VM at sprint end, through the release tooling** — install
> `kinerary-cp-release` (merged `94e572d`, not installed on the VM), rehearse
> upgrade *and* rollback on the Mac, then upgrade production with a recorded way
> back. The VM is live with a real organizer. Hard rule 2 applies at every step.

Six of Sprint 6's seven build bullets land here. Build order follows the goal:
**events → rates and daily report → the dashboard that renders them → the
aggregator and ops rows → organizer signup.**

> **Sizing note, stated once and not re-litigated:** this track now holds the
> from-zero event pipeline, the derived rates, the daily report, the
> missing-information loop, a full operator console, the verification aggregator
> and organizer signup — while tracks 1, 3 and 4 run alongside. It is
> the largest of the five by a wide margin. The build order above is chosen so
> that stopping early still leaves something that answers the goal's question.

### Data gathering — the largest gap, and everything else waits on it
Sprint plan `:1479-1496`.

- **Zero assistant-side event emission exists.** Greps across `control-plane/api/src/relay/` (15 files), `chat-router.ts`, `runtime-gateway/server.js` and the worker return nothing.
- What exists is **one coarse table**: `control_plane.funnel_events` (`db/migrations/0034_web_portal_addenda.sql:27-44`), a closed 10-name lifecycle vocabulary, emitted from exactly 8 sites, **all in `portal.ts`**. `provisioning_completed` and `interview_confirmed` are in the CHECK constraint and never emitted.
- Sprint 6 needs the **§5 base event envelope** (22 fields, `docs/trip-bot-analytics-and-metrics-design.md:258-292`) with outcome events inside it — grounded / partial / missing-data answers, unanswered group mentions, organizer follow-up requested/answered, post-write verification passed/failed — *"not as a second vocabulary"*. `funnel_events` shares nothing with that vocabulary.
- Then the five derived rates, grouped by trip/phase/day/channel/role/topic; the daily control-plan report; and the missing-information control loop.
- Also routed here from the live-run ledger: **per-user Telegram info-message logging** (`:1351-1353`).
- Sprint 7 keeps the weighted 1–5 scoring and repeated-question reduction.

#### Measure the live trip first — by hand, before any events exist

The measurement model already exists and **does not require instrumentation to
run**. `.agents/skills/trip-assistant-experience-evaluation/SKILL.md` is the
source of truth (`docs/trip-assistant-experience-metrics.md` is a deliberate
pointer that restates nothing): six weighted dimensions, an **8-step evaluation
workflow** — define the window, collect product evidence, count service usage,
assess data completeness, assess quality from the traveler's viewpoint, separate
system-owned from organizer-owned from traveler-experienced, evaluate learning
and enrichment, recommend the next smallest actions — and a 7-part reporting
pattern.

`docs/test-reports/usa2026-trip-assistant-usage-report.md` is the proof it works
without events: it counted 10 inbound group messages, **2 of 12 participants who
ever contacted the bot**, a day-by-day activity timeline, and zero usage across
the final 10 days, scoring 2.9/5 — all from transcripts and site data.

**We have one real active trip (Nir's), and it is the only real data there is.**
Two consequences:

1. **Run the evaluation on it early, by hand.** It needs no code, so it produces a real baseline in the first days of the sprint rather than at the end. Every day spent building instrumentation before this is a day of a live trip going unmeasured.
2. **It is the design input for the event vocabulary.** Scoring a real trip without instrumentation is how you find out which events you actually needed — cheaper than discovering it after the pipeline is built. The 18 event types in `references/control-plan-metrics.md:533-552` should be confirmed or corrected against what the evaluation could not answer.

Then re-score the same trip at sprint end, so track 2's goal question gets an
answer with a before and an after rather than a single number.

Two cautions:
- **Capture the skill before deploying over it.** Its scoring notes — the traps that produce a flattering score for a service travelers did not receive — live in a Hermes profile with no history, and nearly got lost once. `scripts/install-hermes-skill.sh trip-assistant-experience-evaluation <profile> --capture` first, then commit.
- **A manual evaluation reads a real family's transcript.** That is appropriate for a one-off human-or-agent evaluation and is exactly what the instrumented path must never do — `funnel_events` and the §5 envelope are transcript-free by design. The report should quote only what it needs, as the USA2026 one does, and persist no transcript.

### Monitoring
- **Verification aggregator** (`:1461`) — `ready_private` is written unconditionally at `provisioner.py:1150-1158`, with no gate. The `control_plane.verification_evidence` table exists (`0001_foundation.sql:139`) and **has no writer anywhere** (verified: only the migration and an id-format list reference it). Of the six required signals, only messaging binding and reachability have any check at all.
- **Super-admin dashboard** (`:1466`) — **decided: build it as specified.** Nothing exists today: no UI, no `/v1/admin/*`, no `/v1/jobs` read endpoint, no suspend/retry. The data mostly exists (`jobs`, `funnel_events`, `audit_events`, `release-registry`, `redaction.ts`) with no reader, so the work is a read API plus a UI shell plus the suspend/retry mutations with server-side authorization.
  - Considered and **not** taken: wrapping `.agents/skills/trip-fleet-monitor/fleet-mcp.mjs`, whose eight read-only tools already answer six of the dashboard's eight rows against the live DB. Worth keeping in view as the fallback if the console runs long — and worth reading its queries before writing new ones.
  - Per the goal, the daily control-plan report and the derived rates are the dashboard's primary content; the ops rows (jobs, failures, versions, audit) fill in behind them.
- **Runbook** (`:1476`) — partly satisfied by `kinerary-cp-release upgrade|rollback` (#84, merged `94e572d`), which is not recorded against this bullet.

### Landing page
- `web/` is a real, wired SPA — the plan's note at `:1886-1889` claiming its endpoints are unmounted is **stale**: `control-plane/api/src/portal.ts` mounts all of them (`app.ts:1469`).
- Open: the **organizer-scoped projection decision** (`:1469-1475` + §5 `:1895-1935`) — build it here or defer to the post-MVP web track; the richer trip-card model and the action surface (suspend/retry/re-provision) from `docs/web-control-plane-integration-plan.md` §8.
- Dead weight: six orphaned page files in `web/src/pages/` superseded by `ProductApp.tsx`, and a `web/README.md:14-17` that still says auth is interface-only.

### Account management — **an add to Sprint 6, scoped to organizers** (decided 2026-09-19)

**In scope:** organizer email/password signup on the landing page. Control-plane
organizer accounts are **Google-only** today when the portal is configured —
`/v1/signup` and `/v1/auth/telegram` both return 410, and the only account
creation is first-verified-Google-login (`portal.ts:378-383`).
`docs/web-control-plane-integration-plan.md:97-111` specifies nine account
endpoints; four exist (`google/start`, `google/callback`, `/v1/me`, `/v1/logout`).
Missing: `register`, `verify-email`, `login`, `password/forgot`, `password/reset`,
the `email_identities` / `account_action_tokens` tables, session rotation on
password change, and rate limits on the auth endpoints. Named as a standing gap
at plan `:1313` and `:1916`, with the landing page called its natural home.

**Out of scope, stays a standing gap:** member login on provisioned trip sites.
`server/server.js` has no registration route at all; accounts come only from
seeded `trip.config.json` participants, Google is link-only (`:1303-1305`), and
invites **bind an existing seat rather than create one**
(`server/control-plane-auth.js:98-99`). A participant with no seeded password and
no linked identity cannot get in. Deliberately deferred — `server.js` auth is a
security-sensitive path and this is a second, larger build.

### Superseded — do not build
The **expiring activation plan and its distinct approval** (`:1464`) is superseded
pending scoping (`:1440-1447`, 2026-09-05). `activation_approved` and `active` are
in the enum with no writer, and whether they survive is an open product question.

---

## Track 3 — Model efficiency and cost (net-new to the sprint)

Nothing in Sprint 6 covers this, but the substrate is unusually ready.

> **Goal: make model spend real, predictable and attributable.** The product
> cannot scale on Dror's personal Claude and Codex logins. Today's headline
> paths measure at **$0 because they land on subscriptions** — that is a
> measurement artefact, not a saving. Success is a known, metered per-mission
> cost, **even if the visible bill goes up**.
>
> **Where the money goes today is unknown, and producing that number is the
> point** — priorities follow the measurement, not a guess made now.

### Decided shape (2026-09-19): harness → recommendation → instrumentation

**Step 0 — fix the OpenRouter config that is already lying.**
`kinerary-extract` pins `minimax/minimax-m3:free`, which **does not exist on
OpenRouter**, so that profile has silently run its 7-deep fallback chain since it
was written (`model-runner.ts:649-654`, plus two test reports). Either find the
correct id, choose another free/cheap model, or drop the pin — but note the trap:
the chain is duplicated in `profile-templates/kinerary-extract/render_extract.py:63-79`
**and** `templates/config.overlay.yaml`, and the live profile is whatever
`render_extract.py` writes. Fixing only the YAML changes nothing. No comparison
run is trustworthy until this is honest.

**Step 1 — inherit the instrumentation from PR #92, do not write it.** Verified
2026-09-19: #92 already threads
`ModelUsage {inputTokens, outputTokens, totalTokens, costUsd, costKind}` through
all four backends, surfaces it on every result beside `attempts` and `ms`, and
reads `payload.usage` in `callOpenRouter` instead of discarding it
(`model-runner.ts:50-78`, `:879`). It even carries
`costKind: "billed" | "api_equivalent"` — the distinction that stops a
Claude-CLI subscription call being reported as money spent. Writing this
separately means writing it twice on top of a +537/−66 rewrite of the one file
that decides which model reads an organizer's documents. **This reverses the
order: #92's model-runner work goes first, and track 3 builds on it.**

**Step 1b — the harness.** Extend `control-plane/api/tools/extract-intake-eval.mjs`:
a `--label` per model config, cost emitted alongside the `ms` and `attempts` it
already records, run across candidate models for the three pinnable tasks.
Prerequisites inside the product: record **which runner/model produced each
result** (a column beside `duration_ms` in `interview_interpretations`, which
records neither today) and stop discarding `payload.usage` in `callOpenRouter`
(`model-runner.ts:475-545`).

**Step 2 — the recommendation, as a migration plan.** Per mission: the model, its
metered cost, the quality it holds, the evidence — and explicitly which missions
move off the subscription paths and in what order. `model-runner.ts` forbids
`openrouter/auto` by design (`:707`), so every pin stays explicit.

**Step 3 — instrumentation, if it fits.** Model, tokens and latency recorded on
every call so the answer keeps updating rather than being a snapshot. This
overlaps track 2's data gathering; build it once, for both.

**OpenRouter plays both roles, in that order:** the comparison substrate first,
then the production routing layer for whichever missions the comparison says are
worth metering — one key, one bill, attributable per-model spend.

**Existing cost source worth using before building one:** Hermes writes billed
model, provider and token counts per session into `~/.hermes/profiles/<p>/state.db`.
That is where both existing comparison reports got their numbers, and it is how
the companion — which has no seam in this repo — can be measured without one.

### The seam already exists
`control-plane/api/src/model-runner.ts` is the single task→runner→model resolver:
a **three-task table** at `:759-765` (`interpret`, `extract`, `plan_review`), four
runner kinds (`openrouter`/`codex`/`claude`/`hermes`) at `:738-753`, per-task
`<PREFIX>_RUNNER|_MODEL|_TIMEOUT_MS`, and a deliberate refusal of model-picks-model
(`FORBIDDEN_MODELS`, `:707`). Adding a mission to the A/B surface is one table entry.

### The comparison harness already exists
`control-plane/api/tools/extract-intake-eval.mjs` — 13 scenarios including prompt
injection, a failure taxonomy (`unsupported`/`lost`/`datetime`/`info`),
cross-document invariants, `--runs`/`--concurrency`, per-run JSON with **`ms` and
`attempts`**, and `--scenarios` for private documents that must not be committed.
Model comes from `modelRunnerFromEnv()`, so **`EXTRACT_MODEL` is already the A/B
axis**. It is roughly one `--label` away from being the cost/quality test set.

Supporting material: `test/fixtures/make_documents.py` (generates japan/multi/chaos
documents *with* their assertions, never committed), `interview-transcript.test.ts`
(golden transcripts, each assertion named after the live run that caused it),
`organizer-chaos.ts` (a scripted misbehaving organizer).

### What blocks measurement today
- **Nothing records which model produced a result.** `interview_interpretations` stores `attempts` and `duration_ms` (`0048_interview_interpretations.sql:40`) but no model or runner column — historical comparison is impossible.
- **`callOpenRouter` throws away `payload.usage`** (`model-runner.ts:475-545`). No token accounting anywhere in the product; grepping `prompt_tokens|completion_tokens|usage` across the API, gateway, `mcp.js` and `server/` returns zero accounting hits.
- **No price table, no budget.** The only pricing in the repo is prose in a comment.
- **Only `interpret` persists latency.** `extract`, `plan_review`, enrichment and the companion record nothing.

### Where the cost actually is
- **Six missions bypass the seam entirely** — venue-link search, consular lookup, booking extract, item enrich, day label, schedule review — each through a Hermes *profile* with a 7-deep provider fallback chain. They cannot be A/B'd without adding them to the task table or editing a profile globally.
- **The companion has no seam in this repo at all** (`relay/dispatch.ts:88-89` hands off to the gateway). It is the largest spend, `max_turns: 30`, free text, and the hardest to score.
- **`plan_review` runs with no model at all today** — `PLAN_REVIEW_RUNNER` is absent from `provisioning.env` (verified), so it degrades to `modelSkipped: NO_RUNNER`. The rules-only half produced 33 useful proposals for free.
- **A live misconfiguration:** `kinerary-extract`'s pinned primary `minimax/minimax-m3:free` does not exist on OpenRouter, so that profile has been silently running its fallbacks since it was written (`model-runner.ts:649-654`, plus two test reports).

### Prior art
`docs/test-reports/enrichment-openrouter-2026-09-13.md` (6/6 in 3–6s, ≈$0.002, but
4 of 6 URLs dead) and `docs/test-reports/plan-review-vs-enrich-comparison-2026-09-15.md`
(a real wall-time/token table; both $0 because both landed on a subscription).
Both are cost/quality comparisons already in the right shape.

### Dependency worth naming
Ranking models on the **structured** missions (10 of 16) needs only the offline
harness. Ranking them on the **free-text** missions (the companion, the interviewer)
needs track 2's outcome events to define "better". Those two halves can run at
different speeds.

---

## Track 4 — Housekeeping and bug fixing

> **Goal, five parts:** a backlog that tells the truth · live trips stop breaking
> · a clean tree · the important pending issues actually fixed · **docs in order
> and aligned with the code**.
>
> **Weight: front-loaded, then small.** The audit and the tree clean-up come
> first, because tracks 1 and 3 need a true picture to know what to build; after
> that it drops to opportunistic fixes.

### Task zero: the already-fixed audit
Findings that exist **right now**, before any sweep:

- **PR #91 and PR #92 both claim #58** (Codex runner exposes shell/web/patch/MCP to untrusted document text). Two open PRs, one defect.
- **PR #92 claims all fourteen of #49–#62** on a single branch (`feat/document-intake-sprint6`). Any separate work on those issues is duplicate work until that PR lands or is split.
- **Merged despite being recorded as uncommitted:** `fix/organizer-identity-roster`, `fix/group-attachment-followup`, `fix/site-upload-auth`, `fix/hermes-tool-call-payload-aliases`, `fix/monitor-activity-visibility`, `feat/trip-fleet-monitor` are all ancestors of `main`.
- **Seven stale ledger rows** in `docs/signup-test-execution-capture (Manual).md:131-144` (see track 1).
- **Three docs that will mislead planning:** sprint plan `:1886` (SPA endpoints unmounted — they are mounted), `web/README.md:14-17` (auth interface-only — it is not), `control-plane/api/src/app.ts:119` (service index self-reports `"sprint": 4`).

### Land or close the open PRs — risk-assess #92 first (decided)
#89 trip data dir by id · #90 verified chat binding (current branch) · #91 Codex
isolation · #92 document intake · #95 organizer invite links.

**#92 was assessed on 2026-09-19 and the decision is: unbundle it, do not land
it whole.** Report: `docs/test-reports/pr92-regression-assessment-2026-09-19.md`.
It targets `integration/sprint-6` (as do all five open PRs), so production sits
behind sprint-6 → main → a `kinerary-cp-release` upgrade.

**The agreed plan:**

1. **Land #91 first for #58, then rebase #92 onto it** — not revert; both export
   the same two symbols. They are complementary, not duplicate: #91 has an env
   *allowlist* and `--ignore-user-config`, #92 a *denylist* and a startup
   isolation probe #91 lacks. Measured against a fake `codex` that records its
   own environment, #92's child saw the relay secrets and #91's saw `null` —
   while #92's `compose.vm.yml` makes codex the **default** for both document
   tasks. Keep #92's startup probe.
2. **Slice A — reader, parser, gate — ships first.** `answer-merge.ts` has
   **zero imports**, so it ships with no registry, store, migration or worker:
   132 tests in 4.7s, nothing one-way. Closes eight of the defects.
3. **Slice B — registry, store, migrations, worker — waits** behind NFS
   provisioning, which lands as its own verified change first.

**Do not treat #62 as open work.** The `travel_anchors` prompt is already
widened inside #92 ("flights, trains, hotels, cars, tickets or tours",
`interview.ts:525`, with a comment citing #62) even though the PR body declares
it open. Picking it up separately duplicates a prompt change on a file #92
rewrites. This is the exact trap this track exists to catch.

**Two risks that are not #92's alone.** All nine migrations `0050`–`0058` lack
the required `-- rollback:` header, five of them already on `integration/sprint-6`;
`vm-release.py:300` treats missing as `breaking`, which converts a rollback from
"redeploy the previous image" into "restore the dump and lose every write since",
on a stack with a real organizer. Fixing it is nine comment lines and is
**provably inert** — `applyMigrations` tracks `(version, applied_at)` keyed on
filename with no checksum (`migrations.ts:14-28`), so an applied migration is
skipped and never re-read.

And `${KINERARY_NFS_ROOT:?…}` appears twice in `compose.vm.yml`. Verified
2026-09-19: the variable exists in neither `main`, nor `integration/sprint-6`,
nor `kinerary-deploy`, and the VM has **no NFS mount at all**. Unresolvable, it
stops `docker compose` *parsing* — so API, worker, relay and every bound chat go
down together. That is unprovisioned infrastructure, not a misconfiguration, and
it is the reason Slice B waits.

### Get `integration/sprint-6` onto `main`
Migration `0053` and the group reply-capture work (PR #64) exist **only** on the
integration branch. Track 1e's verification and anything depending on the
bindings schema are working against a branch, not against `main`.

### Branch and worktree sweep
25 local branches, 19 worktrees including three `/private/tmp/kinerary-review-*`.
`pr-steward` is the agent for this; it deletes only provably-merged branches, on confirmation.

### Test health
- **#100** — `interview-transcript.test.ts` re-runs every migration 14 times and sits 4s from its timeout.
- `tests/` is flaky at concurrency 4 (a different test each run) — rerun, then run the file alone; never raise the timeout.
- `cptest` is shared across sessions: a mid-run `42P01` on `schema_migrations` means another run reset it.

### Open defects not owned by tracks 1–3
**#105** a chat binding can be created against a torn-down trip — one stale row makes verify permanently red and costs 40s per relay restart · **#103** companion replies containing Hermes's slash surface are dropped · **#78** completed background delegations never delivered · **#37** approval callback logs nothing on success · **#30** approval poller stands down with no relay liveness check · **#31** `multiplex_profiles` template stamp · **#33** PR #29 review residue · **#106**/**#107** (operator-facing: usage telemetry to the fleet monitor, audited password recovery).

### Docs in order and aligned with the code
Part of the goal, not a side effect. The known drift, all verified 2026-09-19:

- `docs/onboarding-mvp-sprint-plan.md:1886-1889` — says the SPA's endpoints are unmounted; `portal.ts` mounts all of them.
- `web/README.md:14-17` — says auth is interface-only; it creates real sessions.
- `control-plane/api/src/app.ts:119` — the service index self-reports `"sprint": 4` and omits every portal route.
- `docs/signup-test-execution-capture (Manual).md:131-144` — seven rows Open/Partial that are all built.
- `docs/onboarding-to-active-plan.md:81-94` — describes the 2026-09-06 deployment; Modern is the front door now.
- `docs/NEXT-TASKS.md` — from 2026-08-08, pre-control-plane, not a live source.
- Sprint 6's own section has **no `— BUILT` markers at all** while §4.5 and Sprint 5 Track 8 do; `sprint-scribe` should bring it level, and record the four-track split from this document into the plan itself.

### The guard: make preflight check it (decided)
A working rule decays; `scripts/preflight-checks.sh` does not. The repo already has
the pattern to copy — `.agents/hermes-sync.tsv` declares repo↔profile pairings and
preflight enforces them, with reviewed exceptions in `.preflight-allow`.

The same shape applies here: a declared mapping from **a status claim in a doc**
to **an executable assertion about the code**, so a doc saying "X is not built"
fails the check once X exists. Prose cannot be verified; a declared assertion can.
Claims that cannot be expressed that way stay human-maintained and are simply not
in the file — better a small enforced set than a large unenforced one.

### Sprint 5 residue
`docs/test-reports/vm-e2e-2026-09-14.md` was never written; step 7 of
`docs/sprint5-closeout-handoff.md` remains "reported done, not confirmed".

### Prerequisite for track 2's ship
`kinerary-cp-release` is merged (`94e572d`) but **not installed on the VM**.
Installing it, and rehearsing `upgrade` and `rollback` with `--dry-run` on the
Mac, has to happen before track 2 ships at sprint end.

---

## Track 5 — Exit gate

Verification, not build. It exercises all four of the other tracks, which is why it is not
folded into any of them — burying it makes the sprint's exit criterion invisible.

- **The two-person demo rehearsal** (`:1512-1520`) — organizer runs signup/interview/confirm/group; super-admin reviews the approval gates and the dashboard; then a deliberate activation rejection, a failed health check and a worker restart before a clean retry.
- **Re-provision `japan-2026` through the full cycle onto a fresh container** (`:1521`) — the headline manual test, the first trip to go end to end with no hand-seeded state. Three constraints: allocate a **new** vmid (do not add it to `PROVISIONER_VMID_MAP`), the existing container and its family supergroup binding are **live** and the binding move is still unbuilt, and keep the old container until the new one verifies.
- **The automated test list** (`:1498-1510`), including the full sandbox E2E of the demo script.
- **Exit gate** (`:1551`): the demo script passes, evidence is retained, cleanup is verified, and the run repeats without manual database changes.

---

## Decisions taken (2026-09-19)

**Cross-cutting**
- Track 1 covers site + MCP + transformer work; transformer items reach live trips via **one pilot trip, then the fleet**.
- The exit gate is **its own fifth track**, not folded into housekeeping.
- Track 2 ships to the **VM**, through `kinerary-cp-release`, with rollback rehearsed first.

**Track 1 — day-of usefulness**
- Priority is **biggest blank first**; done is **the named list ships**, no outcome bar.
- In-site bot: **handoff now, conversation later.** The async message board stays as it is; a synchronous path is separate, later work.
- Group invite link: **capture it at bind time** via `exportChatInviteLink` — accepting that the bot must be made an admin in the group.
- Group addressing: **test what is merged first**, against a stand-in that stamps `expects_reply`, before committing to the cross-repo Hermes change.
- Today before the trip: **both, in phases** — preparation progress first (falls out of 1a), destination tips second (needs 1a item 1).
- Parked: plan-review queue surface; synchronous in-site conversation.

**Track 2 — does the product work**
- Audience is **the business**, so data gathering leads and the dashboard exists to read it.
- First question: **is the assistant actually helping** — the outcome events.
- The live-trip families are **consenting alpha testers**: their data may be read for evaluation, their trip contents must **never** be altered (bug fixes excepted), and a metadata policy that removes the need to know the exact source is to be defined later.
- **Measure the live trip (Nir's) by hand, first**, using the evaluation skill's 8-step workflow. It needs no instrumentation, it gives a real baseline in week one, and it is the design input for the event vocabulary. Re-score the same trip at sprint end.
- Dashboard: **built as specified**, not wrapped around the fleet monitor.
- Accounts: **organizer web signup only.** Member login on provisioned sites stays a standing gap.

**Track 3 — make spend real**
- Where the money goes is **unknown, and measuring it is the point.**
- "Reduce cost" means **metered and attributable**, off personal subscriptions — even if the visible bill rises.
- OpenRouter is **both** comparison substrate and production routing layer, in that order — **and** the bogus `minimax/minimax-m3:free` pin gets fixed first.
- Deliverable is **all three, in order**: harness → recommendation (as a migration plan) → instrumentation.

**Track 4 — housekeeping**
- Goal is five-part: truthful backlog · live trips stop breaking · clean tree · important pending issues fixed · **docs in order and aligned**.
- PR #92: **risk-assess with `regression-planner` before deciding to land or split.**
- The guard against re-fixing is **mechanical** — extend `scripts/preflight-checks.sh`, following the `.agents/hermes-sync.tsv` pattern.
- Weight: **front-loaded, then small.**

## Delta against Sprint 6 as written

**Added** (none of this is in `docs/onboarding-mvp-sprint-plan.md:1438-1552`):
- All of track 1 — the trip-site work, plus four gaps named in the interview that were in no document: group addressing friction, the group join link, the in-site bot surface, and Today before the trip starts.
- All of track 3 — the model cost work, now including production instrumentation and a migration off subscription billing.
- Track 4's audit, the PR risk assessment, the branch sweep, the docs alignment and the preflight guard.
- Organizer web signup, inside track 2.
- Installing `kinerary-cp-release` on the VM, as a prerequisite for track 2's ship.
- **A hand-run experience evaluation of the live trip (Nir's), early and again at sprint end.** The sprint plan schedules the *instrumented* measurement only; it does not ask anyone to measure the one real trip we have with the model that already exists.

**Removed / not built:**
- The expiring activation plan and its distinct approval (`:1464`) — superseded pending scoping, per the plan's own note.
- Member login on provisioned sites — considered and deliberately left as a standing gap.
- The plan-review queue surface, and a synchronous in-site conversation — both parked out of track 1.

**Not selected as a track 4 goal, but still listed under it:** test health
(#100, the `tests/` flakiness at concurrency 4, `cptest` sharing). Worth a second
look, since every other track's verification rests on it.

**Unchanged:** the verification aggregator, the dashboard, the runbook, the
outcome events and derived rates, the daily report, the missing-information
control loop, and the exit gate — all still exactly as the sprint plan states
them.

## Execution — run the tracks in parallel; this is where they collide

The four tracks touch mostly disjoint code, so they are meant to run **at the
same time**, not in sequence. What follows is the small set of places where they
genuinely contend, and the priority to apply when they do.

### Start these four together — nothing they touch overlaps

| Track | First item | Paths it touches | Blocked by |
|---|---|---|---|
| 4 | The already-fixed audit, the docs drift, and the `regression-planner` pass on PR #92 | `docs/`, `gh`, no product code | nothing |
| 2 | The hand-run experience evaluation of the live trip (Nir's) | nothing — it is an evaluation | nothing |
| 3 | Step 0, the `minimax/minimax-m3:free` pin | `profile-templates/kinerary-extract/` | nothing |
| 1 | The destination-info enrichment pass (biggest blank) | `control-plane/worker/.../enrichment.py`, `transformer.py` | nothing |

All four are day-one work with no shared file between them, and two of them
produce the inputs the rest of the sprint plans against.

### Reserve migration numbers before anyone writes one

**This is already broken.** `0054` exists three different ways right now:
`0054_companion_bug_reports.sql` (this branch), `0054_document_registry.sql`
(PR #92, which runs to `0057`), and `0054_organizer_invitations.sql`
(PR #95, to `0055`). The repo has renumbered twice before for exactly this
(`2d91519`, `6922dba`), so it is a known and recurring cost.

Numbering has to be allocated up front, per track, before parallel work starts —
and the two open PRs re-based onto whatever is decided. Otherwise every track
that needs a table pays a renumber, and each renumber invalidates its own testing.

Every new migration still opens with `-- rollback: compatible|breaking — <why>`.

### The real serialisations

1. **PR #92 gates track 3's harness and track 1's #62.** It separates intake,
   itinerary and vision model tasks and ships `0056_model_task_settings.sql` —
   the same surface track 3 step 1 modifies. The `regression-planner` assessment
   is therefore not just housekeeping; it is the unblocker. Do it first.
2. **`integration/sprint-6` must reach `main` before track 1e.** Migration `0053`
   and the group reply-capture code exist only on the integration branch.
3. **The event vocabulary waits on the evaluation.** Track 2's pipeline is the
   largest build in the sprint; starting it before the hand evaluation risks
   building the wrong 18 events. The evaluation takes days, not weeks.
4. **Infrastructure is single-threaded, and code is not.** Track 1's pilot
   re-provision, track 5's `japan-2026` full cycle and track 2's VM ship all
   provision against the same Proxmox, NPM and Cloudflare. They must not overlap
   with each other or with a VM run — check for an active window first. This is
   the one place "parallel" is unsafe rather than merely awkward.
5. **`model-runner.ts` has one owner at a time** — track 3 — and track 2's
   instrumentation consumes what track 3 records rather than adding its own.

### Priority when two things cannot run at once

1. **Whatever unblocks another track.** The #92 assessment, the sprint-6→main
   merge, and migration-number allocation all cost little and release several
   tracks each.
2. **Track 4's audit and docs drift.** Tracks 1 and 3 plan against them; working
   from a stale picture is how the same thing gets fixed twice.
3. **Track 2's events**, because the rates, the daily report and the dashboard
   all read from them and nothing else in that track can start first.
4. **Track 1, biggest blank first.**
5. **Track 3's harness and recommendation.**
6. **Track 5**, last by definition — it verifies the others.

Track 4 stays front-loaded and then small; it should not compete with track 2
once the audit is done.

## How the claims in this file were checked

Every "does not exist" claim above was verified against the tree on 2026-09-19,
not read out of a document. Re-run these before trusting any of it again:

```bash
# verification_evidence exists and has no writer  (track 2)
grep -rn "verification_evidence" --include="*.ts" --include="*.py" --include="*.sql" control-plane/ | grep -v node_modules
#   -> only 0001_foundation.sql:139 and 0005_opaque_id_format.sql:19

# funnel_events emission is 8 sites, all in portal.ts  (track 2)
grep -rn "recordFunnelEvent" control-plane/api/src/

# nothing stamps expects_reply, so the reply-capture window never opens  (track 1e)
git grep -n "expects_reply" -- ':!*test*'

# plan_review runs with no model  (track 3)
grep -n "PLAN_REVIEW" ~/kinerary-deploy/provisioning.env   # -> no match

# add_plan_item has no duplicate guard  (#67, track 1b)
sed -n '595,620p' mcp/mcp.js; sed -n '2300,2330p' server/server.js

# two open PRs both claim #58; #92 claims all of #49-#62  (track 4)
for p in 91 92; do gh pr view $p --json body -q .body | grep -oE '#(4[0-9]|5[0-9]|6[0-9])' | sort -u; done

# 0054 is taken three ways  (track 4, migration numbering)
ls control-plane/db/migrations/ | tail -3
for b in feat/document-intake-sprint6 feat/organizer-invite-links; do
  git ls-tree -r --name-only "$b" control-plane/db/migrations/ | tail -3; done

# branches recorded as uncommitted are merged  (track 4)
for b in fix/organizer-identity-roster fix/group-attachment-followup; do
  git merge-base --is-ancestor "$b" main && echo "$b MERGED"; done
```

When one of these stops matching what this file says, fix this file — and add the
claim to the preflight mapping described under track 4 if it can be expressed as
an assertion.
