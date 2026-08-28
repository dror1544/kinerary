
# General issues
Thes nots capture issues/ux raised up during the signup-test-plan execution and aim to have a whole look on the proccess, comments are by stages and some might already has a resolution on future sprint, in cases like that refer to the plan and approve it is the right path

In General, untill this will be production, make note to say at the begining of the interview a disclamer that this is still on alpha stages and it might be wrong or buggy 

Debtief your self and Hermes at end of each run for issues you notices, and based rais issue notices by you, this notes are mine. however if an issue approved as fixed/rejected/ignored (all need manual approval by human), idicated that in the specific run notes. 

## Signup Run Number 1

### General comments
1. Telegram information messages (model switch, home set, quota limitation, comprssion .etc) need to be sent to a logger od the app (per user) for analysis but not to the orginizer, and maybe to the app logic (like changing to a different model etc.)
2. Telegram commands, of Hermes does not need to be avaliable to the oprginizer of trip group. some will be logic automation (for example new sesstion every morning)
3. When muliple answers button is displayed it should be on the orginizer languish, currently shows in hebrew
4.  If an answered is failed to parse, send to the hermes agent trip-intake (LLM) to unravel the details, also if more detials where given that can add information to a future answer ask the LLM to extract that also. In addition, at the end of the interview the bot summarize all trip details, ask the agent to confirm the summary with the capture trip details with the capture intaks.json

### Step 1 
  No Comments  

### step 2 **DM Message on kinerary:**
 1. the first meesage with Approve/denay, when approved or denied need respond in the text, best prefred is editing the message and incate the action was approved/rejected 
 2. Since Telegram does not allow a bot to initiate a message, it is unclear how this message is sent over witout the user did the interview, so to proper order is that the user get a link (probebly from the onboarding site) after trip perliminary details placed. 
 3. I know it is plan to berge both bots to one and route between them (sprint 5) , but It make more sense that if he started from the onbarding site (implemented on landing-spa worktree), there the orginizer will get a link to the interview bot on telegram including the token, and when interview is finish move to the personal bot (@Tripinterviewer_bot) and than link to the @kinerary_bot
 3. Do not place a (Recomnded) comments on the option of the answers unless it is a trip details, on constrains (like dates, number, orginizer etc.) your recomendation does not help
### Step 3 Interview bot
1. Asking about the trip if there are multiple answers, put it in the buttons only no need to indicate it by number and that write the numbers (general to all places it is like that)
2. it is a trip you can not recomend the orginizer the trip type - in general it does not make sense to recomed on the trip constains (type, number of pepole, duration), it make sense to recomend places, hotels, atttractions etc.
3. The question aboout the number of pepole is confusing, the suggestion is to start with 2, 4, 5, other, the other trigger a manual input number, although it make more sense to ask who is comming to the trip (names and ages) - and deduct from it the number, if not sure ask a follow up question - Are more pepole joining the trip?
4. Duration can also be deducted from the dates it can come from the onboarding site, or if not can be asked in the interview
5. **Issue** When Placed a link to a site with the plan, the bot asked for permission, this need to be avoided to the orginizer and scrapping a website should be possible to the bot
6. **Comment** if can not get data from the link, use a scrapping method instead of trying to get it dirctly from the link
7. **Bug** On the deitary restriction, got an error on that, need to check
8. planed order (schedule), sould allow multiple ansewers, and add flight details on flight daya as option.
9. **Bug** On the schedule regisration it failed to do so
10. Currenly the planned is not asking to help  on the trip daily itenruray, it should indicate that it can be done on the trip bot and this interview is mostly to establish the trip main structure
11. When trip was confirmed, user get a notice about the trip bot, but no follow up or a link to the site or the bot. The current situation the user it is a deadlock with nowhere to go.
12. **Note** All the approval we made on the claude code, could be easily initiaed by the Hermes intake profile (or the personal bot) via the MCP, lets explore that
13. when name of a traveller is given on a non english languish verify with the user the English names of the travellers

### Step 4–5 Plan + Provisioning — agent debrief (Claude, 2026-08-28)

My own notes from driving the run; none of these are approved yet.

**Code defects found and fixed (each with a regression test; 19 provisioning +
139 worker tests green).** All five were in code that had never once run
against a real fresh container — the existing trips (CT200/201/202) were built
by hand, so every assumption the automation inherited from them was untested.

1. **`pct create` made unprivileged containers.** Container root maps to host
   uid 100000, so the root-owned NFS `mp0` mounts as `nobody:nogroup` and the
   bootstrap's own `mkdir -p <mount>/media/avatars` gets EACCES — killing it
   under `set -e` before `.env`, the systemd unit or the nginx site are
   written. Every real trip container is privileged. Fixed: `--unprivileged 0`.
2. **Bootstrap installed no compiler.** `server/package.json` needs
   `better-sqlite3`, a native module; with no prebuilt match npm falls back to
   node-gyp and `deploy.sh`'s `npm install --production` dies. Fixed: add
   `build-essential`.
3. **35-second SSH deadline on a multi-minute bootstrap.** One `timeout` served
   as both the ssh `ConnectTimeout` *and* the whole-command deadline
   (`timeout + 15`), so installing a toolchain was always killed mid-apt. Fixed:
   separate `command_timeout` (900s), connect stays 20s.
4. **NPM forwarded to the container's LXC name.** Nothing resolves `trip-*`
   hostnames on this LAN — not even the live `trip-kinerary`, checked from the
   RPi4 that runs NPM — because the containers hold static IPs outside DHCP and
   never register in DNS. Result: a clean 502 with everything else correct. Every
   working proxy host is IP-based; the name form was copied from the
   hand-written `topology.yaml` files, whose own headers admit they were never
   applied. Fixed: `forward_host` = the container IP.
5. **Failures reported the wrong stream.** `deploy.sh` writes its diagnostics to
   stdout while stderr carries only ssh's "Permanently added … known hosts"
   warnings, and the code did `stderr or stdout` — so every real failure reported
   pure noise. The same head-only truncation in the ssh transport hid defect 1
   behind locale warnings for a full round trip. Fixed: report both streams,
   keep the tail, and pin `LANG=C.UTF-8` so the locale noise stops at source.
   `ShellDeployAdapter` had **zero** test coverage; it now has some.

**Process gaps (not fixed — need a decision):**

- **No retry path after a provisioning failure.** A terminally failed job leaves
  the plan `superseded`, and regenerating it is then blocked by
  `plans_trip_id_digest_key UNIQUE (trip_id, digest)` — same intake + release
  means same digest — returning `PLAN_ALREADY_PENDING`. Every retry in this run
  needed a manual DB cleanup (delete the dead plan, its `plan_approvals` row and
  its job, then reset `trips.lifecycle_state`). This wants a real endpoint.
- **`_bootstrap_app_environment` only runs inside `create()`.** `apply()` is
  inspect-then-create, so a container that exists but is half-built is never
  repaired — the only recovery is destroy and recreate.
- **Job lease (600s) is now shorter than the bootstrap ceiling (900s)**, and
  there is no heartbeat yet. Harmless today (a real bootstrap takes ~140s) but
  a hung one would outlive its lease.
- **`provisioning.env` must set every `PROXMOX_*`/`RPI_*` explicitly.**
  `compose.local.yml` passes each as `${VAR:-}`, so an unset var arrives as `""`
  and defeats the code's own defaults. Cost two failed runs.
- Compose here is v2.13, which **ignores all but the last `--env-file`**.

**Data gaps in the generated site** (config is otherwise correct — meta.title
"Japan 2026 — Family", right dates, 5 participants, 5 phases with dates and
accommodation, `travel_info` with JPY):

- **`travel_anchors` are dropped.** The intake captured 7 concrete dated anchors
  (Skytree, TeamLab, Hakone Free Pass, Sagano train, Hozugawa boat, Sumo Osaka);
  `trip.config.json` has none. This is the known Sprint 4.5 enrichment gap, now
  confirmed against real data rather than assumed.
- **No `trivia_questions.json` and no `bookings.json`** — the server logs both as
  ENOENT on every start. `create-trip` generates trivia for hand-made trips; the
  control-plane transformer does not, and the interview collects neither.
- **Family name has no transliteration** — `families[0]` is
  `{"he": "סולומון", "en": "סולומון"}`. Same root cause as your general note 4:
  non-Latin input needs an LLM pass, not a deterministic copy. It is also what
  produced the slug bug below.
- **Slug derivation can't handle non-Latin input.** `destination` was answered as
  Hebrew prose, `derive_trip_slug` romanizes nothing and falls back to the
  literal word `trip` → the public URL would have been `trip-2026.ara-united.store`.
  Corrected mid-run via `intake/correct` (destination → "Japan") giving
  `japan-2026`. The fallback should use the first phase name (`tokyo-2026`)
  rather than a generic word, but the real fix is your note 4.

  ### Trip Website review - Almost empty site 
  1. The Entire plan and attarctions in the PDF was not extracted and splitted to the phases 
  2. Hero Photos, sould capture the places on the phase it is specificly indicated on the create trip skill, need to automate it or use LLM if not possilbe 
  3. Map does not show the location of the places on the trip phases 
  4. Info did not added number of embessy, police etc.
  5. No Budget and no booking (at least show and idicate not confirmed)
  6. Review Data from the japan trip on the kinerary0deploy folder and usa-2026, japan-2025 and both has reacher data, also los-angeles-hawaii-vegas-2026 was actually gathered from the trip interview for the most of it (the schedual was added later).
  7. Enrichment is an important role (sprint 4.5) to make the trip site valuable to the trip members
  ### Trip Bot interacation and wiring
  1. The trip bot (Kinerary) is not wired to the orginizer, not to the telegram and seems like also the  MCP is not connected to it 

### Website review — agent response (Claude, 2026-08-28)

Triaged with Dror; agreed scope for the next run = **Bucket A must-fixes +
Sprint 4.5 deterministic half**. Trivia → documented descope. All built
test-first; suites green (worker 171, provisioning 23, API 250/5-skip, main
372). **The control-plane compose stack needs `docker compose build` before the
next live run** — the image predates all of this.

| Your item | What changed |
|---|---|
| #1 PDF plan not split into phases | Partly: the anchors the interview *did* capture (7 dated activities + the proposal + 5 phase hotels) now become `bookings.json` rows via `derive_bookings()`, dated and mapped to the right phase. Full PDF → per-phase day-by-day is the **AI half of 4.5, still deferred**. QUESTIONS.md now tells the interviewer to mine a shared document, not skim it. |
| #2 Hero photos per phase | Done, deterministic: `enrichment.py` pulls each phase's lead image from Wikipedia REST (`page/summary/<title>` → `originalimage`). Only fills when the phase has none. Verified: all 5 japan-2026 phases got real photos (Shinjuku, Fuji/Ashi, Kyoto, Osaka Castle). |
| #3 Map has no phase locations | Done: Nominatim geocode per phase → `phase.mapStop {lat,lng}`. All 5 japan-2026 phases resolved. |
| #4 Info: no police/emergency numbers | Partial: `countries.dev` gives currency/callingCode/capital/flag live. **`emergencynumberapi.com` is dead** (domain reassigned, all `/api` 404 — `scripts/country-info.js` is broken by this too), so emergency numbers come from a ~20-country static table + EU-112 bloc in `enrichment.py`. Embassy/consular contacts: no free source, still not done. |
| #5 No budget / no bookings | Bookings: done (see #1). Budget: not built — the interview collects only a free-text budget note in `constraints`, nothing structured enough to seed `budget_items`. Flag if you want a stopgap. |
| #6 Reference trips are richer | Used them as the target shape — `bookings.json`, `travel_info.emergency_contacts`, `phase.hero`/`mapStop` shapes all copied from `los-angeles-hawaii-vegas-2026`. |
| #7 Enrichment matters | Deterministic half now runs in `ProvisionerWorker` (live from `__main__`, no-op in tests). Self-guarding: any lookup miss leaves that slice alone, never fails the job. |
| Bot wiring | Confirmed **Sprint 5**, not a Sprint-4 defect — the plan defers the companion profile / MCP bridge / Telegram bind. Pulled one piece forward: the bootstrap `.env` now always writes a `HERMES_API_KEY`, so the site can accept an agent/MCP call at all without a redeploy. `HERMES_URL` / `TELEGRAM_*` stay Sprint 5. |

Not addressed (out of agreed scope, logged): AI phase-narrative/anchor pass,
weather, consular contacts, structured budget, the provisioning-retry endpoint,
`ready_private` not in `CORRECTABLE_STATES`.

---

## Status ledger (Claude, 2026-08-28)

Every numbered issue above, with where it stands. **None of the "Fixed" rows
are human-approved** — they are code changes on the branch, uncommitted,
awaiting your review/verification per the note at the top of this file.

Legend: **Fixed** = code written + tested this branch, pending your approval ·
**Partial** = part done, rest noted · **Deferred** = belongs to a later sprint
in `docs/onboarding-mvp-sprint-plan.md` · **Open** = no work yet · **Bug** =
reported, not yet reproduced.

### General comments

| # | Issue | Status | Detail |
|---|---|---|---|
| 1 | Telegram info messages (model switch, quota, compression…) → per-user logger, not to organizer | **Open** | Observability work, no owner in the plan. Belongs with Sprint 6 analytics. Flag for a decision on where the per-user log lives. |
| 2 | Hermes/Telegram commands shouldn't be available to a trip-group organizer | **Deferred** | Sprint 5 — Trip Context Gateway / router scoping. |
| 3 | Multi-answer buttons render in Hebrew, should be the organizer's language | **Open** | `interview.ts` / interview profile — the `clarify` option labels aren't localised. Not touched. Related to the choice-question UX memory. |
| 4 | LLM-parse unclear answers · carry-forward extraction · reconcile end-summary vs `intake.json` | **Partial** | Deterministic side of the concrete failure (non-Latin `destination` → slug `trip-2026`): **still not fixed** — `derive_trip_slug`'s `"trip"` fallback should use the first phase name; unchanged this session. The LLM-parse / carry-forward / summary-reconcile behaviour is interview-profile work, not started. Tracked in memory `interview_llm_parse_and_summary_reconcile`. |

### Step 2 — DM approval message

| # | Issue | Status | Detail |
|---|---|---|---|
| 1 | Approve/deny message should edit itself to show the action taken | **Open** | Control-plane Telegram approval adapter — not touched. |
| 2 | Bot can't initiate a DM → the token link should come from the onboarding site first | **Deferred** | Sprint 5 + landing-spa worktree. Memory `onboarding_requires_clickable_start_link`. |
| 3a | Flow: onboarding site → interview bot (with token) → personal bot → `@kinerary_bot` | **Deferred** | Sprint 5 router. |
| 3b | No "(Recommended)" tag on constraint answers (dates, number, organizer) | **Open** | Interview-profile prompt rule — not touched. |

### Step 3 — Interview bot

| # | Issue | Status | Detail |
|---|---|---|---|
| 1 | Choice questions: buttons only, no numbered list in the message text | **Open** | Interview profile — memory `interview_choice_questions_ux`. Not touched this session. |
| 2 | Don't recommend trip constraints (type/size/duration); recommend places/hotels/attractions | **Open** | Interview profile. Not touched. |
| 3 | "Number of people" is confusing → ask who's coming (names + ages), derive the count | **Open** | Needs an `interview.ts` schema change (derive `group_size` from `travelers`). Not started. |
| 4 | Duration is derivable from the dates / onboarding site | **Open** | `interview.ts` / landing-spa. Transformer already prefers explicit dates over the duration band; the interview still asks both. |
| 5 | Bot asked permission to read a pasted link — should be automatic for the organizer | **Open** | Hermes `trip-intake` profile approvals/capability config. Not touched. |
| 6 | If a link can't be fetched, fall back to scraping | **Open** | Same as #5. |
| 7 | **Bug** — dietary restriction step threw an error | **Bug** | Not reproduced yet. Needs a repro run against the interview MCP. |
| 8 | Schedule/planned-order should allow multiple answers + a flight-details option | **Open** | `interview.ts` `phases`/anchors schema. Not started. |
| 9 | **Bug** — schedule registration failed to submit | **Bug** | Not reproduced yet. |
| 10 | Interview should say daily-itinerary help happens on the trip bot; the interview is for structure | **Open** | One line in `SOUL.md` / `QUESTIONS.md`. Not added this session (SOUL.md already disclaims trivia/photos/budget/venues, but not the itinerary specifically). |
| 11 | After CONFIRM the user is in a dead-end — no link to the site or bot | **Deferred** | Sprint 5 router; same root as Step 2 #2. Memory `onboarding_requires_clickable_start_link`. |
| 12 | **Note** — the Claude-Code approvals could be driven by the Hermes intake profile / personal bot via MCP; explore | **Open** | Exploration item, not scoped. |
| 13 | Verify the English spelling of non-English traveller names | **Partial** | Transformer now honours supplied `name_en` / `family_en` (`NonLatinNameTests`, prior run). The interview does **not** yet prompt the organizer for them — `QUESTIONS.md` `travelers` section unchanged on this point. |

### Step 4–5 — code defects (prior run)

| # | Issue | Status | Detail |
|---|---|---|---|
| 1 | `pct create` made unprivileged containers → NFS EACCES mid-bootstrap | **Fixed** (prior) | `provisioning/adapters.py` — `--unprivileged 0`, regression test. |
| 2 | Bootstrap installed no compiler → `better-sqlite3` build fails | **Fixed** (prior) | `adapters.py` — `build-essential` in the apt line, test. |
| 3 | 35 s SSH deadline killed the multi-minute bootstrap | **Fixed** (prior) | `SubprocessSshTransport` — separate `command_timeout` (900 s), test. |
| 4 | NPM forwarded to the unresolvable `trip-*` LXC name → 502 | **Fixed** (prior) | `compute.py` — `forward_host` = container IP, test. |
| 5 | Failures reported stderr (ssh noise) not stdout; locale spam hid the real error | **Fixed** (prior) | `provisioner.py` reports both streams + tail; `LANG=C.UTF-8` pinned in bootstrap. `ShellDeployAdapter` now has tests. |

### Step 4–5 — process gaps

| Issue | Status | Detail |
|---|---|---|
| No retry path after a provisioning failure (`PLAN_ALREADY_PENDING` on re-plan) | **Open** | Needs a real endpoint. Every retry still needs manual DB cleanup. Decision required. |
| `_bootstrap_app_environment` only runs in `create()`, never repairs a half-built container | **Open** | Not started. |
| Job lease (600 s) < bootstrap ceiling (900 s), no heartbeat | **Open** | Not started. Harmless while bootstraps take ~140 s. |
| `provisioning.env` must set every `PROXMOX_*`/`RPI_*` explicitly (compose `${VAR:-}` beats code defaults) | **Mitigated** | All vars are set in `~/kinerary-deploy/provisioning.env` now. Root cause (compose passing empty strings) not changed. |
| Compose v2.13 ignores all but the last `--env-file` | **Mitigated** | Single `--env-file` in use; `CONTROL_PLANE_CHAT_ROUTING_KEY` mirrored into `provisioning.env`. |

### Step 4–5 — data gaps in the generated site

| Issue | Status | Detail |
|---|---|---|
| `travel_anchors` dropped from the config | **Fixed** | `derive_bookings()` → `bookings.json` sidecar (hotels + dated anchors, phase-mapped). Two follow-up bugs found during the 2026-08-28 re-provision and fixed: the site's `bookings` table is `CHECK(type IN ('flight','hotel','car','attraction','other'))` and `phase TEXT NOT NULL`, so the first pass's `type:"activity"` rows and the `phase:null` proposal row were silently dropped by `INSERT OR IGNORE` (only 5/12 seeded). Now maps activity-like → `attraction` and parks an unphased anchor on the first phase. All 12 seed. |
| No `trivia_questions.json` / `bookings.json` (ENOENT every boot) | **Fixed** | `bookings.json` generated; `trivia_questions.json` written as `[]` (documented descope). |
| Family name not transliterated (`{he:סולומון, en:סולומון}`) | **Partial** | Honoured when the intake supplies `family_en` (prior run). Auto-transliteration when it doesn't = the LLM pass (General note 4), not done. |
| `derive_trip_slug` can't romanise non-Latin, falls back to literal `trip` | **Partial** | Worked around mid-run last time via `intake/correct`. The `"trip"` → first-phase-name fallback improvement is still **not done**. |

### Trip Website review + Bot wiring

See the "Website review — agent response" table just above — #1 partial, #2/#3/#7 done (deterministic), #4 partial (emergency = static table; consular contacts not done), #5 bookings done / budget not built, #6 used as the reference shape, Bot wiring = Sprint 5 (with `HERMES_API_KEY` pulled forward into the bootstrap).