# Kinerary Control Plane — WIP Architecture and Operating Guide

**Status:** Work in progress. This document describes the target architecture
and safety contracts; it does not authorize deployment, infrastructure writes,
public activation, or a commit.

**Scope:** The web onboarding product, durable trip registry, private
provisioning workers, release-image lifecycle, monitoring, and the boundary to
Hermes and messaging systems.

The companion implementation sequence lives in
`.hermes/plans/2026-08-12_212146-trip-fleet-control-plane-and-onboarding.md`.
Bot and lifecycle telemetry are detailed in
`docs/trip-bot-analytics-and-metrics-design.md`.

## 1. Product responsibility

The control plane begins before the interview and remains responsible after a
trip goes live. It must support:

- public signup and provider identity verification;
- trip ownership and future multi-trip organizer accounts;
- database-authorized access to the shared interview bot;
- immutable confirmed-intake versions;
- deterministic provisioning, verification and activation;
- version-pinned trip runtimes with compatible upgrade/rollback;
- Hermes profile and messaging bindings;
- super-admin health, job, usage and audit dashboards;
- later organizer dashboards, historical trips, consented preferences,
  entitlements and monetization.

The control plane is deterministic software, not an LLM and not a broad MCP
server. Hermes can collect or apply trip-domain intent through narrow tools;
it does not receive infrastructure authority.

## 2. Non-negotiable boundaries

1. **Public and privileged surfaces are different services.** The public API
   may verify identity, create a draft, issue an interview link and read scoped
   status. Only a private worker may execute provider operations.
2. **The control plane runs on dedicated compute, never directly on a
   hypervisor.** The local MVP uses a Proxmox LXC; a cloud deployment may use
   other private compute. Provider credentials are scoped to named actions.
3. **Every real trip gets an isolated logical runtime and private MCP
   identity.** The local MVP uses one LXC per trip; shared infrastructure must
   never imply shared trip-data access.
4. **Website releases are immutable, versioned release artifacts.** The local
   MVP renders each artifact as a Proxmox template/image. A running test or
   production trip is not the permanent clone source.
5. **Japan qualifies every release.** Its fixture is removed before sealing;
   no Japan content, credentials, logs, DB or mutable state ships in an image.
6. **Persistent trip data and secrets are separate from the runtime image.**
   Replacement, upgrade and rollback must not depend on copying a mutable
   container root filesystem.
7. **Interview access is database-authorized.** A Telegram ID must first be
   verified by website signup and then matched to a signed, expiring,
   single-use trip enrollment.
8. **The interviewer is intake-only.** It has no Proxmox, DNS, activation,
   cross-trip MCP, secret, or arbitrary filesystem capabilities.
9. **Messaging topology is a policy choice.** Shared-bot routing is preferred
   where isolation can be proven; per-trip bots are optional, not universal.
10. **Activation is distinct from confirmation and provisioning.** Public
    routing requires its own exact plan, approval and verification.
11. **No plaintext secrets in PostgreSQL, trip folders, source control, logs,
    analytics, plan snapshots or MCP responses.** Store opaque references.
12. **A failed or waiting job is never reported as active.** External user
    actions are durable wait states, not invisible manual instructions.

## 3. General architecture and local MVP mapping

```text
Internet
  │
  ├─ public onboarding domain
  │    └─ Onboarding Web/API (public listener)
  │         ├─ Telegram login verification
  │         ├─ user/trip membership endpoints
  │         ├─ interview enrollment links
  │         └─ scoped dashboard/status APIs
  │
  └─ active trip domains
       └─ ingress/DNS/TLS adapter → selected trip runtime website only
          (local MVP: Cloudflare Tunnel → NPM → trip LXC)

Dedicated control-plane compute
  ├─ public Web/API process
  ├─ private worker process
  ├─ PostgreSQL control-plane registry (initial placement)
  ├─ scheduler/reconciler
  ├─ monitoring/analytics ingest endpoints (private)
  └─ secret-reference resolver
            │ private/provider-specific credentials
            ├─ compute/release-artifact adapter
            ├─ ingress/DNS/TLS adapter
            ├─ agent-runtime adapter
            └─ messaging-gateway adapter

Agent-runtime service
  ├─ isolated Hermes profile per trip
  ├─ versioned policy + personalization bundles
  ├─ shared messaging router or optional dedicated gateway
  └─ scoped connection to exactly one trip MCP per profile

Per-trip isolated runtime
  ├─ website runtime pinned to release artifact ID
  ├─ private trip MCP
  ├─ attached/restored persistent trip state
  └─ supervised health/readiness services
```

The general architecture requires these roles, not a named local technology:

| General role | Local MVP adapter | Future cloud adapter examples |
|---|---|---|
| control-plane compute | dedicated Proxmox LXC | private VM, container service, Kubernetes workload |
| release artifact | immutable release manifest + Proxmox template | OCI image, VM image, managed revision |
| trip isolation runtime | one LXC per trip | dedicated workload/namespace or approved shared runtime tier |
| ingress | RPi Cloudflare Tunnel + NPM | cloud load balancer, CDN/edge, managed DNS/TLS |
| secrets | restricted local files/references | cloud secret manager/Vault/KMS-backed store |
| agent runtime | supervised Proxmox service | private VM/container workload with durable profile store |
| messaging | shared Telegram router | same logical router on replicated/cloud compute |

The public API and worker can initially live on the same dedicated compute, but
they use separate listeners, credentials and code paths. The public reverse
proxy has no route to worker endpoints, PostgreSQL, Grafana, Prometheus, MCP,
SSH or provider APIs.

## 4. Implementation stack

- **Public/control API:** Node.js with TypeScript is recommended to align with
  the existing web product. Python FastAPI remains acceptable if the team
  chooses one backend language after a prototype.
- **Provisioning workers:** Python, reusing the current provider adapters,
  Telegram code and `/Users/elul/familytrip-provisioner/` behavior.
- **Registry:** PostgreSQL from the first deployed version. SQLite remains
  suitable for local adapter tests and per-process durable outboxes only.
- **Jobs:** PostgreSQL-backed jobs/steps with leases and a single worker first;
  add a broker only when measured concurrency requires one.
- **Secrets:** external secret manager or root-owned `0600` files exposed by
  opaque references and least-privilege service accounts.
- **Operations:** structured redacted logs, append-only audit events, private
  health/readiness, Prometheus for bounded live metrics and PostgreSQL for
  historical/event queries.

Do not introduce Kubernetes, arbitrary remote shell, public provisioning MCP,
or a public provider-action API for the first milestone.

### 4.1 Hard-to-remove scale constraints — address in the MVP

| Constraint | Later migration cost | MVP rule |
|---|---|---|
| Proxmox template as the only image identity | Cloud providers cannot consume an LXC template | Persist a release manifest/digest and `release_artifacts` per provider; treat the template ID as one rendering |
| One LXC as the only isolation expression | Cost, quotas and scheduler overhead grow linearly | Preserve trip-level logical isolation and add an `isolation_tier`; the local tier is dedicated LXC |
| Host paths, bind mounts or local SQLite as canonical trip state | Data cannot be relocated, replicated or restored provider-independently | Canonical data uses PostgreSQL/object-storage/backup interfaces with logical references |
| systemd, loopback/LAN and fixed IP assumptions in product code | Cloud runtimes expose different process/network semantics | Define generic start, readiness, private endpoint and ingress-verification contracts; local adapters use systemd/IPs |
| Mac-home/profile filesystem as agent identity | Cannot scale or provide high availability | Provision profiles through a private agent-runtime API using portable policy and personalization bundles |
| In-memory web sessions, enrollment links, router bindings or worker leases | Multiple replicas create replay, duplicate job and cross-trip-routing failures | Store these in PostgreSQL/Redis with expiry, unique constraints, leases and idempotency |
| Direct `.env` values/local files as the secret system | Rotation, audit and workload identity do not transfer cleanly | Store secret references only; implement a provider-neutral resolver and use local files only as the MVP backend |
| RPi/NPM/Cloudflare route objects in business records | Cloud TLS/DNS/load-balancing has different primitives | Store logical hostname/TLS/upstream intent and provider resource IDs behind an ingress adapter |
| Telegram-only or one-bot-per-trip identity model | Provider expansion and bot sprawl become expensive | Persist provider-neutral messaging bindings; shared router is the default and dedicated bots are a policy tier |
| High-cardinality analytics keyed by person/chat/runtime IDs | Cost and observability failures rise sharply with tenants | Bounded metrics, opaque event IDs, tenant-scoped access and lifecycle rollups from day one |

These are architecture contracts, not requirements to deploy cloud services in
the MVP. The local adapter may use LXC, systemd, LAN addresses, local files and
one control-plane LXC, provided those choices do not leak into canonical trip,
release, user, job or authorization records.

## 5. Versioned release-artifact model

### 5.1 Release build

For each product release:

1. resolve an immutable Git commit/tag and dependency lock state;
2. create a disposable clean provider build instance;
3. install common server/site/shared/MCP runtime and the provider adapter's
   supervision configuration;
4. inject the Japan fake-trip fixture into a temporary test location;
5. run unit, HTTP health, real rendering, MCP discovery, persistence and
   migration compatibility tests;
6. remove the Japan fixture, temporary database, secrets, logs, machine
   identity and build credentials;
7. prove the sanitized image contains none of those values;
8. seal a generic release manifest plus a new local Proxmox template/image
   without overwriting an older release;
9. write a candidate `releases` record with verification evidence;
10. promote it to `available` only after explicit review.

### 5.2 Release selection

- Each deployment stores its `release_id` and artifact digest; never infer
  version from files in a running runtime.
- New trips use the configured default available release unless an approved
  plan selects another compatible version.
- Active trips remain pinned until an upgrade is planned and approved.
- Old provider artifacts remain while pinned deployments or rollback windows
  need them.
- Provider-artifact retirement is blocked while an active/retained deployment
  depends on it.

### 5.3 Persistent-data compatibility

Every release declares an application schema and supported data-schema range.
Migration tooling must support rehearsal against a copied Japan data set and a
trip-specific checkpoint. Rollback is permitted only when the prior release
can read the checkpointed/migrated data or an approved restore will return it
to a compatible version. "Keep the old template" alone is not rollback.

## 6. Configuration and data ownership

### 6.1 External environment profile

The onboarding runtime loads a provider-neutral architecture profile from an
external, permission-restricted environment profile or secret provider. The
profile selects adapters and supplies adapter-specific configuration. Examples:

- release-builder storage and naming policies;
- compute/network allocation policies; in the local adapter these include
  Proxmox URL/node/storage/bridge, VMID and IP pools;
- ingress/DNS/TLS policy; in the local adapter these include NPM/Cloudflare
  endpoints, account/zone/tunnel references and credentials;
- public domain policy;
- agent-runtime and messaging-gateway endpoints/credentials;
- source checkout, persistent-data, backup and secret roots.

Committed `.example` files contain names and validation rules only. Provider
credentials should preferentially use `*_FILE`/secret references rather than
one large flat environment containing every value.

### 6.2 Trip folder

`trips/<slug>/` contains architecture-neutral, versioned trip material:

- normalized confirmed intake and digest/reference;
- `trip.config.json` and trivia content;
- provenance and review status;
- agent personalization inputs;
- approved assets or asset references.

It contains no VMID, IP, domain, provider URL, profile filesystem path, local
port, API key, bot token or deployment wrapper. It also contains no canonical
host path or bind-mount name: those cannot survive provider migration.
Deployment packages use a positive allowlist rather than syncing the directory
with exclusions.

### 6.3 Mutable runtime state

Participant changes, bindings, comments, uploaded media metadata and other
live mutations must live in a persistent data store with versioning/backups,
not by silently rewriting the source-controlled trip config inside one LXC.
Until that migration is complete, deployments compare source/live hashes and
refuse ambiguous overwrites.

## 7. Durable registry model

Foundational tables/records:

- `users`: account lifecycle and non-secret profile fields;
- `user_identities`: provider, immutable provider subject, verification time;
- `trips`: immutable ID, slug, lifecycle state, current deployment;
- `trip_memberships`: user, trip, owner/organizer/member role and status;
- `interview_enrollments`: hashed token, trip/user binding, expiry/use state;
- `intake_sessions` and `intake_versions`: draft state, confirmed artifact
  reference/digest, schema, provenance and confirmation evidence;
- `releases`: source/artifact digest/schema/compatibility/evidence/status;
- `release_artifacts`: release, provider, provider artifact ID and retention;
- `deployments`: trip, release, provider, isolation tier, persistent-data
  version and lifecycle;
- `resources`: provider/type/external ID for runtime, network, site, MCP,
  profile, messaging/group binding, domain and route status;
- `jobs` and `job_steps`: type, idempotency key, plan, lease, attempt, wait,
  result and safe error code;
- `approvals`: actor, scope/type, exact plan digest, expiry and consumption;
- `health_samples` and `incidents`;
- `usage_events`/rollups and cost records;
- `entitlement_references`: future plan/feature limits without billing details;
- `audit_events`: actor, action, target, before/after, request/job correlation.

Raw interview transcripts, Telegram IDs in analytics, tokens/passwords/keys,
MTProto sessions, provider credentials and full private trip payloads do not
belong in the operational registry unless a separately documented product
store and retention policy requires them.

## 8. Signup and interview authorization

1. Verify the Telegram Login payload signature, age and configured domain.
2. Upsert the Telegram identity only after successful verification; enforce a
   unique provider subject.
3. Create a draft trip and owner membership in one transaction.
4. Issue an opaque, signed, expiring, single-use interview enrollment deep
   link. Store only its hash/nonce and binding.
5. When the shared interviewer receives `/start`, send the token plus verified
   inbound Telegram ID to the onboarding API over a private/authenticated
   channel.
6. Atomically validate identity, trip, state, expiry and replay; bind or resume
   one intake session.
7. Scope every interviewer call to that session/trip/user. Reject all other
   Telegram users rather than relying on a static allowlist.
8. Present a recap; literal `CONFIRM` creates a new immutable intake version.
9. Confirmation queues planning. It does not approve provisioning or public
   activation by itself.

## 9. Workflow and approval rules

The trip lifecycle and job lifecycle are separate, as defined in the WIP plan.

- Every mutating request has an idempotency key.
- Workers resolve stable external identities before create/update.
- Plans contain desired resources, expected current state, checks and safe
  rollback/remediation constraints; never plaintext secrets.
- Provisioning and activation approvals bind to exact plan digests and expire.
- Any plan change invalidates the approval.
- Worker steps heartbeat and can be reconciled after restart.
- Telegram/group/user action creates a durable waiting step with instructions
  and expiry; it does not hold a worker process open.
- A failed verification stops all dependent actions.
- Rollback/delete/archive are new reviewed jobs, never automatic cleanup.

## 10. Provisioning flow

After an approved confirmed intake:

1. validate the selected release, provider artifact and trip schema
   compatibility;
2. allocate provider-specific runtime/network resources plus logical hostname,
   data and endpoint identities under a database allocation lock;
3. create the selected isolation runtime from the release's provider artifact;
4. attach or initialize persistent data and backups;
5. copy only approved trip content and inject runtime secrets by reference;
6. start and verify the site and private MCP under supervision;
7. provision an isolated Hermes profile with global policy and per-trip
   personalization bundles;
8. create or reuse a logical messaging binding and complete group binding;
9. verify all private components and store an evidence report;
10. transition to `ready_private`, then await a separate activation plan.

## 11. Hermes agent-runtime migration

The existing FamilyTrip provisioner already supplies valuable controls:
validated profile names, new-profile-only behavior, MCP host allowlists,
restricted source roots, profile-local file permissions and connectivity
tests. Preserve these controls while changing deployment assumptions.

The target private adapter accepts an idempotent manifest containing:

- trip/profile stable identity and display name;
- verified private MCP endpoint plus secret reference;
- global behavior-policy bundle version;
- per-trip personalization bundle version/reference;
- logical messaging binding reference;
- analytics emitter configuration/secret reference.

It returns non-secret resource IDs and evidence. It never accepts arbitrary
paths/commands or returns submitted credentials. Moving the control plane off
the Mac is incomplete while active trip agents still depend on an
unsupervised Mac-only process; migrate the runtime or explicitly document a
temporary remote-worker boundary and availability limitation.

## 12. Messaging strategy

Messaging is provider-neutral in the registry and lifecycle.

### Shared Telegram mode (preferred default)

- A platform login/onboarding bot handles authentication/onboarding links.
- A shared interviewer bot starts only database-authorized sessions.
- A shared companion bot can serve many trip groups when the gateway resolves
  `bot identity + chat ID` to one active trip before invoking Hermes.
- Each routed turn selects exactly one trip profile and one trip MCP.
- Organizer-private and family-group contexts remain different authorization
  modes even when they use the same bot identity.
- Bot token access stays in the gateway; Hermes profiles receive a logical
  channel binding, not a reusable cross-trip token where avoidable.

### Optional dedicated-bot mode

Use only when platform limitations, customer branding, contractual isolation
or product tiering requires it. Managed-bot creation and BotFather/MTProto
operations are adapter steps for that mode, not baseline dependencies for
every trip.

Telegram bots cannot create a group or add themselves. The organizer must
create/select the group and activate a signed, single-use group binding. That
action is represented by a resumable job wait.

## 13. Activation and verification

Private readiness proves:

- correct release/template and data compatibility;
- provider-runtime local and private-network structured health;
- persistent data and backup checkpoint;
- systemd/supervision state and restart recovery;
- private MCP readiness, permitted tools and cross-trip negative checks;
- Hermes profile isolation and policy/personalization versions;
- messaging routing, group binding and context authorization;
- rendered UI with expected trip identity and protected controls.

Activation then requires an independently approved plan. Publish only:

```text
Internet → selected edge/ingress adapter → exact hostname → trip website
```

The local MVP verifies runtime loopback → LAN → exact NPM Host route → public
HTTPS structured health → rendered page and login controls. Cloud adapters
must provide equivalent private-upstream, exact-host and public-render checks.
A generic HTTP 200 is not evidence.

## 14. Dashboard and future product surface

### Super-admin first

- user/signup/interview/provisioning/activation funnel;
- every trip's lifecycle, owner, release and resource state;
- job timeline, waits, retries, approvals and audit history;
- site/MCP/Hermes/messaging/ingress health and incidents;
- deployment age, schema compatibility and upgrade candidates;
- bounded usage, provider calls and infrastructure/LLM cost;
- plan/confirm actions for retry, suspend, rotate, upgrade, rollback and
  archive.

### Organizer later

The organizer sees only trips permitted by `trip_memberships`: drafts, active
and historical trips, onboarding progress, group/participant controls,
consent settings, reusable preferences and entitled features. Cross-trip
Traveler DNA is user-owned, consented, versioned and provenance-aware; it is
not silently inferred from other travelers' private data.

Future monetization can add subscriptions, premium messaging providers,
retention, analytics/insights, creator features or resource tiers. Usage and
entitlement records should exist early, but billing data and pricing logic are
not required for lifecycle automation.

## 15. Private API shape

Illustrative public operations:

```text
POST /v1/auth/telegram
POST /v1/trips
POST /v1/trips/{tripId}/interview-enrollments
GET  /v1/trips/{tripId}
GET  /v1/trips/{tripId}/onboarding-status
```

Illustrative private/admin operations:

```text
POST /internal/interviews/start
POST /internal/interviews/{sessionId}/confirm
POST /admin/releases/{releaseId}/promote
POST /admin/trips/{tripId}/plans/provision
POST /admin/trips/{tripId}/approvals/provision
POST /admin/trips/{tripId}/jobs/provision
POST /admin/trips/{tripId}/plans/activate
POST /admin/trips/{tripId}/approvals/activate
POST /admin/trips/{tripId}/jobs/upgrade
POST /admin/trips/{tripId}/jobs/rollback
GET  /admin/trips/{tripId}/verification-report
```

Never expose generic shell, URL-fetch, provider-action, YAML-ingest, secret
retrieval or arbitrary profile-configuration endpoints.

## 16. Required tests

- Telegram signup signature/freshness, identity uniqueness and enrollment
  replay/mismatch rejection.
- Cross-user and cross-trip authorization failures on every public/dashboard
  query.
- Plan digest, expiry, single-use approval and idempotency behavior.
- Worker lease expiry/recovery and restart reconciliation.
- Parallel allocation cannot assign duplicate provider resources or logical
  hostname/endpoint identities; the local adapter proves this with VMID/IP/
  domain/port allocation.
- Release builder strips Japan and all secret/runtime artifacts before seal.
- Japan can deploy from the sealed template and complete a compatible
  upgrade/rollback rehearsal.
- Positive-allowlist deployment never packages environment/operator files.
- Trip data and runtime persistence survive runtime-image replacement.
- Two shared-bot test groups route to different Hermes profiles/MCPs with
  negative cross-trip checks.
- Dedicated-bot mode, if enabled, satisfies the same logical contract.
- Public routing exposes only the intended website.
- Monitoring/analytics failures never block trip responses or lifecycle work.
- Registry/log/plan/event secret scanners find no submitted/generated secret
  values.

## 17. Delivery milestones

1. Schemas, PostgreSQL registry, public/private boundary and test harness.
2. Versioned release-artifact builder with Japan qualification, sanitized seal
   and a local Proxmox rendering.
3. Telegram signup plus database-authorized interview enrollment/confirmation.
4. Durable workflow engine and private Python provisioning worker.
5. Per-trip runtime, persistent-data and private verification.
6. Portable Hermes profile/runtime adapter, hosted on Proxmox for the local
   MVP.
7. Shared Telegram router and signed group binding; dedicated mode optional.
8. Separate activation and public multi-hop verification.
9. Super-admin dashboard, monitoring and lifecycle analytics.
10. Upgrade/rollback/completion/archive rehearsal with Japan.
11. Organizer dashboard and monetization features after core automation is
    reliable.

No real organizer trip should be the first proof of any milestone. Japan is
the release and lifecycle fixture until the full evidence chain passes.
