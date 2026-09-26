# Regression plan: Release A, the first Sprint 6 upgrade of the production control-plane VM (sprint mode)

**Verdict: CONDITIONAL. `b04e229` cannot go to the VM until the owner answers one question: D1, the organizer-document route (§3.1). After that, it is GO once gates G1–G9 (§7) are all met.**

- **The finding that blocks.** Release A is meant to change no trip site (decision 28). It still gives both live trips' organizers a new way to rebuild their own site in the middle of the trip. The route: send a PDF or photo to the bot in a private chat, then tap **Approve**. The relay then calls `correctIntake` and `provisionOnConfirm`, which rebuilds the trip on the newest `available` release, `130924b`. For Orlando that means losing its hand-deployed connector and getting a regenerated config. For Japan it means site code from 8 days later, on its last day.
- **Both live trips meet every precondition of that route today.** Measured: a confirmed session with a chat, an open binding on that chat, one owner, schema 3 accepted by `130924b`, and a model runner configured.
- **Recommended answer to D1: (a).** Put the route behind a flag, off by default, in one small PR. The #217 walk then comes off the Release A gate.
- **Recommended window, before 3 Oct:** **Fri 2 Oct 2026, dry-run at 13:30 UTC, relay restart about 14:00 UTC, done by 15:30 UTC.** That is 16:30–18:30 IDT, 22:30 JST → 00:30 JST on Japan's last night, and after Orlando has ended. §5 has the fallback and the case for waiting until after 3 Oct. Before booking it, check whether the owner is free on Friday afternoon in Israel (§9 Q3).
- **What changes nothing in this verdict:** all 13 migrations are additive and declared `compatible`. I checked their backfills against production-shaped counts. A code-only rollback keeps the database. Hermes, trip sites and releases are untouched.

Planned for **`b04e229`** (tip of `origin/integration/sprint-6`, fetched 13:50Z 2026-09-26). Its code is identical to `9f51bf2`: `git diff 9f51bf2 b04e229` touches only `CHANGELOG.md` and two docs. All six CI jobs on `9f51bf2` passed. On `b04e229`, "TypeScript API" was still running at 13:52Z and the other five had passed.

**What invalidates this plan:** a new tip that touches anything outside `docs/`, `*.md` or `.github/`. That includes `control-plane/**`, `provisioning/**`, `scripts/companion-install-host.sh`, `profile-templates/**` or `.agents/skills/create-trip/**`. Also invalidating: a new migration; any release promoted to `available`; a change to the VM's `KINERARY_REV`/`HERMES_REV`; a new trip reaching `ready_private`. The D1(a) flag commit is expected, and needs only a 10-minute delta check (§6). Docs-only commits, such as open PR #239, do not invalidate it.

Assessed by `regression-planner`, 2026-09-26, sprint mode, locally, with read-only production probes under the MVP probe rule.
- I printed no key and read no traveller text. Every production read below is a count, a name, a version or a state.
- No DB suite was run, and ports 5433/5434 were not touched.
- No restart, no `kinerary-cp-release` call (not even `--dry-run`), no `docker cp`, no config edit, no commit.
- The only code I ran: `python3 -m unittest tests.scripts.test_vm_release` (70 tests, OK, 4.8 s wall), and the tool's own `classify_migrations` over the 13 new files.

---

## 1. Change set

**Range.** The VM runs `130924b`. That is a merge commit on `main` (#164), and it is **not** an ancestor of the target.
- The merge base is `810795a`. `git log 810795a..b04e229` lists 230 commits: 55 first-parent merges and 67 direct commits.
- The effective change for the VM is `git diff 130924b b04e229`: 379 files, +70,813/−1,689.
- Main-only commits in `130924b` that are not in the target:
  - `e2558fc` (mime sniff) is carried as `2c70c01`/#166.
  - `6f6b9d9` is carried as `59ed025`.
  - `1261d2a` has a patch-equivalent (`git cherry`).
  - `b451ee7` (#109) is carried by hand as `a58ac96`: same files, same subject.
- **Nothing the VM runs is lost by the upgrade.**

| Surface (agent §2 row) | What changes | Reaches, and when |
|---|---|---|
| `control-plane/api/src/` (53 files) | #199 typed changes (#206/#205/#114), #230 and #234 (#225 items 1, 3, 5, 7, 8, 9, F-b), #192/#218 allow-listed child env, #178/#179 organizer DM documents and companion-down quietness, #181 assistant events (off by default), #180/#176/#174 retired-trip bindings, #95 operator invitations (unmounted: no `CONTROL_PLANE_OPERATOR_KEY` in `compose.vm.yml`), #47 `/trips` `/switch`, Slice B document intake (#145/#92) | everyone, at the API/relay restart |
| `control-plane/api/src/relay/` (10 files, +3,327/−299) | all of the above that runs in the relay, plus **new behaviour a live family can see**: `group-context.ts` (unaddressed group messages from the last 15 minutes, up to 10, are passed to the companion with the next addressed message; always on, `poller.ts:5030`), #64 reply capture (0053; dormant unless Hermes sends `metadata.expects_reply`), and the command menu gaining `/trips` and `/switch` (set at relay boot) | every live Telegram chat, at the relay restart |
| `control-plane/worker/`, `provisioning/` | transformer (destination info #156, packing #162/#167, RSVP activities #169, uncovered days, #109), `document_handoff.py`, provisioner, `adapters.py` (#228's three nginx `location` blocks), `compute.py` | **only trips provisioned or re-provisioned after the upgrade** |
| `control-plane/db/migrations/` | **13 new files** (§3.2) | everyone, irreversibly, at migrate (before any container restarts) |
| `site/`, `server/`, `shared/`, `trip-web/` (release payload: #211 hardening, #196 allow-list, #228 connector, `site/modern`) | nothing on the VM. **Release A promotes nothing** (assumed; Q2) | no existing trip; no new trip either, because new trips build on the newest `available`, `130924b` |
| `scripts/companion-install-host.sh`, `profile-templates/` | changed. The VM's `hermes` forced command runs `/opt/kinerary/scripts/companion-install-host.sh` (measured), the checkout the upgrade switches | companions installed **after** the upgrade. Live companions are not refreshed |
| `.agents/skills/create-trip/` | changed | new trips only |
| `control-plane/deployment/` | only `vm-invite*.{py,sh}` added. `vm-release.py` and `vm-relay-restart.sh` are byte-identical at `130924b` and `b04e229` (sha256 `52520d77…` / `f0478bdb…`), and the installed `/usr/local/sbin/kinerary-cp-release` matches (measured) | the tool that runs the upgrade is the one already installed |
| Hermes | untouched: `HERMES_REV` stays `ab0d98414-pbf43d580`; `upgrade` without `--hermes-rev` does not restart it (`vm-release.py:1249-1253`). The #189 upgrade is separate | — |
| Sidecars | `interview-mcp` and `companion-mcp` are recreated on `b04e229`. **`inbound` is not**: it is not in the `up` list at `vm-release.py:1243`, so it stays on `agent-runtime:810795a` (measured). That is harmless, but verify does not check it | at the upgrade |

<details><summary>Merged PRs in range (first-parent, 810795a..b04e229)</summary>

#234 #237 #236 #235 #232 #233 #230 #231 #228 #226 #199 #224 #218 #215 #211 #204 #192 #196 #197 #181 #180 #176 #174 #171 #166 #165 #108 #149 #144 #150 #160 #158 #148 #89 #95 #145(Slice B forward-port) #147 #151 #136 #143 #141 #142 #91 #139 #140 #138 #81 #64 #47 #73 #80, plus merges of main (`b4fed9b`, `37be82e`). Not in range and open: #239 (CLAUDE.md, docs), #116 (document-store bootstrap, §8 Q5).
</details>

## 2. Risk table

| # | Change | Surface | Blast radius | Migr. | Compat. break | Risk | Test | Min | Batch |
|---|---|---|---|---|---|---|---|---|---|
| R1 | **#178: an organizer's DM document → proposal → Approve → `provisionOnConfirm`** | relay + API | **both live trips' organizers, mid-trip**, and every future confirmed organizer | 20260918110132 | **rebuilds a live site on `130924b`** (§3.1) | **high: one-way, live trip** | none can make it safe. It is a decision (D1). If shipped live, the #217 walk | 0 (a) / 20–40 + provisioning (b) | isolated: its own decision |
| R2 | Relay restart itself | relay | every live chat | — | — | medium: ~1 min pause, up to 40 s waiting for companions (runbook). A companion reply in flight at that moment may be lost (carried, #230 §4) | verify + H | 1–2 | — |
| R3 | #230/#234 Telegram client: 429 wait (≤3 s), 10 s bound, "telegram call timed out" to Hermes | relay | every Bot API call the relay makes, companions included | — | Hermes classifier mirrored in a test; the VM image was read by the lead (F2 closed) | medium: timing, fleet-wide | CI (pinned) + H | 7 | isolated (log) |
| R4 | #199 typed changes, #230/#234 step retry | relay | interpret-path interviews only. **Confirmed sessions are refused everywhere** (#230 §3, `interview.ts:2009,2027`) | 20260925180000 | old relay orphans `pending` drafts on rollback | medium: a model in the loop | CI; real-model run 113/114 (still valid, §6); walk D | ~100 (Dror, walk) | batched: one walk |
| R5 | Group context, reply capture, #179 outage quietness, `/trips` `/switch` menu | relay | **live families' groups and DMs** | 0053, 0052 | none in schema. Behaviour: the companion now *knows* recent unaddressed group chat | medium: visible, not data loss; privacy of family small talk (Q4) | unit tests; walk W5 | 10 | batched: walk |
| R6 | New worker × `130924b` site release | worker | trips built after Release A: the real organizer's open interview, if confirmed | — | sprint-6 transformer fields served by `130924b`'s **deny-list** `sanitizeConfig` (`server.js:729` at `130924b`); #196's allow-list is not in that release | **unsized**: security path → `boundary-reviewer` (Q6) | none yet | 20 (review) | isolated |
| R7 | 13 migrations | DB | all rows | yes | additive; backfills fit production data (§3.2) | low | CI fresh + upgrade; probes; rehearsal test | 5 | isolated (dry-run) |
| R8 | #228 nginx blocks in `adapters.py` | worker | **new containers only**. Orlando's and Japan's nginx are never rewritten (bootstrap only on create/half-built, `engine.py:102`, carried from the #228 plan) | — | the blocks proxy `/mcp` and `/oauth/`; Express 404s them because `130924b` has no connector | low | `tests/provisioning` (CI) | 0 | — |
| R9 | #192/#218 claude child env inside the Linux relay container | relay | every interview model call | — | allow-list keeps `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR` (`model-runner.ts:529`), read by me. **Never run in the VM's container** | medium, and **silent** (the router just does less) | post-deploy runner probe P2 | 2 | isolated assertion |

## 3. Migration and compatibility findings

### 3.1 R1: the organizer-document route rebuilds live trips (read in code, preconditions measured)

The chain, read at `b04e229`:
1. `dispatch.ts:975-1011`: a private chat whose sender is the chat, with a readable attachment and a model runner, is routed to `organizerDocumentRoute`, then `confirmedOrganizerChat` (`document-correction.ts:125`). That needs a `confirmed` session on this trip with this `telegram_chat_id`.
2. `poller.ts:771` → `approveCorrection` → `correctIntake`. `ready_private` is in `CORRECTABLE_STATES` (`intake-correction.ts:32-40`). It supersedes the executed plan and sets `lifecycle_state = 'intake_confirmed'`.
3. `poller.ts:789-795`: `provisionOnConfirm` runs `generatePlan` and `issueApproval` (`planner.ts:437`), so a worker job follows.

`confirmedOrganizerChat` does not exist at `130924b` (`git grep` is empty). On production today, such a file goes to the companion.

**Measured on the VM (counts only):**

| | Orlando | Japan |
|---|---|---|
| confirmed session with a chat | 1 (lang `he`) | 1 (lang `en`) |
| open binding on that organizer chat | 1 | 1 |
| active owners | 1 | 1 |
| executed plan's release | `release_276dcf8b…` (`cea047d`) | `release_ee61ecd6…` (`8f4d4e1`) |

Other measured facts:
- Every `available`/`verified` release accepts intake schema 1–3, and both revisions write schema 3.
- The newest `available` is `release_ad97b4bd…` (`130924b`).
- `release_58b8e3b2…` (`fbf3899`, the connector) is `verified`, not `available`.
- Provisioning is on: `PROVISIONER_COMPUTE_ENABLED`, `…_COMPANION_PROFILE_ENABLED` and `…_MCP_BRIDGE_ENABLED` are all `1`.

**So after Release A, one PDF and one tap rebuilds a live trip.**
- The effects, carried from the trip-mcp plan §4, whose mechanism was verified in code on 2026-09-25: config overwritten through `--sync-config`, enrichment re-run, lifecycle flipped mid-holiday. Orlando also loses the connector code (grants go dormant).
- A boarding pass on Japan's departure day is exactly the file this route would catch.
- **This contradicts decision 28 ("without redeploying any trip site") and decision 11.**
- **A rollback of Release A does not undo it.**
- #217 already asked "ship dark or walk". Release A turns that open question into a precondition.

### 3.2 The 13 migrations

Production has **51 applied**, the last being `0051_trip_person_links.sql` (applied 2026-09-12); `0050` has never been applied (measured). The target's files are a superset of the applied set (`comm`), so there is no "downgrade" refusal (`vm-release.py:1471-1473`). The tool's own classifier, run over the 13 new files, says **`compatible`, 13 of 13**. So the tool will record "code-only rollback keeps the database".

| Migration | What touches existing rows | Production-shaped check (measured) | What a keep-DB rollback leaves behind |
|---|---|---|---|
| `0050_plan_reviews` | 2 nullable `trips` columns; 2 tables | runs **after** 0051, out of numeric order. No dependency between them (read) | ignored by old code |
| `0052_telegram_organizer_links` | backfill `INSERT … FROM intake_sessions WHERE telegram_chat_id ~ '^[0-9]{1,20}$'`, `ON CONFLICT DO NOTHING`; `user_id NOT NULL` + FK | 28 candidate sessions, 0 NULL `user_id`, 0 missing user, 0 non-digit chat ids → cannot fail | orphan table, ignored |
| `0053_companion_reply_capture` | `trips.companion_reply_capture_enabled boolean NOT NULL DEFAULT true`; 2 nullable binding columns | 44 bindings; instant | ignored |
| `0054_companion_bug_reports`, `…129_document_registry`, `…130_answer_provenance`, `…131_model_task_settings`, `…143012_assistant_events` | new tables only | — | orphan tables |
| `…132_document_corrections` | new table | — | **a `pending` correction is orphaned.** Count it before rolling back |
| `20260922060000_organizer_invitations` | `trips.hermes_profile` + `CHECK (char_length(btrim(…)) BETWEEN 1 AND 64)`, **backfilled from bindings** | 44 bindings with a profile, longest 32 after trim, 0 blank → the CHECK holds | column ignored by old code |
| `20260922060001_one_organizer_per_address` | data repair driven by `organizer_invitations` | that table is created empty in the same run, and `CONTROL_PLANE_OPERATOR_KEY` is not passed on the VM → **a no-op on production** (its own comment says so; confirmed by structure) | nothing |
| `20260922120000_destination_info` | 3 `country_reference` columns with defaults | — | ignored |
| `20260925180000_intake_pending_changes` | new table | — | `pending` drafts orphaned. Count first (runbook) |

- **Failure mode, if migrate fails anyway:** the checkout and `vm.env` go back, and no container has been touched. Earlier files may have committed; all are compatible, so the old code runs on them (`vm-release.py:1225-1237`).
- **Expected noise:** none from `migrations.test.ts`. The lists are already updated in-tree, and CI is green on `9f51bf2`.
- **What `migrations.test.ts` does not prove:** "0051 applied, 0050 not". It builds empty databases. The probes above cover the three data-dependent statements.
- **Rehearsing the upgrade against a restored copy** would prove the rest. I rank it optional (§8.6), because a failure is loud and leaves the old code running.

### 3.3 Other compatibility points

- **Intake schema:** 3 on both revisions (read); releases accept 1–3 (measured). No ritual migration is needed.
- **Old site release × new worker (R6).** `130924b`'s `sanitizeConfig` is the pre-#172 deny-list. Every new field the sprint-6 transformer writes is served raw behind `authRequired`: `phases[].packing`, `rsvp_activities`, destination info.
  - `HERMES_DESTINATION_INFO_PROFILE` and `HERMES_SEARCH_PROFILE` are **not** in the worker's environment (measured), and `compose.vm.yml` does not pass them. So the #156 `origin: hermes:<profile>` class should not be produced.
  - That is an inference. It is a security path, so it goes to `boundary-reviewer`.
- **Document store.** No `DOCUMENT_STORE_*` in the relay or the worker (measured), and `compose.vm.yml` passes neither. The relay's fatal branch (`relay/server.ts:247-257`) therefore cannot fire.
  - Uploaded originals are read but **not kept**, silently (no log line when unset).
  - Doc drift: comments in `relay/server.ts:244` and `worker/__main__.py:425` say `compose.vm.yml` sets `DOCUMENT_STORE_REQUIRED=1`. It does not.
- **Runner settings on the VM relay (measured):**
  - `INTERPRET_PATH_DEFAULT=1`; `INTERPRET_RUNNER` and `EXTRACT_RUNNER` are `claude`, both models `claude-sonnet-5`.
  - No `*_EFFORT`. Effort comes from `CLAUDE_CONFIG_DIR`'s `settings.json`, `"effortLevel": "medium"`. The `compose.vm.yml:220` comment says `xhigh`, which is doc drift.
  - **No `ITINERARY_EXTRACT_TIMEOUT_MS`**, so the code default of **60 s** applies (`itinerary-extract.ts:24`, same on both revisions). CLAUDE.md says 120000 "must reach the relay process". The Mac's document walks therefore run with a longer timeout than production.
- **After the upgrade, production runs a commit that is not on `main`** (decision 33). The trip-monitor gate refuses non-`main` commits (`vm-release.py:2031`). `upgrade main` would then be refused as a downgrade, because 13 applied migrations are unknown to `main`. **Until sprint 6 reaches `main`, the only way to change production is `rollback` or another sprint-6 commit** (Q7).

## 4. Live-fleet impact (measured 2026-09-26, 13:2x–13:5xZ, unless marked)

**Five probes owed since #199, done:**

| # | Probe | Result |
|---|---|---|
| 1 | Revision and images | `vm.env`: `KINERARY_REV=130924b`, `HERMES_REV=ab0d98414-pbf43d580`; checkout HEAD `130924b`, clean. Running: api, worker and companion-mcp on `130924b` images; relay and interview-mcp on `agent-runtime:130924b`; `inbound` on `agent-runtime:810795a`; `hermes` on `kinerary-cp/hermes:ab0d98414-pbf43d580`; postgres 16. **The brief is verified.** |
| 2 | `interpret_path` | all sessions: `true 28`. Created in the last 14 days: `true 22`. No agent-path session exists |
| 3 | Geresh (#199) | `trip_answer_sources` and `trip_answer_conflicts` **do not exist on production** (0 of 4 sprint-6 tables found in `information_schema`). They arrive empty with the upgrade. Wider count: intake versions containing ׳/״: **0 of 37** (Orlando 0/1, Japan 0/3); open session answers: 0 of 1. **The `identityFold` risk is nil on the live fleet** |
| 4 | Relay runner settings | §3.3 |
| 5 | Open interviews | 8 not confirmed. 7 are expired. **1 is not: `interviewing`, `awaiting=person`, phase `opening`, `en`, idle 76 h, `expires_at` NULL** (trip `draft-sreq-a46…`, `intake_in_progress`, session created 2026-09-23 09Z). Guard query (mid-turn): 0. Open agent turns: 0. Jobs in flight: 0 |

**Trips:**
- Live: `orlando-florida-2026` and `japan-tokyo-hakone-kyoto-osaka-2026` are `ready_private` and reachable. They are the only two slugs in the tool's `live_companions` set; 0 retired trips are in it.
- 2 `intake_in_progress` drafts, 3 `draft`, and 15 `retired-*` rows in the 20 most recent.
- The Orlando connector's container code (`fbf3899`, hand-deployed) is **carried** from the #228 plan (2026-09-25 `pct exec`). I did not re-read it (no Proxmox access in this run).

**Measured load.** In 56 h of the current relay's log (09-23 16:26Z → 09-26 01:11Z), there were 29 inbound updates, 11 of them companion-routed from an identified sender. Their UTC hours were 18, 11, 15 and 00. `getUpdates` failed with 502 ×10 and 504 ×1.

**Who feels what, and when:**

| Who | What they feel | When |
|---|---|---|
| Orlando and Japan families | relay pause (~1 min; messages wait at Telegram); the menu shows `/trips` `/switch` in private chats; group replies now carry up to 10 recent unaddressed lines; companion-down quietness (#179); 10 s bound and 429 retry on companion sends. Hermes is untouched | at the relay restart and after |
| Their organizers | **R1**, unless D1(a); `/trips` and `/switch`. Typed-change flows: **none** (confirmed sessions are refused) | after the upgrade, on their first DM document |
| The real organizer (`draft-sreq-a46…`) | the whole interview stack: #199, #230, #234. **#205 is live on production today**: `e2ff4c8` is in `130924b`, and `poller.ts:1267/1624` writes the raw proposal. Release A fixes it for them. If they confirm, their trip is built by the sprint-6 worker on the `130924b` site (R6) | their next message |
| Trips built later | same as the row above, until a sprint-6 release is promoted (Release B) | — |
| Websites | nothing | — |

**What a live trip needs to get a fix: nothing in Release A is meant to reach a trip site.** #211, #196 and the connector reach Orlando and Japan only by a hand redeploy after 1 Oct and 3 Oct (decision 11), with a promoted sprint-6 release and its own plan. **Never run `retryProvision` on either trip while `release_58b8e3b2…` is verified-not-available** (decision 18, the #228 plan §4): it rebuilds on `130924b`. R1 is the same action, reached from Telegram.

## 5. Window

**Constraints:**
- Orlando: US-Eastern, EDT = UTC−4. Its night (22:00–08:00) is 02:00–12:00 UTC. It ends 1 Oct.
- Japan: JST = UTC+9. Its night (22:00–08:00) is 13:00–23:00 UTC. It ends 3 Oct; 3 Oct is likely a travel day.
- The owner (IDT = UTC+3) must be awake for the dry-run, the upgrade and the checks.
- The real organizer's time zone cannot be read from counts. Two timestamps (09Z and 15Z) fit a European or Israeli day, which is too little to plan on.
- No hour has both families asleep while Orlando is running (the #230 plan §4 reached the same result).

| Option | When (UTC) | Exposure | For | Against |
|---|---|---|---|---|
| **A, recommended** | **Fri 2 Oct, 13:30–15:30** (restart ~14:00 = 17:00 IDT, 23:00 JST) | Japan asleep on its last night; Orlando over; measured load is ~0.5 companion messages per hour | honours "before 3 Oct"; Orlando is out of the R1 exposure; the owner is awake | Japan has one exposed day (3 Oct) under R1 unless D1(a); **Friday afternoon in Israel, and possibly a holiday eve (not verified)**: confirm the owner is free |
| A′ | Thu 1 Oct or earlier, 12:30–13:30 | Orlando at breakfast (08:30 EDT), Japan 21:30 JST | earliest fix of #205 for the open interview | both families awake-ish; both organizers exposed to R1 for their remaining days |
| B, after both end | Sun 4 Oct or later, 06:00–09:00 (09:00–12:00 IDT) | no live trip | no mid-trip exposure at all; R1 then only rebuilds finished trips; the relay pause touches nobody on holiday | the open interview keeps #205 for 2 more days (its organizer has been idle 76 h in phase `opening`, measured, so the exposure is small); goes against decision 28's choice |

**My reading:**
- On risk alone, B is lower, and D1(a) closes most of the gap between A and B.
- With D1(a), A's residual exposure is a ~1 minute pause at 23:00 JST.
- Without D1(a), A exposes Japan's organizer on departure day. I would then recommend B.
- Either way, the Mac walk session (§6 W) has to finish before the window, and **the nightly e2e must be off that night** (decision 27).

## 6. The plan

**Pre-window (the lead, the owner and a developer), in this order:**

| # | Run | Command / where | Checklist | Min | Who |
|---|---|---|---|---|---|
| P0 | **D1 decision** | — | (a) flag, (b) accept + walk #217, or (c) window B | 0 | owner |
| P1 | *(if D1a)* the dark flag | developer: gate `organizerDocumentRoute` on an env flag that defaults off (`compose.vm.yml` passes nothing, so it is off on the VM); one dispatch test "flag off → organizer DM document goes to the companion"; then CI | test fails without the gate; "TypeScript API" green | 30–45 dev (est.) + 14 CI (measured 14m05s on #234) | developer, verifier |
| P2 | Delta check on the new tip | `git diff --stat b04e229 <tip> -- ':!docs' ':!*.md'` equals exactly P1's files | anything more → re-plan | 10 | lead |
| P3 | Tool unit tests on the tip | `python3 -m unittest tests.scripts.test_vm_release` | 70 OK | 0.1 (measured 4.8 s) | lead |
| P4 | **Rollback rehearsal, off-production** | `python3 -m unittest tests.scripts.test_vm_release_rehearsal` on the Mac (Docker; its own Postgres container, not 5433/5434). **Not run by me: it is DB-backed** | 4 tests: dry run changes nothing; upgrade then `--restore-db` rollback; a failing-migrate rollback undoes itself. **It does not cover the plain keep-DB rollback**, which is Release A's way back. That path has **never run on production** (history: one baseline and two upgrades, no rollback) | ~5 (est.) | lead |
| P5 | `boundary-reviewer`: R6 | build a config with the `b04e229` transformer from a `multi` fixture, and diff its paths against what the `130924b` `sanitizeConfig` passes | no internal identifier, key or `hermes:` origin in the served paths | ~20 (est.) | boundary-reviewer |
| W | **The ONE throwaway-trip session** (below) | Mac, `@Tripinterviewer_bot`, stack from the exact release commit; hard-rule-2 prompt for the Mac deploy; no VM run and no nightly overlapping | below | ~110 with Dror, plus provisioning (est.) | Dror + lead |

**W: the throwaway-trip session.** Scenario `multi` or `manual`, **never `japan`**: the fixture collides with the live trip.

Setup (lead, ~10 min):
- Bring the stack up from the release worktree with `WORKER_REPO_ROOT_HOST=$PWD`.
- Match the VM's runner settings: claude, `claude-sonnet-5`, medium effort. **Set `ITINERARY_EXTRACT_TIMEOUT_MS=60000` for this session**, which is what the VM runs.
- Confirm the Mac's newest `available` release is a `130924b`-equivalent, so the trip is built as production would build it. If it is a sprint-6 release, R6 is not exercised; say so in the report.

Interview half (carried D1–D11 from the #199 round-3/4 plans, D12–D14 from #230/#234):
1. D1–D2: a typed change is previewed and applied only on Yes (EN, then HE `כן`).
2. D3: an old Yes after a follow-up and a relay restart gives `change.updated`, and nothing is applied.
3. D4: Confirm while a change waits is refused, and the change is shown.
4. D5–D6: Cancel restores the displaced question; the old Cancel after a follow-up still cancels.
5. D7: preview "remove <stop>", upload a hotel PDF dated inside it, tap the old Yes: nothing is applied, and the new preview lists the booking.
6. D8: a bare "no" to the next question while a change waits. Note the result (decision 16a).
7. D9 and D11: travellers with ׳, an emoji and a ZWNJ are shown unaltered.
8. D10 and **D12**: tap the old Yes within about 5 s of a follow-up. Expect "Done", the offer, then **one** v2 preview. After settling it, the offer is the last message. Log: `change_floor_taken_back {"reply":"change_preview"}`, `change_displaced_moved`.
9. **D13**: an unclear follow-up while a tap wins. The tap's reply comes first, then "not understood" once.
10. **D14**: upload two documents that disagree during the interview.
    - `grep -cE 'telegram_api.call_timed_out|trip_bot.step_send_failed|trip_bot.step_send_abandoned|trip_bot.step_retry_failed'` = 0.
    - `grep -c '"skipped":true'` = 0.
    - Every `step_sent` prompt appears on screen exactly once.
    - The first optional question arrives after "a few more questions".
    - The disagreement is asked once.
11. Read `interpret_path` off the session.

Confirmed half:
12. Confirm, and let it provision.
13. *(if D1a)* A PDF to the organizer DM goes to the **companion**, not a proposal. `grep -c document_correction` = 0. (3 min.)
    *(if D1b)* The #217 walk instead: PDF → proposal → Approve and rebuild; a DM photo; the outage line with the gateway stopped (+20–40 min).
14. W5 (new in this plan): bind a family group. Send 3 unaddressed lines, then address the companion: its reply may refer to them (group context). Stop the gateway: an unaddressed line gets silence, an addressed line gets one generic line (#179). Start it again. Then `SELECT count(*) FROM control_plane.telegram_chat_bindings WHERE awaiting_reply_since IS NOT NULL` on the Mac database: expected 0 (reply capture dormant with this Hermes).
15. Open the built site's Info, Packing and RSVP views (R6 as rendered).
16. `scripts/teardown-trip.py --trip <slug> --execute`. Mac teardown is pre-approved; this also exercises the cascade over drafts and corrections.

G, the Hebrew read (Dror, ~25 min carried + 2):
- Round 3's four strings and round 4's six keys (`change.warn.*.more` / `.moreNonRefundable`, `change.droppedUnshown`, `change.uneditable` with its nouns).
- The #230 pair: `changePendingBlocksConfirm` followed by `change.sendFailed`.
- **New here:** the menu descriptions `trips` / `switch` (`command-menu.ts`). Live Hebrew-speaking organizers will see them.

**The real-model run does not need repeating.** `typed-change-real-model-2026-09-26-after-round4.md` (113/114, 0 false positives, tree `72a288b`, effort medium, matching the VM) still holds: `git diff 72a288b b04e229` on `intake-copy.ts`, `interpret.ts`, `typed-changes.ts`, `typed-changes-render.ts` and `model-runner.ts` is empty.

**The window (the lead, with the owner's word at each step):**

| # | Step | Command (on the VM, by a person, over SSH; not through the trip-monitor gate, which refuses non-`main`) | Pass | Min |
|---|---|---|---|---|
| V0 | Fleet re-read (T−10) | the §4 probes 1 and 5, plus `SELECT id,status FROM control_plane.releases ORDER BY created_at DESC LIMIT 2`, plus `SELECT count(*) FROM control_plane.users WHERE status='deleted'` (baseline for 060001) | as §4; no new trip past `intake_confirmed`; no interview mid-turn; newest `available` still `release_ad97b4bd…` | 5 |
| V1 | Plan | `sudo kinerary-cp-release plan <sha>` | 13 new, all `compatible`; "a later rollback can keep the database"; no downgrade | 2 |
| V2 | Dry-run | `sudo kinerary-cp-release upgrade <sha> --dry-run` | 0 problems: storage guard (measured today: backups on `ext4`, **no network filesystem mounted**, `/etc/fstab` has 0 nfs/cifs lines, `/` has 27 G free against 10 G + DB (12 MB) + 2 G), Proxmox preflight (pool thresholds, not readable by me), guards | 5–10 |
| V3 | Upgrade | `sudo kinerary-cp-release upgrade <sha>` | builds 3 images first (~1.6 GB, before the snapshot); dump + snapshot `pre-<sha>-…`; migrate; api, worker and sidecars; relay `--force-live`; verify all green; Dror notified. The last upgrade's switch through verify took 41 s (history: 16:26:20→16:27:01Z); the image build time is not recorded | 15–25 (est.) |
| V4 | **H, before any other restart** | `sudo docker logs -t kinerary-cp-relay-1 2>&1 \| grep -E` over the runbook's list (§"After a build that has #230 and #234"), plus `relay.ready`, `relay.gateways_awaited`, `relay.gateway_connected`; Hermes `trying plain-text fallback\|relay outbound timed out` | both companions connected; no failure names; `model_runner.claude_effort_unset` is **expected** on the VM (CLAUDE.md) | 5, then again after the first real interview |
| V5 | **P2, the runner probe** (turns R9 from silent to loud) | `sudo docker exec -i kinerary-cp-relay-1 node --input-type=module - < /opt/kinerary/control-plane/deployment/runner-probe.mjs claude claude-sonnet-5` (stdin, so no `docker cp`; the argv form must be checked: with `-` the args follow it) | `{"ok":true,…}`. One real model call | 2 |
| V6 | Data checks | `SELECT count(*) FROM public.control_plane_schema_migrations` = **64**; `organizer_invitations` = 0; `users` deleted = V0's baseline; `telegram_organizer_links` ≤ 28; `trips.hermes_profile` non-null ≥ 2 | as stated | 3 |
| V7 | `rollback --dry-run` (not executed) | `sudo kinerary-cp-release rollback --dry-run` | target `130924b`, images present (measured: api, worker and agent-runtime `:130924b`), "keeping the database", guards clean | 3 |
| V8 | Fleet monitor view | `fleet-mcp.mjs --tool list_trips` / alerts | two live trips `ready_private`; no new alert | 3 |
| V9 | Real-stack interview, **to the summary, NOT Confirm** | Dror signs up a throwaway organizer on `@Kinerary_bot`, runs a `manual`-style interview to the recap, and stops | `interpret_path` true; `interview.interpret_ok` > 0; no provisioning, so no container, DNS or NPM change. **Not `--auto`:** on the VM that points the live relay at a stand-in and holds every live family's messages for the run | 15 (est.) |

## 7. Go / no-go

**GO requires all of:**
- G0: D1 answered. If (a), P1–P2 are done.
- G1: every CI job green on the exact commit.
- G2: W passed. No D-item applied anything without a Yes, and every D14 count is 0.
- G3: G (the Hebrew read) accepted.
- G4: P4 green, and P3 70 OK.
- G5: P5 clean, or R6 accepted by the owner.
- G6: V1 and V2 clean.
- G7: V0 clean at T−10.
- G8: nightly e2e and Mac provisioning off for the window.
- G9: the owner's explicit word for V3 (hard rule 2).

**Stop before V3 if any of these hold:**
- The dry-run reports a problem.
- An interview is mid-turn: wait 5 minutes and re-run. `--force-live` only after telling the organizer.
- A job is in flight.
- A release was promoted.
- The tip moved.

**Roll back (`sudo kinerary-cp-release rollback`, keep-DB) if:**
- verify fails and is still red 2 minutes later;
- a companion is not connected after 5 minutes;
- V5 fails;
- V4 shows `relay.start_failed`, `42P01`, or `call_timed_out` bunched with no Telegram incident;
- the first real interview message errors.

**Before rolling back:**
- `SELECT count(*) FROM control_plane.intake_pending_changes WHERE status='pending'`, and the same for `trip_document_corrections`. Tell any organizer who has one.
- Cost: about 1 minute of bot pause (runbook).
- After Release A, a rollback is a guarded restart: a #234 retry episode can refuse it for up to about 278 s (runbook).

**Not undone by any rollback:**
- a rebuild R1 already started;
- answers applied, and intake versions written;
- trips built on the sprint-6 worker.

**The deeper ways back:**
- `rollback --restore-db`: refused once a trip has reached `provisioning` since the dump.
- `vm-restore-snapshot.sh` from the Mac: a whole-VM snapshot.

## 8. What would reduce the risk (ranked by risk removed per minute)

1. **D1(a): ship the organizer-document route dark (~45 min + CI).** It removes the only one-way action Release A hands to a live family, and it takes the #217 walk (20–40 min plus a provisioning cycle of Dror's time) off the gate.
2. **V5, the runner probe (2 min).** It is the only proof that the claude runner authenticates inside the Linux relay container under #192's allow-list. Otherwise that failure is silent.
3. **V4 with `-t`, before any restart (5 min).** The timestamps are gone once `vm-relay-restart.sh` archives the log.
4. **Promote no release before 3 Oct, and say it to whoever can (0 min).** A promotion would retarget both R1 and `retryProvision`.
5. **P5 on R6 (~20 min).** It turns an unsized serving question into evidence before the real organizer confirms.
6. **Optional: rehearse the 13 migrations against a copy of production (~20 min on the VM, a scratch DB named for it; needs approval because it writes a database).** Low value, because the backfills already fit the counts and a failed migrate is loud and leaves the old code running.
7. **Doc fixes for `doc-keeper` (~10 min).** The three drifts: the `DOCUMENT_STORE_REQUIRED` comments, `compose.vm.yml`'s "xhigh" comment, and CLAUDE.md's "`ITINERARY_EXTRACT_TIMEOUT_MS` must reach the relay" (it does not on the VM).

**What Release A does not do**, so nobody assumes it does:
- No trip site is redeployed, and no release is promoted.
- No Hermes upgrade (#189).
- Not the nightly e2e.
- No Track 2 build, and not the exit gate (Release B).
- It does not turn on operator invitations: `CONTROL_PLANE_OPERATOR_KEY` is absent from `compose.vm.yml`, and there is no `cpinvite` user (measured).
- It does not configure the document store (#116, §9).
- It does not close #225: items 2, 4 and 6, and follow-ups 10–26, stay open. **First after Release A:** the `fetchFile` byte-download timeout, which runs on the poll loop for photos and PDFs sent to companions. Then `sendOptionalOffer`/`speakBoundary` through `deliverStep`, then logging the unchecked sends, then `retry_after` in the step backoff, then the `getUpdates` client timeout.

**Sprint-mode notes:**
- **Entrypoint debt:** the Slice B document store has no boot-level presence on the VM. It is unset, and silent. Operator invitations are not deployable on the VM as composed.
- **Regression ring:** the Sprint 5 router (W covers it), group addressing (W5), `/trips` `/switch`, and signup approval through the relay (verify covers bot identity and polling only; one `/start` in V9 covers the rest).
- **What to stop testing:** the geresh probe (tables absent, 0 of 37 versions); F2 (closed by the lead's image read).

## 9. Questions for the owner (ranked)

1. **D1, the organizer-document route on live trips.** (a) Dark behind a flag. (b) Live, with the #217 walk and both organizers told. (c) Wait for window B. **I recommend (a).**
2. **Does Release A promote any release to `available`?** This plan assumes **no**, per decision 28. Promoting would change what R1 and `retryProvision` rebuild, and it would need its own plan (#211, #196 and the connector on new trips). **I recommend no, until after 3 Oct.**
3. **The window.** A: Fri 2 Oct 13:30–15:30 UTC. Confirm you are free that Friday afternoon, and check whether it falls on a holiday eve (not verified). Or B: after 3 Oct. **I recommend A with D1(a), otherwise B.**
4. **Group context on live families mid-trip (R5).** From the restart on, the companion receives recent unaddressed family chat with each addressed message. Accept it for Orlando and Japan's remaining days, or gate it like D1? **I recommend accepting it** (the families consented to evaluation under the alpha-tester policy, and it changes what a turn knows, not how many there are). It is a new data flow, though, so it is yours to name.
5. **#116 (document-store bootstrap).** Release A does **not** need it: no `DOCUMENT_STORE_*` is set, and the route only drops originals. **Do not apply its mount before Release A.** An NFS mount makes `guard_storage` refuse every upgrade and every rollback (`vm-release.py:880-884`). **I recommend leaving it open for Release B / #92.**
6. **R6: new trips after Release A pair the sprint-6 worker with the `130924b` site (deny-list sanitizer).** Accept after P5, or hold new confirmations until Release B? **I recommend accepting after P5 is clean.**
7. **Production on a non-`main` commit** until sprint 6 merges (§3.3). Accept that `main` hotfixes cannot reach the VM meanwhile? **I recommend accepting it, and writing it down.**
8. **Who runs W, and when.** **I recommend** Dror and the lead, on 1 Oct or the morning of 2 Oct IDT, on the Mac, with no nightly run that night.

<details><summary>Evidence (2026-09-26, all read-only)</summary>

- **Git.**
  - `git fetch origin`; `origin/integration/sprint-6 = b04e229facc3…`.
  - `merge-base --is-ancestor 130924b b04e229` → no. Merge base `810795a`.
  - `git cherry -v b04e229 130924b 810795a`.
  - `git diff --name-status 130924b b04e229 -- control-plane/db/migrations`: 13 A, 1 M (0051 gained only its header line).
  - `git diff 9f51bf2 b04e229`: 3 docs files.
- **CI.** `gh run list --branch integration/sprint-6`: `9f51bf2` success. On `b04e229` at 13:52Z, TypeScript API was in progress and the other five jobs were green.
- **VM (SSH `debian@…`, read-only commands; SQL inside `BEGIN READ ONLY … ROLLBACK`):**
  - `vm.env` revisions; `docker ps` images; `git rev-parse`/`status`/`remote`/refspec.
  - The installed tool's sha256 = the repo's `vm-release.py` at both revisions.
  - `findmnt` netfs: empty. `fstab` nfs/cifs: 0. Backup directory fs: `ext4`. `df /`: 27 G free.
  - Release history TSV: baseline `cc63dab`; upgrade → `810795a` `verify-failed`; upgrade → `130924b` `ok`; **no rollback row**.
  - Images present for `130924b` and `810795a`.
  - Relay `printenv` filtered to `INTERPRET_|EXTRACT_|ITINERARY_EXTRACT|DOCUMENT_STORE|TELEGRAM_API_ROOT|CLAUDE_CONFIG_DIR`. Worker provisioning flags. The API's `OPERATOR` names (none). `effortLevel` in `claude-config/settings.json` = `medium`.
  - Forced-command path for `hermes`.
  - Relay `docker logs -t`: event-name counts and hourly counts only.
  - SQL: `control_plane_schema_migrations` (51, last `0051`); trips; releases (incl. `data_schema_min/max` 1–3); jobs in flight 0; `interpret_path` counts; not-confirmed sessions (state/expired/awaiting/idle); guard query 0; open agent turns 0; live-trip preconditions for R1; plan releases; geresh counts; migration backfill preconditions (28/0/0/0; 44/32/0); DB size 12 MB; companion set.
- **Code read at `b04e229`:**
  - `vm-release.py` 780–900, 1156–1700, 369–385, 2024–2035.
  - `vm-relay-restart.sh`; `compose.vm.yml` (api, worker, relay, inbound, hermes).
  - `relay/dispatch.ts` 950–1015; `document-correction.ts` 118–165, 396–440; `intake-correction.ts` 30–215; `poller.ts` 760–800; `planner.ts` 437–447.
  - `relay/server.ts` 236–262; `worker/__main__.py` 418–445; `group-context.ts`; `protocol.ts` diff; `command-menu.ts` diff; `model-runner.ts` 449–545.
  - All 13 migration bodies' row-touching statements; `interview-mcp.ts` tool extraction on both revisions (same 7 tools, so verify's gateway check is unaffected).
- **Plans consolidated:**
  - `regression-plan-2026-09-26-pr230-typed-change-pre-deploy.md` (+ round 2);
  - `…-pr234-relay-send-hardening.md` (+ round 2);
  - `…-pr199-round3.md` (+ round 4);
  - `…-trip-mcp-onto-sprint6.md`;
  - `typed-change-real-model-2026-09-26-after-round4.md`;
  - issue #217, issue #225, PR #116.
- **Ran:** `tests.scripts.test_vm_release` (70 OK, 4.8 s); `classify_migrations` over the 13 files (13 compatible).
- **Not done:** any DB suite, a `kinerary-cp-release` call, a restart, a deploy, a commit, Proxmox or trip-container reads, reading any message text.
</details>
