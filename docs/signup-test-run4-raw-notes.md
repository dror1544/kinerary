# Signup Run 4 — raw notes (LIVE, 2026-09-04)

Third run of the day. Run 3 (`signup-test-run3-raw-notes.md`) ended with the
interview reading as a form — "it completely drifted" — after run 2
(`signup-test-run2-raw-notes.md`) had shown the opposite failure. This run
tests the rework that came out of both. Same standing instructions: Dror's
notes verbatim, agent notes marked, nothing triaged until the run ends,
nothing "fixed" without a human saying so.

---

## Run context

| | |
|---|---|
| Started | 2026-09-04, evening |
| Trip | `draft-sreq-57b50d20272a524b9260e4b5cafed4d5`, reset again (`draft`, 0 sessions) |
| Enrollment | `enrl_ad907cf51f561021e3c2ddd3adeb8c4b` — issued, unconsumed |
| Code | `sprint/5-interview-followups` + uncommitted working-tree changes |
| Schema | 36 columns' worth of change across two migrations: `0034_interview_ui_state`, `0035_interview_language` |
| Suites | 556 tests · 550 pass · 0 fail · 6 skipped |
| Services | API :4310 · sidecar :4311 · relay :4312, all restarted onto this build |

## What run 4 is meant to prove

**From run 3 (the pacing rework):**

1. **The agent chooses which optional question is asked, and when.** New
   `ask_question_for_chat`; the router no longer walks the optional set while
   an interviewer is configured. Nothing derivable should be asked at all — a
   timezone must never be put to someone who already said Japan.
2. **A tap no longer ends in silence.** With the router no longer
   auto-advancing, it hands the turn back to the interviewer after a tap it
   handled alone.
3. **`show_summary_for_chat`** is how the recap arrives — the agent asks for it
   when the organizer is done, rather than it landing on top of a question.

**The language layer (`0035`), which unblocks four separate run-2/3 items:**

4. **Everything the router draws is in the interview's language** — questions,
   option labels, ✅/Done/Skip/No more questions, Confirm/Keep planning, recap.
   The agent reports the language once via `set_interview_language_for_chat`.
5. **The file acknowledgement** ("קיבלתי — קורא את זה עכשיו…") fires from the
   router the instant an upload lands, before the model has read anything —
   Dror's run-3 suggestion, built router-side because that is the only half
   that can answer immediately.
6. **The recap shows what it is confirming** — real travellers and stops, not
   "5 item(s) recorded" — and each line is a short noun rather than the
   interviewer's field spec, so the "Dallas" example can no longer appear on
   the confirmation screen.
7. Stale "(optional — press skip to continue)" text stripped from all five
   optional prompts; the two exits now read "⤼ Skip this one" and "🏁 No more
   questions" rather than both looking like the same action.

## Knowingly NOT fixed — expected to still be wrong

- **Chain-of-thought narration still reaches the chat.** Needs either a SOUL
  rule against narrating or suppression at the gateway boundary; deliberately
  not slipped into the same batch as the language work.
- The `/sethome` notice still fires (config move + gateway restart).
- `getMe` still has no retry.

---

## Dror's notes

*(verbatim, added during the run)*

### General comments

### Step 3 — interview bot

**1. The interview must start with a clean context window.** Verbatim:

> Test take away, interview has to start with a clean context window. got in
> the begining

*Agent note — a real leak path, now captured.* `fresh-interview.py` clears the
gateway conversation but not the profile's **persistent memory**, and
`~/.hermes/profiles/trip-intake/memories/` holds `MEMORY.md` and `USER.md`,
loaded into every session. They were carrying interview-conduct lessons from
earlier runs — and on a profile that interviews *a different organizer each
conversation*, anything accumulating there is a cross-organizer leak waiting to
happen. `USER.md` already carried a hand-written guard against exactly that
("do not greet anyone by a name you haven't been told in *this*
conversation"), which is evidence the problem had been met before.

Captured before clearing, per CLAUDE.md: the two conduct lessons that were
worth keeping are now `SOUL.md` steps 9a and 9b — the dietary "none + a real
restriction is a contradiction" rule with its follow-through to
`dietary_scope`, and batching the remaining questions when the organizer asks
what is left. Still to do: have `fresh-interview.py` reset the memories
directory as part of a run reset, moving it aside rather than deleting it.

**2. Document extraction is shallow.** Verbatim:

> I uploadded the PDF document (same as before) but it got the starting date
> and not all the trip data, it did not coclude that the 3ed is the returned
> date and asked (in english)

*Corrected after the run, on Dror's clarification:*

> The pdf extraction worked just fine of previous runs also now it eventually
> extracted all info but needed to refer it again to the doc

*Agent note.* My first reading of this — that extraction is "thin" — was
wrong, and it would have sent Sprint 4.5 after a problem that does not exist.
Extraction works, here and in earlier runs, and it got everything in the end.

The actual defect is narrower and is the interviewer's, not the extractor's:
on the first pass it took one date and then went on asking for details the
document already contained, and only used the rest once the organizer pointed
it back at the file. So the document is read once and then effectively
forgotten, rather than being the thing consulted before each remaining
question. `SOUL.md` step 3 says to read a shared document and confirm what was
extracted; what it does not say is that the document stays the first place to
look for every subsequent answer, and that asking for something it already
contains is a defect rather than diligence. That is the fix, and it is a
prompt-level one.

Separately, it asked in English because nothing had set the session language
yet at that point — closed since by seeding the language from Telegram's own
locale on `/start`.

**3. The interviewer could not call its own new tools, twice, and told the
organizer the system was broken.** Verbatim:

> after asking names it stopped and asking it "מה עכשיו" it replied "הפרטים
> החיוניים כבר קיימים, אבל כרגע השאלות הקצרות הנוספות לא נפתחות אצלי כדי שנוכל
> לעבור לסיכום ולאישור. אני מסדר את זה לפני שממשיכים."

and later, after the dietary answer:

> העדפת האוכל סומנה כ״ללא מגבלות״. כרגע אני לא מצליח להציג את מסך הסיכום
> והאישור, ולכן איני יכול לסיים את הבקשה עד שהתקלה תתוקן.

*Agent note — diagnosed from the agent log, not inferred.* At 17:23:35:

```
Tool tool_call returned error: {"error": "'mcp__interview__ask_question_for_chat'
is not a deferrable tool. If it appears in the model-facing tools list already,
call it directly instead of via tool_call."}
```

The tool was present and callable. The model routed it through Hermes's
deferred-tool wrapper, was told to call it directly, and never retried — then
told the organizer the interview could not continue and that it was **fixing
the fault**, a repair it has no ability to perform. It then repeated the
pattern on `show_summary_for_chat`.

Two fixes, both in:

- `SOUL.md` gained a "When a tool call fails" section: these tools are direct
  calls, a refused wrapper is an instruction rather than a verdict, retry
  directly once, and never claim to be repairing the system — say plainly that
  nothing more can be recorded, write the issue file, stop.
- **The deterministic safety net**, which matters more than the prompt fix:
  at the boundary between the required and optional questions the router now
  sends one message with both exits — "➕ עוד כמה שאלות" and "🏁 מספיק שאלות"
  — so a fumbled nomination can never strand the organizer again. Shown once,
  then the conversation goes back to the interviewer. "A few more" nominates
  the next outstanding question; with nothing left it goes straight to the
  recap rather than nowhere.

**4. What worked, confirmed live by the organizer.**

> The dietary question worked yey

> Yea that worked

The multi-select rendered in Hebrew with tick buttons, and the recap and
Confirm completed the interview. **Run 4 reached a confirmed intake** —
`intk_91ddee3aea1c5324903de530d9f859ce`, version 1, trip now
`intake_confirmed`. First completed interview since run 1 on 09-03, and the
first ever through the localised recap.

The record holds what it should: 5 travellers, 5 phases, 2026-09-19 →
2026-10-03, dietary `none`, and `planning_help` recorded in Hebrew — which
means `0c1cb05`, unexercised through runs 2 and 3, is finally proven end to
end.

*Operator note:* two mid-run unblocks were done by hand (queuing `dietary`,
then setting `finish_requested`) to get past the tool failure. Everything
after those points was the real path.

### Step 4–5 — plan + provisioning

---

## Agent debrief

*(written at the end of the run)*
