---
name: trip-site-operations
description: "Use for trip site config, Telegram login, and imagery."
version: 1.0.0
author: Hermes
license: MIT
---

# Trip Site Operations

Use when a user asks about the trip website itself: current published data, Telegram login / group binding, or visual assets such as site imagery.

## When to use
- The organizer asks for the trip site link or current published details.
- You need authoritative trip config and the local readonly mirror is missing, stale, or unreadable.
- You need to connect a Telegram group to the site for Telegram Login.
- The organizer asks to change the site's main image, logo, or a phase hero image.

## Source priority
1. **Trip MCP (`get_config`)** for authoritative live site configuration.
2. Local `trip-config-readonly/` mirror only as a convenience copy.
3. Treat the local mirror as optional; do not block on it if the symlink target is gone.

## Workflow: inspect current site config
1. Call `mcp__trip_mcp__get_config` first for the live authoritative config.
2. Read `meta.logo` for the logo asset name.
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
7. If the tool refuses with missing organizer binding, bind the organizer's Telegram first before retrying.

## Workflow: image / hero replacement requests
1. Inspect the live config to identify what is currently being shown:
   - site-wide logo (`meta.logo`)
   - phase hero image (`phases[].hero.photo`)
2. If the user says only "replace the image," ask the minimum clarifier: whether they mean the **site-wide main image/logo** or a **specific phase image**.
3. If needed, inspect the public site HTML/JS to determine where the homepage image is sourced from. In this trip site, the hero is populated client-side from `/api/config`; the presence of a read path does **not** imply a writable config endpoint exists.
4. Do not say a change was completed until you either:
   - used a real write path/tool, and
   - verified the site now shows the new image.
5. If there is no direct edit tool available in the current toolset, say that clearly and summarize the current configured images instead of pretending the change was made.
6. When relevant, propose upbeat Hawaii options in concrete terms (e.g. Waikiki panorama, palm-lined turquoise beach, colorful Hawaiian sunset) so the organizer can choose quickly.

## Workflow: voucher / confirmation uploads
1. Extract the voucher PDF first so you can identify the booking type, phase, supplier, dates, passenger name, and confirmation number.
2. Call `mcp__trip_mcp__get_bookings` first to obtain real live booking IDs.
3. If the matching booking already exists, upload the PDF with `mcp__trip_mcp__upload_booking_confirmation` using that booking `id` and a local absolute PDF path.
4. If `get_bookings` is empty or the matching booking is missing while `get_config` still shows summary booking data, treat that as **missing live editable records**, not as proof the site already has an upload target.
5. In that case, create the missing live booking first with `mcp__trip_mcp__add_booking`, then upload the confirmation PDF to the returned booking ID.
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
- For voucher uploads, verify a successful upload response tied to the intended booking ID.
- For operational answers, verify the active trip phase/date before finalizing the response.
- For itinerary imports, verify the affected attraction rows after update/create, and confirm day placement does not contradict the trip’s verified flights/transfers.

## References
- `references/mcp-readiness-and-imagery.md` — field-level notes for readiness checks and imagery-related responses.
- `references/hawaii-itinerary-imports.md` — patterns for collapsing itinerary docs into daily activity rows and resolving stale-date conflicts.
