# Signup Run 7 — raw notes (LIVE, 2026-09-05)

First run on Track 4: the agent is the only voice, the router the only writer,
with a phase machine and a watchdog. Runs 1–6 are in
`signup-test-run1..6-raw-notes.md`; the analysis that produced Track 4 is
`interview-design-review.md`. Standing instructions as always: Dror's notes
verbatim, agent notes marked as such, nothing triaged until the run ends,
nothing "fixed" without a human saying so.

---

## Run context

| | |
|---|---|
| Trip | `draft-sreq-d147e42b46284ae0c6ac7139e381b872`, reset twice (see below) |
| Session | `sess_48a42b57eb0e6b498b7d839d55b81a32`, `language = 'he'` |
| Code | `sprint/5-interview-followups` @ `41dbb70` + three uncommitted mid-run fixes |
| Schema | 40 (`0037_interview_phase` applied live) |
| Model | `claude-sonnet-4-6`, with a spell on `gpt-5.4-mini` after a quota limit |

## What run 7 was meant to prove

1. **A1** — the agent speaks only through `say_for_chat` / `ask_question_for_chat`.
2. **A2** — the interview is a phase it enters, so finishing is reachable.
3. **A4** — a 30-second watchdog means it never goes silent.

## Two deploy failures before the run could start

Both mine, both worth recording because they cost two aborted rounds.

**1. The API came up with an empty agent key.** `compose.local.yml` reads
`${CONTROL_PLANE_INTERVIEW_AGENT_KEY:-}` from the shell, and the restart was
done without sourcing `provisioning.env`. An empty key leaves the agent routes
unmounted, which is a *working state* by design — so nothing failed loudly.

**2. The sidecar registered 6 tools instead of 12.** All the `*_for_chat` tools
sit behind `if (AGENT_KEY)`, so a keyless sidecar silently exposes only the
token-based half. The interviewer therefore had no `say_for_chat` at all, fell
back to prose, and A1 dropped every word of it.

*Agent note.* The decisive evidence — `registered 6 tool(s)` in the gateway log
— was one grep away for half an hour while two rounds were burned. The check
that mattered was "what does the agent actually have?", not "did the thing I
just restarted come back up". **A silently empty key disarms every agent tool
with no error anywhere except deep in the agent log. That deserves a loud
startup check.**

Also fixed before the run: the `/sethome` notice, open since run 1. The home
channel sat under a top-level `telegram:` key; `GatewayConfig.from_dict` only
reads platform config from `platforms:`. Moved, gateway restarted.

---

## Dror's notes

*(verbatim, added during the run)*

### Step 3 — interview bot

**1. The document is read, then its answers are asked for anyway.** Verbatim:

> It started good, red the document parse it, and then asked for destination

*Agent note — this is C3 from the design review, and B2 is the fix that is not
built yet.* The document was parsed into the agent's context but nothing from it
was written to the record, so `destination` was still unanswered and the router
asked for it, correctly. Today extraction lives in the model's context and
reaches the record only if the agent happens to submit it. B2 makes extraction
go through the same write path as any answer, after which the router cannot ask
what the document already said.

**2. The watchdog repeated itself, over and over.** Verbatim:

> It asked for names, gave it asked relations asked and then asked again (third
> time)
>
> נמשיך מכאן. / מי מגיע לטיול? שם וגיל של כל אחד, ולאיזו משפחה הוא שייך.
>
> Getting this over and over again : נמשיך מכאן. / יש משהו שחשוב לכם לראות או
> לעשות?

*Agent note — one cause produced both this and the silence around it.* The agent
kept writing prose; A1 dropped it; the turn therefore produced **nothing**,
which is exactly what the watchdog is built to detect. It concluded the agent
had stalled, took the floor and re-asked. Every turn: agent writes → dropped →
looks stalled → "נמשיך מכאן." plus the same question. **17 refused sends
against 3 `say_for_chat` calls** was the tell.

Fixed mid-run, both parts:

- a refused agent send is now **converted** into `say_for_chat` rather than
  dropped, so nothing the agent says is lost and a turn that spoke is not
  mistaken for a stall. The leak filter still drops rather than converts.
- the watchdog will not re-ask a question that is already the last thing on
  screen (`trip_bot.recovery_suppressed`).

*This defect was named one report earlier and left unfixed while diagnosis
continued. Once a defect is understood and the organizer is actively hitting
it, the fix comes before the analysis.*

**3. The bot narrates the interface.** Verbatim:

> got this "יפנוטו נרשם. עכשיו השאלות על אופי יפנוטו — המין והטון — יגיעו עם
> כפתורים. אחרי שתענו עליהן, נסגור את הכול ונעבור לסיכום." which is fine, just
> "יגיעו עם כפתורים" is TMI for the user

*Agent note.* SOUL already forbade previewing that a question "will come with
buttons"; the agent did it anyway — the C4 pattern. The failure is now quoted
verbatim in SOUL with the offending words marked. **This is a soft guard**, and
knowingly so: it is the trade made when the agent was given the words back. If
it recurs the next step is stripping that clause at the boundary, not a
stronger sentence.

**4. Long dead air between question and answer.** Verbatim:

> it takes a lot of time for the next quesion, after the last one

*Agent note — architectural, not model latency.* Delivery of anything the agent
wrote ran **inside** the Telegram poll loop, after `getUpdates` returned. So:
the organizer answers, `getUpdates` returns immediately with their message, the
loop finds nothing owed yet, blocks on the next poll for 25 seconds — and the
agent's reply, written two seconds later, waits out the whole window. Worst
case ~25s of silence for a message that was ready at once.

Fixed mid-run: delivery runs on its own 700 ms timer, independent of polling.
The claims are atomic, so the two loops coexist safely.

**5. A message vanished.** Verbatim:

> it nvere came back to me after last message I mentioned

*Agent note — my restart, not a defect.* Restarting the relay to ship the
latency fix leaves a ~12-second window in which an update can be fetched by the
dying process and never handled; Telegram considers it delivered. **Second time
this session a service was restarted under a live interview.** Do not restart
mid-run without asking.

**6. A tapped answer was asked for again, in prose.** Verbatim:

> It aske about the bot gender with multiple answers I clicked then asked again
> free text

*Agent note.* The tap was recorded — `bot_gender = male` is in the record. The
re-ask came from the **agent**, which cannot happen from the router
(`nextQuestion` only returns unanswered questions). C3 again, from the other
side: the agent's picture of the record is a snapshot in its context rather
than something it reads.

**7. THE FINDING OF THE RUN — every question arrives twice, and the timeout is
scoped wrong.** Verbatim:

> On the bot almost every question I get at least twice, seems like one from the
> router and one from the agent, look like the timeout is not reset, furthermore
> waiting to a person response need to be handled from the session perspective
> not by one question

*Agent note — Dror's framing is better than the design's, and this supersedes
A3 as written.* Measured: **10 router prompts and 6 agent messages** for roughly
ten questions, with **zero** dedupes — because the two speakers write different
words for the same question, and the dedupe compares prompt keys the agent's
messages do not carry.

The second half is the real correction. Whose turn it is belongs to the
**session**, not to a turn or a question. At any moment the conversation is
waiting either on the person or on the machine, and that is one fact about the
whole conversation. Two consequences fall straight out:

- While waiting on the organizer the timeout should not be *running*, not
  merely reset. A watchdog counting down against a human reading a question is
  measuring the wrong thing.
- While waiting on the machine exactly one side owes the next message, so a
  question cannot arrive twice.

**Recommendation:** A3 becomes one `awaiting` field on the session — *person*
or *agent* — set when a message goes out, cleared when one comes in, with the
timer running only while it is the machine's turn. That single mechanism
replaces four guards added this week: the 30-second per-turn watchdog, the
3-second settle window, the prompt dedupe, and the handback check.

A3 had been deprioritised on the grounds that it "buys tidiness, not
capability". This run is the evidence that was wrong.

**8. Raw markdown, no buttons on most messages, and no working approval.**
Verbatim:

> Im finished the interview. There is a regression on the markdown formatting
> not applied and show raw. Almost no message came with option buttons
> including the last approval. The agent said it will report to me for the
> issues

*Agent note — three separate things, and the first is mine from an hour
earlier.*

**Raw markdown.** The connector always sent agent-authored text with
`parseMode: "MarkdownV2"`, because that is the dialect `TELEGRAM_DESCRIPTOR`
advertises. Converting a refused send into `say_for_chat` routed the same text
through the ROUTER instead, and the router's delivery passed no parse mode at
all — so every converted message rendered as literal asterisks. Fixed: whoever
delivers the agent's words owes them the same parse mode. A regression
introduced by the fix for item 2, four hours after it shipped, and exactly the
kind of thing the transcript harness cannot see because it asserts text, not
wire options.

**No buttons, no working approval.** Read from the database rather than the
chat: the session DID reach `phase = recap`, `state = awaiting_confirmation`,
with **14 answers** — further than run 6, which never got here at all. But
there is no `intake_versions` row and the trip is still `intake_in_progress`,
so the interview is **not confirmed**. The router sent the recap with its
Confirm / Keep planning keyboard; the agent kept talking over it, so the last
thing on screen was agent prose asking for approval in words, which no tool
acts on. `last_prompt` never advanced past `q:constraints`, so the router's own
dedupe never engaged either.

This is item 7 again, and it is now the whole story of the run: **two speakers,
both deciding independently that something is owed.** The buttons were sent.
They were buried.

**"The agent said it will report to me for the issues."** The run-2 and run-4
pattern: an invented recovery no tool performs. There is no issue-reporting
capability, so nothing was reported to anyone.

---

## What worked, confirmed live

- **`say_for_chat`** — the agent's own voice reaching the organizer through the
  router, for the first time.
- **`agent_send_converted`** — prose routed rather than lost.
- **`recovery_suppressed`** — the watchdog declining to repeat itself.
- **`handback_skipped: TURN_ALREADY_OPEN`** — no turn stacking.
- The **document offer opens** the conversation, in Hebrew.
- **12 answers recorded**, phase `optional`, every required question answered —
  further than any run since run 4, and past where run 6 died.

## Still open at the end of the run

- B2 (document extraction writes answers) — not built; items 1 and 6 above.
- A3, in Dror's session-scoped form — item 7.
- The three mid-run fixes are uncommitted and have no tests yet.
- A loud startup check for a missing agent key.

## Agent debrief

*(to be written at the end of the run)*
