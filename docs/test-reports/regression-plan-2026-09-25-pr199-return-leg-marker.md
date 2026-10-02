# Regression plan: PR #199 re-assessment at 2b5bff8 (return-leg marker, #114 problem 5, and #205)

**Verdict: no-go to merge as it stands.** The rework does what the PR says it does, and it passes on the merged tree too. It stores the merged list, a return leg becomes a second stop, and the marker is never stored. But writing the merged answer also makes a second behaviour live, and no test covers it:

- **A typed change to anything already recorded is now silently dropped.** "Actually Tokyo is 20 to 25", "Ruth is 71": the held value wins, the write succeeds, and the organizer is shown the unchanged value as if it had been accepted.
- **A moved date, a renamed stop or a corrected spelling now adds a duplicate** instead of replacing the entry.
- **A sibling can be absorbed into another traveller.** "Ella Cohen" is fused into a held "Bella Cohen".

Before this PR the same messages did change the value, but they replaced the whole list with the delta (#205). So this trades data loss for silent no-ops and duplicates. That trade is Dror's decision, and today no test holds it in place. There is no migration and no change to trip sites. Production does not run sprint-6 yet, so today nobody feels any of this.

Assessed by `regression-planner`, 2026-09-25. Branch mode, local. Production was read only through the read-only fleet MCP. I deployed nothing.

## What would reduce the risk (ranked by risk removed per minute)

1. **Pin down the change case with two DB-path tests before anything else (about 15 min, estimate).** I already wrote and ran these as throwaway probes (see Evidence), so they are known to work. Add them to `test/interpret-typed-merge-db.test.ts`:
   - E: held `[Tokyo 19–24 Oct, Kyoto 24–28 Oct]`, then the typed message "actually Tokyo is 20 to 25".
   - F: held `[Ruth Cohen 70, Avi Cohen 41]`, then the typed message "actually Ruth Cohen is 71".

   Assert the value you *want*. At 2b5bff8 both keep the old value. On base `d8427f7` both apply the change and lose the other entry. Whichever way Dror decides, the test makes the behaviour deliberate rather than accidental.
2. **Let a typed correction win on a matched entry (about 30 min, estimate).** This covers the most common correction. In `corrected()` (`interpret.ts`), call `reconcileStructured(existing, proposal)` instead of `mergeParts`. Then write each reported `conflicts[i].incoming` onto the matched entry. A correction is the one path where the organizer's newer words should win. Documents stay held-wins, because they go through `ctx.held`, not `ctx.answers`. This fixes date, age and time corrections where the entry still matches. It does not fix a date moved to a range that does not overlap, a rename or a removal (item 4).
3. **If item 2 is deferred, make the no-op loud (about 15 min, estimate).** When the correction merge reports conflicts and `changed` is false, reject the proposal with a reason instead of accepting it. The router then asks rather than answering "got it" with the old value. Today `mergeParts` throws the conflicts away (`answer-merge.ts`, `mergeParts` keeps `.merged` only).
4. **Turn off clip tolerance for typed names (about 15 min, estimate).** `cutShort` exists because a PDF clips one or two letters at its margin. Typed text is not clipped. With it on, "Ella Cohen" matches "Bella Cohen", "Anna Cohen" matches "Hanna Cohen", and "Vital Cohen" matches "Avital Cohen" (all measured `true` today). On the typed path that silently absorbs a new sibling. Add a `MergeOptions` flag (for example `clipped: false`) and pass it from `corrected()`.
5. **Decide how a stop is moved, renamed or removed by typing (Dror, see Decisions).** Now that the marker carries "this is a second visit", an **unmarked** same-name stop could match the one held stop of that name whatever its dates. That turns "no, Tokyo is 25 to 30" into a move instead of a duplicate. Renames and removals need an explicit, bounded operation from the model, like the marker. Nothing expresses them today.
6. **Add a precondition to the typed structured write (about 10 min, estimate).** `runInterpretPath` builds the merged list from `recorded`, which is read before a model call of several seconds (`poller.ts:2352`). It then writes with no `{ held }` precondition (`poller.ts:2526`). The document gate does both, with a retry. Before this PR the typed write overwrote everything anyway, so this is a narrower window, not a new one. I did not establish whether a document burst and a typed burst for one chat can overlap.

If Dror accepts silent no-ops as a deliberate interim step, the minimum is item 1 (the test asserting today's held-wins behaviour, labelled as known-wrong) plus an issue for items 2, 4 and 5. Then the PR can merge as described, because it no longer claims more than it does.

## 1. Change set

| PR | Branch / head | Base | Files |
|---|---|---|---|
| #199 | `fix/114-return-leg-marker` @ `2b5bff8` (GitHub `headRefOid` confirmed 2026-09-25) | `integration/sprint-6`, merge base `96a2897` | `src/answer-merge.ts` (+47/−4), `src/interpret.ts` (+47/−9), `src/interview.ts` (+4/−2), `src/relay/poller.ts` (+3/−1), `test/answer-merge.test.ts` (+66), `test/interpret-typed-merge-db.test.ts` (+185, new), `test/interpret.test.ts` (+76/−1). All under `control-plane/api/` |

**The base has moved again.** The brief says the tip is `dce60e9`. `origin/integration/sprint-6` is `d8427f7` (#204, a one-line change to `test/organizer-trips.test.ts`, fetched 2026-09-25). `git merge-tree --write-tree d8427f7 2b5bff8` is clean, giving tree `c4bcf36`. The brief's `38e5e1f` was against `dce60e9`.

**Merged tree vs PR tree.** No file overlaps. There is one semantic link. `poller.ts` and `interpret.ts` import `model-runner.ts`, and the base rewrote it under #192 (child-process env allow-list; `hermeticEnv` removed). The removed export is not used by any PR file (grep). I built the merged tree and checked it:
- `tsc --noEmit`: clean, 3.6s.
- `answer-merge`, `interpret`, `model-runner-env` and `claude-effort-inheritance` tests: 165/165 pass, 2.5s.
- The new DB test: 4/4 pass, 8.8s, against my own scratch database `cptest_rp199_merged`, which I dropped afterwards. All measured 2026-09-25.

So the PR-tree-only suite is sufficient for the code's own behaviour. It is **not** sufficient for the real-model run. That run must use the merged tree, because the base changed how `claude` is spawned.

## 2. Risk table

| Change | Surface | Blast radius | Migration | Compatibility break | Risk | Test | Min | Batched? |
|---|---|---|---|---|---|---|---|---|
| Typed path writes the merged answer (`submitArgsForAccepted`, poller:2525) | `control-plane/api/src/relay/`, run in the **relay** | Every interpret-path interview where the organizer types a correction to a recorded list, from the relay restart on | none | behaviour: add/fill now merge; **change is dropped silently**; move, rename and spelling fixes duplicate; removal is impossible | **High for correctness, low for reach** (prod has none of this yet) | items 1–3 | 15–45 (est.) | isolated: silent failure |
| Marker scoped to `phases` (`MergeOptions.visits`) | same | same | none | none | low: verified on the DB path (test D) | done | 0 | done |
| Marker stripped in `validateAnswer` and in `suggestFrom` | `src/` (API and relay) | every writer | none | none | low: verified | done | 0 | done |
| Prompt rule for `additional_visit` | relay model call | every interpret-path typed message about stops | none | none | **unmeasured**: model compliance | run 4 | ~15 (est.) | isolated: needs a real model |
| People matching on the typed path (`people: true`, `cutShort`) | relay | typed roster additions | none | a sibling with a clipped-looking name is absorbed | medium: silent, plausible in a family | item 4 | 15 (est.) | isolated |

## 3. Migration and compatibility findings

- **There is no migration.** No file under `control-plane/db/migrations/` is touched, so there is no `migrations.test.ts` noise and no snapshot is needed.
- **No trip-runtime payload.** Nothing under `site/`, `server/` or `shared/`, so no new release and no change to the seal.
- **What changed is the semantics of stored answers.** Measured on the real burst path (`flushSettledInboundBursts` with a fake model, reading `intake_sessions.answers`), same probe on both trees:

  | Typed message | base `d8427f7` stores | PR merged tree `c4bcf36` stores |
  |---|---|---|
  | "actually Tokyo is 20 to 25 October" (held Tokyo 19–24, Kyoto 24–28) | `[Tokyo 20–25]`: Kyoto lost | `[Tokyo 19–24, Kyoto 24–28]`: **correction dropped** |
  | "actually Ruth Cohen is 71" (held Ruth 70, Avi 41) | `[Ruth 71]`: Avi lost | `[Ruth 70, Avi 41]`: **correction dropped** |

  In the pure functions on the PR tree, 2026-09-25:

  | Typed message | What the PR stores |
  |---|---|
  | "no, Tokyo is 25 to 30" | a third stop, so two Tokyos |
  | "not Kyoto, Osaka" | Kyoto kept, Osaka added |
  | "Noa, not Noah" | both kept |
  | "Ruth is 71" (first name only) | "Ruth" added beside "Ruth Cohen" |
  | "Noah is not coming" | Noah kept |
  | "my father Avi Cohen joins" | added, which is correct |

- **Why:** `corrected()` merges with `mergeStructuredParts([existing, proposal])`. That is `mergeParts`, whose contract is *"a later part fills and adds; it never replaces"* (`answer-merge.ts`). On a scalar conflict `mergeField` keeps the held value. That rule is right for documents and wrong for a correction. The PR's own comment on `ApplyProposalsContext.held` still says *"an organizer retyping an answer is making a change"*. The code now contradicts it.
- **The prompt asks for exactly the input that gets dropped.** The correction block (`interpret.ts:1301–1304`) invites "no, it's…" and "make it…" and says *"propose only what is being ADDED or CHANGED"*. CHANGED values on a matched entry are discarded.
- **The traveller probe, re-checked by reading `samePerson`, `accountedFor` and `cutShort` and by running them:**
  - Confirmed: "Ruth" never matches "Ruth Cohen", because `accountedFor` needs two words. "Ruth Cohen" does not match "Ruth Levi".
  - **Refuted in part:** "first name only never merges, so the worst case is a duplicate" holds for one-word names only. A two-word name whose given name is another's minus one or two *leading* letters, with at least 4 left, and the same surname, **does** fuse: Ella/Bella, Anna/Hanna, Vital/Avital (`samePerson` returns `true`). "My daughter Ella Cohen, 9, is joining" with Bella Cohen (12) held stores `[Avi, Bella 12]`. Ella is silently not added.
  - "Ruth Cohen Levi" matches "Ruth Cohen" by design (middle name). If a "Ruth Levi" is also held, both match, and the result is `ambiguous`. `mergeParts` then drops the entry silently too.
- **Writers re-checked independently at 2b5bff8:**
  - `poller.ts:909` (conflict choice): confirmed. A whole-answer write happens only for `entryKey === "" && path === ""`, which `applyProposals` produces only for non-structured answers. `reconcileStructured`'s scalar conflict carries a non-record `incoming`, which `isRecordValue` refuses. Structured answers go through `applyConflictChoice(held)` with a `{ held }` precondition.
  - `poller.ts:2029` (document gate): confirmed. When an answer is held, `merged` is `reconcileStructured(heldData, combined).merged`. When none is held, the delta is the whole answer. Each write carries `{ held }` and retries when stale. The marker is not asked for there, and `validateAnswer` strips it regardless.
  - `poller.ts:2069` (suggestions): the marker is stripped (confirmed). **Pre-existing, not introduced here:** a document suggestion for an **answered** question is the raw delta, not merged with held. `suggestion_yes` (`poller.ts:1184`) writes it wholesale with no precondition. As far as I read it cannot be reached, because `renderStep` shows a suggestion only for a question being asked. I have not verified that end to end. Also, `mergedProposal` passes `{ people }` and not `mergeOptionsFor()`, so a marked return leg inside a multi-part *suggestion* folds into the first stop. This is harmless for storage and inconsistent.
  - Others: `:1011` builds the dietary scope from the store. `:3136` folds the itinerary into the whole list behind a stale check. `:532` is `choice_other` only. None of them stores a raw proposal where a merged answer is wanted.
- **Minor:**
  - When re-validation fails, the fallback in `corrected()` returns merged data that has **not** been sanitized. The write re-validates and refuses it (`interview.interpret_write_refused`), so nothing bad is stored, but the organizer still gets an acknowledgement.
  - `submitArgsForAccepted`'s docblock was inserted *under* `submitArgsFor`'s, so the older comment now sits above the wrong function.

## 4. Live-fleet impact (read 2026-09-25, read-only fleet MCP, config `~/.hermes/profiles/trip-monitor/fleet-stacks.json`)

- **Production (VM):** reports schema `0051_trip_person_links.sql` with 51 applied. The base tip carries 63 migration files, so **the VM runs a pre-sprint-6 release**. #199 reaches production only when sprint-6 merges to `main` and someone runs `kinerary-cp-release upgrade`.
  - When it lands: the typed path runs in the **relay**, so it is felt from the relay restart (`vm-relay-restart.sh`). That means any open interpret-path interview whose organizer types a correction to a recorded list.
  - Today: 2 live trips (`orlando-florida-2026`, `japan-tokyo-hakone-kyoto-osaka-2026`), both `ready_private`. Their intakes are confirmed and immutable, so this does not affect them.
  - 1 open interview (`draft-sreq-a468f…`, phase `opening`, awaiting person, idle 54h, en).
  - No trip site needs a redeploy. This is control-plane only.
  - Not checked: whether the VM relay has `INTERPRET_PATH_DEFAULT=1`. That needs SSH.
- **Mac staging:** the API container mounts `worktrees/sprint-6-integration/control-plane/api/dist`. The relay is pid 71552, `tsx src/relay/server.ts` from that same worktree. So staging feels the change at the **next relay restart** after that worktree advances past the merge. No interviews are stalled locally.

## 5. The plan

| # | Run | Command | Checklist | Min | Who |
|---|---|---|---|---|---|
| 0 | Done (caller) | full `control-plane/api` on the PR tree, `cptest_int199b` | 1693 tests: 1687 pass, 0 fail, 6 skipped (caller's report, not re-run) | not given | — |
| 1 | Done (me) | merged tree `c4bcf36`: `tsc --noEmit`; four unit files; the new DB test on `cptest_rp199_merged` | clean; 165/165; 4/4 | 3.6s + 2.5s + 8.8s (measured) | — |
| 2 | Items 1–4 written and green | `CONTROL_PLANE_TEST_DATABASE_URL=…/cptest_<own> node --import tsx --test test/interpret-typed-merge-db.test.ts test/interpret.test.ts test/answer-merge.test.ts` | E and F assert the decided behaviour; Ella/Bella keeps both; A–D still pass | ~1 run; 45–75 dev (est.) | developer |
| 3 | Full `control-plane/api` on the merged tree after item 2 | same as run 0, own database | 0 fail | minutes (the caller's run; not measured by me) | verifier |
| 4 | Real-model compliance, **on the merged tree** | a real `claude` runner, `INTERPRET_*` as in `provisioning.env`, over a fixed message set. Return leg: EN "another three days at the end for Tokyo", the HE original from #114. Plain date: "Tokyo, 19 to 24 September" and its HE form. **Plus** two change messages: "actually Tokyo is 20 to 25", "Ruth is 71" | marker on return legs only, never on plain dates; record the delta shape the model sends for a change (the entry alone? with its name?). **3 runs × 2 languages × each message** | ~20 (est.) | none; Mac, no deploy |
| 5 | Chaos walk with a *change* added | add to `CHAOS_LATE_CORRECTIONS` a date change on a held stop; `scripts/preflight-deploy.sh --deploy --auto --scenario chaos --cleanup` | at least 5 travellers; Naxos and Santorini added; the changed date landed **once**; read `interpret_path` off the session | tens of min (est.) | **hard rule 2 prompt**; Mac window, no VM run overlapping |

## 6. Budget

- **Minimum gate to merge into the integration branch:** run 2 with item 1 plus item 2 *or* item 3, plus run 3. That is about an hour of developer time (estimate). It turns the silent drop into either a correct change or a question.
- **+ item 4 (about 15 min):** removes the sibling-fusion case on typed input.
- **+ run 4 (about 20 min):** the only evidence that the model sets the marker correctly, and the only way to learn what shape a "change" arrives in, which items 2 and 5 depend on. **Owed before any deploy**, whatever is decided about merging.
- **+ run 5 (tens of min, a deploy):** the only end-to-end proof that a typed change lands. Without it you are deciding to find out on a real organizer's correction.

## 7. Go / no-go and the way back

- **Stop the merge if** Dror has not decided the change semantics (Decisions 1). **Stop a deploy if** run 4 shows the marker on plain-date statements in more than 0 of 6 runs per message, or run 5 shows a changed value missing or duplicated.
- **Snapshot:** not needed for the schema. On the VM, `kinerary-cp-release` takes one for every upgrade anyway.
- **Undo:**
  - On the integration branch: `git revert -m 1 <merge>`.
  - On the VM: `sudo kinerary-cp-release rollback --dry-run`, then the real rollback, then `vm-relay-restart.sh` (there is no migration, so `compatible`).
- **What rollback does not undo:** answers written in the window stay in `intake_sessions.answers`. That includes dropped corrections, duplicate stops and absorbed siblings. Once a session confirms, they are permanent in an immutable `intake_versions` row and reach the trip site.

## 8. Decisions needed

1. **What does a typed correction to a recorded list mean?** Options:
   - (a) The correction wins on matched entries (item 2).
   - (b) Held wins but the router asks (item 3).
   - (c) Merge as-is, with silent no-ops accepted as a known interim state and an issue filed.

   The PR as written is (c) without saying so.
2. **How is a stop moved, renamed or removed by typing?** For example, match an unmarked same-name stop regardless of dates (item 5). Renames and removals need an explicit operation from the model, which the prompt does not offer today.
3. **Should the typed path use clip-tolerant name matching?** Recommendation: no (item 4).

<details><summary>Evidence, 2026-09-25</summary>

- `gh pr view 199`: head `2b5bff8b…`, base `integration/sprint-6`, state OPEN.
- `git merge-tree --write-tree d8427f7 2b5bff8`: `c4bcf366…`, clean. `git diff --stat dce60e9 d8427f7`: `organizer-trips.test.ts` only.
- Merged tree (archive of `c4bcf36`, `node_modules` linked from the PR worktree; the `control-plane/api/package.json` of the two trees does not differ): `tsc --noEmit` clean. Four unit files: 165 pass, 0 fail. `interpret-typed-merge-db.test.ts`: 4/4.
- DB-path probe (a copy of the new test's harness with two change cases). Merged tree: `phases [{Tokyo 10-19..10-24},{Kyoto 10-24..10-28}]`, `travelers [{Ruth Cohen 70},{Avi Cohen 41}]`. Base `d8427f7`: `phases [{Tokyo 10-20..10-25}]`, `travelers [{Ruth Cohen 71}]`. The scratch database was dropped afterwards.
- `samePerson`: (Ruth, Ruth Cohen) false; (Ruth Cohen, Ruth Levi) false; (Ella Cohen, Bella Cohen) true; (Anna Cohen, Hanna Cohen) true; (Vital Cohen, Avital Cohen) true; (Noa Barak, Noah Barak) false.
- Fleet (read-only MCP): production is at 0051, 51 applied; live trips are 2 `ready_private`; 1 open interview awaiting person.
</details>
