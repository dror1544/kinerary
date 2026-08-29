# MVP Onboarding Implementation Plan — Local Hosting

**Status:** Proposed implementation plan. This plan is intentionally local-MVP
first, but its records and interfaces must comply with the portable
control-plane contracts in `control-plane-implementation-guide.md`. It does
not authorize deployment, live provisioning, or a commit.

**Outcome:** a registered organizer can sign up, complete a protected Telegram
interview, explicitly confirm the intake, approve a provisioning plan, and
receive a working private trip URL — without editing JSON, accessing the
repository, or running deployment commands. Each boundary is independently
testable before it is connected to the next one. Sprint 4 is the sprint whose
exit gate proves this end-to-end. Sprint 4.5 makes the generated site actually
useful (destination data, itinerary, map); Sprint 4.7 hardens the provisioning
path once it has run for real. Sprints 5–7 extend the live trip experience.

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

### Standing requirement — reachable through the real entrypoint

**No sprint is complete while its feature exists only under test.** A suite
that builds the application itself, injecting its own dependencies, proves the
feature works but not that anything assembles it in the process that actually
runs. Sprint 1 passed 81 tests with every signup route returning `503` in a
real deployment, because `server.ts` never constructed the signup dependency
block; nothing in the suite looked at the real entrypoint, so nothing failed.

Every sprint that adds a route, adapter or startup dependency therefore owes:

- wiring in the real entrypoint (`api/src/server.ts` or the worker's `__main__`),
  resolving whatever secrets and adapters it needs from the architecture
  profile — not just in a test's dependency object;
- a boot-level test that spawns that entrypoint as a process and asserts the
  new surface answers (`api/test/server-boot.test.ts` is the pattern), together
  with the negative case proving the assertion can fail;
- a startup failure, not a request-time failure, when a required secret or
  adapter is missing — a half-configured process must not accept traffic.

Sprint exit gates below are read as including this requirement; it is stated
once here rather than repeated in each.

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

### Sprint 4 — Provisioner: intake-to-trip and end-to-end onboarding

**Goal:** complete the vertical acceptance test — transform a confirmed,
approved intake into a running private trip, with a working URL delivered to
the organizer and basic family access. No JSON editing, no repository access,
no deployment commands required from the organizer or family.

This is the sprint whose exit gate is the product-alignment acceptance test
from the PR #10 comment (2026-08-20). Release-artifact hardening (immutable
build pipeline, sanitation scans, sealed manifests, promotion rules) is
deliberately deferred past this gate; the first provisioning run uses the
existing Kinerary deploy infrastructure against a test allocation.

Build:

- **Seed a development release record** so `generatePlan` (Sprint 3) can
  select a compatible release and the Sprint 3 exit gate can actually run. One
  migration or seed script is sufficient; no release-build pipeline yet.
- **Complete the minimum usable intake** — extend the interview schema before
  transformation so it captures exact travel dates and timezone, traveler
  roster and basic roles, hotels/location changes, flights/reservations/fixed
  anchors, and important mobility, dietary, budget and family constraints.
  Keep optional detail out of this gate. A confirmed intake must contain enough
  information to create a useful initial trip rather than only a deployed
  shell.
- **Immutable confirmed-intake snapshot** — store or address the exact
  normalized answer payload represented by each `intake_versions` row. The
  transformer must read that immutable version, not mutable
  `intake_sessions.answers` state indirectly. Its digest must verify before
  planning or transformation.
- **Intake transformer** — reads the confirmed immutable intake version and
  produces a valid `trip.config.json` using the existing Kinerary schema.
  Validate the output against the existing schema before writing. Store only
  the logical config; no VMIDs, IPs, or paths.
  - **`trivia_questions.json` is descoped** (decision 2026-08-28, reviewing the
    first pipeline-built site): the interview collects nothing that feeds
    trivia, and generating it deterministically from destination + phase names
    would be thin filler, not the "who remembers this from the last trip"
    content the feature is for. The provisioner now writes an empty
    `trivia_questions.json` (`[]`) so `server.js` stops logging a
    missing-file error on every boot; real trivia can come from a later
    enrichment/debrief pass or the `create-trip` path, not this transformer.
- **`bookings.json` from the intake** (added 2026-08-28) — `travel_anchors[]`
  (dated activity tickets, a tour proposal) and each phase's accommodation were
  captured by the interview but dropped by `transform_intake` (anchors became a
  single Hero stat number). `derive_bookings()` now projects both into a
  `bookings.json` sidecar, every row `confirmation: null` unless the intake
  carried one, so the site's Bookings tab has real, if unconfirmed, content.
- **Provisioner worker** — implements the job worker that claims an approved
  provisioning job, invokes the intake transformer, and deploys a private trip
  instance using the existing `kinerary-deploy` infrastructure. Records the
  working private URL as part of the job result (non-secret; the URL itself is
  not a credential). Marks the job `succeeded` and the trip `ready_private`.
- **Organizer notification** — on success, sends the working private URL to the
  organizer via Telegram. Tests use the fake adapter, but a real delivery path
  is mandatory in this sprint because receipt of the URL is part of its exit
  gate; it cannot remain deferred to Sprint 5.
- **Family access path** — create a revocable invite link using the existing
  Kinerary authentication model. Redeeming it creates or confirms the scoped
  trip membership; it must not expose another trip or grant organizer/admin
  authority. The acceptance test must open the site as an invited family
  member, not only as the organizer.
- **Intake correction path** — when corrections are needed after confirmation,
  creates a new intake version (never edits the confirmed one) and requires
  re-planning. The existing plan is invalidated; a new plan must be generated
  and approved. For this gate, provisioning the replacement from the newly
  approved plan is sufficient; automated in-place upgrade of the existing
  runtime is explicitly deferred so it cannot delay the first successful
  family onboarding. This closes the open item from the PR #10 product
  comment.
- **Failure recording** — provisioner worker records safe error codes and
  manual-intervention notes on failure so operational gaps are visible.

Automated tests:

- the interview captures the minimum usable dates, timezone, roster, stays,
  anchors and constraints, and its confirmed immutable snapshot verifies
  against the stored digest;
- intake transformer produces a `trip.config.json` that passes the existing
  Kinerary schema validation for each major field type in the Japan fixture;
- transformer rejects an incomplete intake (missing required fields) rather
  than producing a schema-invalid config;
- provisioner worker happy path: approved job → intake transformed → deploy
  called → job marked `succeeded`, trip marked `ready_private`, URL recorded;
- provisioner failure path: deploy step fails → job moves to
  `waiting_for_user_action`, trip reverts, URL is not recorded;
- intake correction path: POST on a confirmed intake creates a new version;
  the old confirmed version is unchanged; the existing plan is invalidated;
- organizer notification is sent exactly once through the real delivery path
  on the manual acceptance run, and not on failure;
- a revocable family invite can be redeemed once to open the correct trip as a
  family member without receiving organizer privileges.

Manual tests / acceptance test:

  Run the full acceptance test defined in PR #10 (2026-08-20):
  1. Unknown family signs up via Telegram → organizer receives approval request.
  2. Organizer approves → family receives enrollment link.
  3. Family completes the onboarding interview and sends `CONFIRM`.
  4. Organizer generates a plan, reviews it, and approves it.
  5. Provisioner runs → organizer receives working private URL via Telegram.
  6. An invited family member redeems the revocable invite and opens the URL —
     the correct trip site loads with family-level access, no JSON or repo
     access needed.
  7. Test one correction: family requests a date change → old confirmed version
     remains unchanged → new intake version → organizer re-plans and
     re-approves → replacement provisioning succeeds. Automated in-place
     runtime upgrade is not required for this gate.

Exit gate: **the acceptance test above passes end-to-end against the test
allocation, with a non-production hostname and test Telegram identities.** A
previously unknown family completes onboarding, the organizer approves both
gates, a valid Kinerary trip is generated from the intake, an isolated instance
is provisioned using the existing deploy infrastructure, and the family
receives a working private URL without editing JSON, accessing the repository,
or running deployment commands. Failure and correction paths are both
demonstrated and recorded.

_Deferred past this gate (original Sprint 4 scope):_ immutable release-artifact
renderer, sanitation scans, sealed manifests, release promotion pipeline
(`candidate` → `available`), and dedicated compute/persistent-data/secret
adapters. These now live in **Sprint 4.7 — Provisioning hardening**, alongside
the operational recovery gaps the first end-to-end run surfaced.

### Sprint 4.5 — Trip content enrichment (destination data, itinerary, map)

**Goal:** close the gap found reviewing the first real control-plane-provisioned
trip (2026-08-23, confirmed again 2026-08-28/29): `transform_intake()` produces
a schema-valid but visually thin config — no destination info, no per-phase
day-by-day, an empty map tab. Turn a deployed shell into a site trip members
find useful.

This is not a new idea. `.agents/skills/create-trip/` (the older, human-driven
scaffolding path) already does the deterministic half every time it runs — see
`INTERVIEW.md` §4 and `scripts/country-info.js` (keyless lookups against
`countries.dev` + `emergencynumberapi.com`, producing `travel_info.countries[*]`
shape). `.hermes/plans/2026-08-06_063428-post-interview-enrichment-and-provisioning.md`
(never implemented) scoped the geocoding/weather/hero-photo half. Neither
reached the control-plane pipeline. The itinerary/anchor/narrative work is new
territory both prior plans left open; the execution point is now decided —
**at intake, via the shared `kinerary-extract` Hermes profile**, with a
deterministic post-processing layer enforcing invariants (below).

**Scope**, every item tagged: `built` (on the branch) · `follow-on` (defined,
deferred past this sprint, no open product decision) · `separate build` (real,
out of 4.5).

As of 2026-08-30 every item below is `built` except one low-visual residual
(`follow-on`): **prose anchor extraction**. The `separate build` (site
live-plan enrichment worker) stays out of 4.5.

| Item | Tag | Notes |
|---|---|---|
| Deterministic destination data | `built` | `control_plane_worker/enrichment.py` `enrich_config`, wired as `ProvisionerWorker(enrich=…)` — live from `__main__`, no-op passthrough in tests. `countries.dev` → currency / calling code / capital / flag; a static `_EMERGENCY_BY_ISO` table + EU-112 bloc (`emergencynumberapi.com` is dead — domain reassigned, all `/api` 404); Nominatim → `phase.mapStop {lat,lng}`; Wikipedia REST summary → `phase.hero.photo` (en title → en.wikipedia, he-only → he.wikipedia). Every lookup self-guards: a miss leaves that slice of the config alone; an enrichment failure never fails the provision job. `_KNOWN_COUNTRY_CURRENCY` kept as the offline fallback. |
| Bookings from the intake | `built` | `transformer.derive_bookings()` → `bookings.json` sidecar. `travel_anchors[]` + each phase's accommodation, `confirmation: null` unless the intake carried one. Anchor `type` maps into the site's `CHECK(type IN ('flight','hotel','car','attraction','other'))`; an anchor with no resolvable phase parks on phase 1 (`bookings.phase` is `NOT NULL`). |
| Trivia | `built` (descope) | Empty `trivia_questions.json` (`[]`) sidecar so the trip server stops logging a missing-file error every boot. No content generated; real trivia can come from `create-trip` or a later debrief pass. |
| **Itinerary from an uploaded plan document** | `built` | Extracted at intake into an optional `phases[].days[]` field (`extract_itinerary` MCP tool → `kinerary-extract`), sanitised to plain text, projected through `transformer._normalise_days`. Repeated phase names resolved per-day by date range. Spec below (§4.5-i). Verified on japan-2026. |
| **Map tab: phase pins + click-to-summary** | `built` | Root cause was the missing top-level `map`: `initMap` fell back to `setView([30,10], 3)` so the pins sat off-screen. `enrichment._build_map` now emits `center` (centroid), `zoom` (from bounding-box span), `stops[]` from the phase `mapStop`s; `site/app.js` hardened (emoji default on the `map.stops` branch, `buildMapPopup` skips absent fields instead of printing `undefined`). |
| Accommodation location (Maps/Waze/address) | `built` | `_add_phase_nav` sets `accommodation.maps` / `accommodation.waze` as **name searches** (`.../maps/search/?...&query=<hotel name>, <city>` and `waze.com/ul?q=…`) — Google/Waze resolve a hotel name far better than OSM, and coordinate templating on a shaky geocode drops the pin in the wrong district (the OMO3 Asakusa bug). `enrich_config` still geocodes the hotel name for the map *pin* (`phase.mapStop`) + `accommodation.address` (Nominatim `display_name`), city-centre only when it misses — but the links no longer depend on that succeeding. Matches the hand-built trips (`kinerary-deploy/trips/los-angeles-hawaii-vegas-2026`: `accommodation.{maps,waze,address}`). |
| Per-venue location + **ticket/official links** | `built` | `extract_itinerary` returns `venues[]` per phase — the real map-pointable places the source document names (not rail passes / ticket bundles). A venue's `url` comes from the document when it prints one; otherwise `extract_itinerary`'s `resolveVenueLinks` step **web-searches** for the first-party/ticket site (`HERMES_SEARCH_PROFILE`, falls back to the consular profile; skipped if neither is set, never guesses a domain). `transformer._normalise_venues` projects `phases[].venues[]` = `[{id, name:{he,en}, url?, area?}]`; `enrichment._enrich_venues` adds name-search `maps`/`waze`. The site renders a card per venue (rating + 🗺️/🔵/🎫 buttons) — `loadRatings` now renders `VENUES[phase.id]` for config-driven phases (previously only the removed static HTML). Mirrors the hand-built `venues[]` (`{id, name, name_he, url, area}`) in `kinerary-deploy/trips/japan-2025`. |
| Consular / embassy contacts (`travel_info.emergency_contacts`) | `built` | Migration 0023 `country_reference` keyed `(destination_country, home_country)`. `interview-mcp` `lookup_consular_contacts` checks the store, then runs a host-side web search (`HERMES_CONSULAR_PROFILE`) on a miss and writes back. `enrich_config` takes an injected `consular_lookup`; `__main__` wires a read-only query. `home_country` from `meta.home_country`, Israel default. japan/israel row seeded from the real listing. |
| 7-day weather per phase | `built` | Open-Meteo is keyless and the site already fetches it client-side. `enrichment._add_phase_nav` sets `phase.mapStop.weatherKey` (and `accommodation.weatherKey`) to the phase id, which is all `site/app.js` needs to fire its own forecast call at render time — never baked into the config, never stale. |
| Anchor extraction from phase prose | `follow-on` | Promote a dated event buried in a phase `name`/`note` into a `travel_anchors[]` entry. Now largely covered: a document's dated events land in `phases[].days[]` via `extract_itinerary`, and text trimmed from a phase name is kept in the `phase.note` blurb. The residual — date-parsing an organizer's typed phase name — is low value and regression-prone; deferred. |
| Phase narrative blurb | `built` | `transformer._phase_note_text` writes a readable blurb ("4 nights in Tokyo, 6 Sep–10 Sep. Staying at …. 3 days planned") with any trimmed name context as a trailing clause, replacing the raw concat. |
| Persist the raw uploaded document | `built` | Migration 0024 adds `intake_sessions.source_document` + `intake_versions.source_document` (jsonb `{filename,text,savedAt}`). `POST /v1/interview/:id/source-document` stages it; `extract_itinerary` forwards the document after extracting (best-effort); `confirmIntake` copies session → version. Sibling column — outside the `data` canonical-safety CHECK and the digest. |
| Structured budget | `built` | Optional `budget_detail` structured question → `transformer._derive_budget` projects `config.budget` (`party_size` / `phases` / `phase_labels` / `seed_items`), the shape `server.js` seeds `budget_items` from. Categories validated to the site's set; `amount 0 + estimate` → a "fill-in" row; `seed_key` stable for idempotent re-seed. No `INTAKE_SCHEMA_VERSION` bump (additive-optional). |
| Site live-plan enrichment worker | `separate build` | The trip site already has the DB hooks — `phase_plan_items` / `phase_plan_days` with `enrichment_status` (`none/pending/done/failed`), `review_status`, `config_ref` dedup, day-headline correction trail. A worker that calls a model post-deploy to detect ticketing needs, re-enrich, and feed the in-app review queue is its own sprint, not 4.5. |

#### §4.5-i. Itinerary-from-document spec (`this step`)

- **Schema.** `phases[]` intake items gain an optional `days` key. **No
  `INTAKE_SCHEMA_VERSION` bump** — `validateAnswer` only shape-checks structured
  answers (array vs object), so item keys pass through untouched; a `phases`
  entry with no `days` transforms byte-identically to today, the same rule that
  lets a v1 intake ride a v2 release. `days` shape mirrors the site's config
  contract exactly, so `site/app.js` `renderDays` and the
  `/api/phases/:id/plan/promote` `config_ref` path consume it unchanged:
  `{ date: "YYYY-MM-DD" (inside the phase range), label: {he,en} (plain text),
     items: [{ time: "HH:MM"|null, text: {he,en} (plain text) }] }`.
- **New tool `extract_itinerary`** on `control-plane/api/src/interview-mcp.ts`,
  next to `submit_answer`. `extract_itinerary({ sessionToken, phases,
  pdf_base64 | document_url | document_text })` →
  `{ ok: true, phases: [{name, days:[…]}], warnings:[…] }` or
  `{ ok: false, reason: "EXTRACT_NOT_CONFIGURED" | "EXTRACTION_FAILED" }`.
  Implementation mirrors `mcp/mcp.js`'s `/extract` (lines ~589–760): `pdf-parse`
  → text capped ~20 000 chars; prompt built fresh from the passed `phases` (ids
  + date ranges) + destination + session roster; `execFile(HERMES_BIN, ['-p',
  HERMES_EXTRACT_PROFILE, 'chat', '-q', prompt, '-Q', '--safe-mode',
  '--reasoning', 'none'])`, ~60 s timeout, `execFile` not `exec` (document text
  is one argv entry, never shell-interpolated). Reuses the existing shared
  `kinerary-extract` profile (no tools, no memory — already used by Add-Booking).
  Any failure ⇒ `{ ok: false }`, never a throw.
- **Deterministic post-processing in the tool** (model extracts structure, code
  enforces invariants): drop phase blocks whose `name` ∉ the passed ids; drop
  days whose `date` is unparseable or outside the phase range (→ `warnings`);
  mirror the present side when one of `he`/`en` is missing, drop an item only if
  both are empty; coerce a non-`HH:MM` `time` to `null`; **strip every `<…>`
  and re-expanding entity from every `label`/`text`.** `renderDays` sends config
  `days` text through `_biSpan`, which emits raw HTML (deliberate for
  hand-authored config — `server.js:2879` says so), so unsanitised model output
  there is an XSS sink. `--safe-mode` + the no-tools profile handle injection
  *into an agent*; this handles injection *into the page*.
- **Interviewer workflow** (`.agents/skills/trip-intake-interviewer/SOUL.md`
  step 3, `…/references/QUESTIONS.md` phases section): after `phases` is
  captured, if a document was uploaded, call `extract_itinerary`; summarise the
  result back conversationally; on confirmation, fold `days` into each phase
  entry and re-`submit_answer("phases", …)` (a pre-CONFIRM correction is already
  normal). `{ ok: false }` or no upload → proceed with no `days`. **Never
  blocks CONFIRM.**
- **Transformer** (`transformer.py` `_derive_phases`): read `raw.get("days")`,
  keep only well-formed days, normalise to the site shape, attach `phase["days"]`
  only when non-empty; adjacent same-named merged phases concatenate their
  `days`. No `days` → output unchanged.
- **Digest.** `days` is inside the `phases` answer → part of
  `computeIntakeDigest` → part of the plan digest. Editing the itinerary
  post-CONFIRM = a new intake version through the existing `intake/correct`
  path → re-plan. No new mechanism.

**Automated tests (`this step` + already built):**

- a known destination gets a `travel_info.countries[*]` entry with real
  currency/emergency data, HTTP layer faked (the way `country-info.js` itself is
  never tested against the live APIs) — *exists*;
- an unrecognized/unreachable destination degrades to no `travel_info` entry and
  no crash — enrichment failure must never block deployment — *exists*;
- an intake whose document describes a multi-day plan produces
  `phases[].days[]` that is date-correct (every `date` inside its phase),
  bilingual, and **plain text** (an HTML payload in the source is stripped);
- an intake with no document, or a failed extraction, produces the same config
  as today and does not block CONFIRM;
- the top-level `map` object is emitted with a `center`/`zoom` and one `stop`
  per geocoded phase.

Exit gate: a confirmed intake whose uploaded document describes a real
multi-day plan produces a `trip.config.json` with populated `travel_info`,
per-phase `days[]` the site renders on the phase pages, and a map tab that shows
a pin per phase with a summary on click — with graceful degradation (no `days`,
no `map` beyond what geocoded) when the inputs aren't there, and no human
patching the output afterward.

### Sprint 4.7 — Provisioning hardening

**Goal:** turn the provisioning path from "works once you know the manual
recovery steps" into "recovers itself", and finish the release-artifact work
Sprint 4 explicitly deferred.

Build — **operational gaps found in the Phase H run** (each needs a hand DB
edit or a destroy-and-recreate today):

- **Provisioning-retry endpoint.** A terminal/failed job leaves the trip
  wedged; re-planning the same intake hits `plans_trip_id_digest_key` (identical
  intake + release ⇒ identical digest) → `PLAN_ALREADY_PENDING`. Every retry
  during Sprint 4.5's live work needed a manual cleanup — delete the dead plan,
  its `plan_approvals` row and its job, then reset `trips.lifecycle_state`. This
  wants a first-class endpoint that supersedes the old plan/job and generates a
  fresh one, and (for a live trip) does so with `first_provision = false` so
  the container's seeded users survive.
- **`ready_private` is not in `CORRECTABLE_STATES`.** Re-provisioning a live
  trip currently needs a manual `UPDATE control_plane.trips SET
  lifecycle_state='intake_confirmed'` before `intake/correct` or `generatePlan`
  will run. Either add the state to the set, or route re-provision through the
  retry endpoint above with no lifecycle hop.
- **Job lease (600 s) is shorter than the bootstrap ceiling (900 s), with no
  heartbeat.** Harmless while a real bootstrap takes ~140 s, but a hung one
  outlives its lease and can be double-claimed. Add a heartbeat, or make the
  lease cover the ceiling.
- **`_bootstrap_app_environment` only runs inside `create()`.** `apply()` is
  inspect-then-create, so a container that exists but is half-built is never
  repaired — the only recovery is destroy and recreate. Make the bootstrap
  idempotent and callable against an existing container.
- **Worker should mint its own NPM token.** `NPM_API_TOKEN` in
  `provisioning.env` is a ~1-day JWT; a provision run after it expires 401s at
  the NPM step (hit twice during 4.5 work). The worker holds
  `NPM_IDENTITY`/`NPM_SECRET` — it should exchange them for a JWT at job time.
  (Related, already mitigated: `provisioning.env` must set every
  `PROXMOX_*`/`RPI_*` explicitly because `compose.local.yml` passes each as
  `${VAR:-}` and an empty string beats the code's own default — keep the
  caveat.)

Build — **release-artifact hardening** (moved here from Sprint 4's "Deferred
past this gate" note and §5):

- immutable release-artifact renderer (build pipeline, sanitation scan, sealed
  manifest); release promotion rules (`candidate` → `available`); dedicated
  compute / persistent-data / secret adapter abstractions.

Automated tests:

- a terminally failed provision recovers to a fresh queued job through the
  retry endpoint with no database edits, and a re-provision of a live trip
  keeps its users (`first_provision = false`);
- a stale lease / worker restart mid-bootstrap reconciles to exactly one
  logical provision, never two;
- bootstrap run twice against the same container is a no-op the second time;
- a sealed release artifact renders, passes the sanitation scan, and promotes
  `candidate` → `available`; a plan cannot select a `candidate` release.

Exit gate: a failed provision is recovered through a documented endpoint with
no manual DB changes; a worker restart mid-bootstrap does not double-provision;
a sealed, scanned release artifact is promoted and selected by the planner.

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
- **Known gap, surfaced during the Phase H live acceptance test (2026-08-26):**
  fold the standalone `trip-intake` interviewer profile into the same shared
  Trip Bot router this sprint already builds, instead of it staying a
  separate bot/profile. Route an inbound chat to interviewer mode whenever
  its chat ID isn't yet bound to a trip (`telegram_chat_bindings` — migration
  0019); once bound, route to that trip's companion as normal. The companion
  profile for an *existing* organizer must also be able to re-enter interview
  mode when they start a new trip, rather than requiring a second bot/profile
  for every additional trip. Until this lands, an organizer's real Telegram
  chat id for notification delivery can only be captured verified-server-side
  at `/v1/signup` itself (Telegram Login Widget) — the interview conversation
  has no reliable, server-verified way to learn its own chat id, so
  `interview.ts`'s `telegramChatIdHint` (migration 0022) is necessarily an
  LLM-relayed, unverified value in the meantime, not a substitute for this.
- **Interview UX and correctness** — the batch of interview-side issues from the
  first live signup run (`docs/signup-test-execution-capture (Manual).md`'s
  status ledger: General #1–4, Step 2 #1–3, Step 3 #1–13). Folded here because
  this sprint already rebuilds the interviewer as a router mode. In scope:
  - localise `clarify` option labels to the organizer's language — they render
    in Hebrew regardless today (General #3);
  - drop the "(Recommended)" tag on constraint-type answers — dates, headcount,
    organizer identity — where a recommendation is meaningless (Step 2 #3b,
    Step 3 #2); buttons only, no numbered list echoed in the message text
    (Step 3 #1);
  - derive headcount from the traveler roster instead of the separate confusing
    `group_size` question; derive duration from the dates where they're known
    (Step 3 #3, #4);
  - allow multiple planned-order answers, with a flight-details option on flight
    days (Step 3 #8);
  - let the interviewer read a pasted link / scrape a page without prompting the
    organizer for approval (Step 3 #5, #6);
  - say plainly that day-by-day itinerary help lives on the trip bot and this
    interview is for structure (Step 3 #10);
  - prompt for the English spelling of non-Latin traveller names — the
    transformer already honours `name_en`/`family_en` when supplied (Step 3 #13);
  - LLM-parse an answer that doesn't parse deterministically, carry extra detail
    forward to later questions, and reconcile the spoken end-summary against the
    stored intake after CONFIRM (General #4); also fix `derive_trip_slug`'s
    `"trip"` fallback to use the first phase name before a generic word;
  - close the post-CONFIRM dead end with a link to the site / bot (Step 3 #11 —
    same root as the router work above);
  - **two bugs to reproduce and fix**: the dietary step threw an error
    (Step 3 #7); schedule/planned-order failed to submit (Step 3 #9).
  Out of scope, homed elsewhere: per-user Telegram info-message logging
  (General #1) → Sprint 6 analytics; driving the approval gates from the Hermes
  profile via MCP (Step 3 #12) → exploration, unscheduled.

Automated tests:

- organizer-profile bundle versioning, structured memory consent and Trip
  Context Gateway scoping;
- `clarify` option labels render in the organizer's language; headcount is
  derived from the roster with no separate `group_size` prompt; the dietary
  step and a planned-order submission both succeed (regressions for Step 3
  #7 / #9);
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
- Emit the assistant-experience **outcome** events defined in
  `trip-assistant-experience-metrics.md` — grounded, partial and
  missing-data answers, unanswered group mentions, organizer follow-up
  requested/answered, post-write verification passed/failed — inside the base
  event schema in `trip-bot-analytics-and-metrics-design.md` §5, not as a
  second vocabulary. Derive response rate, grounded-answer rate, missing-data
  rate, traveler self-service rate and post-write trust rate from them, grouped
  by trip, phase, day, channel, user role and topic so a quality problem can be
  attributed to platform reliability, website data gaps, organizer workflow
  friction or assistant behaviour.
- Add the daily control-plan report to the dashboard: usage, value delivered,
  information quality, learning and enrichment, and organizer enablement —
  including the top missing items to request and the traveler value each one
  unlocks.
- Implement the missing-information control loop: detect a missing fact while
  answering, convert it into a focused organizer request naming the smallest
  artifact that unlocks the most value, and track whether the request was
  fulfilled.

Automated tests:

- a trip cannot become active when any required evidence is missing;
- activation approval replay/expiry and failed ingress verification leave the
  route unpublished and state non-active;
- health/analytics events are tenant-scoped, bounded and transcript-free;
- the daily report and every derived rate are computed from recorded bounded
  events, never from sampled transcript text, and a trip with no traffic
  renders an empty report rather than a divide-by-zero or a fabricated rate;
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
- Score the completed trip against the six weighted dimensions in
  `trip-assistant-experience-metrics.md` — availability, website
  data completeness, accuracy and cross-channel consistency, operational value,
  group experience, and learning/enrichment — producing the 1–5 top-level score
  from the documented weights. Each row carries the evidence behind it, an owner
  and the next improvement.
- Attribute every dimension to what the system controlled, what the organizer
  controlled and what travellers experienced, per the skill's Core Principle. A
  score must not blame the platform for an artifact the organizer never
  supplied, nor credit it for one the organizer supplied unprompted.
- Measure repeated-question reduction across the trip: once a fact, link or
  document enters the source of truth, the rate of the questions it answers
  should fall. This is the enrichment loop's outcome measure and needs the
  Sprint 6 outcome events to compute.

Automated tests:

- completed-trip mutation fails through both direct API and agent gateway;
  selecting/unarchiving it permits read-only access only;
- a configured-but-undelivering assistant cannot score well on availability,
  and an answer that explains missing data the system should have held is not
  scored as accurate; a dimension the organizer owns does not lower the
  platform's score; repeated-question reduction is computed from recorded
  events and is absent, not zero, when the trip has too little traffic;
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

The release-hardening work originally scoped for Sprint 4 — the immutable
release-artifact renderer (build pipeline, sanitation scan, sealed manifest),
release promotion rules (`candidate` → `available`), and dedicated
compute/persistent-data/secret adapter abstractions — is now **Sprint 4.7 —
Provisioning hardening**, which runs after the first successful end-to-end run
proves the vertical path. The Sprint 4 acceptance test deliberately uses the
existing `kinerary-deploy` infrastructure and a seeded development release
record until then.

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
