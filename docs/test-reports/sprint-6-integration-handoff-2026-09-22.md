# Integration handoff — `integration/sprint-6`, 2026-09-22

**Branch tip: `b4754ed`.** Four pieces of work landed today, all verified before
push. This document says what is done, what is left, where reality diverged from
the plan and why, and which documents are now wrong.

Read the **"Before you touch anything"** section first — one of its two items
will silently mislead you otherwise.

---

## Before you touch anything

### 1. The local `integration/sprint-6` branch is 14 commits stale — and it is what the running stack serves

```
origin/integration/sprint-6   b4754ed   ← today's work
      integration/sprint-6    59ed025   ← the LOCAL branch, 14 behind, 0 ahead
```

Every push today went from a **detached HEAD** straight to
`origin/integration/sprint-6`, because the branch is checked out in the
`sprint-6-integration` worktree and cannot be checked out twice. The local
branch therefore never moved.

That worktree is what the dev stack bind-mounts — confirmed, not assumed:

```
$ docker inspect kinerary-control-plane-local-worker-1 --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}'
/Users/elul/kinerary/.claude/worktrees/sprint-6-integration
```

**So the running API and worker are executing pre-2026-09-22 code.** Nothing has
diverged (0 ahead), so this is a clean fast-forward. It was deliberately *not*
done in this session: fast-forwarding that worktree changes what the running
stack serves, which is Dror's call, not an agent's.

```bash
git -C .claude/worktrees/sprint-6-integration merge --ff-only origin/integration/sprint-6
# then rebuild: the API mount is dist/, not src/ — see CLAUDE.md
```

### 2. The main checkout is on a detached HEAD

`/Users/elul/kinerary` sits at `d12c761` detached, left over from the PR #95
merge. Harmless, but `git status` there will not say what you expect.

---

## What landed

| Commit | What |
|---|---|
| `ddf943c` → merged `c5f418e` | Forward-port of PR #145 ("Slice B") — document intake, registry, provisioning handoff |
| `d12c761` | Merge of PR #95 — operator-issued organizer invitations |
| `a9d02b2` → merged `c197ebc` | PR #89 — a trip's NFS directories named by trip id |
| `b4754ed` | Three files the Slice B forward-port had dropped |

PRs **#145, #95 and #89 are all closed/merged on GitHub.** #145 was closed
manually with an explanation, since a forward-port leaves no ancestry for
GitHub to detect.

### Verification actually performed

Not "the suite was run" — what was run, and against what:

- **control-plane/api**, full, DB-backed against a disposable database:
  1582 tests, 1576 pass, 0 fail, 6 skipped. The 6 are environment-gated
  (5 need `VAULT_ADDR`/`VAULT_TOKEN`, 1 needs a live extraction backend) and
  pre-date this work.
- **control-plane/worker**: 460 unit tests, plus 97/97 DB-backed
  `test_provisioner.py`.
- **tests/provisioning** (37), **tests/scripts/test_teardown_trip.py** (22),
  **tests/scripts/test_vm_invite.py** (9, under two interpreters).
- `scripts/preflight-checks.sh` clean on every commit — no BLOCK lines. The two
  `trip-fleet-monitor` profile-drift warnings are pre-existing and unrelated.

Every disposable database was created and dropped inside the
`kinerary-sprint5-testdb` container on port **5434**. Port **5433** is the live
dev stack's own database and was never touched — see CLAUDE.md's account of
2026-09-06, when it was.

---

## Where this diverged from the plan, and why

### The forward-port was semantic, not textual — and two things therefore differ from PR #145 on purpose

`integration/sprint-6` and `fix/92-slice-b` had evolved independently over the
same code, so each function was reconciled by **intent** rather than by applying
hunks. Two deliberate differences, both of which will look like mistakes to
anyone diffing the branches:

1. **`gateDocumentProposals`, `DocumentReading` and `DocumentGateResult` moved**
   from `document-intake.ts` to a new `document-gate.ts`. The gate is pure — no
   database, store, model or clock — so it was split from the registry/store/
   vision concerns. Both original callers already follow it.
2. **`ask()` was hoisted** out of `readDocumentsInto` into its caller, so it
   fires only after `markReadingDocument(false)`. On PR #145's branch it could
   fire while the flag was still held, silently swallowing the next question.
   This was caught by a `consult` review, not by a test.

### PR #89's own design decision was overridden

PR #89 made the NFS **host** directory trip-id-based but deliberately kept the
container's **mount point** slug-shaped, on the reasoning that it was the one
place a person reads the name. Dror overrode that on 2026-09-22: *all* NFS paths
are trip-id-based.

The slug now survives in exactly one place that is not NFS — a new
`LxcSpec.trip_slug`, always derived from the topology's own top-level `name` at
load time rather than stored as a second YAML key, so **no migration of existing
`topology.yaml` files is needed**. It feeds the container's local `TRIP_DIR` and
the `TRIP.txt` marker.

### A merge-born defect that existed in neither parent

`ShellDeployAdapter._trip_nfs_documents_dir` (from Slice B) assumed every trip's
NFS directory is slug-named. PR #89 made that false for new trips. Neither
branch was wrong alone; their combination was. Left alone, **every new trip's
documents would have silently fallen back to the slower non-hardlinked path**,
logged only as a warning nobody reads — and documents are PII (confirmation
numbers, passenger names).

Fixed by reading the directory the trip's own `topology.yaml` actually recorded
(`_trip_nfs_dirname`, hand-parsed like the adjacent `_private_url`, because
`provisioning.models.load_topology` raises on legacy topologies that have no
`nfs_host_dir` at all). Reconstructing from `trip_id` instead would have been
actively wrong: `trip_id` is known on every deploy, but the directory is only
id-shaped for a topology built *after* PR #89.

### PR #95 needed two fixes before it could land

- Its migrations were hand-numbered `0054`/`0055` — colliding with the existing
  `0054_companion_bug_reports.sql` and violating preflight B7. Renamed to
  `20260922060000_` / `20260922060001_`.
- `vm-invite.py` read `KINERARY_INVITE_ENV` / `KINERARY_SECRETS_DIR` eagerly at
  module scope, which broke its own test's `importlib` import. Moved to lazy
  per-call accessors — the pattern `control_plane_worker/__main__.py` already
  established.

### Three files were dropped, then restored

The Slice B handoff document named `document-sweeper.ts` at its step 7 and said
to wire `startDocumentSweeper` — both done — but never mentioned **that file's
own test**, and never mentioned either `tools/` file. So the sweeper ran on the
integration branch untested, and `extract-eval.ts` — the harness that produces
the `EXTRACT_INTAKE_*` / `EXTRACT_ITINERARY_*` benchmark numbers CLAUDE.md
documents — was unreachable.

Restored in `b4754ed`. One real drift found: `extract-eval.ts` still imported
from `document-intake.ts`, the one caller nobody updated when the gate split.

**The method that caught this is the transferable part**: list every file a PR
touched and check each against the target branch, rather than trusting a
step-by-step handoff to be complete.

```bash
BASE=$(git merge-base origin/<pr-branch> origin/integration/sprint-6)
git diff --name-only $BASE origin/<pr-branch> | while read -r f; do
  git cat-file -e "origin/integration/sprint-6:$f" 2>/dev/null || echo "ABSENT: $f"
done
```

A second pass compares **exported symbols** per file, which is what proved the
three relocated exports were moved rather than lost.

---

## What remains

### Decided, deferred, filed

**Issue #154 — an organizer's update reaching an already-active trip.** Dror,
2026-09-22: an organizer updating their trip after it exists is *completely
legitimate*, at any time, including adding phases and changing dates. The
interview creates a structure, not a frozen one.

Most of this already works and should not be rebuilt: `phases`,
`departure_date`, `return_date`, `destination` and `travel_anchors` are all
intake questions, so the change is already expressible; and promotion into the
active plan is scoped by `itinerary_day_key`/`itinerary_item_uid`
(`server/living-journey.js` ~661-666), so the family's own edits survive a
rebuild. The single Approve tap at `ready_private` is **correct as built** —
do not add a gate to it.

The real gap: `CORRECTABLE_STATES` stops at `ready_private`, so on a live trip
Approve returns `INVALID_STATE` → `not_now` → the row settles back to `pending`
and never applies. Extending it, and splitting `not_now` (genuinely-retry vs
never-going-to-apply), is the work. **Open question for Dror: `completed` and
`sealed`** — "at any time" plausibly stops at a trip that is over, and `sealed`
sounds deliberately immutable.

Deferred past Sprint 6 by Dror as not critical at this stage.

### PR #92 is fully superseded and could be closed

All 79 of its files are on `integration/sprint-6`. The only four absent are its
hand-numbered migrations `0054`–`0057`, which exist under their timestamped
names (`20260918110129`–`20260918110132`) — the rename PR #145's own final
commit made. `fix/92-slice-a` is already an ancestor of the branch.

Not closed in this session: Dror asked to land #145, not #92. One instruction,
one action.

### Branch and worktree housekeeping — never swept

Six worktrees hold branches that are now ancestors of `integration/sprint-6`:

| Worktree | Branch |
|---|---|
| `agent-a1fbd6345dd033f68` | `worktree-agent-a1fbd6345dd033f68` @ `ddf943c` |
| `agent-aa7dba7ba4dd7c61f` | `throwaway/pr95-into-sprint6` @ `c5f418e` |
| `agent-af13807e6490acc89` | `worktree-agent-af13807e6490acc89` @ `ddf943c` |
| `pr92-own` | `fix/92-slice-a` @ `2ff213a` |
| `trip-data-dir-s6` | `feat/trip-data-dir-by-id-sprint6` @ `a9d02b2` |
| `monitor-signup` | `feat/organizer-invite-links` @ `b1b882a` |

`pr92-slice-b` (`fix/92-slice-b` @ `b2e3051`) is **not** an ancestor and must
not be judged by that test — its content arrived by forward-port. Keep it until
someone is satisfied nothing further is owed from it.

This is a `pr-steward` job, and it deletes only on confirmation.

### Open PRs not looked at today

#152, #150, #149, #148, #144, #118, #116, #108. Only #152 and #118 currently
report a clean merge state; the rest were last computed against an older tip and
will need recomputing now that four merges have landed.

---

## Documentation updates required

None of these were made in this session. Each is a real inaccuracy now.

1. **`docs/test-reports/slice-b-step6-handoff-2026-09-21.md` — the document that
   caused the dropped files.** Its step list names `document-sweeper.ts` but not
   `document-sweeper-db.test.ts`, and never mentions `tools/document-acceptance.ts`
   or `tools/extract-eval.ts`. Leave the step list as the historical record, but
   it needs a correction note, or the next forward-port driven from a handoff
   inherits the same blind spot. **`doc-keeper`'s.**

2. **`docs/control-plane-vm-deployment.md` § "Where a trip's data lives"** was
   updated for the mount-path change, but says nothing about the **documents**
   subdirectory that `_trip_nfs_documents_dir` now also places by the recorded
   directory name. Flagged by the integrator, deliberately not written by it.

3. **CLAUDE.md § "The interview has no agent"** documents
   `EXTRACT_INTAKE_RUNNER` / `EXTRACT_ITINERARY_RUNNER` as "benchmarked
   2026-09-13 — `docs/document-intake-operations.md`". The harness that produces
   those numbers (`tools/extract-eval.ts`) only reached the branch today, in
   `b4754ed`. Worth a line saying where it lives, since the config outlived its
   own evidence for four days.

4. **`.project/sprint.json` needs nothing** — this was checked, because it
   looked wrong and was not. It stores the *baseline* (`97582b6`), which has not
   moved and is still locked. The session-start line saying
   "`integration/sprint-6` is 46 commit(s) past it, at `59ed025`" is computed at
   runtime by `scripts/project-state.py` **against the local branch**, so it is
   a symptom of the stale local branch described at the top of this document,
   not a file to edit. It corrects itself on the fast-forward. Do not "fix" it
   by hand — the Write hook refuses that anyway.

5. **A note that `tsconfig.json`'s `include` is `src/**/*.ts`**, so
   `npm run build` typechecks neither `tools/` nor `test/`. This is what let a
   stale import survive in `extract-eval.ts`, and it means a green build is not
   evidence those directories compile.

---

## Two traps worth carrying forward

**A fresh worktree with no `node_modules` under-reports rather than failing.**
The three-file restore first showed *two cancelled subtests* in
`group-document-to-plan.integration.test.ts` — not an error, not a skip. The
cause was `server/` and `mcp/` never having had `npm ci` in that worktree.
Cancelled subtests read like flakiness; here they meant "this worktree was never
provisioned." Same shape as the preflight failure CLAUDE.md already records,
wearing a different disguise.

**A staged resolution is not a merge.** PR #95's conflict resolution was
prepared on a throwaway branch with no `MERGE_HEAD`. Committing it as-is would
have produced a single-parent commit, losing the ancestry — and GitHub would
never have marked #95 merged. Check `git rev-parse --verify MERGE_HEAD` before
committing anything that is supposed to be a merge.
