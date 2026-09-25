# Kinerary Lifecycle and Trip-Companion Analytics — WIP Design

**Status:** Work in progress. This document does not authorize enabling
production telemetry, changing Hermes or messaging configuration, installing
collectors, or exposing a dashboard. Slice 1 of §11 Phase 1 — the relay's own
events — is built but **off by default and enabled nowhere**; §16 says what it
records, what it deliberately does not, and where it departs from this
document.

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

Organizer-scoped Hermes profile
  ├─ plugin observes accepted turn/tool/response lifecycle
  ├─ receives a server-issued trip context per accepted turn
  └─ local durable outbox (non-blocking)
              │ private authenticated batches
              ▼
Analytics Ingest Service (on control-plane private network)
  ├─ authenticates organizer emitter and trip-context capability
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
- **Hermes emitter:** a standalone plugin installed per organizer profile in
  the agent-runtime service. It observes accepted turns only after the router
  and Trip Context Gateway resolve an exact trip/channel/role capability.
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

### 4.2 Organizer profile and trip-context resolution

Each long-lived organizer profile declares a **non-secret static organizer and
profile identity**. Trip identity is not static profile configuration: the
messaging router resolves it from a private DM selection or durable group
binding, and the Trip Context Gateway issues an immutable capability before
dispatch. Example profile configuration:

```yaml
trip_analytics:
  enabled: true
  organizer_id: "opaque-organizer-id"
  profile_id: "familytrip-organizer-01"
  environment: "production"
  ingest_url: "https://analytics.internal.example/v1/events"
  secret_ref: "secret://kinerary/analytics/organizer-01-emitter"
```

Use Hermes configuration mechanisms for non-secret settings and a secret
reference/provider for credentials. Do not hard-code a trip ID or token in
plugin code and do not put a token in a repository file. The plugin accepts a
trip ID only from the authenticated router/gateway context, never from message
text, tool arguments or model output. It emits both the durable organizer
profile ID and resolved trip/deployment IDs.

The control plane creates this configuration with the organizer profile and
verifies that each event's trip context matches the active router capability.
Group and private sessions are distinct, and analytics must not copy organizer-
private memory or its contents into events.

For shared-Trip-Bot group mode, `bot_identity + provider_chat_id` resolves to
exactly one active `messaging_binding`. Private DMs resolve from the organizer's
explicit selected trip or signed intake session. Raw provider IDs remain
inside the routing service. Analytics receives `trip_id`, organizer-scoped
`profile_id`, `messaging_mode=shared` and a rotating pseudonym only after
authorization. A routing miss or ambiguous/stale binding is a safe operational
event and must not dispatch to Hermes.

### 4.3 Channel and requester role resolution

The analytics plugin must derive categories from the trip's private configuration, without exporting raw Telegram identifiers to dashboards.

| Field | Derived value | Source |
|---|---|---|
| `channel_type` | `group`, `organizer_dm`, `participant_dm`, `other_dm`, `unknown` | normalized Hermes source/chat type plus configured group binding |
| `requester_role` | `organizer`, `participant`, `unknown`, `unauthorized` | configured organizer ID reference / group binding / authorization result |
| `trigger_type` | `mention`, `reply_to_bot`, `slash_command`, `dm`, `automation`, `ordinary_chatter` | MessageEvent text/reply metadata and group policy |
| `accepted_as_request` | boolean | actual gateway/agent routing result—not an inference |

For the first version, only count a group message as a bot request when the deployed group policy accepts it (e.g., explicit mention, reply to bot, or defined command). This avoids treating the family’s ordinary conversation as bot usage.

*Slice 1 (§16) resolves these fields from the relay's own knowledge and uses a
narrower vocabulary than this table — notably `requester_role: unknown`, not
`participant`, for a sender the trip has no link for.*

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

*Slice 1 (§16) does not build this outbox. The relay emitter holds a bounded
in-memory queue and writes straight to the database, with no retry; the
durability above is owed by the Hermes-plugin slice and by any ingest route.*

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
  "profile_id": "organizer-opaque-profile-id",
  "context_source": "group_binding",
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

**Precedence when both apply, confirmed against real evidence (2026-09-23
hand evaluation, `docs/test-reports/nir-trip-assistant-experience-2026-09-23.md`):**
a request can be conversationally successful (a clear, well-formed reply was
sent) while the substantive tool call behind it failed — the live case was a
document upload where `read_file` errored twice with the identical parse
failure, and each time the assistant sent a good "please resend" message.
If `outcome` is set from "was a reply sent" rather than "did the required
tool succeed," this records as `answered` and the resolution-rate metric
(§7.2 item 5) reads as healthy while the organizer's actual need — getting
his itinerary into the system — went unmet twice. **`outcome` must reflect
the substantive task, not the conversational wrapper: `failed_tool` takes
precedence over `answered` whenever a request's required tool call failed,
even if the bot's own message was graceful.** This is the same distinction
`docs/sprint6-tracks.md` names for #114 ("measuring 'did the call succeed' is
not measuring 'did we understand'") — this is confirmation that it also
applies here, in a different corner of the same product.

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
11. **Same-fingerprint, different-outcome-by-channel rate — added 2026-09-23,
    confirmed real rather than theoretical.** `content_fingerprint` (§5.1)
    already correlates repeated inputs; this cross-tabulates it against
    `channel_type` and `outcome`. On the one live trip, the identical link
    was rejected in a private DM and accepted, two days later, in the group —
    a traveler-visible "it's broken, now it isn't" with no product change in
    between. Nothing upstream of this metric needed to change to compute it;
    it was missing only as a named check, not as data.
12. **Memory/enrichment write rate — gap, not yet a metric.** Neither this
    list nor §7.4 has a rate for "how often does the assistant actually write
    a durable fact relative to conversation volume." The live trip's own
    `MEMORY.md` held exactly one fact after six days and dozens of exchanges
    containing several learnable preferences (a schedule correction, a
    repeated cuisine preference). `preference_detected`/`preference_confirmed`
    (the skill reference's draft event list) would feed this once
    instrumented; add the rate itself here so a future trip's memory file
    can be judged against a number, not a hand re-read.

### 7.3 Operational reliability metrics

- public onboarding API, workflow worker, PostgreSQL and scheduler health;
- release builder and provider-artifact inventory consistency;
- per-trip site/MCP/messaging/ingress health plus per-organizer Hermes-profile
  health and restart recovery;
- shared-router binding misses, ambiguous routes and cross-trip policy blocks;
- plugin emission successes/failures/dropped events;
- outbox event count, bytes, oldest pending age, retry count;
- ingest acceptance/rejection/dedupe counts;
- classification queue depth and latency;
- Hermes bot response failures/timeouts;
- tool failures grouped by bounded tool family;
- per-organizer profile, Trip Context Gateway and collector health;
- connected-service authorization/revocation, import/sync freshness and
  bounded provider outcomes without external account IDs or document/media
  content.

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
- Two groups using the shared Trip Bot may emit the same organizer profile ID
  but must emit different logical trip/context IDs; a routing miss emits no
  Hermes turn, and private `/select` changes neither group binding.
- A completed trip emits read-only access outcomes and every attempted
  mutation is blocked at the gateway/API rather than classified as success.
- An organizer DM, a participant group mention, a bot reply, and a slash command are classified into correct channel/role/trigger dimensions.
- The emitter can be stopped or the ingest endpoint can be unavailable without impacting a bot response.
- Retried delivery produces one stored event due to ingest idempotency.
- No raw message text, names, chat IDs, Telegram IDs, tokens, tool arguments, tool results, or secret-looking values appear in emitted payloads, logs, Prometheus labels, or default Grafana views.
- The event taxonomy handles Hebrew and English examples and yields `unclassified` rather than inventing a category when uncertain.
- One full agent turn accurately produces accepted/request, response outcome, latency, and safe tool-family metrics.
- Default/intake contexts and organizer profiles do not emit trip analytics
  without an authenticated server-issued trip capability.
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

The Hermes emitter plugin may be installed into the organizer-profile plugin
location during provisioning, but its source, tests and deployment
configuration remain centrally managed. The messaging emitter belongs at the
gateway/router so shared-bot traffic is labeled only after a successful
logical trip/intake binding. The control plane attaches emitters using approved
static organizer/profile IDs, dynamic authenticated trip contexts and secret
references; it never embeds credentials in trip content.

---

## 15. Recommendation

Start with **PostgreSQL transactional lifecycle events + a private ingest
service + messaging/Hermes emitters + Grafana**, and add Prometheus only for
bounded live operational metrics. A separate PostgreSQL schema and
least-privilege roles may initially share the control-plane database cluster;
analytics must not gain authority to mutate trip lifecycle state.

*Slice 1 (§16) took the "share the cluster" option one step further: its table
is in the `control_plane` schema itself, not a separate schema, and there is no
ingest service yet.*

Implement deterministic event capture and rule-based categories first. Treat LLM classification as an asynchronous, opt-in enrichment for ambiguity—not as the analytics foundation.

---

## 16. Implementation status — slice 1: relay-side events (built 2026-09-25, off by default)

Issue #177, Track 2 of Sprint 6. This is the first part of §11 Phase 1 that
exists in code. It does not authorize enabling anything: the header still
governs, and nothing here is switched on in any deployment.

### 16.1 What is built

- **The contract** — `analytics/schemas/tripbot-event.v1.json` (where §14 puts
  it), mirrored in TypeScript by `control-plane/api/src/analytics/contract.ts`.
  Both are allow-lists: `additionalProperties: false`, every field named. The
  relay validates against the TS copy because a deployed container may not
  carry the JSON file (the build's `rootDir` is `src`, so it cannot read the
  repo-root file at runtime); `test/assistant-events-contract.test.ts` fails if
  the two disagree on properties, required fields, enums or per-type rules, and
  runs both validators (the TS one and Ajv against the JSON Schema) over a corpus
  of good and bad events.
- **The table** — `control_plane.assistant_events`, migration
  `20260925143012_assistant_events.sql` (`rollback: compatible`). Every value
  column is CHECKed against a closed set; `trip_id` is `ON DELETE SET NULL`, as
  `funnel_events` does. The table's CHECKs enforce the contract's rules on their
  own, as the second line behind the validator: a `metadata` allow-list; separate
  CHECKs requiring `documents` and `attachments_joined` to be JSON numbers
  matching `^[0-9]{1,2}$` and between 0 and 20 (each written as a `CASE`, because
  Postgres does not promise `AND` evaluation order and an out-of-order cast would
  raise a cast error instead of failing the check); a per-event-type outcome
  CHECK; and a per-event-type NOT-NULL-when-required CHECK. The one field the
  contract requires that the table cannot is `trip_id`, which `ON DELETE SET NULL`
  needs to be nullable. `response_latency_ms` keeps only its 0..86400000 range.
  Both reviewers found the first version's CHECKs weaker than the contract; the
  migration was edited in place because it had never been applied. A test
  compares the table's columns with a checked-in list, so adding a column is a
  reviewed change.
- **The writer** — `writeAssistantEvents` (`analytics/store.ts`): validates each
  event itself, inserts idempotently on `event_id`, and checks that the `trip_id`
  exists *in the same statement* as the insert (a CTE selecting the trips
  `FOR KEY SHARE`, then `INSERT … JOIN known … ON CONFLICT DO NOTHING`), so a
  trip deleted concurrently cannot fail the batch on the foreign key, and no
  query runs before `statement_timeout`/`lock_timeout` (5 s each) are set as the
  transaction's first statements. It is the function a later ingest route would
  wrap.
- **The emitter** — `RelayAssistantEvents` (`analytics/emitter.ts`), fed by
  emission hooks in `relay/poller.ts` (`applyDecision`, `runDocumentCorrection`),
  `relay/connector.ts` (after Telegram answers a companion `send`) and
  `relay/server.ts` (wiring). `relay/dispatch.ts` stays free of I/O of its own:
  it attaches an optional `analytics` descriptor to the decision and the poller
  emits.
- **The rollup** — `rollupAssistantEvents`: per trip, per local day (the caller
  names the time zone), computed from the table alone. Group messages addressed
  vs not, requests handed on, replies delivered with latencies, turns lost,
  turns with no delivered reply, by channel and role, and each document's fate
  as far as the relay can see it.
- **The purge** — `purgeExpiredEvents(db, olderThanDays = 90)`; refuses under
  one day, since `0` would delete everything.

`test/assistant-events-replay.test.ts` replays an anonymized week of the Nir
trip through the real `dispatchUpdate` and `applyDecision` and checks the
rollup against the counts the 2026-09-23 hand evaluation had to read
transcripts for (the organizer's four DM document reads enter at `applyDecision`
with a descriptor built by the same `inboundFacts()`; when the test was written
`dispatchUpdate` could not produce a `document_correction` decision, and routing
them through dispatch was rejected because the test would then assert that bug's
behaviour. Since #178 (PR #215) dispatch produces it, and the test keeps the
hand-built decision so it controls exactly which documents are read),
that no row contains an identifier or a word anyone wrote,
that a throwing or hanging sink changes nothing the family sees, and that with
the setting unset the same week writes nothing.

### 16.2 What is deliberately not built

- **No Hermes plugin.** `source_service` admits only `relay`; the plugin's
  value is added with the plugin. Per-profile install, Hermes configuration,
  secrets and a look at the deployed `pre_gateway_dispatch` payload (§4.1) are
  all outside what the header allows.
- **No ingest route, no outbox, no retry.** A batch the sink drops is gone (§16.5).
- **No keyed pseudonyms, no content fingerprints** (§5.1, §5.3). They need a
  keyed rotating secret. `digestTelegramId` is *not* a substitute: it is an
  unkeyed SHA-256 of a numeric id, reversible by brute force and stable across
  trips, which is exactly the cross-trip tracking §5.3 forbids.
- **No category, no LLM, no Prometheus, no dashboard.** No `question_category`
  is stored, because the relay never reads a message for its topic.
- **Purge is not scheduled.** The function exists and is tested.
- **Not enabled anywhere** (§16.6).

### 16.3 Where this slice settles or changes the rest of the document

- **`requester_role` is `unknown` for an unlinked sender, not `participant`.**
  §4.3's row implies a group binding makes a sender a participant. Only
  organizers are linked today (migration 0051), so an unlinked sender may be a
  family member or an organizer on an account the trip never linked; guessing
  either would produce a number that looks better than it is (comment on
  `requesterRoleOf`). `organizer` is set only from a person link, or from the
  organizer's own confirmed interview chat on the document route. Unlinked
  people therefore all read `unknown` until participants are linkable.
- **The relay never writes `answered`.** It sees whether Telegram accepted a
  reply; it cannot see whether the tool behind it worked, and §6.3 says
  `failed_tool` beats `answered`. The outcome set has no such value and a test
  asserts its absence. A forwarded turn with a delivered reply is reported as
  `reply_delivered_substantive_outcome_unknown`. The one exception is the
  relay's own document read (`relay_tool_completed`): there the relay *is* the
  tool, so it may record `failed_tool`, `blocked_by_policy`,
  `correction_proposed` or `no_new_information`. The outcome vocabulary is
  therefore delivery facts plus those four, and adds
  `dispatched`, `lost_gateway_unavailable`, `lost_companion_unreachable`,
  `reply_delivered`, `reply_suppressed` (the connector's internal-leak
  suppression) to §6.3's table.
- **No `schema_version` column or field, and `source_service` is `relay`
  only.** Neither was on the recommended allow-list for this slice, so neither
  exists; the version lives in the schema's file name (`tripbot-event.v1.json`).
  (§5.1's example carries `"schema_version": 1`; this contract does not.) The
  Hermes slice adds its own `source_service` value.
- **`metadata` is JSON-typed with exactly three keys**, `attachments_joined`
  (0–20), `documents` (0–20) and `document_held` (boolean) — numbers and one
  boolean, so nothing textual can ride in it. Enforced by the validator and by
  a CHECK on the table. Dedicated columns were the alternative; rejected
  because a document's fate (held, then joined to a later addressed message,
  then handed on) needs counts that fixed columns cannot hold.
- **`answered` / `answered_with_tools` are absent everywhere in v1** — enum,
  table CHECK and rollup. Writing them behind a "`source_service` is not
  `relay`" rule was the rejected alternative: no emitter that may legitimately
  write them exists yet, so the Hermes slice adds them with its own rule.
- **Vocabulary narrower than §4.3.** `channel_type` is `group`, `organizer_dm`,
  `other`, `unclassified`, derived from Telegram's **raw `chat.type`**, not the
  router's mapped wire type: `mapChatType` turns every unknown type into
  `group`, which had made `unclassified` unreachable. A private chat from a
  linked organizer is `organizer_dm`; any other private chat is `other`; `group`
  and `supergroup` (forums included) are `group`; `channel` is `other`; anything
  else is `unclassified`. `other` is not split, for two reasons the developer
  gave in hindsight (round 1 had used the brief's three-value set and recorded no
  reason): a `participant_dm` cannot be asserted while only organizers are linked
  (migration 0051 — an unlinked DM sender may be an organizer on an unlinked
  account), and a channel split would name traffic the poll loop never receives
  (`allowedUpdates` is `message`, `callback_query`, `my_chat_member`; no
  `channel_post`). Both are carry-forward. `requester_role` has
  `unclassified` in place of `unauthorized`. `trigger_type` adds `name`
  (addressed by the assistant's name), `reply_window` (the one-shot reply
  window, migration 0053) and `not_addressed`. In every field an input the
  mapper does not recognise becomes `unclassified` — never a real bucket — so
  a new chat type or attachment kind shows up as a visible count.
- **The gate is recorded, never re-decided.** `addressed` comes from dispatch;
  `classifyTrigger` only names which of the gate's reasons applied, with the
  gate's own predicates in the gate's order (fed the mapped type the gate itself
  saw), and reports `unclassified` if they
  ever drift.
- **Store in `control_plane`, not a separate schema.** Reason from the task
  brief: the DB-backed test files reset with `DROP SCHEMA IF EXISTS
  control_plane CASCADE`, and a second schema would survive every reset.
- **Unaddressed group messages are stored per message, as metadata only.** This
  was the manager's recommendation and is now **confirmed by the owner
  (Dror) on 2026-09-25 for the MVP** (family and friends); source: his
  2026-09-25 comment on issue #177. His stated purpose is ambient listening to understand what a family
  needs and possibly intervene later. The reason recorded for per-message rows
  over aggregate-only counters is that aggregates cannot be re-cut later and
  any proactive behaviour needs sequence and timing. It was safe to build
  because the emitter is off. It is the most sensitive signal in the slice —
  *when a family talks among themselves*. The confirmed stance is: allowed
  columns only those in the table, retention 90 days (§10's lower bound). The
  **family notice is deferred to full production** (owner decision, same
  comment; tracked in #186); the MVP families are covered by the existing
  alpha-tester consent. Confirmation of the stance does not enable anything:
  the preconditions in §16.7 still stand.

### 16.4 Events: one per observed fact

The relay writes an event for each thing it actually observes, and
`turn_id` links them:

| `event_type` | Observed |
|---|---|
| `ignored_not_addressed` | a group message the relevance gate did not address (with `document_held` when a document was kept for its sender's next addressed message) |
| `request_forwarded` | an addressed message handed to the companion gateway, with the count of documents and of held/replied-to files it brought along |
| `request_to_relay` | an organizer's document after confirmation, which the relay handles itself |
| `turn_lost` | an addressed message no one could take: gateway down (`lost_gateway_unavailable`) or the companion not running (`lost_companion_unreachable`) |
| `reply_sent` | a companion message sent through the connector, and whether Telegram accepted it (`reply_delivered`, `failed_delivery`) or the connector suppressed it |
| `relay_tool_completed` | the substantive result of the relay's own document read |

§4.4's chain (`message_received → message_authorized → … → response_completed`)
is not adopted: the relay cannot observe authorization, agent, LLM or tool
stages, and inventing them would claim knowledge it lacks. The alternative
weighed and rejected for this table was a single `message_received` row whose
outcome is updated later. Each fact is observed at a different moment by a
different component (the poller or the connector), and rows stay append-only.

**Lost turns.** A turn is lost either when no gateway socket takes the frame
(`pushInbound` false: `lost_gateway_unavailable`) or when the router answers
because the companion is not running (`COMPANION_PENDING`:
`lost_companion_unreachable`). Since #179 (PR #215) that answer is "still
finishing your assistant" only for a trip whose assistant was never announced as
up; for an announced one, a group message that is not addressed is ignored
(recorded as chatter, with the same facts), an addressed one gets the generic
"I'm off for now" line at most once per chat per ten minutes, and an addressed
message the limiter suppressed is deliberately recorded with **no** event: an
`ignore` carrying facts counts as chatter, and this was a lost turn, so an
absent event undercounts and a wrong one misleads. The text that follows
describes the router as it was written and still holds for the never-announced
case. The poll loop passes
`canReachProfile`, so a gateway that is down almost always surfaces as the
second; recording only the first would systematically undercount lost turns.
That router answer comes before the relevance gate, so a family's chatter can
arrive as `turn_lost` too: it is recorded with trigger `not_addressed` and the
rollup counts it as chatter, not as a lost turn. This path only asks the gate's
predicate for the record; it does not claim the one-shot reply window, because
claiming is a write.

**The relay's own document read.** `runDocumentCorrection` returns
`{outcome, documents}` at each of its existing exits and the caller emits one
`relay_tool_completed` (six emission points inside the function were rejected).
The outcome: an upload that was only identity documents is `blocked_by_policy`;
unreadable, nothing found, no runner, extraction failed, no intake version, or a
thrown error is `failed_tool`; nothing new is `no_new_information`; proposals
raised is `correction_proposed`.

### 16.5 Correlation, latency and delivery limits

- **Reply attribution.** In `RelayAssistantEvents.replySent`, in order:
  (1) a `reply_to` naming an open request answers that request; (2) a `reply_to`
  naming the request just answered is the rest of that answer (a continuation,
  within 10 minutes); (3) a `reply_to` naming neither is recorded with **no**
  turn and claims nothing — it is a reply to something the emitter is not
  tracking, and crediting whichever request happens to be waiting would give it
  an answer it never got (round 1 did exactly that); (4) with no `reply_to`, the
  oldest open request; (5) with no `reply_to` and nothing open, the continuation;
  (6) otherwise proactive: no `turn_id`. An open request expires after 30
  minutes, and per-chat and total tracking is bounded. Only a message Telegram
  accepted answers a request — a failed or suppressed one is recorded against it
  and leaves it waiting. (The rework also fixed a stale-copy bug: pruning
  returned a filtered copy, so removing an answered request never touched the
  stored list and it stayed "oldest waiting".) A reply to a chat with no known
  trip is counted in memory (`unattributedReplies`) and writes no row; rows with
  a null trip were rejected as meaningless noise. The ignore decision carries no
  chat id, so a chat that only ever chats never becomes attributable — a chat id
  was deliberately not added to it. Proactive sends are attributed best-effort,
  from recent chat memory only. Unverified: that Hermes sets `reply_to` to the
  inbound message id on a companion `send` (the fake gateway in the tests does).
  Without it the emitter falls back to oldest-waiting matching, and a
  multi-message answer sent while another request is pending can be attributed to
  the wrong turn: counts stay right, latency may not.
- **`turn_id` is minted randomly at hand-off**, when the gateway accepts the
  frame. It is never derived from a message, chat or person, so the table cannot
  be joined back to Telegram. It is held in memory only long enough to match
  replies. How a later Hermes plugin will reproduce it is unsettled (below).
- **Latency.** For the companion: hand-off (`pushInbound`) to Telegram accepting
  a reply, per reply, in milliseconds (clamped to 0–24 h); the rollup takes the
  first delivered reply of each replied turn. It excludes the relay's own media
  download before hand-off and the person's send time. For the relay's own
  reads: from `toRelay()`, which runs when the decision is applied, so a read
  queued behind an earlier upload in the same chat's correction chain includes
  that wait. The rollup takes an IANA `timeZone` (default UTC) because the
  control plane holds no trip time zone yet (§6.4). A turn is counted on the
  local day it was handed off, and its replies are read by the window's
  `turn_id`s with **no upper time bound** (round 1 lost a reply landing past the
  window's edge: a turn answered 23:58 to 00:03 read "unanswered").
  "Unanswered" is derived from the table, not from a timer event. **Known
  limit:** a relay restart loses the in-memory attribution, so on a day the relay
  restarted `unanswered` is an upper bound; fixing it needs persisted open turns
  or a relay-stamped id on the wire.
- **Validation runs twice**: at enqueue, so a bug surfaces early (logged by
  field name, never by value), and again in the writer, for the later ingest
  route. Where the two validators differed the **JSON Schema is authoritative**
  and was tightened rather than the TS one loosened: `occurred_at` is a strict
  RFC 3339 pattern (`T`, `Z` or `±hh:mm`, at most 6 fractional digits, hours
  00–23) on top of `format: date-time`, plus a real days-in-month check in TS.
  Loosening TS to ajv's `date-time` was rejected: it accepts a space separator,
  `+0900`, `+09` and leap seconds no emitter here produces. `metadata: null` is
  refused on both sides; absent becomes `{}`. `validateAssistantEvent`
  snapshots its input once and checks and returns only the snapshot, because an
  accessor property could otherwise pass the check and return different text on
  a later read (shown live by the boundary audit); a throwing getter is
  `INVALID`.
- **Fail open.** Every method the relay calls is synchronous, returns nothing to
  await and never throws; it appends to a bounded queue (1,000 events) and a
  timer flushes batches of 200 every 2 seconds, each write abandoned after 10
  seconds and bounded database-side by the 5 s timeouts above. **At most one sink
  write exists at a time, an abandoned one included:** while it is outstanding
  the queue fills and drops. Starting a new write per tick was rejected — it piled
  up hung connections on the relay's shared pool. Connection acquisition
  (`pool.connect()`) is not itself bounded by the writer; it is bounded in effect
  by there never being more than one write outstanding (bounding it with
  `connectionTimeoutMillis` is a relay-wide pool change outside this slice).
  Retry of dropped batches was rejected to keep the slice simple — the
  idempotent writer would make it safe. The write-timeout timer is deliberately
  not `unref`'d: the tests showed a hung write must still time out when nothing
  else keeps the event loop alive. `stop()` has its own 2 s deadline, writes
  batch by batch, and drops the rest with code `STOP_DEADLINE`. All emitter
  logging goes through a try/catch (`safeLog`) and error codes are
  identifier-shaped `error.name` only. A throwing or hanging sink costs events,
  not replies, and a replay test asserts the same Telegram messages in the same
  order. A Telegram send that *throws*, rather than returning `ok: false`, is
  recorded as `failed_delivery` and rethrown unchanged, so the gateway's
  `outbound_result` is identical (tested). The limits: the queue lives in
  process memory, so a crash loses it; a dropped batch is not retried; a write
  abandoned at the timeout may still land, which `event_id` idempotency makes
  harmless; and the drop counter is visible only in a warning log line at most
  once a minute — nothing reads `stats` and no metric is exported yet. Events
  that fail contract validation are counted as rejected and logged as a bug.

### 16.6 Default off — and why unset means OFF

The emitter exists only when the relay is started with
`ASSISTANT_EVENTS_ENABLED=1`. Unset, empty, `0` or anything else is off, and an
unrecognized value logs that it was not understood; the boot log always says
which state was chosen. Off, `dispatch` attaches no descriptor and makes no
extra lookup, so every decision is exactly what it was before. Always attaching
the descriptor was rejected: it would add reads on every group message and
break existing `deepEqual` tests. A descriptor read that fails
drops only the descriptor, never the decision, and is logged by error class,
never by value (tested). Only `1` enables it (surrounding whitespace
ignored); other values are off and logged as not understood, so a typo in the
enabling direction is visible.

This is deliberately the **opposite** of the `INTERPRET_*` settings in
`CLAUDE.md`, where unset silently downgrades a working path and is therefore
the dangerous state. Here the danger is the other direction: a sprint-end
upgrade must not switch on the recording of when a family talks among
themselves as a side effect of code shipping. Do not "fix" the default. The code
comment in `analytics/emitter.ts` says the same.

### 16.7 Carry-forward

The owner confirmed the metadata stance for the MVP on 2026-09-25 (§16.3) and
deferred the family notice to full production (#186). The preconditions that
still stand before recording is switched on anywhere (from the
`regression-planner` and the reviews, as listed in #177's 2026-09-25 comment;
enabling goes to the Mac first, then production, as decided there):

1. **Schedule `purgeExpiredEvents`.** A precondition for enabling
   (§10 requires deletion jobs). Not scheduled by this slice.
2. **Tests the planner named:** a boot test for `relay/server.ts`;
   `handedOff(delivered=false)` through `applyDecision`; the connector's
   `suppressed` and `{ok:false}` branches; the `runDocumentCorrection`
   outcomes other than `failed_tool`, and the correction chain's catch path.
3. **#178 — done (PR #215):** the dispatch-built `document_correction`
   descriptor is now reachable; the route asked whether the wire event had
   media before any was attached, and now asks the message's own attachment.
   It has not been walked end to end on a real trip (#217).
4. **The compose `environment:` pass-through is a deploy decision.**
   `ASSISTANT_EVENTS_ENABLED` is not in the compose relay `environment:` list,
   so setting it in an env file does not reach the process; turning it on means
   changing the deployment's configuration and restarting the relay, which is a
   hard-rule-2 action. A boot check that the restart scripts do not enable
   recording silently is also owed.
5. **The Mac staging database has no timestamped migrations applied**, so a
   rehearsal there needs it migrated first.
6. **Metadata stance: confirmed for the MVP** (§16.3) — no longer open.
7. **Family notice / consent / opt-out: deferred to full production, #186.**
   Not an MVP precondition. Not designed here.

Open items for later slices:

8. **`turn_id` for the Hermes slice** — keyed derivation over profile, chat and
   message id with a shared secret, versus a relay-stamped wire field — is
   decided by that slice after inspecting the deployed `pre_gateway_dispatch`
   payload (§4.1). Until then the relay's `turn_id` cannot be joined to Hermes
   events.
9. **Keyed pseudonyms and content fingerprints** (§5.3), which need the rotating
   secret.
10. **Not in this slice:** retry of dropped batches; deriving a trip's phase time
   zone for the rollup (§6.4); recording router-answered commands (`/help`,
   `/name`, …) and interview turns; the authenticated ingest route that would
   wrap `writeAssistantEvents`.
11. **The organizer activity timeline (raised independently by both reviewers; a
   finding, not a decision).** `trip_id` + `requester_role = 'organizer'` + a
   millisecond `occurred_at` is a per-person activity timeline for each trip's
   one organizer, because only organizers are linked (migration 0051); in a group
   with exactly one non-organizer member, `unknown` is that one person. "No
   identifier is stored" holds for chat and user ids only. The
   owner confirmed the stance for the MVP without a notice (§16.3); the
   full-production notice in item 7 (#186) must cover this timeline.
12. **A future ingest route** must mint `event_id` and `turn_id` server-side (any
   well-formed UUID a client supplies is a 122-bit covert channel) and bound
   `occurred_at` (Postgres keeps 6 fractional digits and the schema now caps it at
   6, but the value is still client-chosen).
13. **Persisting attribution** — open turns, or a relay-stamped id on the wire —
    to remove the restart limit in §16.5.
14. **Splitting `other`** in `channel_type` (§16.3), once participants are
    linkable or a channel path exists.
