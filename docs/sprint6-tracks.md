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
carry-forward (`docs/test-reports/sprint5-closeout-handoff.md:148`), §4.5 enrichment residue,
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

1. **Destination info is blank — BUILT for Health/Money/Communication (2026-09-22, #156);
   Hospitals and Age notes excluded by decision, not deferred (see below).** Health,
   Money, Communication, Hospitals, Age notes are rendered (`trip-web/src/readiness.tsx:26-28,197,208`)
   and never populated. `transformer.py` states the enrichment pass "was never implemented or wired into this provisioner" in `_lookup_known_currency`'s docstring, at `:442` — the `:304-315` cited here was always the wrong location, even before #156 below (that range is the static currency/timezone lookup tables, not the docstring); `enrichment._country_entry` emits only flag/capital/currency/callingCode/emergency.

   **No longer the current state, as of #156 (2026-09-22).** The enrichment pass this bullet describes as missing now exists — `enrichment._enrich_destination_info`, wired into `enrich_config`, reading a cross-trip cache filled by a monthly job in the control-plane API — for Health, Money and Communication; Hospitals stays excluded by the decision below and Age notes is also excluded (see the note after the schema question). `transformer.py`'s docstring at that same location has been corrected to say so. This note only fixes the two false claims (blank, and the citation); **sprint-scribe (2026-09-22): marked BUILT above** — matches the convention this doc's own §4.5 and Sprint 5 Track 8 use (a dated tag on the item, with what was cut named rather than silently dropped). A corresponding `built` row was added to the sprint plan's §4.5 enrichment table (`docs/onboarding-mvp-sprint-plan.md`), alongside its existing venue-link and consular-contact rows.

   **Decided 2026-09-19.** Four things, and the third is what makes this cheap:

   - **Deterministic first, a model only at the gaps.** Facts from APIs as `enrichment.py` already does (countries.dev, Nominatim, Wikipedia, emergencynumberapi — it is deliberately model-free today); prose from a model only where no API can answer. Mark which is which in the data, so the site can show provenance and a wrong model line is traceable to its source.
   - **Hospitals are dropped.** `info.hospitals` stays unrendered. Emergency numbers already come from a real source and are what actually matters in an emergency; a plausible-but-wrong hospital is a failure mode not worth carrying. Health, money and communication stay — they are advisory and lower-stakes.
   - **The content is shared across trips, not built per trip.** The first trip to a country pays for it; every later trip to the same country reads the stored row. **This store already exists**: `control_plane.country_reference` (`db/migrations/0023_country_reference.sql`) was built as exactly this — *"facts that are true of a destination country regardless of which trip is asking"*, filled once by a web search at interview time and *"reused: every later trip to the same pair reads the row instead of searching again"*, read by `enrich_config` at provision time (`worker/__main__.py:281-291`, `enrichment.py:380`). It carries `fetched_at` already. It simply holds nothing but consular contacts today. Extend it rather than building a second cache.

     **The "filled once by a web search at interview time" phrase above describes the ORIGINAL, consular-only design — resolved (#156, 2026-09-22) to NOT extend to Health/Money/Communication.** Those columns depend on no interview answer, and the monthly refresh has to run when no interview session exists at all, so an interview-time MCP tool couldn't perform it; they are instead filled by a timer inside the control-plane API (`destination-info-store.ts`'s `refreshStaleDestinationInfo`, ticked from `server.ts`), with provision time staying a pure cached read — the same read pattern `_enrich_consular` already uses, just not the same write pattern. This was a real fork this doc did not settle (see the "Open schema question" note below for the sibling decision); the write-side reasoning, including why provision-time-only was also ruled out, lives in that module's docstring rather than duplicated here.
   - **Re-verify monthly.** `fetched_at` makes staleness visible and **nothing refreshes it** — there is no job, anywhere, that revisits a `country_reference` row. That refresh is part of this item, not a follow-on. (Built as the timer described just above; a *second*, separate clock — `destination_info_fetched_at` — was needed rather than reusing this one, so that refreshing prose does not silently re-date consular contacts as freshly verified. See the migration comment.)
   - **Granularity: country base with phase overrides.** National facts once; phase-level additions where they genuinely differ.

   **Open schema question to settle first.** `country_reference`'s primary key is
   `(destination_country, home_country)`, because which embassy matters depends
   on the traveler's nationality. Health, money and communication are
   destination-only, so storing them in that table duplicates them once per home
   country and invites the copies to drift apart. Either a second table keyed by
   destination alone, or a deliberate acceptance of the duplication — decide
   before writing the migration, not after.

   **Resolved (Dror, 2026-09-22, on #156): duplication accepted, no second
   table.** A destination-keyed table would be normal-form-correct but adds a
   second store, a second staleness clock and a second join to every read, for
   a table whose row count is "countries people have travelled to". The
   migration computes a destination's info once and fans it out to every
   home-country row sharing that destination in a single `UPDATE` — duplication
   is a storage cost this accepts, never licence to redo the model call per
   pairing. Full reasoning: the header comment on
   `control-plane/db/migrations/20260922120000_destination_info.sql` — linked
   here rather than repeated.

   **Also resolved: Age notes are excluded too**, alongside Hospitals (Dror,
   confirmed 2026-09-22 between the two review rounds on #156, via the dev
   manager). Same reasoning as Hospitals: no deterministic API source exists
   for legal age limits, so an included line would only ever be unverifiable
   model prose about a legal question, shown to families as if it were fact —
   a failure mode not worth carrying, exactly like an invented hospital name.
   Three in-code comments — the module docstring in
   `control-plane/api/src/destination-info.ts`, the comment near `_INFO_LISTS`
   in `control-plane/worker/control_plane_worker/enrichment.py`, and a test
   comment in `control-plane/api/test/destination-info.test.ts` — had called
   this an open question rather than a settled exclusion; fixed in this same
   commit to say so in the past tense, on the same ground as Hospitals.

   **Cost note, for track 3:** this design makes the model spend
   *per-country-per-month* rather than per-trip, which is the difference between
   a cost that grows with customers and one that grows with the world.
2. **No pre-trip tasks** — Readiness reads `config.tasks`; the transformer never emits it. FRAMEWORK feature #8. Undocumented anywhere until now.
3. **No per-phase packing lists — BUILT (2026-09-23), reworked to abstain when unsure (2026-09-25); #162, PR #165 (merge `20f7419`); #167 CLOSED by PR #197 (merge `283ca64`, fix commit `5c78064`).**
   `phase.packing` never emitted; a hardcoded 4-item fallback shows. FRAMEWORK #16.
   **What is built now:** `transformer._derive_phase_packing` emits `phase.packing` — `[{he,en}
   category, {he,en} item]` pairs, the shape `readiness.tsx` reads at `:58` — only when
   `packing_climate.decide()` (`control-plane/worker/control_plane_worker/packing_climate.py`) is sure of
   the place AND of the season in every month the phase covers. The season bucket
   (`season_bucket`: winter "cold" / spring "rainy" / summer "hot" / autumn "moderate") is
   crossed with a small fixed bilingual table (`_PACKING_ITEMS_BY_SEASON`). Deterministic: no
   network, no model. **There is no default hemisphere any more**: the first pass (#165) resolved a
   trip-level hemisphere from the typed destination and defaulted north; that lookup and
   `_KNOWN_COUNTRY_HEMISPHERE` are gone. The owner's rule (quoted in the module): "Seasons and areas have to be
   treated right -- if not sure, better not to say anything than be unreasonable."
   - **Only a named city ever gets a list.** The phase's own names are read; a country is never
     precise enough, and nothing is inherited from the trip's destination (it is used only to reject a
     contradiction, confirm a namesake, or explain an abstention). A phase naming no place the table
     knows ("Stop", "Road trip", an unlisted town or island) gets nothing.
   - A city qualifies only if it is not arid or tropical, has no dry season, and has a real
     winter and summer; then **every month** the phase covers must sit in one season bucket and
     pass that bucket's temperature test with a 0.5 C margin. Otherwise the phase abstains with a
     named reason (`REASONS`: no dates, no destination, unresolved, ambiguous multi-place, conflicts
     with destination, namesake, climate varies by area, shoulder month, spans seasons, tropical,
     arid, mediterranean, summer rain, mild winter, cool summer, subpolar). The reason goes to a log
     line (`transformer.packing_abstained`) and to tests only. The site then shows what it already
     shows for a phase with no `packing`.
   - Namesakes (Perth, Toronto, Naples...) are believed only when the destination or the phase text
     confirms the country. Islands and territories with their own climate are recorded so they
     abstain by name; the UK stays temperate, with the Isles of Scilly as the named exception
     (Dror, 2026-09-25).
   - Consequence: this only ever **removes** packing output relative to what #165 emitted.
   **Still not built (cut, not dropped):** lists for non-temperate regimes (Sydney, Rome, Seoul in
   their good months), a richer season-to-items table, the geocoder-latitude idea (that is #188, the
   shared place resolver), and any measurement of coverage on real destinations. The trip-level
   `config.packing_general` is untouched; it keeps its own frontend fallback. **Remaining scope is
   tracked in #201** — source-check the eight emitting entries within 0.7 C of a threshold before the VM is
   upgraded to a release carrying this; confirm no live trip already carries `phase.packing`; the
   abstention reason not reaching the production log; and an open owner question on autumn and
   spring having no warm ceiling (Tokyo in late September). Also from #201: #162 must not reach
   `main` or a hotfix branch without #197.
4. **No RSVP activities — BUILT (2026-09-23), #169, PR #171 (merge `0bba091`; feature commit `25805f1`).**
   `phase.rsvp_activities` never emitted, so the whole RSVP surface is invisible. FRAMEWORK #11. Corroborated by the live-trip report: *"RSVP/trivia features: unused"*.
   **What shipped:** `transformer.derive_rsvp_activities`, called from `transform_intake`
   beside the anchor-derived days, writes `phases[].rsvp_activities[]` (`{id, title,
   desc?, date?}`) from the **unconfirmed, attraction-typed `travel_anchors`** (read
   through `_ANCHOR_TYPE_MAP`, not a second word list). It is not exclusive with
   `derive_bookings`: the same anchor stays a Bookings row and also becomes a vote. An
   anchor with no date, or a date in no phase, parks on the first phase. The vote id is
   a stable hash (`_stable_id("rsvp", name, parsed date, detail)`), because the `rsvps`
   table keys votes by that string alone and a moving id orphans votes silently. Three
   behaviour-preserving extractions came with it (`_stable_id`, `_first_phase_id`,
   `_anchor_label_text`); `derive_bookings`' `seed_key`s are pinned byte-identical by
   literal-value tests. The site already rendered it (`site/app.js:3215`, `:4362`;
   `trip-web/src/activity-rsvp.ts`).
   **Deliberately NOT built (cut, not dropped):**
   - A **confirmed** attraction is never a vote (it is already happening; Bookings only).
   - Only `attraction`-typed anchors: nothing is voted on from flights, hotels, cars, or
     from `phases[].venues[]` / extracted `days[]` items.
   - `item_uid` is left unset (no day-plan item to link); `activity-rsvp.ts` matches on
     phase + date + exact title instead.
   - The three anchor walks (`derive_days_from_anchors`, `derive_bookings`,
     `derive_rsvp_activities`) are **not** unified into one traversal — a recorded
     carry-forward from #169's review, to be revisited only if a fourth consumer appears.
   - A phase with no such anchor has the key absent, not `[]`; an existing
     `rsvp_activities` on a phase is never overwritten.
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

### 1c-bis. #117 — the interview holds what it is given, and the companion finishes the plan

**Placed in track 1 on 2026-09-20.** Dror's design, and the answer to #114 —
which stays in track 2 as the evidence. This is the build.

**The scoping decision first, because it rules out a whole class of solution:**
*the interviewer does not resolve trip planning.* #114 reads as "the interview
failed to plan"; the answer is not to make it a planner but to make it **hold**
what the organizer gives it and hand planning onward. Anyone working from #114
alone might reach for a planner. They should not.

The flow, in Dror's order: information volunteered mid-question is **captured and
acknowledged** — even when it maps to no open question, which is exactly the case
that fails today; it is **parked in a later-check area** rather than force-fit
into the nearest slot (`travel_anchors: []` is the force-fit failure mode, named
as such); a **judge pass before the end summary** checks coherence, fills gaps
from the parked information, raises conflicts, tells the organizer their
assistant can settle the rest, and lets the interview **finish rather than block
on completeness**; readiness is **recorded onto the companion being created**,
state it is born holding rather than a report; the companion **proactively offers
to help a few minutes after it starts**, deliberately not instantly; and
readiness is **re-rated as the plan fills**, calibrated to how loose the
organizer wants to be.

**Why track 1 rather than track 2.** Its goal is the organizer's experience — the
interview staying a conversation, an incomplete plan reading as a normal state,
the companion building confidence. That is day-of usefulness for the person
holding the phone, before the trip. This track already spans the companion
(1d, 1e) and is not site-only. Track 2's goal is *measurement*, and #114 sits
there because two of its problems are gaps in the missing-information control
loop's model and because a false "answered" is what the outcome events exist to
catch. Problem and solution in different tracks is unusual, so the seam is named
rather than left implicit:

> **Build the shared representation once.** §1/§2's later-check area and #114's
> "not yet ≠ none" are the same representation track 2's control loop needs. Two
> tracks want it; it gets built in one of them, and the other consumes it.

**Two things not to lose, both from kinerary-09:**

- **#114's problem 5 is NOT covered by #117** — a flat `phases` list of unique names cannot hold Tokyo twice. That is a data-model gap, not a conversational one, and #117 is about the organizer's experience. ~~It still needs an owner.~~ **Update 2026-09-25 (Dror): see "Decisions taken (2026-09-25)", item 3 — the "cannot hold Tokyo twice" half was stale, the live defect was a silent overwrite fixed in open PR #199, and the manager owns it.** **Update 2026-09-26: PR #199 merged (`423e1a4`), not deployed; acceptance still owed — see the note under "#114 — the interview cannot hold an organizer thinking out loud" in Track 2.**

  *Corrected 2026-09-20:* an earlier version of this line sent problem 5 to #115 as "the same theme, likely solved together". Both halves were wrong. #115 contains no such observation — it is a **booking-type taxonomy** gap, where a booked train falls through to `"other"` for want of a canonical scheduled-transport type. Three distinct gaps get confused here:

  | | |
  |---|---|
  | #115 | a taxonomy missing a member, so a value falls to `"other"` |
  | #114 problem 5 | a sequence that cannot repeat an element |
  | #112 *(fixed)* | a string concatenated by a caller blind to its contents |

  They share a real class — **the data model cannot express the real world** — and that is worth recording. They are not likely solved together: a booking vocabulary in the transformer plus site rendering, versus phase sequencing. Different files, different concepts, different owners. Problem 5 keeps needing one rather than looking like it has one.
- **§6 — "no need to push" — is the easiest thing here to regress and the hardest to notice.** A companion that nags a deliberately-loose trip toward a full itinerary *looks like it is working*. Its test is in scope and should stay there.

**Lineage**, worth knowing before redesigning any of it: this descends from
2026-08-28 — LLM fallback parsing, carry-forward extraction, summary
reconciliation. §3's judge is the grown-up form of summary reconciliation, which
diffed the spoken summary against stored intake; this also judges coherence and
routes what it cannot resolve. §1 and §2 are what carry-forward extraction always
needed in order to have somewhere to carry information *to*.

**Cadence note:** this is interview and companion work, so like 1e it does not
ship on the trip-site cadence with the rest of track 1.

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

- **Capture the group invite link at bind time** (decided 2026-09-19; **reopened and replaced 2026-09-26, decision 26: the organizer pastes it once through `set_companion_connection`**, so nothing below is being built). `exportChatInviteLink` is implemented at `control-plane/api/src/relay/telegram-api.ts:285-290` and **nothing calls it**. Needs: a column on `telegram_chat_bindings` (none today — `0029`/`0043`/`0053` have no invite field), a call in `bind_chat_to_trip` (`provisioner.py:371-467`), and a path to the site. The site half already exists: `CompanionPanel.tsx:26,62` renders `connection.group_url`, today writable only by hand through MCP `set_companion_connection` (`mcp/mcp.js:276-282`). **Prerequisite:** the bot must be an admin in the group to export a link, which provisioning does not arrange.
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
bot wiring, hero photos — not re-verified in this pass. `docs/onboarding-to-active-plan.md`
is no longer stale on the front-door claim: fixed in place **2026-09-20** (#137,
PR #138) with dated corrections. The citation that used to sit here (`:81-94`)
was wrong regardless of the fix — that range is A1/A2, not the front-door claim
— see Track 4's drift note below for the corrected locations. "Thin phases"
generally (fixed 2026-09-12/13 in `0daf16a`, `078237c`, `f184cd3`, `947aa2d`)
is unaffected.

**Trip-site MCP connector — #227, MERGED, NOT DEPLOYED (2026-09-26), not marked BUILT; PR #228, merge `8f66492`.** Placed on Track 1 by decision 31. Built on `main` as PRs #219 and #220 outside the track plan and live on one real trip (Orlando) from `main` since 2026-09-25; the carry put the connector files (`server/trip-mcp/`, `mcp/README.md`, nginx and provisioning wiring, the rebuilt `site/modern` bundle) on this branch, byte-identical to `main`'s. Off by default (`TRIP_MCP_ENABLED`). Boundary review on the sprint-6 tree: the three invariants hold; lower-severity findings are tracked by the maintainers outside GitHub. **Not BUILT because #227 stays OPEN:** promoting a release that carries it to `available` is a deploy-class action and needs the owner's approval; `retryProvision` must never be run on Orlando while its recorded release differs; `get_ratings` has no test and two comments still describe #191 as unfixed (per #227).

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

**First slice — BUILT (2026-09-25), #177, PR #181 (merge `7d1bdca`).** The relay-side emitter (`control-plane/api/src/analytics/emitter.ts`, `relay-facts.ts`, wired into the relay's dispatch, poller and connector), the `control_plane.assistant_events` table (migration `20260925143012_assistant_events.sql`), the language-neutral contract (`analytics/schemas/tripbot-event.v1.json`, mirrored in `contract.ts`), the writer, a per-trip per-day rollup and `purgeExpiredEvents` (90 days) in `analytics/store.ts`. Metadata only: no text and no identifiers, and the database's CHECKs refuse both. The relay never writes `answered`. **Off by default and not enabled anywhere** (`ASSISTANT_EVENTS_ENABLED=1` turns it on; unset is off). **Not built, still owed by this bullet:** the Hermes plugin (tool-side outcomes, so `answered`/`failed_tool`), the authenticated ingest route, the derived rates, the daily report, the dashboard, scheduling the purge, and enabling it in any deployment. Owner decisions cited from the 2026-09-25 comment on #177: merge dark; metadata stance confirmed for the MVP; the family notice deferred to full production (#186). Preconditions before recording is switched on are listed in that comment (they include #178). Track 2's other bullets below are not marked and remain unbuilt.

- **Zero assistant-side event emission exists.** Greps across `control-plane/api/src/relay/` (15 files), `chat-router.ts`, `runtime-gateway/server.js` and the worker return nothing.
- What exists is **one coarse table**: `control_plane.funnel_events` (`db/migrations/0034_web_portal_addenda.sql:27-44`), a closed 10-name lifecycle vocabulary, emitted from exactly 8 sites, **all in `portal.ts`**. `provisioning_completed` and `interview_confirmed` are in the CHECK constraint and never emitted.
- Sprint 6 needs the **§5 base event envelope** (22 fields, `docs/trip-bot-analytics-and-metrics-design.md:258-292`) with outcome events inside it — grounded / partial / missing-data answers, unanswered group mentions, organizer follow-up requested/answered, post-write verification passed/failed — *"not as a second vocabulary"*. `funnel_events` shares nothing with that vocabulary.
- Then the five derived rates, grouped by trip/phase/day/channel/role/topic; the daily control-plan report; and the missing-information control loop.
- Also routed here from the live-run ledger: **per-user Telegram info-message logging** (`:1351-1353`).
- Sprint 7 keeps the weighted 1–5 scoring and repeated-question reduction.
- **Unfinished-interview measurement is owned here (Dror, 2026-09-25)** — the question people stop at and outcome by duration, `docs/interview-without-an-agent.md` §8b; partial coverage today in `fleet-mcp.mjs` `statistics`/`stalled_interviews`. The sprint plan's Sprint 6.5 WITHDRAWN section, which said it had no owner, now points here.

#### #114 — the interview cannot hold an organizer thinking out loud

**Placed in track 2 on 2026-09-20**, captured from a live manual interview on
`ae397fd` with evidence from `interview_interpretations`
(`sess_3a16921971ce48ea8a1e8c22721974b6`), not recollection. To be solved this
sprint; not a now-fix.

One unprompted Hebrew message carried five facts and a request — Tokyo 5 days,
Hakone 2, equal time in Kyoto and Osaka, three more days back in Tokyo, "we
haven't booked hotels yet", and *"suggest something like this"*. The interpreter
returned **one** proposal: `travel_anchors: []`, evidence "we haven't booked
hotels yet", confidence 0.6. It kept the single negative clause, discarded
everything else including the direct request for help, and asked its next
scripted question.

**Why it belongs to track 2 rather than anywhere else.** This track's question is
"is the assistant actually helping?", and #114 is a precise, evidenced answer:
*no*, in the common case of an organizer who is unsure and says so. It is not a
prompt-tuning problem — a better prompt cannot emit a structure the schema does
not have — so it is not track 3. It is not a regression, so it is not track 4's
housekeeping. And it is not the trip site, so it is not track 1.

More than proximity, it is the **same conversational model** this track's
missing-information control loop (`:1493`) needs. That loop detects a missing
fact and converts it into a focused organizer request. #114 is its mirror image:
the organizer volunteered the facts unprompted *and* made a request, and there is
a representation for neither. Two of its six problems are that model's gaps:

- **no proposal kind for "the organizer asked *us* for something"** — a request addressed to the assistant has nowhere to go and vanishes unacknowledged;
- **"not yet" and "none" are collapsed** — an empty answer at 0.6 confidence may read downstream as *answered*, closing a question the organizer explicitly left open. That is exactly the false "we have this" the outcome events exist to catch, so it is a measurement concern as well as a capture one.

The other four — extraction that slot-fills rather than comprehends, durations
stated as a solvable constraint system, a returning leg that a flat unique-name
`phases` list cannot express, and revision of an earlier answer while a later
question is on screen — are intake-schema work that lands in the same place.

**It is explicitly NOT Slice A or Slice B of #92.** #92 is document intake; this
is the no-document path. They touch `interpret`/`extract` in common and nothing
else, and folding this into work already being carried would hide it.

**Sizing, stated rather than skipped:** track 2 was already the largest of the
five by a wide margin, and this makes it larger. If something in this sprint
gives, this track is where the pressure will show first.

**Worth noting for sequencing, and it is sharper than it looks.** The live
interview that produced #114 was in effect a manual run of the experience
evaluation below — it surfaced a six-part representational failure with zero
instrumentation. But it only did so because **a human was reading the
conversation**. The session's own data showed a *clean run*: every interpretation
succeeded, no `failure_reason`, no stalled turn.

So an outcome-event pipeline derived from the system's own success and failure
signals would have scored that interview as **successful**. That is a design
constraint on this track's event vocabulary, not a footnote: measuring "did the
call succeed" is not measuring "did we understand". Catching #114's class needs
events about what was *not* consumed — how much of a message mapped to
proposals, which clauses were left on the floor, whether a request addressed to
the assistant was recognised at all.

It is also a caution about what the pipeline will never see, and the reason the
hand evaluation leads rather than follows.

**One thing that is NOT true, corrected 2026-09-20.** An earlier version of this
note suggested #112 (the geocoder returning nothing) and #114's returning-leg
problem might share a fix. They do not. `ae397fd` touches five files —
`enrichment.py` query construction, `venue-links.ts`, `poller.ts` and their
tests — and **none of the phases model, the schema or the transformer**
(verified). #112 was the *destination string* being an itinerary and getting
concatenated into a place query, fixed by splitting on commas, de-duplicating
and anchoring on the country tail. #114's problem 5 was described as the *phases list* being
unable to hold Tokyo twice (that half was found stale on 2026-09-25: the transformer already keeps two non-adjacent visits; the live defect was a silent overwrite of an undated first visit, PR #199, since merged 2026-09-26 as `423e1a4`, not deployed). A phases model that expressed a returning leg would
not have fixed #112, and #112's fix does nothing for a returning leg.

The real shared theme is weaker and worth stating only as an observation:
**"where" is represented as flat strings in several places, and callers
concatenate them without being able to see what is already inside.** That is not
a shared fix, and this track should not carry #112-adjacent work on the strength
of it.

**#206 / #205 / #114 return-leg — MERGED, NOT DEPLOYED (2026-09-26), not marked BUILT; PR #199, merge `423e1a4`.** The issue labels put #206 and #205 in track 2; this section had no plan item for them until now (recorded, not assigned by the scribe). What the merged code does (`control-plane/api/src/typed-changes.ts`, `typed-changes-store.ts`, `typed-changes-render.ts`, `interview.ts`, `interpret.ts`, `relay/poller.ts`, migration `20260925180000_intake_pending_changes.sql`): a typed change to a held stop or traveller is proposed, validated, shown to the organizer and applied only after explicit confirmation; removing a stop or traveller warns about confirmed bookings (non-refundable only where the data says so); a return leg is kept as a second stop; a removal with many bookings can be typed; names with Persian, Indic or emoji characters are kept; a preview Telegram refuses can always be cancelled. **Acceptance is owed, so #206, #205 and #114 stay OPEN** (no closing keywords, on purpose; #114's title is broader than the return-leg fix): a walk on the test bot with the owner, the #178 → #217 document walk on a throwaway trip, and the owner's read of the Hebrew strings. **Update 2026-09-26 (second sweep):** the real-model run in English and Hebrew after round 4 is done — 113 of 114 pass, 0 false positives, 0 silent picks, the one non-pass a `BAD_OUTPUT` error with nothing accepted (`docs/test-reports/typed-change-real-model-2026-09-26-after-round4.md`); and #225 items 1, 3 and 5 are merged (see the next paragraph), so they are no longer owed as code. Items 2, 4, 6 stay tracked in #225. Costed plan: `docs/test-reports/regression-plan-2026-09-26-pr199-round3.md`. Related and still open: #209, #214, #216, #198.

**#225 items 1, 3, 5 (PR #230, merge `72c4d69`) and 7, 8, 9 + F-b (PR #234, merge `9f51bf2`) — MERGED, NOT DEPLOYED (2026-09-26), not marked BUILT; #225 stays OPEN.** What the organizer gets: a boundary offer that a follow-up's preview covered comes back once the change is settled, and no typed message goes unanswered when a tap wins the floor (items 1, 3); a change the organizer already saw is no longer dropped because Telegram was briefly busy (item 5); a question or the summary that Telegram refused is retried with a bounded backoff (2, 4, 8, 16, 32, 60, 60 s; 8 attempts) instead of never (item 7); one hung Telegram connection is bounded at 10 s instead of freezing every chat's replies, the interview's and the live companions' (item 8); an unanswered document disagreement that Telegram refuses can no longer block the interview (F-b); a timed-out companion reply is no longer re-sent, where the family could have seen it twice (item 9). Two review rounds each. Regression plans (`docs/test-reports/regression-plan-2026-09-26-pr230-typed-change-pre-deploy.md`, `…-pr234-relay-send-hardening.md`): sufficient to merge, not sufficient to deploy. **Acceptance owed before Release A:** the test-bot walk with the owner (D12–D14), the #178 → #217 document walk on a throwaway trip, the owner's read of the Hebrew strings, and a read of #225's post-deploy log. **Left, tracked in #225:** items 2, 4, 6 and follow-ups 10–26. Reaches families only after an API rebuild and a relay restart.

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
- **Super-admin dashboard** (`:1466`) — **decided: build it as specified, in two slices (read-only first, suspend/retry second; 2026-09-26, decision 23).** Nothing exists today: no UI, no `/v1/admin/*`, no `/v1/jobs` read endpoint, no suspend/retry. The data mostly exists (`jobs`, `funnel_events`, `audit_events`, `release-registry`, `redaction.ts`) with no reader, so the work is a read API plus a UI shell plus the suspend/retry mutations with server-side authorization.
  - Considered and **not** taken: wrapping `.agents/skills/trip-fleet-monitor/fleet-mcp.mjs`, whose eight read-only tools already answer six of the dashboard's eight rows against the live DB. Worth keeping in view as the fallback if the console runs long — and worth reading its queries before writing new ones.
  - Per the goal, the daily control-plan report and the derived rates are the dashboard's primary content; the ops rows (jobs, failures, versions, audit) fill in behind them.
- **Runbook** (`:1476`) — partly satisfied by `kinerary-cp-release upgrade|rollback` (#84, merged `94e572d`), which is not recorded against this bullet.

### Landing page
- `web/` is a real, wired SPA — the plan's note at `:1886-1889` claiming its endpoints are unmounted is **stale**: `control-plane/api/src/portal.ts` mounts all of them (`app.ts:1469`).
- Open: the **organizer-scoped projection decision** (`:1469-1475` + §5 `:1895-1935`) — build it here or defer to the post-MVP web track; the richer trip-card model and the action surface (suspend/retry/re-provision) from `docs/web-control-plane-integration-plan.md` §8.
- Dead weight: six orphaned page files in `web/src/pages/` superseded by `ProductApp.tsx`, and a `web/README.md:14-17` that still says auth is interface-only.

### Account management — **an add to Sprint 6, scoped to organizers** (decided 2026-09-19; **deferred 2026-09-26, decision 24 — nothing below is being built this sprint**)

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

**Step 1b — the harness. — BUILT (2026-09-22), #155/`0caf49d`.** Extended
`control-plane/api/tools/extract-intake-eval.mjs`: per-run and per-label
`usage` (tokens, cost) threaded into both the failure and success JSON lines
and rolled up into the run summary via `model-runner.js`'s own `addUsage`,
flagging `costKindMixed` when a label's runs blend billed and
`api_equivalent` cost rather than silently picking one. `--label` already
existed; only the cost/usage plumbing was missing. Of the two prerequisites
named here: **"stop discarding `payload.usage` in `callOpenRouter`" was
already done** — Step 1 above already covers it (inherited from #92,
verified 2026-09-19), so this bullet was stale on that point before #155
landed too. **Still open:**
recording **which runner/model produced each result** — no column beside
`duration_ms` on `interview_interpretations` (`0048_interview_interpretations.sql`);
no later migration has added one, so historical model comparison stays
impossible until it does. That remains Track 3's own scope, not routed
elsewhere.

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
cross-document invariants, `--runs`/`--concurrency`, per-run JSON with **`ms`,
`attempts` and (Step 1b, shipped) per-run and per-label `usage`** folded through
`model-runner.js`'s own `addUsage`, flagging `costKindMixed` when a run blends
billed and `api_equivalent` calls — and `--scenarios` for private documents that
must not be committed. Model comes from `modelRunnerFromEnv()`, so
**`EXTRACT_MODEL` is already the A/B axis**, and `--label` already exists. The
harness itself is now the cost/quality test set; Step 0's OpenRouter pin and the
missing model/runner column on `interview_interpretations` (see "What blocks
measurement today") are what's left before a comparison run means anything.

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

**Extraction model comparison — recorded 2026-09-26 (PR #236, merge `d1769ee`); a measurement, not a decision.** `docs/test-reports/model-comparison-extract-2026-09-26.md` compares four models on 28 calls each; it labels Claude Sonnet 5 as what production runs today (decision 13). Its recommendation, as written there: keep Claude Sonnet 5 and meter it; Gemini 3.8 Flash had the only perfect score (272/272) but a 182 s maximum call against the 120 s production limit; GPT-5.4 mini fabricated dates. The choice is the owner's and is not made here; the numbers support the current configuration and do not change it.

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

### Slice A is BUILT (2026-09-20) — committed, not merged, not pushed

`fix/92-slice-a`, eight commits on **`97582b6` — the locked Sprint 6 baseline** —
30 files, +3864/−316. **Full control-plane suite: 1465 tests, 1459 pass, 0 fail,
0 cancelled, 6 skipped**, against a private database (`cptest_92a`, never bare
`cptest`). `preflight-checks.sh --all` clean, typecheck clean.

That 1465 is the baseline's own 1374 plus Slice A's 91 new tests, which is worth
stating because the baseline record says 1374: the number moves when this lands,
and it moves for a reason rather than by drift.

The sprint lock stands; nothing is merged to `integration/sprint-6`, and nothing
is pushed.

`fix/92-slice-b` preserves the rest of #92 whole, plus one commit renaming its
four migrations to `YYYYMMDDHHMMSS_` and giving each a `-- rollback: compatible`
header — none of the four has reached production, so renaming is safe here and
only here.

**Three things the unbundling found, all of which a textual merge would have
taken silently.** They are the argument for slicing rather than landing whole:

| | |
|---|---|
| `<TASK>_EFFORT` | sprint-6 added it (47c99eb) where `modelRunnerFromEnv` built its own runners; #92 moved that construction to `runnerForBinding` from a base predating it. Merged textually, every claude call takes its effort from whatever the process's HOME holds — the 143s-against-60s failure of 2026-09-16, which raises no error |
| Two correction mechanisms | sprint-6's `allowCorrections` (a person retypes) and #92's `held` reconciliation (a document adds) edit the same function, and **neither branch's tests covered the other's feature**. They are exact complements and both are kept; which applies is decided by which field the caller passed |
| Hard rule 6 | #92's `model-runner.ts` named this deployment's credential path in a doc comment. Preflight refused the commit — the rule catching code that arrived from a branch older than the rule |

**A0 is as resolved as it can be while #91 is open.** #91 holds #58's real
isolation (env allowlist, `--ignore-user-config`) and has not landed, so
`codexIsolationProblem` ships present-but-unwired: `CODEX_ISOLATION_ARGS` *is*
applied to every codex call, but the startup check that this machine's codex
knows those feature names lives in `relay/server.ts`, which is Slice B. Written
into the function's own comment, because the alternative is a reader taking the
refusal as present. **Do not read #92 as closing #58.**

**#62 is CLOSED** (verified 2026-09-20), and the prompt reconciliation with #109
landed in Slice A — with **"trains" deliberately dropped**. `_ANCHOR_TYPE_MAP`
maps onto exactly `{flight, hotel, car, attraction, other}` with no rail member
and `.get(type, "other")` catching the rest, so asking organizers for trains
collects them and files every one as `"other"` — #115's shape. The canonical
type comes first or the word does not go in.

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
- **CI red since #192 — first cause MERGED (2026-09-26), PR #224, merge `5a92aae`; #223 stays OPEN.** Test-only: the super-admin `/model … codex:` test no longer needs a `codex` on the host (`control-plane/api/test/relay-dispatch.test.ts`), and two tests pin that #192's guard refuses an unverifiable Codex. Not marked BUILT: the second cause (`EADDRINUSE :::38202` in the Kinerary suite) is left open by decision 15. This is a listed item under test health, which the section below records as not selected as a track 4 goal; #223 itself carries the `track:4` label. Not assigned here.
- **#223 cause 2 — MITIGATED, NOT SHOWN FIXED (2026-09-26), PR #231, merge `035be91`; #223 stays OPEN.** The test ports moved from 38xxx to 28xxx, below the Linux ephemeral range, with a guard (`tests/helpers/ports.js`). The collision theory was not reproduced, so this is not marked BUILT: #223 stays open until the Kinerary suite has been green over time. **PR #233 (merge `0f2d19f`)** raised the TypeScript API CI job's wall-clock limit from 15 to 30 minutes after a docs-only PR's run was cancelled at 15 with no failing test. Track 4 owns both (decision 30). Also opened: #238 (a separate nightly stack; label `track:4`).

### Open defects not owned by tracks 1–3
**#172 — BUILT (2026-09-25), CLOSED on GitHub** (trip config is served through an allow-list instead of `sanitizeConfig()`'s deny-list: `shared/config-visibility.js`, `shared/allow-list.js`, `server/server.js`, `server/living-journey.js`, `shared/agent-schema.js`; PR #196, merge `3cd2191`, fix commit `0bcf763`). **Changes nothing anyone sees until a release carrying it is promoted to `available` and each existing trip is redeployed by hand** (new trips get it from the promoted release; existing trips keep their pinned release). **Left, tracked in #200:** redeploy decisions for live trips (CT200 `trip-usa2026` would lose 40 fields of 12 kinds; the Japan trip after 3 Oct; the Orlando trip's dates unknown), who reads the dropped-field warnings (Dror's direction: the fleet monitor reads `scope:'config'`), and small defects found by the audit. · **#153 and #58 — BUILT (2026-09-25), both CLOSED on GitHub** (every model subprocess — Codex, Claude, Hermes — runs with an allow-listed environment, `model-runner.ts`; the Codex isolation check is exercised on the `/model` path; PR #192, merge `3b623d6`, fix commit `dbe2c4a`). This is the change Task zero's "Land #91 first for #58" was waiting for. **Left, tracked in #202:** the `/model codex` probe timeout and memoising a passing probe, whether the VM's relay should carry explicit `*_EFFORT`, quality of Mac document reading at `medium` (never measured), and runbook drift on `EXTRACT_INTAKE_*`. A running relay picks this up only after the API is rebuilt and restarted. · **#105 — BUILT (2026-09-25), CLOSED on GitHub** (a chat binding against a torn-down trip; five guards: group link, operator invitation, gateway wait and trip list via PR #174/#176, `/switch` via PR #180, merge `70371d6`; teardown revokes live group tokens, #175). **Left, deliberate:** a narrow unlocked race between the ownership check and the insert, documented in the code (a lock caused #175's deadlock); candidate follow-ups named in the #105 closing comment are not filed. · **#103** companion replies containing Hermes's slash surface are dropped · **#78** completed background delegations never delivered · **#37** approval callback logs nothing on success · **#30** approval poller stands down with no relay liveness check · **#31** `multiplex_profiles` template stamp · **#33** PR #29 review residue · **#106**/**#107** (operator-facing: usage telemetry to the fleet monitor, audited password recovery).

**#191, #194 and #208 — BUILT (2026-09-25), all three CLOSED on GitHub** (trip-site routes that needed no login stop serving the family; PR #211, merge `513d42e`, source commit `08121c0`, rebuilt bundle `689116a`). What the merged code does: the gallery and social reads (`/api/photos`, `/api/ratings`, comments, RSVPs, reactions, done-tasks, `/api/album-share/:phase`) require login; another member's record carries only `username`, `name`, `name_en`, `color` and `avatar_file` (`server/public-user.js`, an allow-list); photo files are served behind one-hour signed links or ordinary authentication, contained inside the uploads directory and with protective headers (`server/file-token.js`, `server/server.js`); `/photo/:id` needs an unguessable, non-expiring signed link; the logo route serves only image files that resolve inside the trip directory; uploads accept images only and store a generated name (SVG and HTML are refused, which closed a stored script injection between members); the anonymous trivia stream no longer carries `family`. The tracked `site/modern` bundle was rebuilt in the same PR (#208). **Changes nothing on a running site until a release carrying it is promoted to `available` and each existing trip is redeployed by hand** (see "Decisions taken (2026-09-25)", items 9–11). **Left, tracked:** #212 (link caching, a file-route allow-list, release safeguards, a companion recap document), #213 (classic site: a participant's name or colour runs as script in every signed-in member's browser), #210 (who may mint public album links, smaller inconsistencies), #207 (`POST /api/lost-found` accepts unauthenticated writes with no rate limit). A gallery tab left open past an hour shows broken images until reload (the lifetime is tunable in `server/file-token.js`).

**#178 — BUILT (2026-09-25), CLOSED on GitHub; #179 — PARTLY BUILT, stays OPEN** (PR #215, merge `d5e7fb1`, fix commit `3d32244`; `control-plane/api/src/relay/dispatch.ts`, `intake-copy.ts`). #178: a confirmed organizer's private-chat document now reaches the relay's read-and-propose path (the router had asked the wire event for media before any was attached, so the route never fired). #179 core: while an announced companion is unreachable, an unaddressed family-group message gets no reply, an addressed one gets a single generic line per chat per ten minutes (in memory, per relay process), and a DM gets the same wording; a trip whose assistant was never announced keeps "still finishing". **Left, tracked:** #187 (tell the organizer once per outage, recover, escalate to the monitor) continues and #179 stays open; #217 (follow-ups from the review, listed there). **Reaches families only after an API rebuild and a relay restart. The document-correction path behind #178 has never run end to end, and is reachable for the first time by this change: it must be walked on a throwaway trip before sprint 6 reaches the VM (#217).** Approving a proposal re-provisions the organizer's site, so whether live organizers mid-trip should get this in sprint 6 at all, or have it ship dark, is an open question recorded on #217.

### Docs in order and aligned with the code
Part of the goal, not a side effect. The known drift, all verified 2026-09-19:

- `docs/onboarding-mvp-sprint-plan.md:1886-1889` — says the SPA's endpoints are unmounted; `portal.ts` mounts all of them.
- `web/README.md:14-17` — says auth is interface-only; it creates real sessions.
- `control-plane/api/src/app.ts:119` — the service index self-reports `"sprint": 4` and omits every portal route.
- `docs/signup-test-execution-capture (Manual).md:131-144` — seven rows Open/Partial that are all built.
- `docs/onboarding-to-active-plan.md` — **fixed 2026-09-20** (#137, PR #138). Four
  present-tense structures now carry dated corrections in place: §1's table row
  (`:69`), §2's "Update — 2026-09-07" (`:26-29`), §3's Phase B intro + B1 bullet
  (`:135-151`), §6's next-actions list (`:215-223`). Two-sided, not a blanket
  claim: Modern is the front door for trips provisioned since 2026-09-09
  (`a2e51d1`); trips provisioned earlier keep what they had. Previously miscited
  here as `:81-94` — that range is A1/A2, unrelated.

  **Second round, 2026-09-22** (#157, `55fd3ea`), same file. §2's Phase A
  (A1–A4) and §6's order items 1/2/4 had the same shape as the first round —
  shipped work still presented as open — plus line 93's "a family could use
  that site today" read as an unqualified present-tense claim. All four Phase
  A items, independently re-verified against commit ancestry rather than the
  earlier dry-run report, now carry dated "(implemented, …)" annotations
  naming where the shipped mechanism diverged from what the document
  proposed (A2: a worker log-level fix, not the skip's own level; A3: the
  SSH-bridge fork, not the tooled-worker recommendation
  `companion-install-plan.md` still names). §6 item 4 (Phase D) is annotated
  **not done**, on its own evidence — neither round had asserted a status for
  it before. `docs/companion-install-plan.md` also picked up an annotation
  (found during A3's re-check) that the SSH-bridge fork shipped, not its own
  "Recommendation: the tooled worker".
- Sprint 6's own section previously had **no `— BUILT` markers at all** while
  §4.5 and Sprint 5 Track 8 did. The four-track split itself was already
  recorded in the plan (`onboarding-mvp-sprint-plan.md:1459-1483`, table +
  routing note, landed in this same commit that first wrote this bullet,
  `3fdacba`, 2026-09-19) — that half of this ask was done before it was
  written down as outstanding. **sprint-scribe (2026-09-22):** added
  item-level `— BUILT` markers for what has shipped since — Track 1a item 1
  (destination info) and Track 3 Step 1b (the harness's cost/usage) above,
  plus a new `built` row in the plan's §4.5 table. The rest of this file's
  items (Track 1a items 2–6, 1b, 1c, 1c-bis, 1d, 1e; Track 4's own Slice A,
  already dated separately at "Slice A is BUILT (2026-09-20)") get their
  markers as each ships, not in this pass.

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
`docs/test-reports/sprint5-closeout-handoff.md` remains "reported done, not confirmed".

### Prerequisite for track 2's ship
`kinerary-cp-release` is merged (`94e572d`) but **not installed on the VM**.
Installing it, and rehearsing `upgrade` and `rollback` with `--dry-run` on the
Mac, has to happen before track 2 ships at sprint end.

---

## Track 5 — Exit gate

Verification, not build. It exercises all four of the other tracks, which is why it is not
folded into any of them — burying it makes the sprint's exit criterion invisible.

- **The two-person demo rehearsal** (`:1512-1520`) — organizer runs signup/interview/confirm/group; super-admin reviews the approval gates and the dashboard; then a deliberate ~~activation rejection~~ *(dropped 2026-09-26, decision 27: activation is superseded)*, a failed health check and a worker restart before a clean retry.
- **Re-provision `japan-2026` through the full cycle onto a fresh container** (`:1521`) — **replaced 2026-09-26 (decision 27) by a full-cycle run of the `multi` or `manual` scenario on a fresh container; the constraints below are kept as history** — the headline manual test, the first trip to go end to end with no hand-seeded state. Three constraints: allocate a **new** vmid (do not add it to `PROVISIONER_VMID_MAP`), the existing container and its family supergroup binding are **live** and the binding move is still unbuilt, and keep the old container until the new one verifies.
- **The automated test list** (`:1498-1510`), including the full sandbox E2E of the demo script.
- **Exit gate** (`:1551`): the demo script passes, evidence is retained, cleanup is verified, and the run repeats without manual database changes.
- **Nightly automated end-to-end (decision 27) — script MERGED (2026-09-26), PR #237, merge `f1ba7b4`; NOT SCHEDULED, not marked BUILT.** The script deploys the latest leading branch to staging, walks one trip and tears it down (`chore(process): nightly e2e`); its guards fail closed and a lock left by a dead run is taken over. The schedule and the VM guard wait on Dror. #238 (a separate nightly stack) is open.

---

## Decisions taken (2026-09-19)

**Cross-cutting**
- Track 1 covers site + MCP + transformer work; transformer items reach live trips via **one pilot trip, then the fleet** *(the pilot phase was dropped 2026-09-26, decision 26)*.
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

## Decisions taken (2026-09-25)

All from Dror, 2026-09-25, recorded as given. Where a reason was not given, none is written.

1. **#117's pre-summary judge stays in Sprint 6, to be designed together with an offline judge of whole interview transcripts (#198)** — the offline judge looks for data missed or given late that could be added or changed, so a chronic or plan-less interviewer improves. The pair gets a discussion of its own before anything is built. **Track 2 owns the pair** (Dror, 2026-09-25) — the pre-summary judge of #117 §3 moves with it, though #117 as a whole was placed in track 1 (1c-bis). The rest of #117 (§1 capture-and-acknowledge, §2 the later-check area, the companion that finishes the plan) was not part of that decision and stays where 1c-bis puts it.
2. **Measuring unfinished interviews (`docs/interview-without-an-agent.md` §8b) is owned by Track 2** (see the data-gathering section above).
3. **#114 problem 5:** the "cannot hold Tokyo twice" half was stale (the transformer already keeps two non-adjacent visits). The live defect was a silent overwrite of an undated first visit, fixed in **open PR #199** (not merged; under integration review). The manager owns it. Problems 1–4 and 6 stay answered by #117.
4. **#159 is folded into #188** (the shared place resolver: resolve each phase's location once, with confidence, and abstain when unsure). #159 stays open until #188 shows the requirement.
5. **Packing:** the UK stays temperate, with the Isles of Scilly as the named exception (already in #197; see 1a item 3).
6. **#190 (release channels and per-trip version pinning) — the "crown jewel"** is an organizer's own spin-off, deployed only for their trip, from which the product learns. It has a concept document, `docs/future/release-channels-and-organizer-spinoffs.md` (uncommitted as of this entry). **Nothing in it is scheduled beyond slice 1 (#127 option 1).**
7. **Deferred by the owner until he decides:** #110, #125, #130.
8. **Hermes upgrade (#189): Mac first, VM second, after confirming.** Read-only version and release-notes findings are posted on the issue.
9. **`/photo/:id` is open to everyone in the group, through an unguessable link** — a non-expiring signed capability link handed out only by the authenticated photo listing (PR #211). (Dror, 2026-09-25)
10. **The tracked `site/modern` bundle is rebuilt before a release is promoted** (#208). It was done in the same PR as the change (#211, commit `689116a`). (Dror, 2026-09-25)
11. **The two live trips are redeployed only after they end** — Orlando after 1 Oct, Japan after 3 Oct — **and the fleet monitor reads the config warnings** (the dropped-field warnings of #172; see #200). (Dror, 2026-09-25)
12. **CT200 (`trip-usa2026`) is legacy and is ignored.** (Dror, 2026-09-25)
13. **Documents are read with Claude, as deployed.** (Dror, 2026-09-25)
14. **The correction contract for typed changes to the interview's held answers is the owner's, in #206: propose, validate, confirm, then apply.** Its answers were reviewed by the owner on 2026-09-25 ("if I didn't address a number assume it is fine"), with **items 3 and 4 amended: removing a stop, or a traveller, warns about bookings.** Removing a stop takes its own days and venues, and the confirmation names everything that goes with it; if a booking with a confirmation sits inside it, the user is alerted, and "non-refundable / cannot be cancelled" is said only where the data says so; no confirmed bookings, no extra warning. Removing a traveller follows the same rule; a name change is an update, not remove-plus-add. Built so far on **PR #199, a draft, not merged** (slices 1–3 committed; the real-model run in English and Hebrew is still owed); #205 is addressed by that PR, not fixed. Related, open: #209 (capture cancellation terms and passenger names at extraction), #214 (a document upload can bring back a removed stop), #216 (typed corrections to bookings still merge silently), #198 (the offline judge; Track 2 owns it, with the pre-summary judge, per item 1). (Dror, 2026-09-25)

## Decisions taken (2026-09-26)

All from Dror, 2026-09-26, recorded as given. Where a reason was not given, none is written.

15. **The `Control plane` CI workflow has been red on `integration/sprint-6` since #192 merged (2026-09-25); #204, #211, #215 and #218 merged onto that red base, each judged on green local suites (issue #223, which is open).** Two causes were found.
    - **Cause 1 — decided: fix it first, before #199, as its own test-only PR.** The super-admin test "switches a task's model from their own DM" (`test/relay-dispatch.test.ts`) runs `/model extract_intake codex:gpt-5.6-luna`. Since #192 the handler runs the real Codex isolation probe and refuses an unverifiable Codex; the CI runner has no `codex` and the local Mac does, so every local run passed. The fix is **PR #224** (`fix/223-model-codex-test-host-independent`, commit `7531ec6`, "the /model codex test no longer needs a codex on the host"); all seven checks were green on the PR on 2026-09-26, including TypeScript API. It is open, not merged.
    - **Cause 2 — decided: leave open, as a follow-up after #199; #223 stays open for it.** `EADDRINUSE :::38202` in the `Kinerary suite` job (`tests/helpers/ports.js`, `companionConversation`). It is 1 of the last 15 red runs, and only one test file uses that port. The working theory is that every 38xxx test port sits inside the Linux runner's ephemeral range (32768–60999); it is **unproven and not reproducible on macOS**. **Update 2026-09-26: decision 38 chose the renumber (PR #231).** Options on the table when this was written, neither chosen: renumber `tests/helpers/ports.js` below 32768 (about 45 entries; touches `control-plane/api/test/group-document-to-plan.integration.test.ts` through `PORTS`, and the macOS reasoning in CLAUDE.md), or retry the bind on `EADDRINUSE` in `tests/helpers/server.js` (smaller, but masks the cause). Reason for leaving it open: not recorded beyond the ordering "after #199" — ask Dror. (Dror, 2026-09-26)

16. **#199 round 4 — four behaviours accepted as built.** Round 4 is commit `c9b86ea` on `fix/114-return-leg-marker`: **local, not pushed** (the push waits for #224 to merge, so that #199's CI runs on a base that includes the fix; PR #199's head on GitHub is still `f29b4ef`, still a draft, with TypeScript API red). Behaviours accepted:
    - (a) A bare yes/no goes to a waiting change even when it was meant for another interview question. This is round 3's behaviour, kept, and now pinned by call-count assertions (the round-3 regression plan found it unpinned).
    - (b) A typed yes **or** no re-shows a version the organizer never saw and acts on nothing. Alternative rejected by the developer: keep "no" as cancel and reword the string — it would cancel a merged change the organizer has not seen, against round 3's principle that nothing happens to a change the organizer has not seen. (The rejection is the developer's reasoning, taken from the hand-back; Dror accepted the outcome.)
    - (c) A "yes" to a preview that could not be sent keeps it waiting; only "no" or Confirm drops it.
    - (d) In the load race the organizer gets the tap's next question and then the new preview.

    Gates given: an Opus re-audit, **CLEAN for merge**; a regression-planner verdict, **"sufficient to merge once TypeScript API passes on the final merge ref; not sufficient to deploy"**. That is consistent with the round-3 plan (`docs/test-reports/regression-plan-2026-09-26-pr199-round3.md`), which reached the same merge/deploy split at `f29b4ef` and named the full `control-plane/api` suite on the merged tree as the unmet gate. Its deploy conditions still stand and are not lifted by round 4: the real-model run in English and Hebrew, the walk on a throwaway Mac trip, the owner's Hebrew read, and the five read-only fleet probes. (Dror, 2026-09-26)

17. **#199's smaller audit items go to one follow-up issue, #225 (open): merge #199 as is; items 1, 3 and 5 are fixed before Sprint 6 reaches the VM; items 2, 4 and 6 stay tracked.** Item 1: the floor retake loses a displaced boundary offer. Item 3: other messages can lose the floor to a concurrent tap and get no reply. Item 5: a transient Telegram failure (a rate limit) is treated as permanent and drops a change the organizer had seen. Item 2: the retake can send the same preview twice. Item 4: a No between a follow-up's merge and its preview cancels the unseen merge. Item 6: what a bare "no" does when it was meant for a different yes/no question (this is decision 16(a), accepted; tracked so the first real interview is watched). #225 also lists what is owed before any deploy of #199. (Dror, 2026-09-26)

18. **The trip-site MCP connector is carried to `integration/sprint-6` by the lead session (Claude), after #224 and #199, under the regular approval** — integrator, an explicit regression-planner, boundary-reviewer on the sprint-6 tree, then gate 1 and gate 2. This is Dror's direct answer on 2026-09-26. Earlier statements that he would prepare that PR himself were relayed second-hand and are superseded. The connector was built on `main` as PRs #219 then #220, outside the track plan. **Unowned gap, for the manager to put to Dror: it is on no track and has no GitHub issue.** No track is assigned here. Its seven decisions of 2026-09-25 (source: `sprint6-handover-2026-09-25-trip-mcp-session.md` §4, "Decisions made today", the trip-mcp session; not otherwise in this file or in an issue) are recorded below, dated 2026-09-25:
    1. **Ownership:** requested by Dror directly and built on `main`, outside the Sprint 6 track plan; nobody in Sprint 6 owns it, and it has no issue (see the gap above).
    2. **Access model** (Dror, after weighing four options): anyone on the trip may connect. Organizers read and write, members read-only, and a member's assistant sees the same as the site shows that member (group-visible needs, booking codes and PINs included). Only Telegram id, age and email of others are stripped. "Don't narrow this without asking." *(Corrected 2026-09-26, decision 32: the stripping of age holds for RSVP and comment rows only; `get_config` shows age as the site does. The rule "same as the site, never more" stands.)*
    3. **#211 is not to be ported onto the running Orlando trip now** — Dror: "I do not want to add more on the running trip". Revisit after it ends (1 Oct). Already implied by items 9–11 above (#211's release reaches a trip only by a hand redeploy, and the two live trips are redeployed only after they end).
    4. **Rollout scope:** Orlando only; timing "now", mid-trip, knowingly; the 12–24 h soak was skipped at Dror's choice. Item 11 above says the live trips are redeployed only after they end; whether this rollout squares with it is not settled by either source — for Dror.
    5. **Merge order:** #219 then #220, not stacked; Dror declined a rebase.
    6. **The ChatGPT button** points to `https://chatgpt.com/settings/plugins-settings` (Dror found it).
    7. **Scopes only narrow:** a demoted organizer's connection becomes read-only permanently.

    Items 1, 2, 4–7 are not implied by items 9–12. Reasons were given only where quoted. (Dror, 2026-09-26 for the carry; 2026-09-25 for the seven)

19. **Model for the lead seat: stay on Sonnet 5**, with judgment calls (consult, regression-planner, boundary-reviewer, the re-audit) on Opus. Consistent with `docs/agent-team-plan.md`'s role table. (Dror, 2026-09-26)

20. **Process: feature-branch commits and pushes are not prompts; the merge into the leading branch is.** Recorded in full as decision 11 of `docs/agent-team-plan.md`, implemented in CLAUDE.md ("MVP phase", item 3), the hook and three roles by PR #226 (open when this was written). The *leading branch* is `integration/sprint-6` and the *production branch* is `main`; neither is exempted. Narrowed with it, all agreed: the per-PR regression plan only for migration, auth/boundary and relay-behaviour PRs; green CI on the merge ref as the merged-tree evidence when the merge is clean, no file overlaps and no security path is touched; daily sweeps; at most two review rounds per PR; a test database per lane. Form (b) was chosen over (a), one approval covering commit, push and merge. (Dror, 2026-09-26)

Decisions 21–28 are the owner's answers to the section-B interview of 2026-09-26. Each was picked from the options put to him; the alternatives are named where they matter.

21. **Track 2 is built in parallel, not in a chain: the rates and the daily report are queries over the existing `assistant_events` table, built against fixtures beside the collector.** The authenticated ingest route waits for the collector. Alternatives not taken: collector first, and relay-only for Sprint 6. **A correction the lead made the same day, after the pick:** it was put to him that three of the five rates would wait for the collector. Counting against the event contract (`control-plane/api/src/analytics/contract.ts`; "the relay never claims `answered`"), it is **four**: only the response rate can be computed from relay events; grounded-answer, missing-data, traveler self-service and post-write trust need the assistant-side signal. The pick stands, and the collector is therefore on the critical path for most of the report and starts in wave 1. Where the collector lives (this repository's Hermes profile templates, or the Hermes runtime) has not been scoped; that is the first task of its lane. Until it lands, those four are shown as "not measured yet", which the sprint plan's own tests already require (an empty report, never a fabricated rate). (Dror, 2026-09-26)

22. **The missing-information control loop is folded into #117's later-check representation and cut for Sprint 6 to: detect a missing fact, record it, and show the top missing items in the daily report.** The focused organizer request and tracking whether it was fulfilled move to the next sprint. Alternatives not taken: all three parts as specified, and the whole loop deferred. (Dror, 2026-09-26)

23. **The super-admin dashboard is built in two slices.** Slice 1 is read-only: `/v1/admin/*` over jobs, funnel, versions, redacted failures, audit and the report, plus one page behind an operator allow-list, reusing the fleet monitor's queries. Slice 2 is suspend/retry, the only part that needs boundary review and server-side authorization. "Built as specified" (2026-09-19) is kept; only the order changes. (Dror, 2026-09-26)

24. **Organizer email/password signup is deferred; Google and operator invitations stay the ways in.** No email sender exists anywhere in the control plane, and register, verify and forgot-password all need one; register without verification would break the account-claiming invariant in CLAUDE.md. This reverses the 2026-09-19 add to Sprint 6. (Dror, 2026-09-26)

25. **The judge pair is sequenced: the offline judge (#198) first, the pre-summary judge of #117 last and time-boxed.** This replaces "a discussion of its own before anything is built" (decision 1 above) with a short decision now. Alternatives not taken: the discussion first, and the offline judge alone this sprint. (Dror, 2026-09-26)

26. **Track 1: the "pilot trip, then the fleet" phase is dropped** (the throwaway end-to-end trip is the pilot; new trips get the change from the promoted release and existing trips keep their pinned release), **and 1d's group link is captured by the organizer pasting it once** through `set_companion_connection`, which already exists. This reopens and replaces the 2026-09-19 decisions "transformer items via one pilot trip, then the fleet" and "capture the invite link at bind time"; no `exportChatInviteLink` call, no new column, and no bot-admin step in provisioning. (Dror, 2026-09-26)

27. **Exit gate: `japan-2026` is replaced by a full-cycle run of the `multi` or `manual` scenario on a fresh container; the activation tests are dropped; the automated end-to-end runs nightly on the Mac.** The `japan-2026` re-provision (2026-09-02) collided with the live trip's slug and dates, and its purpose, a run with no hand-seeded state, is what any full-cycle run proves; replacing it also removes the 3 Oct floor. Activation approval replay/expiry and the activation-rejection rehearsal step go, because the activation design is superseded and is not being built; the failed health check and the worker restart before a clean retry stay. The nightly run provisions on the shared Proxmox, NPM and Cloudflare, so it skips any night with a VM run. (Dror, 2026-09-26)

28. **Two releases; Release A is early and control-plane only.** Release A ships the control-plane and relay fixes merged so far **before 3 Oct, without redeploying any trip site**; Release B carries Track 2 and the exit gate. Dror chose this over the lead's recommendation, which was Release A after both live trips end (about 5–8 Oct). It respects the 2026-09-25 rule that live trips are redeployed only after they end (no trip site changes), but the VM serves a real organizer and the live trips' companions route through its relay, so a control-plane upgrade does reach them. **Conditions the lead proposes for Release A, not yet agreed:** a sprint-mode regression plan for the exact commit; the walks already owed before the VM (the organizer document route, #217; #225 items 1, 3 and 5; #199's real-model run in English and Hebrew; the owner's Hebrew read; the five read-only fleet probes) run in one throwaway-trip session; `kinerary-cp-release upgrade --dry-run` first, with a snapshot and a rehearsed rollback; and a window away from the live trips' active hours. (Dror, 2026-09-26)

Decisions 29–31 were taken in the lead session's conversation (sprint-6-integration-ba): Dror answered one multiple-choice question, "Accept all three", to three recommendations the lead put to him. The reasons in the recommendations were the lead's (issue labels; #223 carries `track:4`), not his, so none is recorded as his. They were first written into this file by the process session (sprint-6-integration-3d), relayed from that conversation.

29. **Typed changes to held answers (#206, #205, #114) belong to Track 2**, as their labels say. (Dror, 2026-09-26, relayed)
30. **Track 4 formally owns CI and test health; the port-collision fix (#223 cause 2) is scheduled after the trip-site connector carry.** This settles decision 15's open ordering. (Dror, 2026-09-26, relayed)
31. **The trip-site connector gets a GitHub issue on Track 1 (trip UI/UX).** This closes the "unowned gap" named in decision 18. Filed as #227; its carry onto this branch is PR #228. (Dror, 2026-09-26, relayed)

Decisions 32–34 were taken in the lead session's conversation on 2026-09-26 and are recorded by the lead.

32. **D1 — a member's assistant sees the same as the site shows that member, never more.** The connector's `get_config`, lost-and-found list and bookings are identical to the site's; RSVP and comment rows carry less (no `avatar_file`). That includes other participants' age, family and group-visible needs, emergency-contact and accommodation phone numbers, and a lost-and-found reporter's name and phone (`POST /api/lost-found` needs no sign-in, so the reporter need not be on the trip). No tool returns another person's Telegram id or Google email (boundary review of the carry tree, live requests, 2026-09-26). **This corrects decision 18, sub-decision 2:** "only Telegram id, age and email of others are stripped" holds for RSVP and comment rows only; `get_config` shows age as the site does. `mcp/README.md` and `FRAMEWORK.md` are corrected in PR #228. The owner chose "accept 'same as the site'" over stripping fields; no reason beyond that was given. (Dror, 2026-09-26)
33. **Sprint 6 is not merged to `main`; only documentation goes.** Asked what to do with PR #222 (titled "docs: collect test reports…" but with the whole sprint branch as its head, conflicting with `main` in 7 files), Dror answered "Sprint 6 is not ready to be merged to main yet. Cherry pick only the docs", and chose "all test reports" as the scope. Done as PR #229: 42 files under `docs/test-reports/`, copied as files (no commit picked; several introducing commits also changed code) onto a branch cut from `main`. #222 is left for the owner to close or make a draft (closed 2026-09-26 at the owner's choice, decision 36); it must not be merged. (Dror, 2026-09-26)
34. **This session (sprint-6-integration-ba) leads development and the shared worktree**; the process session (sprint-6-integration-3d) works on process only — the hook, the roles, CLAUDE.md process text, measuring whether the changes save time — and sends changes as PRs from its own worktree. The process session first understood the reverse and corrected itself the same day. (Dror, 2026-09-26)

Decisions 35–37 are the owner's, taken 2026-09-26 in the lead session's conversation and recorded by the lead. Decisions 38–40 are the lead's own calls, not Dror's: he did not decide them, and where a reason is written it is the one given in the PR body, the commit message or the regression plan cited.

35. **The trip-site connector's boundary-review findings are tracked in handover notes only, not as GitHub issues, because the repo is public and the connector is live on a real trip.** Four lower-severity findings, present on `main` and on Orlando and unchanged by the carry (#228), are recorded outside the repository (`~/.claude/sprint6-connector-boundary-findings-2026-09-26.md`); no detail is written here on purpose. The owner accepted D1 as decision 32. (Dror, 2026-09-26, answering the lead's question)
36. **PR #222 is closed, with a pointer to #229.** Amends decision 33's "left for the owner". (Dror, 2026-09-26)
37. **The branch `fix/119-keep-bridge-key-stable` is deleted, and the stale `agent:in-progress` label is removed from #119, #177 and #173.** Its content was squash-merged as `89b1976` (identical patch-id). #119 stays open for what is unbuilt: what replaced the trip container's env file, and a periodic `/health` re-probe. (Dror, 2026-09-26)
38. **#223 cause 2 was fixed at the root, not with a retry (the lead's call, 2026-09-26; Dror did not decide it).** Decision 15 left "renumber `tests/helpers/ports.js` below 32768, or retry the bind on `EADDRINUSE`" open. PR #231 renumbered (`38xxx` to `28xxx`, same layout) and added a guard against the Linux ephemeral range in `tests/helpers/ports.js`, with `tests/ports.test.js`. Reason, from the PR body: a retry in the test helper "would hide the hazard". **The theory (every 38xxx port sits inside Linux's default 32768–60999) was not reproduced**, and the runner's own range was not verified; the failure is made impossible under the theory, not shown gone. **#223 stays open** until the Kinerary suite has been green over time; if `EADDRINUSE` recurs at 28xxx the theory was wrong. `CLAUDE.md` describes none of this reasoning (checked).
39. **The TypeScript API job's wall-clock limit is 30 minutes, not 15 (the lead's call, 2026-09-26; PR #233).** On 2026-09-26 PR #232, a docs-only change, had that job cancelled at the old limit mid-run with no failing test in its log; the job took 9–13.5 minutes on that day. 30 is "about twice the slowest observed run". It is a whole-job guard against a wedged runner, not the per-file hang bound (`--test-timeout`), so a real hang still fails fast. `.github/` is a policy path; the owner approved the commit at the hook prompt. (Source: PR #233 body and commit `50eaad8`.)
40. **The relay hardening's classification and retry rules (#230, #234; the lead's calls, 2026-09-26, so later sessions do not re-litigate them).** Sources: the two PR bodies, commits `464e56c` and `3826c34`, and `docs/test-reports/regression-plan-2026-09-26-pr230-typed-change-pre-deploy.md` and `…-pr234-relay-send-hardening.md`. Reasons only where a source gives one.
    - (a) **400 is the only permanent Telegram refusal.** 401, 403, 404, 409, a 429 over the cap, 5xx and a timeout are transient. Reason given by the lead: a blocked bot is transient, because the change waits and nothing else could reach the organizer anyway. The #230 plan records that a later edit widening "permanent" would drop changes on a blocked bot, and pins 403/404 as transient with a test. The PR bodies list "the 429 cap and the 400-only classification" as not revisited in #234.
    - (b) **A 429 with `retry_after` of 3 s or less is waited out once inside the call; longer or missing is returned at once** (as before the change). Every Bot API method that goes through `post` gets it. Reason recorded: before, such a 429 lost the message; the plan judges a few seconds' delay the cheaper failure for this fleet. The 3 s figure itself: reason not recorded beyond that (the plan checks it is adequate for a private-chat burst and says group flood-waits ask for tens of seconds and fail fast).
    - (c) **A 10 s bound on every Bot API method call** (`REQUEST_TIMEOUT_MS`; not `getUpdates`, not file downloads, not boot-time webhook calls). A timeout is transient and is not retried. Internally it reports the fixed word `TIMEOUT` (never the URL, which carries the bot token); **to the Hermes gateway it reports "telegram call timed out"**. Reason (commit `3826c34`): Hermes classifies a string containing "timed out" as a timeout that it neither retries nor re-sends, while the bare `TIMEOUT` fell to a plain-text re-send, and a family could see a reply twice if the slow first send had landed. Hermes was read at `ab0d98414` on the Mac checkout and in the VM image. **The connector test mirrors Hermes' classifier** (`relay-connector.test.ts`), so a Hermes upgrade that changes it must change the mirror by hand. Alternative rejected by the fix itself: the bare `TIMEOUT` word (round 1 of #234).
    - (d) **Router steps** (questions, the summary, the boundary re-raise, a document disagreement) **are named before the send and un-named if Telegram does not take it.** A transient failure hands the floor back and is retried on the deliver tick with a per-relay-process backoff: 2 s doubling to 60 s (2, 4, 8, 16, 32, 60, 60), at most 8 failures in a row, then `trip_bot.step_send_abandoned` and the organizer's next message starts afresh. Reason (PR #234): a refused step used to be marked on screen and never re-sent. **A permanently refused document disagreement is skipped, not retried, and never blocks the interview**: round 1 un-named it, so every later step asked it first, was refused and said nothing else (found by the regression plan and the adversarial review, fixed in `3826c34`). The retry record is per process; a restart forgets it.
    - (e) **The stall watchdog (`recoverStalledInterviews`) never fires on the interpret path** (`INTERPRET_PATH_DEFAULT=1`; it scans `state = 'interviewing'` only). This was a finding of the hardening developer; the first brief assumed otherwise, which is why the retry lives on the deliver tick and not in the watchdog. It still applies on the agent path.

Decisions 41–44 are the owner's answers to four questions the lead put to him on 2026-09-26 after the Release A regression plan (`docs/test-reports/regression-plan-2026-09-26-release-a-sprint-mode.md`) said Release A could not go until one decision was made.

41. **Release A: an organizer's private-chat document route is switched off by default, behind a flag (`ORGANIZER_DOCUMENT_ROUTE_ENABLED`), until after 3 Oct and until the #217 walk has been done.** The plan's blocking finding, which the lead verified in the code (`organizerDocumentRoute`, `relay/dispatch.ts`, `relay/poller.ts`, `intake-correction.ts`): since #215 a file from an organizer's own confirmed private chat is read by the relay and proposed back, and tapping Approve rebuilds the trip's site from the newest `available` release (`ready_private` is a correctable state) — a mid-trip redeploy of a live trip, which contradicts decisions 11 and 28 (for Orlando it would replace a hand-deployed release; for Japan it could fire on its departure day, and a boarding pass is exactly that kind of file). Production (revision `130924b`) sends such a file to the companion, so the route would have been new with Release A. Options put to the owner: **flag it off by default (chosen)**, ship it live with the #217 walk and tell both organizers not to send documents mid-trip, or wait until after 3 Oct. Consequence: the #217 document-route walk is no longer a gate for Release A; it is a condition for switching the flag on. (Dror, 2026-09-26)
42. **Release A window: Fri 2 Oct — dry-run about 13:30 UTC, relay restart about 14:00 UTC, done by about 15:30 UTC** (16:30–18:30 IDT, about 23:00 JST; after Orlando ends, during Japan's last full day), conditional on decision 41. This is "before 3 Oct", as decision 28 chose. The alternative put to him was Sun 4 Oct 06:00–09:00 UTC, after both trips end. The walk with the owner is on 1 Oct or the morning of 2 Oct IDT, with the nightly e2e off that day. The exact hours are the plan's recommendation, not his. (Dror, 2026-09-26)
43. **The new data flow for the live companions from the Release A restart on is accepted:** recent unaddressed family group messages reach the companion (the plan's owner question 4; in the sprint already, not on production today). It is checked on a throwaway trip first. (Dror, 2026-09-26)
44. **Release A promotes no release to `available`;** new trips keep using the current release until after 3 Oct (a promotion is a deploy-class action that decides which build every new trip is made from). The plan's gate G5 still stands: a `boundary-reviewer` check of new trips built by the sprint worker but served by the older site. (Dror, 2026-09-26) **G5 is done** (`docs/test-reports/boundary-review-2026-09-26-release-a-g5-sprint-worker-old-site.md`): the config question holds — nothing the sprint worker writes into a new trip's config is served by the old deny-list that the allow-list would have withheld — with the one finding and one regression decided in 45 and 46.
45. **Accepted: the RSVP-activities exit on new trips served by the old site.** The sprint worker now writes `phases[].rsvp_activities` (#169), and the old site's unguarded `GET /api/rsvps/:activityId` returns the voter's user row (including the Telegram id, age and vote note); the old site already returns the same user row through venue comments on every trip the old worker built, and the sprint site closes both (#211). Options put to the owner: gate the worker's RSVP-activities merge off until a release with #211 is `available` (recommended by the lead), or accept. **He accepted.** The gate is therefore not built; RSVP cards work on new trips from Release A. Nothing here closes the venue-comment exposure — only a promotion does. (Dror, 2026-09-26)
46. **Accepted: hotel-card and booking document links on new trips return 404 between Release A and the promotion** (the old site does not read the directory the sprint worker hosts documents in; it fails closed). (Dror, 2026-09-26)

Decision 47 is the lead's call, made when the owner said "prioritize it as you see fit" (2026-09-26).

47. **#240 (the Orlando companion invented "nut-free options for Eitan") is high and rare, fixed in the template before Release A, and not mitigated on the live companions until their trips end (the lead's call, 2026-09-26; the owner delegated the priority).** Sources: the assessment comment on #240; `docs/test-reports/regression-plan-2026-09-26-release-a-sprint-mode.md` U7.
    - **Cause, read in the code:** an example sentence at `profile-templates/familytrip-companion/templates/SOUL.md.tpl:283` reaches every companion's prompt. The interview is not exposed the same way (`exampleEchoes` rejects a value copied from an example); the companion has no such guard.
    - **Order:** (1) the owner tells the two organizers not to rely on the companion for allergy or dietary statements until a venue confirms (his channel; wording prepared); (2) a template fix with a test that fails on today's template and a before/after evaluation on the Claude and the Codex runners, before the Release A commit; (3) an audit of every other prompt, skill and template for concrete personal examples, as a follow-up, not a Release A gate; (4) re-rendering the two live companions after their trips end, each an approved step. The evaluation sample is small, so "no longer does this" is stated with its sample.
    - **Why no hot-fix mid-trip:** Hermes saves a conversation's assembled system prompt on its first turn and reuses it; a family group is one conversation that never ends, so reaching a live group needs a re-render, `companion-refresh-prompts.sh` and a gateway restart, which is a live intervention (hard rule 2).
    - **Labels:** `sprint-6`, `track:4`, `size:M`. Reversible if the owner places it elsewhere.

48. **Production reads organizers' documents with Gemini 3.8 Flash (`google/gemini-3.8-flash`, through OpenRouter), and falls back to the Claude CLI only on a quota limit; testing stays on the Claude CLI.** Decided by Dror in the process session's conversation (sprint-6-integration-3d), 2026-09-26, after the two-round comparison in `docs/test-reports/model-comparison-extract-2026-09-26.md` (PRs #236, #243): Gemini was clean in 70 of 70 runs at $0.018 per document, against $0.033 for Claude billed through OpenRouter (40% above `model-runner.ts`'s API-equivalent estimate); DeepSeek was dropped (too slow, or lost an itinerary); GPT-5.4 mini invents dates. His words on the fallback: "fallback only due to quota limit, not on failure." So:
    - **The fallback fires only when Gemini is out of quota** (rate-limited, or OpenRouter credits exhausted), after the same-model retry that already exists. A timeout, a malformed or refused answer, or an upstream error is surfaced exactly as today and never handed to Claude, so a broken Gemini cannot hide behind a working fallback — the failure `model-runner.ts`'s no-fallback rule exists to prevent (the 2026-09-07 incident, and the `kinerary-extract` profile's nonexistent primary).
    - **Only the document-reading tasks** (`extract_intake`, `extract_itinerary`, and `extract` where it reads documents) may fall back; `interpret` and the interview keep the no-fallback rule. *This scope is the process session's reading, not his words: the comparison covered only document reading, and the quota-only rule is what he stated.*
    - **Every fallback is logged and counted** (task and reason, no content), so a primary that is always out of quota is visible.
    - **Testing (Mac staging) stays on the Claude CLI**, as it already is. Codex was offered by the owner for testing, but it cannot read documents: `ATTACHMENT_RUNNERS` excludes it from attachment tasks because it dropped an image. It remains usable for text-only tasks.
    - **Not yet built.** It is a code change to `model-runner.ts` (Track 3 owns it) plus the production VM's configuration in `kinerary-deploy` (the OpenRouter key through `OPENROUTER_API_KEY_FILE`, because child environments are allow-listed since #192), then a release through the normal gates with a regression plan. Nothing changes in production until that release is deployed. (Dror, 2026-09-26; recorded with his consent by the process session)

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
look, since every other track's verification rests on it. *(Superseded
2026-09-26, decision 30: Track 4 formally owns CI and test health; what has been
done under it since is recorded under "Test health" above — #224, #231, #233 —
and #223 stays open.)*

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
