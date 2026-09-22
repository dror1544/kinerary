# Slice B forward-port — Step 6 handoff (`relay/poller.ts`)

**Written 2026-09-21 for a fresh session.** Self-contained: you should not need
to read any prior conversation. Everything below was verified against the tree,
not recalled.

> ## Read this before anything else
>
> **Do NOT start by replaying, cherry-picking or merging the old `poller.ts`
> diff.** Step 6 is **semantic reconstruction, not textual reconciliation**. Two
> branches independently rewrote the same ~250-line span for different reasons,
> and neither is a superset of the other. A hunk-level resolution — however
> clean it looks — will drop either a production fix or the feature. This has
> already been attempted twice and abandoned twice, each time correctly.

---

## 1. Where things stand

| | |
|---|---|
| **Worktree** | `/Users/elul/kinerary/.claude/worktrees/agent-a1fbd6345dd033f68` |
| **Branch** | `worktree-agent-a1fbd6345dd033f68` |
| **HEAD / base** | `2966cbd` — "Merge pull request #136 from dror1544/fix/92-slice-a", identical to `origin/integration/sprint-6` |
| **Committed** | **Nothing. Zero commits, zero pushes.** All of steps 1–5 is uncommitted working-tree state: 7 modified files, 17 new files. |
| **`relay/poller.ts`** | **Byte-identical to `origin/integration/sprint-6`.** Untouched. One exploratory edit was made and reverted. |

**Protected references — do not mutate or delete either:**

- `fix/92-slice-b` → `b2e3051` (PR #145's head, pushed, on origin)
- `backup/145-pre-rebase` → `b2e3051`

**The work is uncommitted in an agent worktree.** If that worktree is cleaned,
steps 1–5 are lost and must be redone. Preserving it — a WIP commit on a scratch
branch, or `git commit-tree` + tag — was deliberately **not** done, because the
standing rule is that no agent commits without the person's word. Ask before
assuming it is safe to leave.

### Files changed by steps 1–5

**Modified (7):** `chat-router.ts`, `document-gate.ts`, `interview.ts`,
`relay/dispatch.ts`, `relay/protocol.ts`, `relay/server.ts`,
`test/relay-dispatch.test.ts`

**New (17):** `answer-provenance.ts`, `document-correction.ts`,
`document-intake.ts`, `document-registry.ts`, `document-store.ts`,
`document-vision.ts`, `model-task-settings.ts`, and their tests —
`answer-provenance-db`, `document-correction-flow`, `document-intake-flow`,
`document-registry-db`, `document-store-readiness`, `document-store`,
`document-text-bytes`, `document-vision-db`, `document-vision`, `model-switch`

---

## 2. Verification at this checkpoint

`npm run build` (full `tsc -p tsconfig.json`) — **clean**, at every intermediate
step and at the end.

**Focused suites: 275 pass, 0 fail.**

```
chat-router · relay-protocol · interview · model-switch · document-store
document-store-readiness · document-vision · document-text-bytes
organizer-trips · dietary-scope · organizer-roster
```

**Two expected failures, and why they are NOT step 1–5 regressions.**
`relay-dispatch.test.ts` is 53/55. Both failures are the two new `/model`
super-admin tests, and both are:

```
42P01: relation "control_plane.model_task_settings" does not exist
```

That table is created by one of `b2e3051`'s four migrations, which are
**deliberately last** and not yet applied. The failure occurs inside
`setTaskOverride` **at the SQL call** — after the routing and gating logic has
already run and passed. It is a missing schema, not broken code.

**Suites correctly still blocked on the migrations:**
`document-registry-db`, `answer-provenance-db`, `document-vision-db`,
`document-intake-flow` and `document-correction-flow` (the last two also need
step 6).

---

## 3. Two things already carried forward — do not redo or undo them

### `codexIsolationProblem()` is now wired

PR #91 added this startup probe and deliberately left it **uncalled**; its own
comment said wiring it was owed to Slice B. Step 5 wired it in `relay/server.ts`.
It verifies the installed `codex` binary actually knows every feature name the
isolation flags disable, so a renamed feature fails loudly at startup instead of
making every extraction call exit non-zero with a generic error.

### A regression that was caught and reverted — `interview.ts`

Porting `confirmIntakeVia`'s registry wiring verbatim from `a7c4518` made **every
intake confirmation** unconditionally query `control_plane.trip_documents`, which
does not exist without the migration.

`interview.test.ts` went **103/103 → 10 failing**, all `42P01` through
`confirmIntakeVia`. This was a real regression against the current baseline, not
a schema-dependent test that was already expected to be red.

**That hunk alone was reverted.** `sourceDocument` again falls back to
`session.source_document ?? null`, exactly as before. `interview.test.ts` is back
to **103/103**.

A dated comment sits in `interview.ts` at the exact spot — search
`HELD BACK until the document-registry migration`. **Restore condition:** restore
the block from `a7c4518` **as part of the same step that applies the four
`b2e3051` migrations**, and rerun that file's DB suite before calling it done.

`confirmedSources()` and the `listTripDocuments` import are present but unused
until then. Harmless — no `noUnusedLocals` in this tsconfig, and the build is
clean.

---

## 4. Step 6 — the actual task

**Scope: `control-plane/api/src/relay/poller.ts`, and specifically three
functions.**

Both branches independently and substantially rewrote the same ~250-line span,
for unrelated reasons:

| Function | On `origin/integration/sprint-6` | On `a7c4518` (Slice B) |
|---|---|---|
| `runDocumentPath` | re-sequenced so the next question is asked before the long extraction | restructured around the document registry |
| `readDocumentInto` → `readDocumentsInto` | return type `Promise<void>` → `Promise<boolean>` so the caller can sequence | renamed **plural**; takes a `commit: CommitDocumentBurst` callback and a `StructuredModelRunner` |
| `runInterpretPath` | three separate dated fixes (below) | calls `extractRegisteredDocuments` / `gateDocumentProposals` instead of `extractIntakeFromDocument` / `applyProposals`; adds a `STALE_ANSWER` retry loop around gate-and-write |

### The four production fixes on HEAD that MUST survive

Each came from a live incident. Losing any one silently re-opens it.

1. **2026-09-16 — ask before the long extraction.** `readDocumentInto` used to run
   the day-by-day fold (`foldItineraryFromDocument`) *before* asking the next
   question. Incident: 51 seconds of extra silence after a 115-second document
   read. The return type became `Promise<boolean>` ("did it record something")
   so `runDocumentPath` can `ask()` immediately and run the fold in the
   background via `void … .catch()`.
2. **2026-09-15 — typed language beats phone locale.** `runInterpretPath` follows
   the language the organizer actually **typed in**, not their device locale.
   Incident: an organizer with an English phone writing Hebrew got an English
   interview, site and companion.
3. **2026-09-18 — floor handback at the boundary.** Inside `runInterpretPath`'s
   `ask()` closure: `sendNextStep`'s dedupe branch can hand the floor back having
   said nothing, which left `restateExpectation` silent at exactly the boundary.
   Found by the `settleBoundary` fallback tests.
4. **2026-09-20 — roster match without a model call.** `runInterpretPath` matches a
   typed answer against the roster directly when the on-screen question's choices
   are known, instead of asking the model. Incident: an organizer typed their own
   name, spelled exactly as the roster had it, and the interview asked the same
   question forever.

### What Slice B uniquely adds in the same region

- **Document-registry restructuring** — many registered documents, not one joined
  string of text.
- **`readDocumentsInto` (plural)**.
- **A `commit: CommitDocumentBurst` callback**.
- **A `STALE_ANSWER` retry loop** around the gate-and-write.

### The conclusion

**Neither side is a superset of the other.** There is no overlay of one onto the
other that does not drop either a dated production fix or the whole registry
restructure. Hunk-level conflict resolution here is unsafe — both sides look
locally clean, which is exactly why this is dangerous.

### The method

1. Read all three functions **in full**, current-HEAD version and `a7c4518`
   version, **side by side**, one function at a time.
2. **Author one reconciled implementation of each** that carries **all four**
   production fixes *inside* the document-registry architecture. This is
   authorship, not merging — the two shapes do not align hunk-for-hunk.
3. **Spawn `consult` on the draft before accepting it.** Give it both original
   functions and the four fixes as evidence — **never your own conclusion**.
   This is squarely "same intent, different regions, both must survive".
4. Apply, typecheck, then the smaller additive pieces:
   - `combineBurst` / `documentsInBurst` — the `message_id` preservation (needed
     so a combined burst does not collapse two files into one delivery record);
   - `applyDecision`'s two new `switch` cases (`document_correction`,
     `correction_callback`) — additive, no existing case touched;
   - the single-line `sendNextStep` insertion —
     `if (await askOpenConflict(view, chatId, deps)) return true;` — confirmed
     additive and correctly ordered, after the two "document is being read" floor
     checks and before the `// THE BOUNDARY.` comment;
   - `startTripBotPoller`'s deps passthrough (`superAdminSubjectDigest`,
     `modelRunner`, `documentStore`) once `TripBotPollerDeps` accepts them.
5. Then wire `relay/server.ts`'s already-computed `modelRunner` / `documentStore`
   into the `startTripBotPoller` call. **Today that call site still passes
   `modelRunner: modelRunnerFromEnv()` directly — old behaviour fully preserved
   — and that is deliberate**, because changing it is blocked on step 6.

**One area explicitly NOT re-verified:** `applyInterviewCallback` was checked
against an earlier, narrower diff and has not been re-checked against the fuller
one. Treat it as **unverified**, not clean.

### Focused tests to run after the reconciliation

```
test/relay-poller.test.ts        test/relay-dispatch.test.ts
test/chat-router.test.ts         test/interview.test.ts
test/relay-protocol.test.ts      test/relay-group-attachments.test.ts
test/interview-transcript.test.ts
```

Plus re-run the 275-test set from §2 to confirm nothing regressed. Use a
**private** database you name yourself, e.g.
`CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:5434/cptest_step6"`,
created and dropped by you — **never the shared `cptest`**, which other sessions
use and every DB suite drops the schema of. Do **not** run `tests/scripts` (it
stages probe files into the worktree index, #135) and do **not** run
`scripts/preflight-deploy.sh` (it relinks `node_modules`).

---

## 5. After step 6

7. `document-sweeper.ts`, and wire `startDocumentSweeper` in `relay/server.ts`
   (deliberately **not** wired in step 5 — a dated comment there says why).
8. Python side, in order: `document_handoff.py` → `transformer.py`'s
   `derive_bookings` extension → `provisioner.py` → `__main__.py` →
   `provisioning/adapters.py` → `scripts/teardown-trip.py`.
   **`teardown-trip.py` carries a folded-in fix, decided by Dror 2026-09-21:**
   add `trip_document_corrections` to `DOCUMENT_TABLES`, **keep
   `source_artifacts` exactly as it is** — it is a real per-trip provenance table
   created in `0001_foundation.sql`, *not* a typo, and an earlier report wrongly
   called it a phantom — and add a regression test keeping the backup list
   aligned with the document-store tables. Whether teardown *should* back up
   `source_artifacts` is a separate product question and out of scope here.
9. `tests/helpers/ports.js` — **renumber to `38299` / `38300`.** Slice B's
   `tripDocuments: 3121` and `mcpExtractEmpty: 3122` fall inside
   `TRIP_BRIDGE_PORT_RANGE = {first: 3100, last: 3999}`, and
   `assertClearOfTripBridges(PORTS)` runs **at module scope** — ported verbatim it
   throws on import and breaks every file importing `ports.js`. Then `ad11c19`'s
   remaining test-infra and `1696615`'s one-line port fix.
10. `server/server.js` — `ad11c19`'s authenticated document-serving route. Can
    land any time after step 1; only depends on `TRIP_DOCUMENTS_DIR` and
    `documents.json`.
11. Docs + `CLAUDE.md` — hand-merge the two-line env addition into the current
    block shape (the block has evolved; a mechanical patch will not apply), add
    the three new doc files.
12. **`b2e3051` LAST.** Apply the four timestamped migrations and both
    `migrations.test.ts` list entries, then verify all five:
    1. all four files exist on disk — `20260918110129_document_registry.sql`,
       `20260918110130_answer_provenance.sql`,
       `20260918110131_model_task_settings.sql`,
       `20260918110132_document_corrections.sql`;
    2. **both** lists in `migrations.test.ts` reference them — the four names
       appear **twice** in that file, and a resolution can keep one list and drop
       the other while the suite still passes on the survivor;
    3. B7's two regexes pass for all four — `^[0-9]{14}_.+\.sql$` and
       `^--\s*rollback:\s*(compatible|breaking)\s*[-—]`;
    4. the migration suite is green;
    5. **no migration is present on disk but absent from the expected list** —
       that is the silent one.
    Then restore the `confirmIntakeVia` block held back in §3 and rerun
    `interview.test.ts`'s DB suite.
13. **The `compose.vm.yml` document-store/NFS hunk stays HELD.** Not part of this
    port. Decided by Dror 2026-09-21.

### Why the compose hunk is held, and why not to "just add a default"

`KINERARY_NFS_ROOT` is **defined nowhere** — not on `main`, not on
`integration/sprint-6`, not in `kinerary-deploy`. The only two occurrences in the
tree are prose *about* the problem. The hunk uses `${KINERARY_NFS_ROOT:?…}`,
which is a **parse** failure: `docker compose` will not read the file at all, so
API, worker and relay go down together, with every bound chat.

The hunk is the whole feature-flag block across **two** services — worker and
relay — including `DOCUMENT_STORE_DIR`, `DOCUMENT_STORE_REQUIRED: "1"`,
`PROVISIONER_TRIP_NFS_LOCAL_BASE` and both volume lines. Holding back only the
`:?` lines would merely move the failure from parse time to first request.

**Dror explicitly rejected defaulting the variable**, and the reason should
outlive this document: *a default avoids the parse failure but risks something
worse — silently bind-mounting a local directory instead of the intended NFS
mount, so the system appears healthy while originals are written to the wrong
place.* A loud parse failure is recoverable; silent misplacement with green
health checks is the failure class this repository keeps paying for.

NFS enablement is a **separate change** that must: define `KINERARY_NFS_ROOT`;
verify the mount exists **and is actually the intended NFS filesystem**, not
merely a resolvable path; **fail preflight before deployment** if that contract
is unmet; and only then add the compose mount. After that the `:?` fail-fast
contract is correct and should stay.

---

## 6. Standing rules for this work

- **Ask what each side is protecting, not whether the text reconciles.** In
  `.claude/agents/integrator.md`. On 2026-09-21 three separate resolutions each
  looked clean and each would have reverted a shipped fix.
- **`consult` before resolving intent** in `model-runner.ts`, `server/server.js`,
  `shared/`, or anything spawning a process or constructing its environment.
- **One semantic unit at a time, focused tests after each.** Never accumulate and
  validate at the end — that is how the `confirmIntakeVia` regression was caught
  in §3.
- **Check HEAD before porting anything.** Two files thought to need porting were
  already carried by Slice A. Re-porting landed behaviour is the quiet version of
  reverting it.
- **Do not rewrite a test to make it green.** If a test encodes a changed product
  or security contract, stop and explain the contract decision.
- **Do not touch:** `#144` (the next separate `model-runner.ts` reconciliation
  point), the live-stack worktree `.claude/worktrees/sprint-6-integration` (the
  Mac stack mounts it — read-only, never `git add`, never run a suite there),
  `fix/92-slice-b`, or `backup/145-pre-rebase`.
- **No agent commits, pushes or merges.** The hook refuses it, and it is right to.
