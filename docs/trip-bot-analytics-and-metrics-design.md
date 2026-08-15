# Kinerary Lifecycle and Trip-Companion Analytics — WIP Design

**Status:** Work in progress. This document does not authorize enabling
production telemetry, changing Hermes or messaging configuration, installing
collectors, or exposing a dashboard.

**Goal:** Measure the complete trip-product lifecycle—from signup and interview
through provisioning, activation, live companion usage, upgrade/rollback and
completion—while minimizing personal data, avoiding transcript collection and
keeping analytics off every synchronous user path.

---

## 1. Product Goals

The analytics system should answer, for every trip and across all trips:

- How many verified users create a draft, open the interview link, confirm an
  intake, reach private readiness, activate and complete a trip?
- Where does onboarding wait, fail or require manual intervention, and which
  release/provider step caused it?
- Which release artifact and provider rendering is each trip running, and how
  reliable are builds, upgrades and compatible rollbacks?
- How many real requests reach the bot each day, week, and trip phase?
- Was the request from the **organizer**, a **group participant**, or an unknown/other authorized role?
- Did it arrive in a **private organizer DM** or the **family group**?
- What was it about: logistics, itinerary, food, attractions, transport, accommodation, emergency/support, site help, trivia, administrative action, or another category?
- Did Hermes answer successfully, require tools, fail, time out, get blocked by policy, or need organizer follow-up?
- How long did it take to respond, and how often did the user send another message shortly afterward (a useful friction proxy)?
- Which days, locations/phases, and groups generate the most questions?
- What topics repeatedly expose missing itinerary data, confusing plans, or gaps in bot capabilities?
- What infrastructure, provider and model usage drives support burden and
  future feature-tier cost, without turning analytics into behavioral ads?

This is an **operational and product analytics system**, not a transcript
archive, surveillance system, participant leaderboard or external
behavioral-advertising system.

---

## 2. Core Design Principle: Software First, LLM Only for Ambiguity

Most event capture and classification must be deterministic software.

### Deterministic (default path)

Capture directly from the onboarding API, workflow worker, messaging gateway,
Hermes lifecycle events and trip-runtime health checks:

- account/trip/intake/job/release/resource lifecycle transitions;
- timestamp and trip/profile identity;
- channel type: group, organizer DM, other/private;
- sender role: organizer, participant, unknown/unauthorized (not the raw person identity in dashboards);
- whether a message was addressed to the bot, replied to the bot, a slash command, or ordinary group chatter;
- message and response lifecycle: received, accepted, dispatched, answered, failed, blocked, timed out;
- response latency, number of tool calls, tool names mapped to safe tool families, model/provider result codes;
- explicit commands and workflow events;
- matching against versioned rules/keyword dictionaries for common categories;
- controlled hashes/fingerprints for repeated-question detection.

### Optional LLM classification (exception path)

Use a small, low-cost classifier only when deterministic rules produce `unknown` or a low-confidence multi-label result. It must receive a short, redacted text excerpt only after the event is accepted as a genuine bot request.

LLM classification must:

- output a strict JSON schema with an approved taxonomy and confidence;
- never be on the synchronous reply path; the bot must not wait for analytics;
- run asynchronously from a queue;
- be rate-limited and budgeted per trip/day;
- process only unknown/low-confidence events or a small quality-audit sample;
- store category, confidence, and classifier version—not the full prompt or model chain-of-thought;
- fall back to `other` / `unclassified` when unavailable.

Use deterministic rules for the first implementation. Add the LLM fallback only after baseline accuracy is measured.

---

## 3. Recommended Architecture

### 3.1 Architecture overview

```text
Onboarding API + private workflow worker
  ├─ signup/interview/provisioning/release lifecycle events
  └─ transactional PostgreSQL outbox

Shared messaging gateway or optional dedicated gateway
  ├─ resolves logical trip/profile binding before dispatch
  ├─ derives channel/role/trigger without exporting raw identifiers
  └─ local durable outbox (non-blocking)

Trip-specific Hermes profile
  ├─ plugin observes accepted turn/tool/response lifecycle
  └─ local durable outbox (non-blocking)
              │ private authenticated batches
              ▼
Analytics Ingest Service (on control-plane private network)
  ├─ authenticates per-trip emitter
  ├─ validates schema and event idempotency
  ├─ writes event store and rollups
  ├─ queues low-confidence classifications
  └─ exposes private metrics/query endpoints
              │                         │
              │                         ├─ async classification worker (optional LLM)
              ▼                         │
Analytics database/schema              │
  ├─ PostgreSQL (first production version)  │
  └─ ClickHouse later if event volume warrants it
              │
              ├─ Prometheus exporter (low-cardinality operational aggregates)
              └─ Grafana dashboard (live monitoring + historical analysis)
```

### 3.2 Deployment placement

- **Lifecycle emitters:** the onboarding API and worker use a transactional
  outbox so a business-state commit and its event cannot silently diverge.
- **Messaging emitter:** observes the shared Telegram router or optional
  dedicated gateway after authorization and trip resolution. A single shared
  bot must still emit the resolved logical trip/profile identity.
- **Hermes emitter:** a standalone plugin installed per isolated trip profile
  in the agent-runtime service. It observes only that profile's accepted turns.
- **Ingest service/database:** private services on the onboarding/control
  network, logically separate from the public API. They must not run directly
  on the Proxmox host or inside an individual trip LXC.
- **Grafana:** private operator-only service. It must not be publicly routed through the trip-site ingress.
- **Prometheus:** optional and useful for service health/live counters. It is not the primary raw event store.

### 3.3 Why not Prometheus alone

Prometheus is excellent for bounded, low-cardinality time series such as counters, latency histograms, failures, queue depth, and service health. It is the wrong primary database for:

- one label per trip, chat, person, message, question text, or fingerprint;
- arbitrary historical drill-down and filtering;
- data retention/deletion workflows for individual conversations;
- analytics dimensions that evolve over time.

**Recommended split:**

- Use **PostgreSQL** as the initial source of truth for privacy-controlled event rows and analytics rollups.
- Expose a small set of **low-cardinality Prometheus metrics** for live operations.
- Use **Grafana** with PostgreSQL and Prometheus data sources for both historical and live visualizations.
- If the platform reaches high event volume or needs very fast large-window analytics, migrate event/rollup querying to **ClickHouse** while retaining the same event contract.

---

## 4. Agent and Messaging Integration Mechanism

### 4.1 Use a standalone Hermes plugin, not a core fork

Implement `kinerary-trip-analytics` as a standalone plugin installed under the
relevant Hermes profile/plugin directory. Do not modify Hermes core for trip
analytics. Instrument the provider-neutral messaging router separately so a
shared bot does not require a shared Hermes profile.

Hermes supports a gateway lifecycle hook named `pre_gateway_dispatch`. It receives a normalized `MessageEvent` before authorization and agent dispatch. Relevant event fields include normalized text, source, sender metadata, message ID, reply context, timestamp, and adapter-specific metadata.

Use this hook to emit the inbound lifecycle event. The plugin must be observer-only and fail open: an analytics failure must never prevent an authorized message from reaching the trip bot.

Also use Hermes lifecycle hooks that are already available for agent/tool observability:

- `pre_llm_call` / `post_llm_call` — turn timing and model-call outcome;
- `pre_tool_call` / `post_tool_call` — safe tool-family usage and tool outcome;
- `on_session_start`, `on_session_end`, and `on_session_finalize` — session-level lifecycle summaries.

During implementation, inspect the exact hook payloads in the deployed Hermes version and add contract tests. Do not assume undocumented fields beyond the public plugin contract.

### 4.2 Trip identity resolution

Each isolated trip profile must declare a **non-secret static trip identity**
in plugin configuration. The messaging gateway independently resolves its
logical binding from the control plane before dispatch. Example profile
configuration:

```yaml
trip_analytics:
  enabled: true
  trip_id: "usa2026"
  environment: "production"
  ingest_url: "https://analytics.internal.example/v1/events"
  secret_ref: "secret://kinerary/analytics/usa2026-emitter"
```

Use Hermes configuration mechanisms for non-secret settings and a secret reference/provider for credentials. Do not hard-code the trip ID or token in plugin code; do not put a token in a repository file.

The control plane should create this configuration only when it creates the corresponding isolated trip profile, then verify that the emitter identity matches the profile/trip binding.

For shared-bot mode, `bot_identity + provider_chat_id` must resolve to exactly
one active `messaging_binding`. Raw provider IDs remain inside the routing
service. Analytics receives `trip_id`, `profile_id`, `messaging_mode=shared`
and a rotating pseudonym only after authorization. A routing miss or ambiguous
binding is a safe operational event and must not dispatch to Hermes.

### 4.3 Channel and requester role resolution

The analytics plugin must derive categories from the trip's private configuration, without exporting raw Telegram identifiers to dashboards.

| Field | Derived value | Source |
|---|---|---|
| `channel_type` | `group`, `organizer_dm`, `participant_dm`, `other_dm`, `unknown` | normalized Hermes source/chat type plus configured group binding |
| `requester_role` | `organizer`, `participant`, `unknown`, `unauthorized` | configured organizer ID reference / group binding / authorization result |
| `trigger_type` | `mention`, `reply_to_bot`, `slash_command`, `dm`, `automation`, `ordinary_chatter` | MessageEvent text/reply metadata and group policy |
| `accepted_as_request` | boolean | actual gateway/agent routing result—not an inference |

For the first version, only count a group message as a bot request when the deployed group policy accepts it (e.g., explicit mention, reply to bot, or defined command). This avoids treating the family’s ordinary conversation as bot usage.

### 4.4 Event correlation

Generate an opaque `event_id` for every telemetry event and a `turn_id` when a message becomes an agent turn. Derive correlation from the message ID + profile + session/turn metadata, not from text.

A single user request may generate the following linked events:

```text
message_received
→ message_authorized
→ bot_request_accepted | ignored_chatter | blocked
→ agent_turn_started
→ llm_call_started / completed
→ tool_call_started / completed (0..n)
→ response_completed | response_failed | response_timeout
→ classification_completed (possibly later)
```

The dashboard should count **accepted bot requests** as the primary usage metric, not every inbound Telegram message and not every LLM/tool call.

### 4.5 Reliable delivery: local outbox

The plugin must never send analytics synchronously in the Telegram reply path.

1. Build a minimal event in memory.
2. Append it transactionally to a local SQLite outbox owned by that profile (`0600` permissions).
3. A background flusher batches events to the private ingest service with an HMAC or mTLS-authenticated request.
4. The ingest service deduplicates by `event_id`.
5. On network failure, retry with bounded exponential backoff.
6. Enforce disk-size and retention caps. If the outbox is full, drop the oldest non-critical diagnostic events first, record a local loss counter, and never block the bot.

This makes analytics resilient to an ingest-service outage and enables exactly-once effective storage through at-least-once delivery plus idempotent ingest.

---

## 5. Event Contract and Privacy Model

### 5.1 Base event schema

Store only the minimum data needed for analysis. Example logical schema:

```json
{
  "schema_version": 1,
  "event_id": "uuid",
  "occurred_at": "2026-08-13T16:22:11.123Z",
  "trip_id": "usa2026",
  "deployment_id": "opaque-deployment-id",
  "release_id": "kinerary-2026.08.1",
  "environment": "production",
  "profile_id": "familytrip-usa2026",
  "source_service": "messaging_gateway",
  "messaging_mode": "shared",
  "event_type": "bot_request_accepted",
  "turn_id": "opaque-id",
  "channel_type": "group",
  "requester_role": "participant",
  "trigger_type": "mention",
  "question_category": "transport",
  "category_source": "rules",
  "category_confidence": 0.96,
  "outcome": "answered",
  "response_latency_ms": 1840,
  "tool_family_count": {"trip_data": 1, "maps": 1},
  "policy_action": "allowed",
  "message_length_bucket": "41_160",
  "content_fingerprint": "rotating-hmac-digest",
  "metadata": {"classifier_version": "rules-2026-08-01"}
}
```

Do not use raw chat IDs, raw Telegram user IDs, names, handles, phone numbers, message text, tool arguments, tool results, credentials, or itinerary/private-family details as Prometheus labels or dashboard dimensions.

### 5.2 Lifecycle event schema

Control-plane lifecycle events use the same envelope but a bounded payload,
for example:

```json
{
  "schema_version": 1,
  "event_id": "uuid",
  "occurred_at": "2026-08-13T16:22:11.123Z",
  "source_service": "provisioning_worker",
  "event_type": "job_step_completed",
  "trip_id": "opaque-trip-id",
  "intake_id": "opaque-intake-id",
  "job_id": "opaque-job-id",
  "deployment_id": "opaque-deployment-id",
  "release_id": "kinerary-2026.08.1",
  "operation": "provision_runtime",
  "provider_family": "proxmox",
  "from_state": "running",
  "to_state": "verifying",
  "result": "success",
  "duration_ms": 48210,
  "manual_intervention": false,
  "safe_error_code": null
}
```

Not every event has every correlation ID: a verified signup can precede a
trip, while a release build is not owned by a trip. IDs are opaque internal
references used for restricted joins and are never Prometheus labels unless a
separate bounded-cardinality rule explicitly permits them. Lifecycle events
contain no interview answers, plan bodies, provider payloads, host addresses,
secret references or stack traces.

### 5.3 Person-level measurement without person-level exposure

The initial dashboard requirement is **organizer versus group**, not a named participant leaderboard.

Therefore:

- Store `requester_role`, not a person name, as the primary analytic dimension.
- For unique-user counts, create a **per-trip rotating HMAC pseudonym** at the emitter:
  `HMAC(rotation_secret, trip_id + platform_user_id + rotation_period)`.
- Rotate monthly (or at trip end), so long-term cross-trip tracking is impossible by design.
- Do not export the pseudonym as a Prometheus label.
- Restrict any event-level query containing pseudonyms to the private operator role and use it only for aggregate distinct counting or abuse/debugging.

If named user-level auditing is ever needed, create a separate explicit policy, retention window, access control, and organizer notice. It is not part of the initial release.

Persistent Traveler DNA and organizer-owned cross-trip preferences are product
data, not analytics identity. If implemented, they require explicit consent,
provenance, membership checks and their own retention/revocation model. Never
join rotating analytics pseudonyms across trips to synthesize that profile.

Post-trip ratings, site corrections and discovered-location suggestions are
also product data rather than analytics text. Analytics may count a bounded
event such as `debrief_completed`, `rating_submitted`, or
`knowledge_candidate_reviewed`; it must not carry the rating comment, chat
excerpt, exact hidden-location detail, or Telegram identity. Any chat-derived
candidate requires explicit organizer consent and human review before product
use.

### 5.4 Text retention

Default policy: **do not persist message text** in the analytics database.

Optional, disabled-by-default diagnostic sampling may store a redacted excerpt for a short retention period only when all of the following are true:

- a production incident or taxonomy-quality review requires it;
- the administrator explicitly enables it for a named trip and expiration date;
- secrets, contact details, booking codes, and obvious personal data are redacted first;
- access is restricted and audited;
- deletion is automatic at expiration.

The normal workflow for improving categories is aggregated `unknown` counts plus temporary sampled review, not permanent transcript collection.

---

## 6. Taxonomy: Request Types and Dimensions

### 6.1 Primary category (one required)

| Category | Meaning | Deterministic examples |
|---|---|---|
| `itinerary_schedule` | day plan, timing, next activity, phase | “what is tomorrow’s plan?” |
| `transport` | flights, transfers, driving, parking, public transport | “when should we leave for the airport?” |
| `food_drink` | restaurants, reservations, dietary food options | “where can we eat nearby?” |
| `attractions_activities` | sights, tours, beaches, events, kid activities | “what can we do this afternoon?” |
| `accommodation` | hotel, check-in/out, room/property facilities | “what time is checkout?” |
| `logistics` | meeting points, packing, documents, connectivity, money | “where do we meet?” |
| `weather_safety` | weather, emergencies, medical/safety guidance | “is it safe to go to the beach?” |
| `trip_site_support` | login, website usage, photos, RSVP | “I cannot open the schedule” |
| `trivia_game` | quiz/trivia controls or questions | “when is the Kahoot?” |
| `organizer_operations` | private admin, itinerary edits, approvals, automation | organizer-only operational request |
| `social_general` | greetings, small talk, non-trip chat | “good morning” |
| `feedback_complaint` | complaint, correction, dissatisfaction | “the hotel information is wrong” |
| `other` | genuine request outside taxonomy | fallback |
| `unclassified` | classification pending/failed | never hide this bucket |

### 6.2 Secondary tags (zero or more)

Examples: `today`, `tomorrow`, `urgent`, `booking`, `price`, `location`, `children`, `accessibility`, `dietary`, `live_status`, `recommendation`, `correction`, `approval_required`.

Tags must be from a bounded vocabulary. Never use free-form text as a metric label.

### 6.3 Operational outcome

| Outcome | Definition |
|---|---|
| `answered` | final response was successfully delivered |
| `answered_with_tools` | response delivered and one or more tools used |
| `clarification_requested` | bot asked for required missing context |
| `blocked_by_policy` | request correctly refused or redirected due to policy |
| `ignored_not_addressed` | group chatter was intentionally not treated as a request |
| `failed_provider` | LLM/provider failure |
| `failed_tool` | required tool failed |
| `failed_delivery` | response could not be delivered |
| `timeout` | bounded execution timeout |
| `escalated_to_organizer` | bot identified an item for private organizer follow-up |

### 6.4 Time dimensions

Every event must retain UTC time and derive, using the active trip phase timezone:

- local date/hour/day of week;
- days before departure / trip day number / days after return;
- active itinerary phase/destination reference when available;
- `pre_trip`, `in_trip`, `post_trip` lifecycle period.

Do not derive trip location from raw text when the configured active phase already provides a deterministic answer.

---

## 7. Metrics to Expose

### 7.1 Lifecycle and onboarding metrics

1. Verified signup → pending-super-admin-approval → approved/rejected/expired
   → trip draft conversion. Measure decisions and elapsed time without storing
   the applicant's Telegram ID or approval-message content in analytics.
2. Interview enrollment issued/opened/authorized/expired/rejected counts.
3. Interview started → recap → literal confirmation conversion and elapsed
   time, without exporting answer text.
4. Confirmed → provisioning plan → approval → private readiness → activation
   funnel and duration.
5. Job-step success/failure/retry/manual-wait rate by bounded operation type,
   provider and release ID.
6. Release build, Japan qualification, promotion, deployment, upgrade and
   rollback outcomes.
7. Manual interventions and remediation rate—the primary automation-gap
   indicator.
8. Active/completed/archived trips and repeat-trip creation by account using
   control-plane authorization, never analytics pseudonym linkage.
9. Bounded resource/provider/model usage and cost suitable for capacity and
   future entitlement design. This is not billing truth until a billing
   subsystem explicitly owns it.

### 7.2 Trip-companion product metrics

1. **Accepted bot requests** by trip, day, channel type, requester role, and category.
2. **Unique active requesters** by trip/day/role using rotating pseudonyms.
3. **Group versus private ratio** and organizer versus participant ratio.
4. **Category mix** and category trend by local trip day/phase.
5. **Resolution/outcome rate:** answered, clarification, blocked, failed, escalated.
6. **Median/p95 response latency** and time-to-first/final-response where available.
7. **Tool-assisted answer rate** and safe tool-family usage rate.
8. **Repeat-question rate:** same normalized fingerprint/category within a bounded time window. This indicates missing information or weak answers.
9. **Follow-up-within-N-minutes rate:** a non-command inbound message in the same session shortly after an answer. Treat as a friction proxy, not proof of dissatisfaction.
10. **Unclassified rate** and classifier-confidence distribution.

### 7.3 Operational reliability metrics

- public onboarding API, workflow worker, PostgreSQL and scheduler health;
- release builder and provider-artifact inventory consistency;
- per-trip site/MCP/Hermes/messaging/ingress health and restart recovery;
- shared-router binding misses, ambiguous routes and cross-trip policy blocks;
- plugin emission successes/failures/dropped events;
- outbox event count, bytes, oldest pending age, retry count;
- ingest acceptance/rejection/dedupe counts;
- classification queue depth and latency;
- Hermes bot response failures/timeouts;
- tool failures grouped by bounded tool family;
- per-trip profile health and collector health.

### 7.4 Derived quality indicators (clearly labeled as heuristics)

- **Self-service rate:** answered without organizer escalation / accepted requests.
- **Operational friction index:** weighted combination of clarification, repeated question, tool failure, and fast follow-up rates.
- **Information-gap candidates:** high repeated-question volume for a category/phase with no matching site FAQ/itinerary field.
- **Engagement concentration:** whether usage is dominated by organizer DM versus adopted by the group.
- **Automation coverage:** lifecycle steps completed without operator repair /
  eligible lifecycle steps.
- **Release confidence:** successful Japan qualification plus successful
  deployments/upgrades/rollbacks for a release, always shown with sample size.

Do not present these as objective satisfaction scores without qualitative validation.

---

## 8. Prometheus Metrics: Bounded Labels Only

Expose Prometheus metrics from the ingest service, never directly from each raw user identity.

Example metric families:

```text
tripbot_requests_total{
  trip_id="usa2026",
  channel_type="group",
  requester_role="participant",
  category="transport",
  outcome="answered"
}

tripbot_response_duration_seconds_bucket{
  trip_id="usa2026",
  channel_type="group",
  outcome="answered",
  le="2.5"
}

tripbot_tool_calls_total{
  trip_id="usa2026",
  tool_family="trip_data",
  outcome="success"
}

tripbot_analytics_outbox_pending_events{trip_id="usa2026"}
tripbot_analytics_ingest_failures_total{reason="signature_invalid"}
tripbot_classification_total{source="rules", category="food_drink"}

kinerary_lifecycle_transitions_total{
  from_state="confirmed",
  to_state="provisioning",
  result="success"
}

kinerary_job_steps_total{
  operation="provision_runtime",
  provider="proxmox",
  result="success"
}

kinerary_deployments{release_id="kinerary-2026.08.1", state="active"}
```

Rules:

- `trip_id` is allowed only while the total number of active trips remains bounded and controlled. Reassess before hundreds/thousands of trips.
- Never add `user_id`, `chat_id`, `message_id`, fingerprint, free-form category, text, session ID, or error text as labels.
- Use a bounded error code—not exception text—as a label.
- Keep heavy historical queries in PostgreSQL/ClickHouse through Grafana, not PromQL.

---

## 9. Grafana Dashboard Design

Create a private Grafana folder named **Kinerary / Lifecycle and Companion
Analytics** with role-based access.

### Dashboard A — Onboarding and lifecycle

Filters: time range, environment, release, lifecycle state.

Panels:

1. Signup → pending super-admin approval → draft → interview start →
   confirmation → ready-private → active funnel, with approved/rejected/expired
   signup decisions as separate bounded outcomes.
2. Median/p95 time in each lifecycle state and job wait.
3. Provisioning step success/failure/retry/manual-intervention rates.
4. Release builds, Japan qualification, active deployment count and
   upgrade/rollback outcomes by release.
5. Current trips blocked on user action versus technical remediation.
6. Resource/provider/model usage and estimated cost by bounded service family.
7. Repeat-trip creation and completed-trip retention as aggregate product
   signals, visible only to appropriately authorized product/admin roles.

### Dashboard B — Fleet overview

Filters: time range, environment, trip, lifecycle period.

Panels:

1. Total accepted requests and unique active requesters.
2. Requests per hour/day, overlaid with trip local time.
3. Trips ranked by usage volume and active-requester rate.
4. Group versus organizer/private request share.
5. Outcome funnel: received → accepted → answered / blocked / failed.
6. p50/p95 response latency and error/timeout rate.
7. Telemetry pipeline health: emitter/ingest/outbox/classifier.

### Dashboard C — Per-trip adoption and content needs

Filters: trip, date range, phase/destination, requester role, channel.

Panels:

1. Requests by local trip day and phase.
2. Category distribution as stacked bars and trend lines.
3. Heatmap: local hour × day of trip.
4. Organizer versus group category comparison.
5. Top repeated-question fingerprints shown only as anonymized cluster IDs plus category/count; no raw content by default.
6. Clarification, escalation, repeat, and fast-follow-up rates.
7. Missing-information candidates by category/phase.

### Dashboard D — Reliability and cost control

1. Hermes turn, tool, delivery, and analytics error rates.
2. LLM classifier volume, rate-limit/budget consumption, and classification confidence.
3. Event outbox backlog and ingest latency.
4. Tool-family latency/failure charts.
5. Alerts: bot unavailable, outbox growth, ingest failures, high timeout rate, classification backlog.
6. Shared messaging route misses/ambiguity and unauthorized cross-trip
   dispatch attempts.
7. Site/MCP/Hermes/messaging health grouped by release ID.

### Drill-down policy

Default dashboard viewers see aggregated metrics only. Event-level drill-down
requires a restricted operator role and must show pseudonymous IDs,
timestamps, categories, outcomes, release IDs and safe error codes—not message
content. Future organizers may see aggregate analytics only for trips where
they hold an active owner/organizer membership; fleet, other-customer, provider
cost and incident views remain super-admin-only.

---

## 10. Data Retention and Access Controls

Suggested initial retention policy:

| Data class | Retention | Access |
|---|---:|---|
| Prometheus operational aggregates | 30–90 days | operator/admin |
| Daily/hourly aggregate analytics | 24 months | operator/admin |
| Event rows without text or direct identifiers | 90–180 days | restricted operator |
| Rotating pseudonym mapping material | never stored centrally | emitter only / derived ephemeral value |
| Diagnostic redacted excerpts (disabled by default) | 7–30 days maximum | explicitly approved restricted operator |
| Raw transcript | not stored by analytics | Hermes/session policy only |

Implement deletion jobs and verify them. Keep the analytics database, Grafana, and backups private. Apply least-privilege database roles: ingestion writer, rollup worker, Grafana read-only, and maintenance/deletion worker.

---

## 11. Implementation Plan

### Phase 1 — Event contract and local prototype (no production export)

1. Write versioned schemas for control-plane lifecycle, resource/health and
   trip-companion events.
2. Emit signup-approval, interview, job and release transitions from a
   transactional PostgreSQL outbox in the onboarding service; approval-message
   payloads and Telegram IDs are never analytics fields.
3. Define the bounded category/tag/outcome taxonomy and initial Hebrew/English
   rule dictionaries.
4. Build local-only messaging/Hermes emitters that capture normalized metadata
   without storing text.
5. Add SQLite outboxes with event IDs, retry status, retention caps and
   redaction tests where a PostgreSQL transaction is not available.
6. Build a local ingest endpoint and contract tests for deduplication, source
   authentication, trip-binding mismatch and invalid payload rejection.
7. Verify that all analytics failures leave signup, workflow execution and bot
   response paths unaffected.

### Phase 2 — Correlation, lifecycle rollups and deterministic classification

1. Correlate signup → intake → trip → job → deployment → release without
   copying private intake content into analytics.
2. Add messaging-route and agent/tool lifecycle observation using supported
   gateway/Hermes hooks.
3. Implement turn correlation and outcome/latency derivation.
4. Add deterministic classifiers for commands, known trip terms, site support,
   logistics, transport, food, attractions, accommodation, weather/safety and
   organizer operations.
5. Add tests with anonymized Hebrew and English examples, shared/dedicated
   messaging modes, ambiguous requests and mixed-topic cases.
6. Persist event rows and hourly/daily lifecycle, release, reliability, usage
   and companion rollups in PostgreSQL.
7. Add data-retention/deletion jobs and role-based database access.

### Phase 3 — Dashboards and operational monitoring

1. Export bounded Prometheus metrics from the ingest service.
2. Deploy Prometheus and Grafana privately, without public trip-site routing.
3. Create all four dashboards above plus health/error alerts.
4. Validate lifecycle funnels against controlled database transitions and
   companion figures against a controlled conversation/event count.
5. Run Japan through release-artifact qualification, fresh local-MVP
   deployment, shared-bot routing, activation, upgrade and rollback before
   enabling telemetry for a real trip.

### Phase 4 — Optional LLM classifier and insight workflow

1. Measure deterministic classification coverage/accuracy from an approved temporary audit sample.
2. Add asynchronous structured-output LLM classification only for `unknown`/low-confidence events.
3. Add daily classifier budgets, failure fallback, and classifier-version comparisons.
4. Add a weekly private report listing category trends and information-gap candidates, using aggregates rather than transcript summaries.
5. Require explicit approval before enabling any short-lived redacted-text diagnostic sample.

---

## 12. Tests and Acceptance Criteria

Do not call the analytics system ready until all of the following are demonstrated with real output:

- A genuine Telegram group message that is not addressed to the bot is recorded as `ignored_not_addressed`, not an accepted request.
- A website identity can be correlated to its own lifecycle funnel without
  putting its Telegram ID, name or intake content in analytics events.
- A failed/retried lifecycle job produces idempotent step and transition
  events, and dashboard state reconciles with the authoritative registry.
- Image build, Japan qualification, deployment, upgrade and rollback events
  retain the correct release ID.
- Two groups using the shared bot emit different logical trip/profile IDs and
  a routing miss emits no Hermes turn.
- An organizer DM, a participant group mention, a bot reply, and a slash command are classified into correct channel/role/trigger dimensions.
- The emitter can be stopped or the ingest endpoint can be unavailable without impacting a bot response.
- Retried delivery produces one stored event due to ingest idempotency.
- No raw message text, names, chat IDs, Telegram IDs, tokens, tool arguments, tool results, or secret-looking values appear in emitted payloads, logs, Prometheus labels, or default Grafana views.
- The event taxonomy handles Hebrew and English examples and yields `unclassified` rather than inventing a category when uncertain.
- One full agent turn accurately produces accepted/request, response outcome, latency, and safe tool-family metrics.
- Default and intake Hermes profiles do not emit trip-bot analytics for a trip they do not operate.
- Grafana numbers reconcile with the event database for a fixed test time window.
- Data deletion/retention jobs remove expired event rows and diagnostic samples.
- Prometheus cardinality remains within a reviewed bound under a synthetic multi-trip load test.
- The optional LLM classifier is disabled by default, asynchronous when enabled, schema-validated, budgeted, and cannot delay the bot response.

---

## 13. Important Non-Goals for the First Release

- No public analytics dashboard.
- No permanent transcript mirror.
- No named-user engagement scoring or participant leaderboard.
- No cross-trip user tracking.
- No billing ledger, pricing decision or automated entitlement enforcement;
  usage/cost events are planning inputs only in the first release.
- No LLM classification on every message.
- No direct instrumentation inside Hermes core.
- No use of telemetry to alter a group conversation automatically without a separate reviewed product decision.

---

## 14. Suggested Repository Layout

Keep analytics separate from trip runtime and the privileged provisioning MCP:

```text
analytics/
  schemas/
    lifecycle-event.v1.json
    tripbot-event.v1.json
  control-plane-outbox/        # lifecycle/resource event publisher
  messaging-emitter/           # shared/dedicated gateway observation
  emitter-plugin/              # standalone Hermes plugin source
    plugin.yaml
    __init__.py
    outbox.py
    classifier_rules.py
    redact.py
  ingest-service/
    app/
    migrations/
    tests/
  dashboards/
    grafana/
    prometheus/
  docs/
    data-retention.md
    taxonomy.md
```

The Hermes emitter plugin may be installed into the profile-specific plugin
location during provisioning, but its source, tests and deployment
configuration remain centrally managed. The messaging emitter belongs at the
gateway/router so shared-bot traffic is labeled only after a successful
logical trip binding. The control plane attaches emitters using approved
static IDs and secret references; it never embeds credentials in trip content.

---

## 15. Recommendation

Start with **PostgreSQL transactional lifecycle events + a private ingest
service + messaging/Hermes emitters + Grafana**, and add Prometheus only for
bounded live operational metrics. A separate PostgreSQL schema and
least-privilege roles may initially share the control-plane database cluster;
analytics must not gain authority to mutate trip lifecycle state.

Implement deterministic event capture and rule-based categories first. Treat LLM classification as an asynchronous, opt-in enrichment for ambiguity—not as the analytics foundation.
