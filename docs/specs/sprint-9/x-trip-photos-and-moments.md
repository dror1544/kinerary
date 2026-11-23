# Trip photos and trip moments from the chats, Claude and ChatGPT

Status: draft (2026-11-24; decisions 1–3 by Dror, design by the lead, awaiting approval) · Issue: none yet ·
Track: video look · Size: L, built as two PRs (Part A, Part B) · Tier: High
Security path: yes (Part A widens member write access in the trip connector; Part B has the relay keep and
forward group photos nobody addressed to the bot) · Migration: no (trip SQLite columns only) ·
Live-trip behaviour: yes, once the switches are on

## Problem

The family's photos and the stories around them live in the Telegram group and never reach the trip.

- **The relay deliberately ignores a group photo nobody addressed.** `relay/companion-gate.ts` drops it as
  `NOT_ADDRESSED` and keeps documents only ("in a family group [photos] are the family talking"). Unaddressed
  text is kept briefly in `group-context.ts` as context for the next addressed message.
- **The site already has both halves.** It has an album (`POST /api/photos/upload`, any member) and moments
  (`trip_moments`: caption, body, date, phase, `photo_id`, `draft|published`, routes in
  `server/living-journey.js`). Nothing in a chat writes to either.
- **The companion MCP** (`mcp/mcp.js`) has `add_photo` but no moment tools.
- **The trip connector** (`server/trip-mcp/tools.js`) has neither, and members are read-only there.

## Decisions (Dror, 2026-11-24)

1. **Group photos are saved automatically**, per trip, **on by default**, and an organizer can turn it off.
   Asking ("@bot save this", "save the last photos") works whether it is on or off.
2. **What happens to a drafted moment is an organizer preference**, one of three:
   `ask_in_chat` (the bot asks the chat, then publishes on a yes), `organizer_draft` (a draft on the site for an
   organizer to publish), or `publish` (straight to the site). The bot acts on the setting.
3. **Through Claude and ChatGPT, every member may add photos and moments.** This matches what the site already
   lets them do. Everything else stays read-only for members.

**Lead's choices inside those decisions, for approval:**

- L1. The default moment mode is `ask_in_chat`, the mode where nothing a person said reaches the site without
  someone in the chat agreeing.
- L2. When automatic saving is first on in a group, the bot says so once, in the group's language: "I save photos
  posted here to the trip album. An organizer can turn this off in the trip settings." It says it again after an
  organizer turns it back on.
- L3. A joke or story with no photo becomes a moment **when someone asks** ("@bot save that as a trip moment").
  The bot does not read the group's chatter looking for jokes. A moment drafted for a burst of photos may quote
  the lines around those photos, because that is the context the request is about.
- L4. Quoted lines are attributed by first name. A line from someone who has since been removed from the trip is
  not quoted.

## Behaviour

**Part A: site, companion MCP, trip connector (no relay change)**

- **Organizer settings** gains "Trip photos from the chat": "Save photos posted in the group" (on/off, default
  on) and "New trip moments" (Ask in the chat · Save as a draft for organizers · Publish straight away, default
  Ask in the chat). Both are stored in `trip_settings`.
- **Moments carry more than one photo** and say where they came from (`source`: `site`, `chat`, `connector`).
- **The companion MCP gains** `add_moment`, `list_moments`, `update_moment`, `delete_moment` and
  `get_photo_settings`. `add_photo` gains `source` and the original sender, so the album shows who took the
  photo, not the bot.
- **The trip connector gains** for every member: `add_moment`, `list_moments`, and `get_photo_upload_link`, an
  upload page for one or more photos with an optional moment caption. For organizers it also gains
  `update_moment`, `delete_moment` and `publish_moment`. A member may edit or delete only their own moments,
  the same rule as the site.

**Part B: the relay and the companion**

- **Automatic saving.** With the switch on and the trip's setting on, every photo posted in the trip's group goes
  to the album. That includes a photo in an album (media group) and a photo sent as a file. It is attributed to
  its sender and stored in the phase of the day it was sent. The relay already downloads it (`normalizeUpdate`),
  and now forwards it to the site through the runtime gateway (per-trip key) instead of dropping it. No model
  turn happens for the save itself.
- **On request**, whether automatic saving is on or off:
  - **In a group:** "@bot save this" in reply to a photo, or "save the last photos". The relay keeps references to
    the group's photos from the last 30 minutes, the way `pending-attachments.ts` keeps documents. A request
    after the window is answered honestly ("I can only reach photos from the last half hour").
  - **In a DM:** a photo with "save this to the trip" is saved, attributed to the sender. A photo in a DM with no
    words is answered with one question ("Add it to the trip album?") rather than saved silently.
- **A moment per burst.** When photos were saved (automatically or on request) and the group has then been quiet
  about them for 5 minutes, the relay gives the companion **one** system turn. The turn carries the photo ids,
  their senders, and the group-context lines around them (the lines `group-context.ts` already holds). The
  companion drafts at most one moment: a short title and a few sentences, the joke kept as said. It then acts
  on the trip's mode:
  - `ask_in_chat`: one message with the draft and a "Save" button; words work too ("yes", "save it", "change
    the title to …"). It is published on a yes. With no answer within a day, it is dropped.
  - `organizer_draft`: saved as a draft and nothing posted in the chat.
  - `publish`: published, and nothing posted in the chat.

  When the photos carry nothing worth a moment (no lines around them, or only logistics), the companion stays
  silent (the existing silence sentinel) and drafts nothing.
- **A joke or story with no photo** becomes a moment on request (L3), through the same mode.
- **In a DM**, the person can ask for a moment directly. The draft is shown to them and then follows the mode
  (`ask_in_chat` means asking them).

## Acceptance criteria

Part A
- AC-1 Given a new trip, then `GET /api/settings` returns `group_photo_autosave: true` and
  `moment_capture_mode: 'ask_in_chat'`. An organizer can change both, and a member's PATCH is 403.
- AC-2 Given an unknown `moment_capture_mode` in storage or in a request, then it reads as `organizer_draft`
  (the most restrictive mode: nothing reaches the chat or the site without an organizer). A request with one
  is answered 400.
- AC-3 Given a moment with several photos, then `GET /api/moments` returns `photo_ids` in order. A member sees
  only published moments and their own drafts, unchanged from today.
- AC-4 Given the companion MCP, then `add_moment` with `photo_ids`, `caption`, `body`, `author` (a participant
  username) and `source: 'chat'` creates the moment in the visibility the caller asks for. `list_moments`,
  `update_moment` and `delete_moment` work through the agent key.
- AC-5 Given the trip connector with a member's grant, then `add_moment`, `list_moments` and
  `get_photo_upload_link` are listed and work. `update_moment` and `delete_moment` succeed on their own moment
  and are refused on another person's. Every other write tool is still absent for a member (the connector's
  tool list for a member differs from today's only by these tools).
- AC-6 Given the photo upload page opened with a member's site session, then it uploads one to 20 images (the
  site's existing limits) attributed to that member. An optional caption makes a moment linking them. The page
  says "done" only after it has read the photos back. With no session it says to sign in.
- AC-7 Given `add_photo` with `source` and `uploaded_for` (a participant username), then the album shows that
  participant as the photo's author.

Part B
- AC-8 Given the switch on, the setting on and a photo posted in the bound group by a participant, then within a
  minute it is in the album, attributed to them, and no model turn happened for it (relay log, no companion
  request).
- AC-9 Given the setting off, then a group photo nobody addressed is not uploaded and not kept past the existing
  media TTL, exactly as today. Given a request ("@bot save this" replying to a photo from the last 30 minutes),
  it is saved.
- AC-10 Given a photo from a Telegram user who is not a trip participant, then it is saved only if automatic
  saving is on. It is attributed to "a guest" with no name, and their lines are never quoted (L4).
- AC-11 Given a burst of photos followed by 5 quiet minutes, then the companion gets exactly one moment turn for
  the burst. In `ask_in_chat` it posts at most one draft message. In `organizer_draft` and `publish` it posts
  nothing in the chat.
- AC-12 Given the first message after automatic saving is on in a group, then the bot posts the L2 notice once.
  It posts it again only after the setting goes off and on.
- AC-13 Given a DM photo with no words, then the bot asks once and saves only on a yes. Given "save this to the
  trip" with it, it saves.
- AC-14 Given the moment turn, then the companion never quotes a line from outside the burst's window, never
  quotes a non-participant, and never writes text a child should not read (the existing "everything on the site
  is seen by children" rule).
- AC-15 Given the site is unreachable when a photo is to be saved, then the relay retries within the media TTL
  and then logs the loss. It never leaves the photo in a queue unbounded.

## Contracts

**Trip SQLite.** `trip_settings` gains `group_photo_autosave INTEGER NOT NULL DEFAULT 1` and
`moment_capture_mode TEXT NOT NULL DEFAULT 'ask_in_chat' CHECK (… IN ('ask_in_chat','organizer_draft','publish'))`.
`trip_moments` gains `source TEXT` and `photo_ids TEXT` (JSON array; `photo_id` stays as the first, for old
readers). `photos` gains `source TEXT`. All use the `ALTER … ADD COLUMN` + try/catch pattern.

**Site routes.** `PATCH /api/settings` takes the two keys (organizer). `/api/moments` takes `photo_ids` and
`source`. There is a new internal route for the relay's photos, reached only through the runtime gateway with
the trip's own key (K2 of `597-per-gateway-and-per-trip-keys.md`), shaped like the gateway's existing
`provisionParticipant` POST: `POST /internal/t/<trip>/photos` carrying the bytes, the sender's Telegram id and
the sent time. The site maps the Telegram id to a participant itself. The relay never names a username.

**Connector access (the security-relevant change).** `server/trip-mcp/tools.js` gets a third tool class for
"member writes that the site already allows a member". These are the moment tools and the photo link, and
nothing else joins the class without a spec. Each one calls the site with the member's own JWT, so the site's
existing per-author checks decide. The connector does not re-implement them.

**Relay.** `companion-gate.ts`: the photo branch of the not-addressed path saves (setting on) or holds a
reference for 30 minutes. A new `photo-burst.ts` handles the 5-minute quiet timer and the single system turn to
the companion, carrying ids and the held context lines. The relay reads the trip's two settings through the
gateway, cached for 60 seconds. The L2 notice is relay-owned text, in English and Hebrew.

**Switches** (`shared/feature-switches.js`): `chat_photos_to_album` (relay, site, companion) gates automatic
saving and the save-on-request path. `trip_moments_capture` (relay, site, companion) gates the burst turn and the
moment tools. Both have `memberVisible: true`, so the organizer settings render.

**Companion skill:** a new `.agents/skills/trip-moments/` skill covering the burst turn, the three modes, L3 and
L4, quoting rules and staying silent. `trip-site-operations` links to it.

## Non-goals

- Reading the group's chatter for jokes with no request and no photo (L3).
- Videos and voice notes. Photos only. A video posted in the group is untouched, as today.
- WhatsApp groups (they follow `625-whatsapp-via-relay.md` once it exists).
- Face recognition, tagging people in photos, or Immich-side albums beyond what `/api/photos/upload` already
  syncs.
- Taking a photo out of the album when it is deleted in Telegram.

## Security and privacy notes

- **Automatic saving is a change to what the bot keeps.** On a trip where it is on, every participant's group
  photo leaves the chat. That is why it is announced in the group (L2), switchable by an organizer, and gated by
  a switch. Turning the switch on for every trip (`--all`) still asks Dror (standing approval).
- **The moment turn is the first time the companion gets a turn nobody asked for.** It carries only lines
  already held for context. Its output is bounded: one draft message at most, or silence.
- **Boundary review:** live request/response for AC-5 (a member's tool list and a refused edit of someone
  else's moment), the gateway's internal photo route with a wrong trip key, and AC-9 (no upload with the
  setting off).

## Test plan

- **Part A:** server tests from AC-1–4 and AC-7, connector tests for AC-5 and AC-6, and a trip-web test for the
  settings row.
- **Part B:** relay unit tests with a fake gateway and a fake clock for AC-8–13 and AC-15, plus a companion eval
  pair for AC-14 (a burst with a joke, a burst with only logistics).
- **Both:** `verifier` criterion by criterion. Part B is relay behaviour, so `regression-planner` writes a plan,
  and Dror tests it on a staging group before the merge.

## Rollout

Part A ships first, switches off. Part B follows. Both are switched on for a staging trip, then for Alsace
(Dec 2–6) if Dror wants it there, then as the default for future trips.
