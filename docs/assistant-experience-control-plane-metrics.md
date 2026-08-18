# Assistant Experience Metrics for the Control Plane

How to judge whether the trip assistant is actually useful, and what to report
daily. Originated as a Hermes evaluation reference
(`trip-assistant-experience-evaluation`) and moved here so it is versioned with
the control plane it measures.

**This is the evaluation layer, not the instrumentation layer.**
`trip-bot-analytics-and-metrics-design.md` stays the authority for the event
contract (§5), the request-type taxonomy (§6), bounded Prometheus labels (§8)
and retention (§10). The events below are *outcome* events — they describe how
well a request was served, where §6 classifies what was asked — and must be
emitted inside that base event schema rather than as a parallel system. If the
two ever disagree, fix the event contract there and link to it; do not fork a
second vocabulary here.

Implementation is split across two sprints in `onboarding-mvp-sprint-plan.md`:
the event taxonomy and daily report land in Sprint 6 alongside the dashboard,
the scoring rubric and repeated-question reduction in Sprint 7 with reviewed
learning.

## Product Thesis

A trip assistant creates value when it becomes the operational memory of the trip:

- travelers get fast answers without asking the organizer repeatedly;
- the organizer stops searching emails, PDFs, and group history;
- the website becomes a living source of truth;
- repeated questions and group decisions become structured knowledge;
- every missing fact becomes an actionable upload/request;
- the assistant gets more useful as the trip progresses.

## Event Taxonomy

Suggested events to log:

- `inbound_message_received`
- `assistant_response_sent`
- `assistant_response_failed`
- `group_mention_unanswered`
- `verified_data_answered`
- `partial_data_answered`
- `missing_data_detected`
- `organizer_followup_requested`
- `organizer_followup_answered`
- `document_uploaded`
- `document_extracted`
- `trip_record_created`
- `trip_record_updated`
- `post_write_verification_passed`
- `post_write_verification_failed`
- `preference_detected`
- `preference_confirmed`
- `recurring_question_detected`

Group events by trip, phase, day, channel, user role, and topic.

## Derived Metrics

- **Response rate** = assistant responses sent / inbound messages.
- **Grounded answer rate** = verified-data answers / total answers.
- **Missing-data rate** = missing-data answers / total answers.
- **Traveler self-service rate** = traveler questions answered without organizer intervention / total traveler questions.
- **Enrichment conversion rate** = structured updates / enrichment opportunities.
- **Organizer prompt conversion rate** = completed uploads or answers / organizer prompts sent.
- **Post-write trust rate** = verified visible updates / total writes affecting traveler UI.
- **Repeated-question reduction** = decrease in repeated questions after a fact/link/document is added to the source of truth.

## Daily Control Plan Report

A useful daily report should include:

### Usage
- inbound messages to the bot;
- unique travelers;
- group vs private usage;
- response rate and latency;
- unanswered mentions or failed deliveries.

### Value Delivered
- questions answered from verified site data;
- questions answered with partial data;
- questions requiring organizer intervention;
- repeated questions handled by the assistant;
- reminders or decisions supported.

### Information Quality
- new website records added;
- documents uploaded and parsed;
- missing fields that blocked better answers;
- stale or inconsistent website areas;
- private-data risks detected.

### Learning and Enrichment
- new preferences learned;
- new itinerary decisions captured;
- follow-up questions asked;
- follow-ups answered;
- unstructured inputs converted into structured records.

### Organizer Enablement
- top 3 missing items to request from the organizer;
- traveler value unlocked by each item;
- suggested short message to ask for those items.

Example organizer prompt:

> Three uploads would make the assistant much more useful tomorrow: the return-flight confirmation, the next hotel voucher, and any booked attraction tickets. With those, the bot can answer times, addresses, confirmation questions, and reminders without you needing to search your phone.

## Example Rubric Rows

| Area | Score | Evidence | Owner | Next Improvement |
|---|---:|---|---|---|
| Group response reliability | 2/5 | Bot missed direct mentions in the group. | Kinerary | Add unanswered-mention monitoring and alerting. |
| Website URL consistency | 2/5 | Assistant gave inconsistent answers for the site link. | Kinerary | Store canonical public trip URL in config/API. |
| Maui flight logistics | 5/5 | Assistant answered date, flight number, departure and arrival from verified data. | Shared | Add reminder automation. |
| Return flight completeness | 3/5 | Flight number exists but time is missing. | Organizer | Ask organizer to upload flight confirmation. |
| Itinerary day updates | 3/5 | Records were updated but traveler-facing UI still confused the organizer. | Kinerary | Require post-write UI verification. |
| Voucher management | 2.5/5 | Some bookings exist, but many confirmations are missing. | Shared | Prompt organizer for missing PDFs in priority order. |
| Learning from group | 2.5/5 | Preferences and recurring questions were not systematically captured. | Kinerary | Add confirmed-preference capture flow. |

## Scoring Notes

- Do not give high availability scores just because the bot is configured; travelers must actually receive responses.
- Do not give high accuracy scores for a correct explanation of missing data if the system should have known or stored that data.
- Give credit for explicitly asking the organizer for the smallest missing artifact and explaining the value unlocked.
- Treat public group answers and private organizer answers differently when sensitive data is involved.
- Prefer evidence from live site data and logs over memory or assumptions.
