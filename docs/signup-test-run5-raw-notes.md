# Signup Run 5 — raw notes (LIVE, 2026-09-04)

Fourth run of the day. Run 4 (`signup-test-run4-raw-notes.md`) reached a
confirmed intake but needed two manual unblocks; this run tests the fixes that
came out of it. Standing instructions as always: Dror's notes verbatim, agent
notes marked, nothing triaged until the run ends, nothing "fixed" without a
human saying so.

---

## Run context

| | |
|---|---|
| Trip | `draft-sreq-d147e42b46284ae0c6ac7139e381b872` — a **fresh signup**, since run 4's trip is now `intake_confirmed` |
| Enrollment | `enrl_1c172088d0b3ce4c00b9a6bb0fcbcd32` (second issue — see below) |
| Suites | 559 tests · 553 pass · 0 fail · 6 skipped |
| Services | API :4310 · sidecar :4311 · relay :4312, all on the current build |

## Aborted first attempt — the reset had a blind spot

The first attempt at this run started on top of **run 4's conversation**.

> I had a rate limit issue which fixed and I chnaged model, but when it came
> back it remember older interview

*Agent note — the script's fault, not the model's, and it is fixed.*
`fresh-interview.py` learned which Telegram DM to clean from the trip's own
`intake_sessions` rows. A trip created by a fresh signup **has none yet** — so
`chat_ids` came back empty, the conversation wipe was skipped silently, and
the run started against whatever the interviewer was last saying in that DM.
The reset's own output said as much in hindsight: no "wiped N message(s)" line,
and nobody looks for a line that is not there.

Measured rather than assumed: the DM was still bound to session
`20260825_011320_d52a9d49` — **created 25 August**, 457 lifetime messages, 74
retained. The rate limit and model switch did not cause it; they forced a
context reload that surfaced what was already attached.

Fixed in the script: `--chat-id` (env `KINERARY_INTERVIEW_CHAT_ID`) is merged
with the derived list, and an empty list now prints a loud warning that the
conversation was NOT cleared and what to pass. The re-reset with `--chat-id`
wiped 74 messages and cleared the binding.

This is the third distinct way the "clean context" problem has appeared —
after the shared session id (run 1) and profile memories (run 4). All three
now have a deterministic answer in the same script.

## Confirmed working before the abort

- **Language seeded from Telegram's locale.** The aborted attempt's session
  had `language = 'he'` with only one answer recorded and no agent report —
  so the router had the right language from the first message, which is what
  the run-4 English file acknowledgement needed.
- **The memory reset ran** on the first attempt (`moved 2 memory file(s)`),
  and on the re-reset correctly reported `memories already empty`.

## What run 5 is meant to prove

1. The interview cannot dead-end: the router's "essentials done" message with
   both exits, shown once, whatever the interviewer does.
2. A tool-call failure is retried directly, and the agent never claims to be
   repairing the system.
3. The shared document stays the standing source — nothing already in the PDF
   gets asked for.
4. File acknowledgement arrives immediately, in Hebrew.
5. A genuinely clean context window, for the first time with all three leak
   paths closed.

## Knowingly NOT fixed

- Chain-of-thought narration still reaches the chat.
- The `/sethome` notice still fires.
- `getMe` has no retry (it resolved cleanly on this build's start).

---

## Dror's notes

*(verbatim, added during the run)*

### General comments

### Step 3 — interview bot

**1. The interview asks for dates without ever offering to read a document.**
Verbatim:

> Now it asked the date of the trip (hebrew) without suggesting adding
> documents

*Agent note — a regression my own router split caused.* `SOUL.md` step 3 has
always said to offer the document *before* asking anyone to type dates, and
that is a standing requirement, not a nicety (memory
`interview_offer_document_upload`). It worked while the interviewer opened the
conversation. It stopped working the moment the router took over the required
questions: the router speaks first now, and it went straight to `trip_type`
and `departure_date`. The agent only gets a turn once the organizer writes
something, by which point they are already typing out a trip they had written
down in a file.

The language was right — Hebrew from the first message, seeded from the
Telegram locale — so this is purely about what gets said, not how.

Fixed by moving the offer to where the opening now lives: the router sends it
as the first message after `/start`, with a single "אין לי מסמך" button, and
asks the first question once the organizer sends a document, taps past it, or
just starts typing. Localised like everything else the router draws.

The general lesson is worth keeping: **each time a responsibility moved from
the agent to the router, something the agent used to do quietly stopped
happening** — buttons and confirmation in run 4, the document offer here.
Anything else `SOUL.md` claims to do at the START of a conversation deserves
the same audit, since the agent no longer opens one.

**2. The router bombarded the chat.** Verbatim:

> It is completely stopped waiting it bombarding me with messages

*Agent note — measured, not inferred.* Nine agent turns opened in the window
and 28 messages went out. Two mechanisms stacked:

- **Handback re-entry.** After a tap the router hands the turn back to the
  interviewer. It did so without checking whether the agent already held an
  open turn, so a slow agent got re-poked, and each poke produced another
  message.
- **One prompt per write.** `submitAnswerForChat` sets
  `router_prompt_due_at = now()` on every successful write. An agent recording
  several answers off one document therefore asked the router to speak several
  times in a second.

Fixed: `hasOpenAgentTurn` guards the handback, and `lastPrompt` suppresses a
repeat of the same prompt. **The dedupe alone was not enough** — see run 6 #3.

**3. The agent recited the run's own bug reports back at the organizer.**
Verbatim:

> It seems that all the comments I gave it is now explaining to the organizer

*Agent note.* Corrective instructions written for the *agent* — SOUL rules
about what not to do — surfaced as explanations to the *organizer*. The
interviewer has no notion of an audience boundary: everything in its context is
material it may speak aloud. This is the same seam as the chain-of-thought leak
(run 2 #2) and the third-person "הבוט" slip (run 3 #1), and it is why the
`internal-leak.ts` denylist was added at the relay boundary — a filter, because
there is no marker to key on.

**4. Verdict.** Verbatim:

> It is not working well, the start was good and then it lost it

Run 5 did not reach a confirmed intake.



### Step 4–5 — plan + provisioning

---

## Agent debrief

*(written at the end of the run)*
