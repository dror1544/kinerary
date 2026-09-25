# The organizer interview — six runs, and whether the design holds

**Written 2026-09-04**, after six live runs in which every individual defect
was diagnosed and fixed and the interview still ended worse than it started.

> "The feeling that we have regressed, it seems like nothing really fixed and
> what woked stopped" — run 2
>
> "It is not working well, the start was good and then it lost it" — run 5

This document does three things: recap what actually happened across the runs,
group the failures by cause rather than by run, and propose a design that can
hold. The per-run records stay authoritative for detail
(`signup-test-run1..6-raw-notes.md`); nothing here replaces them.

---

## 1. What the interview has to do

A short, warm, phone-friendly conversation in the organizer's own language
that ends in a **confirmed intake record** — the immutable `intake_versions`
row every later stage builds on. Tappable options, no forms, no typing out
things already written in a document the organizer can just send.

"Works" means exactly one thing and it is checkable from the database: the
trip reaches `intake_confirmed` with answers a person would recognise as
theirs. Not "the chat looked finished".

---

## 2. The six runs

| Run | When | Confirmed? | Ended by |
|---|---|---|---|
| 1 | 08-28 → 09-03 | **yes** | tapping through the one happy path |
| 2 | 09-04 10:35 | no | recap fired on every write; agent could not confirm at all |
| 3 | 09-04 14:26 | no (stopped) | optional questions marched as a form — "it completely drifted" |
| 4 | 09-04 evening | **yes**, 2 manual unblocks | agent could not call its own new tools |
| 5 | 09-04 | no | document offer gone; bombardment; agent recited its own instructions |
| 6 | 09-04 18:14 | no | no buttons on screen, "approved" reached nobody |

Two confirmations in six, one of which needed a human editing the database
mid-run. Run 1 is not the high-water mark it looks like: it reached the end by
never stepping off a single narrow path. Runs 2–6 walked further and every
step off it hit a hole.

**A pattern to name before the analysis, because it is not obvious:** almost
nothing here is a fix breaking an unrelated thing. What actually happens is
that each fix moves a responsibility from the agent to the router, and
**whatever the agent used to do quietly at that point stops happening.**
Buttons and confirmation moved in run 4; the document offer went missing in
run 5. The fix is never wrong — it is incomplete in a way nothing detects
until an organizer hits it.

---

## 3. What broke, grouped by cause

### C1 · Three writers share one chat, and none of them knows it

The organizer sees one bot. Writing into that chat are:

1. the **router** (deterministic, control-plane),
2. the **Hermes agent's** assistant text, relayed verbatim,
3. the **Hermes gateway itself** — `/sethome`, model switches, quota notices.

None coordinates with the others. Everything in this family comes from that:

- the recap landing on top of a live question (run 2 #5)
- the agent narrating "Let me record that now" (run 2 #2, run 3 #1)
- being told "הבוט ישאל אותך" — one assistant announcing another (run 3 #1)
- the agent explaining the run's own bug reports to the organizer (run 5 #3)
- both bombardments (run 5 #2, run 6 #3)
- the `/sethome` housekeeping notice, still unfixed since run 1

Mitigations so far: `interview_agent_turns`, `hasOpenAgentTurn`,
`last_prompt`, a 3-second settle, `internal-leak.ts`. Every one of them is a
**race mitigation**. There is still no model of whose turn it is.

### C2 · "Finished" is derived, not entered — and run 6 made it unreachable

`deriveSessionState` recomputes from the answers on every read. There is no
transition, so there is no such thing as *entering* confirmation — only
*being* in it, which is why the recap re-fired on every write in run 2.

Run 6 is the same defect from the other side, and the numbers are exact. All
six required questions were answered. Reaching `awaiting_confirmation` then
needs **either all sixteen optional questions answered, or `finish_requested`**.
Eight optional were answered. `finish_requested` is set only by the 🏁 button,
which only exists attached to a *router-drawn* question — and the agent was
asking the questions, so no button was on screen. `offered_more: true` shows
the run-4 safety net had already been shown and consumed.

The organizer typed approval into a session that had no reachable path to
being approved. `/done` was added afterwards as an escape hatch. **An escape
hatch is the right patch and the wrong fix**: it exists because the state
machine has a hole, not because the organizer needed a command to learn.

### C3 · The agent asks questions the record has already answered

Run 6's two visible defects — asking `trip_type` without buttons, then asking
"לאן נוסעים?" after reading the document — have one root cause, and the
database states it plainly. **Both were already recorded** at the moment they
were asked:

```
bot_gender, bot_name, departure_date, destination, dietary,
organizer_identity, phases, planning_help, return_date, timezone,
travelers, trip_interests, trip_pace, trip_type
```

The router could not have made either mistake: `nextQuestion` returns only
unanswered questions. The agent asked them anyway, because what it knows about
the record is a snapshot in its context, refreshed by judgement rather than by
a read. Run 4's fix for this was a SOUL line making the document the standing
source. It held for exactly one run.

### C4 · Every invariant that matters is a sentence in a prompt

Each of these is a SOUL rule, and each has failed live at least once:

| Rule | Failed in |
|---|---|
| never ask an option question yourself | run 2 #6, run 6 #1 |
| never narrate your next step | run 2 #2, run 3 #1 |
| hold one language | run 1, run 2 #3 |
| don't ask what the document already answered | run 4 #2, run 6 #2 |
| never claim to have confirmed | run 2 #7 |
| never claim to be repairing the system | run 4 #3 |

Run 2's "(Recommended)" is the cleanest proof that this class cannot work:
`993dd4c` added a prompt rule to remove a label that **Hermes appends
deterministically in `clarify_tool.py` and strips before the model sees the
answer**. The agent could not have complied — it cannot see the string. A
prompt rule was written against a defect no prompt could reach.

And the reliability of the whole class resets on a model switch, which run 5
had mid-interview.

### C5 · Failures are invisible on both sides

The agent cannot tell a broken system from a refused call, so it invents
recovery and reports it as fact:

- `confirm_intake` needs a token it does not hold → "אכתוב הודעה לדרור
  להשלמה ידנית" — a handoff no tool performs (run 2 #7)
- Hermes's deferred-tool wrapper refuses a direct-call tool → "אני מסדר את זה
  לפני שממשיכים" — a repair it cannot do (run 4 #3)
- two malformed writes returned `400`; **Hermes counts a 4xx as unreachable**,
  so three strikes removed the interview tools for ~46 seconds (run 6)

Meanwhile the organizer's only signal is the transcript, and the transcript
reads finished when the record is not. Run 2 ended that way; run 6 ended that
way.

---

## 4. Does the design hold?

**The split is right. The contract between the halves is not.**

Right, and worth keeping: only the router can draw a keyboard, write an
immutable record, and be relied on; only the agent can hold a conversation,
read a PDF, and decide that asking someone who just said "Japan" for their
timezone is absurd. Nothing in six runs argues against that division.

What does not hold is everything left implicit between them. The contract
today is: *both may speak whenever they like, both infer the state
independently, and the agent's half of the rules is a prompt.* Six runs is
enough evidence that this is not a set of bugs.

Concretely, the design is missing four things, and every defect in §3 is one
of them:

1. **one writer at a time** (C1)
2. **explicit phases with transitions and entry actions that fire once** (C2)
3. **one place that decides what is asked next** (C3)
4. **invariants held by code rather than by instruction** (C4, C5)

---

## 5. The plan

Staged so each phase is independently shippable and independently testable.
Phase A is the one that matters; B and C make it stay fixed.

### Phase A — make the router the only writer

**A1 · The agent stops sending messages.** It gets `say_for_chat(text)`. On
interview chats, every other agent `send` is dropped at the relay boundary —
`internal-leak.ts` already intercepts exactly there; it flips from a denylist
to "nothing passes that was not addressed to the organizer on purpose".

This is the highest-value change in the document. It makes **structurally
impossible**: chain-of-thought leakage, third-person "הבוט", agent-recited
instructions, numbered lists, "(Recommended)", agent-side language drift,
prose approval requests, invented repairs, and agent-side bombardment. Every
one of those is currently a prompt rule that has failed live.

**A2 · An explicit phase column.** `opening → essentials → optional → recap →
confirmed`, stored, with transitions and entry actions that fire exactly once.
Replaces `deriveSessionState` plus the three flags bolted onto it
(`finish_requested`, `offered_more`, `skipped[]`), which are a state machine
written the hard way. `/done` becomes an ordinary transition rather than an
escape hatch.

**A3 · A floor token.** One writer holds it; the router holds it by default.
`interview_agent_turns` is nearly this already — make it authoritative and
delete the three race mitigations it subsumes.

**A4 · A watchdog.** If the floor is held and nothing organizer-visible has
been sent for N seconds, the router takes it back and asks the next question.
Run 4's essentials-done message is a special case of this; generalise it and
no fumbled agent turn can ever strand an organizer again.

### Phase B — delete whole classes of question

**B1 · Derivable questions are never asked.** A `derive()` on the question
definition: `timezone` from destination, `home_country` from the organizer,
duration from the dates. Run 3's timezone question stops being a judgement
call the agent has to get right every time.

**B2 · Document extraction writes answers, not context.** Extraction goes
through the same write path as any answer, so "already answered" is a fact in
the record rather than a memory in a prompt. C3 disappears — combined with A1,
the agent cannot ask an answered question because it cannot ask anything.

**B3 · The document offer is a phase entry action**, not a SOUL sentence — the
run-5 regression by construction cannot recur.

### Phase C — test the transcript, not the units

**This is why six regressions were found by Dror and not by CI.** 568 tests
pass and every failure in §3 is invisible to all of them, because they assert
units and the defects are in the *conversation*: two messages where one
belongs, English inside Hebrew, a question asked twice, a state with no exit.

**C1 · A transcript harness.** Drive the router with a scripted organizer and
a stubbed agent; assert the exact sequence of organizer-visible messages.
Standing assertions, each one a past run: no message sent twice; no option
question without a keyboard; no string outside the session's language; every
question asked at most once; every path reaches `confirmed` or a stated dead
end; no denylisted internal token.

**C2 · Run it in CI** on `integration/**` — the workflow already covers that
branch.

### Phase D — the small known-deferred items

`/sethome` config move under `platforms:` (+ gateway restart) · `getMe` retry
with backoff · the alpha disclaimer Dror asked for in run 1 · the post-confirm
dead end (run 1 #11: no link to the site or the bot).

### Order

A1 → C1 → A2 → A3/A4 → B → D. A1 removes the largest class of visible defect;
C1 stops the next regression being found by a person on a phone.

---

## 6. What this plan deliberately does not do

- **Extend the relay contract to carry keyboards.** It would let the agent
  draw buttons — and duplicate what the router already does well, while
  keeping two writers. A1 goes the other way on purpose.
- **Patch Hermes.** The `clarify` label and the 4xx-as-unreachable breaker are
  both upstream. A1 makes `clarify` unreachable on this path; the breaker is
  already handled by returning 4xx as tool results.
- **Rewrite the interviewer as a deterministic script.** The judgement is
  worth keeping. Run 4's dietary follow-through and the document extraction
  are things no script would do.

---

## 7. Open decisions — for Dror

1. **A1 is the load-bearing choice.** It makes the interview's voice pass
   through one gate, which is a real loss of spontaneity in exchange for every
   guarantee in §5. Worth confirming before it is built.
2. **How long does the agent get to answer** before the watchdog takes the
   floor (A4)? Affects how a slow PDF read feels.
3. **Do runs 2–6's items go into Sprint 5, or a new sprint?** Per the standing
   instruction, an unowned gap is a decision for you, not a guess by me.
4. **Are the two manual unblocks in run 4 acceptable as "confirmed"?** They
   are recorded as such; if not, run 1 is the only clean confirmation and the
   bar in §1 has never been met twice.
