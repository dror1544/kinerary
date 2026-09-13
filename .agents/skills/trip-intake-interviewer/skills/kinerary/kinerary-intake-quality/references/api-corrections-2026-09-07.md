# API corrections — session 2026-09-07

Confirmed production bugs and corrections from the session on 2026-09-07.
These should be merged into `kinerary-interview-api-notes` SKILL.md when the
read-before-write guard allows it.

## `record_answers_for_chat` — structured field name is `data`, not `structured`

The batch answer call uses `data` (not `structured`) as the field name for
structured questions. Using `structured: [...]` returns `DATA_REQUIRED`.

**Correct shape:**
```json
{ "questionId": "phases", "data": [ { "name": "Tokyo", ... } ] }
```

**Wrong shape (returns DATA_REQUIRED):**
```json
{ "questionId": "phases", "structured": [ { "name": "Tokyo", ... } ] }
```

The `submit_answer_for_chat` argument table in SKILL.md already says `data`
for structured questions — the batch API must match.

## Multi-organizer session detection

When `get_interview_for_chat` returns a completely different `sessionId` and
`tripId` from the previous turn, it is a **new organizer** — not a continuation
of the previous session. Do not carry over any data (traveler names, destination,
dates, etc.) from the old session. Start fresh.

This happened in session 2026-09-07: after the Solomons' Japan intake session
was submitted for confirmation, the next call to `get_interview_for_chat`
returned an entirely different session for the Elul family's USA trip.

## PDF extraction: use pymupdf, not pdfminer

`pdfminer` is not installed in this environment. Use `pymupdf` (also importable
as `fitz`):

```python
import pymupdf  # or: import fitz
doc = pymupdf.open(path)
text = "".join(p.get_text() for p in doc)
```

This worked reliably for both Hebrew/RTL PDFs (Yapan Tours) and Hebrew Markdown
files in the same session.

## Turn-close after phases submission

Submitting `phases` often causes `nextQuestion` to become null immediately,
which closes the turn. Any `say_for_chat` call after that point returns 404.

**Rule:** ask the one or two most important optional questions (dietary scope,
pace) in the same message that acknowledges the traveler list — before
submitting `phases`. Once the turn closes you cannot send anything more until
the organizer writes next.
