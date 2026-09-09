---
name: kinerary-intake-quality
description: Use for Kinerary intake state and document reconciliation.
version: 1.0.0
---

# Kinerary intake quality control

Use this alongside the core Kinerary interview skill when an organizer shares documents, corrects an earlier interpretation, or answers a button question in writing. This is intake-only: it records and validates answers but never provisions or activates a trip.

## Source-of-truth discipline

1. Before interpreting a new organizer message, read the current chat-scoped interview state.
2. After every write, verify the returned state and use its `recorded`/`selections`/`pendingAsk` values as the source of truth.
3. If the organizer's wording and the returned state disagree, do not explain the disagreement as system machinery; resolve it conversationally and correct the answer explicitly.
4. Never claim an answer was saved unless the write returned success.

## Document-first discipline

1. Extract an attached itinerary or booking document before replying.
2. Record every field it establishes before sending a message. Use structured batch recording where supported and individual text submissions for text fields.
3. Keep the document as an active reference through the rest of intake. Before every remaining question, check whether the document already answers it.
4. For right-to-left PDFs, dense tables, or broken reading order, render and inspect pages visually when text extraction might omit names, counts, or booking details.
5. Distinguish a party count from a roster. If a document says “5 adults” but contains no names or ages, report exactly that and ask only for the missing roster; never invent names from context.
6. When a user confirms transliterations, update the existing traveler records with `name_en` and `family_en` exactly as confirmed. Do not silently normalize spelling.

## Choice and dietary corrections

- A typed response such as “no” or “none” is not proof of what the router selected. Re-read state before acting.
- For dietary selections, `none` is exclusive. If state contains a real restriction, ask who it applies to and record `dietary_scope` immediately while the detail is fresh.
- If the organizer says “kosher,” use the `kosher` option, not `kosher_style`; kosher-style means no pork or shellfish while ordinary beef and chicken remain acceptable.
- If a written answer resolves a choice, submit the exact option id. Do not display or recreate the option list yourself.
- **Check `view.selections` on every state read.** Router button answers (dietary, trip_pace, etc.) appear in `selections` immediately when tapped. Submit them with `submit_answer_for_chat` before continuing — do not ask the organizer again and do not leave them unrecorded.

## Conversational pacing

Keep the organizer-facing message short and human. After a successful write, acknowledge the useful human fact rather than narrating internal progress. Ask at most one optional topic at a time; leave optional items open rather than interrogating the organizer through the whole list. Before recap, explain specifically how the named companion will use the group's roster, dates, route, pace, and dietary constraints.

## Reference

For the validated document/state reconciliation pattern and examples, see `references/document-state-reconciliation.md`.