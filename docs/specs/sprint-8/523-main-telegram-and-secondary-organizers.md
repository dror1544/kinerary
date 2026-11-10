# Main Telegram per account; secondary organizers by trip link

Status: approved 2026-11-07 by Dror · Issue: #523 · Track: T1 · Size: L · Tier: Normal
Security path: yes (who is an organizer, on Telegram and on the trip site; `organizerOrAgentRequired`) · Migration: likely (timestamped, rollback header) · Live-trip behaviour: yes
Builds on: #519 (PR #521, one organizer, one Telegram)

## Problem

#519 made a trip's organizer one Telegram account, with the dashboard's
"link my Telegram" (`lk_`) link scoped to one trip. Its third boundary review
found that after a lost phone the new phone could start no new trip (N1). Dror
replaced the implicit rules with two explicit links.

## Behaviour (Dror, 2026-11-07)

- **The main Telegram.** On the dashboard, the account's **Link Telegram**
  creates a link that opens the bot. Opening it binds that Telegram account to
  the Kinerary account as its **main, default** Telegram: account-wide, for
  every trip, present and future. There is one main Telegram per account. A new
  one **replaces** the old one, which is unlinked from the account and its
  trips. This is also lost-phone recovery.
- **Secondary organizers.** The **main organizer** can add a secondary organizer
  to one trip. From that trip's dashboard page, or from the organizer view on
  the trip site, they create a **trip link**. Whoever opens it in Telegram
  becomes a secondary organizer of **that trip only**. A secondary organizer:
  - organizes that trip from Telegram: the companion's organizer actions, plan
    changes, documents;
  - gets an **organizer view on the trip site** for that trip;
  - has **no dashboard** access and needs no Kinerary account;
  - sees only that trip in `/trips` and anywhere trips are listed;
  - **cannot** add organizers, create trip links, approve link requests, or see
    any other trip.
- **Interview links** follow #519: they belong to the main Telegram. A
  different Telegram is refused (interview started) or the main organizer is
  asked (not started). An approval stays per trip, as #519 decided.

## Acceptance criteria

- AC-1 Given a signed-in account, when it opens **Link Telegram** and the link
  is opened in Telegram account T, then T becomes the account's main Telegram
  (account-wide). An interview link for any of the account's trips, including
  ones created later, opened from T starts as the organizer.
- AC-2 Given a main Telegram T0, when the account links T1 the same way, then
  T1 is the main Telegram, and T0 is unlinked from the account and from every
  trip where it was bound through the account (trip-only approvals and
  secondary-organizer bindings of other people are untouched). T0 is told once
  in its chat; T1 is told it is now the main Telegram.
- AC-3 The account link is single use, short-lived (as today's `lk_`), issued
  only to the signed-in account (session + CSRF), and reaches nothing until
  opened.
- AC-4 Given a trip, when its main organizer creates a **trip link** (from the
  dashboard's trip page or the trip site's organizer view), and Telegram account
  S opens it, then S is a secondary organizer of that trip only. The link is
  single use and short-lived, and the main organizer is told who joined (first
  name and @username).
- AC-5 Given secondary organizer S, then in Telegram S can do the organizer
  actions for that trip. `/trips` lists only that trip. S cannot create links,
  approve requests, add organizers, or reach any other trip. Each of these is a
  test.
- AC-6 Given S, then S can open the trip site's organizer view for that trip
  (the companion gives the link, or the same sign-in members use, with organizer
  role for that trip only). S has no dashboard session, and the dashboard routes
  refuse S. On the trip site, organizer-only routes accept S for that trip and
  refuse S for any other.
- AC-7 Only the main organizer can create a trip link. A secondary organizer,
  a member, or an outsider is refused, on the dashboard and on the trip site.
- AC-8 The main organizer can remove a secondary organizer (dashboard trip page
  and trip-site organizer view). Removal takes effect at once in Telegram and on
  the site.
- AC-9 #519's rules still hold for interview links, including "an account that
  ever had a Telegram is never treated as empty" and the per-trip approval.
- AC-10 Hebrew and English copy for every new message, with Hebrew in plural
  voice.

## Contracts (for the builder to confirm)

- `telegram-link-token.ts` (`lk_`): becomes the account link (AC-1 to AC-3).
  Its #519 `binding_scope` becomes `account`, and replacement revokes the old
  main.
- A new trip-link token kind, and a secondary-organizer binding with its role,
  probably `binding_scope = 'trip'` plus a role column, or its own table.
- The trip site: `organizerOrAgentRequired` (`server/server.js`) must accept a
  secondary organizer's session for its trip. This is a security path, so the
  allow-list and `sanitizeConfig` invariants are untouched and proven by
  request/response.
- `/trips` and every trip list (`organizer-trips.ts`).

## Non-goals

- A dashboard for secondary organizers.
- More than one main Telegram per account.

## Test plan

Written first: DB and route tests for each AC. A boundary review with live
request/response on the trip site (AC-6, AC-7). Each "cannot" in AC-5 and
AC-7 gets its own refusal test.

## Rollout and regression

Relay, API and trip-site redeploys. Every live trip site needs the server change
for AC-6. The existing `lk_` links become main-Telegram links. The per-PR
regression plan is needed, and redeploying the trip sites needs Dror's approval.
