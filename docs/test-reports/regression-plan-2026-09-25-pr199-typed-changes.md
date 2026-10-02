# Regression plan: PR #199 at cdf6a09, the typed-change flow (#206)

**Verdict: the suite is enough to merge into `integration/sprint-6`, and still not enough to deploy.** Both defects from the first pass are fixed. The stale Yes after a restart was defect 2, and the change lost in a crash was defect 3. Mutation runs prove the tests that guard each fix, listed in §9. The merge still waits on the owner: the PR is still a draft (`isDraft: true`, read 2026-09-25), and the Opus boundary re-audit is running. Before the VM, a real-Telegram walk, the chaos organizer, a Hebrew read and the live-fleet reads are still owed.

This is the second pass. It updates the plan for 0849880 in place, and supersedes `regression-plan-2026-09-25-pr199-return-leg-marker.md`. Assessed by `regression-planner` on 2026-09-25, branch mode. I did not read production (see §4).

## What would reduce the risk (ranked by risk removed per minute)

1. **Teach the automated organizer to settle a waiting change, then walk `chaos` on the Mac.** About 45 min of dev (est.), plus one walk. Still open, and still the biggest item.
   - `git grep "pc:" cdf6a09 -- control-plane/api/tools` finds nothing.
   - `CHAOS_LATE_CORRECTIONS` (`tools/organizer-chaos.ts:54`) still types two corrections, and each now becomes a waiting draft. The walk has no way to tap Yes on either.
   - I expect `--scenario chaos` to stall or to fail `minTravellers: 5` (`:72`). That is inferred from the code, not run.
2. **A test for the re-show branch after a committed crash.** About 10 min (est.).
   - The branch at `poller.ts` ≈2696–2708 re-shows a draft whose reading was committed but whose preview never went out.
   - I disabled that branch in a scratch copy. The integrity file still passed 20/20, and `typed-changes-flow-db.test.ts` still passed 29/29.
   - Add a `crashOnce` on a statement after `markInterpretationCommitted` (for example the `last_prompt` write), then replay, and assert one preview.
3. **A test for the digest check inside `pickForDraft`'s lock.** About 5 min (est.).
   - With both lock-level checks removed, only the `applyPendingChangeForChat` one was caught (test "the guard is atomic").
   - Nothing tests the pick path's check under the lock. The relay's pre-check covers the sequential case.
4. **Walk it once on real Telegram** (about 20 min with Dror, est.). Use the Mac on `@Tripinterviewer_bot`. The checklist is run C in §5.
5. **A native Hebrew read** (about 20 min, Dror, est.). It covers the earlier `change.*` and `warn.*` strings, plus the **8 new ones** in `intake-copy.ts`: `change.updated`, `tooBig`, `tooBigFresh`, `sessionConfirmed`, `uneditable`, `sendFailed`, and the two `invalid.detail.*`.
6. **Retire the 20-round race test, or say plainly that it is a smoke test** (2 min). It passed with the whole digest fix removed (§9). As written, it cannot fail on the bug it is named for.

Items 2, 3 and 6 are small and do not block the merge. Items 1, 4 and 5 are owed before the VM.

## 1. Change set

| PR | Head | Base | What changed since the first pass |
|---|---|---|---|
| #199 (draft) | `fix/114-return-leg-marker` @ `cdf6a09` (on `0849880`; `gh pr view` `headRefOid`, 2026-09-25) | `integration/sprint-6` @ `c29aa3f`; merge base `96a2897` | `cdf6a09` adds 13 files, +1201/−95. Source: `chat-router.ts`, `intake-copy.ts` (+16, the 8 strings × 2 languages), `interview.ts`, `relay/dispatch.ts` (+10), `relay/poller.ts` (+215/−~60), `typed-changes-render.ts`, `typed-changes-store.ts`, `typed-changes.ts`. Tests: the new `typed-changes-integrity-db.test.ts` (550 lines, 20 tests), plus `relay-dispatch`, `typed-changes-render`, `typed-changes-store-db` and `typed-changes`. **No migration change:** `git diff 0849880 cdf6a09 --stat` lists no file under `db/`. |

- `git merge-tree --write-tree c29aa3f cdf6a09` gives `871e190`, clean. I re-ran it.
- The whole PR is still what §1 of the first pass listed: 21 files, including migration `20260925180000_intake_pending_changes.sql`.

**`dispatch.ts` against #215 (the tip):**
- `git diff 96a2897 c29aa3f -- …/dispatch.ts` shows #215 touched only `dispatchUpdate`: `OutageNoticeLimiter`, the `COMPANION_PENDING` split and the attachment route. It did not touch `dispatchCallback`.
- On the merged tree, the new `pc:` branch sits at `dispatch.ts:1443–1452`. The order inside `dispatchCallback` is:
  1. `switch`, at 1384;
  2. `correction`, at 1418;
  3. the generic block, at 1430, with `route.kind === "interview"` first at 1432, then the new `change` branch, then `STALE_INTERVIEW_CALLBACK`.
- The new branch comes after the tip's own branches, and it matches only `parsed.kind === "change"`. That kind comes from a `^pc:` regex that no other callback kind can satisfy, so it cannot shadow `sw:`, `dc:`, conflict or approval data.
- Its only effect: a `pc:` tap outside a live interview used to get an unanswered `ignore`, and now gets `callback_reply` `change.gone`.
- The intent does not overlap #215. Both aim for a reply that is always answered, but on different paths.
- A tap whose `chatId` is null still falls through to `approval_callback`. That was already true for every kind, and it only happens with inline-mode messages.

## 2. Risk table

| Change | Surface | Blast radius | Migration | Compat break | Risk | Test | Min | Batch? |
|---|---|---|---|---|---|---|---|---|
| Typed change to `phases`/`travelers` becomes a preview-then-confirm draft | `api/src/relay/`, at relay restart | every interpret-path interview holding those answers | yes (unchanged) | held lists are no longer written by a typed message | medium | integrity + flow DB (done); items 1, 4 | 45 + walk, 20 | batch the walk |
| **cdf6a09:** a digest in `pc:<id>:<digest>:…` and in `last_prompt`, checked under the row lock | relay + API | same | none | a pre-digest button parses with `digest: null` and is never applied. Nothing live carries one, because 0849880 was never deployed | low now | 5 tests fail when it is removed (§9) | 0 | — |
| **cdf6a09:** draft created before the reading is committed; `last_prompt` recorded only after the send succeeds | relay | same | none | none | low now | 3 + 2 tests fail when each fix is removed (§9); the re-show branch is untested (item 2) | 10 | — |
| **cdf6a09:** size cap (40 ops, 3500 chars) and refusal of a change to a confirmed session or to an uneditable shape | relay | organizers who send large or odd corrections | none | new refusals, said out loud | low | D/E/H tests (read, not mutated) | 0 | — |
| Confirm refused while a change waits | API and relay | includes the web confirm route (422) | same | the web has no UI to settle a draft | low | done | 0 | — |
| Prompt carries held lists and asks for ops | relay model call | every interpret-path typed message | none | none | medium: a model in the loop | 114-call harness (one model, one effort) | ~7 per re-sample (derived) | isolated |
| `pc:` authorisation | relay | any chat | — | — | security path | **Opus re-audit, in progress. Not duplicated here** | own pass | isolated |
| `identityFold` geresh/gershayim (`answer-merge.ts`, unchanged in cdf6a09) | all merge paths, including `document-correction.ts` on confirmed trips | names with ׳ or ״ | none | persisted `entry_key` may stop matching | low | a read-only query (§4) | 1 | isolated |

## 3. Migration and compatibility findings

- **Migration safety is unchanged.** `cdf6a09` touches no migration. It is still one additive table: `CREATE TABLE IF NOT EXISTS`, two indexes, `ON DELETE CASCADE`, and a `rollback: compatible` header. No rehearsal is needed.
- **The new queries use existing columns.** `getDraftForInterpretation` reads `interpretation_ids` (`WHERE session_id = $1 AND $2 = ANY(interpretation_ids)`), which the migration already creates. The `SELECT` in `applyPendingChangeForChat` gained `ops`, which also already exists.
- **Restart order is still one-way.** A new relay against a database without the table gets `42P01`. The release tool's order (migrate, api, relay) is correct, and a hand-run relay restart before `migrate` is not.
- **Rollback with drafts pending** is as the first pass found: the old relay routes `pc:` to the approval path, which refuses it, and a waiting change is dropped when the organizer confirms. Before any rollback, count them: `SELECT count(*) FROM control_plane.intake_pending_changes WHERE status='pending'`.
- **The callback format changed between 0849880 and cdf6a09.** 0849880 never reached production (its schema is at `0051`, per the first pass's read), so no live button carries the old format. If one did, `digest: null` matches nothing, and it answers with the current preview.
- **Two producers are unchanged.** Only the interpret path creates drafts. #214 (a fold can resurrect a removed stop) and #216 (bookings) remain open and are not touched by cdf6a09.

## 4. Live-fleet impact

Unchanged from the first pass, and **not re-read**: I did not read production in either pass.

| What | Source | Felt |
|---|---|---|
| 1 open, idle interview (`opening`, 54 h idle) | the first pass's fleet read, 2026-09-25 | only if its organizer returns after the relay restart and then types a change to stops or travellers |
| 2 `ready_private` trips (`orlando-florida-2026`, `japan-tokyo-hakone-kyoto-osaka-2026`) | same | not by drafts: a confirmed session is refused, now at `proposeChange` as well (`kind: "confirmed"`). By `identityFold`: only through document corrections, and only for names with ׳/״ |
| Schema | `0051`, 51 applied (first pass) | reaches the VM only with sprint 6 → `main` → `kinerary-cp-release upgrade` |

**No trip needs a redeploy.** The change is control-plane only, felt at the relay restart.

**Owed before the VM**, read-only, through `fleet-mcp.mjs`:
1. `interpret_path` counts. This checks the "28/28 interpret" claim.
2. The VM relay's `INTERPRET_RUNNER/MODEL/EFFORT`. If they differ from `claude-sonnet-5`/medium, re-run the harness at the VM's values (about 7 min).
3. Whether Hebrew sessions hold stops with `name_en`.
4. `SELECT count(*) FROM control_plane.trip_answer_sources WHERE entry_key ~ '[׳״]'`, and the same query on `trip_answer_conflicts`.
5. The open-interview state at the deploy window.

## 5. The plan

| # | Run | Command | Checklist | Min | Who |
|---|---|---|---|---|---|
| A | **Done.** Full `control-plane/api` on merged tree `871e190` | the caller's run; log `scratchpad/merged2-suite.log` | I read the finished log: `# tests 1894 / pass 1886 / fail 2 / skipped 6`. Both failures are `release CLI` ("not a git repository", "Unexpected end of JSON input"), the same git-archive artefact as the first pass. Integrity suites `ok 474`–`ok 480`. The caller reports release-cli 2/2 in a real tip checkout; I did not re-run that | 13.6 (log `duration_ms 816945`) | — |
| A′ | **Done by me.** Mutation runs, integrity file alone | scratch copy of `cdf6a09` `src/`, db `cptest_int199w` | §9 | 0.6 per run (measured 33–39 s) | — |
| B | Items 2, 3 and 6 | integrity file alone on a `cptest_<own>` database | the re-show branch is caught; the pick lock check is caught | ~15 dev + 1 | developer, then verifier |
| C | Real Telegram, Mac staging | stack from the sprint worktree; Dror on `@Tripinterviewer_bot` | (1) EN "actually Tokyo is 20 to 25": preview shown, nothing stored until Yes. (2) HE age change, then reply `כן`. (3) Tap an **older** preview's Yes after a follow-up and a relay restart: expect `change.updated` and the current preview, **nothing applied**. (4) Confirm while waiting: refused. (5) Cancel restores the displaced question. (6) Read `interpret_path` off the session | ~20 (est.) | Dror; no overlapping VM run |
| D | Chaos walk, after item 1 | `scripts/preflight-deploy.sh --deploy --auto --scenario chaos --cleanup` | both late corrections previewed and applied once; ≥5 travellers; Naxos and Santorini present; no stall | tens of min (est.) | **hard rule 2 prompt**; Mac window |
| E | Boundary re-audit of `pc:` | — | owned by the Opus audit now running | its own pass | boundary-reviewer |

**On the next sprint walk:**
- **Batched:** C1, C2, C4 and C5, plus #218's child environment and #215's `companionUnavailable` reply.
- **Isolated:** C3, which needs a restart mid-flow; E, the security path; the harness re-sample, which has a model in the loop; and the geresh query, a silent failure.

## 6. Budget

- **Merge into `integration/sprint-6`:** A (done), plus the owner lifting the draft, plus E's verdict. No further test time is needed from me.
- **Deploy the sprint to the VM:** item 1 + D + C + the Hebrew read + the §4 reads, roughly 2.5 h of dev and walks (est.), plus a Mac window. B (about 15 min) is cheap insurance on two untested branches.
- Without D, a real organizer's correction is how you would find out whether a draft can stall an interview.

## 7. Go / no-go and the way back

- **Stop the merge if** E finds a tap that settles another session's draft, or the owner keeps the draft.
- **Stop the deploy if** D stalls or leaves a correction unapplied, if C3 applies anything, or if §4 item 1 shows agent-path sessions nobody expected.
- **The way back:**
  - On the branch: `git revert -m 1 <merge>`.
  - On the VM: `sudo kinerary-cp-release rollback --dry-run`, then the real rollback. The database is kept only if every sprint-6 migration is `compatible`.
  - First, count pending drafts (§3).
  - What rollback does not undo: changes already applied to `intake_sessions.answers`, and any intake confirmed since.

## 8. Decisions needed

1. Is the boundary re-audit (E) the merge gate? #206's progress comment listed a boundary read before merge.
2. Items 2 and 3 (about 15 min): in this PR, or a follow-up issue?
3. The web confirm route still returns 422 `PENDING_CHANGE` with no way to settle a draft on the web. Is that acceptable?
4. `change.uneditable` tells the organizer to "tell the Kinerary team". Is there a channel for that, or is it a dead end?

## 9. What cdf6a09 closed, with the proof

**The method.** On the old head, the new test file cannot tell you anything about the fix. It fails to import (`does not provide an export named 'PREVIEW_BUDGET_CHARS'`; run by me, 1 test, fail 1). So "fails on the old head" is true of all 20 tests, for a reason unrelated to the bug.

What I ran instead: `cdf6a09`'s own `src/` in a scratch copy, with one fix removed at a time (`scratchpad/mut199w/mutate.py`), the integrity file alone, database `cptest_int199w`. The unmutated baseline was 20/20.

| Mutation (fix removed) | Tests that fail | Reading |
|---|---|---|
| **Defect 2: all digest checks** (settle, typed yes, pick, both lock checks) | "a stale button after a merge, and after a relay restart…" (L201); "the guard is atomic…" (L237); "a TYPED yes confirms only the version whose preview was delivered…" (L274); "a stale pick tap is not applied…" (L302); "a button from before digests existed is never applied" (L335) | **FIXED.** L201 is the exact scenario from the first pass: merge, then `forgetShownPreviewsForTests()` as the restart, then the old Yes. |
| Only the lock-level checks | L237 only | the under-lock check carries the race. **The lock check in `pickForDraft` is guarded by no test** (item 3) |
| Only the relay's pre-checks | none: 20/20 | the lock checks alone refuse the stale Yes, and the relay checks are a second layer. This is fine |
| **Defect 3: propose moved back after `markInterpretationCommitted`** | "the relay dies while the draft is created…" (L369); "the relay dies after the draft, before the commit…" (L386); "a MIXED message … resumed after a crash keeps both…" (L400) | **FIXED.** L369 and L386 cover the lost-change window; L400 covers the mixed-message loss the first pass named |
| The committed-replay re-show branch disabled | none, in this file (20/20) or in `typed-changes-flow-db` (29/29) | an **untested** branch (item 2) |
| `last_prompt` recorded before the send, as at 0849880 | L274; "a refused send records no prompt…" (L349) | the send-failure half is guarded |

**Weak tests, read:**
- **"a tap racing a typed follow-up, 20 rounds" (L252) passed with the whole digest fix removed.** It is not a guard for defect 2. Reading the code, the tap nearly always wins: the typed path has more round trips (queue, flush, claim, model, propose) before it merges. Its closing assertion (`Object.keys(outcomes).length >= 1`) is always true.
- **L302's stored-ages assertion is vacuous**, because a pick resolves a candidate and never writes answers. The `change.updated` assertion is the one doing the work.

**First-pass items, and their status now:**
- Item 2 (revision in the callback) and item 3 (propose before commit): **closed**, as above.
- Item 4 (a dispatch-level test for `pc:`): **closed** by two tests in `relay-dispatch.test.ts`. One checks that a tap from the owning chat becomes `interview_callback`, carrying its digest. The other checks that a tap from a stranger, a group, or a confirmed session becomes `callback_reply`. I read both. I did not mutate the dispatch branch; by reading, removing it fails the second test on `kind`.
- Items 1, 5 and 6 (the chaos organizer, real Telegram, Hebrew): **still open.**

**Still unverified, and what it costs:**
- The Hebrew review: about 20 min, Dror, now covering 8 more strings.
- One model at one effort (114 calls, `claude-sonnet-5`/medium): about 7 min to re-sample at the VM's settings, if they differ.
- A real Telegram walk: about 20 min.
- #214 (fold resurrection) and #216 (bookings): open, and not touched by cdf6a09.
- The chaos organizer has no `pc:` handling: item 1.
- The geresh/gershayim fold, and the production `entry_key` query: 1 min, read-only.
- The live-fleet reads (§4): owed, about 10 min.
- The boundary findings are the Opus audit's to confirm, not mine.

<details><summary>Evidence, 2026-09-25 (second pass)</summary>

- `git show cdf6a09 --stat`: 13 files, +1201/−95. `git diff 0849880 cdf6a09 --stat` has the same 13 files, none under `db/`.
- `git merge-tree --write-tree c29aa3f cdf6a09` gives `871e190`. `gh pr view 199`: `isDraft: true`, `headRefOid cdf6a09…`, `mergeable: MERGEABLE`.
- `scratchpad/merged2`: contains `draftDigest` (6 hits in `poller.ts`) and `OutageNoticeLimiter` (5 hits in `dispatch.ts`). It is the merged tree, with both sides present.
- `merged2-suite.log`: `# tests 1894 / pass 1886 / fail 2 / skipped 6`, `duration_ms 816945`. Failures: `not ok 405 - release CLI` (build: "fatal: not a git repository"; promote: "Unexpected end of JSON input"). Skips: 5 × `vault://` and 1 real-extraction fixture.
- The scratch copy `scratchpad/head` `src/` matches `git archive 0849880` exactly (`diff -rq`).
- Mutation logs: `scratchpad/mut-{baseline,digest-all,digest-lock-only,digest-relay-only,order,no-committed-replay-show,replayshow-flow,prompt-before-send}.log`.
- I read `dispatchCallback` on the merged tree at `dispatch.ts:1365–1467`.

</details>
