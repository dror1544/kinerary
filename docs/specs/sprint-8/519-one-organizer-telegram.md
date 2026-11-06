# One organizer, one Telegram: a link opened by someone else

Status: approved 2026-11-06 by Dror · Issue: #519 · Track: T1 · Size: M · Tier: Normal
Security path: yes (who becomes a trip's organizer in Telegram; enrollment redemption) · Migration: possibly (a pending-approval row, if no existing table fits: timestamped, rollback header) · Live-trip behaviour: yes (every interview link redeemed after the deploy)

## Problem

An interview link is a bearer token. Today whoever opens it in Telegram is
linked as an organizer of the trip (`linkTelegramOrganizerInTx`,
`organizer-trips.ts`), whatever Telegram account the organizer already uses.
The boundary review of #517 (2026-11-06) showed a forwarded link making a
stranger an organizer, and, with a paused interview, reaching its answers.
#517 stopped the answers from carrying over; the stranger still became an
organizer.

## Behaviour

Decided by Dror on 2026-11-06:

- **A trip has one organizer, the approved one.** A link never silently adds a
  second Telegram account.
- **Not yet bound.** If the organizer's account has no Telegram account bound
  yet, the Telegram account that opens the link is bound as the organizer, as
  today.
- **Same account.** If the account is bound to this same Telegram account, the
  interview starts or resumes as today (#517 rules unchanged).
- **A different Telegram account, interview already started.** If any
  interview session exists for the trip (live, paused or confirmed), there is
  no approval. The other person is refused, and the original organizer is told.
- **A different Telegram account, interview not started.** The original
  organizer is asked to approve. **Approve** makes the new Telegram account the
  organizer's account for this trip, and unbinds the old one from the trip.
  **Decline**, or no answer, leaves everything as it was.

"Bound" means the organizer's account (the link's `user_id`) has a verified,
non-revoked Telegram identity: an organizer link for that user, or a Telegram
identity on the account. The builder names the exact source and uses one
definition everywhere.

### Decisions after the boundary review (Dror, 2026-11-06)

- **An approval counts for that trip only.** When the organizer approves another
  Telegram account for trip A, that account becomes the organizer's Telegram
  for A only. For the account's other trips it is not "bound": opening a link
  for another trip follows that trip's rule (refused, or the organizer is asked).
  The approval prompt says so.
- **The one exception: the dashboard's signed-in "link my Telegram" link**
  (`lk_`, `telegram-link-token.ts`). It adds a Telegram account to its own trip
  without approval, because it is the signed-in owner's own act and the way back
  after a lost phone. It counts for that trip only, so a leaked dashboard link
  cannot open the account's other trips.
- So account-wide "bound" = the account's Telegram sign-up identity plus links
  created by an ordinary redemption of the account's own interview links. Links
  from an approval or a dashboard link count for their own trip only.
- Typed approve/decline is ignored while the organizer's chat has a live
  interview (the words go to the interview), and the Hebrew "אישור" is not an
  approve word: it is the recap's own button label. Found by the boundary review
  (F1).

## Acceptance criteria

- AC-1 Given an organizer account with no bound Telegram, when a link is opened
  from Telegram account T, then T is bound as the trip's organizer, and the
  interview starts as today.
- AC-2 Given an account bound to T, when T opens a link for that account's
  trip, then behaviour is unchanged (start, or #517 resume).
- AC-3 Given an account bound to T0, and a trip with any interview session,
  when another account T1 opens the link, then:
  - T1 gets one message saying this link belongs to another organizer and to
    ask them, and nothing about the trip (no destination, no dates, no names);
  - no session is created and T1 is not linked to the trip;
  - the link stays unused (not consumed), so the real organizer can still use
    it;
  - T0 gets one message: someone else opened your interview link for
    "<trip title>"; if it was not you, get a new link from the dashboard.
- AC-4 Given an account bound to T0, and a trip with no interview session, when
  T1 opens the link, then:
  - T1 is told the organizer has been asked to approve, and nothing about the
    trip;
  - T0 gets an Approve/Decline prompt naming the trip and T1's Telegram first
    name and @username, and only those;
  - nothing is bound and no session starts until T0 answers.
- AC-5 When T0 taps **Approve**, then T1 replaces T0 as the organizer's
  Telegram for this trip: T0's link to the trip is revoked, T1's is created, the
  link is consumed, and T1's interview starts (the ordinary seeded opening). T1
  is told it is approved. T0's bindings for other trips are unchanged.
- AC-6 When T0 taps **Decline**, or does not answer before the link expires,
  then nothing changes. T1 is told it was not approved (on decline), and the
  link stays usable by T0 until it expires.
- AC-7 The Approve/Decline buttons work only from T0's own private chat, once,
  and only while the request is pending. A second tap, a tap from another chat,
  or a tap after expiry does nothing but say so. Buttons are shortcuts: typing
  "approve"/"decline" in T0's chat while a request is pending does the same.
- AC-8 Group chats never redeem an organizer link (unchanged); nothing here is
  sent into a group.
- AC-9 Hebrew and English copy for every new message. Hebrew uses the plural
  voice of the rest of the interview copy.
- AC-10 The existing "Unlinked for this trip" rule (`revoked_at`) still holds:
  a revoked pair is never re-bound by a link, approval or not.

## Contracts

- `control-plane/api/src/organizer-trips.ts` (`linkTelegramOrganizerInTx`) and
  the enrollment redemption path it is called from (`/start` handling,
  `chat-router.ts`/`interview.ts` `startSession`).
- A pending approval: an existing table if one fits (the signup approval
  requests and `telegram_callback_refs` are the precedents), otherwise a
  migration.
- The relay callback handling for the two buttons (`relay/poller.ts`).
- `intake-copy.ts`: the new messages.

## Non-goals

- Co-organizers. A second organizer is a later product decision.
- Changing who may get a link on the dashboard (#517's scope is unchanged).
- The operator-invitation path (#518).

## Security notes

This narrows who can become an organizer. The decision is made from the
verified Telegram `from.id` of the update and the account's stored binding,
never from message text. T1 learns nothing about the trip at any point before
approval. Boundary review before merge.

## Test plan

Written first, as DB tests through `dispatchUpdate` and the callback handler.
Write one or more per AC, and also cover:
- a forwarded link on a started trip (AC-3);
- the approve and decline round trips (AC-5, AC-6);
- a button tapped from the wrong chat or twice (AC-7);
- the typed fallback (AC-7);
- a revoked pair (AC-10).

## Rollout and regression

Relay and API restart. Applies to links opened after the deploy. Trips that
already have a second Telegram organizer keep it; this spec does not unbind
anyone retroactively. Per-PR regression plan: needed (redemption path).
