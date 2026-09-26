# PR #92 — regression assessment, 2026-09-19

**Mode:** branch / pre-deploy. **Production access: none this run, by instruction.**
Section 4 (live-fleet impact) names what must be checked and why, and does not
check it. Provisioning is ON on the VM for a real organizer; nothing here was
run against the VM, the production database, or any deploy host.

**Verdict.** Do not land whole. The document feature itself is well built and
carries real tests, but three things stop it as a single merge: **the merge into
`integration/sprint-6` is semantically broken today** (10 test files newly red,
measured), **the four migrations carry no `-- rollback:` header**, which forces
every future control-plane rollback to restore the database dump, and **the
Codex isolation in this PR is the weaker of the two competing implementations —
the relay's `OPENROUTER_API_KEY` and `TELEGRAM_BOT_TOKEN` reach the Codex child,
under a test whose name says they do not.** Land PR #91 for #58, split the rest
into a pure-logic slice that can go now and a stateful slice that needs VM
preparation first.

---

## What was measured, and where

Everything below with a number was run in this session on the Mac, 2026-09-19,
against a **private** scratch database (`cptest_rp92`, `cptest_s6base` on
127.0.0.1:5434) — never the shared `cptest`, never a stack database.

| Run | Result | Wall |
|---|---|---|
| `integration/sprint-6` baseline, full control-plane suite | 1334 tests, 1325 pass, **1 fail**, 2 cancelled, 6 skip | 6 m 15 s |
| PR #92 merged into sprint-6, full control-plane suite | 1445 tests, 1413 pass, **24 fail**, 2 cancelled, 6 skip | 6 m 26 s |
| PR #92's new non-DB tests (18 files) | 132 tests, **132 pass** | 4.7 s |
| PR #92's DB document suites + `migrations.test.ts` (7 files) | 49 tests, **48 pass, 1 fail** | 48 s |
| PR #91's `codex-isolation.test.ts` alone | 1 test, pass | 0.6 s |

Numbers I did **not** measure, and their source: trip-site suite 476/476 (PR body);
worker 395 passed / 82 skipped (PR body — this Mac's `python3` lacks PyYAML and
psycopg, so it needs the preflight venv); `preflight-deploy.sh` "tens of minutes"
and the all-scenario e2e "~80 min" (CLAUDE.md).

**One caveat on the merged run.** The PR worktree
`/Users/elul/kinerary/.claude/worktrees/document-intake-s6` is sitting on an
**uncommitted in-progress merge** of `integration/sprint-6` (`MERGE_HEAD` =
`37be82e`), with the migrations already renumbered to 0055–0058 and the test
ports already moved to 38126/38127. There are **zero unmerged paths and zero
conflict markers** — the merge is textually resolved and semantically broken.
Another session may be mid-resolution. The failures are not merge artefacts:
every cluster of them matches a semantic conflict I found by reading the code
(below), so the delta is real even if the resolution is still moving.

---

## 1. Which of #49–#62 does it genuinely close

First, a correction to the framing: **the PR body does not claim all fourteen.**
It claims `Closes` on twelve (#49, #50, #52–#61), says "Advances #51", and says
"#62 remains open". The PR's own operations doc
(`docs/document-intake-operations.md`, "Pre-existing defects found") disagrees
with the body on #62 and says it *is* fixed on this branch. The diff agrees with
the doc, not the body.

Verdicts, with the code that decides each. **Closed** means the issue's stated
reproduction now behaves as the issue's "Expected" section says, and a permanent
test guards it.

| # | Verdict | What decides it |
|---|---|---|
| 49 | **Closed** | `document-text.ts:530` — `getDocumentProxy(bytes.slice())`. `test/document-text-bytes.test.ts` asserts `byteLength` and `contentDigest` unchanged after reading, for a typed PDF **and** a PDF with no text layer — exactly the two cases the issue named. |
| 50 | **Closed** | `poller.ts:1338-1341` defines one `commit` that calls `recordInterpretationResult` + `markInterpretationCommitted`, and every exit of `runDocumentPath`/`readDocumentsInto` calls it — `NO_SESSION` (1347), `NO_READABLE_DOCUMENT` (1361), `NOT_CONFIGURED` (1373), the failure path (1747), `SESSION_CLOSED` (1767), success (1862). Tests: "a redelivered upload costs nothing and says nothing new", "two files in one upload …". Both are DB-gated, and live in the file that now fails post-merge — the evidence has to be re-run, not re-read. |
| 51 | **Partially addressed — do not close** | The PR body says so honestly. Itinerary side done: `ITINERARY_DOCUMENT_BUDGET_CHARS = 60_000`, `ITINERARY_TRUNCATED_WARNING`, `documentPartial` to the organizer, per-unit coverage. Typed-message side **not** done: `INTERPRET_SOURCE_BUDGET_CHARS = 8_000` (interpret.ts:1103) is a named constant now, and `interpret.ts:1201` is still a bare `.slice()` with nothing told to the organizer. |
| 52 | **Closed** | `foldExtractedIntoPhases` merges by date, held day wins, result sorted. Reproduced against the branch: the issue's exact input gives `daysAdded: 2`, dates `["2026-09-19","2026-09-20","2026-09-21"]`, and the held 09-19 day keeps its own content. `itineraryCoverageComplete` (answer-merge.ts:587) replaces the "every phase has a day" check. |
| 53 | **Closed** | `workbookFormats` parses `xl/styles.xml` `numFmts`/`cellXfs`; `date1904` read from `workbookPr`; `serialToIsoText` handles the 1900 phantom leap day and the 1904 system; `columnIndex` places cells by reference; a `<f>` with no cached `<v>` counts as unread. `test/xlsx-dates.test.ts`, 4 tests, green. |
| 54 | **Closed** | Identity and merge moved into the new, **import-free** `answer-merge.ts`; `matchEntry` returns `{kind:"ambiguous", candidates}` and the gate reports it (`interpret.ts:926, 938`). Reproduced: the issue's two-Tokyo case now merges **nothing** and reports one ambiguity with `candidates: 2`. |
| 55 | **Closed in code; the issue's named test is missing** | `isoDateProblem` (interview.ts:281) wired to `phases` and `travel_anchors` via `checkComplete`. Reproduced: `validateAnswer("phases", …, [{name:"Rome", start:"2 May", end:"6 May"}])` → `INCOMPLETE_ANSWER`, detail "phases[0].start must be a date written YYYY-MM-DD"; the ISO form passes. The issue asked for a `validateAnswer` test on exactly this pair — there is none in `interview.test.ts`. One assertion away from closed with a guard. |
| 56 | **Partially addressed** | The prompt rules exist (`interpret.ts:1355-1361`: "A STOP'S DATES come only from something that states the stay", "A FLIGHT is not a stop"). Neither piece of evidence the issue required exists at this revision: (a) no unit test asserts the prompt carries the stop-date rule — I grepped `control-plane/api/test` for the rule text and found only a row in the operations doc; (b) the acceptance evidence (`docs/test-reports/document-intake-real-booking-folder-2026-09-13.md`, and the 3-rep benchmark) was measured on `feat/document-intake` at base `e9c2d84`, not on this branch. The issue itself warns the fix "changes the prompt's hash, which on that branch is part of the stored-reading key" — so a benchmark from another revision does not describe this prompt. |
| 57 | **Closed** | `extractText(pdf, { mergePages: false })` (document-text.ts:533), per-unit `coverage` with `PAGE_USABLE_CHARS`, `documentPartial` said **before** the recap (poller.ts), vision routing for wholly text-less PDFs when `VISION_RUNNER` is set. `test/document-coverage.test.ts`. |
| 58 | **Partially addressed — and the remaining gap is the security half** | See §2. The tool-disabling half is done and is startup-verified; the environment half is not, and the test that claims it is does not assert it. |
| 59 | **Closed** | `parseDataJson` (interpret.ts:101) scans the first complete JSON value, string- and escape-aware, and accepts only when the remainder is `^[\s\]}]*$`. `test/parse-data-json.test.ts` covers all five cases the issue listed, including "brackets inside strings do not end the value" and "trailing content is not noise". |
| 60 | **Closed** | `model-runner.ts:856-857` returns `UPSTREAM_ERROR` with `finish_reason` in the detail; `worthRetrying` already includes `UPSTREAM_ERROR`. `test/openrouter-empty-completion.test.ts` asserts `attempts: 2`, `models == ["minimax/minimax-m3","minimax/minimax-m3"]` ("never another model"), and the exhausted case ending `UPSTREAM_ERROR` after the attempt budget — precisely the issue's required tests. |
| 61 | **Closed** | `documentNothingNew` in both languages (intake-copy.ts:388, 571); the branch keys on `NO_NEW_INFORMATION \|\| ALREADY_ANSWERED` (poller.ts:1882-1888). Test named in `document-intake-flow.test.ts`. |
| 62 | **Substantially addressed — the PR body is wrong about this one** | The `travel_anchors` prompt is widened to "flights, trains, hotels, cars, tickets or tours" (interview.ts:525) with a comment citing #62; base `f478694` still had "Any flights, hotels, or cars already booked?". The operations doc says N is fixed. The round-trip test the issue asked for already exists (`worker/tests/test_transformer.py:1326`, `test_document_handoff.py:148`, `test_provisioner.py:412` — an `attraction` anchor reaching `bookings`). What is genuinely absent is a golden-fixture expectation that an *extracted* booked ticket yields an anchor with its reference. |

**The traps, stated plainly.**

- **#62 is the expensive trap.** The PR body tells a reader it is open. It is
  not. Anyone who picks #62 up and rewrites the `travel_anchors` prompt will
  produce a conflicting prompt change against a file this PR already rewrote,
  and a prompt change is not something two branches can both own — it is part of
  the stored-reading key.
- **#56 is the quiet trap.** It looks closed (the rule is in the prompt) and its
  acceptance evidence is one revision stale. If somebody reads the operations
  doc's "0 conflicts on multi" and treats that as this branch's behaviour, they
  are reading a measurement of different code.
- **#58 is the dangerous trap.** It is marked `Closes` and has a green test
  named "…and carries no relay secrets". It does not carry no relay secrets.

---

## 2. The #58 overlap: PR #91 vs PR #92

**They are not duplicates. They are complementary, and each has one half the
other lacks — but the half PR #92 is missing is the security half.**

Both add the identical 22 `--disable` feature flags and the same four `-c`
overrides (`mcp_servers={}`, `plugins={}`, `apps={}`,
`shell_environment_policy.inherit="none"`). Beyond that they diverge:

| | PR #91 `fix/58-codex-runner-isolation` | PR #92 `feat/document-intake-sprint6` |
|---|---|---|
| Child environment | `codexChildEnv()` — an **allowlist**: PATH, HOME, CODEX_HOME, XDG_CONFIG_HOME, TMPDIR/TMP/TEMP, LANG/LC_*, SSL_CERT_*, NODE_EXTRA_CA_CERTS | `hermeticEnv()` — a **denylist**: everything except `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT` |
| `--ignore-user-config` | **yes** — "no config.toml can re-enable a tool" | **no** |
| Startup verification | none | `codexIsolationProblem()` runs `codex features list` at relay boot; on a mismatch it sets `KINERARY_CODEX_ISOLATION_UNVERIFIED=1`, and `runnerForBinding` then returns `undefined` for codex — an unverified codex is no binding at all |
| Test asserts secrets are stripped | **yes**, on `KINERARY_TEST_SECRET`, `OPENROUTER_API_KEY`, `CONTROL_PLANE_DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, and on the whole inherited key list | **no** |

**Measured, not inferred.** I ran each branch's real `codexRunner` against a fake
`codex` binary that records its own environment, with `KINERARY_TEST_SECRET`,
`OPENROUTER_API_KEY` and `TELEGRAM_BOT_TOKEN` set in the parent:

```
PR #92 — child saw: { "secret": "must-not-reach-codex",
                      "openrouter": "sk-must-not-reach-codex",
                      "telegram": "123:must-not-reach-codex" }
PR #91 — child saw: { "secret": null, "openrouter": null, "telegram": null }
```

Issue #58's corrective change item 3 literally says "Spawn with the same scrubbed
environment the other CLIs use (`hermeticEnv()`)", so PR #92 followed the
issue's letter. But the issue's *regression test required* says "a variable set
in the relay's environment does not reach the child", and `hermeticEnv()` is a
denylist that cannot satisfy it. **PR #91 is right and the issue text is wrong.**

Worse, PR #92's test at `control-plane/api/test/codex-isolation.test.ts` is named
"every call disables the tool features, empties MCP/plugins/apps, **and carries
no relay secrets**". It sets `KINERARY_TEST_SECRET`, has the fake codex record
`process.env.KINERARY_TEST_SECRET` into its answer, types it in the `parse`
signature — and then writes `const { argv } = res.value;` and never asserts on
`secret`. The claim is in the test name and nowhere in the test body. That is
this repository's own bug class: a green test standing in for a check nobody
made.

And the exposure is not theoretical on this branch, because `compose.vm.yml` in
this same PR **makes codex the default for both document tasks**
(`EXTRACT_INTAKE_RUNNER: ${EXTRACT_INTAKE_RUNNER:-codex}`,
`EXTRACT_ITINERARY_RUNNER: ${EXTRACT_ITINERARY_RUNNER:-codex}`). Today the VM
runs the claude path, so `runCodexOnce` is cold. This PR turns it on for every
uploaded document at the same time as shipping the weaker isolation.

**Recommendation.** Land **PR #91** for #58. It is two files, 113 lines, its
test passes in 0.6 s, and it is strictly stronger on both the config and the
environment. Then **rebase PR #92 onto it** — not a revert: PR #92 keeps
`codexIsolationProblem()` and the `runnerForBinding` refusal, which PR #91 does
not have and which a codex-default deployment genuinely needs (codex *exits* on
an unknown feature name, so without the probe a codex CLI upgrade fails every
structuring call at call time instead of at boot).

The rebase is mechanical, because both branches export the same two symbol names
(`CODEX_ISOLATION_ARGS`, `CODEX_ISOLATION_FEATURES`) with the same contents:
take PR #91's `codexChildEnv` + `--ignore-user-config` + its test, keep PR #92's
`codexIsolationProblem` + `runnerForBinding` guard + its `features list` probe
test. Estimated 20 minutes plus one run of `test/codex-isolation.test.ts`.

---

## 3. Migrations against live rows

The four files are `0054_document_registry.sql`, `0055_answer_provenance.sql`,
`0056_model_task_settings.sql`, `0057_document_corrections.sql` (PR HEAD
numbering; the in-flight merge has already renumbered them 0055–0058).

| Migration | What it does to existing rows | compatible / breaking | `-- rollback:` header |
|---|---|---|---|
| `0054_document_registry` | Creates `trip_documents`, `trip_document_extractions`. **Touches an existing table**: three `ADD COLUMN IF NOT EXISTS` on `source_artifacts` — `document_id` (nullable FK), `filename` (nullable), and `received_at timestamptz NOT NULL DEFAULT now()`. | **compatible** — the `NOT NULL DEFAULT now()` is added, not imposed on a populated column, so Postgres 11+ rewrites nothing and every existing row gets `now()`. Nothing existing is dropped, narrowed or retyped. Older code never selects the new columns. | **ABSENT** |
| `0055_answer_provenance` | Two new tables only (`trip_answer_sources`, `trip_answer_conflicts`) with FKs onto `trips`, `trip_documents`, `trip_document_extractions`. No existing row is read or written. | **compatible** | **ABSENT** |
| `0056_model_task_settings` | Two new tables plus a `BEFORE UPDATE OR DELETE` trigger on the new history table only. The trigger is scoped to a table this migration creates, so it cannot fire on anything existing. | **compatible** | **ABSENT** |
| `0057_document_corrections` | One new table with FKs onto `trips` and `intake_versions`. No existing row touched. | **compatible** | **ABSENT** |

**All four are genuinely additive** — I read every statement. There is no `DROP`,
no `SET NOT NULL` on a populated column, no narrowed `CHECK`, no type change, no
backfill `UPDATE`, and no `UNIQUE` index over pre-existing data (every unique
index is on a table created in the same file). Against production-shaped data
they will succeed. The operations doc's claim "All additive" is correct.

**But the header is required and is missing on all four**, and that has a
concrete cost, not a stylistic one. `control-plane/deployment/vm-release.py:299`:

```python
kind, reason = declared if declared else ("breaking", "no `-- rollback:` header — treated as breaking")
```

`classify_migrations` returns `compatible` only if **every** migration above the
rollback target says so. So four honest, additive, `compatible` migrations that
forgot to say so will make `kinerary-cp-release rollback` classify the whole
upgrade as breaking — which means the way back is *restore the pre-upgrade
database dump*, losing every write since the deploy: every organizer message,
every interview answer, every new trip. That is the difference between a
two-minute code-only rollback and losing a day of a real organizer's work.

`test/migration-rollback.test.ts` catches this, and it is **red on both trees**:

- baseline `integration/sprint-6`: 4 undeclared — `0050_plan_reviews`,
  `0052_telegram_organizer_links`, `0053_companion_reply_capture`,
  `0054_companion_bug_reports` (pre-existing debt; the rule landed with PR #84
  after those files)
- merged with PR #92: **8 undeclared** — the same four plus this PR's four

So this is not a new red test, but PR #92 doubles the debt. Note also that
`migration-rollback.test.ts` **does not exist on the PR branch** — it arrived in
sprint-6 at `94e572d`, after the PR's merge-base `f478694`. The author could not
have seen it fail.

Fix cost: four lines, e.g.
`-- rollback: compatible — new tables plus nullable/defaulted columns on source_artifacts; older code reads none of them`.

**Expected noise, so a real failure is not waved through.** `migrations.test.ts`
asserts the literal ordered file list twice (fresh-install and upgrade). The PR
already updated both. After any renumber it must be updated again, and after the
merge it must also carry sprint-6's `0054_companion_bug_reports`.

---

## 4. The 0054 collision, and what a renumber costs

`0054` is currently claimed three ways:

| Claim | Where | State |
|---|---|---|
| `0054_companion_bug_reports.sql` | **merged** on `integration/sprint-6` (`37be82e`) | owns the number |
| `0054_document_registry.sql` … `0057_document_corrections.sql` | PR #92, based on `f478694` (before the above landed) | must move |
| `0054_organizer_invitations.sql`, `0055_one_organizer_per_address.sql` | PR #95 `feat/organizer-invite-links` → `integration/sprint-6`, open | must move |

**The correct renumbering.** `0054` is taken and is already on the integration
branch, so both open PRs renumber. Whoever merges first takes the next
contiguous block:

- **PR #92 first:** `0055_document_registry`, `0056_answer_provenance`,
  `0057_model_task_settings`, `0058_document_corrections` — which is exactly
  what the in-flight merge in the worktree has already done. PR #95 then becomes
  `0059_organizer_invitations`, `0060_one_organizer_per_address`.
- **PR #95 first:** `0055`/`0056` for the invite pair, and PR #92 becomes
  `0057`–`0060`.

Given §6's recommendation (split PR #92, ship the pure slice first, hold the
stateful slice for VM preparation), **PR #95 should take 0055/0056** and PR
#92's stateful slice should take `0057`–`0060`. That is one renumber for #95
and — importantly — **one more** for #92, its second.

**How dangerous is the collision itself? Less than it looks, and I want to be
precise rather than alarming.** `applyMigrations` (`migrations.ts:19`) keys on
**filename**, sorted, and records each in `control_plane_schema_migrations`. Two
files numbered `0054` with different names both apply, in alphabetical order
(`companion` < `document` < `organizer`). There is no data hazard and no
skipped migration. The repo already tolerates non-contiguous numbering:
`main` has `0051` and no `0050`, and when sprint-6 merges, `0050_plan_reviews`
will apply on production *after* `0051_trip_person_links` is already recorded.

So the collision costs legibility and test churn, not rows.

**What a renumber costs in redone testing.** This is the honest accounting:

| Cost | Detail | Minutes |
|---|---|---|
| `git mv` ×4 + update `migrations.test.ts`'s two literal lists | mechanical | 10 |
| **Re-run the DB migration path** — fresh install and upgrade must both still be green, and the upgrade path is the one that proves ordering | `npm run test:migrations` on a scratch DB, or the 7-file document DB set I timed | 1 min for `migrations.test.ts` alone; **48 s** for the whole document DB set (measured) |
| **Prose cross-references** — nothing tests these, so they only get fixed by hand | Already stale from the *first* renumber, at PR HEAD: `document-registry.ts:2` "(migration 0052)", `document-store.ts:8` "(0052)", `answer-provenance.ts:2` "(migration 0053)", `poller.ts:1487` "(0053)", `0055_answer_provenance.sql:3` "The registry (0052)", `scripts/teardown-trip.py` "migrations 0052, 0053", `docs/document-intake-operations.md:58` "migration 0055", `:181` "migration 0054". **Eight references already wrong; a second renumber moves them again.** | 20 |
| Nothing else | The feature code names tables, not migration numbers. No adapter, no worker query, no release seal depends on the number. | 0 |

**Total: about 30 minutes of hand work and ~1 minute of test time per renumber.**
The renumber is cheap; the *prose* is what rots, and it rots silently because no
check reads it. Recommendation: replace the "(migration 00NN)" comments with
table names in the same pass, so the third renumber costs nothing.

---

## 5. `0056_model_task_settings.sql` and `model-runner.ts` vs the upcoming instrumentation

**There is a collision, it is in `model-runner.ts` and not in the schema, and
this PR should go first — by a wide margin.**

What the upcoming work wants:

1. per-task model/cost instrumentation in `control-plane/api/src/model-runner.ts`
2. a model/runner column beside `duration_ms` in `interview_interpretations`

What PR #92 already does to `model-runner.ts` (+537 / −66, the largest source
change in the PR):

- adds `ModelUsage { inputTokens, outputTokens, totalTokens, costUsd, costKind }`
  and `addUsage()` to combine two calls
- threads usage out of **all four** backends: the claude CLI stream
  (`claudeStreamAnswer`, including cache-read tokens and `total_cost_usd` marked
  `costKind: "api_equivalent"` — a quota signal, not money), OpenRouter
  (`prompt_tokens`/`completion_tokens`/`cost`, `costKind: "billed"`), codex
  (total tokens), hermes
- surfaces it on `RunResult` beside `attempts` and `ms`, so every call already
  reports duration, attempt count and usage
- adds task-level binding resolution: `SwitchableRunner.effective(task)` returns
  `{binding: {runner, model}, source: "override"|"environment"|"none"}` — i.e.
  the runner already knows, per call, which runner:model actually served it

So **item 1 is essentially built.** Doing it separately first means writing it
twice and then reconciling two `usage` shapes inside a file one branch has
rewritten by 537 lines.

**Item 2 is untouched and does not collide with `0056`.**
`0056_model_task_settings.sql` creates `model_task_settings` and
`model_task_setting_history`; it does not go near `interview_interpretations`.
And PR #92 does **not** persist usage anywhere:
`recordInterpretationResult` (interpret.ts:1634) still writes only
`proposals, failure_reason, attempts, duration_ms`. The only place model identity
is persisted is `trip_document_extractions.provider/model` — document
extractions only. The only consumer of `usage` is the offline benchmark
`tools/extract-eval.ts`.

**Cheaper order, with reasons:**

1. **PR #92's model-runner work lands first.** Then the instrumentation work is
   two small additions rather than a rewrite: add `model`, `runner` and a usage
   column to `interview_interpretations` in a new migration numbered *after* this
   PR's block, and extend `recordInterpretationResult`'s parameter object and its
   one `UPDATE` to carry `result.usage` and `runner.effective(task).binding`.
   Both call sites (`poller.ts:1862`'s `commit`, and the text path) already have
   the `RunResult` in hand.
2. **The reverse order costs three things:** the instrumentation is rewritten on
   top of a 537-line rewrite; its migration lands *before* this PR's block and
   forces this PR into a **third** renumber; and two independently-designed
   usage shapes have to be merged in the one file where a mistake silently
   changes which model reads an organizer's documents.

One thing the upcoming work should inherit rather than invent: `costKind`. A
claude-CLI "cost" is an API-equivalent number on a subscription, not money spent.
An instrumentation table that stores a single `cost_usd` column without that
distinction will produce a spend report that is wrong for every claude task.

---

## 6. Land whole, or split

**Split. Three pieces.** The feature is good; the merge is not, and one of the
three pieces cannot be deployed at all until somebody does one-time work on the
VM that has not been done.

### The evidence for splitting

Merging PR #92 into `integration/sprint-6` today takes the control-plane suite
from **1 failing file to 11**, measured:

| Failing file | Baseline | Merged | What it is |
|---|---|---|---|
| `migration-rollback.test.ts` | fail (4 undeclared) | fail (8 undeclared) | §3 |
| `document-intake-flow.test.ts` | — | **fail** | "confirming records which documents the version was built from" → `NOT_ALL_REQUIRED_ANSWERED` |
| `interview.test.ts`, `interview-transcript.test.ts`, `interpret.test.ts`, `interpret-db.test.ts`, `relay-poller.test.ts`, `relay-dispatch.test.ts`, `dietary-scope.test.ts`, `document-suggestions.test.ts` | — | **fail** | interview/boundary/roster cluster |
| `intake-copy.test.ts` | — | **fail** | `correctionChange.answered` is identical in `en` and `he` |
| `group-document-to-plan.integration.test.ts` | cancelled | cancelled | pre-existing flake — "Server exited with code 1 before becoming ready" |

The root of the big cluster is a genuine semantic conflict, and I traced it:
sprint-6 (`e2ff4c8` "name the organizer from the roster", `ff522e4`
"natural-language boundary replies") introduced `isAnswered(q, answers)` and
`IntakeQuestion.satisfiedBy` — `organizer_identity` now requires
`organizerMatch(answers).kind === "matched"`, and `return_date` requires
`datesInOrder`. Neither exists on PR HEAD (`isAnswered` appears 0 times there,
11 times after the merge). PR #92's fixtures fill required questions with
`{kind:"text", text:"filler"}`, which used to satisfy them and no longer does.
That is a fixture problem, not a product problem — but it is 10 files' worth of
it, and every number in the PR body was measured *before* this merge existed.

`intake-copy.test.ts` is the one real product defect the merge exposes:
`correctionChange.answered` is `"• {question}: {value}"` in both languages, and
sprint-6's new copy test refuses identical strings ("a key added to both sides
and translated in neither"). Here it is a pure template with no words, so the
right fix is one entry in `SHARED_BY_DESIGN`, not a translation.

### The proposed split

**Slice A — reader, parser and gate. No schema, no new surface, no VM work.**

Files: `document-text.ts`, `itinerary-extract.ts`, `interpret.ts` (parse + gate +
prompt), `interview.ts` (`isoDateProblem`, `travel_anchors` prompt),
`answer-merge.ts`, `answer-provenance.ts`'s pure half, `model-runner.ts`'s
OpenRouter branch, plus the 18 non-DB test files.

Closes #49, #52, #53, #54, #55, #59, #60, #62; advances #51, #56.

The enabling fact: **`answer-merge.ts` has zero imports.** It is 662 lines of
pure functions — no database, no model, no clock — so #52's `itineraryCoverageComplete`
and #54's `matchEntry`/`reconcileStructured` ship without the registry, the
store, the migrations or the worker. The gate reports conflicts and ambiguities
in memory; only *persisting* them needs a table.

Blast radius: control plane, every organizer mid-interview, at relay restart.
No migration, so nothing is one-way.
**Test cost: 4.7 s measured** for its 132 tests, plus the full control-plane
suite to prove nothing else moved.

**Slice B — durability and reconciliation. The feature.**

Files: `document-registry.ts`, `document-store.ts`, `document-intake.ts`,
`document-correction.ts`, `document-vision.ts`, `document-sweeper.ts`,
`model-task-settings.ts`, the four migrations, `relay/poller.ts`'s document path,
`relay/dispatch.ts`, `chat-router.ts`, the worker's `document_handoff.py` and
`provisioner.py`, `scripts/teardown-trip.py`, `compose.vm.yml`.

Closes #50, #57, #61.

Cannot deploy to the VM until the one-time NFS work is done (§7). Needs its own
DB rehearsal and its own acceptance run.

**Slice C — the trip site's document routes.**

Files: `server/server.js`, `tests/trip-documents.test.js`,
`provisioning/adapters.py`.

This is the only part that touches `PAYLOAD_ROOTS`, so it is the only part that
**needs a new release** and a per-trip redeploy to reach anybody. It is also a
new authenticated route serving organizer-supplied bytes on the trip origin, so
it goes to `boundary-reviewer` with real request/response evidence, not a test
name.

Slice C depends on Slice B (there are no documents to serve without the
registry and the provisioner hand-off), so it ships after — but it is worth
reviewing separately because its risk is of a completely different kind.

### What batches, and what must be tested alone

**Batches onto one run.** Slice A's ten defects are all observable in one
interview walk with the golden `multi` document set: they touch disjoint code
(a PDF reader, an xlsx reader, a JSON decoder, a merge engine, a validator, two
prompts) and every one of them shows up in the same recap. One walk, ten
answers, with a numbered checklist naming which defect each check belongs to.

**Must be isolated, with why:**

| Item | Why it cannot ride along |
|---|---|
| **#58 / codex isolation** | Security path. Needs its own request/response — here, its own recorded child-process argv and environment. "It came up in the e2e run" proves nothing about a flag. And PR #91 vs #92 must be compared on the same fake binary, which is a 0.6 s test, not an 80-minute walk. |
| **The four migrations** | One-way (no down migrations). Rehearse alone against a restored production-shaped copy, with the snapshot named first. |
| **#56 (prompt stop-date rules)** | Non-deterministic — a model in the loop. One green run is one sample. The issue itself asks for ≥3 repetitions per provider on `multi`. Needs `tools/extract-eval.ts`, not the e2e walk. |
| **#52 and #54 against each other** | Both change what the site shows for a stop. A single green walk cannot say which one worked. They are cheap to separate: both have deterministic unit reproductions (I ran them), so isolate at the unit level and let them share the walk. |
| **Slice C's auth** | `authRequired` is not an organizer check. A new route serving uploaded bytes needs `boundary-reviewer`. |
| **The `/model` command** | A new super-admin runtime surface that changes which model reads every organizer's documents. Gated correctly (private chat + `digestTelegramId(from.id) === superAdminSubjectDigest`, derived server-side), but it is an authorization decision and belongs with the security pass. |
| **The correction-approval button** | Approving a correction calls `provisionOnConfirm` on an **already-confirmed** trip — a Telegram tap that redeploys a live family's site. Deserves its own deliberate test on a trip nobody is on. |

**Deserves *more* than one run:** anything with a model in it — #56's prompt,
the document extraction path as a whole, the vision reader. Say three runs per
scenario, not one.

---

## Change set

| Item | Branch → base | Files | State |
|---|---|---|---|
| **PR #92** "feat(intake): make uploaded documents durable and reconcilable" | `feat/document-intake-sprint6` → `integration/sprint-6` | 79 files, +13,388 / −476, 5 commits (`a7c4518`, `70c442e`, `ad11c19`, `9ce8a02`, `1696615`) | open, **CONFLICTING** |
| PR #91 "fix(model-runner): isolate Codex from untrusted input" | `fix/58-codex-runner-isolation` → `integration/sprint-6` | 2 files, +113 / −1 | open, overlaps #58 |
| PR #95 "Invite an organizer…" | `feat/organizer-invite-links` → `integration/sprint-6` | 29 files incl. `0054_organizer_invitations.sql`, `0055_one_organizer_per_address.sql` | open, migration collision |
| Integration target | `integration/sprint-6` @ `37be82e` | carries `0054_companion_bug_reports.sql`, `migration-rollback.test.ts`, the 38000+ test-port move | — |

PR #92's merge-base with `integration/sprint-6` is `f478694`. Sprint-6 has moved
40 commits since, including `94e572d` (release rollback + the rollback-header
rule), `03b0cf1`/`5f7ef6a` (test ports off 3100–3999), `e2ff4c8` (organizer
roster), `ff522e4` (natural-language boundary), `47c99eb` (per-task Claude
effort in `model-runner.ts`), `f7a117e` (group attachments in `poller.ts`).
Every one of those touches a file PR #92 rewrites.

---

## Risk table

| Change | Surface (§2 of the planner's table) | Blast radius | Migration | Compat break | Risk | Test | Min | Batch? |
|---|---|---|---|---|---|---|---|---|
| `compose.vm.yml`: `${KINERARY_NFS_ROOT:?…}` ×2, `DOCUMENT_STORE_REQUIRED=1` | VM redeploy | **Whole control plane down** if unset | — | **yes** | **Highest** | manual pre-flight on the VM; §7 | 15 | isolated |
| `compose.vm.yml`: codex becomes the default for both document tasks | VM redeploy | every uploaded document | — | behaviour | **High** (with §2's env gap) | codex-isolation test + one document walk | 10 | isolated |
| `relay/poller.ts` +879/−122 | relay restart | every live Telegram conversation | — | — | High | full CP suite + one interview walk | 6.5 + walk | batch |
| `model-runner.ts` +537/−66 | relay restart | every model call on every task | — | — | High | `codex-isolation`, `model-runner*`, `openrouter-*` | 1 | isolated (security) |
| 4 migrations, additive, **no rollback header** | applied on API boot | everyone, one-way | **yes** | rollback classification | **High** | `migrations.test.ts` + `migration-rollback.test.ts` + rehearsal | 1 + rehearsal | isolated |
| `interview.ts` `isoDateProblem` (#55) | VM redeploy | every structured answer | — | **tightens validation** — a live session holding a non-ISO phase date can no longer confirm | Medium | `validateAnswer` unit test (missing) | 2 | batch |
| `answer-merge.ts` (#52/#54) | VM redeploy | every document and multi-slice answer | — | — | Medium | 132-test unit set | 0.1 | batch |
| `interpret.ts` prompts (#56, #62) | relay restart | every extraction, non-deterministic | — | prompt hash is part of the stored-reading key | Medium | `extract-eval --scenario multi` ×3/provider | 30+ | isolated |
| `document-text.ts` (#49/#53/#57) | relay restart | every uploaded file | — | — | Medium | `document-text-bytes`, `xlsx-dates`, `document-coverage` | 0.1 | batch |
| `chat-router.ts` + `dispatch.ts`: conflict/correction callbacks, `/model` | relay restart | organizer chats; `/model` = super admin only | — | — | Medium | boundary-reviewer | own pass | isolated |
| correction approval → `provisionOnConfirm` | relay restart | **redeploys a confirmed trip's site from a Telegram tap** | — | — | **High** | deliberate test on an unoccupied trip | 20 | isolated |
| `server/server.js` `/api/trip-documents` + `.xlsx/.png/.jpg/.webp/.gif/.txt` content types | **release** → provision or redeploy | new trips only until each live trip is redeployed | — | new release required (`artifactDigest` over `site,server,shared`) | Medium | `tests/trip-documents.test.js` + boundary-reviewer | 1 + pass | isolated |
| `provisioning/adapters.py` `TRIP_DOCUMENTS_DIR` | worker → new provisions only | new trips | — | **only written when `.env` does not exist** — existing trips rely on the `DATA_DIR`-basename fallback | Medium | verify on one existing trip | 5 | isolated |
| `worker/document_handoff.py`, `provisioner.py` | VM redeploy | trips being provisioned only | — | worker refuses to start if store required and not ready | Medium | worker suite | 2 | batch |
| `scripts/teardown-trip.py` | nothing until run | operators | — | — | Low | `tests/scripts` | 1 | batch |
| `tests/helpers/ports.js` 3121/3122 | nothing | — | — | **conflicts with the merged 38000+ move** | Low — `assertClearOfTripBridges()` fails loudly at import; already resolved in the in-flight merge | trip-site suite | 1 | batch |

---

## Migration and compatibility findings beyond SQL

**Release seal.** `server/server.js` is under
`PAYLOAD_ROOTS = ["site", "server", "shared"]` (`release-artifact.ts:24`,
mirrored in `release_source.py:23`). Slice C therefore requires a **new release**
— candidate → verified → available — before any trip can get it, and the worker
re-verifies the tree against `artifactDigest` before deploying. A stale digest
fails the provision loudly, which is the right failure, but it fails it at
provision time.

**Intake schema.** Not bumped. `INTAKE_SCHEMA_VERSION` is unchanged (the
reproduction above returned `schema_version: 3`), so no
`release_accepts_intake_schema_vN` migration is needed and `planner.ts`'s
`data_schema_min/max` window is untouched. Good — this was the obvious place for
a silent "planning finds no release".

**Two producers, one shape.** The document path now writes `phases[].days[]`
through `foldExtractedIntoPhases` **and** `phases[].planned` /
`travel_anchors[]` through the gate, into the same answer store the agentless and
agent paths write. The tests exercise the agentless/interpret path. The agent
path is not exercised by any test in this PR. Say which path a run exercised.

**`trip.config.json` / `.env` drift.** `provisioning/adapters.py` writes
`TRIP_DOCUMENTS_DIR` only inside `if [ ! -f {app_dir}/.env ]`, so **no existing
trip ever gets the variable**. `server.js` covers this with a fallback that
derives the directory when `path.basename(DATA_DIR) === 'server-data'` — which
holds for every trip this adapter provisioned. Whether it holds for the two
legacy hand-provisioned trips is not determinable from this repository.

**Content types.** `.html` is deliberately left out of the map so a saved booking
page falls through to `application/octet-stream`; `X-Content-Type-Options:
nosniff` is set, so it downloads rather than executing on the trip origin. The
reasoning is sound and the test `'a saved web page is a download, never a page
on the trip origin'` exists. It still wants live evidence, because it is an XSS
boundary on a session-bearing origin.

**Fail-safe defaults.** Nothing in `shared/needs-schema.js` or
`shared/agent-schema.js` changes. Not a visibility-resolution risk.

---

## Live-fleet impact — NOT CHECKED this run

**No production access was used, by instruction. Provisioning is currently ON on
the VM for a real organizer, and there is no approval for a production touch.**
Do not read the section below as a clean result; it is a list of what somebody
has to establish before this deploys.

What has to be read off production, and why each one changes the plan:

1. **The trip list and lifecycle states.**
   `SELECT slug, lifecycle_state, updated_at FROM control_plane.trips ORDER BY updated_at DESC;`
   Cheapest correct route: the fleet monitor's read-only MCP,
   `.agents/skills/trip-fleet-monitor/fleet-mcp.mjs --tool list_trips` — it holds
   the connection and opens it read-only via `PGOPTIONS`, so no shell on the box
   is needed. Anything at `ready_private` or beyond has real people on it;
   `teardown-trip.py` and `fresh-interview.py` both refuse past that line and so
   must any test proposed here.
2. **Which release each live trip is pinned to.** A control-plane change reaches
   *every* live trip at once, including one running a release from weeks ago. The
   relay's new document path and the new callback kinds have to be compatible
   with the **oldest release still running**, not with `main`.
3. **Whether any trip is running right now.** A trip mid-holiday is the strictest
   case. `shift-trip-dates.py` refuses to move one; nothing in this plan may
   touch one either.
4. **Whether a conversation is live before restarting the relay.** A relay
   restart under `awaiting = 'machine'` drops the turn.
   `vm-relay-restart.sh` (not `scripts/relay-restart.sh` — that one restarts the
   Mac's) refuses within five minutes of one. Schedule around conversations.
5. **Whether the VM even has the NFS export mounted, and whether `vm.env` sets
   `KINERARY_NFS_ROOT`.** This is the deploy-blocking one — see §7.
6. **Whether the VM's `codex` CLI knows all 22 isolation feature names.** If it
   does not, this PR's `codexIsolationProblem()` sets
   `KINERARY_CODEX_ISOLATION_UNVERIFIED=1` and `runnerForBinding` returns
   `undefined` for codex — and since `compose.vm.yml` in this PR makes codex the
   *default* for both document tasks, the result is that **every uploaded
   document becomes unreadable**, quietly, with only a startup log line to say
   so. That is the silent-downgrade bug class this repo already pays for with
   `INTERPRET_PATH_DEFAULT` and `NOT_CONFIGURED`.

**What has to be redeployed for a fix to actually reach anybody.** Slices A and B
are control-plane: one VM redeploy and they reach everyone at restart. Slice C
is a release: new trips get it at provision, and **every existing live trip keeps
its pinned release until somebody redeploys it**, per trip, with a named decision
— the same asymmetry that left the two live sites on the old upload-auth code
while new trips got the fix (PR #86, 2026-09-17).

---

## The plan

Ordered. Each line has its command, what to look at, its minutes and who has to
be there. Nothing here deploys; that is the human's call.

### Tier 0 — before anything else (25 min, one engineer, no deploy)

| # | Do | Command | Look for |
|---|---|---|---|
| 0.1 | Add the four `-- rollback: compatible — …` headers | edit | `npm run test:migrations` green; `migration-rollback.test.ts` down from 8 undeclared to 4 |
| 0.2 | Add the one missing assertion to PR #92's isolation test | `assert.equal(res.value.secret, null)` | it **fails** — that is the point; confirms the leak |
| 0.3 | Decide #58: PR #91 or PR #92 (§2) | — | a decision, not a test |
| 0.4 | Fix `correctionChange.answered` | add to `SHARED_BY_DESIGN` in `intake-copy.test.ts` | `router copy` green |

### Tier 1 — the gate. Nothing merges without these (≈8 min machine, 1 engineer)

| # | Run | Command | Minutes |
|---|---|---|---|
| 1.1 | PR's own non-DB set | `node --import tsx --test --test-concurrency=1 test/{answer-merge,document-*,xlsx-dates,parse-data-json,model-*,openrouter-*,itinerary-budget,gate-reconcile,codex-isolation}.test.ts` | **0.1** (measured: 4.7 s, 132 tests) |
| 1.2 | Full control-plane suite, **private** scratch DB | `CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:5434/cptest_<yourtag>" node --import tsx --test --test-concurrency=1 --test-timeout=300000 test/*.test.ts` | **6.5** (measured) |
| 1.3 | Trip-site suite | `cd tests && npm test` | ~1 (PR body: 476/476) |
| 1.4 | Worker suite | through the preflight venv | ~2 (PR body: 395/82) |

**Do not use `cptest`.** It is shared between sessions and two runs at once
corrupt each other; a 42P01 on `schema_migrations` mid-`applyMigrations` means
somebody else reset it. Use your own name; the guard in `test/support/test-database.ts`
only requires the name to contain "test".

**On reading 1.2's result.** The trip-site suite is flaky at concurrency 4 (a
different single test each run, 2026-09-18). The control-plane suite at
concurrency 1 is not — the baseline I measured had exactly one deterministic
failure and one known server-startup flake
(`group-document-to-plan.integration.test.ts`, "Server exited with code 1 before
becoming ready"). So a red file in 1.2 is real. Re-run it alone before costing
a fix; never raise the timeout.

**Acceptance for Tier 1: 1.2 must return to the baseline's failure set**, i.e.
`migration-rollback` only (and green after 0.1). Any of the other ten files still
red is a blocker.

### Tier 2 — the isolated items (≈60 min machine, 1 engineer + a reviewer)

| # | Run | What it proves | Minutes |
|---|---|---|---|
| 2.1 | `test/codex-isolation.test.ts` on the chosen #58 implementation, with the secret assertion added | no relay secret reaches the child; every flag present; no bypass flag | 1 |
| 2.2 | `boundary-reviewer` pass | `/api/trip-documents` under `authRequired` with real request/response; traversal refused; `.html` downloads not renders; `/model` reachable only by the super admin; the correction callback refuses a foreign chat and a foreign sender | own pass |
| 2.3 | `tools/extract-eval.ts --scenario multi`, **3 repetitions per provider**, on *this* revision | #56: 0 invented conflicts, expected stop dates, and that the benchmark describes this prompt rather than `e9c2d84`'s | 30 |
| 2.4 | Migration rehearsal against a restored production-shaped copy | the four migrations apply to real rows; `source_artifacts.received_at NOT NULL DEFAULT now()` on a populated table | 20 |

### Tier 3 — acceptance walk, after a deploy decision (≈80 min + a person)

One batched run, `scripts/preflight-deploy.sh --deploy --auto --scenario all --cleanup`
(hard rule 2 — a human's decision, not mine), with this checklist as it goes:

1. A PDF with a text layer: its stored digest equals the upload's → **#49**
2. Re-send the same file: no second model call, no repeated recap → **#50**
3. A two-page PDF, page 2 a scan: "partly read" said before the recap → **#57**
4. An .xlsx with date-formatted cells: ISO dates in the recap, not serials → **#53**
5. A ticket-only upload: no one-day stop invented; a flight makes no stop → **#56**
6. A document repeating held facts: "nothing new", not "nothing about the trip" → **#61**
7. A trip returning to one city, undated hotel: one ambiguity asked, nothing merged → **#54**
8. A second document adding days to a stop that already has one: they appear → **#52**
9. A booked e-ticket: an `attraction` anchor **with its reference**, not a `planned` name → **#62**
10. A non-ISO date from a document: refused with a named field, never stored → **#55**

### Tier 4 — only for Slice C (after a release)

Per-trip redeploy decision, named trip by trip. `/api/trip-documents` and the
confirmation route verified on one redeployed trip with a real member token.

---

## Budget

| Tier | Buys | Cost |
|---|---|---|
| **0 + 1 — the minimum gate** | The merge is actually done; the four migrations declare themselves; the control-plane suite is back to baseline; the secret leak is either fixed or visible | **~35 min**, 1 engineer, no deploy |
| **+2** | The security path has evidence instead of a test name; the prompt claim is measured on this revision; the migrations are rehearsed against real rows | **+60 min**, 1 engineer + `boundary-reviewer` |
| **+3** | The ten defects are proven end to end on the real path, once, in one walk | **+80 min** and a person present |
| **+3 ×3** | Enough samples to say anything about the non-deterministic half | **+240 min** |
| **+4** | Slice C actually reaches a live trip | a release + a per-trip decision |

**If you buy only one tier, buy Tier 0+1.** Without it you are merging a branch
whose own test suite is red in ten files nobody has looked at.

**Tier 3 is the only thing that proves the document path end to end.** Skipping
it is a choice to find out in a real organizer's interview — which, given
provisioning is on for one right now, is a live conversation.

---

## Go / no-go, and the way back

**Stop conditions — any one of these blocks the deploy:**

1. **`KINERARY_NFS_ROOT` is not set in the VM's `vm.env`.** `compose.vm.yml` now
   uses `${KINERARY_NFS_ROOT:?…}` in **two** places. Unset, `docker compose`
   fails to parse the file and **the entire VM stack does not come up** — API,
   worker, relay, every bound chat, every organizer mid-interview. This is not a
   degraded feature; it is the control plane down.
2. **The NFS export is not mounted on the VM, or the marker file is missing.**
   `DOCUMENT_STORE_REQUIRED: "1"` is set for both the relay and the worker. The
   relay calls `process.exit(1)` (`relay/server.ts:255`) and the worker raises
   `ValueError("document store not ready …")` (`__main__.py`) unless the
   directory exists, carries `.kinerary-document-store`, accepts a probe write,
   and sits on its own mount. The one-time setup is in
   `docs/document-intake-operations.md` and the doc itself says **"Not verified
   on a real NFS mount"**.
3. **The control-plane suite is not back to its baseline failure set** (§ Tier 1).
4. **The four migrations still have no `-- rollback:` header** — because that
   alone converts the way back from "redeploy the previous image" into "restore
   the dump and lose every write since".
5. **The VM's `codex` does not know all 22 isolation features**, while
   `compose.vm.yml` makes codex the default for both document tasks.
6. **#58 is unresolved between PR #91 and PR #92.**
7. **An interview is live** (`awaiting = 'machine'` within five minutes) when the
   relay restart is due.

**The snapshot, taken first:** `sudo kinerary-cp-release upgrade --dry-run`,
then the real upgrade, which snapshots the VM from the Proxmox host (never
vzdump, never NFS), dumps the database and records the way back. Never
hand-edit `KINERARY_REV`.

**The way back:**

- **Code:** `sudo kinerary-cp-release rollback` → redeploy the previous image.
- **Schema:** keep the tables — all four are additive, `source_artifacts`'s new
  columns are nullable or defaulted, old code reads none of them. **But** with no
  `-- rollback:` header, `vm-release.py` will classify the set as `breaking` and
  will not offer the keep-the-newer-database path. Fix the headers before
  deploying and this is a two-minute rollback; deploy without them and it is a
  dump restore.
- **Storage:** unset `DOCUMENT_STORE_REQUIRED` to start without the store;
  originals already written stay on the export.
- **Models:** `/model <task> default`, or
  `DELETE FROM control_plane.model_task_settings`.
- **Not reversible by redeploy:** any `trip_document_corrections` already
  approved has created a real `intake_versions` row and may have re-provisioned a
  live site. Intake versions are immutable by design.

---

## What would reduce the risk, ranked by risk removed per minute

1. **Add one line to PR #92's `codex-isolation.test.ts`: `assert.equal(res.value.secret, null)`.**
   *1 minute.* The value is already captured by the fake binary and already typed
   in the `parse` signature — it is destructured away on the next line. Today the
   test's name asserts something its body does not check. This one line turns the
   repository's worst failure mode (a green test standing in for an unmade check)
   into a red one. Highest ratio in this document by a wide margin.
2. **Land PR #91 for #58 and rebase PR #92 onto it.** *20 minutes.* Measured:
   PR #91 keeps `OPENROUTER_API_KEY` and `TELEGRAM_BOT_TOKEN` out of the child;
   PR #92 does not. PR #91 also adds `--ignore-user-config`, which matters
   precisely because PR #92 deliberately keeps the login's own `CODEX_HOME` —
   the one place a `config.toml` could re-enable a disabled tool. Keep PR #92's
   `codexIsolationProblem()` startup probe; PR #91 has nothing like it.
3. **Write the four `-- rollback: compatible — …` headers.** *4 minutes.* All
   four migrations genuinely are compatible; they just do not say so, and
   `vm-release.py` fails safe to `breaking`. Four lines convert the rollback
   from "restore the dump, lose a day" to "redeploy the previous image".
4. **Make `KINERARY_NFS_ROOT` default rather than `:?`-required, or land the VM
   setup as its own change first.** *10 minutes to decide.* As written, one
   unset variable in `vm.env` stops the whole stack from parsing its compose
   file. Either give it a default and let `DOCUMENT_STORE_REQUIRED`'s
   readiness check produce the (clear, logged) failure, or do the mount + marker
   + `vm.env` edit as a separate, verified change **before** the code that
   depends on it.
5. **Fix the ten merge-broken test files before review, not after.** *~60
   minutes.* Almost all of it is one fixture change: PR #92's tests fill required
   questions with `{kind:"text", text:"filler"}`, and sprint-6's
   `IntakeQuestion.satisfiedBy` now requires `organizer_identity` to match the
   roster and `return_date` to be in order. A reviewer cannot hold a
   13,000-line diff *and* work out which of 24 failures are real.
6. **Split into Slices A / B / C (§6).** *A day of branch surgery.* Slice A —
   ten of the fourteen defects — has no migration, no new surface, no VM
   prerequisite, and a 4.7-second test set. It can ship this week. It is held
   hostage today by an NFS mount that does not exist yet.
7. **Add the one `validateAnswer` test #55 asked for.** *5 minutes.* The fix
   works (I reproduced it), but nothing guards it, and it lives in `checkComplete`
   — a hook that is easy to drop in a refactor.
8. **Add a prompt unit test for #56.** *5 minutes.* Assert
   `buildExtractIntakePrompt(...)` contains the stop-date-evidence rule and the
   flight rule. A prompt line is the easiest thing in this diff to lose silently,
   and its hash is part of the stored-reading key.
9. **Re-run the #56 benchmark on this revision.** *30 minutes.* The existing
   acceptance evidence measures `feat/document-intake` at base `e9c2d84`.
10. **Replace the "(migration 00NN)" comments with table names.** *20 minutes.*
    Eight are already wrong after one renumber, and there is at least one more
    renumber coming. Nothing tests prose.
11. **Update the PR body's issue list to match the diff** — #62 is addressed,
    #56 is partial, #58 is partial. *5 minutes.* A wrong `Closes` line is how
    two people do the same work, or nobody does the remaining half.
12. **Persist `usage` and the effective `runner:model` on
    `interview_interpretations` in this PR rather than a later one.** *~1 hour.*
    The values already exist on `RunResult`; `recordInterpretationResult` is one
    `UPDATE`. Doing it here avoids a later migration that forces a third renumber
    and a second `usage` shape (§5).

**And what *not* to do:** do not ask for a bigger e2e. The e2e walk is already
the expensive resource here, and none of the twelve items above needs it.

---

## Decisions needed — nothing guessed

1. **#58: PR #91 or PR #92?** My recommendation is PR #91's environment and
   `--ignore-user-config`, plus PR #92's startup probe. Somebody has to choose,
   because both PRs export the same symbol names.
2. **Does the VM have the NFS export mounted, and does `vm.env` set
   `KINERARY_NFS_ROOT`?** Not determinable without production access. If not, this
   PR cannot deploy at all — see stop conditions 1 and 2.
3. **Does the VM's installed `codex` know all 22 isolation feature names?** Not
   determinable here. If not, and codex is the default, every uploaded document
   becomes unreadable with only a log line.
4. **Should `compose.vm.yml` really default both document tasks to codex?** The
   benchmark supporting that choice (codex ~16 s/doc vs claude ~70 s, equal
   accuracy) was measured on a different revision, and it is the runner with the
   isolation gap.
5. **Merge order between PR #92 and PR #95, and therefore who takes 0055/0056.**
6. **Is a Telegram tap an acceptable trigger for re-provisioning a confirmed,
   live trip's site?** `applyCorrectionCallback` → `approveCorrection` →
   `provisionOnConfirm`. The authorization is sound in shape (proposal's own
   chat, sender == chat, still the trip's confirmed interview chat), but the
   consequence is a live-site redeploy, and there is a standing note that an
   organizer's chat can be retargeted to a newer trip.
7. **Do the two legacy hand-provisioned trips have
   `path.basename(DATA_DIR) === 'server-data'`?** If not, Slice C's document
   route silently returns `[]` on them.
8. **Is `authRequired` (family JWT *or* agent API key) the right gate for a
   trip's source booking documents,** or should it be
   `organizerOrAgentRequired`? It is consistent with the existing
   `/api/bookings/confirmation/:fn`, which is an argument for it, not a proof.
   `boundary-reviewer`'s call.
9. **Who owns re-running the PR's reported validation numbers post-merge?** Every
   figure in the PR body was measured before `37be82e` existed.

---

*Written by the regression-planner agent. No deploy was performed, no commit was
made, no production system was contacted. Scratch databases `cptest_rp92` and
`cptest_s6base` were created on the local test Postgres (127.0.0.1:5434) and can
be dropped.*
