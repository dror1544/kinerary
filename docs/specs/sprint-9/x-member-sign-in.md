# Trip members sign in without a password

Status: approved (2026-11-19, by Dror) · Issue: none yet (`x-`); folds in #614 · Track: T5 · Size: L · Tier: High
Security path: yes (Mini App sign-in links, runtime launch exchange, site invites, password recovery) · Migration: yes · Live-trip behaviour: yes, behind a per-trip switch, off by default

> **Build timing.** Built on its own branch, merged to `main` **after 2026-12-06** (the VM is
> frozen 2026-11-24 to 12-06). Nothing here may reach `main` before then.
>
> **Approved 2026-11-19 by Dror**, with the decisions recorded under "Decisions" at the end.

## Problem

Today a trip member can get in five ways. Each one has a gap:

| Way in | Where | The gap |
|---|---|---|
| Password on the trip site (`/api/auth/login`, `server/server.js`) | trip site | Seeded at provisioning or set through a one-time link. People forget it, and only the organizer can reset it. |
| One-time enrollment link (`POST /api/agent/participants`, `…/reset-password`, then `/api/auth/enroll`; 30 min) | trip site | Works, but the organizer has to make one and send it every time. |
| Telegram Login widget (`/api/auth/telegram-login`) | trip site | Telegram binds the widget to one domain per bot. With one shared bot and a hostname per trip it cannot work. It is **ruled out permanently** (Dror, 2026-08-28), and nothing here brings it back. |
| Google button (`/api/auth/google-login`) | trip site | Google Cloud has no API for authorized JavaScript origins, and wildcards are refused, so every trip's hostname needs a manual console entry. `googleClientId` is null on every trip. |
| Telegram Mini App (`control-plane/api/src/telegram-mini-app.ts`) | control plane, through the runtime gateway | The first launch needs a `telegram_member_links` row. Only a person who types a control-plane trip password, or redeems a site invite, while presenting fresh initData gets one (`linkMemberInTx`, `:493`). |

Two facts make the gap worse than the table shows.

1. **Most travellers do not exist in the control plane at all.**
   - The interview seeds travellers into the trip site's own database. No `control_plane.users`
     row and no `trip_memberships` row is written for them.
   - Only an invite redemption writes those rows (`portal.ts:1795-1835`).
   - The runtime launch exchange finds the trip-site username through a redeemed `site_invites`
     row alone (`portal.ts:1885-1893`).
   - So a seeded traveller has no Mini App way in, whatever they type.
2. **The trip's Telegram group already says who belongs.**
   - The organizer adds people to it, and the companion lives in it.
   - Being in it grants nothing today, although the trip site already uses live group
     membership as a precondition for its own Telegram sign-in (`telegramActiveMember`,
     `server/server.js:134-141`).

## Behaviour

When this is done:

- **S1: open from the group.**
  - A member taps "Open the trip" in the trip's Telegram group.
  - **First launch:** Telegram identifies them, the control plane checks live that they are in
    that trip's group, and they pick their own name from the travellers nobody has claimed yet.
    From then on the Mini App opens the trip directly.
  - **No password and no email**, and the claim never makes anyone more than a `member`.
  - **Leaving the group closes this way in.** It is checked on every launch.
  - **The organizer sees every claim** and can release a wrong one.
- **S2: a personal invite, for people not on Telegram.**
  - Organizer settings → Signing in can produce a personal invite link for an *existing*
    traveller (today it makes a trip-site enrollment link).
  - Opening it lets the traveller choose Google, through the dashboard origin, or a password.
  - The device then stays signed in, as any portal session does.
  - The companion can produce the same link when the organizer asks it to.
- **S3: help yourself back in (#614).**
  - Every sign-in screen of a member account offers "Send me a sign-in link".
  - The link goes to the account's linked Telegram chat, or to its verified email address.
  - The answer on screen is the same whether or not the account exists.
  - The organizer's one-time link stays as the fallback.

The trip-site password, the enrollment link and the trip-site routes stay exactly as they are.
Nobody loses a way in.

## Slices

| Slice | Content | Depends on | Size |
|---|---|---|---|
| S1 | Group sign-in in the Mini App, claims, release, switch | Q1 = yes | M |
| S2 | A site invite for an existing traveller; Organizer settings and companion produce it | — | M |
| S3 | "Send me a sign-in link" (#614) | S2's account model | S–M |

Each slice is its own PR on the branch, mergeable alone and in this order. S2 may come before S1.

## Acceptance criteria

### S1: group sign-in

- **AC-1** Given switch `member_group_sign_in` is OFF for a trip (also when it is unknown or
  unreadable), when someone launches the Mini App with `startapp=<that trip id>` and has no link,
  then the outcome is exactly today's (`not_linked`, `fallback: "trip_password"`). No Telegram API
  call is made.
- **AC-2** Given the switch is ON, the trip has exactly one open group binding (negative
  `chat_id`, `closed_at IS NULL`), and `getChatMember(chat_id, user)` answers an active status, when
  a person with no link launches with `startapp=<trip id>`, then the outcome is
  `{ kind: "claim", tripId, travellers: [...] }`.
  - An **active status** is `creator`, `administrator` or `member`, or `restricted` with
    `is_member: true`. That is the same rule as `isActiveMemberReply`, `server/server.js:136-139`.
  - **`travellers`** lists display names and opaque claim ids only: no username, no role, no
    contact details.
- **AC-3** Given AC-2's state, when any of the following is true, then the person gets the same
  response as AC-1 (byte-identical body and status), and nothing is written:
  - they are not in the group;
  - the trip does not exist, or is retired;
  - the trip has no open group binding, or more than one;
  - the Telegram API errors or times out.
- **AC-4** The travellers offered in AC-2 are the trip site's participants, minus:
  - anyone who is an organizer or owner, on the site or in `trip_memberships`;
  - anyone already claimed, or already holding a control-plane account mapped to them through a
    redeemed invite or a claim (see Contracts).

  An organizer's name is never claimable.
- **AC-5** Given AC-2, when the person claims a traveller with fresh initData (age ≤
  `LINK_MAX_AUTH_AGE_SECONDS`), then one transaction:
  1. re-checks the group live and re-checks that the traveller is unclaimed (`FOR UPDATE`);
  2. creates a `users` row, unless that traveller already maps to an account;
  3. writes a `trip_memberships` row with `role = 'member'`, `runtime_access = true` and
     `dashboard_access = false`;
  4. writes a `trip_participant_claims` row;
  5. writes a `telegram_member_links` row with `verified_via = 'mini_app_group_membership'`;
  6. mints a scoped session, exactly as a linked launch does.

  A second claim of the same traveller, concurrent or later, gets `409 ALREADY_CLAIMED` and
  writes nothing.
- **AC-6** Given a link with `verified_via = 'mini_app_group_membership'`, on every later launch
  the group is re-checked before a session is minted.
  - **Not in the group:** the link and its claim are revoked (`revoked_reason = 'left_group'`)
    and the person gets AC-1's answer.
  - **Telegram unreachable:** no session is minted and nothing is revoked. The answer is a
    retryable error that does not name the trip.
  - **Already-open sessions:** `/internal/runtime-sessions/check` treats a revoked link exactly
    as an Unlink today (`sessionMayOpenTrip`).
- **AC-7** A claim enqueues one notice to the organizers' own Telegram chats, in the trip
  language: "<Telegram first name> signed in as <traveller> from the trip group". Organizer
  settings → Signing in lists each claim: traveller, Telegram first name and @username if any,
  date. Release ends the claim, revokes the link and ends sessions it minted, and makes the
  traveller claimable again.
- **AC-8** A claim never yields a role other than `member`, whatever the traveller's role on the
  site says. A traveller whose site role is not in `ROLE_RANK` is not offered (fail-safe).
- **AC-9** Nothing logs an initData string, a Telegram id or its digest, a chat id or a claim id
  in plaintext. The same rule as the header of `telegram-mini-app.ts`.

### S2: a personal invite for an existing traveller

- **AC-10** An organizer can create a site invite whose `runtime_username` is an **existing**
  participant. Redeeming it adopts that participant rather than creating a new one (the runtime
  adapter answers success for an existing participant with the same invite id). A redeemed invite
  for an existing traveller makes them a mapped account for AC-4.
- **AC-11** Organizer settings → Signing in shows "Send a personal invite" per traveller. It
  produces the link and a forwardable message in Hebrew and English. It replaces nothing: the
  trip-site one-time link stays beside it.
- **AC-12** The companion can request the same link for a named traveller only when the
  organizer asks for it, through an organizer-scoped tool (`organizerOrAgentRequired`, never
  `authRequired`). It returns the link to the organizer's own chat, never to a group.
- **AC-13** Redeeming with Google signs in through the dashboard origin's existing Google
  client. No per-trip Google configuration is read or needed.

### S3: "Send me a sign-in link" (#614)

- **AC-14** `POST /v1/auth/sign-in-link` takes an email address, or a trip plus a traveller
  name. It answers `202` with the same body in every case: account found or not, channel found or
  not, rate-limited or not.
- **AC-15** When an account exists, a single-use link (30 minutes, stored as a digest) goes to:
  - its linked Telegram private chat, if one exists; else
  - its verified email address, if one exists; else
  - nowhere.

  Opening it creates a portal session and offers to set a new password.
- **AC-16** Rate limits: per IP, per target account and per channel. Exceeding them is silent,
  as AC-14 says.
- **AC-17** A trip-site-only traveller, with no control-plane account, is told on the trip
  site's login screen to "open the trip from the Telegram group, or ask the organizer for a
  personal invite". The trip site sends nothing itself.

## Contracts

**Migration**, `control-plane/db/migrations/<YYYYMMDDHHMMSS>_member_group_sign_in.sql`, starting
`-- rollback: compatible — new table and a widened CHECK; the previous release never reads either`:

- widen `telegram_member_links_verified_via_check` with `'mini_app_group_membership'`;
- new `control_plane.trip_participant_claims`:
  - columns `id`, `trip_id`, `user_id`, `runtime_username`, `via` (CHECK:
    `'group_membership' | 'invite'`), `created_at`, `released_at`, `released_reason`;
  - a unique index on `(trip_id, runtime_username) WHERE released_at IS NULL`.
- Write the rollback paragraph as `20261020120000_telegram_mini_app_sign_in.sql` does:
  - say what a row is worth;
  - say why a release is a column and not a move. A previous release that ignores claims has
    no claim-based access to keep alive: its exchange reads `site_invites` alone. Verify that
    against the code, and if it is not true, use the move pattern instead.

**Control plane (`control-plane/api/src/`)**

- **`telegram-mini-app.ts`:**
  - a new outcome `claim`;
  - `resolveMiniAppLaunch` gains the switch-gated group path (AC-1–AC-3);
  - a new `claimTravellerInTx` (AC-5);
  - per-launch re-check for group links (AC-6);
  - the maps at `:360` and `:601` gain the new `verified_via`.
- **`telegram-group-membership.ts` (new):**
  - `activeGroupMember(chatId, telegramUserId)`, using the relay's bot token (the bot that is in
    the group). If the Mini App's bot is a different one, use the token of the bot bound to that
    binding.
  - It has a timeout and never throws. Any doubt answers `false`, or `unknown` for AC-6.
  - Mirror `isActiveMemberReply`.
- **`portal.ts`:**
  - the runtime launch exchange (`:1885-1893`) reads `runtime_username` from an active
    `trip_participant_claims` row first, then from redeemed `site_invites`;
  - new routes for the claim (`POST /v1/mini-app/claim`), the claims list and release
    (`GET/DELETE /v1/trips/:id/member-claims`, organizer only), and S3's
    `POST /v1/auth/sign-in-link` plus its redemption.
- **`RuntimeAccountAdapter`:**
  - add `listParticipants(tripId)`, which returns username, display name and role. It needs a new
    runtime-gateway route, `GET /internal/t/:tripId/participants`, behind the same key as the
    existing `participantExists`.
  - make `provisionParticipant` idempotent for an existing participant (S2).
- **Feature switch:** add `member_group_sign_in` to `shared/feature-switches.js` with surfaces
  `['control_plane']` and `memberVisible: false`.

**Trip web (`trip-web/src/`)**

- the Mini App claim screen: name list, confirm, Hebrew and English;
- Organizer settings → Signing in: the claims list with Release (S1), and "Send a personal
  invite" (S2);
- the trip site's login screen gets AC-17's line;
- run `npm run build`, because `main` tracks `site/modern`.

**Trip site (`server/server.js`)**

- the internal participants list for the gateway;
- the existing auth routes stay unchanged.

**Companion (S2):** one organizer-scoped tool on the companion's control MCP. Name it in the PR;
it does not exist today.

## Non-goals

- **The Telegram Login widget on trip sites.** It stays ruled out (Dror, 2026-08-28). This spec
  uses the Mini App, which is a different mechanism.
- **Making the dashboard the only account system** and retiring trip-site passwords. That is
  the one-origin work: `docs/specs/sprint-8/x-one-origin-*.md`, unscheduled and to be re-specced.
- **Per-trip Google configuration.**
- **Children's accounts and shared family devices.** A child without Telegram is reached by S2,
  through a parent's device.
- **Organizer sign-in.** It is unchanged.

## Security and boundary notes

- **This changes who can open a trip.** With S1 on, anyone the organizer admits to the group can
  open the trip as a member. Dror accepted this (D1). It is the reason the switch exists.
- **The CHAT'S TRIP only SELECTS** (`telegram-mini-app.ts` header). `start_param` still only
  names a trip. The grant comes from the live `getChatMember` answer for the trip's own open
  binding, which the person cannot choose.
- **`ROLE_RANK` stays an allow-list.** A claim writes only `member` (AC-8).
- **Unknown resolves to the most restrictive answer.** That covers the switch, Telegram and the
  binding count (AC-1, AC-3, AC-6).
- **A refusal never confirms a guess** (AC-3, AC-14).
- **The switch-registry rule.** It says "a switch never widens visibility or permission"
  (`shared/feature-switches.js` header). This switch gates a new way in, which is a permission
  path. The registry header gains a recorded exception for sign-in paths (D3), in the same PR as the
  switch.
- **`boundary-reviewer` before merge**, with live request/response evidence for AC-1, AC-3,
  AC-5 (double claim), AC-6 (leave the group, then relaunch) and AC-14.

## Test plan

Write the tests first, from the ACs.

- **Database:** use your own `cptest_<name>` database. Never remove or recreate a shared
  container (CLAUDE.md hard rule 7).
- **New suites:**
  - `control-plane/api/test/telegram-member-group-sign-in.test.ts` covers AC-1–AC-9 against
    Postgres;
  - `control-plane/api/test/member-claims-routes.test.ts` covers AC-7;
  - `control-plane/api/test/site-invite-existing-traveller.test.ts` covers AC-10–AC-13;
  - `control-plane/api/test/sign-in-link.test.ts` covers AC-14–AC-16.
- **`control-plane/api/tools/fake-telegram.ts`** gains `getChatMember` with every status
  (`member`, `left`, `kicked`, `restricted` with and without `is_member`), plus an error and a
  timeout.
- **`trip-web`:** the claim screen, the claims list with Release, and the invite button.
  `tests/` covers the trip site's participants route and AC-17.
- **Run** `scripts/preflight-deploy.sh` (default mode) before handing back.
- **Manual check on staging** (Dror):
  - launch from a group as a seeded traveller: claim, then reopen;
  - leave the group, then reopen;
  - release a claim;
  - use a personal invite with Google;
  - "Send me a sign-in link" to Telegram.

## Rollout and regression

- **A regression plan is required:** migration, auth and boundary paths.
- The switch ships OFF everywhere.
- **Order:** turn it on for one staging trip, then for one real trip at `ready_private` (with
  approval: it is a deploy under hard rule 2), then as the default for new trips.
- Live trips feel nothing until the switch is on for them. S2 and S3 add routes and buttons,
  but no existing route changes.

## Decisions (Dror, 2026-11-19)

- **D1, from Q1: yes.** Being in the trip's Telegram group, plus picking an unclaimed traveller,
  is enough to open the trip as a member (S1). The personal invite (S2) must stay a full way in
  for anyone who does not want to be on Telegram. It is not a fallback to be dropped later.
- **D2, from Q2: someone in the group who is not on the traveller list is told to ask the
  organizer, and nothing is created.**
  - If the organizer then sends that person a personal invite, it works.
  - This is today's site-invite path, which adds a new traveller.
  - S2 must keep that path working beside the new "invite an existing traveller" path.
- **D3, from Q3: a recorded exception.**
  - Add a paragraph to the header of `shared/feature-switches.js`: a switch may gate a new
    sign-in path, as long as it never changes an allow-list, a role or a visibility rule. Cite
    this spec.
  - `member_group_sign_in` is the first switch to use it.
- **D4, from Q4: no organizer approval per claim.** The notice (AC-7) and Release are the
  control.

## Amendments (Dror, 2026-11-20, after two boundary-review rounds on S1)

Each was found with live request/response evidence while S1's server half was built. Where one
contradicts the text above, the amendment wins.

- **A1: a claim binds the site, and every way a claim ends unbinds it.**
  - The claim binds the new account to the *existing* trip-site participant before it commits
    (an adopt route on the site, forwarded by the runtime gateway, internal key only). Without
    it the site refuses the session exchange with `IDENTITY_MISMATCH`.
  - Adopt never creates a participant, never changes a role, password or data, and never
    displaces an owner, organizer or invite-bound binding.
  - Release, leaving the group, Unlink and member removal remove the binding.
  - S2's invite for an existing traveller (AC-10) reuses this pair.
- **A2: a session from a group claim cannot set a password or link Google on the trip site.**
  - Otherwise a claimant sets the traveller's password, logs in directly, and holds a 30-day
    site token that Release cannot end, which defeats D4.
  - This narrows "the trip-site routes stay exactly as they are": they stay as they are for
    every session that exists today. A claimed member who wants a password uses S2.
- **A3: leaving the group ends existing access, not only the next Mini App launch.** This
  extends AC-6.
  - Minting a trip launch from a group-link session re-checks the group live.
  - The session liveness check re-asks Telegram at most once per 10 minutes per link.
  - Telegram unreachable: no new launch, nothing revoked, and an open session stays live until
    the next check. An outage must not sign a whole family out.
- **A4: switching `member_group_sign_in` off closes existing group-claim access too.** The
  links are dormant, not revoked: no launch, not live, no Telegram call. They work again when
  the switch is back on.
- **A5: the claims list stays in the trip site's Organizer settings**, as written above. The
  runtime gateway forwards the list and Release to the control plane
  (`/t/:tripId/__member-claims`), because `trip-web` talks only to the trip site and the trip
  site has no way to call the control plane. The gateway passes only the user, trip and session
  from its own sealed cookie, and the control plane re-decides that the caller is an organizer
  of that trip. Opened on the trip site's own hostname, the list does not render.
- **A6: whether a pending personal invite reserves its traveller from group claims is decided
  in S2.** Today only a redeemed invite does (AC-4).
- **A7: the group check uses the relay's bot**, the one that sits in the trip groups. It never
  falls back to the Mini App's token.

## Amendments (Dror, 2026-11-21 and 2026-11-22, while S2 and S3 were built)

- **A8: AC-12 is a bot command, not a companion tool.**
  - An organizer sends `/invite <traveller name>` in their own private chat with the bot, and
    the bot replies there with the link.
  - The companion's control MCP knows only which profile is calling. It cannot tell who typed,
    or whether the turn came from the group or a private chat, so a tool there cannot prove an
    organizer asked. The relay reads the sender off Telegram's own update.
  - The companion's part is to tell an organizer to use the command.
  - This is a relay behaviour change, so the merge needs a regression plan.
- **A9: an invited member's session cannot set a trip-site password or link Google**, the same
  rule as A2.
  - Redeeming the invite already gives the person a portal login, which removal ends.
  - Otherwise a removed person keeps a site password and a 30-day site token on the
    traveller's account.
  - **Removing an invited member revokes the assistant connections made under that binding.**
    Invited members keep the assistant while they are members; a claimed session still cannot
    use it.
- **A10: invite versus claim.** This settles A6.
  - A pending personal invite reserves its traveller from group claims. Revoking it, or its
    expiry, frees the name.
  - An invite for a traveller who is claimed from the group is refused, and the organizer is
    told to release that sign-in first.
  - Redeeming never answers a raw error. An owner or organizer of the trip cannot redeem a
    member invite.
  - Removing an invited member ends their trip-site binding and frees the name.
- **A11: the invite path was never "add a new traveller".** D2 and AC-10 describe today's site
  invite as adding one. The code already required the traveller to exist on the trip site
  before an invite could be made, and still does: a new traveller is added on the site first,
  then invited.
- **A12: personal invites are not gated by `member_group_sign_in`** (D1: the invite is a full
  way in for people not on Telegram).

## Amendments (Dror, 2026-11-22, after the reviews of S2 and S3)

- **A13: a secondary organizer's session cannot set a trip-site password or link Google**, the
  same rule as A2 and A9. A removed secondary organizer could otherwise still log in on the
  trip's own hostname and read the trip at member level. The owner's session and plain
  organizer logins are unchanged.
- **A14: an invited session sees and manages only the assistant connections it approved.**
  The traveller's own login still sees and can disconnect every connection under their name.
- **A15: an invited session gets the same restricted view of the traveller's record as a
  claimed session:** no Google identity, no Telegram id.
- **A16: a new sign-in-link request does not cancel an earlier link that is still valid.**
  Otherwise anyone who knows a traveller's name or address can keep killing the link the
  traveller just asked for.
- **A17: S3 stays narrow.**
  - Telegram delivery reaches accounts made by a group claim or holding a Telegram identity.
  - Email delivery reaches accounts holding a Google identity, at the address typed in the
    request.
  - A member who joined by invite or trip password and has neither gets nothing from S3. A
    member with a password email already has the existing forgot-password route.
  - Organizers are never sent a link.
- **A18: S3 ships behind its own switch, `member_sign_in_link`.**
  - The trip-plus-name door needs it on for that trip.
  - The email door and the "Send me a sign-in link" control need it on for every trip.
  - A group claimant's link is also held to A3 and A4.
- **A19: deploying A9 and A13 changes behaviour for people who are already invited or already
  secondary organizers.** They can no longer set or change a trip-site password or link Google.
  Passwords and assistant connections made before the deploy are not touched.

## Open questions (answered, kept for the record)

Answered in Decisions D1–D4 above.

- **Q1 (blocks S1).** May being in the trip's Telegram group be enough to open the trip as a
  member, once the person picks a name that nobody has claimed?
  - If yes: anyone the organizer adds to the group can see the trip, including PINs and booking
    details, which members see by design.
  - If no: drop S1, and S2 becomes the main path.
- **Q2.** What should happen when someone in the group is not on the traveller list (a
  grandparent, a friend)?
  - Recommended: they are told to ask the organizer, and nothing is created.
  - Alternative: they are offered "Join as a guest". That needs a new role and is not in this
    spec.
- **Q3.** How should the switch-registry rule be reconciled (see Security notes)?
  - Recommended: a recorded exception in the registry header for sign-in paths, with this spec
    as the reason.
- **Q4.** Should a claim need the organizer's approval before it opens the trip?
  - Recommended: no; the notice and Release are enough. Each approval would be one more step for
    the organizer, at the moment the family is trying to get in.
