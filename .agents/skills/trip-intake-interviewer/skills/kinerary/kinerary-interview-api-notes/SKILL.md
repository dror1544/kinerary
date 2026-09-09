---
name: kinerary-interview-api-notes
description: Kinerary chat-scoped interview API pitfalls and arg names.
version: 1.1.0
---

# Kinerary interview — chat-scoped API notes

Production-discovered facts about the interview MCP tools in the Telegram
chat-scoped flow. Load alongside `trip-creation-interview` for every session.

## Available tools (chat-scoped flow only)

You hold **no `sessionId` or `sessionToken`** — only the `_for_chat` variants work:

- `get_interview_for_chat` — no arguments; reads current state
- `submit_answer_for_chat` — submits one answer
- `say_for_chat` — sends a message to the organizer
- `ask_question_for_chat` — sends an optional question with its buttons
- `show_summary_for_chat` — triggers recap + Confirm/Keep-planning
- `set_interview_language_for_chat` — sets the interview language once

**These always fail — do not call them:**
`submit_answer`, `get_session_status`, `start_interview`, `confirm_intake`,
`extract_itinerary`, `lookup_consular_contacts` (all require sessionToken).

## Argument names for `submit_answer_for_chat`

| Question type | Correct argument | Common mistake |
|---|---|---|
| `text` | `otherText` | `answer` or `text` — returns TEXT_REQUIRED error |
| `choice` | `optionId` (string) | — |
| `multi_choice` | `optionIds` (array) | comma-string in `optionId` |
| `structured` | `data` (actual JSON value) | JSON-encoded string |

## `say_for_chat` — calling pattern

`say_for_chat` is a deferred MCP tool. **Call it directly as
`mcp__interview__say_for_chat`.** Accepts one argument: `text`. **One call per
turn** — a second call replaces the first message, it does not append.

**Availability quirk (observed 2026-09-07):** the tool sometimes transiently
reports "does not exist" as a direct call, then works on retry. Sequence:
1. Try `mcp__interview__say_for_chat` directly.
2. If "does not exist", try via `tool_call(name="mcp__interview__say_for_chat", ...)`.
3. If `tool_call` errors with "not a deferrable tool", retry step 1 — that
   error means the tool IS in the direct list; the direct call will succeed.

Do not tell the organizer anything is broken unless all three steps fail.

## Session lifetime and the 404 boundary

The router reclaims the turn as soon as `nextQuestion` becomes null (all
required questions answered). After that, `say_for_chat` and
`get_interview_for_chat` return `404 NOT_FOUND`. The session is fine — the
turn ended.

When you hit this boundary: (1) do not retry, (2) write an issue notification
file, (3) stop — the router re-opens a turn when the organizer writes next.

**Practical implication:** interleave important optional questions (dietary,
pace, bot name/tone) with required answers *before* submitting `phases`. Once
`nextQuestion` is null the turn closes and you can no longer send messages.

## Choice questions — do not skip

`trip_type`, `trip_pace`, `bot_gender`, `bot_tone` are router questions with
real Telegram buttons. Do not bypass them by jumping ahead to other answers.
If the organizer types a choice in writing, resolve it to the option id and
call `submit_answer_for_chat` with `optionId`.

## `record_answers_for_chat` — batch field names and limitations

`record_answers_for_chat` accepts a list of `answers`, each with `questionId`
plus **one** of:

| Field | For question types |
|---|---|
| `structured` | `structured` questions (array/object) |
| `optionId` | `choice` |
| `optionIds` | `multi_choice` |

**Confirmed in session (2026-09-05):** the batch call silently rejects
`text`-type questions — they come back in `rejected[]` with `TEXT_REQUIRED`,
even when a `text` key is supplied. The only reliable path for text-type
questions (`destination`, `departure_date`, `return_date`, etc.) is individual
`submit_answer_for_chat` calls with `otherText`.

**Pattern:** use `record_answers_for_chat` for structured/multi-choice answers
from a document; follow with individual `submit_answer_for_chat(otherText=...)`
calls for every `text`-type question.

## Document-first workflow

When the organizer uploads a booking PDF:

1. Extract text via the Python API — **not** the CLI (`pymupdf text` is an
   invalid subcommand; the correct CLI verb is `gettext`, but the Python API
   is simpler and always reliable):
   ```python
   import pymupdf
   doc = pymupdf.open(path)
   text = "".join(p.get_text() for p in doc)
   ```
2. **Record before speaking.** Call `record_answers_for_chat` for structured
   and multi-choice answers, then individual `submit_answer_for_chat` calls
   (with `otherText`) for text-type fields — all before sending any message.
   The organizer must never be asked for something that was in the document.
3. Confirm your reading in a single `say_for_chat` message; do not ask the
   organizer to retype anything already in the document.
4. `extract_itinerary` is unavailable (sessionToken required). Extract venues
   manually and include them in the `phases` data array under a `venues` key.
5. `lookup_consular_contacts` is also unavailable — skip silently; the site
   falls back to generic emergency numbers.

## `selections` — reading pre-answered button questions

When the organizer taps a router button (e.g. `dietary`, `trip_pace`), the
answer is stored in `view.selections` immediately — before you submit it.

**Pattern:**
1. After any state read, scan `view.selections` for keys that still appear in
   `optionalRemaining`.
2. For each match, call `submit_answer_for_chat` with the correct arg
   (`optionIds` for multi_choice, `optionId` for choice).
3. Do NOT re-ask the organizer — they already tapped.

Observed 2026-09-07: `dietary` was answered via buttons (`kosher_style`,
`lactose_free`) and sat in `selections` unrecorded until the agent read state
and submitted. Without this step the intake record stays empty for that field.
