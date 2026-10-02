# Regression plan — Slice B forward-port, **merge into `integration/sprint-6`**

**Date:** 2026-09-22 · **Mode:** branch / pre-merge (not a deploy decision)
**Assessed tree:** the merged tree materialised in
`.claude/worktrees/agent-af13807e6490acc89` — index and working tree loaded by
`git read-tree` from `git merge-tree --write-tree origin/integration/sprint-6
ddf943c1dd00c13ce044c1cfaed07602e33eec62`; HEAD is the throwaway branch
`integrator/slice-b-forward-port-merge-check` still at `c263f4f`
(= `origin/integration/sprint-6` tip). The 52-file `git status --short` is the
content under assessment.

**Verdict:** **merge-ready on its own terms, with three carry-forward conditions
that must be written down before the next lane merges.** Nothing in this tree
reaches a live trip by being merged. The two production-blocking findings from
the earlier deploy assessment split: the correction-approval re-provisioning
path is **not** confined to production — any stack brought up from this branch
inherits it — while the migration-sequencing concern is *inverted* by this
merge, which fixes the branch's ordering and simultaneously opens a new,
narrower ordering hazard for the lanes that follow.

---

## 0. Provenance of every claim here

| Claim | How it was established | When |
|---|---|---|
| The 52-file change set | `git status --short` in this worktree | 2026-09-22 |
| The other side's 5 commits and 15 files | `git merge-base` = `2966cbd`; `git log`/`git diff --stat 2966cbd..origin/integration/sprint-6` | 2026-09-22 |
| Preflight passes on the merged tree | `bash scripts/preflight-checks.sh --staged` → **exit 0**, two pre-existing Hermes-profile warnings unrelated to this change | measured 2026-09-22 |
| Migration ordering semantics | read `control-plane/api/src/migrations.ts` (`/^\d+_.+\.sql$/`, `.sort()`, one transaction per file, advisory lock) | 2026-09-22 |
| B7's merge grandfathering | read `scripts/preflight-checks.sh` lines 328–382 | 2026-09-22 |
| Rollback headers | `head -1` on all four new files and on `0050`–`0054` — all `-- rollback: compatible` | 2026-09-22 |
| Lane overlaps | `git diff --name-only origin/integration/sprint-6...<lane>` for `feat/organizer-invite-links`, `feat/trip-data-dir-by-id-sprint6`; `git ls-tree` for their migrations | 2026-09-22 |
| Live fleet | `.agents/skills/trip-fleet-monitor/fleet-mcp.mjs --tool list_trips` / `fleet_overview`, read-only, against the production stack named in the private `fleet-stacks.json` | 2026-09-22 |
| Test results | **taken from the caller**, not re-run here: control-plane/api 1540/1546 + 6 pre-existing skips, worker 452/452, `tests/` 490/490, clean `tsc` | reported 2026-09-21/22 |
| The earlier 2026-09-21 deploy plan | **Not reachable.** `docs/test-reports/regression-plan-2026-09-21-slice-b-forward-port.md` is present neither in this worktree nor in the main checkout's `docs/test-reports/`. Its two findings were therefore re-derived from the code, and from the in-tree `docs/test-reports/pr92-regression-assessment-2026-09-19.md`, which is the 09-19 assessment of the same underlying work. Where my reading and theirs might differ is flagged in §3. | searched 2026-09-22 |

---

## 1. Change set

**Incoming (one side):** the forward-port of PR #145 "Slice B" —
`ddf943c1dd00c13ce044c1cfaed07602e33eec62`, 52 files, +9323/−156.

| Group | Files |
|---|---|
| New control-plane modules | `answer-provenance.ts`, `document-correction.ts`, `document-intake.ts`, `document-registry.ts`, `document-store.ts`, `document-sweeper.ts`, `document-vision.ts`, `model-task-settings.ts` |
| Modified control-plane | `chat-router.ts` (+30), `document-gate.ts` (de-duplicates Slice A's gate), `interview.ts` (+106), `relay/dispatch.ts` (+98), **`relay/poller.ts` (+1046)**, `relay/protocol.ts` (+7), `relay/server.ts` (+76) |
| **Migrations (4)** | `20260918110129_document_registry.sql`, `20260918110130_answer_provenance.sql`, `20260918110131_model_task_settings.sql`, `20260918110132_document_corrections.sql` |
| Worker / provisioning | `document_handoff.py` (new), `provisioner.py`, `transformer.py`, `__main__.py`, `provisioning/adapters.py` (+1 line), `scripts/teardown-trip.py` |
| **Trip runtime** | `server/server.js` (+72): `/api/trip-documents`, `tripDocumentPath()`, `confirmationPath()` extension, six new content types |
| Tests | 13 new control-plane test files, `migrations.test.ts` (both expected lists), `relay-dispatch.test.ts`, `tests/trip-documents.test.js`, `tests/helpers/{ports,server}.js`, `tests/package.json`, `tests/mcp-extract.test.js`, `tests/scripts/test_teardown_trip.py`, 3 worker test files |
| Docs | `CLAUDE.md` (+3), `docs/document-intake-feature-plan.md`, `docs/document-intake-operations.md`, two `docs/test-reports/` files |

**Already on the branch (the other side), 5 commits / 15 files since `2966cbd`:**
`a794b5e` preflight B7 merge-grandfathering (+ `tests/scripts/test_preflight_b7_merge.py`),
`81e8484` + `ec6ad8c` integrator-role "a clean merge is not evidence" (`.claude/agents/integrator.md`, `.codex/agents/integrator.toml`),
`59ed025` trip-site Journey/Today/weather date alignment (`server/living-journey.js`, `trip-web/src/*`, the rebuilt `site/modern/assets/index-*.js`, `tests/living-journey.test.js`),
`c263f4f` the merge of #147.

**File overlap between the two sides: none** (independently confirmed — the
other side's 15 files appear nowhere in the 52). The couplings that matter are
*semantic*, and they are in §3 and §4.

**Deliberately held back:** the `compose.vm.yml` document-store/NFS hunk
(`KINERARY_NFS_ROOT`, `DOCUMENT_STORE_DIR`, `DOCUMENT_STORE_REQUIRED: "1"`,
`PROVISIONER_TRIP_NFS_LOCAL_BASE`, two volume lines), decided by Dror
2026-09-21 and recorded in `docs/test-reports/slice-b-step6-handoff-2026-09-21.md`
§5.13. Verified: no compose file is in the change set, and `DOCUMENT_STORE_*`
appears only in `control-plane/api/src`, tests, docs and `teardown-trip.py`.
This is load-bearing for everything below — see §5.

---

## 2. Risk table — **merge blast radius**, not deploy blast radius

"Reaches on merge" means: what changes for someone who branches from, builds
in, or boots a stack from `integration/sprint-6` after this lands.

| # | Change | Surface (§2 of the role) | Reaches on **merge** | Reaches on deploy | Migration | Compat break | Risk | Test that would catch it | Min | Batch? |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 4 new migrations | `control-plane/db/migrations/` | every lane's `migrations.test.ts`, every fresh test DB, every local stack boot | everyone, at API boot, irreversibly-forward | **yes ×4, all additive, all `rollback: compatible`** | none against baseline history | **Low today, Medium for the next lane** (§3) | `npm run test:migrations` on a **private** DB | 3 | isolated |
| 2 | Legacy-named migrations still open on `feat/organizer-invite-links` (`0054_organizer_invitations.sql`, `0055_one_organizer_per_address.sql`) | same | that lane's next merge | fresh-install order ≠ upgrade order | — | **yes — ordering invariant** | **Medium–High, and silent** | a rename + both `migrations.test.ts` lists; no suite catches ordering divergence | 15 | isolated, **before that lane merges** |
| 3 | `relay/poller.ts` (+1046), `dispatch.ts`, `document-correction.ts` — organizer's post-confirmation documents intercepted, proposed, and on Approve → `provisionOnConfirm` | `control-plane/api/src/relay/` | any stack booted from the branch; **the Mac stack provisions onto the same Proxmox/NPM/Cloudflare as the VM** | every live Telegram conversation, at relay restart | — | behaviour change: a document the companion used to receive no longer reaches it | **High** | a deliberate walk on an unoccupied trip; not an e2e ride-along | 20 | **isolated** |
| 4 | `interview.ts` — `source_document` shape, `STALE_ANSWER` precondition | control-plane API | any local stack sharing a DB across branch switches | everyone at restart | — | **yes — `intake_versions.source_document` shape, on an immutable row** | Medium | `interview.test.ts` DB suite; and a read of one new version's JSON | 5 | batch |
| 5 | `server/server.js` — `/api/trip-documents`, widened `confirmationPath()`, 6 content types | `site/server/shared` → a **release** | **nobody** — no release is built by merging | new trips at provision; existing trips only when individually redeployed | — | new artifact digest (content-hashed, §4) | **Medium, security-path** | `tests/trip-documents.test.js` (present) **+ `boundary-reviewer` with real request/response** | 1 + a pass | **isolated** |
| 6 | `provisioning/adapters.py` `TRIP_DOCUMENTS_DIR`, worker `document_handoff.py` / `provisioner.py` link path | worker + provisioning | lanes that also touch these files (§4) | trips being provisioned only | — | **cross-lane, silent** (§4) | **Medium–High** | none exists; needs one assertion after a provision | 10 | isolated |
| 7 | `model-task-settings.ts`, `/model` + `/models` in `dispatch.ts` | control-plane API + relay | branch behaviour only | super admin's DM, at restart | table + append-only trigger | none | Low–Medium | `model-switch.test.ts` (present) | 0 | batch |
| 8 | `chat-router.ts` callback shapes `x:` / `dc:` | control-plane API | branch | every tap | — | new prefixes, additive | Low | `chat-router.test.ts` | 0 | batch |
| 9 | `scripts/teardown-trip.py` (+ `trip_document_corrections`, store dir) | operator script | anyone tearing down a test trip on the branch | — | — | none | Low | `tests/scripts/test_teardown_trip.py` — **but see the #135 warning in the handoff doc** | 0 | batch |
| 10 | `CLAUDE.md` +3 lines (codex for document tasks) | prose, read as instruction by every session | **immediately, every session on the branch** | — | — | — | Low, worth naming | none | 0 | — |
| 11 | `tests/helpers/ports.js`, `helpers/server.js`, `tests/package.json` | test infra | every lane's test run | — | — | conflict surface for lanes touching the same files | Low | the suite itself | 0 | batch |

---

## 3. Migration findings — and whether the "sequencing gap" is merge-relevant

### 3.1 Against the branch as it stands: clean

- `applyMigrations` selects `/^\d+_.+\.sql$/`, sorts lexicographically, and runs
  each unapplied file in its own transaction under an advisory lock
  (`control-plane/api/src/migrations.ts`, read today). The branch's highest
  legacy name is `0054_companion_bug_reports.sql`; `"0…" < "2…"`, so all four
  new files sort **after** every legacy migration on both a fresh install and an
  upgrade. `migrations.test.ts` now asserts exactly that order in **both** of its
  lists (the fresh-install list and the upgrade list) — the trap the handoff doc
  names, and it is not present here.
- The other 5 commits add **no** migration, so nothing on the branch side
  competes for ordering.
- What the four touch: three create new tables only. `20260918110129` also does
  three `ALTER TABLE control_plane.source_artifacts ADD COLUMN IF NOT EXISTS`
  (`document_id`, `filename`, `received_at timestamptz NOT NULL DEFAULT now()`).
  `source_artifacts` exists since `0001_foundation.sql` and its own header states
  no code has ever written to it; `now()` is STABLE, so the added column takes
  Postgres's fast default rather than a table rewrite. It does take a brief
  `ACCESS EXCLUSIVE` lock — taken at boot, by the dedicated `migrate` service,
  before `api` is healthy and before `relay` starts (`compose.vm.yml`:
  `api depends_on migrate: service_completed_successfully`, `relay depends_on
  api: service_healthy`, read today). **No table the sprint baseline created
  (`0050`–`0054`) is touched.**
- All four carry `-- rollback: compatible — …`. So does every migration between
  production's current `0051` and this tree. `vm-release.py`'s destructive
  default is therefore not armed anywhere across this span.
- `INTAKE_SCHEMA_VERSION` is **not** bumped (grep of the full staged diff: every
  occurrence is a fixture or the pre-existing insert). No
  `release_accepts_intake_schema_vN` widening is owed.
- **Preflight passes on the merged tree with all 52 files staged** — B7 (naming
  + rollback header), B8 (`.project/sprint.json` agrees; baseline `97582b6`
  verified an ancestor of HEAD) and B9 (Codex mirrors) are all green; exit 0.

### 3.2 The new hazard this merge opens — and it is genuinely merge-level

From the moment timestamp names are on the branch, **a legacy `00xx_` migration
arriving from an older lane sorts *before* the four document migrations on a
fresh database, and is applied *after* them on any database already upgraded.**
Lexicographic order stops meaning application order.

That is not hypothetical. `feat/organizer-invite-links` carries
`0054_organizer_invitations.sql` — a numeric collision with the branch's own
`0054_companion_bug_reports.sql`, the exact bug class `docs/migrations.md` was
written to end — and `0055_one_organizer_per_address.sql`.

And the commit that arrived in the other five makes preflight *not* object:
B7 skips any migration present in `MERGE_HEAD` (`a794b5e`, lines 362–372), which
is correct for genuinely grandfathered files and is precisely what will wave
those two through on the merge path with no block.

Today the divergence is harmless — organizer invitations and the document
registry share no object. It stops being harmless the first time two
independently-named migrations touch the same table.

**Action, and it is cheap:** before `feat/organizer-invite-links` merges, rename
its two files to `YYYYMMDDHHMMSS_` names later than `20260918110132`, and update
**both** lists in `migrations.test.ts`. Renaming is safe here because neither has
ever been applied to production — `origin/main`'s migrations directory ends at
`0051_trip_person_links.sql`, so production's schema is at `0051` and has seen
neither. (Renaming an *applied* migration is the thing that must never happen;
this is not that.)

### 3.3 So: is the earlier plan's "migration-sequencing gap" merge-relevant?

I could not read the 2026-09-21 plan (§0), so this answers the question from the
code rather than from their words, and should be reconciled with them.

- **If they meant deploy-step sequencing** — migrations applied before the code
  that reads the new tables runs — then **no, it is confined to deploy**, and the
  VM's compose already enforces it: `migrate` runs to completion, then `api`,
  then `relay`. It is additionally moot for this merge because all 52 files land
  in **one** merge commit; there is no intermediate branch state whose API code
  queries tables no migration has created. That intermediate state *did* exist
  during the step-by-step forward port (the handoff doc puts the migrations
  last, at step 12) — it does not survive the merge.
- **If they meant ordering** — then **yes, it is merge-relevant**, in the form in
  §3.2, and the merge is what arms it for the *next* lane rather than for this
  one.

Either way, the item that belongs in the merge handover is §3.2's rename.

---

## 4. Compatibility findings other than SQL

1. **`intake_versions.source_document` changes shape.** `confirmIntakeVia`
   (`interview.ts`) now writes `{documents:[…], sources:[…]}` whenever the trip
   has registry rows, and falls back to the session's old
   `{filename,text,savedAt}` only when it has none. Intake versions are
   immutable by design, so a version written by this code keeps the new shape
   forever. The worker reads it (`provisioner.py:_load_intake_source_document`)
   and is updated in the same change set, so they travel together — but a
   checkout *without* Slice B pointed at a database that has such a version, or
   a rolled-back stack, reads a shape it was not written for. Relevant on the
   branch because local stacks get pointed at shared databases across branch
   switches.
2. **Release seal.** `computeArtifactDigest` hashes `<path> <blobSha>` lines over
   `PAYLOAD_ROOTS = site, server, shared` — git's own content hash, so a content
   change to `server/server.js` changes the digest, not only an added file.
   (This corrects the "pure function of the file list" shorthand: the file list
   *and* every file's content.) Consequence: every release built from the branch
   after this merge has a new digest; no existing release is invalidated, because
   each is pinned to its own revision. Nothing here can produce a stale-digest
   provision failure.
3. **Cross-lane, silent, and nothing tests it.** Slice B hard-links originals
   into `os.path.join(PROVISIONER_TRIP_NFS_LOCAL_BASE, slug)` +`/documents`
   (`provisioner.py:195`) and writes `TRIP_DOCUMENTS_DIR={nfs_mount_path}/documents`
   into a new container's `.env` (`adapters.py:302`).
   `feat/trip-data-dir-by-id-sprint6` renames the trip NFS directory from slug to
   **trip id** (its `adapters.py` diff widens the reset guard to
   `trip_[0-9a-f]{8,}`). With both landed, the two halves compute different
   directories — and the failure is silent by construction: `/api/trip-documents`
   filters its manifest to files that are actually present, so it returns `[]`
   and a trip simply shows no source documents. Both lanes' suites stay green.
   The two lanes *do* both touch `adapters.py`, `provisioner.py`,
   `teardown-trip.py` and `tests/scripts/test_teardown_trip.py`, so the textual
   conflict will at least force a human to look — which is the only reason this
   is Medium–High and not simply High.
4. **`feat/organizer-invite-links` conflict surface.** Beyond the migrations:
   `chat-router.ts`, `relay/dispatch.ts`, `migrations.test.ts`, `provisioner.py`,
   `test_provisioner.py`, `CLAUDE.md` — six files both sides now edit. Slice B's
   `dispatch.ts` hunks insert a new command branch and a new media route into the
   same function that lane extends. This is a carry-forward note, not a blocker.
5. **`migrations.test.ts` is a guaranteed conflict for every future migration**,
   and the file names each migration **twice**. A resolution that keeps one list
   and drops the other still passes on the survivor — the handoff doc names this
   trap explicitly (§5.12.2). Put it in the integrator's carry-forward list.
6. **Relay wire.** `WireMediaDescriptor.message_id` is optional and is both
   produced and consumed inside the relay (`normalize.ts` → `poller.ts`). No
   gateway-version coupling.
7. **`authRequired` is not an organizer check.** `/api/trip-documents` and the
   widened `confirmationPath()` both sit behind it, so **any trip member's JWT —
   or the agent API key — can list and fetch every source document a trip was
   built from**, including whatever the organizer forwarded. The manifest filter
   (`/^[a-f0-9]{64}\.(pdf|docx|xlsx|html|txt|png|jpg|webp|gif)$/` plus a presence
   check) correctly makes this un-probeable, `.svg` and `.html` are correctly
   left out of the content-type map, and `path.basename()` blocks traversal — the
   code is careful. The *contract* is the open question, and per CLAUDE.md a
   security path gets `boundary-reviewer` with real request/response evidence
   rather than a green suite.

---

## 5. Live-fleet impact

Read today, read-only, through the fleet monitor's MCP against the production
stack (hosts and credentials live in the private config, never here):

| | |
|---|---|
| **Live** | 1 trip — `japan-tokyo-hakone-kyoto-osaka-2026`, `ready_private`, reachable, created 2026-09-14, idle 144h |
| Prospects | 6 `draft`, **2 `intake_confirmed` and never built (10 days)**, 1 `intake_in_progress` |
| Retired | 39 |
| Interviews open right now | none |
| Unreachable non-retired trips | none |
| Provisioning jobs | 33 succeeded, 1 failed, 1 cancelled |

**What this merge does to them: nothing.** Merging changes no running process.
Reaching them needs a VM redeploy (control-plane half) and, for
`server/server.js`, a new release *plus* a per-trip redeploy — the one live trip
keeps its pinned release until somebody deliberately redeploys it.

Two things the merge nevertheless changes about the *risk* around them:

- The two `intake_confirmed`-but-unbuilt prospects are exactly the population the
  correction path acts on: confirmed trips whose organizer may still send a
  document. After a deploy, a file from either organizer's DM stops reaching the
  companion and becomes a proposal.
- Provisioning is on for a real organizer on the VM (standing memory, unverified
  today), and the Mac provisions onto the same Proxmox/NPM/Cloudflare and derives
  the same slug from the same scenario. So the §6 isolation test below needs a
  window agreed with a person, not just a free evening.

---

## 6. The plan — what to run for the **merge** decision

The suites are already green on this exact tree (caller-supplied, §0). What
follows is what a green suite cannot tell you. None of it is a deploy.

| # | Run | Command / action | Who must be present | Minutes | Batch? |
|---|---|---|---|---|---|
| 1 | Preflight on the merged tree | `bash scripts/preflight-checks.sh --staged` | nobody | **done — exit 0, 2 unrelated warnings** | — |
| 2 | Migration ordering, fresh **and** upgrade, on a **private** database | `CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:5434/cptest_mergecheck" npm run test:migrations --prefix control-plane/api` — **never the shared `cptest`** | nobody | 3 | isolated |
| 3 | Security boundary on the new route | `boundary-reviewer` on `/api/trip-documents` + `confirmationPath()`: a member JWT, an organizer JWT, the agent key, and no credential at all, with real request/response | reviewer | its own pass | **isolated** |
| 4 | Correction-approval path, deliberately | On a trip **nobody is on**: confirm an intake, send a document to the organizer DM, tap Approve, and watch whether a provisioning job is created. Refuse this on anything past `ready_private`. | a person, and an agreed VM/Mac window | 20 | **isolated** |
| 5 | Document handoff path assertion | After one provision with a document: assert the linked file exists under the container's `TRIP_DOCUMENTS_DIR` and that `/api/trip-documents` returns it — the assertion that turns §4.3 loud | with #4 | 10 | rides on #4 |
| 6 | Carry-forward note written | The three items in §8 recorded where the next integrator will read them, before any other lane merges | integrator | 10 | — |

Not run, deliberately: `scripts/preflight-deploy.sh` (relinks `node_modules` in
worktrees) and `tests/scripts` (stages probe files into the worktree index, #135)
— both named in the handoff doc's standing rules.

---

## 7. Budget

- **Minimum gate for the merge itself: #1 (done) + #2 + #6 — about 13 minutes.**
  That covers everything the merge changes for the branch: the tree commits, the
  migrations order and apply cleanly both ways, and the next integrator is
  warned.
- **+ #3 (`boundary-reviewer`)** buys the one thing that must not be inferred
  from a green suite: that a member token cannot read something the product did
  not intend it to. Owed before any release promotion; cheapest to do now, while
  the author's reasoning is fresh.
- **+ #4 and #5 (~30 min plus a window)** buy the only proof that a Telegram tap
  does what the code says it does, on a trip nobody is on. Without them, the
  first time that path runs for real is on somebody's trip.
- The 80-minute scenario walk buys nothing extra *for the merge*. It belongs to
  the deploy decision, with the compose hunk, and is assessed elsewhere.

---

## 8. Go / no-go for the merge, and the way back

**Merge is a go** provided:

1. §6 #2 is green against a private database (not `cptest`).
2. The three carry-forward items in §9 are written down where the next
   integrator will read them — a merge that lands silently is how §3.2 turns
   into a real ordering bug three merges from now.
3. Nobody treats this merge as authorisation to deploy. The compose hunk is
   still held; the deploy decision is separate and already assessed elsewhere.

**Stop the merge if:** §6 #2 shows any file applying out of the asserted order,
or `migrations.test.ts` passes while a migration on disk is absent from either
list (that is the silent one), or preflight is re-run and no longer exits 0.

**The way back from a merge is cheap and stays cheap:** no migration has been
applied to any real database by merging, no release exists, no container has
been touched. The merge commit is revertible; that is the whole reason the
merge decision and the deploy decision are worth keeping apart.

**One housekeeping note:** this report is an **untracked** file in a worktree
whose index is pre-loaded with the merge content. `git commit` on the prepared
index will not include it; `git add -A` would. Move or delete it before
committing the merge if the plan is to land it separately.

---

## 9. What would reduce the risk — ranked by risk removed per minute

1. **Rename `feat/organizer-invite-links`'s two migrations to timestamp names
   (15 min, before that lane merges).** Removes a silent fresh-vs-upgrade
   ordering divergence *and* a `0054` numeric collision, and it is free right
   now because production is at `0051` and has applied neither.
2. **Write the carry-forward note (10 min).** Three lines: the migration rename;
   `migrations.test.ts` names every migration twice and a resolution can keep one
   list; `adapters.py` / `provisioner.py` documents path vs the trip-data-dir-by-id
   lane. This is the single highest-value artefact of this assessment.
3. **`boundary-reviewer` on `/api/trip-documents` (one pass).** The only way to
   know what a member token can read. Cheapest while the change is fresh, and
   owed before any release promotion regardless.
4. **Add one assertion to the provisioning test that the linked document is
   present under `TRIP_DOCUMENTS_DIR` (10 min).** Converts §4.3 from a silent
   empty list into a red test — the repo's own bug class, closed for the price of
   one assertion.
5. **Give `provisionOnConfirm` a lifecycle guard, or an explicit decision that it
   has none (20 min).** Today a Telegram tap rebuilds a confirmed trip's site with
   no check on how far past `ready_private` that trip is, while
   `teardown-trip.py`, `fresh-interview.py` and `shift-trip-dates.py` all refuse
   at that line. Either the guard, or a comment saying why this path is the
   exception.
6. **Nothing else.** The four migrations are additive and headered, the seal
   logic is sound, the relay wire change is internal and optional, and the suites
   are green on this exact tree. This is a large change set that is, on the merge
   axis specifically, low-consequence.

---

## 10. Decisions needed — nothing guessed

1. **The 2026-09-21 deploy plan could not be read.** Its two findings were
   re-derived here. Someone who can reach it should reconcile §3.3 with what it
   actually said about "migration sequencing" — my two readings lead to opposite
   merge answers, and I have given both.
2. **Who owns the migration rename on `feat/organizer-invite-links`?** That lane,
   or the integrator at merge time. It has no owner today.
3. **Is a Telegram tap an acceptable trigger for re-provisioning a confirmed
   trip, with no lifecycle guard?** Open since the 2026-09-19 assessment; still
   open. It does not block this merge; it blocks the deploy.
4. **Is "every trip member can read every source document" the intended
   contract** for `/api/trip-documents`? A product decision, not a code defect.
5. **Standing memory carried, unverified today:** that provisioning is left on
   for a real organizer on the VM. Assumed true for §5; confirm before scheduling
   §6 #4.
