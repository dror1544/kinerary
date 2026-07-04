# Pre-Trip Planning Checklist

A staged template for the human side of trip planning — the bookings, prep,
and coordination that happen *before* you scaffold the website with the
`/create-trip` skill (or `scripts/new-trip.js`). Copy this file into your own
trip's working notes and fill in the placeholders; none of it is read by the
framework itself.

The website's own `tasks[]` (in `trip.config.json`) is for the **shared,
family-visible** checklist — small, dated items everyone can see and check
off in the app. This document is for **your own planning process** as the
organizer: the staged sequence of decisions, and who owns what before any of
it becomes a `tasks[]` entry.

---

## Status Snapshot

Keep a running two-line summary at the top so anyone (including an AI
assistant helping you plan) can see where things stand at a glance:

### ✅ Already Done
- *(e.g. "International flights booked — conf. XXXXXX")*
- *(e.g. "Main accommodation confirmed for the first leg")*

### ⚠️ Not Done (sorted by urgency)
- See Stage 1 below for anything time-sensitive.

---

## Stage 1 — Urgent, Time-Sensitive Bookings ⏰
**Deadline: as soon as possible**
> Anything that sells out weeks or months ahead (popular attractions, ferry
> crossings, ryokan with limited rooms, timed-entry parks) goes here first —
> everything else can wait.

### 1A — Flights
| Leg | Date | People | Notes |
|---|---|---|---|
| *(origin → destination)* | *(date)* | *(who)* | *(status)* |

### 1B — Car Rentals
| Segment | Dates | Size | Notes |
|---|---|---|---|
| *(pickup location)* | *(date range)* | *(vehicle size)* | *(one-way fees, driver age restrictions, etc.)* |

### 1C — Accommodation
List each leg of the trip with a top pick and a budget pick, so the decision
is easy to make later without re-researching:

| Stop | Dates | Nights | Top Pick | Budget Pick |
|---|---|---|---|---|
| *(destination)* | *(dates)* | *(#)* | *(name, ~price/night)* | *(name, ~price/night)* |

### 1D — Attractions to Book Ahead
| Attraction | Book By | Booking Site | Price |
|---|---|---|---|
| *(the one that sells out first — flag it)* | *(date)* | *(url)* | *(price × people)* |

---

## Stage 2 — Group Logistics Prep 🏷️
**Deadline: ~2 weeks before departure**

Anything that needs to be produced and printed/distributed before the trip:
luggage tags, a shared packing list, printed itinerary summaries. If you
want a per-person printable tag, a plain HTML file with print CSS
(`@media print`) plus a QR code (name + phone) works well and needs no
backend.

---

## Stage 3 — Pre-Trip Kickoff 🎬
**Deadline: ~1 week before departure**

If the group is meeting (in person or over video) before departure, this is
a good checkpoint to walk through the itinerary together, assign
last-minute responsibilities, and — if you're using the trivia game — have
everyone submit a question or two about each other for the trip trivia
bank (see `scripts/trivia_agent.py` for AI-assisted question generation).

---

## Stage 4 — Website Setup 🌐
**Deadline: before Stage 3, so it's ready to show**

Run the `/create-trip` skill (or `node scripts/new-trip.js` for the manual
CLI wizard) to scaffold `trips/<your-slug>/`. See `FRAMEWORK.md` for the
full feature list and `.claude/skills/create-trip/SKILL.md` for the
interview-driven path. Deploy per `FRAMEWORK.md`'s Docker Compose section.

---

## Final-Week Checklist ✅

- [ ] Dry-run the website on a phone (not just a laptop)
- [ ] Confirm every `tasks[]` item marked done is *actually* done
- [ ] Print luggage tags / distribute any physical prep
- [ ] Share login credentials with everyone in the group
- [ ] Spot-check weather widget + map render correctly for every phase

---

## Responsibilities Template

Track who owns what outside the shared task list — things that need a
specific person's input rather than a simple checkbox:

| Task | Owner | Status |
|---|---|---|
| *(e.g. "collect restaurant recommendations for city X")* | *(name)* | *(to start / in progress / done)* |

---

## Files & Paths Reference

| Path | Purpose |
|---|---|
| `trips/<slug>/trip.config.json` | This trip's data — the single source of truth |
| `.claude/skills/create-trip/` | Interview-driven scaffolding skill |
| `scripts/new-trip.js` | Manual CLI wizard alternative |
| `scripts/obsidian-to-config.js` | Import an existing Obsidian trip vault |
| `FRAMEWORK.md` | Full architecture + feature reference |
