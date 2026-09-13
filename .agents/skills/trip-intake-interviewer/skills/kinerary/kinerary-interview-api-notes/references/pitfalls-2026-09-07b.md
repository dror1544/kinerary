# Session pitfalls — 2026-09-07 (second session)

## PyMuPDF import alias

`import fitz` is the reliable alias for PyMuPDF and confirmed working.
`import pymupdf` is the newer API name but may not be available on all installs.
Use `fitz` as the safe default:

```python
import fitz  # PyMuPDF
doc = fitz.open(path)
text = "".join(p.get_text() for p in doc)
```

The CLI command `pymupdf <file>` is invalid — the subcommands are `gettext`,
`show`, `extract`, etc. The Python API is always simpler.

## `pendingSay` in state response

`get_interview_for_chat` and `say_for_chat` sometimes return a `pendingSay`
field in the state. This is a pre-populated message the router intends to send
automatically — it does NOT need to be echoed or repeated by the agent.
Reading it tells you what context the organizer will see next, but do not
call `say_for_chat` with the same text.

## `record_answers_for_chat` field name for structured answers

For structured questions, the batch call uses the key `structured` (not `data`)
when submitting via `record_answers_for_chat`. However, individual
`submit_answer_for_chat` calls for structured questions still use `data`.

| Tool | Structured key |
|---|---|
| `record_answers_for_chat` | `structured` |
| `submit_answer_for_chat` | `data` |

## `lookup_consular_contacts` — definitively unavailable

Requires `sessionId` and `sessionToken` in its schema. The chat-scoped flow
holds neither. Skip silently every time; the site falls back to generic
emergency numbers. Do not attempt to call it.

## `tool_call` wrapper error is an instruction to call directly

If `tool_call(name="mcp__interview__say_for_chat", ...)` returns
"not a deferrable tool", that is the system telling you the tool is already
in the direct list. Call `mcp__interview__say_for_chat` directly on retry.
The error is not a sign the tool is broken.
