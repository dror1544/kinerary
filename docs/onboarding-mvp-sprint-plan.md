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

The first implementation runs locally on Proxmox, with a dedicated
control-plane LXC, PostgreSQL, a private provisioning worker, a Proxmox runtime
adapter, local ingress adapter, private Hermes-agent runtime, and Telegram as
the first messaging adapter. Those are **adapters**, not canonical product
assumptions.

The first release deliberately supports one happy-path organizer and one demo
trip at a time, but it must use durable IDs, membership scoping, idempotency,
and per-trip records from the beginning. A manual approval is expected at
two safe gates: provision and public activation.

### Component seams

| Component | Input | Output | Must be testable without |
|---|---|---|---|
| Signup and ownership | verified provider identity | user, draft trip, membership | Telegram interview or Proxmox |
| Interview enrollment | user + draft trip | expiring single-use enrollment | real provisioning |
| Intake service | authorized Telegram messages | versioned confirmed intake | provider credentials |
| Planner/workflow | confirmed intake + release ID | immutable plan, jobs and audit trail | actual runtime creation |
| Release catalog | source revision | verified release manifest + local artifact reference | real organizer data |
| Runtime adapter | approved plan | private runtime/resource records | public DNS/TLS |
| Agent/messaging adapter | trip binding + policy bundle | isolated profile and group binding | public activation |
| Verification/activation | private readiness evidence | active trip and scoped status | a new provisioning run |

No public API, Telegram update, or Hermes tool invokes provider actions
directly. The only privileged entry point is a private worker consuming
approved, idempotent jobs from PostgreSQL.

## 2. Shared test environment and evidence

Build these once in Sprint 0; every later sprint uses them.

- A `test` architecture profile selects separate Proxmox resource ranges,
  non-production hostnames, test-only Telegram bot/chat IDs, and distinct
  secret references. No real values appear in source control or trip folders.
- Seed fixtures create an organizer identity, a second unauthorized identity,
  Japan intake data, an incompatible release, and a controlled provider error.
- Adapter fakes implement compute, ingress, Hermes, Telegram, clock and secret
  interfaces for deterministic unit/contract tests. A separate integration
  profile uses real local adapters only against the test allocation.
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
  plan, job, resource, verification evidence, activation and audit event.
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
  values are not stored in trip content or public responses;
- fake adapter contract tests prove request IDs and idempotency keys propagate.

Manual tests:

- inspect service network bindings: only the public API is reachable through
  ingress; worker, database, MCP, provider and secret endpoints are private;
- dry-run test-resource cleanup and verify it selects only labelled test data.

Exit gate: schema migration succeeds on a blank test database, all component
interfaces have fakes, and a failed job is represented durably without an
external side effect.

### Sprint 1 — Signup, identity, ownership, and draft trip

**Goal:** an organizer creates and resumes only their own draft.

Build:

- Implement provider-neutral `users`, `user_identities`, `trips`, and
  `trip_memberships`; enforce membership scoping in every query.
- Implement Telegram login verification as the first identity adapter, with
  signature freshness and unique Telegram identity constraints.
- Create a small public signup/status UI: authenticate, create a draft name,
  view own draft state, and obtain an interview handoff. Super-admin views are
  separately authorized.

Automated tests:

- valid, stale, tampered and duplicate Telegram-login payloads;
- owner can read/create their draft; a second user, unauthenticated caller and
  forged trip ID cannot read or mutate it;
- repeat submit is idempotent and creates one draft/membership;
- API responses and logs omit Telegram tokens and numeric identity values where
  not needed.

Manual tests:

- sign in with a test organizer, create a draft, refresh/relogin and confirm
  the same draft is visible;
- sign in with the second test identity and confirm the first draft is absent.

Exit gate: a real test Telegram login produces a durable draft, while all
authorization cases pass using only public API access.

### Sprint 2 — Authorized interview and immutable intake

**Goal:** only the verified signup identity can talk to the interviewer for its
specific draft, and `CONFIRM` produces a versioned intake.

Build:

- Issue signed, opaque, expiring, single-use enrollment links bound to user,
  trip, purpose and expiry.
- Implement a narrow interview-session API for the Hermes interviewer. It can
  read/write its one intake session and validate answers; it has no provider,
  activation, secret, or cross-trip capability.
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
- API and audit assertions confirm no raw transcript is emitted.

Manual tests:

- complete a short interview from the test organizer's Telegram DM, confirm
  the bot refuses a message from the unauthorized identity, then confirm;
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

### Sprint 5 — Hermes profile, shared Telegram routing, and group binding

**Goal:** connect one isolated companion profile and one test group without
creating a per-trip bot by default.

Build:

- Convert reusable `familytrip-provisioner` validation/profile logic into a
  private agent-runtime adapter using policy and personalization bundles.
- Create provider-neutral messaging bindings and a shared Telegram router.
  Bind `provider + bot identity + chat ID` to exactly one trip only after a
  signed organizer action and permission verification.
- Keep interviewer DM, organizer-private commands and group-chat commands as
  separate routes/policies. Dedicated-bot support remains an optional adapter
  path, not a Sprint 5 dependency.

Automated tests:

- profile bundle versioning and private MCP endpoint scoping;
- two-trip router matrix: each accepted group message reaches only its own
  profile; unknown/moved/replayed chats and ordinary chatter are rejected or
  ignored according to policy;
- group-binding invitation replay/expiry/organizer mismatch and insufficient
  bot permissions fail safely;
- agent/messaging adapter failures leave the trip non-active and retryable.

Manual tests:

- bind a disposable Telegram group using the test organizer; verify the shared
  bot sees only allowed behavior and the companion uses the Japan identity;
- send the same trigger from a second test group and verify no cross-trip
  response or MCP access occurs.

Exit gate: private verification demonstrates one group, one logical binding,
one profile and one trip MCP identity, with a two-trip isolation test passing.

### Sprint 6 — Verification, explicit activation, dashboard, and demo rehearsal

**Goal:** complete the end-to-end lifecycle and prove operations can safely
observe, pause and recover it.

Build:

- Implement a verification aggregator requiring release compatibility,
  runtime/service health, rendered trip data, MCP/profile isolation, messaging
  binding and backup checkpoint before `ready_private`.
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

## 4. Demo-trip acceptance script

Run this only after Sprint 6 automated gates are green. Record the IDs,
timestamps, approvals and redacted evidence in the release/demo record.

1. Select a verified release and create a unique test-run ID.
2. Sign in as the test organizer on the onboarding website and create a draft.
3. Open the enrollment link from that organizer's Telegram account; prove the
   other test identity is refused.
4. Complete the Japan fixture interview, inspect the normalized summary, and
   send literal `CONFIRM`.
5. Generate and manually approve the provisioning plan. Verify the plan is
   bound to its intake digest and selected release.
6. Observe the worker create the isolated test runtime, restore/attach its
   persistent data, configure its private MCP, and store private-readiness
   evidence. Confirm no public route exists yet.
7. Bind the disposable test Telegram group to the shared companion router and
   prove a second group does not route to this trip.
8. Review and separately approve the activation plan. Verify the
   non-production hostname, TLS and website only; verify worker/admin/MCP
   endpoints remain private.
9. Use the active Japan site and one safe companion interaction. Check the
   dashboard's lifecycle, health and redacted analytics evidence.
10. Rehearse one controlled failure (worker restart or failed readiness),
    recover through the dashboard, then suspend/archive the demo and run the
    labelled cleanup. Preserve only approved audit/release evidence.

The demo is successful only if the evidence demonstrates both success and the
refusal paths: unauthorized identity, replayed enrollment, unapproved plan,
missing verification evidence and failed activation must all be unable to
produce an active trip.

## 5. MVP completion criteria and deferrals

The MVP onboarding milestone is complete when the Sprint 6 demo is repeatable
from a clean test allocation, and the automated test suite covers every
component seam plus the major refusal paths. A human may still approve
provisioning and activation; automation means those approvals trigger a
durable, repeatable workflow rather than an operator's ad-hoc commands.

Defer until the MVP is stable: cloud renderer, managed database/queue,
Kubernetes, multi-region operation, organizer self-service history/insights,
billing, automated release promotion, additional messaging providers, and
dedicated per-trip bots. Do not defer their interfaces: release manifests,
resource IDs, secret references, `isolation_tier`, memberships, messaging
bindings and lifecycle events are required in the first schema.
