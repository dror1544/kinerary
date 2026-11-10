# A paused interview picks up where it stopped

Status: approved 2026-11-05 by Dror (option A, "pause it") · Issue: #513 · Track: T1 · Size: M · Tier: Normal
Security path: yes (`portal.ts` interview-link routes and enrollment: who may get a link for a trip) · Migration: no expected (say so if one is needed: timestamped, rollback header) · Live-trip behaviour: yes (interviews that expire after the deploy)

## Problem

Found on Mac staging, 2026-11-04. An interview closes an hour after the
organizer's last message (`expired_at`). After that:

- the trip stays `intake_in_progress`, so `issueEnrollment` refuses
  (`TRIP_NOT_DRAFT`) and no new link can be issued;
- the dashboard shows "Continue in Telegram", a plain bot link with nothing
  to continue;
- a new session, if one could start, is built from the trip card's seed only
  (`startSession`, `interview.ts`) and never reads the answers already given.

So a pause (dinner, waiting for a partner's tickets) becomes a dead end.
`docs/interview-without-an-agent.md` §8 left "end or park?" open; this decides
it: **park**.

PR #515 already fixed the two smaller halves: `hasInterview` ignores an expired
unconfirmed session, and the bot's "this conversation has closed" notice is no
longer suppressed by an earlier confirmed trip.

## Behaviour

Decided by Dror on 2026-11-05: an expired interview is paused, not ended. A
new link resumes it with every answer kept.

## Acceptance criteria

- AC-1 Given a trip whose latest interview session is unconfirmed and expired,
  when the organizer opens the trip on the dashboard, then it says the
  interview is paused and offers **Get a new interview link**. It does not
  offer "Continue in Telegram", and it does not offer "Replace lost interview link".
- AC-2 Given that trip, when the organizer asks for a new link, then a link is
  issued (no `TRIP_NOT_DRAFT`, no `INTERVIEW_ALREADY_STARTED`), and any earlier
  unredeemed link for the trip stops working.
- AC-3 Given that link, when it is opened in Telegram, then the interview
  resumes. Every answer recorded in the expired session is on record, and
  `ui_state` facts that are answers about the person also carry over: the
  organizer's name, a declined name or stop confirm. The next question is the
  first one still unanswered. Nothing already answered is asked again.
- AC-4 The resumed opening says so in one line before the next question, for
  example "Welcome back — let's pick up where we stopped." in English and
  "ברוכים השבים — ממשיכים מאיפה שעצרנו." in Hebrew (plural voice), in the
  expired session's language. It is not the first-time introduction.
- AC-5 Card values seed only questions that are still unanswered. A carried-over
  answer is never overwritten by the card (AC-4 of #438 still holds).
- AC-6 Documents already read for the trip stay attached to it, and are not
  read or charged again. A re-sent copy is handled by #514's rule.
- AC-7 Given an expired session and a message in that chat, the bot's
  `expiredWriteAfter` notice points to the dashboard for an organizer who
  has one ("open the trip on the dashboard and get a new link there") and to
  whoever set the trip up otherwise. Hebrew in plural voice. The proposed text
  is in PR #515's carry-forward.
- AC-8 A trip created by Telegram sign-up or an operator invitation (no
  dashboard) resumes the same way from an operator-issued or re-requested link.
- AC-9 A confirmed interview is unaffected: no new link, no resume.
- AC-10 Only the trip's owner can get the link (the existing route's scope,
  unchanged), with a boundary-review note in the PR.

## Contracts

- `control-plane/api/src/enrollment.ts`: `issueEnrollment` / `replaceEnrollment`
  accept a trip whose only unconfirmed session is expired.
- `control-plane/api/src/interview.ts`: `startSession` carries over the latest
  expired unconfirmed session's answers for that trip; the expiry sweep
  (`claimExpiredSessions`) and the trip lifecycle (stay in
  `intake_in_progress`, or return to `draft`: the builder's choice, stated and
  tested).
- `control-plane/api/src/portal.ts`: trip detail carries a paused flag the page
  reads; `recoverable` agrees with what `/replace` answers.
- `web/src/pages/ProductApp.tsx`: the paused state and its button.
- `intake-copy.ts`: the resume line and the dashboard-aware expired notice.

## Non-goals

- Resuming on the organizer's next message without a link (§8's other option).
  The link stays, because it is what binds the chat to the trip.
- Changing the one-hour expiry.

## Test plan

Written first: DB tests for AC-2, AC-3, AC-5, AC-6 and AC-9 (expire a session,
issue a link, redeem it, read the new session); portal tests for AC-1 and
AC-10; web tests for the paused state; copy tests for AC-4 and AC-7 in en and he.

## Rollout and regression

Relay and API restart. Interviews that already expired before the deploy become
resumable too, which is what we want. Per-PR regression plan: needed (enrollment
and session start).
