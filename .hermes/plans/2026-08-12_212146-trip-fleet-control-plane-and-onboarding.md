# Trip Lifecycle, Control Plane, and Automated Onboarding — WIP Plan

> **Status: WIP architecture and implementation plan.** This document records
> the intended product direction; it does not authorize a deployment, a live
> infrastructure mutation, or a commit. Refine provider details and acceptance
> evidence as the implementation progresses.
>
> Read with `docs/control-plane-implementation-guide.md`,
> `docs/trip-bot-analytics-and-metrics-design.md`,
> `docs/onboarding-mvp-sprint-plan.md`,
> `docs/kinerary-trip-platform-handoff.md`, and the post-interview enrichment
> plan. Where the older handoff assumes a fixed golden LXC, Mac-hosted control
> plane, or one Telegram bot per trip, this plan records the newer target.

## Goal

Automate the complete trip lifecycle:

```text
website signup
→ super-admin signup approval (MVP)
→ authorized Trip Bot interviewer handoff
→ confirmed, versioned intake
→ enrichment and reviewed provisioning plan
→ isolated trip runtime from a versioned release artifact
→ website + private MCP + Hermes profile + Telegram routing
→ private verification
→ explicit activation
→ active-trip monitoring and administration
→ completion, insights, upgrade/rollback, and archive
```

The first dashboard is super-admin-only. The same ownership model must later
support organizer dashboards, multiple current and historical trips, reusable
traveler preferences with consent, usage insights, entitlements, and billing.
Do not postpone tenant boundaries in the database merely because the first UI
has only one administrator.

## Decisions carried by this revision

### Public product, private authority

The onboarding website and its narrow signup/trip APIs are public. Provider
credentials and infrastructure operations are not. A private worker consumes
approved, idempotent jobs from the control-plane database. No public request,
Telegram message, Hermes tool, or family-group action can invoke arbitrary
shell, Proxmox, DNS, secret, or profile operations.

### Versioned release artifacts; Proxmox is the local MVP renderer

There is no single forever-mutated "golden trip" container. Every approved
Kinerary release produces a provider-neutral immutable release manifest plus
one or more provider-specific rendered artifacts. The local MVP renderer is a
Proxmox LXC template/image:

```text
source release
→ clean runtime build
→ inject Japan fake-trip fixture
→ server/render/MCP/migration/smoke verification
→ remove Japan data, secrets, logs, DB and test state
→ seal release manifest and local Proxmox template/image
→ register release metadata and evidence
```

Japan is the qualification fixture for every artifact, not production content
baked into it. Each trip deployment is pinned to a release ID and an artifact
digest. Old rendered artifacts remain available for compatible rollback and
older active trips until a reviewed retention policy retires them.

The release record must not make an LXC template ID its sole identity. It
contains a generic runtime contract (source revision, dependency lock, schema
range, health/start contract, artifact digest and compatibility evidence),
then records Proxmox template IDs as one provider rendering. A future cloud
renderer may produce an OCI image, VM image or managed-runtime revision for
the same release ID.

Trip data, mutable runtime data, and secrets must be separable from the image
root filesystem so a trip can be rebuilt on a new or previous image without
losing its state. Schema migrations declare forward and rollback compatibility.

### Local Proxmox MVP; portable control-plane contract

Provisioning moves off the developer Mac. The MVP target is a dedicated
onboarding/control-plane LXC on Proxmox, never a service installed directly on
the hypervisor. It hosts the public application/API and private worker as
separately bound processes. PostgreSQL may initially share the LXC but must
have tested backups, standard migrations and a migration path to a managed or
separate PostgreSQL service.

The general architecture does not require Proxmox. It requires a public API,
durable registry, private job runner, secret resolver, release catalog,
compute adapter, ingress adapter, agent-runtime adapter and messaging adapter.
Proxmox/LXC, RPi/NPM/Cloudflare, and local service supervision are the initial
adapter implementations.

The existing `/Users/elul/familytrip-provisioner/` is input to the Hermes
worker design. Move or adapt its validation, profile isolation, duplicate
protection, allowlists, and MCP verification into a supervised Proxmox-hosted
agent-runtime service; do not build a competing profile provisioner.

### Shared Trip Bot, private Super Bot, and organizer-scoped profiles

The design uses two Telegram bot identities and does not require a new bot
merely because a new trip exists.

- a shared **Trip Bot** handles approved onboarding DMs and active trip groups
  through a deterministic router;
- before a trip is established, a signed enrollment routes the organizer to
  the shared intake-only interviewer context;
- after establishment, each group binding selects exactly one trip context;
- each organizer has one long-lived Hermes companion profile that evolves
  across trips, while every message receives a server-issued, trip-scoped
  execution context;
- a separate private **Super Bot**, restricted to the configured application
  owner, reports incidents and exposes narrow plan/approve/execute control-plane
  operations;
- a dedicated per-trip Telegram bot remains an optional policy tier only when
  branding, contractual isolation, platform constraints, or premium packaging
  justifies it.

In a private Trip Bot DM, `/select` lists only trips the organizer owns and
updates one selected conversation context. Group routing ignores that private
selection and always uses the group's durable binding. An organizer may plan a
future trip while a current group continues to use its active trip. Reassigning
a group is a signed, reviewed operation that closes the old binding without
erasing its history.

The router performs identity resolution, lifecycle gating, authorization,
command filtering, rate limiting, exact trip-context selection, and audit
emission before Hermes. Hermes profiles never hold the shared Telegram token
or choose a trip/MCP endpoint from message content. The messaging provider is
an adapter, and lifecycle state records logical bindings rather than BotFather
or token-layout assumptions.

### Data and secret ownership

- `trips/<slug>/` owns confirmed trip content, versioned configuration,
  provenance, and personalization inputs.
- PostgreSQL owns identities, ownership, lifecycle, jobs, approvals, release
  selection, allocated resources, messaging/trip-context bindings, connected-
  service metadata, monitoring summaries, and audit records.
- an external environment/secret store owns architecture settings and all
  credentials. User OAuth grants are tenant-scoped connections in the secret
  store, not architecture settings or trip files. The database stores opaque
  secret references only.
- VMIDs, IPs, domains, provider endpoints, keys, and ports do not belong in a
  trip folder or per-trip wrapper script.
- photos, videos, booking documents, and other binaries live in approved media
  or object storage; trip content stores reviewed metadata and provenance
  references, never binary payloads or OAuth tokens.

## Component architecture

```text
Public ingress
  └─ onboarding web/API
       ├─ Telegram login verification
       ├─ user + trip ownership APIs
       ├─ signed interview enrollment links
       └─ organizer/super-admin dashboard APIs
             │ narrow DB operations only
             ▼
       PostgreSQL control-plane registry
             │ approved/idempotent jobs
             ▼
Private provisioning worker
  ├─ release-artifact adapter ────────────► provider artifact catalog
  ├─ trip-runtime adapter ────────────────► selected isolation runtime
  ├─ Hermes adapter ──────────────────────► long-lived profile per organizer
  ├─ messaging adapter/router ────────────► shared or dedicated bot binding
  ├─ connected-service adapters ──────────► consented import/search/publish APIs
  ├─ ingress adapter ─────────────────────► selected edge/ingress provider
  └─ verification/monitoring adapters

Per-trip isolated runtime
  ├─ version-pinned website runtime
  ├─ private trip MCP
  ├─ persistent trip state/data mount
  └─ supervised services and health endpoints

Trip Context Gateway
  └─ server-issued trip + role + channel + lifecycle capability
       └─ exactly one permitted trip MCP operation
```

The public API and private worker may share code and a database, but they must
not share network exposure or route arbitrary provider actions through the
public process. In the local MVP, the adapters resolve respectively to
Proxmox LXC templates, a dedicated trip LXC, NPM/Cloudflare on the RPi, and a
Proxmox-hosted agent runtime.

## Portability guardrails and hard-to-remove constraints

These are design constraints to satisfy in the MVP. Deferring them would make
cloud migration materially more expensive:

| Constraint | Why it becomes hard later | Required MVP boundary |
|---|---|---|
| LXC-only release identity | A Proxmox template cannot run on cloud container/VM services | Generic release manifest + digest; Proxmox template ID is provider metadata only |
| Host paths/bind mounts as canonical data | Local volumes and `/Users/...` paths do not migrate or scale | Logical data/backup/secret references; database/object-store interfaces |
| systemd/LAN/IP as product contracts | Containers, managed runtimes and service meshes use different lifecycle/network models | Provider-neutral start, readiness, endpoint and ingress contracts |
| Mac-local Hermes profiles | Filesystem profiles and launchd do not provide cloud HA | Agent-runtime API with an organizer profile plus portable policy, memory and trip-context bundles |
| In-memory sessions/router state | Multiple public/API/gateway replicas cause replay and misrouting | PostgreSQL/Redis-backed enrollment, bindings, leases and idempotency |
| Per-trip physical LXC as the only isolation model | Cost and scheduling grow linearly with customer count | `isolation_tier` policy; logical trip isolation remains mandatory |
| RPi/NPM/Cloudflare assumptions | Cloud ingress has different TLS, DNS, routing and identity primitives | Ingress adapter exposes hostname/TLS/upstream intent, not IP-specific commands |
| `.env`/local files as secret source | Secret rotation/audit differ across providers | Secret-reference interface; no values in registry, trip content or plans |

## Lifecycle model

Do not force signup, interview, resource creation, and long-running external
actions into one overloaded status column.

### Trip lifecycle

```text
draft
→ interviewing
→ awaiting_confirmation
→ confirmed
→ provisioning
→ ready_private
→ awaiting_activation
→ active
→ completed
→ archived

Any non-terminal state → failed/remediation_required
active → suspended → active | completed
```

`active` is a trip lifecycle state; it is not the same as the organizer's
selected private-DM context. One organizer profile has one selected context at
a time, but may own a current trip, future drafts and completed history.
`completed` is sealed read-only. `archived` changes retention/visibility and
runtime policy, not the immutability of the completed trip record.

Before `draft`, a verified website identity may be in
`pending_signup_approval` (MVP). This is a signup-request state, not a trip
with interview or provisioning authority. Only a configured super-admin's
signed, expiring, one-time Telegram decision can approve it. Rejection or
expiry creates no usable draft, enrollment, provider resource or job.

### Provisioning job lifecycle

```text
queued
→ planning
→ awaiting_approval
→ running
→ waiting_for_user_action | verifying
→ succeeded

or → failed → remediation_required → queued with a new plan
```

`waiting_for_user_action` covers unavoidable external steps such as pressing
Start on Telegram or creating/choosing a group. It is not an infrastructure
failure. Resource records independently track the LXC, site, MCP, Hermes
profile, messaging binding, group binding, domain, and routes.

## Task 0 — Reconcile contracts and safety boundaries

- Mark this plan and its supporting docs WIP and cross-link them.
- Define versioned schemas for environment configuration, trip content,
  releases, plans, events, connected-service capabilities, organizer memory,
  trip contexts, and provider adapter results.
- Define provider contracts for release rendering, isolated runtime,
  persistent data/backup, secrets, ingress, agent runtime and messaging;
  prove the Proxmox/RPi/Mac replacements implement those contracts without
  persisting local paths or provider-specific assumptions in canonical records.
- Decide the persistent-data mount and backup/restore contract before building
  replaceable runtime images.
- Inventory Proxmox storage/template capabilities read-only. Never infer a
  VMID from an IP address.
- Confirm the target Hermes deployment/runtime topology and the supported
  gateway dispatch hooks before moving profile creation off the Mac.
- Classify the current scripts and `familytrip-provisioner` as reusable logic,
  transitional compatibility, or migration input.

## Task 1 — Release image builder and registry

Create a release pipeline that accepts an immutable source revision, builds a
clean runtime artifact, exercises it with Japan, strips test/runtime material,
seals a generic manifest plus the local Proxmox rendering, and registers:

- release ID, semantic/product version, Git commit and build time;
- provider-neutral artifact digest and runtime contract;
- provider renderings such as Proxmox template/storage identifiers;
- application and persistent-data schema versions;
- compatibility and rollback constraints;
- Japan verification report digest;
- status: `candidate`, `verified`, `available`, `deprecated`, `retired`.

New-trip provisioning must accept a release ID. `available` promotion and
retirement require explicit administrative actions. A failed build never
changes the default release.

## Task 2 — Identity, ownership, and signup

Create PostgreSQL migrations and public APIs for:

- `users` and provider-neutral `user_identities`;
- Telegram login signature/freshness verification and unique Telegram IDs;
- a minimal, rate-limited `pending_signup_approval` request plus transactional
  notification outbox; notify only the configured super-admin Telegram
  identity with signed, expiring, single-use Approve/Reject actions;
- approval atomically creates/unlocks the draft and owner membership; reject,
  expiry, incorrect admin identity and replay are terminal/no-op paths;
- `trips` and `trip_memberships` with owner/organizer/member roles;
- creation of a draft trip owned by the authenticated, approved user;
- future entitlements/subscription references without implementing billing.

The first UI exposes super-admin access and the organizer's own draft/status.
Every query is scoped by membership even while there is only one real admin.

## Task 3 — Authorized interview handoff

Only after signup approval and draft creation, issue a signed, opaque,
expiring, single-use deep link to
the shared Trip Bot's interviewer route. At `/start`, verify that the inbound
Telegram ID:

- belongs to a registered website identity;
- matches the link's user and trip;
- is still eligible to start/resume that intake;
- has not reused or replayed an expired enrollment token.

The interviewer gets only intake-session APIs/MCP capabilities. It cannot
provision, activate, retrieve secrets, or read another user's trip. Literal
`CONFIRM` writes an immutable normalized intake version and digest; later
corrections create a new version rather than rewriting history.

For known-answer questions, the Telegram interviewer uses small,
versioned choice sets rather than asking for free text first. For example,
trip type offers `family`, `group of families`, `couple`, and `other`; `other`
opens a bounded free-text follow-up and is summarized back to the organizer.
Every choice question has an appropriate `other`/`not sure yet` escape hatch.
Persist option ID and schema version plus the literal free-text answer when
used; do not silently force it into an enum.

## Task 4 — Durable workflow engine and private worker

Implement:

- PostgreSQL-backed jobs and steps with leases, heartbeats, retries, and
  idempotency keys;
- plan generation and approval bound to the exact plan digest;
- append-only audit events and structured secret-redacted logs;
- bounded retry policies and explicit `waiting_for_user_action`;
- reconciliation after process/container restart;
- no automatic destructive rollback.

Use Node.js/TypeScript for the public/control API if it best matches the web
application. Reuse Python for provisioning and Telegram adapters instead of
porting proven provider logic merely to enforce one language.

## Task 5 — Per-trip runtime provisioning

After a confirmed intake and approved plan:

1. select an available release compatible with the trip data schema and
   deployment provider;
2. allocate provider-specific runtime/network resources plus logical hostname,
   persistent-data and secret references;
3. instantiate the selected isolation runtime from the provider rendering;
4. attach/restore persistent trip data and inject only approved trip content;
5. inject runtime secrets without copying them into trip data or logs;
6. start the site and private MCP under supervision;
7. verify loopback, LAN, persistent storage, service restart and MCP tool
   isolation before any public route exists.

The deploy package uses a positive allowlist of files. Do not copy an entire
trip directory and try to exclude every secret or operator artifact.

## Task 6 — Organizer Hermes profile, memory, and Trip Context Gateway

Evolve the existing FamilyTrip provisioner into a private agent-runtime
adapter that creates one long-lived profile per organizer, not one profile per
trip. The profile owns a versioned global policy/persona bundle and references
structured, consented organizer preferences and recurring-traveler records.
It does not hold unrestricted credentials for every historical trip.

Add a deterministic Trip Context Gateway. Every dispatch carries a
server-issued capability containing the organizer/profile, exact trip,
channel, requester role, lifecycle state and permitted action family. The
gateway selects one private trip MCP, enforces read/write policy, rejects
caller-supplied trip substitutions, and records safe audit evidence. Group and
organizer-private sessions are isolated so private memory cannot enter a group
response.

Remembered preferences are suggestions with provenance, not automatic input.
Copying a preference or recurring traveler into a new trip requires organizer
confirmation. Raw transcripts and sensitive personal facts are not durable
profile memory. Verification proves cross-trip reads/writes and private-to-
group memory leakage fail.

## Task 7 — Messaging routing and group binding

Build a provider-neutral messaging adapter with Telegram first.

For shared-bot mode:

- distinguish the shared Trip Bot from the owner-only Super Bot;
- store a signed, single-use binding invitation;
- verify organizer identity and Telegram group context;
- map `provider + bot_identity + chat_id` to exactly one trip;
- route onboarding DMs to an intake-only session and established group turns
  to the organizer profile with an exact server-issued trip context;
- support private `/select` using signed, expiring callbacks over owned trips;
- keep private selected context independent from durable group bindings;
- allow reviewed group reassignment while retaining binding history;
- keep group and organizer-private contexts distinct in routing and policy;
- ensure ordinary group chatter is ignored unless the trigger policy accepts
  it;
- verify the shared bot's permissions are no broader than needed.

The Super Bot accepts private updates only from the configured application
owner. It may show redacted incidents and create/approve/retry/suspend/archive
plans, but it has no arbitrary shell, provider-action or secret-retrieval
surface. Profile refinement means a reviewed personalization-bundle update;
it cannot weaken global authorization/privacy policy.

For optional dedicated-bot mode, reuse the same logical interface and lifecycle
states. Do not make managed-bot creation or per-trip BotFather domain setup a
global activation prerequisite when the shared Trip Bot can satisfy the
feature safely.

## Task 8 — Private verification and activation

Private readiness requires stored evidence for:

- selected release and schema compatibility;
- runtime/service health and restart recovery;
- site rendering against the correct trip data;
- MCP readiness/tool discovery and trip isolation;
- Hermes profile isolation and personalization version;
- messaging and group binding;
- required login methods and authorization behavior;
- backup/restore checkpoint.

Only then transition to `ready_private`. Generate a separate activation plan
containing the exact hostname, NPM/Cloudflare changes, verification requests,
and rollback constraints. Activation requires a separate, expiring approval.
Publish only the website; never publish provisioning, admin, secret, SSH, or
private MCP endpoints.

## Task 9 — Dashboard, monitoring, and administrative operations

The super-admin dashboard initially shows:

- signup/interview/provisioning/activation funnels;
- trip and resource state, release version and schema compatibility;
- job history, blocked user actions and safe error summaries;
- site/MCP/profile/messaging health and incidents;
- usage, latency, provider and infrastructure cost summaries;
- plan/confirm operations for retry, suspend, upgrade, rollback, secret
  rotation and archive.

Organizer dashboards later use the same membership model to show only their
trips, history, preferences/Traveler DNA with consent, reusable intake data,
and entitled features. Cross-trip insights must never bypass ownership,
consent, provenance or retention policy.

## Task 10 — Lifecycle analytics

Add `docs/trip-bot-analytics-and-metrics-design.md` as the detailed telemetry
contract. Analytics covers both control-plane lifecycle/product events and
Trip Bot operational events. It is not a transcript archive.

Capture at minimum:

- signup-to-interview and interview-to-confirmation conversion;
- provisioning duration/failure/manual-intervention rates by step/release;
- activation and group-binding completion;
- active-trip site, MCP, Hermes and messaging reliability;
- privacy-preserving bot adoption/category/outcome signals;
- upgrade/rollback success and support burden;
- bounded usage and cost events needed for future entitlements/monetization.

## Task 10A — Connected services and external integrations

Define connected services as optional, consented product capabilities, not
provisioning prerequisites. Foundational records include user-owned service
connections, trip bindings, granted capability levels, opaque secret
references, sync cursors, import jobs, source artifacts, extracted candidates,
publish drafts and review/approval receipts.

Capabilities are separately granted for `select/import`, `continuous_read`,
`write/organize`, `publish`, and `transaction`. Revoking an optional connection
degrades that feature without taking the trip offline. Provider adapters must
use official APIs and preserve source, retrieval time, consent and review
state. Never use scraping, CAPTCHA bypass, browser credential automation, or
undocumented private APIs.

Planned adapter tracks:

- Google Photos Picker and native OS photo pickers for explicitly selected
  media; broader/background gallery behavior waits for the mobile app and
  separate consent;
- Immich albums/assets/search through fine-grained API keys;
- Google Drive Picker for selected booking documents, with Gmail mailbox
  access deferred behind restricted-scope verification and security review;
- Google Places/Maps URLs for place normalization and context; personal Saved
  lists require user export/share/import rather than Maps scraping;
- social-media draft generation first, then explicit preview/approval and
  official publish APIs;
- Booking.com, Agoda, Priceline or other inventory adapters only after partner
  access; start with expiring search offers and provider checkout redirects,
  not autonomous purchase/payment.

Imported booking/place/photo facts are reviewable candidates before they alter
trip content. Media and documents stay outside Git; the trip stores portable
metadata and provenance references.

## Task 11 — Upgrade, rollback, completion, and archive

- Active trips stay pinned until an approved upgrade plan selects another
  compatible image.
- Upgrade rehearses data migration, health and rendered UI before cutover.
- Rollback uses an available compatible prior image and a verified data
  checkpoint; it never assumes database downgrades are safe.
- Completion stops proactive live-trip automation, seals a final trip-data
  digest and makes trip-domain mutations fail at the API/gateway layer, not
  merely by prompt. Historical corrections are separate annotations or
  reviewed knowledge candidates.
- Archive revokes runtime credentials/routes according to policy while
  retaining or deleting trip data according to organizer consent and legal
  requirements. Revisiting or unarchiving changes visibility/access, never the
  completed trip's read-only status.

After completion, offer a separate organizer-authorized debrief. It collects
choice-first ratings and review outcomes for sites, corrections/additional
site facts, and discovered or recommended locations. Every item is versioned
with trip, source, author role, consent, confidence and review status.
Chat-derived discoveries require explicit per-trip organizer consent and are
stored only as redacted, reviewable candidates; they never automatically
change current-trip data, a shared catalog, or cross-trip recommendations.
Organizer approval is required before promotion, and consent revocation
governs unreviewed-candidate deletion/retention.

## Task 12 — Japan end-to-end release and lifecycle rehearsal

Japan is the only initial full-system fixture. Test both image creation and a
fresh deployment from the sealed image:

```text
website test signup
→ super-admin test approval
→ authorized interview link and replay
→ literal CONFIRM
→ plan/approval
→ new runtime from candidate image
→ private website/MCP/Hermes/messaging verification
→ test group binding
→ activation against a non-production hostname
→ monitoring/analytics reconciliation
→ upgrade to a second candidate image
→ compatible rollback
→ completion/archive rehearsal
```

Do not use an unconfirmed real intake as a fixture and do not route Japan to a
production hostname or real family group.

## Acceptance criteria

1. A registered Telegram identity cannot create a usable draft or access an
   interview until the configured super-admin approves its signed, expiring,
   single-use signup request. Wrong-admin, replayed, expired and rate-limited
   requests fail; after approval it can access only its own interview/trips,
   and replayed or mismatched enrollment links fail.
2. Public endpoints cannot invoke provider actions or retrieve secrets.
3. A verified release image contains no Japan data, credentials, logs, DB or
   runtime state, yet a Japan deployment from it passes the full test suite.
4. Repeating a job does not duplicate a runtime, profile, messaging binding,
   route, domain or secret.
5. A shared Trip Bot can route two test groups through one organizer profile
   with different server-issued trip contexts and isolated sessions, without
   cross-trip access or private-memory leakage. Private `/select` does not
   change either group binding. Dedicated-bot mode is optional, not assumed.
6. A trip cannot become `active` before private verification and separate
   activation approval both succeed.
7. Registry, logs, analytics and dashboards contain no plaintext secrets or
   raw message transcripts by default.
8. Restarting the onboarding worker resumes or reconciles work without losing
   durable state or claiming false success.
9. A trip can remain pinned to an older artifact while another trip uses a
   newer release; a compatible Japan upgrade and rollback are demonstrated.
10. Super-admin queries are globally authorized and organizer queries are
    membership-scoped from the first schema version.
11. Connected-service tokens never enter trip folders, plans, logs or database
    values; revocation, cross-trip binding attempts, stale imports and
    unapproved publish/transaction actions fail safely without disabling the
    core trip.

## Explicitly deferred, without blocking the schema

- billing provider and pricing plans;
- organizer-facing historical insights and Traveler DNA UX;
- additional messaging providers;
- connected-service implementations beyond the foundational capability,
  consent, provenance and secret-reference schemas;
- broad Gmail synchronization, automatic photo-library scanning, social
  publishing and travel purchases;
- high-volume queue/analytics infrastructure;
- fully automatic release promotion;
- cross-trip recommendations beyond consented, provenance-aware aggregates.

These are deferred product features, not permission to omit user ownership,
release IDs, usage events, entitlements references, or privacy boundaries from
the foundational model.
