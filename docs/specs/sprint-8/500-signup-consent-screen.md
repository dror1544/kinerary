# Sign-up privacy choices, the interview's health-and-children question, and a personal settings page

Status: approved 2026-10-30 by Dror (decisions below) · Issue: #500 (with #499's remaining part and #501) · Track: T1 · Size: L · Tier: High
Security path: yes (portal auth routes `/v1/auth/verify-email` and `/v1/auth/google`, a new account-level route, the interview's write path to `intake_versions`) · Migration: yes · Live-trip behaviour: yes (interview; no trip-site change)

Shape: the owner's decision of 2026-10-30 21:08 on #500 and #501. It replaces the
three-box sign-up of the 21:03 comment. Sign-up has **two** boxes, and the
interview asks **one** question:

| | Where | Default | Legal basis (owner) | Issue |
|---|---|---|---|---|
| "I agree to the Terms and the Privacy Policy" | sign-up screen | unticked, **required** | contract | #499 |
| "Let the Kinerary team read my trips to improve the product" | sign-up screen, later personal settings | **ticked**, can be unticked (may later depend on the plan) | legitimate interests, with notice and an opt-out (not consent) | #501 |
| Health needs and children's details | the interview, once, when relevant; or ahead of time in personal settings | none: asked | consent | #500 |

## Problem

- **No acceptance is recorded.** `/privacy` and `/terms` are live (PR #502, on
  `main`; brought into `integration/sprint-8` by PR #503, open on 2026-10-30).
  Nothing asks anyone to accept them, and nothing records who accepted which
  version. The sign-up page (`web/src/pages/SignUpPage.tsx`) has an email field
  and the Google button and nothing else.
- **Accounts are created in four places.** None of them records a choice:
  1. Email sign-up. `POST /v1/auth/verify-email` (`control-plane/api/src/portal.ts:884`)
     creates the account in `consumeSignUpToken` (`portal-email-auth.ts:371`),
     through `resolveOrCreateEmailAccountByDigest`.
  2. Google. `POST /v1/auth/google` (`portal.ts:1136`) creates a new account in
     the sign-in transaction (`resolveOrCreateEmailAccount`, `portal.ts:1196`).
     There is no form in front of it, and it serves sign-in and sign-up alike.
  3. Operator invitation. `inviteOrganizer` (`organizer-invite.ts:355`) creates
     the account. The organizer first arrives in **Telegram** through the deep
     link (`startFromDeepLink`, `chat-router.ts:796`), not through the portal.
  4. A site invite redeemed at `/join` (`POST /v1/site-invites/redeem`) creates
     a **member** account, not an organizer. Members are out of scope (see
     Non-goals).

  The Mini App (`POST /v1/auth/telegram-mini-app`, `portal.ts:972`) creates no
  account: it signs in people who are already linked. The legacy
  `POST /v1/signup` answers 410 whenever the portal is configured (`app.ts:266`).
- **Health details and children's details are stored with nobody asked.** The
  interview collects:
  - `travelers[].age` (`interview.ts:729`). It is optional and model-filled.
  - The `dietary` ticks `nut_allergy`, `gluten_free` and `lactose_free`
    (`interview.ts:863`).
  - `constraints.mobility`, free text (`interview.ts:832`).

  The transformer turns these into `participants[].age` and
  `participants[].needs[]` (`transformer.py:842`, `:987-1040`). The Privacy
  Policy promises (§3) that "we are adding a step that asks the organizer for
  explicit consent the first time a child or a medical or allergy need is
  entered".
- **Evaluation reading has no switch.** Alpha families agreed by message to
  evaluation reading. A new organizer has no way to say no, and the tooling that
  reads trips for evaluation has no flag to honour
  (`.agents/skills/trip-assistant-experience-evaluation/`,
  `.agents/skills/trip-fleet-monitor/fleet-mcp.mjs`).
- **There is no personal settings page.** The portal routes are listed in
  `web/src/App.tsx:47-66`. There is no `/account` or settings page, and
  `AccountShell` is only the frame of the auth pages. The one account-level
  setting today is the name (#438, PR #491). It is asked inline on `/trips` by
  `NamePrompt` (`web/src/components/NamePrompt.tsx`) through
  `POST /v1/account/name` (`portal.ts:1322`).

## Behaviour

**Sign-up (portal).** `/sign-up` shows the two boxes above both ways in, which
are "Email me a link" and the Google button:

- **Box 1** is unticked. It has links to `/terms` and `/privacy`. Neither way in
  can be used until it is ticked: the email button is disabled and the Google
  button is not rendered.
- **Box 2** is ticked. Next to it sits one plain sentence: "On during early
  access. You can turn it off now, or later in Personal settings."
- On the email path, the choices travel with the address. The verify page
  (`VerifyEmailPage.tsx`, where the name and the password are chosen) shows the
  same two boxes again, pre-set to what the person chose on `/sign-up`. The
  account is created only when that page is submitted with box 1 ticked. This is
  the moment the choices are recorded, in the account's own creation
  transaction.
- On the Google path, the choices go in the body of `POST /v1/auth/google`. They
  are recorded in the sign-in transaction, and only when the account has no
  current terms record.

**First visit with no current record (portal).** This covers an existing
organizer, a Google sign-in from `/sign-in` that created an account, and an
invited organizer who later signs in. On the next full sign-in to the dashboard,
before the trip list, they see the same two boxes as a blocking panel.

- Box 2 is ticked, and for an alpha family it also says "You agreed to this
  when you signed up. You can turn it off."
- The dashboard opens once box 1 is ticked.
- This happens once per policy version (see Contracts: versions).

**First visit in Telegram (invited and Telegram-only organizers).**
`startFromDeepLink` starts an interview for an organizer whose account has no
current terms record. The bot then sends the terms line before the first
question, after #438's greeting:

- Links to `/terms` and `/privacy`, with an "I agree" button.
- The evaluation notice, with a "Don't read my trips" button.

Both work in words as well ("I agree", "מסכים", "don't read my trips"). The
interview continues only after agreement. A reply that cannot be read restates
the line with its buttons, and nothing is recorded. This prompt is never sent
into a group, and never into a companion conversation.

**Health needs and children's details (interview).** The trigger is an answer
that would store a *sensitive detail* on a trip whose organizer has not given
permission. A sensitive detail is one of:

- a traveller's age under 18;
- a ticked `nut_allergy`, `gluten_free` or `lactose_free`;
- a non-empty `constraints.mobility`.

Permission is given either ahead of time in personal settings, or for this trip
in this interview. When the trigger fires:

- The rest of the answer is stored. The sensitive parts are held aside in the
  session's working state, never in `answers`.
- The very next thing the bot says is one question, in the interview's
  language, with **Yes** and **No** buttons. It also works in words:
  > You mentioned a child / a health or allergy need. May I keep health needs
  > and children's details for this trip? Saying yes confirms you are the parent
  > or guardian, or have their permission. If not, I'll plan without them.
- **Yes** merges the held parts back into the answer. It records the permission
  for this trip, and later sensitive details on this trip are kept without
  asking again.
- **No** discards the held parts and says so plainly:
  > Understood. I won't keep {Noa's age / the nut allergy}. The trip carries on
  > without it, and you can allow this later in Personal settings.

  It records the refusal for this trip. Later sensitive details on this trip are
  dropped with one short line each, and the question is not asked again on this
  trip.
- The question is **asked once per trip**. When permission was given ahead of
  time in personal settings, it is never asked.

**What "not stored" means**, end to end. For a refused or unanswered detail:

- **Interview.** It never enters `intake_sessions.answers`. It is held only in
  `ui_state`, and is gone when the question is answered, when the session
  closes, or when it expires.
- **Intake.** It never enters an `intake_versions` row. A held detail that is
  still unresolved when the organizer confirms is discarded, and the recap says
  what was left out. `intake_versions` is immutable, so "never written" is the
  only honest version of "not stored".
- **Correction.** `POST /v1/trips/:id/intake/correct` drops the same details
  when the trip has no permission, and names the dropped fields in its response.
- **Trip site.** It is not stored there either. The transformer gets no `age`
  for that traveller and no need entry for that tick, so `trip.config.json` has
  neither. A child is still on the roster by name, family and login, because the
  trip cannot run without the roster. Only the age goes. See open question 3.
- **Not changed.** `shared/needs-schema.js` keeps its fail-safe exactly as it
  is: an unknown need type still defaults to organizer-only, and so does an
  explicit-but-invalid visibility. This item adds no need type and no
  visibility value, and does not touch `sanitizeConfig()` or
  `shared/config-visibility.js`.

**Personal settings page (new, smallest version).** Route `/account`, titled
"Personal settings", linked from the dashboard header for full sessions only.
One card, "Privacy", holds three things:

1. **Terms and Privacy Policy.** Read-only: "Accepted on 31 October 2026
   (version 2026-10-30)", with links.
2. **Switch: "Let the Kinerary team read my trips to improve the product"**,
   showing its current value.
3. **Switch: "I may add travellers' health needs and children's details, and I
   have the right to share them"**, off unless given. When it is on, the
   interview skips the question on every trip.

Each change is one recorded choice. No other account setting moves here (see
Non-goals).

**Evaluation tooling (#501).** A trip is readable for evaluation only while
every one of its owners has evaluation reading on.

- The fleet MCP reports this per trip.
- The evaluation skill refuses a trip that is off, unless the run is fixing a
  fault the organizer reported, or is for security.

**Language.** Every new string exists in English and Hebrew, and Hebrew is
right-to-left.

- **Portal.** The portal has no i18n (`web/index.html:2` hardcodes
  `lang="en"`), so the new component carries both string sets. It picks a
  language with `mailLanguage()` (`AccountShell.tsx:22`) and offers a toggle.
- **Bot.** The strings go into `intake-copy.ts`, which is already bilingual.
- **Wording.** The wording below is a draft for the owner's approval. If the
  English and Hebrew differ, Hebrew wins (owner, #499).

## Acceptance criteria

All of these are testable offline: a unit test, an API test against the test
database, or a web component test. No live run is needed.

- **AC-1** Given the flag is on, when `POST /v1/auth/verify-email` arrives
  without `acceptTerms: true`, then it answers 400 `TERMS_NOT_ACCEPTED`, the
  token is **not** consumed, and no `users` row is created.
- **AC-2** Given a valid token and `acceptTerms: true, evaluationReading: false`,
  when verify-email succeeds, then in the same transaction as the account there
  are two `account_privacy_choices` rows:
  - `terms_privacy`, `true`, with the current policy version and channel
    `portal_email`;
  - `evaluation_reading`, `false`, with the current notice version.

  A forced failure after `consumeSignUpToken` leaves neither the account nor the
  rows.
- **AC-3** Given a Google sign-in that creates a new account with
  `privacy: {acceptTerms: true, evaluationReading: true, policyVersion: <current>}`
  in the body, then both rows are recorded with channel `portal_google`. The
  same body on a sign-in of an account that already has a current terms record
  writes nothing. A body with a stale `policyVersion` writes nothing, and the
  account then answers `needsPrivacyChoices: true`.
- **AC-4** Given a full session whose account has no `terms_privacy` row at the
  current version, then `GET /v1/me` includes `needsPrivacyChoices: true`. Given
  one that has it, the key is absent, so the response is byte-identical to
  today's shape. A Telegram-scoped session never gets the key.
- **AC-5** `POST /v1/account/privacy`:
  - accepts only the documented keys;
  - refuses `acceptTerms: false` (400);
  - refuses a stale `policyVersion` (409 `POLICY_VERSION_STALE`);
  - answers 401 without a session, 403 without a CSRF token or from a foreign
    origin, and 403 for a Telegram-scoped session (class `account`);
  - each accepted change appends exactly one row per choice that changed. A
    repeat of the current value appends nothing.
- **AC-6** Given the dashboard with `needsPrivacyChoices: true`, then the
  blocking panel renders before the trip list:
  - box 1 is unticked, and the submit button is disabled until it is ticked;
  - box 2 is ticked;
  - an account with an `operator_seed` evaluation row shows the alpha note;
  - the panel renders in Hebrew, `dir="rtl"`, when the language is Hebrew.
- **AC-7** Given `/sign-up`, then neither way in is usable until box 1 is
  ticked. Box 2 starts ticked, and unticking it reaches the request body as
  `evaluationReading: false`.
- **AC-8** Given an interview whose organizer has no permission, when a
  `travelers` answer carries `{name: "Noa", age: 9}`, then the stored answer has
  Noa without `age`, `ui_state` holds the age, and the next prompt is the
  permission question. The same holds for a `dietary` answer ticking
  `nut_allergy`, and for `constraints.mobility`.
- **AC-9** Given that pending question, when the organizer taps Yes, or writes
  "yes, I'm her mum", or writes "כן", then the held parts are merged into
  `answers` and a `sensitive_details` row is recorded: `true`, `trip_id` set,
  channel `telegram_interview`. When the organizer taps No or writes "no, leave
  it out", then the held parts are discarded, a `false` row is recorded, and the
  reply names what was not kept.
- **AC-10** Given a reading that fails, is `unclear`, or is below the
  confidence floor, then nothing is recorded, nothing is merged, and the
  question is restated with its buttons. This is fail-closed: an unread reply is
  never a yes.
- **AC-11** Given a trip with a recorded refusal, when a later answer carries a
  sensitive detail, then it is dropped with one short line and the question is
  not asked again. Given an account whose latest settings-level
  `sensitive_details` is `true`, the question is never asked and details are
  kept.
- **AC-12** Given `confirmIntake` with a held detail still unresolved, then the
  confirmed `intake_versions.data` does not contain it, and the recap lists it as
  not kept. Given `correctIntake` on a trip without permission, then the new
  version does not contain ages under 18, the three health ticks or
  `constraints.mobility`, and the 200 response carries
  `droppedForPermission: ["travelers[1].age", …]`.
- **AC-13** Given an intake without those details, then the transformer's
  output has no `age` and no need for them. `shared/needs-schema.js` and
  `tests/config-allow-list.test.js` are unchanged and green.
- **AC-14** Given a deep-link start for an organizer with no current terms
  record, then the terms line is the first thing after the greeting. The
  interview's first question is not asked until agreement, given by button or
  by words. Agreement records `terms_privacy` with channel `telegram_interview`
  and the Telegram account digest.
- **AC-15** Given `/account` with a full session, then it shows the terms
  acceptance date and version and the two switches. Toggling one posts one
  change and re-reads the state. `/account` with a Telegram-scoped session
  shows "sign in with your password or Google to change these", and no
  switches.
- **AC-16** Given a trip with two owners, one with evaluation reading off, then
  the fleet MCP's `list_trips` and `trip_detail` report
  `evaluation_reading: "off"` for it. A trip whose owners all have it on reports
  `"on"`. An owner with no row reports `"off"`, which is fail-safe.
- **AC-17** Given the API constant `LEGAL_POLICY_VERSION`, then a test reads the
  version line of `web/legal/privacy.md` and `web/legal/terms.md` and fails
  naming the file when either differs from the constant.
- **AC-18** Given `PRIVACY_CHOICES_ENABLED` unset, then:
  - verify-email, Google, `/v1/me` and the interview behave exactly as before
    this change: same responses, no rows, no question;
  - the new routes answer 404.

## Contracts

### Migration

`control-plane/db/migrations/20261031090000_account_privacy_choices.sql`

```sql
-- rollback: compatible — adds one new table that only this release reads or writes; no existing table, column or row changes
CREATE TABLE control_plane.account_privacy_choices (
  id                       text PRIMARY KEY,
  user_id                  text NOT NULL REFERENCES control_plane.users(id),
  choice                   text NOT NULL CHECK (choice IN ('terms_privacy', 'evaluation_reading', 'sensitive_details')),
  value                    boolean NOT NULL,
  -- terms_privacy: the legal pages' version (YYYY-MM-DD). evaluation_reading: the notice version ('v1').
  -- sensitive_details: the legal pages' version in force when it was given.
  policy_version           text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 40),
  basis                    text NOT NULL CHECK (basis IN ('contract', 'legitimate_interest', 'consent')),
  channel                  text NOT NULL CHECK (channel IN ('portal_email', 'portal_google', 'portal_first_visit',
                             'portal_settings', 'telegram_interview', 'operator_seed')),
  trip_id                  text REFERENCES control_plane.trips(id),   -- set only for an interview answer
  language                 text CHECK (language IS NULL OR language IN ('en', 'he')),
  telegram_account_digest  text,                                      -- who answered, on a Telegram channel
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (choice <> 'terms_privacy' OR value),                         -- declining the terms is not recorded; it blocks
  CHECK (trip_id IS NULL OR choice = 'sensitive_details')
);
CREATE INDEX account_privacy_choices_latest ON control_plane.account_privacy_choices (user_id, choice, recorded_at DESC);
```

- The table is append-only. The current value of a choice is the newest row
  for (`user_id`, `choice`), plus `trip_id` where it applies. No code path
  issues `UPDATE` or `DELETE` on it, and a test greps `src/` for either.
- There is no backfill. No row means "not asked".
- `migrations.test.ts` lists the ordered file names in two places. Both lists
  are updated in the same commit, and the PR body says so.

### Versions

- `control-plane/api/src/legal-version.ts` exports two constants:
  - `LEGAL_POLICY_VERSION`, the date on the version line of `web/legal/*.md`.
    The live wording is being updated by another session's text-only PR to
    `main`. This item references the version that PR's files carry, and does
    not edit `web/legal/`. AC-17 keeps the two in step.
  - `EVALUATION_NOTICE_PERIOD = "v1"` (a notice version, not a product phase).
- `needsPrivacyChoices` is true when either of these holds:
  - there is no `terms_privacy` row at a version `>= TERMS_REASK_FROM`;
  - there is no `evaluation_reading` row for the current period.
- `TERMS_REASK_FROM` is a separate constant. It is raised only for a material
  change, so that an editorial update does not re-ask everyone. See open
  question 2.
- When the evaluation-reading terms change (for example a plan where reading is
  part of the free tier and the opt-out is a premium feature),
  `EVALUATION_NOTICE_PERIOD` changes and everyone sees the new notice (owner, #501).

### API

The routes are all in `portal.ts` and classified in `portal-scope.ts`.
`assertEveryRouteIsClassified` fails boot otherwise.

| Route | Class | Request | Responses |
|---|---|---|---|
| `POST /v1/auth/verify-email` (changed) | `open` | adds `acceptTerms: true` (required when the flag is on), `evaluationReading: boolean` (required), `language?` | 400 `TERMS_NOT_ACCEPTED` / `INVALID_REQUEST` **before** the token is touched, like `PASSWORD_TOO_SHORT` today; otherwise as today |
| `POST /v1/auth/google` (changed) | `open` | optional `privacy: {acceptTerms, evaluationReading, policyVersion, language?}` | unchanged. Recorded only for an account with no current terms row and a matching version. Never a reason to refuse a sign-in |
| `GET /v1/me` (changed) | `session` | — | adds `needsPrivacyChoices: true` only when true, and never for a scoped session |
| `GET /v1/account/privacy` (new) | `account` | — | `{ policyVersion, termsAcceptedAt, termsVersion, evaluationReading, evaluationSource: "choice" \| "early_access_agreement", sensitiveDetails }` |
| `POST /v1/account/privacy` (new) | `account` | exactly a subset of `{acceptTerms: true, evaluationReading: boolean, sensitiveDetails: boolean, policyVersion, surface: "first_visit" \| "settings", language}`. `policyVersion` is required with `acceptTerms` | 200 with the GET body · 400 `INVALID_REQUEST` · 409 `POLICY_VERSION_STALE` |

- Every route above is `private, no-store` and needs our own Origin, like
  `/v1/account/name`.
- The account is always the session's, never a body field. The channel is
  derived on the server from `surface`.

### Server modules

- **New `control-plane/api/src/privacy-choices.ts`.** It holds all writes to the
  table, the "current value" reads, and `needsPrivacyChoices(userId)`. It also
  exports `tripEvaluationReading(tripId)`, which is fail-safe: off when any
  owner is off or has no row.
- **New `control-plane/api/src/sensitive-details.ts`.** It holds one pure
  predicate set and two functions:
  - `splitSensitive(questionId, answer)` returns `{kept, held}`;
  - `dropSensitive(answers)` returns `{answers, dropped: string[]}`.

  The predicate names the details exactly. `travelers[].age` is sensitive when
  it is a number below 18. `dietary` is sensitive for the option ids
  `nut_allergy`, `gluten_free` and `lactose_free`. `constraints` is sensitive
  for the key `mobility`. There is no model judgement in the predicate.

### Interview

- **Write path.** The interview's two writers of `intake_sessions.answers`
  (`interview.ts:4636` in `submitAnswerVia` and `:4781`) call `splitSensitive`
  when the trip has no permission. Held parts go to `ui_state.sensitive_pending`
  as a list of `{path, value, label}`, and the question becomes the router's
  next prompt. It takes priority over `nextUnansweredQuestion` and is never a
  required intake question, so `deferredRequired` and `INTAKE_SCHEMA_VERSION`
  are untouched.
- **Words.** Replies are read by a new `readPermissionReply` in `interpret.ts`
  on the existing `interpret` task. It adds no new task name, so it needs no new
  `*_RUNNER` line (`interpret.ts:2344-2355`). Output:
  `{intent: "yes" | "no" | "unclear", confidence}`. Only
  `yes && confidence >= 0.8` is a yes, and only `no && confidence >= 0.8` is a
  no.
- **Buttons.** The callback data is new, `sp:y` and `sp:n`, parsed in
  `chat-router.ts` `parseCallbackData`.
- **Backstop.** `confirmIntakeVia` (`interview.ts:4917`) and `correctIntake`
  (`intake-correction.ts:113`) call `dropSensitive` before
  `assertCanonicalRecordSafe` when the trip has no permission. Both producers
  write the same immutable record, so both get the gate.
- **Copy.** New `intake-copy.ts` keys in `en` and `he`:
  - `sensitivePermissionAsk`, `sensitiveKept`, `sensitiveDropped`,
    `sensitiveDroppedAgain`;
  - `termsLine`, `termsAgree`, `evaluationNotice`, `evaluationOff`,
    `termsUnread`;
  - the recap line `notKept`.

### Web

- **New.** `web/src/components/PrivacyChoices.tsx` is the two boxes, bilingual,
  used by `/sign-up`, `/verify-email` and the first-visit panel.
  `web/src/pages/AccountSettingsPage.tsx` is the `/account` page.
- **Changed.**
  - `SignUpPage.tsx`, `VerifyEmailPage.tsx`, `GoogleSignInButton.tsx` (passes
    `privacy`) and `ProductApp.tsx` (the panel before the trip list; header
    link).
  - `App.tsx`: the route, plus the `PageTitle` entry "Personal settings —
    Kinerary".
  - `api.ts`: the `Me` schema, plus `getPrivacy` and `savePrivacy`.
- **Not touched.**
  - `web/nginx.conf`: `/account` is an SPA route under `location /`.
  - `web/legal/**` and `web/public/**`: another session owns the wording.
  - `shared/**`: this keeps it out of a release.

### Tooling (#501)

- `fleet-mcp.mjs` `list_trips` and `trip_detail` gain `evaluation_reading`. It
  is read through a SQL expression equal to `tripEvaluationReading`. The MCP
  stays read-only.
- `trip-assistant-experience-evaluation/SKILL.md` gains a first-step rule:
  - read the flag, and stop on `"off"` unless the run is fixing a fault the
    organizer reported, or is for security;
  - say which one applies in the output.
- Both are repo content with a Hermes profile copy, so they need
  `install-hermes-skill.sh --capture` then a deploy. They are listed in
  `.agents/hermes-sync.tsv` where they already are.

### Configuration

`PRIVACY_CHOICES_ENABLED` (API and relay), default off. When it is off:

- the API behaves as today;
- the new routes 404;
- `GET /v1/auth/capabilities` gains `privacyChoices: true` only when the flag
  is on, so the page knows whether to draw the boxes.

### Operator seed

`scripts/seed-evaluation-notice.py --user <user_id>… [--execute]`. It
inserts `evaluation_reading = true` with basis `legitimate_interest`, channel
`operator_seed` and version `v1`, for the alpha families' accounts. It
prints a plan first and takes ids as arguments: no name or id lives in the
repo (rule 6).

### Wording drafts (for owner approval; Hebrew wins)

| Key | English | עברית |
|---|---|---|
| box 1 | I agree to the [Terms] and the [Privacy Policy]. | אני מסכים/ה ל[תנאי השימוש] ול[מדיניות הפרטיות]. |
| box 2 | Let the Kinerary team read my trips to improve the product. On by default; you can turn it off now or later in Personal settings. | צוות Kinerary רשאי לקרוא את הטיולים שלי כדי לשפר את המוצר. פעיל כברירת מחדל; אפשר לכבות עכשיו או בהמשך בהגדרות האישיות. |
| settings switch | I may add travellers' health needs and children's details, and I have the right to share them. | אני רשאי/ת להוסיף צרכים בריאותיים של מטיילים ופרטים של ילדים, ויש לי הזכות לשתף אותם. |
| interview ask | You mentioned {detail}. May I keep health needs and children's details for this trip? Saying yes confirms you are the parent or guardian, or have their permission. If not, I'll plan without them. | ציינת {detail}. האם לשמור צרכים בריאותיים ופרטי ילדים בטיול הזה? אישור פירושו שאת/ה ההורה או האפוטרופוס, או שיש לך את רשותם. אם לא — אתכנן בלעדיהם. |
| buttons | Yes, keep them · No, leave them out | כן, לשמור · לא, בלי זה |
| declined | Understood. I won't keep {detail}. The trip carries on without it; you can allow this later in Personal settings. | הבנתי — לא אשמור את {detail}. הטיול ממשיך בלעדיו; אפשר לאשר זאת בהמשך בהגדרות האישיות. |

## Non-goals

- **No change to the legal pages.** No change to `web/legal/` or
  `web/public/privacy|terms`, and no Hebrew policy. Another session owns the
  wording, and the Hebrew version is "not urgent" (owner, #499).
- **Members are not asked.** People who join through a site invite (`/join`)
  or a trip-site login get no boxes. They create no trips and enter no
  travellers. See open question 6.
- **Existing data is not deleted.** Data already in confirmed intakes or on
  live sites stays. A switch governs entries from now on. See open question 4.
- **No new dashboard entry for travellers or needs.** The dashboard has none
  today (`ProductApp.tsx:157` collects destination, dates and trip type only),
  and the trip site has no writer for `age` or `needs`
  (`POST /api/agent/participants`, `server/server.js:1202`, takes neither).
  Any future writer must call `splitSensitive` / `dropSensitive`, and this spec
  names that as the contract.
- **Companions are not changed.** Health facts a traveller tells a companion in
  conversation, and companion memory, are out of scope. See open question 7.
- **The settings page holds nothing else.** It does not take over the name
  prompt, account deletion or data export.

## Security and boundary notes

- **Auth routes change.** `verify-email`, `google`, a new `account`-class
  route, and `/v1/me`. That means `boundary-reviewer` with live
  request/response against a test database:
  - refusals for a foreign origin, a missing CSRF token and a scoped session;
  - an extra body key refused, not ignored;
  - verify-email's new refusals land before the token is consumed;
  - a Google `privacy` body cannot write for an account other than the one the
    verified token resolved to.
- **One identity answer.** `resolveOrCreateEmailAccount` /
  `...ByDigest` stays the only place an address becomes a `user_id`.
  `privacy-choices.ts` only ever writes for a `userId` that a caller has
  already resolved, inside that caller's transaction.
- **Fail-safe defaults.** No row is "not given" for `sensitive_details` and
  "off" for evaluation reading in tooling. An unread reply is not a yes.
  `shared/needs-schema.js` is not touched. Its fail-safe still covers anything
  that reaches a site.
- **Scoped sessions.** They cannot change these choices (class `account`). A
  forwarded Mini App session is often not the account owner (`portal-scope.ts`
  header), and evaluation reading opens the owner's trips. See open question 5.
- **Telegram agreement.** It is recorded with the answering Telegram account's
  digest. An interview link can be forwarded and redeemed by someone else's
  Telegram account, so the record says who actually agreed. Open question 5
  asks whether that is enough.
- **Nothing on a trip site changes**, so the site needs no release. `shared/`
  must not appear in the diff. If it does, this becomes a release.

## Test plan

Tests are written first, from the ACs. Suites touched: `control-plane/api` unit
and DB (on its own named test database, never another session's), `web`
vitest, `control-plane/worker` unittest (transformer), `tests/` (unchanged,
must stay green), and `tests/scripts` for the seed script.

- **`control-plane/api/test/privacy-choices-db.test.ts`**:
  - AC-2, AC-3, AC-4, AC-5, AC-16;
  - the append-only grep;
  - two owners, fail-safe.
- **`control-plane/api/test/portal-privacy-routes.test.ts`**:
  - AC-1, AC-5 refusals, AC-18 with the flag off;
  - `assertEveryRouteIsClassified` with the new routes.
- **`control-plane/api/test/sensitive-details.test.ts`** (pure): the predicate
  table, `splitSensitive` and `dropSensitive` on each of the three detail kinds,
  and an age of exactly 18 not held.
- **`control-plane/api/test/interview-sensitive-permission.test.ts`**:
  - AC-8 to AC-12, against the test database with a fake runner;
  - the runner returning `{ok:false}`, `unclear`, 0.79, and a Hebrew yes.
- **`control-plane/api/test/interview-terms-gate.test.ts`**: AC-14, plus a
  seeded (#438) opening still rendered first.
- **`control-plane/api/test/legal-version.test.ts`**: AC-17.
- **`control-plane/api/test/migrations.test.ts`**: both lists updated.
- **`control-plane/worker/tests/test_transformer.py`**: AC-13, an intake
  without age and without the ticks yields no age and no needs.
- **`web/src/components/PrivacyChoices.test.tsx`**: AC-6, AC-7 and Hebrew RTL.
- **`web/src/pages/AccountSettingsPage.test.tsx`**: AC-15.
- **`tests/scripts/test_seed_early_access_evaluation.py`**: the plan output
  without `--execute`, and refusal of a malformed id.
- **Fleet MCP** (`.agents/skills/trip-fleet-monitor` tests): the new field,
  AC-16.
- **Manual, staging.** One phone run in each language: sign-up with the email
  path, a Google sign-up, and an interview with a child and a nut allergy,
  answered once by button and once in words. Record the texts.

## Rollout and regression

**Per-PR regression plan: needed**, for each PR. The change carries a migration
and auth routes, and it changes what the live interview says next.

Three PRs are recommended, in this order, all dark behind
`PRIVACY_CHOICES_ENABLED`:

- **A.** The table, `privacy-choices.ts`, the auth route changes, `/account`,
  the sign-up boxes and the first-visit panel. This is the portal plus the API.
- **B.** `sensitive-details.ts`, the interview question, and the backstop at
  both producers. This is the API plus the relay.
- **C.** The Telegram terms line for invited and Telegram-only organizers, the
  fleet-MCP field, the evaluation-skill rule, and the operator seed.

Who feels it, and when:

- **Portal.** Everyone with an account sees the first-visit panel on their next
  full sign-in after the flag is turned on. Trip sites, companions and groups
  are unaffected.
- **Interview.** Only interviews that start after the relay restarts with the
  flag on. A session already open at the restart meets the question on its
  next sensitive answer. The restart is scheduled off any live conversation
  (`awaiting = 'machine'` recently). The VM's relay restart is a deploy, so
  hard rule 2 applies.
- **Before turning the flag on in production**, run the operator seed for the
  alpha families. Otherwise their trips read as `"off"` to the evaluation
  tooling, which is fail-safe, but it stops evaluation.
- **No trip redeploy and no release.** Nothing under `site/`, `server/` or
  `shared/` changes.

The way back is to turn off the flag and restart. The table stays, unread,
because the migration is additive.

## Decisions (Dror, 2026-10-30)

- **UX guardrail (Dror, 2026-10-30, supersedes the two boxes above): no checkboxes on sign-up.**
  Too many boxes cost sign-ups, and an explicit "are you 18 or older" question makes the site look
  suspicious. The sign-up screen carries one quiet line under the button: "By creating an account you
  agree to the Terms and Privacy Policy. We may read trips to improve Kinerary —
  you can turn this off in Settings." (he/en). Creating the account records, with the policy version:
  terms accepted, evaluation reading on (legitimate interests, notice + opt-out). The age condition
  lives in the Terms text, never as a question. The opt-out lives only in Personal settings. Existing
  accounts see the same one-line notice once (dismissable), not a panel of boxes. Any future consent
  addition must keep the sign-up screen box-free unless Dror decides otherwise.
- **No "early access" in the notice (Dror, 2026-10-31).** Evaluation reading is not tied to a product
  phase: it may come to depend on the business model (for example, read on the free plan, opt-out on
  premium). So no user-facing text names a period, and the stored notice is versioned
  (`EVALUATION_NOTICE_PERIOD = "v1"`), so a later change of terms is a new notice version, not an
  edit of history. Today everyone can opt out; whether the opt-out stays universal is a business-model
  decision outside this item.
- **Health scope: medical only.** Allergies and intolerances (nut, gluten, lactose), mobility, and a
  child's age are asked once in the interview and not stored on a no. Kosher, kosher-style,
  vegetarian and vegan stay ordinary preferences; raised with the legal review.
- **A no for a child drops only the age.** The name, family and login stay (the trip needs its
  roster).
- **Every other open question: the spec's own recommendation**, adopted as Dror's decision —
  only material policy changes re-ask; a "no" for a later
  settings switch governs new entries only (deleting old data stays an email request); a Mini App
  (Telegram-scoped) session may only turn choices off; a Telegram agreement is recorded against the
  link's account together with the Telegram account that agreed; members joining by site invite get
  no box 1 for now; "the kids" with no stated age does not trigger the question; a yes is per trip
  (the settings switch is the ahead-of-time answer); Telegram-only organizers get the one-time terms
  message only at their next interview start, never mid-companion; the #501 evaluation-tooling half
  becomes its own small issue.

## Open questions

None blocking approval; factual checks noted above happen during build.
