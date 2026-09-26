# Trip assistant experience evaluation — japan-tokyo-hakone-kyoto-osaka-2026 (Nir's family)

**Evaluator:** dev-manager session, by hand, per `.agents/skills/trip-assistant-experience-evaluation/SKILL.md`.
**Window:** full trip history, 2026-09-15 (provisioning) through 2026-09-23 (today). Trip itself runs 2026-09-19 to 2026-10-03 — this evaluation lands mid-trip.
**Sources:** `control_plane.trips`/`telegram_chat_bindings`/`jobs` (control-plane VM, read-only SSH); the companion's own `state.db` (Hermes profile `japantokyohakonekyotoosaka2026`) copied locally, queried, then deleted — no transcript retained; the companion's `MEMORY.md`. Trip site's own `/api/config` requires a member login this evaluation didn't have, so site data is read *through* the companion's confirmations, not directly.
**Not accessible from here:** raw Telegram-side delivery/read receipts; the other four participants' individual identities inside the group chat (see Gap, below).

## 1. Executive score

**3.3 / 5 — a useful baseline service that answers real questions fast, but the two enrichment channels that turn this into "excellent" (document upload, memory) are both effectively non-functional for this family.**

## 2. Scorecard

| Dimension | Weight | Score | Evidence | Owner | Next improvement |
|---|---:|---:|---|---|---|
| Availability & response reliability | 15% | **5** | 21/21 real user messages across 6 active days got a reply, every one within 1–2 minutes (often under 30s). Zero unanswered mentions found. | System | None needed — this is working. |
| Website data completeness & freshness | 20% | **3** | The itinerary itself loaded successfully (via a shared link) and organizer corrections visibly landed on the site (confirmed by the assistant's own "updated on the site, checked" replies). But every attempt to attach real confirmations/vouchers failed — see §4. | System (ingestion) | Fix document upload before crediting this dimension higher. |
| Accuracy & cross-channel consistency | 15% | **3** | The *same* itinerary link failed to open when sent in the private chat (2026-09-16) and succeeded two days later in the group chat (2026-09-18) — the traveler experienced this as "it doesn't work" until he tried a different channel. | System | Investigate why link-reading behaves differently by chat context. |
| Operational value | 20% | **4** | Real, verifiable value: restaurant picks anchored to the actual booked hotel (not generic), a genuine schedule conflict caught and resolved (teamLab Planets at 18:00 vs. a competing plan at 20:xx), weather-driven day replanning for two specific dates, and organizer schedule edits ("breakfast not before 09:00") reflected back into the plan. | System + organizer | Keep this pattern; it's the product working as intended. |
| Family/group experience | 10% | **3** | Tone and Hebrew are natural, concise, practical (one leading recommendation + a fallback, consistently). But every session — private *and* group — carries the same `user_id`; there is no evidence any of the other four listed travelers (Ela, Noa, Maya, Shai) ever messaged the assistant themselves. | Organizer + traveler | Can't fix from outside; worth asking the organizer whether the group is aware they can talk to the bot directly. |
| Learning, enrichment & organizer enablement | 20% | **2** | `MEMORY.md` holds exactly one fact, written on day 1, never updated across 5 more days of conversation containing several learnable preferences. More importantly: **six separate attempts by the organizer to enrich the trip with real documents (4 file uploads in DM, 2 "attach the itinerary" tries in the group) all failed — zero succeeded.** The one itinerary update that *did* work came from a plain-text link, not a document. | System | This is the single highest-leverage fix — see §6. |

**Weighted:** 0.15(5) + 0.20(3) + 0.15(3) + 0.20(4) + 0.10(3) + 0.20(2) = **3.3**

## 3. Value delivered

- Answered specific, time-sensitive questions fast and well: "is there a Uniqlo Tiger store nearby," "which wagyu place is near tonight's hotel," "what's the most accurate forecast for our Tokyo days" — each with a concrete, location-anchored answer, not a generic one.
- Caught a real scheduling conflict (a confirmed 18:00 teamLab Planets entry against a competing plan for the same evening) and proposed a resolution before it became a problem on the ground.
- Took an organizer's schedule correction in plain Hebrew ("breakfast not before 09:00, Skytree around 10:30...") and reflected it into the site's plan, then confirmed it did so.
- Successfully extracted a full day-by-day itinerary (19 Sep – 3 Oct: Tokyo, Hakone, Kyoto, Osaka) from a shared link when every document upload had failed — a real, if roundabout, recovery path.

## 4. Failures / trust risks

- **Document ingestion is 0-for-6 for this family.** 2026-09-16, 10:03–10:14: the organizer sent four different files (three PDFs, one with no readable extension) trying to get his vouchers/detailed itinerary into the system. Every one came back "still can't read this — try another format." He also sent a plain link, which the assistant said "won't open" in that context. He gave up for two days.
- **The same link worked two days later, in a different channel.** 2026-09-18, 07:15, the group chat: the identical `yapantours.com` link the DM had rejected was read successfully and its itinerary extracted. Nothing distinguishes the two attempts except which chat sent them. This reads, to a traveler, as "it's broken" followed by "now it isn't," for no reason they can see.
- **The assistant's own recovery language was good — it just never worked.** Each failed attempt got a specific, actionable ask ("send it again as a PDF or image") rather than a bare "I don't know" — matching the skill's own definition of good behavior. The failure is in the reading, not the conversation.

## 5. Information gaps

- Booking confirmations/vouchers for this trip almost certainly never made it into the trip's structured data — every channel the organizer tried to use for that failed. (Not independently confirmed against the site's own booking records — this evaluation didn't have a member login; inferred from six consecutive ingestion failures and no later successful upload.)
- No evidence of any other participant's direct engagement with the assistant, so the "family experience" score above is really a two-week measurement of one person's experience, not five people's.
- Zero activity from 2026-09-21 onward (2+ days of silence as of this writing, mid-trip). Could mean the trip is going smoothly and nobody needs help — or that something stopped landing. Not distinguishable from the data available here.

## 6. Organizer enablement — top actions, ranked by unlock value

1. **Re-attempt the voucher/confirmation upload now, in the group chat (not DM), as a plain PDF.** The one channel that's proven to work (link-in-group) suggests trying documents there too, rather than repeating what already failed twice in DM.
2. **Ask directly whether other family members know they can message the bot.** Zero evidence they've tried — worth confirming this is a real choice, not a UX dead end for them.
3. **If the trip needs no more day-by-day changes, say so explicitly** — a plan considered "fixed" beyond bookings is exactly what the assistant is designed to respect (per this repo's own decision: already-booked items stay fixed, everything else is open to revision).

## 7. System actions

- **Document/attachment ingestion is the priority fix.** This is not a one-off — it failed for every format this organizer tried, across two channels, on the one real trip using this feature today. Track 1's existing backlog (per `docs/sprint6-tracks.md`) already names related document-intake work (#92 and successors); this live case is concrete evidence for prioritizing it, not a new finding.
- **The DM-vs-group link-reading inconsistency deserves its own look** — same URL, same content, different outcome by channel is exactly the "accuracy and cross-channel consistency" failure class the evaluation skill calls out by name.
- **`MEMORY.md` growing by exactly one line across six days of substantive conversation** is worth a second, structural look once instrumentation exists — is the memory tool underused by design, or is it a capability the profile isn't reaching for?
- This report itself supports the sprint's own point: none of the above needed instrumentation to find. A hand read of six days of real conversation surfaced two concrete, fixable defects and confirmed several real strengths — worth re-running at sprint end on the same trip to see if this delta moved.
