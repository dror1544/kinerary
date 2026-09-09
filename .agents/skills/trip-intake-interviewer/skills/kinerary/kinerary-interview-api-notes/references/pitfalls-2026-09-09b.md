# Pitfalls observed — 2026-09-09 session (Solomon Japan trip)

## `record_answers_for_chat` + structured questions: unreliable, use submit directly

The batch call was attempted for `travelers` with field `structured` (as the
skill table documents). It returned `DATA_REQUIRED` or was rejected outright.

**Reliable pattern going forward:**
- Do NOT use `record_answers_for_chat` for `structured`-type questions.
- Use `submit_answer_for_chat` with argument `data` (actual JSON value, never
  a JSON-encoded string) for every structured question.
- Reserve `record_answers_for_chat` only for `choice` and `multi_choice` batch
  submissions from documents/button taps.

The SKILL.md table entry for `structured → record_answers_for_chat` is
misleading; the batch path does not reliably accept structured answers.

## `submit_answer_for_chat` with wrong arg name for structured questions

First attempt used `structured` as the argument name (not `data`):
```
{"questionId": "travelers", "structured": [...]}
```
Returned: `{"error": "DATA_REQUIRED", "expectedArgument": "data (a JSON array)"}`

Correct call:
```
{"questionId": "travelers", "data": [...]}
```

## `record_answers_for_chat` for text fields: confirmed still broken

`destination` was tried via batch with `answers: [{questionId: "destination", value: "..."}]`
→ rejected with `TEXT_REQUIRED`. Individual `submit_answer_for_chat(otherText=...)` worked.

## `pendingSay` in state response

When `say_for_chat` succeeds, the returned state includes a `pendingSay` field
containing the message queued for delivery. This is informational — it confirms
delivery was accepted. No action needed on it.

## `phases` submission: venues key accepted

`submit_answer_for_chat(data=[{..., "venues": [{name, time}]}])` was accepted
for the `phases` question. The `venues` array with `name` and `time` fields
populated correctly from the booking document.
