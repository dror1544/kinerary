# Regression plan: PR #181, relay-side assistant events (#177), merged into integration/sprint-6

**Verdict:** safe to merge into `integration/sprint-6` without recording anything, once the verifier's full `npm test` on `cptest_int181` comes back green. Nobody feels it until the sprint-6 → main → `kinerary-cp-release upgrade` deploy. After that it is still inert: the new code runs, the new table stays empty, and no trip site changes. The tests on the hooks are **NOT SUFFICIENT** for turning `ASSISTANT_EVENTS_ENABLED=1` on anywhere (§5, §8), but that switch is not part of this change.

- Mode: branch / pre-deploy (local). The live fleet was read over SSH to the VM, read-only (§4).
- Tree assessed: worktree `agent-a797c0ad957103928`, branch `int181-merged-tree`, staged and not committed. `git write-tree` = `06294a6`, parent `d1c44af` (local `integration/sprint-6`), PR head `8d8cbd8`.
- Assessed by regression-planner on 2026-09-25. The PR body cites reviews. I did not use them as evidence.

---

## 1. Change set

PR #181 `feat(sprint6.2): relay-side assistant events — metadata-only outcome facts, off by default (#177)`: head `8d8cbd8`, base `integration/sprint-6`, OPEN (read with `gh pr view 181`, 2026-09-25).

`git diff --cached --stat`: 15 files, +4082 / −17.

| File | Kind |
|---|---|
| `control-plane/db/migrations/20260925143012_assistant_events.sql` | new migration (one table, one index) |
| `control-plane/api/src/analytics/{contract,emitter,relay-facts,store}.ts` | new modules |
| `control-plane/api/src/relay/poller.ts` (+39/−) | hooks in `applyDecision`; `runDocumentCorrection` now returns an outcome |
| `control-plane/api/src/relay/dispatch.ts` (+161) | optional `analytics` descriptor on decisions; extra reads when on |
| `control-plane/api/src/relay/connector.ts` (+17) | `replySent` after a companion `send` |
| `control-plane/api/src/relay/server.ts` (+16) | `assistantEventsFromEnv`; wiring; `stop()` on shutdown |
| `control-plane/api/test/assistant-events-{contract,replay,store}.test.ts` | new suites |
| `control-plane/api/test/migrations.test.ts` (+2) | literal migration list updated (both copies) |
| `analytics/schemas/tripbot-event.v1.json` | new JSON schema, repo root `analytics/`. Not a release payload root. |
| `docs/trip-bot-analytics-and-metrics-design.md` | doc |

Nothing changed under `site/`, `server/`, `shared/`, `trip-web/`, `mcp/`, `profile-templates/`, `web/`, the worker or provisioning.

## 2. Risk table

| Change | Surface (§2) | Blast radius | Migration? | Compat break? | Risk | Test | Min | Batch/isolate |
|---|---|---|---|---|---|---|---|---|
| Migration: `assistant_events` + FK to `trips(id)` ON DELETE SET NULL | `db/migrations`, runs in the VM `migrate` service before `api` | whole control-plane DB, one-way | yes, additive | none. Old code ignores the table | low: additive, no backfill, no data dependency | `migrations.test.ts` (list updated), `assistant-events-store.test.ts` | in the verifier's run | isolated (store suite); rehearse **with the sprint bundle**, §3 |
| `relay/server.ts` wiring, off by default | `api/src/relay` → relay restart | every live Telegram chat at restart | no | none while off | the flag decides everything. Off path read and confirmed (§5). **No test drives `server.ts`.** | none today. Boot check proposed, run 3 | ~5 (est.) | isolated: silent-failure class |
| `dispatch.ts` descriptors | relay | every routed update | no | none while off: `withAnalytics` returns `{}` without calling `build` | low off. On adds sequential reads on the decision path (§5 Q4) | replay suite "turning events on … changes nothing else", "a descriptor read that fails …" | in the verifier's run | batched in the replay |
| `poller.ts` hooks + `runDocumentCorrection` return type | relay | companion routes, the organizer document path | no | none while off (optional chaining) | low off. Several outcome branches are untested on (§5 Q5) | replay (only `failed_tool` ×4) | — | — |
| `connector.ts` `replySent` + `.catch` rethrow | relay | every companion `send` | no | none: same rejection rethrown, same `outbound_result` | low | contract test "the connector's reply hook" (throw path, with and without the hook) | — | — |
| Emitter, store, contract | new code, reachable only when on | none while off | — | — | n/a off | contract suite: **43/43, 10.7 s wall, measured here 2026-09-25**, no DB | 1 | — |

## 3. Migration and compatibility findings

### Q1: What the new table and FK do to the VM's existing schema

```sql
CREATE TABLE IF NOT EXISTS control_plane.assistant_events (
  event_id uuid PRIMARY KEY,
  trip_id  text REFERENCES control_plane.trips(id) ON DELETE SET NULL, ...
CREATE INDEX IF NOT EXISTS assistant_events_trip_time_idx ON control_plane.assistant_events (trip_id, occurred_at);
```

- **Applying it.** `CREATE TABLE … REFERENCES trips` takes a `SHARE ROW EXCLUSIVE` lock on `control_plane.trips` for the migration's own transaction. `applyMigrations` runs one transaction per file (`migrations.ts:25-33`). That lock blocks writes to `trips` (INSERT/UPDATE/DELETE) but not reads, and it waits for any open writer on `trips`. On the VM the migration runs in the `migrate` service before `api` starts (`compose.vm.yml`: `api` depends on `migrate: service_completed_successfully`). The old worker and relay may still be running at that point, so a long-open worker transaction on `trips` would delay the migration, and writers would queue behind it. The table is empty, so once acquired the lock is held for milliseconds. The ~25 existing FKs to `trips` in this schema had the same property when they were added (`grep REFERENCES control_plane.trips`). No `lock_timeout` is set by the runner. This is not new.
- **Does it destroy anything?** No. There is no DROP, no NOT NULL on a populated column, no backfill, and no change to existing rows.
- **Can it fail on production data?** It reads no existing rows, so it cannot fail on their shape. `trips(id)` is the primary key (`0001_foundation.sql:12`). `IF NOT EXISTS` would silently skip if a differently shaped table already existed. `to_regclass('control_plane.assistant_events')` is NULL on both the VM and the Mac staging DB (read 2026-09-25), so there is nothing to skip.
- **Teardown's `retire_in_db` (`scripts/teardown-trip.py:554-587`).** It never DELETEs a trip. It does one transaction: revoke tokens → close bindings → `UPDATE control_plane.trips SET slug = …` → close sessions. `trips.slug` is `NOT NULL UNIQUE` (`0001_foundation.sql:13`), a non-partial unique index that could back a foreign key. So Postgres takes a **FOR UPDATE** row lock for that UPDATE, not FOR NO KEY UPDATE, and FOR UPDATE conflicts with FOR KEY SHARE.
  - The writer (`store.ts:74-78`) takes `FOR KEY SHARE OF t` on each referenced trip. The FK trigger on its INSERT takes the same lock again.
  - **While off:** there is no writer and no lock. Teardown behaves exactly as today.
  - **While on:**
    - If the writer holds the trip row, teardown's slug UPDATE waits for the writer's transaction. That transaction is one statement, bounded by `SET LOCAL statement_timeout = 5000`.
    - If teardown holds the trip row, the writer waits up to `lock_timeout = 5000`. It then fails, and that batch is dropped and counted (fail-open).
  - **No deadlock cycle is possible between the two.** The writer only ever waits on `trips` rows, and holds nothing teardown later needs. This is unlike the `redeemGroupBindingToken` token→trips cycle of #175. A theoretical cycle would need a third transaction that FOR-UPDATE-locks two trip rows in one transaction. I found no such writer, but I did not exhaustively prove the absence (open item, §9).
  - Non-key updates to `trips` (`lifecycle_state`, `updated_at`) take FOR NO KEY UPDATE, which does not conflict with FOR KEY SHARE.
- **DELETE on `trips`.** No code path deletes a trip. A DELETE would already be refused by the many NO ACTION FKs from `0001_foundation.sql`. If one ever ran, SET NULL would fire an UPDATE on `assistant_events WHERE trip_id = $1`, which the `(trip_id, occurred_at)` index serves. Rows exist only while the flag is on.
- **`rollback: compatible`: true and correctly formed.** The header matches `ROLLBACK_HEADER` in `vm-release.py:128`. Preflight `--staged` exits 0 on this tree (run here, 2026-09-25; the only warnings are pre-existing Hermes-profile drift). Old code never names the table, so a code-only rollback that keeps the DB is sound. Two consequences worth knowing:
  1. `classify_migrations` gives a verdict over **every** pending migration. The VM is 12 behind, so this one is not upgraded alone (§4). All 12 pending files declare `compatible` (headers read 2026-09-25), so the bundle verdict is `compatible`.
  2. After a keep-DB rollback, `cmd_upgrade` and `cmd_plan` refuse any later target that lacks this file ("the database has migrations … lacks — refusing a downgrade", `vm-release.py:1444,1473`). A main-only hotfix that does not contain it cannot be deployed until main has it. That is true of every forward-only migration; it is not specific to this one.

### Q2: The test-DB reset behaviour

- The table is created in `control_plane`, so `DROP SCHEMA IF EXISTS control_plane CASCADE` removes it and `applyMigrations` recreates it. The migration's own comment gives this as the reason it did not use a separate schema.
- 34 test files contain `DROP SCHEMA` (`grep -rln`, 2026-09-25). That is the 32 of the brief plus the 2 new DB suites (`assistant-events-replay`, `assistant-events-store`).
- The package runs `--test-concurrency=1` (`package.json:11`), so the new suites do not race the others inside one run. `cptest` is still shared between sessions (standing hazard). The verifier's `cptest_int181` avoids it.
- Suites that enumerate or count:
  - `migrations.test.ts` asserts the **literal ordered file list** in two places. The PR adds the new file to both, so the expected failure has already been dealt with. A red `migrations.test.ts` on this tree is a real failure.
  - The same test asserts `count(tables) >= 20`, which is unaffected.
  - `relay-gateway-wait.test.ts:105` reads the columns of `telegram_chat_bindings` only.
  - `organizer-trips.test.ts:88` runs `TRUNCATE users, trips CASCADE`. CASCADE also truncates `assistant_events`, which is harmless.
  - The new store suite pins this table's own columns and indexes by design.
  - I found nothing else that enumerates `control_plane` tables (grep for `information_schema`, `pg_tables`, `pg_class`, `TRUNCATE` in `test/` and `src/`).

### §4 compatibility

- **Release seal:** untouched. No file under `site/`, `server/` or `shared/`. `analytics/` is not in `PAYLOAD_ROOTS`.
- **Intake schema:** untouched.
- **`trip.config.json`:** untouched.
- **Fail-safe visibility schemas:** untouched. Nothing to route to boundary-reviewer on this path.
- **Two producers of one shape:** the `analytics` descriptor is built by dispatch in three places (`seen()` via NOT_ADDRESSED / to_gateway, and `companionPendingFacts`) and by the replay test directly for `document_correction`. The document_correction descriptor in dispatch (`seen("organizer")`, `documents: attachment ? 1 : 0`) is **unreachable today** because of #178, and so is untested. When #178 is fixed, that descriptor needs its own test.

## 4. Live-fleet impact

Read on 2026-09-25 over SSH to VM 110. All reads were read-only: `SET default_transaction_read_only = on`, `docker ps`, `docker exec … env`, `grep -l`.

| Fact | Value | Source |
|---|---|---|
| VM running rev | `130924b` (api, worker, relay, companion-mcp, interview-mcp; up 41 h). `130924b` is **not** an ancestor of this tree: the VM runs main, not sprint-6. | `docker ps`; `git merge-base --is-ancestor` |
| VM migrations applied | 51. Newest numbered is `0051`, no timestamped files. **12 pending** against this tree: `0050_plan_reviews`, `0052`–`0054`, 7 × `2026091…/2026092…`, and this one. Nothing is applied on the VM that is absent from the tree. | `control_plane_schema_migrations` vs `ls migrations` |
| `assistant_events` on VM | absent | `to_regclass` |
| `ASSISTANT_EVENTS*` in the VM relay's environment | 0 | `docker exec kinerary-cp-relay-1 env` |
| …in `/opt/agent-auth/{claude,openrouter}.env`, `/opt/kinerary-deploy/{provisioning,vm}.env` | no match (grep rc 1; all four files present) | `sudo grep -l` |
| …in `~/kinerary-deploy` (Mac; trips/intakes/.git excluded) | no match | `grep -rn` |
| Live sites (not `retired-*`, ≥ `ready_private`) | **2**: `orlando-florida-2026` (ready_private, updated 2026-09-23), `japan-tokyo-hakone-kyoto-osaka-2026` (ready_private, 2026-09-15). 2 drafts `intake_in_progress` (updated 2026-09-23). | `control_plane.trips` |
| Open chat bindings | 3 | `telegram_chat_bindings` |
| CT200 `trip-usa2026` | memory says no control plane tracks it. **Not checked today**, and not affected either way: the relay only routes bound chats. | memory, unverified |
| Mac staging relay | pid 71552, `tsx src/relay/server.ts`, cwd `…/worktrees/sprint-6-integration/control-plane/api`; `ASSISTANT_EVENTS*` in env: 0 | `lsof`, `ps eww` |
| Mac staging DB | 56 migrations, newest `0054_companion_bug_reports`, **no timestamped migrations applied**; `assistant_events` absent | local `psql`, read-only |

**Who feels it, and when:**

- **Merging to `integration/sprint-6`:** nobody in production.
  - The Mac staging relay runs *source* from the `sprint-6-integration` worktree. If the merge is committed there, the files change under the running process, but they only take effect at the next `scripts/relay-restart.sh`. There are no dynamic `import()` calls in `src/` (grep).
  - Even after a restart it is off: the flag is absent and the script sources `provisioning.env`, which lacks it.
- **Sprint-6 → main → VM upgrade:** the relay restart that every upgrade already does drops a mid-turn conversation. That is the standing hazard, and `vm-release`'s live guard (`--force-live`) covers it. This PR adds no new felt effect: the boot log gains one line, `relay.assistant_events {"enabled":false}`.
  - Both live sites and all 3 bound chats run the new relay code on the off path.
  - **No trip needs redeploying.** Nothing here is in a trip container or a release.
- **Oldest release still running:** irrelevant. Trip sites do not read anything this PR changes.

### Q3: Is off by default true, and the two clocks

- **Off by default is true of every relay that exists today.** Neither the VM relay nor the Mac relay has the code yet. When they do, off is enforced in three places:
  1. `assistantEventsSetting` enables only on the exact value `"1"`.
  2. `compose.vm.yml`'s relay `environment:` list does not name the variable. `--env-file provisioning.env / vm.env` are used only for interpolation and are **not** injected into the container.
  3. The one route into the VM container is `env_file: /opt/agent-auth/*.env`, which is injected wholesale. Those files do not contain the variable today (verified above).
- **Correction to the brief's premise:** "the API `dist/` is bind-mounted" is true only of the Mac's `compose.local.yml` `api` and `migrate` services.
  - **VM:** nothing is bind-mounted ("no dev `dist/` … overlays"). The relay is `kinerary-cp/agent-runtime:${KINERARY_REV}` running `node dist/relay/server.js` from the image.
    - **Rebuild without restart:** nothing changes until the image for a new `KINERARY_REV` is built and the container recreated.
    - **Restart with the new build:** `kinerary-cp-release upgrade` runs `migrate` → `api` (healthy) → `relay`, in that order through `depends_on`.
    - `vm-relay-restart.sh` uses `up -d --force-recreate --no-deps relay`. It recreates only the relay at whatever `KINERARY_REV` says, without running `migrate`. That could only put new relay code ahead of the migration if someone hand-edited `KINERARY_REV`, which the runbook forbids.
  - **Mac:** the relay is not a compose service at all. It is a host process running **source through tsx** (`scripts/relay-restart.sh:58-59`), so rebuilding `dist/` does nothing to it. Restarting it runs whatever `src/` the checkout holds. The `api` service mounts `dist/` (rebuild + restart). `migrate` runs only on a `compose up` from that checkout.
- **Without the migration, while off:** no statement names the table, so nothing changes. I read every hook: all use `?.`, `withAnalytics` returns `{}` without building, and `server.ts` spreads nothing.
- **Without the migration, while on:** it fails open. Every flush fails with 42P01 inside `writeAssistantEvents`. The emitter's `flush` catch drops the batch and counts it, logging `relay.assistant_events_dropped` (`safe_error_code` is the pg error's class name) at most once a minute. Decisions and replies do not change. The descriptor reads (`resolveTripPerson`, `resolveChatRoute`) do not touch the new table and keep working.
- **Safe order:** while off, either order is safe. Migrate first is the natural order and what the upgrade does. For enabling: migrate → confirm `to_regclass` → set the flag → restart the relay → read the boot line `{"enabled":true}` and see rows arrive.

## 5. Q4 (pool) and Q5 (sufficiency)

### Q4: Can the relay's extra pool use starve `resolveChatRoute` when enabled?

- **The pool:** `createDatabasePool` sets `max: 10` and `idleTimeoutMillis: 30000`, with **no `connectionTimeoutMillis`** (`database.ts:4`), so a caller waits indefinitely for a free connection. The relay shares that one pool across the poll loop, the deliver loop, connector callbacks, the document sweeper, override refresh, correction chains and the emitter.
- **The emitter:** its "one write at a time" claim holds in the code.
  - `flush()` starts nothing while `inFlight` or `outstanding` is set (`emitter.ts:379-380`). `outstanding` is cleared only when the sink's promise settles, including a write abandoned at `writeTimeoutMs` (10 s).
  - Each write holds one connection. Its statements are bounded by `SET LOCAL statement_timeout` / `lock_timeout = 5000`, set immediately after `BEGIN` (`store.ts:93-95`).
  - `pool.connect()` itself is unbounded, but while it waits it holds nothing.
  - Worst case from the emitter: **one of 10 connections**, for at most about 5 s per batch on the DB side.
- **The dispatch reads are the part the emitter's claim does not cover.** They are not bounded by the emitter, and they sit **on** the decision path: they are awaited inside `dispatchUpdate` before the decision returns.
  - An **unaddressed** group message gets one extra `resolveTripPerson`. Before this change that path made no person read.
  - A **companion-pending** answer gets `resolveChatRoute` again (`normalizeUpdate` already did it) plus `resolveTripPerson`.
  - The poll loop processes updates **sequentially** (`poller.ts` `for (const item of raw)` with `await dispatchUpdate`). These reads therefore add latency, not concurrency: at most one extra connection at a time, and only briefly.
  - They cannot starve `resolveChatRoute`: they *are* the same loop, one query after another.
  - The cost is one more round trip per family-chatter message. If the DB is slow, the loop that also routes the next addressed message slows by that amount.
  - A failed read costs only the descriptor (tested, replay "a descriptor read that fails").
  - A **hung** read hangs the loop exactly as a hung `resolveChatRoute` already would. There is no new failure mode, only one more place to meet the existing one.
  - The accurate wording is "the emitter is off the decision path; the descriptor reads are on it". The PR's §12 "never a delayed reply" holds for the emitter, not for those reads.
- **Verdict:** no starvation. There is a small, bounded latency increase on group chatter while on. It has not been measured on a real stack.

### Q5: Do the suites suffice for the poller/dispatch/connector hooks?

**NOT SUFFICIENT.**

Covered (tests read, 2026-09-25):

- **Off path is unchanged:**
  - Replay: "with the setting unset, the week writes nothing" (the whole week through real dispatch, `applyDecision` and connector).
  - Replay: "turning events on adds a descriptor … changes nothing else", deep-equal for chatter, an unaddressed doc, name, mention, organizer DM and companion-unreachable.
  - Contract: connector throw path gives the same `outbound_result` with and without the hook.
  - Setting parse: `1` is on; unset, `0` and junk are off; no DB means no emitter.
- **Emitter fail-open:** throwing and hanging sinks give the same messages in the same order; one hung write all week; `stop()` deadline; a throwing log function.
- **Poller hooks:**
  - `ignore` + NOT_ADDRESSED → `notAddressed`.
  - `to_gateway` delivered → `handedOff` + reply attribution.
  - `reply` companion-unreachable → `companionUnreachable`.
  - `document_correction` → `toRelay` + `relayToolCompleted("failed_tool")` ×4, entered at `applyDecision` because #178 makes dispatch unable to produce it.
- **Connector:** `delivered` (replay) and `failed` by **throw** (contract).
- **Store:** column and index allow-list, idempotency, UNKNOWN_TRIP per row, CHECKs mirror the contract, SET NULL on delete, purge, rollup day edges.

Not covered:

1. **`server.ts` has no test at all.** Nothing proves that the same emitter reaches both the connector and the poller, that `stop()` runs before `connector.close()`, or that the boot line is logged. This is entrypoint debt in the sprint plan's own sense.
2. `handedOff(…, delivered=false)` → `turn_lost/lost_gateway_unavailable` through `applyDecision`. This is the race where `canReachProfile` said yes and `pushInbound` returned false. Only the emitter unit test covers it.
3. Connector `replySent("suppressed")` (the leak filter) and `replySent("failed")` when `sendMessage` **resolves** `{ok:false}` rather than throwing.
4. `runDocumentCorrection`'s outcome mapping: `blocked_by_policy` (identity docs), `no_new_information`, `correction_proposed`, and `failed_tool` for no-runner and no-version. Only the extract-failed branch is exercised.
5. The correction chain's `.catch` → `relayToolCompleted(relayTurn, "failed_tool", 0)`, and that it does not double-record when `relayToolCompleted` itself is the thrower (it is guarded, but that is untested).
6. The `document_correction` descriptor built in dispatch (unreachable until #178).
7. `vm-relay-restart.sh` and `relay-restart.sh` read back `INTERPRET_*` but not this flag (§8, item 1).

What would make it sufficient: items 1–5 as tests, about one file's worth, plus the boot check in §6 run 3. Item 6 belongs to the #178 fix. None of these gates the dark merge, because the off path is covered. **All of them gate enabling.**

## 6. The plan

| # | Run | Command | Checklist | Min | Who |
|---|---|---|---|---|---|
| 1 | Full control-plane suite on the merged tree | `CONTROL_PLANE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5434/cptest_int181 npm test --prefix control-plane/api`, **already running (verifier)** | (a) `migrations.test.ts` green: the list is updated, so red is real. (b) the 3 new suites green, replay not skipped (it skips without a DB URL). (c) `relay-dispatch`, `relay-poller`, `relay-group-attachments`, `document-correction-flow` green: these are the off-path regression ring. (d) a single red test: re-run the file alone before calling it a regression. | verifier's clock, not measured by me | nobody |
| 2 | Contract suite, no DB | `node --import tsx --test test/assistant-events-contract.test.ts` | 43/43 | **done: 43/43, 10.7 s, 2026-09-25** | — |
| 3 | Boot-level check of `server.ts` (entrypoint debt) | build, then start `dist/relay/server.js` twice against a **scratch** DB with polling pointed at a stand-in: once with the variable unset, once `=1` | log contains `relay.assistant_events {"enabled":false}` (unset) / `{"enabled":true}` (=1). Nothing else in the boot log differs. Clean shutdown within the 2 s `stop()` deadline. | ~10, estimate | a developer. No bot token that a live loop owns (one `getUpdates` loop per bot). |
| 4 | Preflight, staged | `scripts/preflight-checks.sh --staged` | B7 migration naming and header | **done: exit 0, 2026-09-25** | — |
| 5 | At sprint-6 → VM upgrade (not this merge) | `sudo kinerary-cp-release upgrade <rev> --dry-run`, then for real | 12 pending migrations listed, verdict `compatible`. After: `to_regclass('control_plane.assistant_events')` is not NULL, `SELECT count(*) FROM control_plane.assistant_events` = 0, and relay boot log `{"enabled":false}`. Take it an hour later too: still 0 rows. | part of the sprint deploy | Dror (hard rule 2) |

The 80-minute e2e walk is **not** needed for this change while it is off. It cannot observe it: the off path writes nothing and changes no message.

## 7. Budget

- **Minimum gate (merge dark into integration/sprint-6):** run 1 green. Runs 2 and 4 are already done. Cost: the verifier's run.
- **+ run 3 (~10 min, estimate):** the only evidence that `server.ts` wires what the tests assume. Without it, the claim "on turns it on" rests on `assistantEventsFromEnv`'s unit tests alone.
- **+ §5 Q5 items 2–5 as tests (about an hour's work, estimate):** needed before enabling, not before merging.
- **Before enabling anywhere real, which is not this PR:** the known carry-forward (purge scheduled, family notice), the tests above, the Mac staging DB migrated (§8), and a timed on-soak on staging to measure the chatter latency increase from Q4.

## 8. Go / no-go and the way back

- **No-go for the merge:** run 1 red on anything that survives an isolated re-run. A red `migrations.test.ts` counts, because its expected change is already made.
- **No-go for the eventual VM upgrade:**
  - Boot log `{"enabled":true}`, or any `relay.assistant_events_setting_unrecognized` line.
  - Rows appearing in `assistant_events`.
- **Snapshot:** `kinerary-cp-release upgrade` snapshots the VM from the Proxmox host and dumps the DB before it changes anything. No extra snapshot is needed for this migration, which is additive.
- **Way back:** `sudo kinerary-cp-release rollback` keeps the DB, because every pending migration declares `compatible`. The empty table stays behind, harmless. Afterwards any upgrade target must contain this migration file.
- **Way back if someone enables it and regrets it:** unset the variable wherever it was added, restart the relay (`vm-relay-restart.sh`), then `DELETE FROM control_plane.assistant_events`. Rows hold no content by construction, but that is still the owner's call.

## 9. What would reduce the risk, ranked by risk removed per minute

1. **Make the off state loud, where it is read (5 min).** Both relay restart scripts already read the environment back off the running process for `INTERPRET_*`. Have them also assert that the boot log line is `relay.assistant_events {"enabled":false}`, or fail when `ASSISTANT_EVENTS_ENABLED` is present but not intended.
   - Why this matters: the Mac relay inherits the **calling shell's** environment (`relay-restart.sh` uses `env -u`, not `env -i`), so an `export ASSISTANT_EVENTS_ENABLED=1` left in a terminal switches recording on silently.
   - On the VM, a line added to `/opt/agent-auth/claude.env` would do the same, because that file is injected wholesale.
   - Recording being switched on silently is this repo's own bug class, pointed in the privacy direction.
2. **A boot test through `server.ts` (run 3; ~10 min to run, under an hour to write as a test).** This is the sprint's standing entrypoint rule, and it is the only untested wiring in the PR.
3. **Write §5 Q5 items 2–5 before anyone enables this (~1 h, estimate).** They are cheap, deterministic, need no model, and cover the outcome branches a real week will hit and the replay did not.
4. **Correct one sentence rather than change the code.** Emitter §12 "never a delayed reply" is true of the emitter. The descriptor reads are awaited on the decision path: +1 query per unaddressed group message, +2 per companion-pending answer. Say so in the design doc, and measure it during the staging soak.
5. **Migrate the Mac staging DB before any on-rehearsal there.** This is pre-existing and not this PR's doing.
   - Found today: the Mac relay runs sprint-6 source while its DB (`kinerary_control_plane` on :5433) has **no timestamped migrations**.
   - As a result, an on-rehearsal on staging would drop every event with 42P01 and prove nothing. The same drift may affect other sprint-6 features on staging (document registry, invitations). That is a separate item for whoever owns the Mac stack.
6. **Nothing else for the dark merge.** The additive migration, the absent flag and the unchanged off path are all verified. Asking for the e2e walk here would buy nothing.

## 10. Decisions needed

- **Run 3 before or after the merge?** I recommend before, because it is cheap. Either way it is not a blocker for merging dark.
- **Is item 1 (restart scripts assert the flag state) a sprint-6 item?** `sprint-scribe` places it. It has no owner.
- **Mac staging DB drift (item 5):** who migrates it, and does it gate any other sprint-6 staging acceptance?

**Could not determine:**

- Whether any code path FOR-UPDATE-locks two `trips` rows in one transaction (the only way to a deadlock with the writer while on). Grep found none; that is not proof. It would take a read of every `UPDATE control_plane.trips` site.
- The latency of the extra descriptor reads on a real stack. This needs an on-soak on migrated staging.
- CT200 `trip-usa2026` state (memory only). It is irrelevant to this change.

**Carry-forward, known:** the PR's "Deliberately not done" (enabling, including the compose pass-through; scheduling `purgeExpiredEvents`; Hermes plugin / `turn_id` linkage / keyed pseudonyms / ingest route / interview turns), #178 (organizer DM document never reaches read-and-propose), #179 (unaddressed group chatter gets "still finishing" while the companion is unreachable). With this PR's events on, that chatter is recorded as `turn_lost` with trigger `not_addressed`, and the rollup already separates it.

**Carry-forward, added here:**

- (a) The restart scripts do not read back the flag (§9, item 1).
- (b) `server.ts` has no boot test (§9, item 2).
- (c) The untested hook branches (§5 Q5, items 2–5).
- (d) The dispatch-built `document_correction` descriptor needs a test when #178 is fixed.
- (e) Mac staging DB lacks all timestamped migrations while its relay runs sprint-6 source.
- (f) After a keep-DB rollback, a main-only hotfix without this file cannot be upgraded to.
- (g) `writeAssistantEvents`' `pool.connect()` is unbounded (the pool has no `connectionTimeoutMillis`). It is harmless while one write is outstanding, but it is worth bounding before an ingest route reuses the writer, as the store's header says it will.
