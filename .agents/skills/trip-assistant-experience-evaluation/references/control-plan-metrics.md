# Trip Assistant Experience Control Plan Metrics

## Purpose

This document defines how Kinerary should measure the real-world value created by a trip assistant across the full product experience: the trip website, the conversational agent, the organizer workflow, and the family or group chat.

The goal is not only to measure whether the bot answered messages. The goal is to measure whether the whole trip-assistant system improved the travel experience, reduced organizer workload, helped travelers act with confidence, and learned enough from the group to become more useful over time.

A good trip assistant is a control loop:

1. The organizer uploads or confirms trip information.
2. Travelers ask questions in the group or in private.
3. The assistant answers from verified trip data.
4. The assistant identifies missing information, asks focused follow-up questions, and encourages the organizer to complete the source of truth.
5. New facts, preferences, documents, and decisions are written back into the trip system.
6. The next answer is better because the trip knowledge base became richer.

This document should be used as part of the control plan for evaluating and improving that loop.

---

## Core Principle

Measure **trip value delivered**, not just model quality.

A polished answer is not good service if the traveler did not get what they needed. For example:

- If the bot was technically configured but did not answer in the group, the service quality is low. The traveler experienced no service.
- If the bot identified a routing bug after the fact, that is useful for debugging, but it does not retroactively improve the traveler experience.
- If the bot cannot provide the official trip website URL, the service quality is low, even if it explains why.
- If the website contains partial data, the assistant should say what is missing and ask the organizer for the smallest missing artifact that would unlock future value.

The evaluation should separate:

- **What the system controlled**: availability, response behavior, data extraction, consistency, prompts to the organizer, website updates.
- **What the organizer controlled**: whether confirmations, vouchers, itinerary decisions, preferences, and documents were provided.
- **What the travelers experienced**: whether they got clear, timely, actionable help.

---

## Top-Level Score

Use a 1–5 score for the overall trip-assistant experience.

| Score | Meaning |
|---:|---|
| 1 | Almost no value: unavailable, missing data, or no meaningful usage. |
| 2 | Point value only: works sometimes, but unreliable or too incomplete for travelers to trust. |
| 3 | Useful baseline service: answers common logistics questions and helps the organizer, but does not yet drive the trip experience. |
| 4 | Strong service: mostly available, grounded in the website, proactive about missing information, and visibly reduces organizer workload. |
| 5 | Excellent trip companion: reliable, trusted, learns from the group, keeps the website current, and improves the trip day by day. |

Recommended weighted model:

| Dimension | Weight |
|---|---:|
| Availability and response reliability | 15% |
| Website data completeness and freshness | 20% |
| Accuracy and cross-channel consistency | 15% |
| Operational value for travelers and organizer | 20% |
| Family/group experience quality | 10% |
| Learning, enrichment, and organizer enablement | 20% |

---

## 1. Availability and Response Reliability

### Question

Did travelers receive service when they tried to use the assistant?

### Metrics

- Number of inbound traveler messages to the bot.
- Number of unique users who contacted the bot.
- Number of messages in the group vs. private chats.
- Percentage of inbound messages that received an assistant response.
- Median and p90 response latency.
- Number of unanswered mentions in the group.
- Number of incidents where the bot was configured but did not respond.
- Recovery time after a failure.

### Scoring Guidance

| Score | Description |
|---:|---|
| 1 | Bot mostly unavailable or does not respond to direct mentions. |
| 2 | Bot responds in some channels but fails in important group interactions. |
| 3 | Bot usually responds, with occasional failures or delays. |
| 4 | Bot reliably responds in expected channels with low latency. |
| 5 | Bot is reliable, monitored, and failures are detected before users complain. |

### Examples

Good:

- A traveler asks: "When do we fly to Maui?" The assistant answers within seconds using the verified itinerary.
- The assistant detects a group mention that did not receive a response and alerts the operator.

Bad:

- Travelers tag the bot in the group and receive no answer.
- The system later explains the failure well, but the travelers still experienced no service.

### Ownership

**Kinerary / assistant owned:** routing, gateway uptime, group binding, mention detection, response delivery, monitoring, alerts.

**Organizer owned:** adding the bot to the right group, giving it the required permissions, telling travelers how to invoke it when needed.

---

## 2. Website Data Completeness and Freshness

### Question

Does the trip website contain enough verified information for the assistant to be useful?

### Metrics

- Percentage of flights with full data: airline, flight number, origin, destination, date, departure time, arrival time, booking reference, confirmation file.
- Percentage of hotels with full data: name, address, check-in/check-out dates, confirmation number, room notes, voucher file.
- Percentage of car rentals with full data: supplier, vehicle class, pickup/drop-off location, pickup/drop-off time, driver, confirmation file.
- Percentage of days with a useful day plan.
- Percentage of booked attractions represented as structured records.
- Count of missing critical fields.
- Count of uploaded documents: PDFs, confirmations, vouchers, tickets.
- Freshness: whether the website reflects the latest organizer-approved changes.

### Scoring Guidance

| Score | Description |
|---:|---|
| 1 | Website has only a title or shell. |
| 2 | Basic trip skeleton exists, but many answers require organizer memory. |
| 3 | Core logistics are present; some documents or details are missing. |
| 4 | Most logistics and daily plans are complete and structured. |
| 5 | Website is a high-confidence source of truth, including documents, decisions, preferences, and current day context. |

### Examples

Good:

- The website contains the Maui flight number and times, so the assistant can answer: "Southwest WN1870, 12:20–13:10."
- A rental-car voucher is uploaded and parsed into supplier, pickup time, drop-off time, confirmation number, and attached PDF.

Bad:

- The assistant can only say: "Return flight exists, but no time is available."
- The website URL is not stored in a discoverable, authoritative place.
- Hotel confirmation documents are missing, so the organizer still has to search email.

### Ownership

**Kinerary / assistant owned:** schema design, upload flow, extraction, validation, missing-field reporting, surfacing the source of truth.

**Organizer owned:** providing confirmations, PDFs, booking references, itinerary decisions, and updates when plans change.

---

## 3. Accuracy and Cross-Channel Consistency

### Question

Are the assistant, website, and live trip data telling the same story?

### Metrics

- Number of answers grounded in verified website data.
- Number of answers that explicitly mark assumptions or missing information.
- Number of inconsistent answers across channels.
- Number of times the assistant gives a bot link instead of the website link.
- Number of itinerary updates that appear in the database but not correctly in the traveler-facing UI.
- Number of corrections required after the assistant said something was done.

### Scoring Guidance

| Score | Description |
|---:|---|
| 1 | Frequent contradictions or hallucinated trip facts. |
| 2 | Some correct answers, but trust is harmed by inconsistent links, stale UI, or premature "done" claims. |
| 3 | Mostly accurate, but not consistently verified against the traveler-facing experience. |
| 4 | Accurate, grounded, and clear about unknowns. |
| 5 | Assistant, website, and documents are consistent, with automatic checks after updates. |

### Examples

Good:

- The assistant says: "Verified: the Maui flight is WN1870, 12:20–13:10. I do not have the return-flight time yet."
- After changing a day plan, the assistant verifies that the traveler-facing website shows the same plan.

Bad:

- The assistant provides a Telegram bot link when asked for the trip website.
- The assistant says "updated on the website" while the organizer still sees duplicate or stale day cards.

### Ownership

**Kinerary / assistant owned:** grounding policy, live reads before answering, post-write verification, website URL discoverability, UI/cache validation.

**Organizer owned:** confirming which plan is the approved plan when there are competing versions.

---

## 4. Operational Value for Travelers and Organizer

### Question

Did the assistant reduce friction during the trip?

### Metrics

- Number of repeated logistics questions answered by the assistant instead of the organizer.
- Number of direct answers to time-sensitive questions: flights, hotel, car return, meeting point, daily plan.
- Number of proactive reminders generated from verified data.
- Number of organizer interruptions avoided.
- Number of traveler decisions made easier by a recommendation plus one fallback.
- Number of times the assistant provided a next action, not only information.

### Scoring Guidance

| Score | Description |
|---:|---|
| 1 | Organizer still has to answer nearly everything manually. |
| 2 | Assistant helps occasionally but cannot be relied on for day-to-day operations. |
| 3 | Assistant answers common questions and saves some organizer effort. |
| 4 | Assistant is a dependable operational layer for the group. |
| 5 | Assistant significantly reduces organizer load and improves daily flow for travelers. |

### Examples

Good:

- "When do we fly to Maui?" -> "Monday, Aug 17. Southwest WN1870, departure 12:20, arrival 13:10. Keep checkout and airport buffer in mind."
- "Which day is the volcano?" -> "Haleakalā is Wednesday, Aug 19. Bring warm layers because it is much colder at altitude."

Bad:

- The assistant answers with raw config terminology that travelers do not understand.
- The assistant cannot answer because the relevant booking or plan was never uploaded, and it does not ask the organizer to complete it.

### Ownership

**Kinerary / assistant owned:** useful answer format, family-friendly phrasing, practical next steps, reminder generation.

**Organizer owned:** approving daily plan changes and providing the decisions that the assistant should operationalize.

---

## 5. Family and Group Experience Quality

### Question

Does the assistant feel like a helpful trip companion for the actual group?

### Metrics

- Clarity and brevity of answers.
- Use of the group language and tone.
- Whether answers are actionable for mixed families, children, teenagers, and adults.
- Whether sensitive information is kept out of the public group.
- Whether the assistant gives one leading recommendation plus one fallback instead of overwhelming users.
- Number of positive or repeated usages from non-organizer travelers.

### Scoring Guidance

| Score | Description |
|---:|---|
| 1 | Robotic, confusing, or unsafe for group use. |
| 2 | Sometimes useful but too technical, verbose, or inconsistent. |
| 3 | Clear enough for basic questions. |
| 4 | Warm, practical, and suited to the group. |
| 5 | Feels like a trusted family trip assistant with good judgment. |

### Examples

Good:

- "The volcano day is Wednesday, Aug 19 🌋. It is beautiful but cold at the top, so bring warm layers. If the group is tired, sunset is easier than sunrise."

Bad:

- "Config phase maui day 2026-08-19 contains Haleakala."  
- Posting passwords, confirmation numbers, or private documents in the group.

### Ownership

**Kinerary / assistant owned:** tone, privacy, formatting, recommendations, language adaptation.

**Organizer owned:** telling the assistant what should be public vs. private, and providing group preferences.

---

## 6. Learning, Enrichment, and Organizer Enablement

### Question

Did the assistant make the trip knowledge base richer over time?

This dimension is as important as answering. The assistant should not only consume website data; it should help the organizer and group produce better data.

### Sub-Dimensions

#### 6.1 Ease of Adding Information

Can the organizer add information without using a complex admin interface?

Metrics:

- Number of trip facts added through chat.
- Number of documents uploaded through chat.
- Number of plan changes completed from natural language.
- Time from organizer message to structured website update.
- Number of repeated corrections needed after an update.

Examples:

- Organizer sends: "Tomorrow switch Diamond Head with the beach day." The assistant identifies the two dates, updates the itinerary, verifies the website, and summarizes the change.
- Organizer uploads a PDF voucher. The assistant extracts supplier, dates, confirmation number, passengers, and attaches the PDF to the booking.

#### 6.2 Learning from Group Conversation

Does the assistant detect useful signals from the family chat?

Metrics:

- Number of new preferences inferred from group conversation and confirmed.
- Number of recurring questions converted into website content, pinned answers, or shortcuts.
- Number of field decisions captured from chat.
- Number of questions that reveal missing source-of-truth data.

Examples:

- Several travelers ask for steak restaurants. The assistant asks the organizer: "Should I save a group preference for high-quality steakhouse recommendations?"
- Travelers repeatedly ask for the website link. The assistant flags that the official URL must be stored and easily retrievable.
- A traveler says the group is tired. The assistant offers to mark the next day as a lighter pace and suggests lower-effort alternatives.

#### 6.3 Smart Follow-Up Questions

Does the assistant ask the smallest useful question to unlock more value?

Metrics:

- Number of missing fields detected.
- Number of targeted follow-up questions asked.
- Response rate to follow-up questions.
- Percentage of follow-ups that resulted in new structured data.
- Number of avoided broad or annoying questions.

Good follow-ups:

- "I have the return flight number but not the time. Can you upload the confirmation or send a screenshot? Then I can answer everyone automatically."
- "Is the Diamond Head reservation already booked, or should I mark it as 'requires booking'?"
- "Is this restaurant plan for the full group or only one family?"

Bad follow-ups:

- "Please provide more details."
- Asking the public group for private booking data.
- Asking too many questions when one missing field would be enough.

#### 6.4 Turning Unstructured Input into Structured Trip Data

Can the assistant transform messy input into useful website records?

Metrics:

- Number of PDFs converted into bookings.
- Number of screenshots converted into bug reports or itinerary updates.
- Number of chat messages converted into activities, reminders, preferences, or tasks.
- Extraction accuracy.
- Post-write verification success rate.

Examples:

- PDF -> car booking with attached confirmation file.
- Screenshot showing duplicate itinerary days -> UI/data consistency issue with a verified fix.
- Message: "Tonight dinner at 8 at X" -> optional evening activity with time and map link.

#### 6.5 Encouraging the Organizer to Upload More Data

The assistant should explain why uploading data helps, not just ask for it.

Metrics:

- Number of focused organizer prompts generated.
- Percentage of prompts that produce new uploaded data.
- Number of repeated traveler questions reduced after data completion.
- Number of missing-data prompts tied to clear traveler value.

Good prompt:

> "If you upload the hotel vouchers, I can answer the group about check-in, address, confirmation, and room notes without you searching email during the trip."

Bad prompt:

> "Please upload more data."

### Scoring Guidance

| Score | Description |
|---:|---|
| 1 | The assistant does not learn from the trip and does not help collect information. |
| 2 | It occasionally stores information when explicitly instructed, but does not drive enrichment. |
| 3 | It can add data through chat, but follow-up and verification are inconsistent. |
| 4 | It regularly identifies missing information, asks focused questions, and updates the website. |
| 5 | It creates a strong learning loop: every interaction can improve the trip source of truth. |

### Ownership

**Kinerary / assistant owned:** extraction, follow-up prompts, information-gap detection, confirmation workflow, structured writes, verification.

**Organizer owned:** approving changes, providing documents, answering targeted questions, deciding what should be shared publicly.

---

## Missing-Information Control Loop

Whenever the assistant cannot answer from verified data, it should follow this pattern:

1. **Answer what is known.**  
   Example: "I have the return flight number: LH 4353."

2. **State the missing field.**  
   Example: "I do not have the verified departure time."

3. **Ask for the smallest useful artifact.**  
   Example: "Can you upload the flight confirmation or send a screenshot?"

4. **Explain the value.**  
   Example: "Then I can answer the group automatically and remind everyone at the right time."

5. **Write back after confirmation.**  
   Example: Add the time, route, and confirmation file to the website.

6. **Verify traveler-facing output.**  
   Example: Confirm that the website and assistant now return the same flight details.

---

## Suggested Daily Control Plan Report

A daily report should include:

### Usage

- Inbound messages to the bot.
- Unique travelers who used it.
- Group vs. private usage.
- Response rate and latency.
- Unanswered mentions or failed deliveries.

### Value Delivered

- Questions answered from verified website data.
- Questions answered with partial data.
- Questions that required organizer intervention.
- Repeated questions that the assistant handled.
- Operational reminders or decisions supported.

### Information Quality

- New website records added.
- Documents uploaded and parsed.
- Missing fields that blocked better answers.
- Stale or inconsistent website areas.
- Private data risks detected.

### Learning and Enrichment

- New preferences learned.
- New itinerary decisions captured.
- Follow-up questions asked.
- Follow-ups answered.
- Unstructured inputs converted into structured records.

### Organizer Enablement

- Top 3 missing items to request from the organizer.
- The traveler value unlocked by each item.
- Suggested message to ask for those items.

Example organizer prompt:

> "Three uploads would make the assistant much more useful tomorrow: the return-flight confirmation, hotel vouchers for Vegas, and any booked attraction tickets. With those, the bot can answer times, addresses, confirmation questions, and reminders without you needing to search your phone."

---

## Example Evaluation Rubric

| Area | Score | Evidence | Owner | Next Improvement |
|---|---:|---|---|---|
| Group response reliability | 2/5 | Bot missed direct mentions in the group. | Kinerary | Add unanswered-mention monitoring and alerting. |
| Website URL consistency | 2/5 | Assistant gave inconsistent answers for the site link. | Kinerary | Store canonical public trip URL in config and expose it via API. |
| Maui flight logistics | 5/5 | Assistant answered date, flight number, departure and arrival times from verified data. | Shared | Add reminder automation. |
| Return flight completeness | 3/5 | Flight number exists but time is missing. | Organizer | Ask organizer to upload flight confirmation. |
| Itinerary day updates | 3/5 | Assistant updated records, but traveler-facing UI still showed confusion. | Kinerary | Require post-write UI verification. |
| Voucher management | 2.5/5 | Some structured bookings exist, but many confirmations are missing. | Shared | Prompt organizer for missing PDFs in priority order. |
| Learning from group | 2.5/5 | Group preferences and recurring questions were not systematically captured. | Kinerary | Add confirmed-preference capture flow. |

---

## Why This Matters

The strongest value of a trip assistant is not that it can generate nice messages. The strongest value is that it becomes the operational memory of the trip.

When this loop works:

- Travelers get fast answers without bothering the organizer.
- The organizer spends less time searching emails, PDFs, and group history.
- The website becomes a living source of truth.
- Repeated group questions turn into structured knowledge.
- Missing information becomes an actionable checklist.
- The assistant becomes more useful every day of the trip.

When the loop does not work:

- The assistant may sound helpful but cannot be trusted.
- The organizer remains the bottleneck.
- The website is incomplete or stale.
- The group keeps asking the same questions.
- Failures are discovered by travelers instead of by monitoring.

The control plan should therefore optimize for a full product outcome:

> **Trip Assistant Value = usage + verified data + reliable responses + operational help + group experience + continuous learning.**

---

## Implementation Notes

Potential event types to log:

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

Useful derived metrics:

- Response rate = responses sent / inbound messages.
- Grounded answer rate = verified-data answers / total answers.
- Missing-data rate = missing-data answers / total answers.
- Enrichment conversion rate = structured updates / enrichment opportunities.
- Organizer prompt conversion rate = completed uploads or answers / prompts sent.
- Traveler self-service rate = traveler questions answered without organizer intervention / total traveler questions.
- Post-write trust rate = verified visible updates / total writes.

These metrics should be grouped by trip, phase, day, channel, user role, and topic so the control plan can identify whether quality problems come from platform reliability, website data gaps, organizer workflow friction, or assistant behavior.

- Repeated-question reduction = decrease in repeated questions after a fact, link or document is added to the source of truth.

---

## Scoring Notes

Carried over from the earlier condensed version of this reference; these are the
traps that produce a flattering score for a service travelers did not receive.

- Do not give high availability scores just because the bot is configured; travelers must actually receive responses.
- Do not give high accuracy scores for a correct explanation of missing data if the system should have known or stored that data.
- Give credit for explicitly asking the organizer for the smallest missing artifact and explaining the value unlocked.
- Treat public group answers and private organizer answers differently when sensitive data is involved.
- Prefer evidence from live site data and logs over memory or assumptions.
