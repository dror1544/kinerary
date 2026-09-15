# Signup Run 9 — raw notes (LIVE, 2026-09-05)

First run on the complete Track 4 stack: A1 (one voice, one writer), A2 (the
phase machine), A3 (the session floor), and B (derivation + batch record).
Run 7 (`signup-test-run7-raw-notes.md`) exercised A1/A2/A4 in isolation and
found the floor design incomplete; every fix from that run is in this build,
plus the session-floor rework A3 that superseded the original watchdog design.
Standing instructions as always: Dror's notes verbatim, agent notes marked as
such, nothing triaged until the run ends, nothing "fixed" without a human
saying so.

---

## Run context

| | |
|---|---|
| Trip | `draft-sreq-40da34bd89b8e341c4b10b925c85fb81`, a fresh signup |
| Session | `sess_958738842e7f81e3a711affbf29b61ca` |
| Code | `sprint/5-interview-followups` @ `c493f05` |
| Schema | 41 |
| Outcome | **`intake_confirmed`** — `intk_0aaf7ea91a2d453a7207e69cce38b7b5`, 18 answers |

**First clean confirmation since run 4, and the first ever on the full
A1–A3+B design.** Run 4 needed two manual database unblocks to get there; this
one did not.

## What run 9 was meant to prove

1. A2's phase machine reaches `recap`/Confirm reliably.
2. A3's session floor stops questions arriving twice.
3. B's derivation and batch-record keep the interview from asking what a
   document already answered.
4. The three mid-run fixes shipped after run 7 (send-conversion, recovery
   suppression, delivery decoupled from polling) hold up over a full run.

---

## Two deploy failures before the run could start

Both mine, both distinct from run 7's deploy failures — new mistakes, not
repeats.

**1. `startFromDeepLink` resumed a different trip's abandoned interview.**
Reported as "did you forget to reset the interview" — run 7's session, still
`awaiting_confirmation`, was still bound to this chat, and a fresh, validly-
issued deep link for a brand-new trip was silently absorbed into it, because
`resolveChatRoute` keys purely on `telegram_chat_id` with no regard for trip.

*Agent note.* Fixed at the source (`chat-router.ts`, not just
`fresh-interview.py`'s own sweep), but the FIRST version of the fix was itself
unsafe: it treated "different trip" alone as license to supersede, which two
existing tests correctly refused to let through — one of them modelling the
exact cross-organizer leak the two-trip isolation matrix exists to prevent
(organizer A's token redeemed on organizer B's own live chat). "Same owner"
could not be the discriminator either — checked empirically, this
deployment's own test signups get different `user_id`s even from the same
real Telegram account. The signal that actually holds is genuine inactivity:
`awaiting_since` (from A3) plus a ten-minute threshold. Committed as `1a9197d`.

**2. The `interview-stack-deploy` skill failed its own tool-registration
check — because the check itself had a bug.** It matched the gateway's summary
log line ("MCP: registered N tool(s) from 1 server(s)"), which carries no tool
names, instead of the per-server line one line above it that lists every one.
Every deploy would have reported every tool "missing" regardless of the truth.
Caught the first time the script actually ran against a live gateway rather
than only being syntax-checked. Fixed and re-verified against the log already
on disk. Committed as `410a802`.

---

## Dror's notes

*(verbatim, added during the run)*

### Step 3 — interview bot

**1. A document was read and processed, but the completion message never
arrived.** Verbatim:

> I accidentally said no document and after asked about the trip type
> uploaded the document, it got the document wrote "Now let me read the PDF
> document:" but nothing happened

*Agent note — a real gap in A3, not the model misbehaving.* The document
extraction genuinely worked (six answers recorded). The agent's first reply
("Now let me read the PDF document") delivered correctly and released the
floor to the organizer, as designed. ~100 seconds later, once extraction had
actually finished, the agent tried to report success — and that message sat
in `ui_state` **undelivered for nearly ten minutes**, measured live. A3's
floor assumed exactly one machine reply per organizer turn; a multi-step
document extraction routinely needs to acknowledge, then work, then report
done, and the second attempt to speak hit `sendNextStep`'s very first guard
(`awaiting === "person" → return`) with nothing left to ever revisit it.

Fixed at every point the agent deliberately acts (`say_for_chat`,
`ask_question_for_chat`, `submit_answer_for_chat` / `record_answers_for_chat`,
`show_summary_for_chat`): each one reclaims the floor itself, because the
agent choosing to act is sufficient reason for it to be the machine's turn.
**One deliberate exception**, caught by an existing test this nearly broke:
once the recap is on screen, nothing may talk over the Confirm button — that
is run 7's other defect ("approved but nothing happened") reopening from a
different angle. Committed as `c493f05`. The organizer's own stuck message was
flushed by hand once the fix was live and verified.

**2. A Hermes housekeeping notice reached the organizer directly.** Verbatim:

> Got maintenance messages of model switched which should not reflect to the
> user
>
> ℹ Codex gpt-5.6-luna caps context at 272K, so auto-compaction was raised to
> 85% (from 50%) to use more of the window before summarizing.
>   Opt back out: hermes config set compression.codex_gpt55_autoraise false

*Agent note — an upstream Hermes gap, not a Kinerary defect, and fixed with a
config toggle rather than a code patch.* Hermes's own noisy-status filter
(`_TELEGRAM_NOISY_STATUS_RE`) already suppresses the sibling notice
("auto-**lowered** compression threshold") from reaching messaging platforms.
This one says "auto-compaction was **raised**" — different wording, not
covered by that regex, so it goes out unfiltered. A config flag exists
specifically for this
(`compression.codex_gpt55_autoraise_notice`, default `true`) that silences
just the notice while leaving the underlying autoraise behavior (more context
budget before summarizing — a good thing) on. Set to `false` in the live
profile and captured in the tracked `config.yaml.template`. Needs a gateway
restart to take effect, applied at the end of the run rather than mid-turn.

**3–7. Every optional question after the required set arrived twice or more,
and buttons stopped working.** Verbatim, across five separate reports:

> Asked twice about trip cadence one without buttons and one with
>
> Asked twice about bot name
>
> Every question about the bot is asked twice one with option and one
> without.
>
> Buttons does not move it, answering direct does

*Agent note — the most serious finding of the run, and the organizer's own
closing line names it exactly right: "it still seems that hermes and gw are
competing."* Root cause, confirmed from the relay log: the organizer answered
the travelers question as **five separate Telegram messages**, one line per
family member, rather than one multi-line message. `openAgentTurn` closes
whatever turn is open for a chat before opening a new one — so each of those
five messages tore down the previous turn and opened a fresh one, and **seven
distinct turn ids** appear in the log for that one burst. Hermes does not know
or care that we closed its turn row; it keeps running its own conversation
loop regardless, so this produced **several overlapping agent invocations**,
each independently free to nominate, ask or record something, with no
coordination between them. Two different invocations each deciding
independently "I should ask about trip_pace now" is exactly what produces one
buttoned ask and one buttonless one, and a checkbox that silently fails is
consistent with one overlapping invocation finalizing a question moments
before the organizer's tap on another invocation's now-stale keyboard lands —
refused as already-answered, surfaced only as a small, easy-to-miss Telegram
toast rather than a chat message.

Data integrity held throughout — `trip_pace` was checked and found recorded
exactly once (`balanced`), despite the doubled display — so this is a
conversation-level defect, not a record-level one.

**Not fixed live, deliberately.** This is a genuine concurrency bug, not a
wording problem, and it does not belong on a hot-patch mid-race — that is how
today's own floor bug briefly got worse before it got better. The right fix
debounces a rapid burst of organizer messages into one agent turn, mirroring
`ROUTER_PROMPT_SETTLE_SECONDS`'s existing pattern for the agent's own writes,
applied to the other side of the pipe. Scoped, not built, in §"Next" below.
The organizer was told to answer by typing rather than tapping for the rest of
the run, which worked and is exactly what let the interview reach
`intake_confirmed` despite the defect.

**8. Verdict.** Verbatim:

> Finshied, it wasn't terrible, but a lot of questions were asked twice or
> more, I don't mind open questions instead of the multiple answers but the
> duplication is confusing. I managed to get to the end of the interview
> which it is an accomplishment in its own, but UX is not good. It still
> seems that hermes and gw are competing.

*Agent note.* Two things worth carrying forward precisely as stated: the
organizer does **not** need buttons for everything — free-text answers are
fine — but duplication of any kind is the thing that reads as broken. That
reorders priorities for the next piece of work: eliminating double-asks
matters more than preserving every button.

---

## What worked, confirmed live

- **`intake_confirmed` reached cleanly** — no manual database intervention,
  the first time that has been true since run 4.
- The phase machine (A2) reached `recap` and the Confirm button correctly,
  and nothing buried it — the recap-protection exception added this run held.
- Document extraction wrote real answers (destination, both dates, phases,
  travel_anchors, trip_type) rather than living only in the model's context.
- The agent spoke more than once per turn without going silent, for the first
  time — visibly, in the "read the PDF… (100s pass) …all recorded" exchange,
  once the stuck message was flushed.
- Typed answers, used as a workaround for the racing-turns defect, worked
  reliably throughout.

## Still open at the end of the run

- **The turn-racing defect** ("hermes and gw are competing") — scoped, not
  built. See "Next" below.
- The bot-name/model-switch class of Hermes housekeeping notices may have
  other members beyond the one found this run; only this one was checked
  against Hermes's own filter regex.
- A loud startup check for a missing agent key, carried over from run 7, still
  not built.

## Next: debouncing a burst of organizer messages

Not started. Sketch only, for review before building:

- A short settle window on the INBOUND side, mirroring
  `ROUTER_PROMPT_SETTLE_SECONDS` on the outbound side: several messages
  arriving within N seconds of each other are coalesced into ONE forward to
  the agent (as one combined event, or as sequential messages within a SINGLE
  open turn) rather than N independent turns each tearing down the last.
- `openAgentTurn`'s close-then-open behavior is right for a genuinely NEW
  turn; the fix is upstream of it — deciding when a new inbound message
  really starts a new turn versus continuing one still settling.
- Needs the same treatment as A1–A3: a transcript-harness test reproducing
  this exact burst (five rapid messages, assert ONE turn opens, assert no
  question is asked twice), built and green before touching production code.

## Agent debrief

Six live-run defects fixed this session (floor-reclaim, chat-route staleness,
recap protection, the deploy script's own tool-check, plus the two carried
from run 7) and one real structural gap identified and deliberately left
unbuilt rather than rushed. The organizer's own diagnosis — two systems
competing — arrived at the same root cause independently and faster than the
log-reading did.
