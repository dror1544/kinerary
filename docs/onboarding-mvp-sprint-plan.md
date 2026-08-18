# MVP Onboarding Implementation Plan — Local Hosting

**Status:** Proposed implementation plan. This plan is intentionally local-MVP
first, but its records and interfaces must comply with the portable
control-plane contracts in `control-plane-implementation-guide.md`. It does
not authorize deployment, live provisioning, or a commit.

**Outcome:** a registered organizer can sign up, complete a protected Telegram
interview, explicitly confirm the intake, approve a provisioning plan, and
receive an active demo trip. Each boundary is independently testable before it
is connected to the next one.

The demo uses the Japan fake-trip fixture and a non-production hostname and
test Telegram identities/groups only. It must never use a real family's data
or a production group as test input.

## 1. MVP scope and operating model

The first implementation runs locally on Proxmox, with a small dedicated
control-plane VM running PostgreSQL, migrations, the API and a private
provisioning worker under Docker Compose. Trip runtimes remain one-per-trip
LXCs behind a Proxmox runtime adapter, local ingress adapter, private
Hermes-agent runtime, and Telegram as the first messaging adapter. Those are
**adapters**, not canonical product assumptions.

The first release deliberately supports one happy-path organizer and one demo
trip at a time, but it must use durable IDs, membership scoping, idempotency,
and per-trip records from the beginning. For the local MVP, a super-admin
approval is required before a verified signup becomes a usable draft. Manual
approval is also expected at the later provision and public-activation gates.

### MVP signup-approval gate

A successful Telegram login proves an identity; it does not authorize
onboarding. It creates a minimal `pending_signup_approval` request and a
transactional notification-outbox event. The notification goes only to the
configured super-admin Telegram identity, with opaque Approve and Reject
actions. It must not include secrets, intake data, or a reusable public URL.

The callback handler verifies the bot identity, the configured super-admin
Telegram ID, the signed opaque action, its expiry, and one-time use. Approval
atomically creates (or unlocks) the owner membership and `draft` trip, then
allows the interview handoff. Rejection/expiry leaves no usable draft,
enrollment link, worker job, or provider resource. Duplicate signup attempts
reuse the pending request and do not create a notification storm. Rate limits
and approval expiry are configuration, not hard-coded values.

Telegram is only the local notification/decision adapter. The canonical
record is a provider-neutral `signup_approval_request` with actor, decision,
timestamps, opaque notification/action IDs and audit evidence. A future
dashboard/email workflow can use that contract without changing signup state.

### Component seams

| Component | Input | Output | Must be testable without |
|---|---|---|---|
| Signup approval | verified provider identity | approved draft trip or terminal rejection | Telegram interview or Proxmox |
| Signup and ownership | approved signup request | user, draft trip, membership | Telegram interview or Proxmox |
| Interview enrollment | user + draft trip | expiring single-use enrollment | real provisioning |
| Intake service | authorized Telegram messages | versioned confirmed intake | provider credentials |
| Planner/workflow | confirmed intake + release ID | immutable plan, jobs and audit trail | actual runtime creation |
| Release catalog | source revision | verified release manifest + local artifact reference | real organizer data |
| Runtime adapter | approved plan | private runtime/resource records | public DNS/TLS |
| Agent/messaging adapter | organizer binding + policy/memory bundle | organizer profile, Trip Context Gateway and group binding | public activation |
| Connected services | user consent + trip binding + capability | reviewed imports/drafts/provider receipts | core trip activation |
| Verification/activation | private readiness evidence | active trip and scoped status | a new provisioning run |

No public API, Telegram update, or Hermes tool invokes provider actions
directly. The only privileged entry point is a private worker consuming
approved, idempotent jobs from PostgreSQL.

## 2. Shared test environment and evidence

Build these once in Sprint 0; every later sprint uses them.

- A `test` architecture profile selects separate Proxmox resource ranges,
  non-production hostnames, test-only Telegram bot/chat IDs, and distinct
  secret references. No real values appear in source control or trip folders.
- Seed fixtures create an approved organizer identity, a pending organizer
  identity, a second unauthorized identity, Japan intake data, an incompatible
  release, and a controlled provider error.
- Adapter fakes implement compute, ingress, Hermes, Telegram, clock and secret
  interfaces for deterministic unit/contract tests. Connected-service fakes
  cover OAuth revocation, stale cursors/offers, import provenance and approval
  gates. A separate integration profile uses real local adapters only against
  the test allocation.
- Each operation writes a correlation ID, plan digest, job ID and redacted
  audit event. Tests assert state and evidence, not only a successful HTTP
  response.
- A cleanup command identifies resources by test run ID and refuses to touch
  unlabelled or production resources. It is exercised first with a dry run.

### Minimum automated suite

| Layer | Purpose | Runs |
|---|---|---|
| Unit | validation, state transitions, authorization and idempotency | every change |
| API/integration | HTTP/API + PostgreSQL migrations and transactions | every change |
| Adapter contract | same assertions against fake and local Proxmox/Hermes/Telegram adapters | adapter changes and release candidates |
| End-to-end sandbox | signup through private readiness using test adapters/resources | merge/release candidate |
| Release qualification | build, Japan injection, sanitation scan, runtime/MCP/render tests | every release artifact |
| Manual acceptance | external Telegram UX, group permissions, DNS/TLS and approval gates | each sprint gate and demo rehearsal |

The existing Kinerary test suite remains a release prerequisite. New
control-plane tests must be runnable without a Telegram account, a Proxmox
server, or secrets; real-adapter tests are explicitly selected by environment.

## 3. Sprints

Each sprint ends with a demonstrable vertical slice, automated evidence, and a
short manual check. Do not begin a dependent sprint by bypassing an unfinished
gate with direct database edits or shell commands.

### Sprint 0 — Contracts, repository shape, and safe test harness

**Goal:** establish deployable boundaries before product behavior.

Build:

- Define versioned schemas for user, trip, enrollment, intake version, release,
  plan, job, resource, verification evidence, activation, organizer profile,
  trip context, messaging/group binding, connected-service capability/consent,
  import provenance and audit event.
- Create the TypeScript control API skeleton and Python worker skeleton with a
  shared provider-neutral request/result schema. Keep workers on a private
  listener/queue path.
- Add PostgreSQL migrations, migration test database, architecture-profile
  validation, redacted structured logging, and test-run resource labels.
- Define fake adapters and contract-test fixtures. Add a read-only local
  Proxmox inventory command; do not allocate resources yet.

Automated tests:

- fresh and upgrade migration tests; invalid/missing architecture configuration
  fails before any provider call;
- state-machine tests reject skipped lifecycle states and direct activation;
- secret redaction and canonical-record tests prove paths, IPs and secret
  values, OAuth grants and provider tokens are not stored in trip content,
  plans, database values or public responses;
- fake adapter contract tests prove request IDs and idempotency keys propagate.

Manual tests:

- inspect service network bindings: only the public API is reachable through
  ingress; worker, database, MCP, provider and secret endpoints are private;
- dry-run test-resource cleanup and verify it selects only labelled test data;
- **open action item — run the Proxmox inventory command against the real
  cluster during the first live test.** `ProxmoxHttpTransport` pins the scheme
  to `https` and never disables certificate verification, so Proxmox's default
  self-signed certificate requires `PROXMOX_CA_BUNDLE` to point at the issuing
  CA. Nothing in the automated suite reaches a live Proxmox — the unit tests
  only prove that unsafe schemes are refused and that verification stays on —
  so this manual run is the only thing that proves the transport works at all.
  Until a live run has passed, treat it as this open item rather than reporting
  it as missing test coverage.

Exit gate: schema migration succeeds on a blank test database, all component
interfaces have fakes, and a failed job is represented durably without an
external side effect.

### Sprint 1 — Signup, identity, ownership, and draft trip

**Goal:** a verified identity needs your Telegram approval before it can create
or resume its own draft.

Build:

- Implement provider-neutral `users`, `user_identities`, `trips`,
  `trip_memberships`, and `signup_approval_requests`; enforce membership
  scoping in every query.
- Implement Telegram login verification as the first identity adapter, with
  signature freshness and unique Telegram identity constraints.
- On first verified signup, create a minimal pending request and transactional
  notification-outbox record. A private Telegram approval adapter sends only
  the configured super-admin an expiring one-time action keyboard.
- Implement private callback processing: require the configured super-admin
  identity and signed action; approve atomically creates/unlocks the draft and
  membership; reject/expire blocks onboarding. The public UI shows only
  `awaiting approval`, approved draft state, or a generic declined/expired
  result.
- Create a small public signup/status UI: authenticate, request a draft name,
  view only their own status, and obtain an interview handoff only after
  approval. Super-admin views are separately authorized.

Automated tests:

- valid, stale, tampered and duplicate Telegram-login payloads;
- verified signup creates one pending request and one outbox notification; a
  repeated request reuses it without notification fan-out;
- approval callback rejects a wrong chat/user, altered action, replay or
  expiry; a valid approval creates one draft/membership exactly once;
- rejected/expired requests cannot obtain an enrollment link, create a job, or
  become a draft through public APIs;
- owner can read their approved draft; a second user, unauthenticated caller
  and forged trip ID cannot read or mutate it;
- notification payload/logs are redacted and rate limits protect the
  super-admin from repeated signup attempts;
- API responses and logs omit Telegram tokens and numeric identity values where
  not needed.

Manual tests:

- sign in with a pending test organizer and verify the website remains in
  `awaiting approval`; approve it from the allowlisted super-admin Telegram
  account and verify the same draft is then visible;
- reject a second test request and verify it cannot receive an interview link;
- sign in with the unauthorized identity and confirm the approved draft is
  absent.

Exit gate: a real test Telegram login produces a durable pending request and
only the allowlisted super-admin can turn it into a draft; public API access
cannot bypass, replay or flood that decision.

### Sprint 2 — Authorized interview and immutable intake

**Goal:** only the verified signup identity can talk to the interviewer for its
specific draft, and `CONFIRM` produces a versioned intake.

Build:

- Issue signed, opaque, expiring, single-use enrollment links bound to user,
  trip, purpose and expiry.
- Implement a narrow interview-session API for the Hermes interviewer. It can
  read/write its one intake session and validate answers; it has no provider,
  activation, secret, or cross-trip capability.
- Design Telegram prompts as small, structured choices whenever the answer has
  a known taxonomy. For example, trip type offers `family`, `group of
  families`, `couple`, and `other`; choosing `other` explicitly opens a
  free-text follow-up. Every choice question also supports an appropriate
  `other`/`not sure yet` path rather than forcing a wrong enum.
- Store both a stable option ID and its schema version; for `other`, store the
  organizer's free text as a bounded answer with provenance. The interview
  must summarize that answer back before `CONFIRM`, not silently classify it.
- Normalize/validate the collected answers. Literal `CONFIRM` creates an
  immutable intake version and digest; corrections create a new version.
- Add status UI for `interviewing` and `awaiting_confirmation` without showing
  private transcript content in dashboards or analytics.

Automated tests:

- enrollment expiry, replay, altered token, wrong Telegram ID and wrong trip
  all fail; a resumed authorized session works;
- session API denies attempts to list trips, enqueue jobs, access secrets or
  substitute another trip ID;
- partial answers validate predictably; `CONFIRM` is required; a second
  confirmation is idempotent; version history/digests are immutable;
- each choice prompt renders the approved options, rejects an unknown callback
  value, and accepts `other` only through its bounded free-text follow-up;
- an intake retains option ID/schema version and the literal `other` answer;
  recap shows both without an invented classification;
- API and audit assertions confirm no raw transcript is emitted.

Manual tests:

- complete a short interview from the test organizer's Telegram DM, confirm
  the bot refuses a message from the unauthorized identity, then confirm;
- answer the trip-type question once with a preset and once with `other`; in
  both cases verify the recap is understandable and requires confirmation;
- edit one answer via the approved correction path and verify a new intake
  version, not in-place mutation.

Exit gate: the dashboard shows one confirmed, digest-addressable Japan intake
that is traceable to its owner but cannot cause provisioning by itself.

### Sprint 3 — Planner, approvals, durable jobs, and release selection

**Goal:** turn a confirmed intake into an inspectable, approved work plan;
no resource is created before approval.

Build:

- Implement PostgreSQL jobs/steps with leases, heartbeats, bounded retries,
  idempotency keys, restart reconciliation and `waiting_for_user_action`.
- Implement release registry read APIs and a plan generator that selects an
  `available`, schema-compatible release. Store resource intent, not provider
  values, in the plan.
- Require an expiring approval bound to the exact plan digest before the
  private worker can claim provisioning work. Show plan effects and safe error
  summaries in the super-admin UI.

Automated tests:

- stale lease recovery, worker crash/restart, duplicate queue delivery and
  concurrent worker claims produce at most one logical step execution;
- incompatible/deprecated releases and a changed intake reject planning;
- approval replay, expiry and plan-digest mismatch reject execution;
- retryable provider errors wait/retry while non-retryable errors enter
  remediation without claiming success.

Manual tests:

- generate a Japan plan, review release ID, logical hostname, isolation tier,
  expected user actions and rollback constraints; decline it and prove no
  resources exist;
- approve a fresh plan, stop the worker during a harmless fake step, restart
  it and inspect correct reconciliation in the dashboard.

Exit gate: an approved Japan plan has a complete audit trail and exactly one
queued private provisioning job, while an unapproved plan has none.

### Sprint 4 — Release qualification and private trip runtime

**Goal:** create a clean, repeatable local runtime from a verified artifact,
with no public route.

Build:

- Implement the local Proxmox release-artifact renderer: build from immutable
  source, qualify with Japan, sanitize test state, seal manifest plus template
  reference, and register it as `candidate` then `available` after review.
- Implement compute/persistent-data/secret adapters for a dedicated test LXC.
  Provisioner attaches data by logical reference, injects approved trip content
  through an allowlist, and starts website/private MCP under supervision.
- Record allocated resource IDs as adapter metadata; never put VMIDs, IPs or
  paths in the intake or trip folder.

Automated tests:

- release manifest compatibility, artifact immutability and promotion rules;
- sanitation scan proves Japan content, database, logs, credentials and
  machine identity are absent from the sealed artifact;
- fake compute contract tests cover create/read/delete/idempotent retry;
- sandbox integration verifies health, render, MCP discovery, persistent-data
  restart and a controlled create failure with no leaked partial success.

Manual tests:

- build one release candidate and inspect its evidence; launch a disposable
  Japan runtime on the isolated test allocation;
- restart its services, confirm state persists, then inspect that no public
  DNS/TLS route, provisioning endpoint or private MCP endpoint is exposed.

Exit gate: one Japan deployment reaches `ready_private` only after stored
release, runtime, persistence, website and private-MCP evidence exists.

### Sprint 5 — Organizer profile, Trip Context Gateway, and Telegram routing

**Goal:** connect one long-lived organizer companion profile to isolated trip
contexts and test groups without creating a per-trip Telegram bot.

Build:

- Convert reusable `familytrip-provisioner` validation/profile logic into a
  private adapter that creates one profile per organizer using versioned
  policy, memory and personalization bundles.
- Add a deterministic Trip Context Gateway. It accepts only a router-issued
  organizer/trip/channel/role/lifecycle capability and selects one permitted
  trip MCP; the model/message cannot choose a trip or endpoint.
- Create provider-neutral messaging bindings and the shared Trip Bot router.
  Bind `provider + bot identity + chat ID` to exactly one trip only after a
  signed organizer action and permission verification.
- Implement private `/select` over owned trips with signed callbacks. Private
  selection is independent from group routing, and reviewed reassignment
  preserves binding history.
- Keep intake, organizer-private and group-chat sessions/policies separate.
  Add the private owner-only Super Bot for redacted alerts and narrow
  plan/approve/execute operations. Dedicated-bot support remains optional.

Automated tests:

- organizer-profile bundle versioning, structured memory consent and Trip
  Context Gateway scoping;
- two-trip router matrix: two groups may reach the same organizer profile, but
  use isolated sessions and different server-issued trip contexts; cross-trip
  reads/writes and private-memory leakage fail;
- private `/select` changes only the DM context; neither group binding changes;
- group-binding invitation replay/expiry/organizer mismatch and insufficient
  bot permissions fail safely;
- reassignment requires confirmation, closes rather than overwrites the old
  binding, and cannot silently retarget another active group;
- Super Bot rejects every sender except the configured owner and never exposes
  shell/provider/secret primitives;
- agent/messaging adapter failures leave the trip non-active and retryable.

Manual tests:

- bind a disposable Telegram group using the test organizer; verify the shared
  bot sees only allowed behavior and the companion uses the Japan identity;
- create/select a second draft in private DM and verify the Japan group remains
  bound to Japan; then send a trigger from a second test group and verify no
  cross-trip response, memory or MCP access occurs.

Exit gate: private verification demonstrates one group, one logical binding,
one organizer profile and one exact trip context/MCP identity, with a two-trip
isolation test passing.

### Sprint 6 — Verification, explicit activation, dashboard, and demo rehearsal

**Goal:** complete the end-to-end lifecycle and prove operations can safely
observe, pause and recover it.

Build:

- Implement a verification aggregator requiring release compatibility,
  runtime/service health, rendered trip data, MCP/context/profile isolation,
  messaging binding and backup checkpoint before `ready_private`.
- Generate a separate, expiring activation plan with the exact logical
  hostname/TLS/upstream intent. Apply it only from a distinct approval.
- Add super-admin lifecycle dashboard: funnel/state, jobs/blocked actions,
  release/resource versions, redacted failures, health, audit trail and
  bounded analytics. Add suspend/retry controls with server-side authorization.
- Document a runbook for failed provisioning, stale worker lease, failed
  activation, cleanup, upgrade rehearsal and rollback. No automatic
  destructive rollback.

Automated tests:

- a trip cannot become active when any required evidence is missing;
- activation approval replay/expiry and failed ingress verification leave the
  route unpublished and state non-active;
- health/analytics events are tenant-scoped, bounded and transcript-free;
- restart reconciliation, suspend/retry authorization, upgrade compatibility
  and compatible rollback use the recorded release/data checkpoint;
- full sandbox E2E executes the demo script below using fakes, then a selected
  local-adapter smoke test executes it against the test allocation.

Manual tests:

- perform the complete demo rehearsal with two people: organizer executes
  signup/interview/confirm/group actions; super-admin reviews the two approval
  gates and observes the dashboard;
- test an activation rejection, a deliberately failed health check and a
  worker restart before approving a clean retry;
- after success, open the non-production trip URL, exercise a safe companion
  request, verify monitoring, then suspend/archive and run labelled cleanup.

Exit gate: the complete demo script passes, its evidence is retained, cleanup
is verified, and the team can repeat the run without manual database changes.

### Sprint 7 — Post-trip debrief and reviewed learning

**Goal:** turn a completed trip into organizer-controlled knowledge for that
trip and, only with explicit consent, future-trip suggestions.

Build:

- Seal the completed trip data/version and enforce read-only behavior in both
  the trip API and Trip Context Gateway. Archiving changes normal visibility
  and runtime policy, never completed-trip immutability.
- Let the organizer explicitly select a completed trip in private Telegram for
  read-only memories; archived trips remain available from the personal
  dashboard and an explicit archive-selection path.
- Maintain structured, consented organizer preferences and recurring-traveler
  references separately from trip records. Suggest reuse with provenance and
  require confirmation before copying anything into a new trip.

- Issue a separate, owner-authorized debrief session after completion. Use the
  same choice-first Telegram pattern for ratings, whether a site was visited,
  recommendation confidence and reuse intent; each prompt offers `other` and
  free-text context where appropriate.
- Record versioned feedback items for site ratings/corrections, discovered or
  recommended locations, and additional facts that improve existing site
  information. Each item has source, trip, author role, confidence, consent,
  status and evidence reference.
- Treat chat-derived discoveries as **candidates**, not facts: extract only
  under an explicit per-trip organizer consent setting, redact/minimize text,
  and require organizer review before a candidate updates trip content or any
  reusable location catalog. Never auto-promote an LLM inference.
- Provide a private review queue with approve, edit, reject and revoke actions.
  Approved trip-local facts may update that trip's knowledge; cross-trip reuse
  requires a separate consent/provenance policy and is deferred from automatic
  behavior.

Automated tests:

- completed-trip mutation fails through both direct API and agent gateway;
  selecting/unarchiving it permits read-only access only;
- organizer memory never crosses into a group response, and an old preference
  or traveler is not copied into a new draft without confirmation;
- debrief enrollment is scoped to a completed trip and authorized organizer;
  a different member/trip cannot read or modify feedback;
- choice and `other` answer handling mirrors intake validation and stores
  provenance/versioning;
- no chat extraction occurs without consent; consent revocation stops future
  extraction and removes/revokes unapproved candidates according to retention
  policy;
- candidate review is idempotent and auditable; rejected or unreviewed items
  cannot alter site content, the location catalog, or future recommendations;
- analytics contains aggregate outcome/category signals, never raw debrief or
  chat text by default.

Manual tests:

- complete a Japan debrief with one high-rated site, one correction, and one
  discovered location entered through `other`; review/edit/approve each item;
- enable then revoke chat-candidate consent and verify only reviewed,
  consented, provenance-labelled items are visible to the organizer.

Exit gate: the Japan trip produces reviewed, provenance-labelled feedback that
improves only the intended trip by default; no raw chat transcript or
unreviewed suggestion becomes shared knowledge.

## 4. Demo-trip acceptance script

Run this only after Sprint 6 automated gates are green. Record the IDs,
timestamps, approvals and redacted evidence in the release/demo record.

1. Select a verified release and create a unique test-run ID.
2. Sign in as the test organizer and submit a draft request. Verify it remains
   `awaiting approval` and has no enrollment link.
3. Approve it from the allowlisted super-admin Telegram account. Verify that
   an unauthorized identity and a replayed approval action are refused, then
   open the organizer's enrollment link.
4. Prove the other test identity is refused by the interviewer.
5. Complete the Japan fixture interview, inspect the normalized summary, and
   send literal `CONFIRM`.
6. Generate and manually approve the provisioning plan. Verify the plan is
   bound to its intake digest and selected release.
7. Observe the worker create the isolated test runtime, restore/attach its
   persistent data, configure its private MCP, and store private-readiness
   evidence. Confirm no public route exists yet.
8. Bind the disposable test Telegram group to the shared companion router and
   prove a second group does not route to this trip.
9. Review and separately approve the activation plan. Verify the
   non-production hostname, TLS and website only; verify worker/admin/MCP
   endpoints remain private.
10. Use the active Japan site and one safe companion interaction. Check the
   dashboard's lifecycle, health and redacted analytics evidence.
11. Rehearse one controlled failure (worker restart or failed readiness),
    recover through the dashboard, then suspend/archive the demo and run the
    labelled cleanup. Preserve only approved audit/release evidence.

The demo is successful only if the evidence demonstrates both success and the
refusal paths: unauthorized identity, replayed signup approval or enrollment,
unapproved plan, missing verification evidence and failed activation must all
be unable to produce an active trip.

## 5. MVP completion criteria and deferrals

The MVP onboarding milestone is complete when the Sprint 6 demo is repeatable
from a clean test allocation, and the automated test suite covers every
component seam plus the major refusal paths. Sprint 7 is the first
post-trip-learning milestone and can begin once a completed Japan demo exists.
A human may still approve provisioning and activation; automation means those
approvals trigger a durable, repeatable workflow rather than an operator's
ad-hoc commands.

Defer until the MVP is stable: cloud renderer, managed database/queue,
Kubernetes, multi-region operation, organizer self-service history/insights,
billing, automated release promotion, additional messaging providers, and
dedicated per-trip bots. Also defer broad Gmail synchronization, automatic
photo-library scanning, social publishing and travel purchases. Do not defer
their interfaces: release manifests, resource IDs, secret references,
`isolation_tier`, memberships, messaging bindings, organizer trip-context
selection, service-connection capabilities, consent/provenance-labelled
imports/feedback and lifecycle events are required in the first schema.

After the MVP, connected services should arrive in separately reviewed tracks:

1. manual booking uploads/forwarding, Google Drive Picker, Maps Place IDs/URLs
   and scoped Immich access;
2. Google Photos Picker and reviewed Gmail extraction after OAuth verification
   and security requirements are understood;
3. native selected-gallery access, with broader background access requiring a
   new mobile consent decision;
4. hotel inventory search after formal supplier access, returning timestamped,
   expiring offers and provider checkout links before any booking capability;
5. social drafts followed by explicit preview/approval through official APIs.

Provider fakes and schema tests land before real credentials. No track may use
scraping, CAPTCHA bypass, browser credential automation or undocumented APIs,
and revoking an optional connection must not make the core trip unavailable.
