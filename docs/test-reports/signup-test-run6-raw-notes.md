# Signup Run 6 — raw notes (LIVE, 2026-09-04)

Fifth run of the day, and the last before stepping back to review the design
(`interview-design-review.md`). Run 5 (`signup-test-run5-raw-notes.md`) lost
the document offer and was bombarded; this run tests the fixes from it. Same
standing instructions: Dror's notes verbatim, agent notes marked, nothing
triaged until the run ends, nothing "fixed" without a human saying so.

---

## Run context

| | |
|---|---|
| Trip | `draft-sreq-d147e42b46284ae0c6ac7139e381b872` — run 5's trip, reset |
| Session | `sess_27fc7df2098828e50ad9aeb173aa8e31`, `language = 'he'` |
| Window | agent turns from 18:14:23 to 18:35:11 UTC — 21 minutes, 10 turns |
| Services | API :4310 · sidecar :4311 · relay :4312 |

## What run 6 was meant to prove

1. The document offer opens the conversation, router-side, localised.
2. The handback guard (`hasOpenAgentTurn`) and prompt dedupe (`lastPrompt`)
   stop the bombardment seen in run 5.
3. `internal-leak.ts` keeps agent-facing material out of the chat.

## Outcome

**Not confirmed.** Read from the database rather than the conversation:

```
sess_27fc7df2098828e50ad9aeb173aa8e31 | interviewing | he |
  {"last_prompt": "q:trip_interests", "offered_more": true} | 14 answers
```

14 answers recorded, no `intake_versions` row, trip still
`intake_in_progress`. The session **never reached `awaiting_confirmation`**,
so the Confirm button was never sent.

---

## Dror's notes

*(verbatim, added during the run)*

### Step 3 — interview bot

**1. The document offer worked — and then the agent asked an option question
itself, without buttons.** Verbatim:

> It started very nice asking a document. And that is very good, it red the
> document and took all, however afterward, it asked the trip type (which was
> asked on previous interviews at the first) but did not placed multiple
> answers button and back to option and sending number. I continue

*Agent note — run 5 #1 is fixed, and run 2 #6 came back.* The opening is now
right: the router offers the document first, in Hebrew, and the extraction
worked. What follows is the old defect returning by a new route. `trip_type`
is a `choice` question the **router** draws with a keyboard — but the agent
asked it in prose instead, and an agent-asked option question degrades to a
numbered list (`gateway/platforms/base.py`'s fallback, since the relay
contract carries no `reply_markup`).

Nothing prevents this. `SOUL.md` says the agent must never ask an option
question itself and must nominate it via `ask_question_for_chat` — a rule, in
a prompt, which is exactly the class of guard these runs keep breaking.

**2. It asked for something the document had already answered.** Verbatim:

> Now asking לאן נוסעים? (עיר, אזור או מדינה) after it red the document and
> should have know the destination

*Agent note — the run-4 #2 defect, unfixed by its prompt-level fix.* Run 4
added a SOUL line making the shared document the standing source to consult
before every remaining question. It held for one run. The document's contents
live only in the model's context, so "was this already answered?" is a
judgement the agent makes fresh every turn, and it gets it wrong under load.
Nothing in the router knows the document said Japan.

**3. Bombardment, second occurrence.** Verbatim:

> Again it bombarding me with messages

*Agent note — the run-5 fix was necessary but insufficient, and the reason is
worth stating precisely.* The handback guard held: six re-entries were blocked.
The dedupe did not help, because **every write genuinely produced a different
next question** — the agent recorded a document's worth of answers, and each
write scheduled its own router prompt for a legitimately new prompt key. There
was nothing to deduplicate.

Fixed after the run with a 3-second settle: `claimDueRouterPrompts` ignores a
due prompt until the writing has stopped for `ROUTER_PROMPT_SETTLE_SECONDS`,
and each new write pushes the deadline out. A burst now produces one message
about where the interview actually ended up.

**4. The interview ended with no way to finish it.** Verbatim:

> Eventually got to the end of the interview no buttons only open questions
> asked for approval I approved but nothing happened

*Agent note — the most serious item of the run, and a dead end by
construction.* The organizer was asked for approval **in prose, by the agent**.
Only the router's Confirm button writes an `intake_versions` row. The session
was still `interviewing`, so no recap and no Confirm button had ever been sent,
and the word "approved" reached an agent that has no tool to act on it.

The three ways out of `interviewing` all failed at once:

- `finish_requested` — set by the 🏁 button, which is attached to a router
  question. The agent was asking the questions, so no button was on screen.
- optional questions running out — 14 of 22 answered, so not reachable.
- `show_summary_for_chat` — the agent's own escape hatch, never called.

`offered_more: true` shows the essentials-done safety net from run 4 **had**
been shown and consumed, so it could not fire again.

Fixed after the run with `/done` and `/summary` router commands, which depend
on neither a live button nor an agent tool call. With required questions
outstanding they ask the next required question rather than pretending to
confirm.

---

## Agent debrief

Runs 5 and 6 are the same run twice: a good opening, then the agent taking
over the conversation and the router losing the ability to finish it. Each
individual defect has a specific fix and each fix landed, but the sixth
consecutive run to end this way is evidence about the design rather than about
six bugs. That analysis is `interview-design-review.md`; this file stays a
record of what happened.

Three fixes shipped after the run and are unexercised live: the 3-second
settle, 4xx MCP results no longer tripping Hermes's circuit breaker, and
`/done`.
