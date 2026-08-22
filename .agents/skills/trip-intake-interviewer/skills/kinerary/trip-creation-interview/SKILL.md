---
name: trip-creation-interview
description: Conduct a private, conversational Kinerary trip-creation interview with a prospective organizer, via the interview MCP server. Use only to collect, validate, summarize, and confirm a draft; never provision, deploy, activate, or modify a trip.
version: 2.0.0
---

# Kinerary trip-creation interview

## Mandatory boundary

This skill is for interview intake only. It has no authority to generate files, provision infrastructure, create a Hermes profile, connect a trip's own data MCP, start a gateway, deploy a website, or activate a trip. Its only tool access is the four `start_interview`/`get_session_status`/`submit_answer`/`confirm_intake` tools on the interview MCP server — nothing else.

## How this works

Every answer goes through `submit_answer` immediately — there is no local draft file. The control plane is the source of truth for what's been answered; if you need to check where the conversation left off, call `get_session_status` rather than relying on your own memory of the conversation (a restarted or resumed conversation must not lose answers).

Full field-by-field guidance: [references/QUESTIONS.md](references/QUESTIONS.md).

## Procedure

1. After the organizer confirms they're ready to begin, call `start_interview` with their enrollment token. Its response includes the first `nextQuestion` — start there.
2. For each question, ask it in plain conversational language (never read the raw `prompt` verbatim if a more natural phrasing fits the conversation) and call `submit_answer` with the organizer's answer once you have it. The response's `nextQuestion` tells you what to ask next; `state: "awaiting_confirmation"` and `nextQuestion: null` means every required question has been answered.
3. **Structured questions** (`travelers`, `phases`, `travel_anchors`, `constraints`) expect a JSON array or object in `submit_answer`'s `data` argument, not a string — see [references/QUESTIONS.md](references/QUESTIONS.md) for the exact shape each one expects. Assemble it from what the organizer told you conversationally; never ask them to produce JSON themselves.
4. If a question is skipped or answered only partially, that's fine for optional questions — just don't call `submit_answer` for it, or submit an empty array/object for a structured one. Required questions (see the reference) must have *some* answer, even a deliberately vague one like "TBD" for a text question, before confirmation is possible.
5. Once `state` is `awaiting_confirmation`, present a concise summary covering trip basics, travelers, stops/dates, and anything left TBD or skipped.
6. Require the literal, standalone explicit confirmation `CONFIRM`. An approval in another word or language is not confirmation.
7. After confirmation only, call `confirm_intake` and report that the setup request is confirmed and ready for the next step. Never say that a website, infrastructure, or trip agent has been created — `confirm_intake` produces an intake record, nothing more.

## Gotchas

- `submit_answer` overwrites the previous answer for that question — corrections before confirmation are normal, not an error state.
- Calling `confirm_intake` a second time after a successful confirmation is safe (it returns the same result) — useful if the organizer's connection drops right after confirming and you're not sure it went through.
- A structured question's `data` must be the actual JSON value (an array for `travelers`/`phases`/`travel_anchors`, an object for `constraints`) — passing a JSON-encoded *string* instead will be rejected.
