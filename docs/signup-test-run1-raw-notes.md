# Signup Run 1 — raw manual notes (archive)

Dror's verbatim run-1 notes plus the agent debriefs, moved out of
`signup-test-execution-capture (Manual).md` on 2026-08-29 to keep that
file small. **Nothing here is a live TODO** — every item has been triaged
into `docs/onboarding-mvp-sprint-plan.md` (Sprint 4.5 / 4.7 / 5) and is
tracked in the Status ledger that remains in the capture file. Kept for
provenance and the exact original wording.

---

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
