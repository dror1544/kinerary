# Signup Run 13 — raw notes (2026-09-05, FINISHED)

Outcome: **`intake_confirmed`**, 18 answers — the fourth clean confirmation in
a row. It got there, and it should not have been as hard as it was: two
separate dead stalls in one interview, each ended by Dror asking the bot
whether it was still alive.

Standing instructions as always: Dror's notes verbatim, agent notes marked as
such, nothing triaged until the run ends, nothing "fixed" without a human
saying so.

---

## Run context

| | |
|---|---|
| Trip | `draft-sreq-b5293ddef5df0cdd72a80e97a778798a` / `trip_7834be4af8791e4ff3b8e4552b85e89d` |
| Session | `sess_f7a4f6600a02f2b546d10a1989070e10` |
| Chat | `391627336` |
| Code | `b86ab5d` at start — document floor (90s), `checkComplete`, Track 8 |
| Model | `gpt-5.6-luna` via openai-codex, no rotation this run |
| Outcome | **`intake_confirmed`**, 18 answers, `intk_69c89de554804deb4dac9ac79938e78a` at 20:25:45Z |

## What run 13 was meant to prove

The three things committed in `6205b2d` just before it: the 90-second document
floor, `travelers` refusing a headcount-only answer, and Track 8 asking the
fixed-choice bot-preference questions without an agent round-trip.

All three worked. Everything below is what the run found *around* them.

---

## Dror's notes

*(verbatim, in the order they were sent)*

**1.** > regarding the English name spelling, It will be preferable it will
> suggest a spelling and the user can correct him rather user will write the
> name all over again

**2.** > the agent ask question but since the router send to it while it is
> active I get this message Redirected current run. I'll adjust using your
> correction. which make no sense the user since he answer what he was asked

**3.** > After "רשמתי: כולם בכשר־סטייל, ולנעה יש רגישות ללקטוז. שאלתי עכשיו
> איזה קצב יתאים לכם בטיול" it did not moved on I had to proactively as a
> question to make it move on, and then it asked twice without the options

**4.** > again, repeated messages response and ask

**5.** > it again competing with the agent on the questions

---

## The stall, read off the logs

*Agent note.* Note 3 is the serious one, and the transcript is misleading about
it — the agent looks like it ignored the organizer. It did not. From
`~/.hermes/profiles/trip-intake/logs/agent.log` and the turn table:

| Time (local) | What happened |
|---|---|
| 23:04:32 | Dror answers dietary — "כולם בכשרות נעה בלקטוז" |
| 23:04:42 | `submit_answer_for_chat` — recorded correctly |
| 23:04:47 | `ask_question_for_chat` — **`trip_pace` nominated, with good phrasing** |
| 23:04:50 | the agent's turn ends; its closing text reaches the relay and becomes `pendingSay` |
| 23:04:50 | the router sends that say, calls `claimFloor`, and **returns** |
| … | `trip_bot.floor_held_by_person`, every pass, for **eleven minutes** |
| 23:15:43 | Dror types "מה עכשיו?" |

`sendNextStep` delivers a pending say and returns before it ever works out what
to ask. The send claims the floor, so the nomination is stranded behind a floor
that now belongs to the organizer — and nothing speaks again until they do.
`answers->'trip_pace'` was still NULL.

The reason it read as being *ignored* rather than *stuck* is that the closing
text had told Dror the question was asked. It had been — to the router, which
then dropped it.

It happened a second time on the same question at 23:20 ("מתקדמים?"), which is
note 4 and the "asked twice without the options" half of note 3: the agent kept
narrating `trip_pace` in prose while the buttoned render stayed stranded.

`nominateQuestionForChat` already folds a say into a nomination — but only one
still pending when the nomination runs. Here the say arrived *after* the ask,
which no nomination-time fold can win.

## The competition (note 5)

*Agent note.* Track 8 fired for any session with `awaiting = 'machine'`, and an
open agent turn is equally the state of an agent composing its next message —
so a router-owned question could land on top of the interviewer. The design
intent was to fill dead air during document extraction, not to race a live
conversation. This is exactly the drift Dror named when Track 8 was specified:
"I don't want this optimization to gradually turn the interview back into a
form."

All three router-owned questions were answered in the end (`bot_gender: male`,
`bot_tone: playful`, `bot_proactive` ×3), so the competition cost UX, not data.

## The busy-ack leak (note 2)

*Agent note.* Not the agent narrating itself — the **harness** narrating
itself. `gateway/run.py:10564` sends the chat a status line when an inbound
arrives mid-run. Dror's answer landed while the agent was working, so the
gateway announced its own scheduling decision as if it were a reply, in
English, mid-Hebrew-interview, about a correction he never made.

---

## Triage

All five notes are triaged into the Status ledger in
`signup-test-execution-capture (Manual).md`:

| Note | Ledger row | Status |
|---|---|---|
| 1 — suggest the spelling, don't ask for it | Step 3 #13 (refined) | Fixed |
| 2 — "Redirected current run" reached the organizer | Step 3 #14 | Fixed |
| 3, 4 — the eleven-minute stall | Step 3 #15 | Fixed |
| 5 — router-owned questions competing | Step 3 #16 | Fixed |

Fixes deployed 2026-09-06 06:42Z; all four services verified on the new build,
all 13 MCP tools confirmed registered from the gateway's own log.

## Still open after this run

- **Track 6's remaining work** — the watchdog still guesses "is the agent
  busy?" from elapsed time. Run 12's 404s came from that guess and no
  heartbeat signal exists yet. Deliberately not invested in further, per the
  position-paper review's scoping.
- **Track 7** — the agent still asks choice questions in prose when it gets the
  chance; `trip_pace` was answered as free text this run rather than tapped.
- **SOUL has no notion of router-owned questions** — the agent can still
  narrate one it is not allowed to nominate.
