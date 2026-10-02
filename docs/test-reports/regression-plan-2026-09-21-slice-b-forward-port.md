# Regression plan — Slice B forward-port (`ddf943c`)

- **Commit assessed:** `ddf943c1dd00c13ce044c1cfaed07602e33eec62`
- **Branch / worktree:** `worktree-agent-a1fbd6345dd033f68` in
  `/Users/elul/kinerary/.claude/worktrees/agent-a1fbd6345dd033f68`
- **Merge-base with `origin/integration/sprint-6`:** `2966cbd`
- **`origin/integration/sprint-6` tip at assessment time:** `c263f4f` (5 commits ahead)
- **Mode:** branch / pre-deploy, run locally with production read access
- **Assessed:** 2026-09-21
- **Sprint state read at assessment:** sprint lock **OPEN** since 2026-09-20,
  baseline **LOCKED** at `97582b6` (`scripts/project-state.py show`). Standing
  memory said "Sprint 6 locked; do not assess or deploy" — **that is stale, and
  verified open today.**

## Verdict in one line

The forward-port itself is sound and the un-rebased state is **not** a merge
hazard — but this must not be deployed as written, because (a) production's
schema is at **0051**, so any sprint-6 deploy applies **seven** migrations, not
four, one of them out of order and one a backfill, and none of that sequence is
covered by any test; and (b) the commit adds a path where an organizer's
**button tap re-provisions a live family's site onto a different release**, with
no human deploy decision in the loop and provisioning switched on.

---

## 1 — Change set

| | |
|---|---|
| `ddf943c` | `fix(intake): forward-port #145 (Slice B) — document intake, registry, provisioner handoff` |
| Diff vs `2966cbd` | 52 files, +9323 / −156 |

Enumerated by area (`git diff 2966cbd..ddf943c --stat`, read 2026-09-21):

**Control-plane API source (9 new + 6 changed).** New:
`answer-provenance.ts`, `document-correction.ts`, `document-intake.ts`,
`document-registry.ts`, `document-store.ts`, `document-sweeper.ts`,
`document-vision.ts`, `model-task-settings.ts`. Changed: `chat-router.ts`,
`document-gate.ts`, `interview.ts`, `relay/dispatch.ts` (+98),
`relay/poller.ts` (+1046/−…), `relay/protocol.ts`, `relay/server.ts`.

**Migrations (4 new).** `20260918110129_document_registry.sql`,
`…130_answer_provenance.sql`, `…131_model_task_settings.sql`,
`…132_document_corrections.sql`.

**Python worker.** New `document_handoff.py`; changed `provisioner.py`,
`transformer.py`, `__main__.py`. Plus `provisioning/adapters.py` (one line:
`TRIP_DOCUMENTS_DIR`).

**Trip site.** `server/server.js` (+72/−…): new `GET /api/trip-documents`,
`confirmationPath` extended, MIME table extended.

**Scripts / tests / docs.** `scripts/teardown-trip.py`; 11 new test files;
`tests/helpers/ports.js`, `tests/helpers/server.js`, `tests/package.json`,
`tests/mcp-extract.test.js`; `CLAUDE.md` (+3); four docs under `docs/`.

**Not in the change set, and this matters:** `control-plane/deployment/`. See §3.

### Is the un-rebased state a blocker?

**No, not as a merge risk — verified, not assumed.**

- The 5 commits on `origin/integration/sprint-6` since `2966cbd` are `a794b5e`,
  `81e8484`, `59ed025`, `ec6ad8c`, `c263f4f`. They touch
  `.claude/agents/integrator.md`, `.codex/agents/integrator.toml`,
  `scripts/preflight-checks.sh`, `scripts/spa-parity-preview.mjs`,
  `server/living-journey.js`, `site/modern/assets/index-*.js`,
  `site/modern/index.html`, `tests/living-journey.test.js`,
  `tests/scripts/test_preflight_b7_merge.py`, and four `trip-web/src/` files.
- `comm -12` over the two name-only file lists: **zero overlap**. Not one of the
  twelve files the brief listed as at risk (`relay/poller.ts`,
  `relay/dispatch.ts`, `interview.ts`, `chat-router.ts`, `document-gate.ts`,
  `relay/protocol.ts`, `relay/server.ts`, `CLAUDE.md`, `scripts/teardown-trip.py`,
  `provisioning/adapters.py`, `server/server.js`, `tests/helpers/ports.js`) was
  touched by those 5 commits.
- `git merge-tree --write-tree origin/integration/sprint-6 HEAD` → exit 0, tree
  `d8fecdd`, **no conflict output**.
- `a794b5e` changes preflight **B7** (grandfathering a legacy migration arriving
  through a merge). Irrelevant to these four, which are timestamp-named and pass
  B7 on their own — confirmed by running preflight, §6.

**But it is still a real gap, for a different reason.** `59ed025` changes
`server/living-journey.js`, `site/modern/index.html` and
`site/modern/assets/index-*.js` — all under `PAYLOAD_ROOTS = site, server,
shared` (`release-artifact.ts:24`). This commit changes `server/server.js`,
also under those roots. The merged tree therefore has an **artifact digest
different from either parent**, and a release cut from `ddf943c` alone would
ship without the Journey/Today/weather date-alignment fix. All the verification
evidence — 421/421, 452/452, 490/490 — was produced at `ddf943c`, not at the
merge result. The merge is textually clean and semantically untested.

**Recommendation: merge (do not rebase) onto `c263f4f`, then re-run the trip-site
and control-plane suites on the merge result before anything else in this plan.**
Do not rebase: `ddf943c`'s commit message is the authorship record of a
reconciliation that was done by reading both sides, and a rebase destroys the
commit that documents it. ~60 min, §5 run 0.

---

## 2 — Risk table

Surface per CLAUDE.md's deploy-path table. "Blast radius" is who feels it.

| # | Change | Surface | Blast radius | Migration? | Compat break? | Risk | Test | Min | Batch? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 4 new migrations, **applied on top of prod's 0051 alongside 0050/0052/0053/0054** | `db/migrations/` → API boot | **Everyone, irreversibly** | **yes ×7** | no | **Highest** | rehearse the exact prod sequence on a restored copy (§5 run 1) | 45 | **isolated** |
| 2 | `applyCorrectionCallback` → `provisionOnConfirm` re-provisions a **live** trip onto the newest *available* release | `api/src/` + worker | **The one live family**, at their own tap | — | — | **Highest** | isolated walk on a throwaway trip; do not exercise on the live trip | 40 | **isolated** |
| 3 | `/model` `/models` runtime model switching, super admin DM | `api/src/relay/` | Every organizer's document reads, fleet-wide | — | — | **High** | `boundary-reviewer`, real request/response | own pass | **isolated** |
| 4 | `GET /api/trip-documents` + `confirmationPath` widened to document dirs, both `authRequired` | `server/` → **a release** | Any trip member or agent key on any trip built from a new release | — | **digest** | **High** | `boundary-reviewer`; `tests/trip-documents.test.js` is necessary, not sufficient | own pass | **isolated** |
| 5 | `relay/poller.ts` rebuild (registry, `readDocumentsInto`, `foldItineraryFromDocument`) | `api/src/relay/` | **Every live Telegram conversation**; a restart mid-turn drops it | — | — | High | e2e interview with documents, ≥2 runs | 80×2 | batch (run 3) |
| 6 | `relay/dispatch.ts` `document_correction` / `correction_callback` routing | `api/src/relay/` | Confirmed trips' organizer DMs | — | — | High | rides run 3's post-confirm leg | — | batch (run 3) |
| 7 | Worker document handoff + `provisioner.py` publish/link/manifest | `worker/`, `provisioning/` | **Only trips being provisioned** — not a settled trip | — | — | Medium | rides run 3's provision | — | batch (run 3) |
| 8 | `provisioning/adapters.py` `TRIP_DOCUMENTS_DIR` | `provisioning/` | New containers only (`if [ ! -f .env ]`) | — | — | Medium | assert the var inside a new container | 5 | batch (run 3) |
| 9 | `interview.ts` — `askOpenConflict` re-enabled, `confirmIntakeVia` restored | `api/src/` | Every organizer mid-interview | depends on #1 | — | Medium | rides run 3 | — | batch (run 3) |
| 10 | `scripts/teardown-trip.py` document tables/store cleanup | `scripts/` | **Nothing until a human runs it** | — | — | Low | `tests/scripts/test_teardown_trip.py`; plan-mode on a throwaway | 10 | batch (run 3) |
| 11 | `CLAUDE.md` `EXTRACT_INTAKE_*` / `EXTRACT_ITINERARY_*` | docs | Operators | — | — | Low | none; but see decision D4 | 0 | — |
| 12 | `tests/` helpers, ports, `package.json` | tests | Nobody | — | — | Low | **measured green**, §6 | 1 | batched |

---

## 3 — Migration and compatibility findings

### 3.1 Production is at 0051. The deploy applies seven migrations, not four.

Read on the VM, 2026-09-21, read-only
(`PGOPTIONS='-c default_transaction_read_only=on'`):

```
SELECT version FROM public.control_plane_schema_migrations ORDER BY version DESC LIMIT 8;
 0051_trip_person_links.sql
 0049_interview_session_expiry.sql
 0048_interview_interpretations.sql
 ...
```

The running containers are all tagged `810795a` =
`fix(provisioning): verify a new trip-mcp bridge can reach its trip (#104)`,
2026-09-18, **on `main`**. `git ls-tree 810795a control-plane/db/migrations/`
ends at `0051`. Consistent.

`integration/sprint-6` carries four migrations `main` does not: `0050_plan_reviews.sql`,
`0052_telegram_organizer_links.sql`, `0053_companion_reply_capture.sql`,
`0054_companion_bug_reports.sql`. So the actual sequence a deploy of this work
will run against production is:

```
0050_plan_reviews.sql              ← OUT OF ORDER: 0051 is already applied
0052_telegram_organizer_links.sql  ← contains a BACKFILL over live rows
0053_companion_reply_capture.sql   ← NOT NULL DEFAULT on populated `trips`
0054_companion_bug_reports.sql
20260918110129_document_registry.sql
20260918110130_answer_provenance.sql
20260918110131_model_task_settings.sql
20260918110132_document_corrections.sql
```

`applyMigrations` runs unapplied files in name order, so `0050` runs *after*
`0051` was applied weeks ago. I read both: `0050` adds `plan_snapshot` /
`plan_snapshot_at` to `trips` plus `plan_reviews` and `plan_review_proposals`;
`0051` adds `trip_person_links`. They are independent, so this will apply. **But
`test/migrations.test.ts` proves only fresh-install and upgrade-from-empty** (it
opens with `DROP SCHEMA … CASCADE`). **Nothing anywhere tests the sequence
production will actually run.** That is the single cheapest gap to close, and
run 1 closes it.

### 3.2 The four new migrations are additive — with one inaccurate header

I read all four in full. Every statement is `CREATE TABLE IF NOT EXISTS`,
`CREATE [UNIQUE] INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
one `CREATE OR REPLACE FUNCTION` and one `CREATE TRIGGER` on a table the same
file creates. **No `DROP`, no narrowed `CHECK` on an existing column, no type
change, no `UPDATE`.** The `-- rollback: compatible` classification is correct
for all four.

One correction to the prose: `20260918110129`'s header says *"nothing existing
changes shape"*, and that is **not true** — it alters the pre-existing
`source_artifacts`:

```sql
ALTER TABLE control_plane.source_artifacts
  ADD COLUMN IF NOT EXISTS document_id text REFERENCES control_plane.trip_documents(id) ON DELETE CASCADE;
ALTER TABLE control_plane.source_artifacts
  ADD COLUMN IF NOT EXISTS filename text;
ALTER TABLE control_plane.source_artifacts
  ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now();
```

That third line is a `NOT NULL` added to an existing table. It is safe here for
two reasons, both checked rather than assumed: `now()` is `STABLE`, not
volatile, so PostgreSQL 16 takes the metadata-only fast-default path; and
`SELECT count(*) FROM control_plane.source_artifacts` on production returns
**0**. The migration's own claim that nothing has ever written to that table is
true today. Fix the header sentence; the classification can stand.

### 3.3 Sizes of the tables the older four touch (production, 2026-09-21)

```
source_artifacts | intake_sessions | trips | intake_versions
               0 |              26 |    49 |              36
```

So `0052`'s `INSERT … SELECT DISTINCT ON … FROM control_plane.intake_sessions
… ON CONFLICT DO NOTHING` backfill reads 26 rows, and `0053`'s
`companion_reply_capture_enabled boolean NOT NULL DEFAULT true` lands on 49.
Both are trivially fast. They are still *data-dependent statements that no test
exercises*, which is why run 1 rehearses against a restored copy rather than an
empty database.

### 3.4 Sequencing on the real deploy path is already correct

The caller asked specifically about migration-then-code ordering. **The tool
already enforces it**, and I read the source rather than the runbook:
`control-plane/deployment/vm-release.py`, the `_switch` path (~lines 1210–1237),
is documented as *"Checkout, vm.env, migrate — nothing that is running is
touched yet, and a failed migrate puts the checkout and vm.env back"*, and runs
`compose run --rm --no-deps migrate` before any service restart. On failure it
reverts the checkout and names which migrations did commit.

Two consequences worth stating:

- There **is** a mixed-version window: migrations run under the new image while
  the old API is still serving. It is safe for this set, because all seven are
  additive and old code neither reads the new tables nor writes the new columns.
  `0053`'s `NOT NULL DEFAULT true` on `trips` is invisible to code that selects
  named columns.
- `classify_migrations` returns `compatible` only if **every** migration in the
  span declares it. I read the header of all seven: all seven say `compatible`.
  So `kinerary-cp-release rollback` would **keep** the database rather than
  discard it. That is the good case, and it is only true because nobody skipped
  a header.

### 3.5 Release seal — a new release is required, and promotion is a deploy

`server/server.js` is under `PAYLOAD_ROOTS` (`release-artifact.ts:24`). The
newest `available` release on production is:

```
release_276dcf8beebcd18e442d8501a0fe33d8 | cea047d650 | available | app 1 | schema 1..3 | promoted 2026-09-16 21:48
```

That is `cea047d` — the site-upload auth fix on `main`. It does **not** contain
`/api/trip-documents`. Until a release is built from the merged tree, verified,
and **promoted to `available`**, no trip site gets the route. Promotion
classifies as a deploy in `match-command.py`, correctly: from that moment every
trip built or rebuilt runs that tree — including a rebuild triggered by risk #2.

### 3.6 Intake schema — no break

Every release row carries `application_schema=1`, `data_schema_min=1`,
`data_schema_max=3`. This commit does not change the shape of
`intake_versions.data`; the new tables sit beside it, which the
`20260918110130` header explains as deliberate (writing source ids into the
answers would move the digest an intake version is pinned to). No
`release_accepts_intake_schema_vN` ritual is owed.

### 3.7 Old containers and `TRIP_DOCUMENTS_DIR`

`provisioning/adapters.py` writes `TRIP_DOCUMENTS_DIR={nfs}/documents` into a
container's `.env` only inside `if [ ! -f {app_dir}/.env ]` — so **no existing
container ever gets it**. `server/server.js` covers that with a derived
fallback:

```js
path.basename(DATA_DIR) === 'server-data' ? path.join(path.dirname(DATA_DIR), 'documents') : null
```

Every provisioned trip has `DATA_DIR={nfs}/server-data`, so the fallback
resolves. **Confirm this on a real container rather than on my reading** — it is
one `docker exec … env | grep DATA_DIR`, and it is in run 3's checklist.

---

## 4 — The feature ships inert on the VM, deliberately, and nothing says so at runtime

This is the most important thing in this report after §3.1, and it cuts both
ways: it **lowers** the deploy risk a great deal and it **removes almost all of
the deploy's value**.

`relay/server.ts:243` says `DOCUMENT_STORE_REQUIRED=1 (compose.vm.yml)`.
**`compose.vm.yml` contains no `DOCUMENT_STORE` entry at all**, and this commit
does not touch `control-plane/deployment/` — `git diff --stat 2966cbd..ddf943c
-- control-plane/deployment/` is empty. `docs/test-reports/slice-b-step6-handoff-2026-09-21.md`
records why, as Dror's decision of 2026-09-21: `KINERARY_NFS_ROOT` is defined
nowhere, the held hunk uses `${KINERARY_NFS_ROOT:?…}` which is a compose *parse*
failure, and a parse failure takes API, worker and relay down together. He
explicitly rejected defaulting the variable, because a default risks silently
bind-mounting a local directory instead of the NFS mount. That reasoning is
right and should survive.

Read off production today, so the consequence is a fact and not a prediction:

- relay container env: no `DOCUMENT_STORE_DIR`, no `DOCUMENT_STORE_REQUIRED`
- worker container env: no `DOCUMENT_STORE_DIR`, no `PROVISIONER_TRIP_NFS_LOCAL_BASE`
- `mount` / `df` on the VM: **no NFS mounted**

Traced through the code with both unset:

```js
const storeReadiness = process.env.DOCUMENT_STORE_DIR || process.env.DOCUMENT_STORE_REQUIRED === "1"
  ? await checkDocumentStore(process.env)
  : null;
if (storeReadiness && !storeReadiness.ok) { … }
```

`storeReadiness` is `null`, so the `if` never fires and **the relay logs
nothing at all**. `documentStore` is `undefined`. Documents are still read,
registered with `ingest_state='unstored'`, extracted and folded into answers —
that half works. Their **bytes are discarded**. `load_trip_documents` returns
`[]` on `not store_root`, `documents.json` is never written, and
`/api/trip-documents` returns `[]` forever. No warning, no failed health check,
no way to tell from the outside.

This is the repository's own named bug class: an unset variable that downgrades
silently. It is a *decided* state, not an accident — but nothing in the deployed
artifact says so at runtime, and in three weeks nobody will remember. **The
single cheapest risk reduction in this report is one `warn` log line.** See R1.

The fail-safe direction is right everywhere else I checked, and that is worth
recording: the worker raises only when `DOCUMENT_STORE_REQUIRED=1`
(`__main__.py`); `provisioner.py`'s publish loop is guarded by `if documents:`
with a per-document NFS→deploy-dir fallback and an explicit *"never a failed
deploy"*; `codexIsolationProblem` sets `KINERARY_CODEX_ISOLATION_UNVERIFIED=1`
and `runnerForBinding` then returns `undefined` for codex rather than silently
substituting a model.

And note the inverse hazard, for whoever does the NFS enablement later: if
`DOCUMENT_STORE_REQUIRED=1` is set and the marker file
`.kinerary-document-store` is not on the mounted volume, the relay calls
`process.exit(1)` — **crash-loop, every live Telegram conversation dead.** That
is correct fail-safe behaviour and it is exactly why the marker must be created
before the variable.

---

## 5 — Live-fleet impact

All of this was read on 2026-09-21 through the read-only fleet MCP
(`.agents/skills/trip-fleet-monitor/fleet-mcp.mjs`) and read-only psql. Nothing
was written.

### Which trips are at `ready_private` or beyond

**Exactly one.**

```
trip_66617c87099572fc766c282a5761d55b | japan-tokyo-hakone-kyoto-osaka-2026
  class live | stage ready_private | reachability reachable
  created 2026-09-14 19:39 | provisioned 2026-09-15 18:31 (job took 3m) | idle 143h
```

Its interview session `sess_e55e5ce0…` is `confirmed`, language `en`,
`interpret_path = t` (agentless), and it was **built from a PDF** — 4708 chars
at 2026-09-15T18:19. 16 model calls, all succeeded. Bindings: a **group**
binding open since 09-16 13:14 and the organizer's **private** binding open
since 09-15 20:29, both on companion profile
`japantokyohakonekyotoosaka2026`. One organizer linked, verified via
`interview_chat`.

**A real family is connected to this right now**, in a group chat, with a live
companion. `teardown-trip.py` and `fresh-interview.py` both refuse past this
line and so does this plan.

### Which release it is pinned to

```
plan release_ee61ecd6c2e5c3633101fb5d11fd6d00 | source_revision 8f4d4e16… | provision | executed | 2026-09-15
```

`8f4d4e16` = `feat(interview): the organizer decides who knows about food needs
and allergies`, 2026-09-14. **The live trip is two releases behind
`available`** and therefore **does not have the `/api/upload` auth fix**
(`cea047d`, PR #86). That matches the 2026-09-17 record that the live sites were
blocked at NPM instead of redeployed. **Carried forward, unverified today:
confirm NPM is still blocking `/api/upload` for that host before anyone
redeploys that container for any reason — including risk #2 below.**

### Is it running right now?

**I could not determine this, and it is a decision, not a low risk.**
`trip_detail` renders the trip's dates as `- — -`; the fleet MCP's fixed catalog
does not expose them and I did not read `intake_versions.data`. The cheapest way
to settle it is `scripts/shift-trip-dates.py --slug … --status` or reading
`trip.config.json` off the container. **Settle it before scheduling any relay
restart**, because a relay restart under a live conversation drops it and
`vm-relay-restart.sh` only refuses when `awaiting = 'machine'` within five
minutes — that guard does not know a family is mid-holiday.

### Everything else on the fleet

- prospects: 6 `draft`, 2 `intake_confirmed`, 1 `intake_in_progress`
- **2 confirmed-but-never-built, waiting 10 days** — `draft-sreq-98dc4020…` and
  `draft-sreq-f686fe70…`. Someone finished answering and no job exists. Not
  caused by this change, but they are the trips most likely to be built *next*,
  i.e. the first real users of everything in this commit.
- retired: 39. No live trip in flight, no stalled interview, no unreachable
  non-retired trip.

### Production configuration relevant to this change

- **Provisioning is ON**: `PROVISIONER_COMPUTE_ENABLED=1`,
  `PROVISIONER_MCP_BRIDGE_ENABLED=1`, IP pool `.95`–`.99`,
  `PROVISIONER_VMID_MAP={}`. Standing memory said provisioning was left on for a
  real organizer since 2026-09-14 — **verified true today.**
- `TELEGRAM_API_ROOT` is present but **empty** — real Telegram, not a stand-in.
- Relay models: `INTERPRET_PATH_DEFAULT=1`, `INTERPRET_RUNNER=claude`,
  `INTERPRET_MODEL=claude-sonnet-5`, `EXTRACT_RUNNER=claude`,
  `EXTRACT_MODEL=claude-sonnet-5`. **No `*_EFFORT`** — expected on the VM, which
  takes `medium` from `CLAUDE_CONFIG_DIR`. **No `EXTRACT_INTAKE_*` or
  `EXTRACT_ITINERARY_*`**, so the CLAUDE.md addition in this commit describes a
  configuration nobody has applied.
- `codex` **is** present in the relay image: `/usr/local/bin/codex`,
  `codex-cli 0.153.2`. So the `codex` / `gpt-5.6-luna` binding is at least
  reachable — but whether `codexIsolationProblem` accepts 0.153.2 is unverified
  (decision D4).

### Outside the control plane

Standing memory says **CT200 `trip-usa2026` is a real production site that no
control plane tracks**. I did not verify it today and the fleet MCP structurally
cannot see it. It will **not** pick up `server/server.js` changes through any
release mechanism; conversely nothing here reaches it. Anyone reasoning about
"who gets `/api/trip-documents`" must remember it exists.

### What has to be redeployed for this to reach anyone — and in what order

1. **Merge onto `c263f4f`**, re-run suites (§5 run 0). Nothing is deployed.
2. **Snapshot first.** `sudo kinerary-cp-release upgrade --dry-run` snapshots the
   VM from the Proxmox host and dumps the database, and records the way back. No
   network filesystem is mounted on the VM today, so its storage guard will not
   refuse. Read the dry-run's migration verdict and confirm it lists **seven**
   migrations, all `compatible`. If it lists four, it is comparing against the
   wrong `from` revision and you are about to find out the hard way.
3. **`sudo kinerary-cp-release upgrade`.** This is the whole ordering answer:
   the tool does checkout → `vm.env` → `compose run --rm --no-deps migrate` →
   services → relay → hermes, and reverts the checkout if migrate fails without
   touching anything that is running. **Do not run migrations by hand and do not
   hand-edit `KINERARY_REV`.** At this point every organizer mid-interview and
   every bound chat is restarted — schedule it around the live trip's
   conversations.
4. **Relay restart** is part of step 3; if a separate one is needed later, use
   `control-plane/deployment/vm-relay-restart.sh`, **never** `scripts/relay-restart.sh`
   (that one restarts the Mac's).
5. **Nothing above reaches a single trip site.** For `/api/trip-documents` and
   the widened `confirmationPath` to exist anywhere, a release must be built
   from the merged revision, verified, and **promoted to `available`**.
6. **And even then, the live trip does not get it.** A trip site is pinned to
   the release it was provisioned from. `japan-tokyo-hakone-kyoto-osaka-2026`
   keeps running `8f4d4e16` until somebody redeploys it, and **that redeploy is
   its own hard-rule-2 decision** — it would also move that family from
   `8f4d4e16` to the merged tree in one step, past the upload-auth fix they are
   currently protected from by NPM rather than by code.

So: **on the code path, this deploy reaches the live family the moment the relay
restarts** (interview and companion behaviour, the correction flow, the `/model`
command). **On the site path, it reaches zero trips** until a promotion, and
zero *existing* trips until a per-trip redeploy. Those are two different clocks
and the plan below keeps them apart.

---

## 6 — What I re-verified, and what I carried

Measured here, in this worktree, 2026-09-21:

| Check | Result |
|---|---|
| `cd tests && npm test` | **490 tests, 490 pass, 0 fail, 52.7 s wall** — matches the caller's 490/490 |
| `scripts/preflight-checks.sh --all` | **exit 0, zero blocks.** B6, B7 (the four timestamp names pass), B8 clean. Two warnings, both `trip-fleet-monitor` profile drift, unrelated |
| `npm run test:unit --prefix control-plane/api` | **23 tests, 0.65 s** — see below |
| `scripts/project-state.py show` | sprint **OPEN**, baseline **LOCKED** at `97582b6` |
| `git merge-tree --write-tree origin/integration/sprint-6 HEAD` | exit 0, clean |

**A correction to the cost table this skill carries.** `npm run test:unit
--prefix control-plane/api` is listed as "~1 min". Measured: **0.65 s, 23
tests** — and `package.json` shows it runs only 5 of the 105 files in `test/`
(`config`, `contracts`, `lifecycle`, `redaction`, `adapters`). It covers **none**
of the new document modules. The number in the table is wrong and the suite is
irrelevant to this change. The real control-plane suite is `npm test` —
`--test-concurrency=1` over 105 files, needs a test database.

**I did not re-run the control-plane DB suite (421/421) or the worker Python
suite (452/452), and deliberately so:** `cptest` is shared between sessions and a
DB-backed suite wipes whatever database it is handed. Those two numbers are
carried as the caller's claims, unverified by me.

### The forward-port's central claim, independently checked

For each of the five sprint-6 commits that touched `relay/poller.ts` since the
divergence at `a7c4518`, I extracted every substantive added line and grepped
the ported file for it:

```
fda968c: 12 added lines, 0 missing      ae397fd:  7 added lines, 0 missing
f7a117e:  3 added lines, 0 missing      ff522e4: 77 added lines, 1 missing
e2ff4c8: 110 added lines, 9 missing
```

I chased all ten apparent misses. Every one is a deliberate rename or
restructure, not a loss:

- `readDocumentInto` → `readDocumentsInto` (the registry rebuild)
- the `intake-copy.js` import line rewritten; `recapLabel` genuinely dropped
- `offerOnScreen` / `offerOutstanding` now computed through `boundaryOnScreen(view)`
  — from `ff522e4`'s own natural-language-boundary work — instead of the older
  `lastPrompt && !nextQuestion && !pendingAsk && state==="interviewing"`
  conjunction. Alive at `poller.ts:3165` and `:3637`.
- `promptKey` alive at `poller.ts:3658-3661`
- `if (!deps.modelRunner)` alive at `poller.ts:1489`, and **louder** than the
  version it replaced: it now says `documentNothing` to the organizer, commits
  `failureReason: "NOT_CONFIGURED"`, and asks the next question, instead of
  returning `false` silently.

**No production fix was lost.** That is the port's central claim and it holds.

The `consult`-caught regression is fixed and explained in place at
`poller.ts:1498-1510`: `ask()` now runs *after* the `finally` that clears
`markReadingDocument`, because `sendNextStep`'s `isReadingDocument` check reads a
DB-persisted flag and would have swallowed every call made inside the `try` —
"a weaker form of the exact 51-seconds-of-silence incident". I read it; the
ordering is right.

---

## 7 — Two things the brief did not mention, and they are the highest risks

### 7.1 Approving a correction re-provisions a live trip onto a different release

`applyCorrectionCallback` (`poller.ts:640`) → `approveCorrection` → on
`applied`:

```js
const owner = await tripOwnerUserId(deps.db, correction.tripId);
const provisioned = owner ? await provisionOnConfirm(deps.db, correction.tripId, owner)… 
```

`provisionOnConfirm` (`planner.ts:437`) calls `generatePlan` and then
`issueApproval` — it generates *and approves* the plan. `generatePlan` selects
from releases `WHERE status = 'available' … ORDER BY created_at DESC`.

So, concretely, on the one live trip: the organizer sends a PDF to their
companion DM after confirmation, taps **Approve**, and the worker rebuilds their
site onto **`release_276dcf8b` (`cea047d`)** instead of the `8f4d4e16` it is
pinned to. Provisioning is on. This will execute.

Whether that upgrade is desirable is beside the point. **It is a deploy of a
live family's site that hard rule 2 never sees.** Nobody is prompted, nothing is
snapshotted, and the trigger is a button tap by someone who has no idea they are
choosing a code revision. This is the one item I would gate hardest.

The *authorization* on that path is layered and, as far as I read it, sound —
and it is worth saying so plainly so the concern above is not mistaken for a
different one. `applyCorrectionCallback` requires all of:
`correction.requestedChatId === decision.chatId` (the proposal names the chat it
was raised in); `decision.fromId === decision.chatId` (private chat, sender is
the chat); and `confirmedOrganizerChat(db, tripId, chatId)` finding a `confirmed`
`intake_sessions` row for that trip in that chat. `fromId` comes from Telegram's
own `callback.from.id`, never from body input — the right side of the
webhook/callback trust boundary. Note that `dispatchCallback` handles
`correction` **before and independently of** route resolution, so the branch is
reachable from any chat and the entire check lives inside
`applyCorrectionCallback`. That is a deliberate choice, explained in a comment,
and it means the check must be read, not assumed. Send it to `boundary-reviewer`.

### 7.2 `/model` and `/models` — runtime model switching from a Telegram DM

`dispatch.ts` adds a super-admin command that writes
`control_plane.model_task_settings` and changes which model serves which task,
fleet-wide, between calls. Gated on `parsed.kind === "command"`,
`message.chat?.type === "private"`, `options.superAdminSubjectDigest` present,
and `digestTelegramId(String(message.from.id)) === options.superAdminSubjectDigest`.
Absent digest means the branch does not exist and the command falls through to
the ordinary unknown-command answer, which reveals nothing — good design.

The digest comes from the relay's Hermes profile,
`profile.signup.super_admin_subject_digest` (`relay/server.ts:187,211,389`), not
an env var. **I did not read that value off the VM** — the profile path I tried
did not resolve inside the container. Signup approvals demonstrably work on the
VM, which strongly implies it is set, so **treat `/model` as live for the super
admin after deploy** until someone confirms otherwise. This changes which model
reads real organizers' documents. `boundary-reviewer`, with real
request/response evidence; "it came up in the e2e run" is not evidence.

---

## 8 — The plan

Ordered. Nothing here is a deploy; runs 4 and 5 require one, and that decision
is Dror's.

### Run 0 — merge onto `c263f4f`, then re-run the cheap suites — **~60 min, one person**

The merge is proven clean textually; nothing has proven the merged tree.

```bash
# on a branch, not on the integration branch itself
git merge origin/integration/sprint-6        # human runs this; no agent may
cd tests && npm test
CONTROL_PLANE_TEST_DATABASE_URL="postgres://…/cptest_sliceb"   npm test --prefix control-plane/api
cd control-plane/worker && PYTHONPATH=.:../.. python3 -m unittest discover -s tests
npm run build --prefix control-plane/api
scripts/preflight-checks.sh --all
```

Checklist, with the change each check belongs to:
1. `tests/` 490/490 — measured green at `ddf943c`; the merge adds
   `living-journey.test.js` changes and a new `site/modern` build, so this is
   the check that the two site-side changes coexist (#4, #12 + `59ed025`).
2. `control-plane/api` full — the caller's 421/421 must reproduce **after** the
   merge (#1, #5, #6, #9).
3. Worker 452/452 (#7, #8).
4. `preflight-checks.sh --all` exit 0 — confirms B7 still passes with
   `a794b5e`'s grandfather clause in place.
5. **`git status` clean afterwards** — the trip-web build rewrites the tracked
   `site/modern`, and an unrestored build ships whatever it produced.

**Use a private test database name.** `cptest` is shared; two sessions at once
corrupt each other, and a DB suite wipes what it is handed.

### Run 1 — rehearse the *production* migration sequence — **~45 min, isolated, one person**

This is the run that does not exist today and is the reason §3.1 matters.
`migrations.test.ts` cannot do this: it starts from `DROP SCHEMA … CASCADE`.

```bash
# 1. a private database, restored from a production dump — the dump
#    `kinerary-cp-release upgrade --dry-run` takes is exactly the right artifact
createdb cptest_prodseq && pg_restore -d cptest_prodseq <that dump>
# 2. prove the starting point is the real one
psql -d cptest_prodseq -c "SELECT version FROM public.control_plane_schema_migrations ORDER BY version DESC LIMIT 3;"
#    must show 0051_trip_person_links.sql and NOT 0050_plan_reviews.sql
# 3. run the real migrator against it
CONTROL_PLANE_TEST_DATABASE_URL=postgres://…/cptest_prodseq node control-plane/api/dist/migrate.js
```

Checklist:
1. All **seven** apply, in this order: `0050`, `0052`, `0053`, `0054`,
   `…129`, `…130`, `…131`, `…132`. Anything fewer means the baseline was wrong.
2. `0050` applying after `0051` raises nothing (#1, §3.1).
3. `0052`'s backfill inserts **≤26** `telegram_organizer_links` rows and the
   generated `'tol_' || md5(…)` ids satisfy the opaque-id `CHECK` (§3.3).
4. `source_artifacts` gains three columns; `received_at` is non-null on the zero
   existing rows; the `ALTER` is instant (§3.2).
5. A second `migrate.js` run is a no-op — `applyMigrations` returns `[]`.
6. **Then the rollback half:** restore the dump again and confirm the *old*
   image's API boots and serves against the *new* schema. That is the mixed-
   version window §3.4 describes, and proving it is what makes `rollback:
   compatible` more than a comment.

**Isolated, because it is one-way.** There are no down migrations; undoing one in
production means restoring a snapshot.

### Run 2 — the security pass — **`boundary-reviewer`, its own pass**

Three items, all needing real request/response evidence, none of which an e2e
walk produces:

1. **`GET /api/trip-documents` and the widened `confirmationPath` are
   `authRequired`, not `organizerOrAgentRequired`.** CLAUDE.md is explicit that
   `authRequired` accepts any family member's JWT *or* the agent API key. So any
   trip member — and the agent key — can list and download every source document
   the organizer sent: vouchers, tickets, saved booking pages, whatever is in
   them. The manifest itself hands out the 64-hex names needed to fetch through
   `/api/bookings/confirmation/:fn`. **Is that the intended visibility?** It may
   well be — but this is exactly the field-by-field judgement that
   `sanitizeConfig()`'s blanket invariant exists to stop, and it is not mine to
   decide. `tests/trip-documents.test.js` proves traversal is blocked and that a
   saved web page downloads instead of executing (both measured green) — those
   are necessary and not sufficient.
2. **`/model` / `/models`** (§7.2).
3. **`correction_callback` authorization** (§7.1) — and specifically that it is
   handled before route resolution.

### Run 3 — one batched acceptance walk — **~80 min per scenario, Mac, one person**

Everything that is observable on a single interview-with-documents walk rides
here. This is the expensive resource, so it carries a numbered checklist and the
change each item belongs to.

```bash
scripts/preflight-deploy.sh --deploy --auto --scenario multi --cleanup
```

**Not `japan`.** The `japan` e2e fixture collides with the live trip — same
cities and dates, slug derivation is nondeterministic, no guard in code. Use
`multi` or `manual`.

Checklist:
1. `interpret_path` is `1` on the new session, read off the column, not
   inferred: `SELECT id, interpret_path, language FROM control_plane.intake_sessions ORDER BY created_at DESC LIMIT 3;` (#5)
2. Send **two different documents in two messages**, then **the same document
   twice**. Registry has two `trip_documents` rows and three
   `source_artifacts` deliveries — the content-vs-delivery distinction the
   `trip_documents_content_idx` unique index exists for (#5).
3. The next question arrives **immediately** after the document recap, not on a
   later poll tick — the `consult`-caught regression (#5).
4. A document that contradicts a held answer produces a row in
   `trip_answer_conflicts` with `status='open'`, and `askOpenConflict` asks
   about it (#9).
5. Confirm the intake. `confirmIntakeVia` records which registry documents the
   version was built from (#9).
6. **Post-confirmation**, send a document to the organizer's DM: a
   `trip_document_corrections` row appears with `status='pending'`, and
   Approve/Reject **both actually do something** — this is the gap that was
   found and fixed during the port (#6).
7. On Approve: a new `intake_versions` row **and** a provision job. Record which
   release the job selected (#6, §7.1).
8. In the new container: `docker exec … env | grep -E 'TRIP_DOCUMENTS_DIR|DATA_DIR'` (#8, §3.7)
9. `GET /api/trip-documents` on the new site — authenticated 200, unauthenticated
   401, and the manifest's `links` name real phases and bookings (#4)
10. `scripts/teardown-trip.py --trip <slug>` in **plan mode first**; confirm the
    document tables and store appear in the backup list (#10)
11. **Whether documents were kept at all**: `SELECT ingest_state, count(*) FROM
    control_plane.trip_documents GROUP BY 1;` — if every row is `unstored`, the
    store is unconfigured and §4 is the reason. Do not let a green walk hide it.

**Run it at least twice.** The document path has a model in the loop, so one
green run is one sample. Two scenarios (`multi`, `manual`) is better than two
runs of one.

### Run 4 — VM dry-run — **~15 min, one person, a deploy decision**

```bash
sudo kinerary-cp-release upgrade --dry-run
```

Checklist: the migration verdict names **seven** migrations and says
`compatible` for all seven; the snapshot and the database dump are taken; the
recorded way back is printed. **If it names four, stop** — it is comparing
against the wrong `from` revision.

### Run 5 — the deploy itself — **Dror's decision, not in this plan**

---

## 9 — Budget

| Tier | What it costs | What it buys |
|---|---|---|
| **Minimum gate** — runs 0 + 1 + 2 | ~105 min + `boundary-reviewer`'s pass | The merge is proven. The exact migration sequence production will run is proven against production-shaped data, including the rollback direction. The three security paths have real evidence. **Without run 1 you are deciding to find out about `0050`-after-`0051` during a deploy, on one instance everyone shares, with no down migration.** |
| **+ run 3 ×1** (`multi`) | +80 min | The document path works end to end once, including the post-confirmation correction flow that had a real bug in it. One sample of a non-deterministic path. |
| **+ run 3 ×2** (`multi`, `manual`) | +80 min | Two samples. This is what I would actually want before a model-in-the-loop path touches real organizers. |
| **+ run 4** | +15 min | The snapshot exists and the migration span is what you think it is. This is nearly free and it is the only thing standing between a bad `from` revision and a wrong migration set. |

The 80-minute walk is the only thing that proves the correction flow end to end.
Without it you are deciding to find out in production — on a fleet whose next
two trips are two organizers who have already been waiting ten days.

---

## 10 — Go / no-go, and the way back

**Stop the deploy if any of these is true:**

- The merge onto `c263f4f` has not happened, or the suites were not re-run on
  the merge result (§1).
- Run 1 has not happened. **This is the hard one.** The empty-database migration
  test does not cover what production will run.
- `kinerary-cp-release upgrade --dry-run` names fewer than seven migrations, or
  any one of them `breaking`.
- The live trip `japan-tokyo-hakone-kyoto-osaka-2026` is **running right now**
  and nobody has established that (§5). A restart drops live conversations.
- `boundary-reviewer` has not reported on `/api/trip-documents`,
  `/model`, and `correction_callback`.
- Anyone is about to set `DOCUMENT_STORE_REQUIRED=1` without having created
  `.kinerary-document-store` on the mounted volume first — that is a relay
  crash-loop and every bound chat with it (§4).

**The snapshot taken first:** `sudo kinerary-cp-release upgrade` snapshots the VM
from the Proxmox host and dumps the database before it touches anything. Do not
substitute vzdump or an NFS copy. Verify from the dry-run output that both
exist.

**How it is undone:** `sudo kinerary-cp-release rollback` (`--dry-run` first).
Because all seven migrations declare `-- rollback: compatible`, the database is
**kept** — `vm-release.py::classify_migrations` requires unanimity and this set
has it. Old code ignores the new tables; `source_artifacts`' new columns are
nullable or defaulted. What rollback does **not** undo: any trip re-provisioned
by an approved correction (§7.1) is on its new release and stays there, and any
`model_task_settings` row written by `/model` persists — clear it with
`/model <task> default` or `DELETE FROM control_plane.model_task_settings`.

---

## 11 — What would reduce the risk

Ranked by risk removed per minute spent.

**R1 — One `warn` log line when the document store is unconfigured. ~10 min.**
Change `relay/server.ts:246` so that when *neither* `DOCUMENT_STORE_DIR` nor
`DOCUMENT_STORE_REQUIRED` is set it still logs
`relay.document_store_not_configured` at `warn` with "documents will be read and
registered; originals will not be kept". Today it logs **nothing** and the whole
feature is silently inert on the VM (§4). This is the repo's own named bug class,
and ten minutes turns it from invisible into greppable. Do the same in the
worker's `__main__.py`. **Highest ratio in this report by a wide margin.**

**R2 — Run 1. ~45 min.** Rehearse `0050`-after-`0051` plus the `0052` backfill
against a restored production copy. It is the only unproven part of a one-way
change, and the dump you need is one the deploy tool already takes.

**R3 — Ship the correction-triggered re-provision dark. ~30 min.** Put
`provisionOnConfirm` behind a flag that defaults to *off*, or make it select the
trip's **currently pinned** release rather than the newest `available` one. Right
now an organizer's tap silently moves a live family's site across two releases
(§7.1). Either change removes the surprise without removing the feature: the
correction still produces a new intake version, it just does not also perform an
unannounced deploy. Whichever you pick, say so in `docs/document-intake-operations.md`.

**R4 — A test that asserts the sequence, not just the list. ~30 min.** Add a
second case to `migrations.test.ts` that applies migrations *up to a named
file*, then applies the rest — so "a migration arriving below the high-water
mark" is covered by the suite instead of by a one-off rehearsal. That converts
R2 from a manual run into a permanent check, and it would have caught the `0050`
gap without anyone reading a production table.

**R5 — Fix the `20260918110129` header sentence. ~2 min.** It says "nothing
existing changes shape" while adding three columns to `source_artifacts`. The
classification is right; the prose is not, and headers in this repo are read by
a tool that decides whether a rollback keeps the database.

**R6 — Correct the `test:unit` entry in the cost table. ~5 min.** Measured 23
tests in 0.65 s over 5 of 105 files, not "~1 min", and it covers none of this
change. A number that no longer matches the tree teaches people to trust the
table.

**R7 — Establish the live trip's dates and write them down. ~5 min.** Whether
`japan-tokyo-hakone-kyoto-osaka-2026` is mid-holiday decides whether a relay
restart is routine or a real intrusion, and the fleet monitor's catalog does not
answer it. Consider adding trip dates to `trip_detail`'s output — the monitor
exists to answer "is anyone on this right now" and currently cannot.

**R8 — Redeploy decision for the live trip, separately. ~20 min to decide.**
That trip is pinned to `8f4d4e16` and lacks the `/api/upload` auth fix, protected
by NPM rather than by code. It is a standing exposure this commit does not
change — but §7.1 means a correction approval could move it without anyone
deciding to. Decide deliberately, before that can happen by accident.

---

## 12 — Decisions needed

**D1 — Is `authRequired` the right gate for `/api/trip-documents`?** Any trip
member and the agent API key can list and fetch every source document the
organizer uploaded. It may be exactly right; it is not mine to decide, and
CLAUDE.md is explicit that `authRequired` is not an organizer check. Route
through `boundary-reviewer`.

**D2 — Should approving a correction re-provision a live trip, and onto which
release?** (§7.1, R3.) Today: yes, and onto the newest `available` — a deploy
nobody approved.

**D3 — Is `super_admin_subject_digest` set on the VM's relay profile?** I could
not read it. It decides whether `/model` is live after this deploy.

**D4 — Do the `EXTRACT_INTAKE_*` / `EXTRACT_ITINERARY_*` codex bindings get
applied, and has `codexIsolationProblem` been checked against `codex-cli
0.153.2`?** CLAUDE.md now documents them; the VM has none of them set. `codex`
is present in the relay image. If the isolation feature list does not match this
codex version, codex bindings are refused and extraction quietly does less —
the same silent downgrade as §4, from a different direction. Confirm
`relay.codex_isolation_unverified` is **absent** from the relay log after any
deploy that sets them.

**D5 — Is the live trip running right now?** (§5, R7.) Decides the restart
window.

**D6 — When does the NFS / compose enablement land?** Until it does, the
document-to-site half of this feature reaches nobody, which means the deploy
buys the intake half only. That is a legitimate choice — it should be a stated
one, so the next person does not spend a day debugging why
`/api/trip-documents` is empty.

---

*Fleet and production facts in this report were read on 2026-09-21 through the
read-only fleet MCP and read-only psql. Nothing was written, nothing was
deployed, nothing was merged or rebased.*
