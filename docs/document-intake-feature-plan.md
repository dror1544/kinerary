# Integrated document intake — dedicated feature plan

Status: revised plan, 2026-09-12. Implementation and acceptance remain to be completed.
This supersedes the previous isolated-module plan and its deferred integration stages.

Implementation state, configuration, rollout/rollback and open decisions (2026-09-13):
[`document-intake-operations.md`](document-intake-operations.md).

## Development and release boundary

Document intake is an independent feature, **not Sprint 5 scope**.
`origin/integration/sprint-5-plus` supplies the latest document/intake infrastructure;
it is the technical baseline, not the delivery milestone or merge destination.

- Fetched baseline: `773603ebc3d2f37e08cbffc0d0351d839eeccb19`.
- Dedicated branch: `feat/document-intake`.
- Worktree: `.claude/worktrees/document-intake`.
- PR #46 (`feat/spa-parity`) continues to own SPA parity; document-intake work
  does not get added to that PR or to the Sprint 5 delivery ledger.
- Implement, refactor, integrate and test the complete feature on this branch.
  Do not modify other worktrees, the live stack or the Sprint 5 branch to advance it.
- Target eventual integration into `main`, after feature acceptance and an explicit
  merge/release decision. Reconcile with the then-current main before that merge;
  audit inherited baseline changes so unrelated Sprint 5 changes are not released
  accidentally through the feature PR. This is a release review, not a development gate.
- There is no requirement to wait for Sprint 5 or unfinished plan-review work.
  Reuse compatible work already present in the baseline. Implement needed shared
  functionality here if it is absent; reconcile parallel changes when they arrive.

Isolation applies to development and release, not to the internal architecture.
Existing files may be changed wherever a clean implementation requires it, including
`interpret.ts`, `relay/poller.ts`, `document-text.ts`, `model-runner.ts`,
`interview.ts`, migrations, transformer/provisioner code, runtime routes and cards.
Preserve behavioral and security contracts rather than freezing particular files.

## Required integrated outcome

```
authorized document ingest
  → trip-scoped NFS bytes + DB document registry
  → format reading, normalization and coverage
  → durable per-document extraction
  → reconciliation across documents and existing accepted trip information
  → deterministic acceptance + durable provenance
  → existing intake answers, immutable versions and trip projections
  → authenticated source-document view/download
  → automated tests + full-flow acceptance
```

New modules are implementation units within this flow. A harness that only calls
new modules, with no production intake caller or trip projection, is not completion.
An individual layer can be developed and tested first; the final branch must wire
and validate the layers together.

Earlier scope includes web upload, post-provision intake and switchable vision.
These remain planned; this revision does not record agreement to defer them.
They can become explicit optional follow-ups only by agreement. The text-document
core has its own acceptance gate and must be independently completable. General
plan-review approval screens and plan patch application are not prerequisites:
the feature owns the document correction flow it needs.

## Baseline findings and reuse

The fetched tree contains `document-text.ts`, `interpret.ts`, `model-runner.ts`
and the existing relay document path. It does not contain `plan-review.ts`.
The highest migration suffix is currently `0051_trip_person_links.sql`; do not
reuse the old plan's assumed 0051/0052 allocations. Allocate the next available
numbers during implementation and check them again when integrating upstream.

Reuse and refactor the existing reader, structured model runner, evidence checks,
answer validator, answer submission, immutable intake/correction mechanism,
itinerary normalization/folding, transformer and authenticated document serving.
Activate the existing `control_plane.source_artifacts` scaffold where its semantics
fit. Add normalized document/extraction/source records where needed rather than
forcing all state into an overloaded JSON field.

The existing artifact uniqueness includes provider and source reference; it does
not alone guarantee trip-wide content deduplication across channels. Add an explicit
trip/content identity and keep separate ingest occurrence records for message IDs,
channels and filenames. Distinguish artifact processing status from organizer
approval of document-derived changes.

The old plan's line-number inventory is historical research, not a fixed contract.
Confirm current call paths and schema constraints when implementing each stage.

## 1. Storage, registry and resumable ingest

Implement one authorized ingest service used by the existing Telegram document path
and later channel adapters on this same branch. Resolve the trip from authenticated
chat/organizer binding; never trust a payload-supplied trip ID by itself.

- Validate size, content type and supported format, and run the existing identity
  document refusal policy before durable registration/storage. Do not claim that
  this heuristic detects every sensitive document.
- Hash original bytes; deduplicate within the trip. The same bytes in another trip
  must have independent authorization and registry ownership.
- Store original bytes outside git and outside Postgres, under a configured NFS
  root such as `DOCUMENT_STORE_DIR/<trip_id>/<digest>`. Generate storage paths;
  filenames are metadata, never path components supplied by the uploader.
- Use temporary writes plus atomic finalization, verify size/digest, and record
  explicit ingest/processing states. NFS and Postgres cannot share a transaction:
  define recovery for an orphan blob, a pending registry row, and interrupted writes.
  Concurrent uploads of identical bytes must converge without replacing content.
- Store a relative storage key in the registry; retain upload occurrences and
  processing diagnostics. Define retention and teardown for originals, temporary
  files and superseded artifacts; deletion must respect retained source references.
- Replace the document path's overwrite-only source-document persistence with the
  registry. Retain/migrate legacy source_document consumers explicitly.
- Fix document-path interpretation completion and replay behavior here. A separate
  production bugfix PR may be useful, but is not required before this branch proceeds.

Exit evidence: fixture uploads through the actual intake entry point create one
trip-scoped blob/document identity; duplicates, concurrent delivery and restart
recovery are covered by tests.

## 2. Reading and per-document extraction

Refactor `document-text.ts` and model task configuration as needed, sharing parser
internals and validation rather than duplicating them to avoid existing files.

- Support the core readable formats: text PDFs, DOCX, XLSX and existing text inputs.
  Decode spreadsheet date styles and the workbook date system; keep page/sheet
  coverage and explicitly report partial, unsupported or truncated reads.
- Remove silent prompt slicing or replace it with a bounded, explicit partial-read
  result. A document beyond the supported budget must not appear fully processed.
- Persist **one extraction result per document**, with document ID/digest, normalized
  text version, reader/extractor/schema version, task/provider/model configuration,
  evidence, coverage and result status. Multi-file bursts coordinate documents;
  they do not concatenate away document identity before extraction.
- Cache/replay by trip + document + processing version/configuration. An intentional
  re-extraction is a versioned operation, distinct from delivery retries.
- Keep model input untrusted, extraction tool-free and outputs schema/evidence gated.
  Existing trip truth belongs in reconciliation context, not as fabricated evidence
  in an individual document's extraction.
- Separate task configuration for intake and itinerary extraction where needed.
  Implement any missing runner generalization here; do not wait for plan-review's
  refactor. Preserve existing environment configuration and pinned-provider retry
  behavior. No silent mid-run provider fallback.

Exit evidence: each input has its own durable, source-attributed extraction;
identical replay makes zero additional model calls; a crash resumes safely.

## 3. Reconciliation, provenance and intake writes

Create one shared set of identity/merge rules and use it for within-document and
cross-document processing. Refactor `interpret.ts` and itinerary folding accordingly.

- Reconcile new extraction records with prior documents and current accepted answers.
  Add distinct entities, fill missing fields, and surface conflicting supported
  values without silently replacing the held value. Upload time is not evidence
  that a booking is newer or authoritative.
- Match bookings/stays using supported identifiers, supplier, dates and location;
  preserve repeated visits and traveler/subgroup distinctions. Ambiguous matches
  remain unresolved instead of being forced into duplicates or false merges.
- Merge itinerary coverage by date/item rather than treating a phase with one day
  as complete. Preserve organizer edits and existing accepted details.
- If a model assists ambiguous identity matching, its result remains a proposal
  subjected to the same deterministic gates. Keep both documents' evidence.
- Record field/entry-to-document provenance and conflict decisions durably. Use stable
  entity/source identifiers, not mutable display names as the sole link. Preserve
  multiple supporting documents and rejected/superseded evidence for audit.
- Keep accepted intake answers as the canonical trip state. Provenance is a sidecar;
  adding source links must not silently change the existing semantic intake digest.
  Immutable versions capture the provenance/document manifest needed to reproduce them.
- Wire accepted changes through the existing validator and intake submission path.
  Recheck session state/version under a lock or revision precondition before committing
  answers, provenance and processing completion. Do not apply a minutes-old snapshot
  after a concurrent organizer edit, another upload or CONFIRM.
- Show coverage warnings, replay acknowledgments and focused conflict questions via
  the real relay/router. Unresolved conflicts preserve accepted state; they must not
  silently discard either source or invent a required plan-review dependency.

Exit evidence: sequential and combined uploads converge for conflict-free facts;
conflicting documents preserve held values and expose a resolvable question;
concurrent edits and confirm transitions cannot be overwritten by stale work.

## 4. Post-confirm corrections without a plan-review dependency

Document-derived changes after confirmation require organizer approval; model
confidence never supplies authorization.

Store a document-specific proposed correction with source references and the base
intake version/digest. Build its organizer review and application path here using
existing intake correction APIs. Approval revalidates against current state and
creates a new immutable version through `correctIntake`; rejection and repeated
callbacks are idempotent. Stale approvals require reconciliation/review again.

Reuse an existing compatible proposal queue if present. If absent, implement the
minimal document-correction storage and adapter on this branch. Keep generic
fingerprinting/decision primitives reusable, without requiring a general plan judge,
plan-review UI or plan-patch applier. Avoid parallel canonical answer stores.

For post-provision changes, choose the appropriate existing correction or draft
booking path explicitly; never apply the same fact through both automatically.
Validate protection of confirmed state whether optional approval presentation is
later deferred or retained in scope.

## 5. Provisioning, runtime and document access

Complete the source-to-trip projection on this branch, including transformer,
provisioner and runtime changes wherever necessary.

- Project accepted phases, dates, travelers, anchors, days and bookings through the
  existing structures; validate contract compatibility and bump schema versions only
  when warranted. Do not let model-specific extraction shapes become runtime truth.
- Hand off documents and their manifests into the trip's NFS-backed document area
  using the existing provisioning storage design. Make retries idempotent, check
  digests, and define reconciliation of post-provision uploads with registry state.
- Persist source associations on runtime entities through document IDs/manifests.
  Preserve existing single-confirmation links during migration and support multiple
  source documents without inventing a public filesystem path.
- Wire authenticated view/download from the relevant trip cards. Enforce trip and
  role/visibility checks for every lookup; draft/private evidence does not become
  visible simply because the caller is an authenticated trip member.
- Web and companion adapters call the same ingest service. Web upload, if deferred
  by agreement, does not defer the Telegram-to-intake-to-trip flow or source links.
- Preserve sanitizeConfig's blanket rule, restrictive unknown visibility defaults,
  and organizer/member auth separation. Diagnostics expose safe status/counts;
  private document contents and storage keys do not leak through warnings/config.

Exit evidence: provisioned fixture trip contains the accepted entities and correct
source links; authorized view/download returns the original bytes and other-trip,
anonymous and unauthorized draft access is rejected.

## 6. Format/provider additions and evaluation

Implement planned vision and super-user task-provider configuration independently
of the text core. Verify actual runner capabilities before promising image/scanned
PDF support. Unsupported or partially scanned documents receive an honest result
until support is implemented; no silent successful empty extraction.

Use pinned model settings and record latency, retries, cost and accepted-fact quality.
Choose model defaults from current measured results and deployed configuration;
do not carry forward the old plan's unverified pricing/context-window claims.
Any reduction of the previously requested web/vision scope needs an explicit decision.

## Implementation sequence and acceptance

All stages run on the dedicated feature branch; the sequence is internal engineering
order, not separately approved integration boundaries:

1. Capture baseline regressions and fixtures; define document, extraction, provenance
   and processing-state contracts; allocate migrations from the actual tree.
2. Integrate registry/NFS storage and recovery into real ingest; repair replay behavior.
3. Wire coverage-aware reading and per-document extraction, with stored results.
4. Integrate reconciliation, concurrency protection, provenance and router messages.
5. Complete confirmed-state correction handling, trip projection and protected sources.
6. Complete retained optional surfaces/providers; run whole-flow acceptance and
   document any explicitly agreed deferrals before release review.

Required validation:

- Pure/unit: normalization, spreadsheet dates, coverage, evidence rejection, identity,
  add/fill/conflict rules, repeated cities, organizer edits and source mappings.
- Storage/DB: digest identity, cross-channel dedupe, cross-trip isolation, concurrent
  claims, failure/restart recovery, extraction reuse, atomic answer/provenance commits,
  stale correction approvals and immutable version behavior.
- Integration: the actual relay ingest caller through storage/read/extraction/merge
  and answer submission; two documents together, reversed order and sequentially;
  duplicate delivery, conflicts, partial reads and post-CONFIRM arrival.
- Provisioning/runtime: accepted structured answers through transformer to a fixture
  trip, correct source associations, original-byte view/download, upgrade compatibility.
- Security: actual request/response evidence for organizer upload, trip scoping,
  member/draft visibility and anonymous access; malicious document text stays data.
- Real-model acceptance: labeled fixtures through the wired flow with pinned settings,
  not only fakeRunner or a disconnected CLI harness. Record facts/false merges,
  coverage, calls, latency and failures. Real documents remain outside git.
- Relevant API, worker, runtime and SPA suites, followed by required preflight checks.
  Guard every destructive harness with the repository's test-database safety helper.
  Use only a disposable test database such as
  `postgres://postgres:test@127.0.0.1:5434/cptest`; never the dev/live database.
  NFS production behavior needs acceptance on a dedicated test area; local directory
  tests are not evidence of a deployed NFS mount working.

Completion means the complete core flow passes with real existing-system callers
and a provisioned fixture trip. Report passed, failed, skipped and unrun checks
separately. Deployment, merge and release remain explicit actions; none is implied
by plan revision. Sprint 5 delivery remains independent throughout development.
