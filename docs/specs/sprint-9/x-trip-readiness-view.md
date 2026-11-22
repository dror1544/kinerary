# The organizer sees the trip's setup stages, and that it is ready

Status: draft (2026-11-23) · Issue: none yet (`x-`) · Track: T5 · Size: M · Tier: Normal
Security path: no (reads only what the organizer's own trip page already reads) · Migration: no · Live-trip behaviour: yes (one new message to organizers; the dashboard card changes)

> Requested by Dror, 2026-11-23, in the member sign-in session: "the organizer needs to see the
> trip is ready, both in the DM and on the trip dashboard, showing the trip stages and that they
> are ready. Once ready, the trip-creation process can be collapsed." It is also his answer to
> "are organizers told before their trip is redeployed" (`x-member-sign-in.md`, A19 and A24).
>
> Not part of PR #627. It is drafted on that branch only because the drafting session could push
> nowhere else; move it to its own `docs/*` branch before approval.

## Problem

An organizer cannot see, in one place, where their trip stands or that it is finished.

- **Dashboard.** The trip page's "Setup progress" card (`web/src/pages/ProductApp.tsx:203`) has
  four steps: start the interview, confirm the outline, create the provisioning plan, review and
  approve the plan.
  - It stops at approval. Building the site and connecting the assistant are not steps.
  - It has no "ready" state. After the trip is built the card stays open, unchanged, above
    everything else.
- **Telegram.** The organizer gets up to two messages (`outbox-dispatcher.ts:143-170`):
  `provisioning_complete` ("Your trip site is ready: …") when the site is up, and
  `companion_ready`, the assistant's introduction. Neither names the stages or says the setup
  as a whole is finished.
- **A trip that is ready and then changes.** When a trip's site is redeployed
  (`scripts/trip-rollout.py`, which by design "notifies nobody"), the organizer is told nothing.
  The member sign-in rollout changes what already-invited members and secondary organizers can
  do on that day (A19).

## Behaviour

When this is done:

- **One list of setup stages**, the same in both places, each marked done or not:
  1. Interview
  2. Trip outline confirmed
  3. Plan approved
  4. Trip site built
  5. Assistant connected
- **The trip is "ready"** when all five are done.
- **Dashboard.**
  - While the trip is being set up, the card shows the five stages, with today's actions on the
    stage that needs one.
  - Once ready, the card collapses to one line: "Your trip is ready", the date, and "Open trip".
    A control expands it to show the five stages, all done.
- **Telegram.** When the trip becomes ready, the organizer gets one message in their own private
  chat: the trip is ready, the five stages ticked, and the site link. In the trip's language.
- **After a redeploy.** The dashboard's collapsed line also says when the trip site was last
  updated. No Telegram message is sent for a routine redeploy (see Open questions, Q3).

## Acceptance criteria

- **AC-1** The control plane answers, for a trip the caller organizes, an ordered list of five
  stages, each `{ key, done }`, plus `ready` (true only when all five are done) and `readyAt`.
  The stages are derived from state the trip already has:
  - `interview`: an interview session exists and is not paused;
  - `outline_confirmed`: lifecycle state is past `intake_in_progress`;
  - `plan_approved`: a provisioning plan exists and is not `pending_approval`;
  - `site_built`: lifecycle state is `ready_private` or later and the runtime route is `ready`;
  - `assistant_connected`: the trip has an open companion chat binding for the organizer.
- **AC-2** A stage that cannot be read resolves to not done, and `ready` to false. A trip that is
  suspended or retired is never `ready`.
- **AC-3** A member, a stranger, and an organizer of another trip get the answer an unknown trip
  gets. No stage data is served to them.
- **AC-4** While `ready` is false, the dashboard card shows the five stages in order, and the
  existing actions (start or resume the interview, create the plan, review and approve, retry)
  appear on the same stages as today.
- **AC-5** When `ready` is true, the card renders collapsed: one line, the ready date, and "Open
  trip". Expanding shows the five stages, all done. The choice to expand is not remembered
  across page loads.
- **AC-6** When a trip first becomes ready, exactly one `trip_ready` notice is enqueued to each
  organizer's own private chat, never to a group. It lists the five stages as done and carries
  the site link. Hebrew or English by the trip's language.
- **AC-7** The notice is sent once per trip. A redeploy, a relay restart, a second organizer
  added later, or the assistant reconnecting does not send it again.
- **AC-8** A trip whose assistant never connects gets the existing "Your trip site is ready"
  message and no `trip_ready` notice. The dashboard shows four of five stages done and stays
  expanded.
- **AC-9** The collapsed line shows "Trip site updated <date>" when the trip's recorded rollout
  version is newer than the one it was built with. Nothing is sent to Telegram.
- **AC-10** Nothing logs a chat id, a user id, a trip id or the site link in the new paths.

## Contracts

- **Control plane (`control-plane/api/src/`).**
  - `portal.ts`: the trip detail the dashboard already reads (`GET /v1/trips/:id`) gains
    `setup: { stages: [{ key, done }], ready, readyAt, siteUpdatedAt }`. No new route.
  - A small module (for example `trip-setup-stages.ts`) holds the derivation, so the dashboard
    answer and the notice use one definition.
  - `outbox-dispatcher.ts`: a new notice type `trip_ready`, enqueued where `companion_ready` is
    enqueued today, in the same transaction, guarded so it is written once per trip.
  - Its text sits beside `organizerIntroMessages` in `companion-intro.ts`.
- **Dashboard (`web/src/pages/ProductApp.tsx`).** The "Setup progress" card renders from
  `setup.stages`; collapsed when `setup.ready`.
- **No migration** if "sent once" can be read from the outbox's own rows for the trip. If it
  cannot, a nullable `trips.ready_notified_at` column, with the `-- rollback: compatible` header.
- **No change** to the trip site, the runtime gateway, or `scripts/trip-rollout.py`.

## Non-goals

- A status the organizer can ask the bot for at any time (see Q2).
- Telling organizers about a routine redeploy (see Q3).
- Stages after setup: activation, the trip running, completion.
- Showing stages to members.
- The classic trip site.

## Security and boundary notes

- **Organizer-only.** The stages ride on the trip detail route, which already refuses everyone
  but the trip's organizers with the answer an unknown trip gets (AC-3).
- **Fail safe.** Unknown or unreadable resolves to not done and not ready (AC-2).
- **The notice goes only to a private chat that belongs to an organizer**, by the rule the
  existing organizer notices use. Never a group.
- **No raw config value is served.** The stages are booleans derived from control-plane state.

## Test plan

Tests first, from the ACs.

- `control-plane/api/test/trip-setup-stages.test.ts` (Postgres): each stage on and off; ready
  only when all five; unreadable, suspended and retired trips (AC-1, AC-2); who may read it
  (AC-3).
- `control-plane/api/test/trip-ready-notice.test.ts`: enqueued once, to each organizer's private
  chat, never a group; not re-sent on the four events in AC-7; absent when the assistant never
  connects (AC-6 to AC-8); Hebrew and English; log hygiene (AC-10).
- `web/`: the card expanded while not ready, with today's actions on the right stages; collapsed
  when ready; expands on click; the updated line (AC-4, AC-5, AC-9).
- Manual check on staging: build a trip end to end and watch the card and the message.

## Rollout and regression

- **Who feels it:** organizers of trips that become ready after the deploy get one more
  message. Organizers of trips that are already ready see the card collapsed on their next
  visit. They get no message, because the notice is enqueued only at the moment a trip becomes
  ready.
- **Clock:** control plane and portal only. No trip redeploy is needed.
- **Regression plan:** assessment needed. It changes what the outbox sends to organizers, which
  is relay-adjacent behaviour.

## Open questions

- **Q1. The five stages.** You said "the setup process". The dashboard shows four today; this
  spec adds "Trip site built" and "Assistant connected", so that "ready" means the trip can
  actually be used. Is that the list?
- **Q2. The Telegram message.** I asked whether you want one message when the trip becomes
  ready, or a status the organizer can ask for at any time, and you answered "yes". This spec
  assumes the first: one message, once. Say if you also want the second.
- **Q3. Redeploys.** You said this is your answer to "are organizers told before their trip is
  redeployed". This spec assumes: the dashboard shows when the trip site was last updated, and
  no Telegram message goes out for a routine redeploy. For the member sign-in rollout
  specifically, which changes what invited members and secondary organizers can do (A19), do
  you want a one-off Telegram message to the organizers of the affected trips? If so it is a
  separate, small item on that rollout, not part of this feature.
- **Q4. Trips that are already ready.** Should their organizers get the `trip_ready` message
  once, on deploy? This spec says no: they already know.
