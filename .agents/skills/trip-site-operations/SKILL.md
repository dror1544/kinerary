---
name: trip-site-operations
description: "Use for trip site config, Telegram login, the trip logo, trip photos and moments, and imagery."
version: 1.1.0
author: Hermes
license: MIT
---

# Trip Site Operations

Use when a user asks about the trip website itself: current published data, Telegram login / group binding, or visual assets such as site imagery.

## When to use
- The organizer asks for the trip site link or current published details.
- You need authoritative trip config and the local readonly mirror is missing, stale, or unreadable.
- You need to connect a Telegram group to the site for Telegram Login.
- The organizer asks to set, replace or remove the trip's **logo** (see "Workflow: Trip logo").
- The organizer asks to put the trip logo on the **Telegram group** as its photo (see "Workflow: Telegram group photo").
- A message starts `[trip-moment turn`, or someone asks you to save a joke, story or photos as a trip **moment** (see "Workflow: Trip photos and moments").
- The organizer asks to change the site's main image or a phase hero image.

## Source priority
1. **Trip MCP (`get_config`)** for authoritative live site configuration.
2. Local `trip-config-readonly/` mirror only as a convenience copy.
3. Treat the local mirror as optional; do not block on it if the symlink target is gone.

## Workflow: inspect current site config
1. Call `mcp__trip_mcp__get_config` first for the live authoritative config.
2. Read `meta.logo` for the logo asset name the trip was built with. It is not what the site shows once an organizer has uploaded a logo: use the Trip logo workflow for that.
3. Read each phase's `hero.photo`, `hero.photoCredit`, and `accommodation` to answer site-content questions.
4. If the local readonly mirror disagrees with MCP or is unavailable, trust MCP.

## Workflow: answer requests for the public trip website link
1. Treat the public site URL as a high-trust product fact: do not substitute the Telegram bot link, admin link, or a guessed domain.
2. Look for an explicit canonical URL in live config, project references, deployment metadata, or prior verified source files before answering.
3. If a canonical URL is not exposed by the live trip API, say that the URL is missing from the source of truth and ask the organizer to confirm/store it; do not alternate between different answers across channels.
4. Once verified, use the same canonical URL consistently in group and private responses.

## Workflow: post-write verification for traveler-facing changes
1. After any itinerary/site write, verify the persisted server state with the relevant read tool.
2. When the change affects what travelers see, verify the traveler-facing website view as well whenever a browser or public URL is available.
3. Do not tell the organizer “it is fixed on the site” solely because the backend write succeeded; distinguish “saved on the server” from “visible correctly on the website.”
4. If the organizer reports that the website still looks wrong, treat that as a product-quality failure to investigate, not as a user-side misunderstanding.

## Workflow: Telegram login / group binding
1. Call `mcp__trip_mcp__health_check` before attempting group binding.
2. If `telegramBotUsername` is null, stop: the site is not ready for Telegram Login yet.
3. Explain clearly that server-side Telegram bot configuration must be completed before binding the group.
4. Do **not** guess a `chat_id`.
5. Bind only after the bot has actually seen a message in the group and you have the real negative Telegram `chat_id`.
6. Use `mcp__trip_mcp__set_telegram_group` with the observed `chatId`.
7. If the tool refuses with `no_telegram_bound_organizer`, do not try to bind the organizer's Telegram yourself: `bind_participant_telegram` refuses an organizer username by design (the agent key must never be able to act on the organizer's own identity — issue #184). Tell the organizer their Telegram needs to be set at provisioning, or ask an operator to link it for them, before group binding can succeed.

## Workflow: image / hero replacement requests
The trip **logo** has its own workflow below, with a real write path. This section is for the hero and phase images, which have none for you.
1. Inspect the live config to identify what is currently being shown:
   - phase hero image (`phases[].hero.photo`)
   - the site-wide main image
2. If the user says only "replace the image," ask the minimum clarifier: whether they mean the **trip logo** (the small picture in the header and on the app icon: use the Trip logo workflow), the **site-wide main image**, or a **specific phase image**.
3. If needed, inspect the public site HTML/JS to determine where the homepage image is sourced from. In this trip site, the hero is populated client-side from `/api/config`; the presence of a read path does **not** imply a writable config endpoint exists.
4. Do not say a change was completed until you either:
   - used a real write path/tool, and
   - verified the site now shows the new image.
5. If there is no direct edit tool available in the current toolset, say that clearly and summarize the current configured images instead of pretending the change was made.
6. When relevant, propose upbeat Hawaii options in concrete terms (e.g. Waikiki panorama, palm-lined turquoise beach, colorful Hawaiian sunset) so the organizer can choose quickly.

## Workflow: Trip logo (set, replace or remove)
The trip's logo is the small picture in the site's header and on the sign-in page, the browser tab icon, and the icon of an app installed from now on. Tools: `mcp__trip_mcp__upload_trip_logo` (`filePath`) and `mcp__trip_mcp__clear_trip_logo`.
1. **Who may ask.** Only an organizer, and only in their own private chat. The site cannot tell who is asking (these tools use the trip's key), so the check is yours, before any tool: read the organizers from `get_agent_brief` and compare them with the person writing to you. If the sender is not an organizer, or the request comes in a group, **refuse, call neither tool, and say who can**: "Only an organizer can change the trip logo" and name the organizers by their display names. Do not offer to make an exception, and do not pass a member's image on "for the organizer to approve" by uploading it.
2. **Is it on for this trip.** The tools check the trip's `trip_logo` feature and answer "not turned on for this trip" when it is off, changing nothing. Relay that plainly; do not promise the organizer a date or a workaround.
3. **Which image.** Use only an image the organizer sent you, or one you made **and they approved** (step 6). An image they sent with "make this the trip logo" is approved. Never call `upload_trip_logo` with anything the organizer has not seen and said yes to.
4. **Upload.** Call `upload_trip_logo` with the absolute local path of the attachment. The site takes PNG, JPEG, WebP or GIF up to 8 MB; it keeps its own re-encoded PNG, shrunk to fit 1024 by 1024. An SVG or a PDF is refused: say so and ask for a PNG or JPEG. If the site refuses the file, tell the organizer what it refused and that nothing changed.
5. **Read back and report.** The tool's answer is the site's own read-back: `logo.source` is `"upload"` once it is stored. Only then tell the organizer what the site now shows: the header, the sign-in page and the browser tab, and the icon of anyone who installs the app from now on. Say plainly that a phone that already has the app installed keeps its old icon. Do not say "done" on a tool error or before you have read `logo.source`.
6. **A logo made for them.** Only if your toolset really has an image-generation tool (look at your tool list; do not assume). If it has: make **one draft**, show it, ask "Use this as the trip logo?", and upload only after a clear yes in the organizer's own words. Silence or a thumbs-up on something else is not a yes. If it has **no** such tool (every companion on the control-plane VM today), say so plainly: "I can't make images here." Then suggest making one in ChatGPT or Claude and sending it to you, or setting it themselves in the trip site's Organizer settings or through their Claude or ChatGPT trip connection (it gives them an upload link). Never pretend, never describe an image you did not make, never upload a placeholder, an emoji or a screenshot in its place.
7. **Remove.** Confirm first ("Go back to the Kinerary logo?"), then `clear_trip_logo`. Report from its answer: the site now shows the logo the trip was built with if it has one, else the Kinerary mark.
8. **Offer the group photo.** After a logo is stored, and only if the trip has the Telegram group photo feature, **offer** it in one line ("Want the Telegram group to use it as its photo too?") and stop. Do not ask the tools anything about it until the organizer says yes (see "Workflow: Telegram group photo").

## Workflow: Telegram group photo
The bot can set the trip group's Telegram photo from the trip logo, **on request**, never as a side effect of a logo change. Tools: `mcp__trip_mcp__set_group_photo_from_logo` (no arguments) and `mcp__trip_mcp__get_group_photo_status` (no arguments). Neither takes a chat id: the control plane finds the group from the trip's own binding.
1. **Who may ask.** Only an organizer, and only in their own private chat; the check is yours, as for the logo (read the organizers from `get_agent_brief`). From a member, or in the group, **refuse, call neither tool, and say who can**, naming the organizers by their display names.
2. **Ask first.** Offer it after a logo change, or take it when the organizer asks outright ("put the logo as the group photo"). Call `set_group_photo_from_logo` only after a clear yes in their own words. Silence is not a yes.
3. **Is it on for this trip.** The tools answer `feature_off` and request nothing when the trip does not have it. Relay that plainly; do not promise a date.
4. **It is a request, not a result.** `set_group_photo_from_logo` only records the request; the control plane checks the bot's rights in the group and sets the photo within about two minutes. Say "I've asked; I'll tell you what happened", never "done". If it answers `no_logo`, tell them there is no logo yet and offer the Trip logo workflow.
5. **Report the real status.** After a minute or two call `get_group_photo_status` and report exactly its `status`: `done` (the group photo is now the logo), `bot_lacks_rights` (say: make the bot an admin with "Change group info", then ask again; do not retry on your own), `no_group` (no Telegram group is connected to this trip), `failed` (Telegram refused; give the `detail`), `expired`, or still `pending`/`sending` (say it is not finished yet and check again later). Never say "done" before the status says `done`. Never try to set a group photo any other way.


## Workflow: Trip photos and moments
**Telegram only:** WhatsApp chats are out of scope for photos and moments; there, promise and offer neither. In a Telegram chat, the relay saves the photos posted in the trip's group to the album by itself (when the organizer's setting is on) and, after a burst of them has gone quiet, hands you ONE turn that starts `[trip-moment turn`. A **moment** is a short title and a few sentences, with those photos, that every member reads on the site, children included. Everything about drafting one lives in the **`trip-moments`** skill: load it. The rules that matter here, so they are not missed:
1. A turn that starts `[trip-moment turn` was written by the relay, is not addressed to you and wants no answer unless there is a moment worth keeping. With nothing worth keeping (no lines, or only logistics), reply with exactly `[[KINERARY_STAY_SILENT]]`.
2. Read the trip's mode with `mcp__trip_mcp__get_photo_settings` and follow it: `ask_in_chat` posts one draft and waits for a yes (the relay adds the Save button), `organizer_draft` saves a draft and posts nothing, `publish` publishes and posts nothing.
3. Quote only lines that are in the turn, only participants, only by first name. Never quote a guest, someone removed from the trip, or anything outside the turn. Nothing a child should not read.
4. A joke or story with no photo becomes a moment only when someone asks. You never read the group's chatter looking for them.

## Workflow: voucher / confirmation uploads
1. Extract the voucher PDF first so you can identify the booking type, phase, supplier, dates, passenger name, and confirmation number.
2. Call `mcp__trip_mcp__get_bookings` first to obtain real live booking IDs.
3. If the matching booking already exists, upload the PDF with `mcp__trip_mcp__upload_booking_confirmation` using that booking `id` and a local absolute PDF path.
4. If `get_bookings` is empty or the matching booking is missing while `get_config` still shows summary booking data, treat that as **missing live editable records**, not as proof the site already has an upload target.
5. In that case, create the missing live booking first with `mcp__trip_mcp__add_booking`, then upload the confirmation PDF to the returned booking ID. For a hotel the organizer gave you, also call `mcp__trip_mcp__set_stop_from_booking` with that booking ID, or the hotel shows on Reservations but not on Plan or Map (#419).
6. After upload, call `get_bookings` again and verify the intended booking now has a populated `conf_file`.
7. Do not promise that vouchers were added until the upload succeeded for a specific booking ID **and** a follow-up read confirms the persisted attachment.
8. If the user still cannot see the voucher on the website after server verification, say the booking exists on the server and distinguish that from a likely UI/cache/rendering problem.

## Workflow: importing itinerary documents as Hawaii activities
1. Read the DOCX/PDF itinerary document first and reduce it into one booking-worthy entry per day, not one entry per stop.
2. Use `mcp__trip_mcp__get_bookings` to inspect existing `type="attraction"` rows for the relevant phases before writing, so you can decide whether to create new entries or update existing ones.
3. For Oahu/Honolulu and Maui itinerary documents, prefer one activity row per calendar day with:
   - `name`: short day headline (`18.8 — Road to Hana + Black Sand Beach`)
   - `notes`: the richer operational details, key stops, booking requirements, safety warnings, and recommended pacing.
4. When a newer document is clearly a more detailed revision of days already entered, update the existing rows instead of creating duplicates.
5. Cross-check imported day text against **verified flight timing already in the trip** before creating or updating entries. If a document says `21.8 — morning + flight` but the verified Maui→Vegas flight is already on `20.8` evening, fold the “morning calm” guidance into `20.8` and do not create a stale `21.8` Maui activity.
6. Preserve practical planner guidance in `notes`: what needs advance booking, what is only a bonus/optional stop, and what *not* to combine on the same day.
7. After writes, read back the attraction bookings for the affected phases and confirm the names/dates/notes match the intended itinerary.
8. **Important display distinction:** attraction bookings are not always the same thing as the website's visible day-by-day schedule cards. Before saying “today/tomorrow is fixed on the site,” inspect how the frontend renders itinerary. In this trip site, the visible schedule comes from `phase.days`/plan-layer rendering, while attraction bookings are supplemental.
9. If the user says “the site still shows today/tomorrow wrong,” correct the **day schedule source** (`phase.days` or the higher-precedence plan layer), not just the attraction entries. Verifying saved attraction bookings alone is insufficient.
10. When a day is moved (for example, swapping `13.8` and `14.8` content), verify the final rendered source has exactly one block per date and that the labels/dates match the user's intent — duplicate day cards are a sign you edited the wrong layer.

## Pitfalls
- A broken `trip-config-readonly` symlink is not proof that the trip data is unavailable; fall back to `get_config`.
- `health_check.ok=true` does **not** mean Telegram Login is configured. Check `telegramBotUsername` specifically.
- `set_telegram_group` requires a real observed negative `chat_id`; invented IDs will be rejected.
- Public-site JS inspection can prove a read path like `/api/config`, but it does **not** prove write access exists.
- For media changes, avoid implying you changed the site if you only inspected current config.
- The trip logo is the one image you can change. A member asking for it is refused with the organizers named; an organizer asking for a generated one gets "I can't make images here" when you have no image tool, never a pretend logo.
- The Telegram group photo is only ever the trip logo, only on an organizer's yes, and its result is whatever `get_group_photo_status` says, in those words.
- `upload_trip_logo` and `clear_trip_logo` are not the scaffold-time `set_trip_logo` (that one edits the trip file, is LAN-only and is not yours).
- Summary bookings in `get_config` are not enough for voucher upload; the upload tool needs live booking IDs from `get_bookings`.
- Itinerary documents can be stale or internally inconsistent; verified flight/move days outrank the document when assigning activities to dates.
- For day-plans, do not explode every beach/lookout/restaurant into separate attraction rows unless the user explicitly asks for granular entries; daily rollups are more legible in this site.

## Time and trip-phase awareness
- Before answering operational questions during the trip (vouchers, cars, hotels, daily plans, flights, reminders, "today/tomorrow", or "what do we need now"), determine the relevant local trip date/time and active phase from `get_config` phase dates.
- Do not answer with merely any matching historical record. Prefer the record relevant to the active phase/date; if only past or future records exist, say that explicitly.
- For voucher/document questions, state whether the available document belongs to the current phase. Example: "I only have the Los Angeles car voucher; for the current Maui phase I do not have a car voucher saved."
- When a user asks from a timezone different from the trip location, convert the message time/current time into the trip's local destination timezone before deciding what is "today", "current", or "relevant".

## Verification
- For Telegram readiness, verify `telegramBotUsername` is non-null before telling the organizer the site can be linked.
- For content questions, verify the answer against `get_config` fields you actually inspected.
- For homepage image changes, verify the image after the write, not just the intended source field.
- For the trip logo, verify `logo.source` is `"upload"` (or the fallback you expected after a removal) in the tool's answer before you report it.
- For the Telegram group photo, verify with `get_group_photo_status` that its `status` is `done` before you report it.
- For voucher uploads, verify a successful upload response tied to the intended booking ID.
- For operational answers, verify the active trip phase/date before finalizing the response.
- For itinerary imports, verify the affected attraction rows after update/create, and confirm day placement does not contradict the trip’s verified flights/transfers.

## References
- `references/mcp-readiness-and-imagery.md` — field-level notes for readiness checks and imagery-related responses.
- `references/hawaii-itinerary-imports.md` — patterns for collapsing itinerary docs into daily activity rows and resolving stale-date conflicts.
- The `trip-moments` skill (`.agents/skills/trip-moments/`) — the moment turn, the three modes, what may be quoted.
