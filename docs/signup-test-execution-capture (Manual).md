# Signup test — execution capture

Where issues raised during signup-test-plan runs stand. Dror's verbatim run-1
notes and the agent debriefs live in **`signup-test-run1-raw-notes.md`**
(archived 2026-08-29); this file keeps only the triaged Status ledger below,
which is the source of truth for what is done vs. planned.

**Standing instructions for every run:**

- Until this is production, the interview opens with a disclaimer that it is
  alpha and may be wrong or buggy.
- At the end of each run, debrief yourself and Hermes for issues noticed, and
  record them here. An issue is only "fixed / rejected / ignored" once a human
  approves it — mark that in the run notes when it happens.

---

## Status ledger

Every issue from Signup Run 1, with where it stands. **None of the "Fixed" rows
are human-approved** — they are code changes on the branch, awaiting review.

**2026-09-03 pass (PR #34).** Step 3 #3, #4, #7 and #13 moved to Fixed, #9 and
General #4 advanced. Both "Bug" rows were reproduced for the first time; #7's
reproduction was exact and #9's was not, which its row now says explicitly
rather than claiming a cure it cannot prove. The next live run is what settles
#9.

Legend: **Fixed** = code written + tested this branch, pending approval ·
**Partial** = part done, rest noted · **Deferred** = has a sprint (see Routing) ·
**Open** = has a sprint, not started · **Bug** = has a sprint, not yet
reproduced · **Mitigated** = symptom handled, root cause noted.

**Routing (2026-08-29 planning pass — `docs/onboarding-mvp-sprint-plan.md`).**
Every row below now has a home:

- **Trip-content items** (Website review #1–7, the Step 4–5 data gaps —
  itinerary/PDF, hero photos, map, Info-tab emergency/consular, budget,
  bookings) → **Sprint 4.5** (rewritten). Tags there: `built` (destination
  data, bookings, trivia-descope), `this step` (itinerary from document,
  map-tab pins + click), `follow-on` (venue Maps/Waze/ticket links, consular
  contacts via Agent search + reusable `country_reference` store, phase
  narrative, structured budget), `needs-source` (weather), `separate build`
  (site live-plan enrichment worker).
- **Provisioning operational gaps** (Step 4–5 process gaps — retry endpoint,
  `ready_private` ∉ `CORRECTABLE_STATES`, job-lease vs heartbeat, half-built
  container repair, worker self-minting the NPM token) → **Sprint 4.7 —
  Provisioning hardening** (new section).
- **Interview UX and correctness** (General #1–4, Step 2 #1–3, Step 3 #1–13,
  incl. bugs #7 and #9) → **Sprint 5**, "Interview UX and correctness" bullet
  cluster — that sprint already rebuilds the interviewer as a router mode.
  Exceptions: per-user Telegram info-message logging (General #1) → Sprint 6
  analytics; approval gates via the Hermes MCP (Step 3 #12) → exploration,
  unscheduled.

Issue text and original wording: `signup-test-run1-raw-notes.md`. "Open" here
does not mean "no owner" — read the row's home from Routing.

### General comments

| # | Issue | Status | Detail |
|---|---|---|---|
| 1 | Telegram info messages (model switch, quota, compression…) → per-user logger, not to organizer | **Open** | → **Sprint 6 analytics** (per-user event logging). Not the Sprint 5 interview cluster. |
| 2 | Hermes/Telegram commands shouldn't be available to a trip-group organizer | **Deferred** | Sprint 5 — Trip Context Gateway / router scoping. |
| 3 | Multi-answer buttons render in Hebrew, should be the organizer's language | **Open** | Sprint 5. `interview.ts` / interview profile — the `clarify` option labels aren't localised. |
| 4 | LLM-parse unclear answers · carry-forward extraction · reconcile end-summary vs `intake.json` | **Partial** | Sprint 5. Deterministic side (non-Latin `destination` → slug `trip-2026`) **fixed 2026-09-03, PR #34**: `derive_trip_slug` now tries the phase names first, preferring `name_en`, so a trip written "יפן" with a "Tokyo" phase becomes `tokyo-2026`; `"trip"` survives only when nothing in the intake is Latin. Mutation-checked. The LLM-parse / carry-forward / summary-reconcile behaviour is interview-profile work, still not started. Memory `interview_llm_parse_and_summary_reconcile`. |

### Step 2 — DM approval message

| # | Issue | Status | Detail |
|---|---|---|---|
| 1 | Approve/deny message should edit itself to show the action taken | **Open** | Sprint 5. Control-plane Telegram approval adapter. |
| 2 | Bot can't initiate a DM → the token link should come from the onboarding site first | **Deferred** | Sprint 5 + landing-spa worktree. Memory `onboarding_requires_clickable_start_link`. |
| 3a | Flow: onboarding site → interview bot (with token) → personal bot → `@kinerary_bot` | **Deferred** | Sprint 5 router. |
| 3b | No "(Recommended)" tag on constraint answers (dates, number, organizer) | **Open** | Sprint 5. Interview-profile prompt rule. |

### Step 3 — Interview bot

| # | Issue | Status | Detail |
|---|---|---|---|
| 1 | Choice questions: buttons only, no numbered list in the message text | **Open** | Sprint 5. Memory `interview_choice_questions_ux`. |
| 2 | Don't recommend trip constraints (type/size/duration); recommend places/hotels/attractions | **Partial** | Sprint 5. Two of the three named constraints stopped being questions at all on 2026-09-03 (PR #34) — size and duration are derived now, so nothing can recommend them. `trip_type` remains a choice question and is still interview-profile work: a "(Recommended)" tag on it is meaningless. |
| 3 | "Number of people" is confusing → ask who's coming (names + ages), derive the count | **Fixed** | 2026-09-03, PR #34. `group_size` is gone from `INTAKE_QUESTIONS`; the headcount is counted off the `travelers` roster, which is required and names each person, so the stat can no longer disagree with the names given. Hero stat becomes an exact number where it was a range ("3", not "3–5"). QUESTIONS.md also says not to ask conversationally — reintroducing it in prose reproduces the complaint. |
| 4 | Duration is derivable from the dates / onboarding site | **Fixed** | 2026-09-03, PR #34. `trip_duration` is gone; duration is the gap between `departure_date` and `return_date`, both required. The stored answer is still read as a fallback for an intake with no usable date pair, so pre-v3 trips do not regress. |
| 5 | Bot asked permission to read a pasted link — should be automatic for the organizer | **Open** | Sprint 5. Hermes `trip-intake` profile approvals/capability config. |
| 6 | If a link can't be fetched, fall back to scraping | **Open** | Sprint 5. Same as #5. |
| 7 | **Bug** — dietary restriction step threw an error | **Fixed** | 2026-09-03, PR #34. **Reproduced exactly.** `dietary` is `multi_choice`, which `validateAnswer` answers only from `optionIds` — and the MCP `submit_answer` tool never exposed that parameter, so every input the interviewer could send (`optionId`, `otherText`, `data`) was refused `OPTIONS_REQUIRED`. The step was unanswerable, not flaky. The parameter existed on the HTTP route and on `submit_answer_for_chat` the whole time and was never backported. Both tools now share one definition, and a coverage test asserts every question TYPE is answerable through it. |
| 8 | Schedule/planned-order should allow multiple answers + a flight-details option | **Open** | Sprint 5. `interview.ts` `phases`/anchors schema. Untouched by the 09-03 pass — #9 fixed a submission defect, not this schema request. |
| 9 | **Bug** — schedule registration failed to submit | **Partial** | 2026-09-03, PR #34. A real defect producing exactly this symptom is fixed: `data` was a strict array/object union, so a model handing over JSON it had just written **as a string** was rejected at the MCP boundary with nothing recorded — and the tool description already carried a "never as a string" warning, which is evidence it kept happening. `dataParam` now parses such a string; prose and JSON scalars are still refused. **But the original run's failure was never captured**, so this is a plausible cause, not a proven one. The next live run settles it. |
| 10 | Interview should say daily-itinerary help happens on the trip bot; the interview is for structure | **Open** | Sprint 5 (also Sprint 4.5's itinerary work reduces the confusion). One line in `SOUL.md` / `QUESTIONS.md`. |
| 11 | After CONFIRM the user is in a dead-end — no link to the site or bot | **Deferred** | Sprint 5 router; same root as Step 2 #2. Memory `onboarding_requires_clickable_start_link`. |
| 12 | **Note** — the approval gates could be driven by the Hermes intake profile / personal bot via MCP; explore | **Open** | Exploration item, unscheduled. |
| 13 | Verify the English spelling of non-English traveller names | **Fixed** | 2026-09-03, PR #34. The transformer already honoured `name_en`/`family_en`; nothing ever asked for them, so they appeared only if volunteered. The `travelers` prompt and its field guidance now ask — once for the whole list, not name by name. `username` derives from the Latin spelling, so without it the site shows people something they do not recognise. Guidance takes the organizer's transliteration as given rather than standardising it. |

### Step 4–5 — provisioning code defects (prior run)

| # | Issue | Status | Detail |
|---|---|---|---|
| 1 | `pct create` made unprivileged containers → NFS EACCES mid-bootstrap | **Fixed** | `provisioning/adapters.py` — `--unprivileged 0`, regression test. Committed `bad403a`. |
| 2 | Bootstrap installed no compiler → `better-sqlite3` build fails | **Fixed** | `adapters.py` — `build-essential` in the apt line, test. `bad403a`. |
| 3 | 35 s SSH deadline killed the multi-minute bootstrap | **Fixed** | `SubprocessSshTransport` — separate `command_timeout` (900 s), test. `bad403a`; stdout-fallback follow-up `1dba06b`. |
| 4 | NPM forwarded to the unresolvable `trip-*` LXC name → 502 | **Fixed** | `compute.py` — `forward_host` = container IP, test. `bad403a`. |
| 5 | Failures reported stderr (ssh noise) not stdout; locale spam hid the real error | **Fixed** | `provisioner.py` reports both streams + tail; `LANG=C.UTF-8` pinned in bootstrap; `ShellDeployAdapter` now has tests. `bad403a` / `1dba06b`. |

### Step 4–5 — provisioning process gaps

| Issue | Status | Detail |
|---|---|---|
| No retry path after a provisioning failure (`PLAN_ALREADY_PENDING` on re-plan) | **Open** | → **Sprint 4.7**. Every retry still needs manual DB cleanup. |
| `_bootstrap_app_environment` only runs in `create()`, never repairs a half-built container | **Open** | → **Sprint 4.7**. |
| Job lease (600 s) < bootstrap ceiling (900 s), no heartbeat | **Open** | → **Sprint 4.7**. Harmless while bootstraps take ~140 s. |
| `ready_private` not in `CORRECTABLE_STATES` (re-provision needs a manual lifecycle `UPDATE`) | **Open** | → **Sprint 4.7**. Hit repeatedly during the 2026-08-29 re-provision. |
| Worker uses a ~1-day NPM JWT from `provisioning.env`; 401s once it expires | **Open** | → **Sprint 4.7**. Worker holds `NPM_IDENTITY`/`NPM_SECRET` — should mint its own. |
| `provisioning.env` must set every `PROXMOX_*`/`RPI_*` explicitly (compose `${VAR:-}` beats code defaults) | **Mitigated** | All vars set in `~/kinerary-deploy/provisioning.env`. Root cause noted in Sprint 4.7. |
| Compose v2.13 ignores all but the last `--env-file` | **Mitigated** | Single `--env-file` in use; `CONTROL_PLANE_CHAT_ROUTING_KEY` mirrored in. |

### Step 4–5 — data gaps in the generated site

| Issue | Status | Detail |
|---|---|---|
| `travel_anchors` dropped from the config | **Fixed** | `derive_bookings()` → `bookings.json` sidecar (hotels + dated anchors, phase-mapped). Two follow-up bugs found + fixed on the 2026-08-28 re-provision: the site's `bookings` table is `CHECK(type IN ('flight','hotel','car','attraction','other'))` and `phase TEXT NOT NULL`, so `type:"activity"` rows and the `phase:null` proposal were silently dropped by `INSERT OR IGNORE` (5/12 seeded). Now maps activity-like → `attraction` and parks an unphased anchor on phase 1. All 12 seed. Committed `bad403a`. |
| No `trivia_questions.json` / `bookings.json` (ENOENT every boot) | **Fixed** | `bookings.json` generated; `trivia_questions.json` written as `[]` (documented descope). `bad403a`. |
| Family name not transliterated (`{he:סולומון, en:סולומון}`) | **Partial** | Honoured when the intake supplies `family_en` (done). Auto-transliteration = the LLM pass (General #4 / Sprint 5). |
| `derive_trip_slug` can't romanise non-Latin, falls back to literal `trip` | **Partial** | Worked around via `intake/correct`. The `"trip"` → first-phase-name fallback is → **Sprint 5** (folded into the LLM-parse item, General #4). |
| Info tab: no embassy/police numbers | **Partial** | Country `emergency` numbers now populated from a static table (`emergencynumberapi.com` is dead). Consular/embassy contacts → **Sprint 4.5 follow-on** (Agent web search → reusable `country_reference` store). |
| Hero photos per phase | **Fixed** | `enrichment.py` — Wikipedia REST lead image per phase. `bad403a`. |
| Map has no phase locations, no click-summary | **Partial** | Geocoding produces `phase.mapStop` (`bad403a`), but the map tab still renders no pins / no summary. → **Sprint 4.5 `this step`** (emit a top-level `map` object + fix the site render/click). |
| PDF plan not split into per-phase itinerary | **Partial** | The 7 dated anchors → `bookings.json`. Full PDF → per-phase `days[]` → **Sprint 4.5 `this step`** (`extract_itinerary` via `kinerary-extract`). |
| No structured budget | **Open** | → **Sprint 4.5 follow-on**. Interview collects only a free-text budget note in `constraints`. |
| Trip bot not wired (organizer / Telegram / MCP) | **Deferred** | **Sprint 5** — companion profile / MCP bridge / Telegram bind. Bootstrap `.env` now writes a `HERMES_API_KEY` so the site can accept an agent call without a redeploy (`bad403a`). |
