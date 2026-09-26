# Regression plan: PR #199 round 3 (f29b4ef), the typed-change flow (#206)

**Verdict: SUFFICIENT to merge into `integration/sprint-6`, NOT sufficient to deploy to the VM.** Round 3 leaves the previous verdict ("enough to merge, not enough to deploy") where it was. Two conditions apply.
- **One merge gate is still unmet: the full `control-plane/api` suite on the merged tree `fa11dce`, on a test database of its own.** Nobody has shown a run at f29b4ef. The PR body's 1859/1853 figures belong to the cdf6a09 era.
- **Round 3 adds one behaviour that no test pins.** A bare "yes"/"no" now reaches a waiting change whatever is on screen, because the outer `startsPc` guard was dropped. With the fake model, which ignores the text it is given, the new tests pass whether or not that guard is there. Fixing that is a 5-minute test. It does not block the merge (§8 item 1).
- **VM:** #199 does not re-provision anything, and it cannot touch the two live trips. Every entry point refuses a confirmed session. Leaving #199 off (shipping dark) is **worse** than shipping it: without it, sprint 6 carries #205's typed-correction data loss to production (§4). The #217 "ship dark" question is about #178's document route. It is separate from #199 and should be decided on its own.

Assessed by `regression-planner`, 2026-09-26, branch mode, local. **I did not run any DB suite:** the brief forbids it, and another agent holds `cptest` on port 5434. I also did not read production (no SSH, per the brief). Every fleet fact below is carried from the 2026-09-25 read, with its source. I deployed nothing and restarted nothing.

## What round 3 changes about the previous plan

The previous plan is `regression-plan-2026-09-25-pr199-typed-changes.md`, at cdf6a09. It is **uncommitted**: it exists only in the worktree `agent-a8e11a30472e707be`. It superseded the committed `regression-plan-2026-09-25-pr199-return-leg-marker.md` (722186d). That earlier plan found the silent drop of typed changes, and #206 was the answer to it. Here is each of the previous plan's items, re-checked by reading f29b4ef:

| Previous item | Status at f29b4ef | Evidence |
|---|---|---|
| 1. Teach the automated organizer to answer a `pc:` preview, then walk `chaos` | **Still open** | `git grep 'pc:' fa11dce -- control-plane/api/tools` finds nothing. `auto-organizer.ts` acts only on `q:` prompts (`onScreen`, :366). Both `CHAOS_LATE_CORRECTIONS` (`organizer-chaos.ts:54`) are typed changes to held lists, so both become drafts. Expect a stall. That is an inference, not a run |
| 2. Test the re-show branch after a committed crash | **Closed** | New test "a reading that was committed and its draft made, but whose preview never reached the organizer, is SHOWN when replayed". With the branch disabled, `live.previews.length` is 0 and the test fails (checked by reading) |
| 3. Test the digest check in `pickForDraft` under its lock | **Closed** | New test "pickForDraft refuses a stale digest UNDER THE ROW LOCK, on its own" calls the store directly. With the check removed it returns a Draft, and `assert.equal(stale, "updated")` fails (checked by reading) |
| 4. A real-Telegram walk | Open | Round 3 adds checklist lines to it (§5, run D) |
| 5. A native Hebrew read | Open, **4 more strings** | New: `change.droppedTooBig`, `change.line.unchangedMore`. Rewritten: `change.uneditable`, `change.sendFailed` |
| 6. The 20-round race test was vacuous | **Closed** | It is renamed "REGRESSION GUARD, not the proof". It now asserts that the model read the follow-up, that the applied drafts match what is stored, and that the preview on screen carries the waiting draft's digest |
| Decision 4: `change.uneditable` points to a support channel that does not exist | **Closed** | The copy was rewritten. A test asserts `doesNotMatch(/team\|support/i)` |

## 1. Change set

| PR | Head | Base | Files |
|---|---|---|---|
| #199 (draft; `mergeable: MERGEABLE`, `gh pr view`, 2026-09-26) | `fix/114-return-leg-marker` @ `f29b4ef` | `integration/sprint-6` @ `c29aa3f`, merge base `96a2897` | 24 files, +6897/−35. All are under `control-plane/api/`, plus one migration, `control-plane/db/migrations/20260925180000_intake_pending_changes.sql` |

- **Round 3 is `f29b4ef` alone:** 11 files, +647/−77.
  - Source: `intake-copy.ts`, `interview.ts`, `relay/dispatch.ts`, `relay/poller.ts`, `typed-changes.ts`, `typed-changes-render.ts`, `typed-changes-store.ts`.
  - Tests: `typed-changes-integrity-db` (+360), `typed-changes-render`, `typed-changes`, `relay-dispatch`.
  - **It touches no migration.**
- **Merged tree:** `git merge-tree --write-tree c29aa3f f29b4ef` gives `fa11dce`, clean. Nothing reads the new `callback_ack` decision kind except `applyDecision`. The other `decision.kind` switch (`interviewChatOf`) sends it to `default: null`, which is correct, because a tap acknowledgement is not the organizer speaking.

**What round 3 does, and what pins each piece.** "Pure" means I mutated a scratch copy of `fa11dce` and ran the non-DB tests. "DB" means I checked by reading only.

| Round-3 behaviour | Where | Test that fails when it is removed |
|---|---|---|
| Cancel needs no digest. Only apply must match | `settleChange` in `poller.ts` | DB: "way out: the OLD Cancel button after a follow-up merged in" |
| A pick or rebuild that grows past the budget drops the draft out loud | `pickForDraft`/`rebuildDraft` (`too_big`), `reshowDraft` | DB: "a pick that turns a short question into a preview too big…" and "a held list that GROWS…" (the fake Telegram refuses more than 4096 characters, `:112`) |
| Warnings and effects are recomputed under the row lock at apply; `UPDATED` if they differ | `applyPendingChangeForChat` (`interview.ts`) | DB: "the guard is under the lock…" and the GI-77 booking test |
| The digest includes the warning and effect lines | `draftDigest` | **Pure, measured:** 1 failure when removed |
| Names cleaned wherever they are rendered: `fill`, `entryText`, `heldRefLists` | render and typed-changes | **Pure, measured:** 2, 1 and 1 failures |
| Wider `FORBIDDEN_TEXT` (Cf, Co, variation selectors, tags) | `typed-changes.ts` | **Pure, measured:** 4 failures with the old regex |
| "…and N more" summary of the unchanged block | render | **Pure, measured:** 1 failure |
| A forged `pc:` tap gets `callback_ack` (a toast, nothing posted) | `dispatch.ts`, `applyDecision` | DB: `relay-dispatch` `deepEqual` on `callback_ack`; integrity 5 (`acks` 1, `sent` []) |
| A bare "no" to a preview that was never delivered **shows** it, and does not cancel | `runInterpretPath` inner branch | DB: 5c "a 'no' to a change that was never shown SHOWS it first" (removing the branch cancels an unseen change) |
| **A bare yes/no is claimed by the waiting draft even when `lastPrompt` is not `pc:`** (outer `if (waiting && session.ok)`; cdf6a09 required `startsPc`) | `runInterpretPath` | **None.** Restore cdf6a09's outer guard and the 5c tests still pass: `fakeModel(() => [update(...)])` re-emits the op for "yes"/"no", the op merges, `announceChange` shows the preview, and nothing is applied. The tests never assert that the model was *not* called. With a real model, "no" returns no ops, the interview presses on, and the change waits unseen until Confirm refuses |

## 2. Risk table

| Change | Surface (§2 row) | Blast radius | Migration | Compatibility break | Risk | Test | Min | Batch? |
|---|---|---|---|---|---|---|---|---|
| Typed change to stops/travellers becomes propose, confirm, apply | `api/src/relay/`, at the relay restart | Every interpret-path interview holding stops or travellers | yes, additive | held lists are no longer written by a typed message | medium: a model in the loop | flow + integrity DB (the author's); harness | 7 (harness) | isolated harness, batched walk |
| Round 3: apply refused when warnings moved; drop when too big | relay and `interview.ts` (API code, called from the relay) | same | none | none | low | pinned (above) | 0 | — |
| Round 3: a bare yes/no goes to the draft whatever is on screen | relay | an organizer who answers another prompt with a bare yes/no while a change waits | none | UX: that answer is taken as "show me the change", and the question is asked again after they settle it | low: visible, not data loss | **unpinned** (§8.1) | 5 | batched walk check D8 |
| Round 3: `FORBIDDEN_TEXT` refuses ZWNJ, ZWJ and SHY in names the model supplies; `cleanText` turns them into a **space** | relay | a place name with ZWNJ (Persian) or one pasted with a soft hyphen | none | the change is asked, not applied. Cleaned display splits a word ("Neu schwan stein") | low, cosmetic | pure tests | 0 | — |
| Confirm refused while a change waits | API (web confirm: 422 `PENDING_CHANGE`) and relay | all interviews | same | the web has no UI to settle a change | low | flow DB | 0 | — |
| `identityFold` geresh/gershayim fold (round 1–2, not round 3) | `answer-merge.ts`, and through it `document-correction.ts` on **confirmed** trips (#178) | stored `entry_key` values for names containing ׳ or ״ | none | persisted keys may stop matching | low; **silent** | read-only DB query | 1 | isolated |
| `pc:` authorisation | relay | any chat | — | — | security path | round 3 *is* the re-audit's fixes. **Nobody has audited the fixes themselves** | own pass | isolated, `boundary-reviewer` |

## 3. Migration and compatibility findings

**The migration** (`20260925180000_intake_pending_changes.sql`, unchanged since slice 2).
- Its header reads: `-- rollback: compatible — one new table and its indexes; nothing existing changes shape, and nothing reads the table until the typed-change flow (#206, slice 3) ships`.
- It is purely additive. It creates `CREATE TABLE IF NOT EXISTS`, two indexes (one of them a partial `UNIQUE (session_id) WHERE status='pending'`), and FKs with `ON DELETE CASCADE` to `intake_sessions` and `trips`.
- It does not change any existing row, so no snapshot rehearsal is needed. `migrations.test.ts` has been updated to list it (both lists), so a failure there is not "expected noise".
- The header's last clause is now stale, because slice 3 ships in the same PR. That does not change the classification: the old code reads nothing from the table.

**What a rollback does to live rows.**
- `vm-release.py` treats `compatible` as "keep the database", so the table and its rows stay.
- The old relay does not read the table. Any `pending` draft is orphaned without anyone seeing it.
- The old relay does not know `pc:` taps. The earlier pass says they fall to the approval path and are refused (carried, not re-read).
- The old Confirm does not check for drafts, so an organizer who confirms loses a waiting change without being told.
- Rolling forward again, the orphaned row is harmless: a confirmed session is refused everywhere, and a live one gets `STALE` and a rebuild.
- **Before any rollback:** `SELECT count(*) FROM control_plane.intake_pending_changes WHERE status='pending'`.

**An interview started before this code.**
- It continues. There is no new `ui_state` field. The first typed change to a held list after the relay restart becomes a draft.
- One narrow window: a burst whose model call ran on the old relay and whose commit did not land is resumed from stored `proposals`. Those are old-shape stops/travellers proposals with no draft. The new path sends stops and travellers "only through the confirmed flow" (`poller.ts` ≈3009), so they are asked about, not written.
- The release tool's upgrade guard refuses to run under interviews that are mid-turn (carried from #217), which makes this window unlikely.

**The reverse.** Covered under rollback above. Also: the digest format changed in round 3, because warnings are now in it. A button drawn by cdf6a09 code would get `UPDATED` and be re-shown. No such button exists outside test databases: cdf6a09 never ran against a real chat, as far as the PR body and the fleet read of 2026-09-25 show.

**Restart order is one-way.** `getOpenDraft` runs on **every** typed interview message. A relay started against a schema without the table fails every one of them with `42P01`. On the VM the release tool migrates (API boot) before restarting the relay. That is the earlier pass's reading, not re-read today. On the Mac, rebuild the API and bring it up first, then run `scripts/relay-restart.sh`.

**Two producers.** Only the interpret path makes drafts. The legacy agent path still overwrites lists, a known limit stated in the PR body. The PR body says 28 of 28 production sessions are on the interpret path. I have not verified that; see §4.

## 4. Live-fleet impact (not read today; carried from 2026-09-25)

| Fact | Source | Status |
|---|---|---|
| The VM's schema is at `0051` (51 applied), so it does not run sprint 6 | first-pass fleet MCP read, 2026-09-25 | carried. **`0051` is also main's newest migration** (`git ls-tree origin/main`), so the schema alone cannot say which main commit the VM runs |
| 2 live `ready_private` trips (`orlando-florida-2026`, `japan-tokyo-hakone-kyoto-osaka-2026`), with confirmed intakes | same | carried. The brief says they are mid-trip |
| 1 open interview, `opening`, idle 54 h | same | carried. #205's body says it is expired |

**Who feels #199, and when.** It reaches the VM only when sprint 6 is merged to `main` and someone runs `kinerary-cp-release upgrade`.
- **Relay restart:** the typed path (`runInterpretPath`) and `pc:` taps (`dispatch.ts` into `applyInterviewCallback`). Felt by new or in-flight interviews only. With provisioning on for a real organizer, that means the next organizer invited.
- **API restart:** the migration, and the web confirm route's 422 while a change waits.
- **The two live trips:** not by #199's flow. `proposeChange` returns `confirmed`, `applyPendingChangeForChat` returns `SESSION_CONFIRMED`, and a `pc:` tap from a confirmed session gets `callback_ack`. The last is pinned by a `relay-dispatch` test.
  - They do feel `identityFold`, through #178's document corrections, and only for names containing ׳/״.
  - The relay restart itself interrupts every live Telegram conversation. That is sprint 6's cost, not #199's.
- **No trip site needs a redeploy.** The change is in the control plane only.

**Why shipping #199 dark is worse than shipping it.**
- The sprint-6 tip still writes the raw proposal on the typed path (`poller.ts:2523`, `submitArgsFor(accepted.proposal.value)`). The prompt asks for "only what is being ADDED or CHANGED" (`interpret.ts:1266`). That pairing is #205: entries already held are lost.
- **`origin/main` carries the same pair** (`poller.ts:1624`, `interpret.ts:1084`, introduced in e2ff4c8 on 2026-09-18).
- #205 says "not live on the VM today". Whether that holds depends on the VM's `KINERARY_REV`, which I could not read.
- There is no flag, by owner decision 8. So the alternative to shipping #199 is shipping #205.

**Owed before the VM.** Five read-only probes, about 10 minutes, run by the lead session under the MVP probe rule:
1. The VM's `KINERARY_REV`: does it already contain e2ff4c8?
2. `interpret_path` counts.
3. The VM relay's `INTERPRET_*` and `EXTRACT_*` settings, so the harness is re-run at the same settings.
4. `SELECT count(*) FROM control_plane.trip_answer_sources WHERE entry_key ~ '[׳״]'`, and the same query on `trip_answer_conflicts`.
5. The open interviews at the moment of the deploy window.

## 5. The plan

| # | Run | Command / where | Checklist | Min | Who |
|---|---|---|---|---|---|
| A | **Done by me.** Typecheck and non-DB tests, merged tree `fa11dce` (a scratch archive, `node_modules` linked from the PR worktree; `package.json` identical) | `npx tsc --noEmit`; `node --import tsx --test` on `typed-changes`, `typed-changes-render`, `typed-change-eval`, `answer-merge`, `interpret` | tsc clean; **263/263** | 4.0 s + 0.9 s (measured 2026-09-26) | — |
| A′ | **Done by me.** Six mutations of the round-3 pure behaviours | scratch copy, the same two files | every mutation caught (§1 table) | ~2 s per run (measured) | — |
| A″ | **Done by me.** Harness dry run on the merged tree | `tools/typed-change-eval.ts --dry-run --reps 1 --lang both` | 38 prompts, 0 held items missing; no model called | <1 s (measured) | — |
| **B** | **Merge gate:** full `control-plane/api` on `fa11dce` | `CONTROL_PLANE_TEST_DATABASE_URL=…/<own db, not cptest> npm test --prefix control-plane/api`, from a checkout of `fa11dce` | 0 fail. A single red test is rerun, then run alone, before it counts (`cptest` contention reads as `42P01`). The only failures expected on an archive are the two `release CLI` "not a git repository" ones, so run it in a real checkout | ~14 (derived: 816,945 ms at cdf6a09 in the earlier plan, plus about 12 new integrity tests) | verifier, once port 5434 is free or on its own Postgres |
| B′ | §8.1: pin the outer yes/no branch | add `assert.equal(model.calls.n, 1)` after each bare reply in the two 5c tests (or use a model that returns `[]` for "yes"/"no"), then run the integrity file alone | fails with the outer `startsPc` guard restored | 5 dev + ~1 (the file alone took 33–39 s at cdf6a09, earlier plan) | developer, then verifier |
| C | Real-model harness, **on the merged tree** (#192 and #218 change how `claude` is spawned), at the VM relay's settings | `node --import tsx tools/typed-change-eval.ts --reps 3 --lang both --out …` | 0 false positives in noise; return leg becomes `add_stop`; `removesEverything` present on the hostile case; compare with the 108/114 of 2026-09-25 (#206) | ~7 (derived: 114 calls × ~7 s ÷ concurrency 2) | nobody present; the Mac, no deploy |
| D | **One Mac trip, two halves**, on `@Tripinterviewer_bot`, stack brought up from the merged worktree | a Mac deploy (**hard-rule-2 prompt**); no VM run overlapping | **Interview half (#199):** D1 EN "actually Tokyo is 20 to 25": preview shown, nothing stored until Yes. D2 HE age change, then `כן`. D3 an **old** Yes after a follow-up and a relay restart: `change.updated`, nothing applied. D4 Confirm while a change waits: refused, change shown. D5 Cancel restores the displaced question. D6 *(round 3)* the **old** Cancel after a follow-up still cancels. D7 *(round 3)* preview "remove Kyoto", then upload a hotel PDF dated inside Kyoto, then tap the old Yes: nothing applied, new preview lists the booking. D8 *(round 3, for the decision)* with a change waiting, answer something else, then type a bare "no" to the next question: note what happens. D9 a traveller named with ׳ (for example ג׳ורג׳). Read `interpret_path` off the session. **Confirmed half (#178 into #217):** once the trip reaches `ready_private`: a PDF to the organizer's DM, then the proposal, then Approve and rebuild; a DM photo; the outage line with the gateway stopped. Then `teardown-trip.py`, which exercises the cascade on a trip that had drafts | ~60–75 (est.: 20 for the interview (earlier plan) + provisioning + 20–40 for #217 (#217's own estimate)) | Dror |
| E | Automated-organizer `pc:` support, then chaos | code in `tools/auto-organizer.ts`; then `--deploy --auto --scenario chaos --cleanup` | both late corrections previewed, confirmed and applied once; at least 5 travellers; Naxos and Santorini present | ~45 dev (earlier plan's est.) + tens of minutes walking | developer; hard-rule-2 prompt; Mac window |
| F | Fleet reads (§4) | read-only fleet MCP or probe | five answers | ~10 (est.) | lead session |
| G | Hebrew native read | `intake-copy.ts` `change.*` / `warn.*` (he) | 4 new or rewritten strings in round 3, plus the earlier ones | ~20 (earlier plan's est.) | Dror |

**Batched vs isolated.**
- D batches #199's interview checks with #217's confirmed-trip walk **on one throwaway trip**. The observables do not overlap: interview drafts before Confirm, and correction proposals after. That saves one provisioning cycle.
- These are isolated:
  - C (a model in the loop: a sample, not a pass).
  - The geresh query in F (a silent failure).
  - E (blocked on tooling; it will stall until then).
  - The boundary pass (a security path).
- D uses the Mac, never `japan`: the fixture collides with the live Japan trip (memory, 2026-09-25).

## 6. Budget

- **Merge (minimum):** B (~14 min, verifier) plus the owner lifting the draft. B′ (~6 min) is cheap insurance on the one behaviour with no test, and I recommend it. It is not a blocker.
- **VM (in addition):**
  - C, about 7 minutes, nobody present.
  - F, about 10 minutes.
  - G, about 20 minutes (Dror).
  - D, about 60–75 minutes (Dror).
  - E, about 45 minutes of dev plus a walk.

  That is roughly 2.5–3 hours of dev and walks, about 1.5 hours of it with Dror (est.). D is the only proof that a typed change survives real Telegram and a real document together. E is the only hands-off proof that a draft cannot stall an interview. **Without D, E and F you are choosing to find out on the next real organizer.** Without F, you do not know whether production already has #205.
- **Deferral option:** #217 already offers "deploy after 3 Oct". If Dror takes that, the whole VM tier moves with it, and nothing about #199's merge changes.

## 7. Go / no-go and the way back

**Stop the merge if** B is red after a rerun and an isolated rerun, if a boundary pass on round 3 is required and not done (Decision 2), or if the owner keeps the draft.

**Stop the VM deploy if:**
- C shows any false positive, or the return leg is not `add_stop`.
- D applies anything without a Yes, leaves a change that cannot be settled, or D7 applies on the old Yes.
- The #217 half fails.
- E stalls.
- F shows agent-path sessions nobody expected, or a turn that is mid-flight at the window.

**The way back:**
- On the integration branch: `git revert -m 1 <merge>`.
- On the VM: `sudo kinerary-cp-release rollback --dry-run`, then the real rollback. It takes the snapshot itself, and the database is kept because the header is `compatible`.
- **First,** count pending drafts (§3), and tell any organizer who has one. Cancelling drafts is a write and needs approval.
- Rollback does not undo answers already applied, nor an intake confirmed since. And whatever the rollback target does with typed corrections comes back with it (#205, if the target has e2ff4c8).

## 8. What would reduce the risk (ranked by risk removed per minute)

1. **Pin the outer yes/no branch (about 5 min).** In both 5c tests, assert `model.calls.n === 1` after the bare reply. This turns round 3's one unpinned behaviour into a test that fails when the behaviour is removed.
2. **Read the VM's `KINERARY_REV` (about 1 min, read-only).** It settles whether #205 is already live. If it is, #199 is a fix production is waiting for, not just new behaviour.
3. **The geresh query (about 1 min, read-only).** It turns the `identityFold` change from silent into known on the live trips.
4. **Re-run the harness on the merged tree (about 7 min, nobody present).** The sample on 2026-09-25 predates #218 and the merge.
5. **A relay-start check that the table exists (about 10 min).** One `SELECT … LIMIT 0` on `intake_pending_changes` at relay boot makes a relay-before-migrate order fail loudly at start, instead of `42P01` on every interview message.
6. **Have `cleanText` delete zero-width characters instead of replacing them with a space (about 5 min).** Map ZWSP, ZWJ, ZWNJ, SHY and WJ to `""`, and only line-breaking characters to `" "`. A pasted "Neu­schwan­stein" then stays one word.
7. **Automated-organizer `pc:` support (about 45 min), then chaos.** This has been owed since the earlier plan, and it is the largest remaining item.

## 9. Decisions needed

1. **The merge gate run (B):** who runs it, and on which database? `cptest` is in use. B needs either a free window on port 5434 or its own Postgres.
2. **Is a boundary pass on round 3 required before the merge?** The PR's own rule is "boundary audit and its re-audit clean". Round 3 is the re-audit's *fixes*, and no reviewer has read the fixes.
3. **A bare yes/no while a change waits and another question is on screen:** should the waiting change always win, as round 3 does? It is safe, but the organizer's answer is asked for again. Or should it answer the on-screen question, as cdf6a09 did? Whichever you choose, item 8.1 pins it.
4. **VM in sprint 6: #199 and #217 are separate decisions.**
   - #199 has no flag by owner decision 8, cannot touch confirmed trips, and replaces #205. Recommendation: it ships with sprint 6 or not at all.
   - #217's "dark or after 3 Oct" question concerns #178's re-provisioning route, which is already on the branch.
5. **The harness's runner settings:** use the VM's (from F), or `claude-sonnet-5`/medium as in `provisioning.env`?

<details><summary>Evidence, 2026-09-26</summary>

- `gh pr view 199`: `headRefOid f29b4efe…`, `isDraft: true`, `mergeable: MERGEABLE`. `git rev-parse origin/integration/sprint-6` = `c29aa3f…`. `git merge-tree --write-tree` gives `fa11dce9…`, exit 0.
- `git show --stat f29b4ef`: 11 files, +647/−77, nothing under `db/`.
- The `interpret.ts` prompt is unchanged between `e9d1479` and `f29b4ef` (`git diff --stat`: only `typed-changes.ts` and the tool changed). The #206 real-model comment (18:15Z) falls between e9d1479 (20:44 +0300) and 0849880 (21:36 +0300).
- Scratch merged tree: `scratchpad/m199r3` (`git archive fa11dce control-plane/api`). tsc: 4.021 s. Tests: `# tests 263 / pass 263 / fail 0`, `duration_ms 890`. Mutation results (pass/fail of 92): baseline 92/0; `fill` uncleaned 90/2; `entryText` uncleaned 91/1; no summary 91/1; digest without warnings 91/1; old `FORBIDDEN_TEXT` 88/4; `heldRefLists` uncleaned 91/1; restored 92/0.
- Harness `--dry-run`: "38 prompts, no model called, held items missing from a prompt: 0".
- `integration/sprint-6` `poller.ts:2523` and `origin/main` `poller.ts:1624` both write `submitArgsFor(accepted.proposal.value)`. The "ADDED or CHANGED" prompt is at sprint-6 `interpret.ts:1266` and main `:1084`, and is on main since `e2ff4c8` (2026-09-18).
- `e2e-full-cycle.py:1172`: `all` = japan, multi, manual. Chaos is only walked on its own.
- Round-3 tests read: the `typed-changes-integrity-db` diff (+360), the `typed-changes-render` and `typed-changes` diffs, and `relay-dispatch` (`callback_ack` `deepEqual`). The integrity file has 32 `test(` call sites, one of them inside a loop over 7 scenarios (grep).
- DB suites: **not run by me** (brief). No SSH, and no production read.
</details>

---

## Round 4 addendum (2026-09-26)

**Verdict: SUFFICIENT to merge #199 (round 3 + round 4) into `integration/sprint-6`, once one run passes. Still NOT sufficient to deploy to the VM.**

- **Why sufficient.** Every round-4 behaviour that changes what is *stored, applied or cancelled* has a test that fails when the behaviour is removed:
  - B1: the digest and the apply-time recompute still cover every warning.
  - B2: the names the parse accepts.
  - B3: a refused re-show drops the change only after a "no" or a blocked Confirm.
  - B4: nothing is done to an unseen version.
  - The floor take-back.

  For the pure half I measured it: 17 of 17 mutations were caught. For the DB half I checked by reading the tests (list below). The behaviours that nothing pins only decide **whether the organizer gets a duplicate message**. None of them decides what is written.
- **The one run that must pass:** the "TypeScript API" CI job on #199's merge ref, after #224 has landed, with round 4 committed on the branch (§4 below).
- **Round-3 conditions:**
  - (1) The full suite on the merged tree: **met for round 3 after all**. The round-3 plan said no run existed, and that was wrong. CI job `108253439396` ran on `ce6c5a3` (parents `c29aa3f` and `f29b4ef`, tree `fa11dce`, the exact merged tree) on 2026-09-25, 21:12–21:25Z. Result: 1921 tests, 1914 pass, **1 fail**, 6 skipped. The failure is "the super admin switches a task's model from their own DM", which is #223, the test #224 fixes. **Round 4 makes that run stale, so this condition is open again.**
  - (2) The `startsPc` gap: **closed**. The two 5c tests now assert `model.calls.n` after each bare reply. With cdf6a09's outer guard restored, the preview failed, so `lastPrompt` is not `pc:`, the bare "yes" goes to the model, and `calls.n` becomes 2. The test then fails (checked by reading).
  - (3) Decisions: still open. Decision 3 becomes more exposed (see §2 below).
- **Brief versus diff:** The developer's hand-back matches the staged diff: 7 files, +724/−79. One count is off. The brief says "5 strings added/reworded in total". The diff touches **6 keys** in both languages: 4 new `change.warn.*.more` / `moreNonRefundable` keys, the new `change.droppedUnshown`, and the reworded `change.uneditable`.
- **Not seen by me:** the Opus re-audit that said NOT YET. It is not on #199 or #206, and it is not in `docs/test-reports`. So I checked round 4 against its developer's own list, not against the re-audit's list. Whether round 4 closes every re-audit item is **unchecked**.

### 1. Round-4 behaviour, and what pins it

**Scratch tree `plan4`.** It is `git merge-tree --write-tree 7531ec6 f29b4ef`, which gives `6bac7c9` (that is `c29aa3f` + #224 + round 3; the merge is clean). On top of it I applied the staged round-4 patch.
- It is the expected final `control-plane/api` content, provided #224 lands as `7531ec6` and round 4 is committed unchanged.
- `node_modules` is linked from the round-4 worktree; the `package.json` files are identical.
- `tsc --noEmit`: clean in 3.5 s.
- Non-DB tests (`typed-changes`, `typed-changes-render`, `typed-change-eval`, `answer-merge`, `interpret`): **277/277 in 1.1 s**, measured 2026-09-26.

| Round-4 behaviour | Pinned by | Evidence |
|---|---|---|
| B1: booking warnings capped per removed stop or traveller (700 chars); non-refundable first; "…and N more" counts the hidden non-refundable ones; never "and 1 more"; one block per stop | render tests B1 | **Mutations, measured:** no cap 4 fails; no ordering 2; no non-refundable count 1; "and 1 more" allowed 1; one block for all stops 1; budget 700→3000 2 |
| B1: the draft, the digest and the apply-time recompute still cover all lines | render "draft keeps EVERY warning line"; DB B1 (a 41st booking gives `UPDATED`) | round-3 mutation "digest without warnings" **re-run on this tree: 1 fail** |
| B2: explicit allow-list (LRM RLM ALM ZWNJ ZWJ SHY VS15 VS16); SHY deleted and nothing-visible refused in `safeText`; `cleanText` deletes zero-width characters and turns line breaks into a space; `wordsOf` cleans before it folds | typed-changes "invisible characters" | **Mutations, measured:** allow-list back to marks only 4; VS16 forbidden again 3; forbidden→space 2; SHY kept by `cleanText` 2; no VISIBLE check in `cleanText` 1; SHY kept by `safeText` 1; no VISIBLE check in `safeText` 1; `wordsOf` does not clean 1; line breaks deleted instead of spaced 1. Round-3 "fill uncleaned" re-run: 2 |
| B3: picker buttons cut on code points | render B3 | **Mutations, measured:** `cutText` as a UTF-16 slice 2; picker button `.slice` 1 |
| B3: the suggestion label edit in `applyInterviewCallback` (`poller.ts:1275`) cut on code points | **none at the call site.** `cutText` itself is pinned | read |
| B3: a typed "no", or a blocked Confirm, whose re-show Telegram refuses drops the change out loud and resumes | DB B3 (en and he), and "Confirm blocked…" | read: without `dropIfUnsent` there is no `change.droppedUnshown`, and the assertions fail |
| B3: a "yes" to an unsendable change keeps it waiting | DB B3 "a typed 'yes'…" (`["pending"]`) | read |
| B3: a `sendMessage` that **throws** counts as `send_failed` | **none.** The fake Telegram never throws (`:104`), and neither does the real client: `telegram-api.ts` catches the `fetch` error and returns `ok:false` | read. This is defence in depth, so its low impact is by design |
| B4: a typed yes **or no** re-shows a version never seen and does nothing else | DB B4, plus the 7th way-out scenario | read: with `bare === "yes" &&` restored, the "no" cancels and `["pending"]` fails |
| Floor take-back in `showProposedChange` | DB "the race test's failing interleaving, made deterministic" (`preview > done`, and "once") | read: without the take-back the preview index is −1 |
| Floor take-back: **"that exact version is already on screen, so say nothing"** (`if (now.view.lastPrompt === changePromptKey(current)) return true`) | **none.** The deterministic test reaches `no_floor` only with a *fresh* draft. The 20-round guard only asserts that the *last* preview carries the open digest, so a duplicate preview would still pass | read (§2 below) |
| `change.uneditable` wording and noun | render string test; DB H (`"your stops"`) | read |

### 2. The floor change: what it can do live that the tests do not show

**Who can hold the floor while `showProposedChange` runs.** The relay runs two loops.
- `run()` handles Telegram updates: taps through `applyInterviewCallback`, commands, and queueing inbound messages. Queueing is `markAwaitingMachine`, at `:386`.
- `deliver()` runs, one after another: `flushSettledInboundBursts`, then `advanceRouterOwnedQuestions`, `renderDueRouterPrompts`, `recoverStalledInterviews` and `closeIdleInterviews` (`:4816–4820`).

`showProposedChange` is reached only from `announceChange` in `runInterpretPath`, which is inside the flush. So the scan, the due prompts and the stall recovery **cannot** interleave with it in one relay process. The only concurrent speakers are the **taps and commands from `run()`**, on an **interpret-path** session that is `interviewing` or at the recap. Agent-path sessions never make drafts. The window is the model call: 7–14 s for text, according to `hasPendingInbound`'s note.

The `takeFloor` callers that can collide are:
- `respond` → `sendNextStep`, after a `q:` tap;
- `settleChange` → `resumeAfterChange`, after Yes or No on a `pc:` preview;
- `showChangeDraft` / `reshowDraft`, after a pick, a stale Yes, or Confirm (`PENDING_CHANGE`).

`sendNextStep` has no knowledge of drafts: there is no `getOpenDraft` in it (grep).

| Interleaving during a follow-up's read | Result with round 4 | Tested? |
|---|---|---|
| Yes tap applies v1 **before** the follow-up is proposed | "Done" and the next question, then the follow-up's preview, once. Before round 4, the preview was lost silently | **yes** (deterministic) |
| A `q:` tap on an older question's button | next question, then the preview. `displacedPrompt` is stale, but `resumeAfterChange` works the next step out again | no. Same code path as above |
| A stale Yes tap **after** the follow-up merged | the tap re-shows the merged version, so the follow-up's show hits `no_floor`, sees that version on screen, and says nothing | **no** (the dedupe line is unpinned) |
| The same, but the tap's re-show is **still in flight**. `showChangeDraft` records `lastPrompt` only *after* Telegram answers (`:2385`), on purpose, so that a failed send is never confirmable | the dedupe cannot see it, the floor is taken back, and **the same version is previewed twice**. This is the one way round 4 gives two replies to one act. Both copies carry the same digest; a second Yes gets `change.gone`. UX only | no |
| A Cancel tap after the merge commits but before the show (milliseconds) | round 3's Cancel needs no digest, so it cancels the merged version, **including the follow-up nobody saw**. `showProposedChange` sees `cancelled` and returns false, and the follow-up gets no reply of its own. This comes from round 3, not round 4, and it is the tap-path exception to B4's rule. Very unlikely | no |
| A tap between the retry's `markAwaitingMachine` (`:2684`) and its `claimFloor` (two DB round trips) | the tap wins, the retry gets `no_floor`, and there is no third attempt. The draft waits unseen. It is recovered by a bare yes/no (B4) or by Confirm (B3) | no |
| Confirm during the read | the waiting version is re-shown. If the merge comes after, a second preview appears and the first one's buttons are edited off (`shownPreviews`) | partly (Confirm with an unsendable change) |

**The change that raises existing exposure: round-3 Decision 3.**
- Round 4 now puts a question *and then* a preview on screen in the same second.
- A bare "yes" typed as the answer to that question goes to the waiting change. It is the version on screen, so it **applies** it.
- Before round 4 that preview was lost. The same "yes" then only re-showed it (B4).
- The change applied is one the organizer typed and was shown, so this is not a stranger's write. But the answer to the question is lost, and it is asked again.

**Restart and rollback.**
- Round 4 adds no migration and no new column. `resolved_by = 'system'` is already written by `typed-changes-store.ts:168`.
- If the relay dies between the take-back's `markAwaitingMachine` and the send, the session is left at `awaiting='machine'` with an unseen draft. On boot, the scan's `sendNextStep` dedupes or re-asks the question, and the draft waits until a bare yes/no or Confirm reaches it. The same recovery exists after a refused send.
- `shownPreviews` is in memory and is lost on restart, as before.
- **Undoing round 4 alone:** revert its commit and restart the relay (`vm-relay-restart.sh`; it refuses under `awaiting='machine'` within 5 min). The database is compatible both ways.
- **Undoing the whole sprint:** round-3 §7 applies unchanged.
- **New log lines worth watching:** `interview.change_floor_taken_back`, `interview.change_dropped_unshowable`, and `interview.change_shown_on_request` (with `on_screen`).

### 3. Several removals at once: a gap in the tests, but a loud and recoverable one; blocks neither merge nor deploy

The cap applies per removed stop or traveller. With N removals there are N blocks of about 775 chars each. The whole draft is still measured against `PREVIEW_BUDGET_CHARS = 3500` (`typed-changes-store.ts:104`, the larger of en and he). Over that budget, `tooBig` refuses it with `change.tooBigFresh`: "please send it in smaller pieces". A merged change gets `change.tooBig`: "apply or cancel what's waiting first".

Measured on `plan4` (`applyOps` + `previewLength`):

| Removals in one message | Bookings behind each | Preview length (max en/he) | Result |
|---|---|---|---|
| 1 stop | 40 | 1,157 | fits |
| 4 stops | 5 / 10 / 40 | 3,475 / 3,475 / 3,479 | fits, barely |
| 5 stops | 3 | 3,369 | fits |
| 5 stops | 5 / 10 / 40 | 4,260 / 4,260 / 4,265 | **refused** |
| 4 travellers (of 6) | 20 flights | 3,239 | fits |
| 5 travellers (of 6) | 10 flights | 4,000 | **refused** |
| 2 stops (5 each) + 2 travellers (10 flights) | — | 3,578 | **refused**. A booking inside a removed stop is also listed under each removed passenger |

**Why this does not block merge or deploy:**
- It is a gap in what the tests cover. The only multi-stop test checks block order, not total length.
- It is **not** silent and **not** data loss. The refusal says so, and the advice works: each removal on its own fits (about 1,000–1,200 chars).
- **Likelihood:** an organizer would have to remove 4–5 entries in one message, *during the interview*, each already carrying several confirmed bookings. That is rare. The mixed stops-plus-travellers case is the likeliest way to reach it.
- **The one case where the advice does not help:** a *single* booking line longer than the budget cannot be split. `bookingText` does not truncate names, and `MAX_TEXT = 80` binds only names the model supplies. Whether names written by document extraction are bounded I **did not verify**. This is theoretical.

### 4. The merge gate on the final tree

**Sequence** (the owner's decision): #224 merges first. It changes only `relay-dispatch.test.ts`; its CI "TypeScript API" was still running at 04:54Z today. Round 4 is committed on `fix/114-return-leg-marker`, which needs the lead and the owner's approval. #199 is then rebased or merged onto the new tip. `git merge-tree 7531ec6 f29b4ef` is clean. Round 4 touches none of #224's files. Of the files round 4 touches, the integration branch changed only `intake-copy.ts` (+4) since #199's base `96a2897`. It did **not** touch `poller.ts`, `interview.ts` or `typed-changes*.ts` (`git diff --stat 96a2897 c29aa3f`).

**Must re-run on the final tree:**
- **The "TypeScript API" CI job on #199's new merge ref.**
  - That is the full `control-plane/api` suite with its own Postgres, which makes it gate B. It should be green, now that #224 removes the only red.
  - Measured: **~13 min** (job `108253439396`, 21:12:42→21:25:40Z, 1921 tests at `fa11dce`). Round 4 adds about 14 DB tests, so budget 13–15 min (est.). Nobody needs to be present.
  - A local run on a DB of its own (~14 min, derived in the round-3 plan) duplicates it. Use it only if CI is red and the rerun, then the isolated file, need a second environment. Neither `cptest_223` nor `cptest_199` may be used while they are reserved.
- **A tree check (1 min):** `git diff --stat 6bac7c9 <final merge tree> -- control-plane/api` must show exactly the 7 round-4 files, +724/−79. If it does, everything under "can stay" applies to the final tree verbatim.

**Can stay as evidence:**
- my `plan4` run: tsc, 277/277, and 17 + 2 mutations;
- the developer's round-4 DB results and its loaded race runs (10 runs; I did not see them run). `poller.ts` and the store are byte-identical across the merge;
- the round-3 pure mutations and the harness dry run.

**Does not carry:** the developer's 1905/0/6. That run was on `f29b4ef` + round 4, **without** `c29aa3f`'s dispatch, model-runner and #215 changes, so it is not a merged-tree result.

### 5. What is still owed before any VM deploy (updates round-3 §5 and §6)

| Item | Change since round 3 | Minutes | Who |
|---|---|---|---|
| F: the five read-only fleet probes | unchanged; still unread (no SSH in this run) | ~10 (est.) | lead |
| C: real-model harness, EN+HE, on the **final** tree | must run **after** round 4 is in: B2 changes how model-supplied names parse (`FORBIDDEN_TEXT`, `safeText`) and resolve (`wordsOf`) | ~7 (derived in the round-3 plan) | nobody |
| D, interview half: the real-model walk EN+HE on `@Tripinterviewer_bot` | add **D10**: with a preview up, type a follow-up and tap the old Yes while it is being read. Expect "Done", the question, then **one** new preview, and `interview.change_floor_taken_back` in the relay log. Add **D11**: a traveller named with an emoji and one with a ZWNJ is shown unaltered. B1, B3 and B4 cannot be provoked by hand (they need a refused send or 40 bookings); the DB tests are their only evidence | ~25 (was 20; est.) | Dror |
| D, #178→#217 half, on the same throwaway trip | unchanged | 20–40 (#217's est.) + provisioning | Dror |
| G: Hebrew native read | round 3's 4 strings, plus round 4's 6 keys: `change.warn.bookingInRemovedStop.more` / `.moreNonRefundable`, `change.warn.bookingForRemovedTraveller.more` / `.moreNonRefundable`, `change.droppedUnshown`, and `change.uneditable` with `change.noun.stops` / `change.noun.travellers` substituted. Worth an extra look: `מתוכן, מסומנות כבלתי ניתנות להחזר / לביטול: {nonRefundable}` | ~25 (was 20; est.) | Dror |
| E: `pc:` support in the automated organizer, then chaos | unchanged, still open | ~45 dev + walk | developer |
| **New:** watch the first real interview after deploy | grep `change_floor_taken_back`, `change_dropped_unshowable` and `trip_bot.floor_lost` | ~5 | lead |

**Totals:** time with Dror goes from about 1.5 h to about 1.7 h (est.). The total VM tier is still about 2.5–3 h.

### 6. What would reduce the risk (ranked by risk removed per minute)

1. **The tree check after the rebase (1 min).** It is what lets every pure result above count for the final tree.
2. **Pin the dedupe line (~10 min dev + about 40 s for the integrity file alone).** Write a deterministic test in which the model hook merges the follow-up, a stale Yes tap re-shows the merged version, and only then does the follow-up's show run. Assert exactly one preview carrying that digest. Delete `if (now.view.lastPrompt === changePromptKey(current)) return true;` and the test must fail.
3. **Close the in-flight window (~15 min, optional).** Both loops share one process, so an in-memory "showing <draftId>:<digest>" marker set before the send lets `showProposedChange` see a re-show that has not returned yet. That removes the duplicate preview entirely.
4. **Pin the label call site (~5 min).** One `relay-poller` case with an emoji at code point 3000.
5. **Make the multi-removal cap global (~20 min + a test, optional).** Divide the per-block budget by the number of blocks (for example `max(250, 2400 / N)`), so that 5 removals fit as well. Only worth it if Dror wants N removals in one message to work.
6. **A fleet-monitor alert on `interview.change_dropped_unshowable` (~10 min).** It fires when an organizer's change was dropped because Telegram refused it, which is exactly the case where the organizer may have been told nothing if Telegram was refusing everything.

### 7. Decisions needed (new or changed)

1. **Boundary pass (round-3 Decision 2, now wider).** Round 4 changes the name-safety set (B2 lets ZWJ, ZWNJ, SHY and VS15/16 through the parse) and the Confirm path. By reading, nothing it allows can break a line or reorder text. The PR's own rule is "boundary audit and re-audit clean", though, and no reviewer has read rounds 3 and 4. Is a `boundary-reviewer` pass required before the merge?
2. **Round-3 Decision 3, now more exposed:** see §2 above. Keep "a bare yes/no always goes to the waiting change", or answer the question when a question is the *later* message?
3. **Is CI's merge-ref run enough for gate B, or is a local run also wanted?** I recommend CI alone. It is the same tree, and its clean host is where #223 showed up.
4. **The re-audit's own list:** someone with access should confirm that round 4 answers every NOT-YET item. I could not.

<details><summary>Round-4 evidence, 2026-09-26</summary>

- `git diff --cached --stat` in `agent-a674ff20aa920f1df` (HEAD `f29b4ef`): 7 files, +724/−79.
- `origin/integration/sprint-6` = `c29aa3f`. PR #224 head is `7531ec6`, child of `c29aa3f`, touching only `relay-dispatch.test.ts`, +55/−3. `git merge-tree --write-tree 7531ec6 f29b4ef` gives `6bac7c9`, exit 0.
- CI for #199 (job 108253439396): `refs/pull/199/merge` = `ce6c5a3`, parents `c29aa3f` and `f29b4ef`, tree `fa11dce`. Result: `# tests 1921 / pass 1914 / fail 1 / cancelled 0 / skipped 6`. The failure is "the super admin switches a task's model from their own DM, and it is recorded".
- `plan4`: `tsc --noEmit` 3.458 s; 277/277, `duration_ms 1090`. Baseline for the mutations: `typed-changes` + `typed-changes-render`, 106/0, restored to 106/0 afterwards. The mutation script is `scratchpad/mutate.py` and the size probe is `scratchpad/multi.ts`.
- **Floor reading:** `claimFloor` / `markAwaitingMachine` (`interview.ts:2001–2031`); `takeFloor` (`poller.ts:3940`); `showChangeDraft` records `lastPrompt` after the send (`:2385`); the loops are at `:4816–4820`; `sendNextStep` (`:4223`) has no draft check.
- **Not done by me:** any DB suite (per the brief: `cptest_223` and `cptest_199` are reserved, ports 5433/5434 untouched), SSH, production reads, deploys and commits. The round-3 text above is unedited.
</details>
