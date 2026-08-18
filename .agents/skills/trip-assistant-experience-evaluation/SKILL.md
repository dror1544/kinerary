---
name: trip-assistant-experience-evaluation
description: "Evaluate trip-assistant value: site+bot+organizer+group."
version: 1.0.0
author: Hermes
license: MIT
metadata:
  hermes:
    tags: [travel, quality, control-plan, metrics, organizer-enablement, trip-assistant]
    category: travel
---

# Trip Assistant Experience Evaluation

Use this skill when the user asks to evaluate, score, audit, or design metrics for a travel-assistant product: the trip website, Telegram/group bot, organizer workflow, and traveler experience as one service.

## Core Principle

Measure **trip value delivered**, not only answer quality.

A beautiful answer is still poor service if the traveler did not get timely help. Judge the full product outcome:

- Did travelers get answers when they tried to use the assistant?
- Were answers grounded in verified trip-site data?
- Did the website and bot stay consistent?
- Did the assistant reduce organizer workload?
- Did it learn from group conversation and enrich the trip source of truth?
- Did it encourage the organizer to upload the missing information that would unlock more value?

Be explicit about what is:

- **System-owned**: bot availability, routing, monitoring, extraction, post-write verification, consistency, prompts.
- **Organizer-owned**: uploading confirmations, approving changes, answering targeted questions, deciding what may be public.
- **Traveler-experienced**: clear, timely, actionable help.

## Recommended Scorecard

Score each dimension 1–5 and provide evidence.

| Dimension | Weight |
|---|---:|
| Availability and response reliability | 15% |
| Website data completeness and freshness | 20% |
| Accuracy and cross-channel consistency | 15% |
| Operational value for travelers and organizer | 20% |
| Family/group experience quality | 10% |
| Learning, enrichment, and organizer enablement | 20% |

Overall interpretation:

| Score | Meaning |
|---:|---|
| 1 | Almost no value: unavailable, missing data, or no meaningful usage. |
| 2 | Point value only: works sometimes, but unreliable or too incomplete for travelers to trust. |
| 3 | Useful baseline service: answers common logistics questions and helps the organizer, but does not yet drive the trip experience. |
| 4 | Strong service: mostly available, grounded in the website, proactive about missing information, and visibly reduces organizer workload. |
| 5 | Excellent trip companion: reliable, trusted, learns from the group, keeps the website current, and improves the trip day by day. |

## Evaluation Workflow

1. **Define the measurement window.**
   State whether you are evaluating since trip start, last day, current destination, or a specific incident.

2. **Collect product evidence.**
   Use live trip data when available: config, bookings, budget, tasks, RSVP/trivia/photos/comments, site health, and chat logs if accessible.

3. **Count service usage.**
   Count inbound traveler messages, unique users, group vs. private usage, response rate, unanswered mentions, and repeated topics.

4. **Assess data completeness.**
   Look for missing or partial flights, hotels, cars, vouchers, attraction tickets, daily plans, official website URL, budget, and preferences.

5. **Assess service quality from the traveler viewpoint.**
   Do not over-credit internal debugging. If the bot did not answer in the group, score availability low even if the failure was later diagnosed.

6. **Separate ownership.**
   For every low score, say what Kinerary/assistant must improve and what the organizer must provide.

7. **Evaluate learning and enrichment.**
   Count how many new facts, documents, preferences, itinerary decisions, and missing-data prompts were captured from conversation.

8. **Recommend the next smallest actions.**
   Give the organizer 3–5 high-leverage uploads/answers and explain the traveler value each unlocks.

## Dimension Details

### 1. Availability and Response Reliability

Ask: did travelers receive service when they tried to use the assistant?

Metrics:
- inbound messages to the bot
- unique users
- group vs private usage
- response rate
- latency
- unanswered group mentions
- delivery failures and recovery time

Scoring pitfall: a technically connected Telegram group is not enough. If travelers tagged the bot and got no answer, the service quality for that incident is low.

### 2. Website Data Completeness and Freshness

Ask: does the trip website contain enough verified information for the assistant to answer confidently?

Metrics:
- flights with number, route, time, confirmation file
- hotels with address, check-in/out, confirmation, voucher
- cars with pickup/dropoff, supplier, confirmation, voucher
- daily plans with practical pacing
- attractions and tickets
- budget/RSVP/trivia/preferences if these features matter
- freshness vs. latest organizer-approved changes

### 3. Accuracy and Cross-Channel Consistency

Ask: are the website, assistant, and group answers telling the same story?

Key checks:
- do not substitute a Telegram bot link for the public trip website URL
- do not claim a site update is visible if only the backend write was verified
- distinguish verified facts from missing information and suggestions
- use the same canonical URL and itinerary facts across private and group channels

### 4. Operational Value

Ask: did the assistant reduce friction?

Examples of value:
- answering “when is the Maui flight?” from verified data
- explaining “which day is Haleakalā?” with practical clothing/pacing advice
- saving the organizer from repeated link/time/location questions
- turning current-day plans into concise, family-ready summaries

### 5. Family/Group Experience

Ask: does the assistant feel useful to the actual group?

Look for:
- clear Hebrew or the group’s language
- short practical answers
- one leading recommendation plus one fallback
- privacy-safe handling of passwords, confirmation numbers, and personal data
- minimal technical jargon

### 6. Learning, Enrichment, and Organizer Enablement

Ask: did the assistant make the trip knowledge base richer over time?

This is not optional. The ability to get the organizer and group to provide more information is as important as answering.

Measure:
- facts added through chat
- documents uploaded and parsed
- itinerary decisions captured
- preferences learned from group conversation
- missing fields detected
- targeted follow-up questions asked
- follow-ups that became structured site data
- repeated questions converted into source-of-truth content

Good behavior:
- “I have the return flight number but not the time. Upload the confirmation and I can answer everyone automatically.”
- “Should I save that the group prefers high-quality steakhouse recommendations?”
- “Is Diamond Head booked, or should I mark it as requires booking?”

Bad behavior:
- saying only “I don’t know” without asking for the smallest artifact that would fix it
- asking broad “send more details” questions
- learning from group chat without confirmation when the fact affects the public trip plan

## Missing-Information Control Loop

When a fact is missing:

1. Answer what is known.
2. State the missing field.
3. Ask for the smallest useful artifact or answer.
4. Explain the traveler value unlocked.
5. After organizer confirmation, write it to the trip source of truth.
6. Verify both server state and traveler-facing display when relevant.

Example:

> I have the return flight number: LH 4353. I do not have the verified departure time. If you upload the confirmation or send a screenshot, I can save it and answer the group automatically next time.

## Reporting Pattern

Use this structure for a quality report:

1. **Executive score:** overall 1–5 and one-sentence reason.
2. **Scorecard table:** each dimension, score, evidence, owner, next improvement.
3. **Value delivered:** what traveler/organizer problems were solved.
4. **Failures or trust risks:** where the service did not meet the product promise.
5. **Information gaps:** what missing data reduced service quality.
6. **Organizer enablement:** top uploads/answers to request, with value unlocked.
7. **System actions:** monitoring, consistency, extraction, or UI verification improvements.

## References

- `references/control-plan-metrics.md` — detailed metric definitions, examples, and event taxonomy for Kinerary control-plan work.
