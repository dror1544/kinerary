# Signup test — run 14 raw notes (2026-09-12, Proxmox VM)

The organizer's own interviews against the VM stack (`@Tripinterviewer_bot`,
agentless interpret path), untriaged. Nothing here enters the Status ledger in
`signup-test-execution-capture (Manual).md` until the run ends — the standing
instruction at the top of that file.

Two runs, same night. The first (`trip_c595f355…`, torn down) produced five
findings that were fixed the same night: double MarkdownV2 escaping, the
multi-select finishing on its first tap, a tapped Skip going silent, a
companion naming its plumbing and asking the organizer to read the site for it,
and an introduction that gave the site password without the username to use it
with. The second (`trip_e853e76f…`) is below.

---

## 1. "From here it's optional" arrived after the optional questions — and
## "more questions" answered with the summary

**Reported (Dror, verbatim):** the message

> זה כל מה שבאמת צריך — מכאן זה רשות. עוד כמה שאלות יעזרו לי להתאים את העוזר
> לקבוצה: איך אתם אוהבים לטייל, מה אוכלים, על מי לשים לב. תענו על כמה שבא לכם,
> ותלחצו סיים מתי שתרצו.

"come after the optional question (seems like it). I checked more questions on
it and got the interview summary."

**What the relay recorded for that session:**

```
05:01:12–05:01:18  trip_bot.prompt_deduped  prompt=q:dietary        (×4)
05:01:59–05:02:03  trip_bot.prompt_deduped  prompt=q:bot_proactive  (×3)
05:02:19           trip_bot.prompt_deduped  prompt=q:planning_help
05:02:34           trip_bot.router_prompt_sent state=awaiting_confirmation
```

So the optional walk was already underway — `dietary`, then `bot_proactive`,
then `planning_help` — when the boundary message landed, and by the time More
was tapped there was nothing optional left unanswered, which is exactly when
`deriveSessionState` moves the session to `awaiting_confirmation` and the next
thing the router has to send IS the summary. The organizer asked for more
questions and was shown the end.

**Where it lives.** The boundary message is `renderEssentialsDone`, sent from
`sendNextStep`'s `!question && state !== "awaiting_confirmation"` branch, whose
"exactly once" is the entry action of the `optional` phase. On the interpret
path the router ALSO walks the optional list itself (`autoWalkOptional`, true
whenever `onInterpretPath`). Nothing orders those two against each other: the
walk can start before the phase transition announces it.

**Not fixed, and deliberately unowned.** Which of the two owns the boundary —
announce before the first optional question, or drop the announcement on the
interpret path where the router is walking them anyway — is a design call about
how the interview paces itself, not a defect to patch blind. Needs Dror.

## 2. Note — the floor race showed itself, and the retry covered it

Instrumentation added the same day (`trip_bot.floor_lost`, for `claimFloor`
returning false, which used to be a bare `return false` with no log at all)
fired for the first time in the wild:

```
05:02:19  telegram_api.call_threw
05:02:19  trip_bot.floor_lost
05:02:19  trip_bot.prompt_deduped prompt=q:planning_help
05:02:34  trip_bot.router_prompt_sent state=awaiting_confirmation
```

A Telegram call threw, the floor was lost, and the session still reached the
recap fifteen seconds later — the retry added the same day covered it.

The `TypeError` is almost certainly a network failure rather than a defect:
Node's `fetch` rejects a failed request as `TypeError`, and the catch already
treats it as `NETWORK`. It records `error.name` only, deliberately — nothing
from the error message, which could carry a URL with the bot token in it. The
cost of that is precisely this: a real TypeError and a dropped connection are
indistinguishable in the log. What was lost is one `editMessageText`, so a
keyboard somewhere kept its old text instead of collapsing.

If telling the two apart ever matters, the fix is a classifier at the catch
(`error.cause?.code`, `ECONNRESET`/`UND_ERR_*` → `NETWORK`, anything else →
`THREW`), not a wider log line.
