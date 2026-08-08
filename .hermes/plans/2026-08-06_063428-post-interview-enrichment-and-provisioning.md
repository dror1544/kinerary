# Post-interview Enrichment and Provisioning Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn a short interview artifact into a complete, verifiable trip site without inventing organizer-owned content, and provision it through configurable Python scripts.

**Architecture:** `driver.mjs generate` remains the interview-to-base-config boundary. A new deterministic Python enrichment layer consumes the generated config, adds sourced operational data and UI-ready derived fields, records provenance and unresolved items, then validates the result. A separate Python deploy layer uses external configuration plus environment-based secrets/keys to provision and verify the LXC → NPM → Cloudflare route.

**Tech Stack:** Node.js generator/verifier; Python 3.11 standard library plus pinned HTTP/config dependencies; Open-Meteo; geocoding provider adapter; source-specific embassy/consulate adapter; Wikimedia/Unsplash verification adapter; Proxmox SSH, NPM and Cloudflare APIs/config.

---

## Confirmed product decisions

- Keep the interview lean. Do not ask for coordinates, weather, emergency numbers, hero media or technical deployment data.
- Default the organizer's consular country to **Israel** for now; add `organizer.home_country` so it can be explicitly chosen later.
- The website displays **the next seven days from now** for each location. It must never substitute climate averages/static historical weather for the live forecast.
- The enrichment step may derive infrastructure data only. It must not invent organizer itinerary content, attractions, bookings, or trivia.
- Trivia remains hidden until the organizer supplies questions.
- Every auto-derived result is stored with provenance and unresolved results are visible as `needs_review` rather than silently omitted.

## Task 1: Define the enriched trip schema

**Files:**
- Create: `schemas/enriched-trip.schema.json`
- Modify: `.agents/skills/create-trip/answers.example.json`
- Modify: `.agents/skills/create-trip/driver.mjs`
- Test: `tests/enrichment/schema.test.mjs`

Add optional `enrichment` fields: source, retrieved_at, confidence, raw/query input, and `needs_review`. Add phase `location`, `hero.credit`, `emergency_contacts`, and hotel `navigation` fields. Preserve user-supplied values and mark generated fields separately.

## Task 2: Implement deterministic enrichment CLI

**Files:**
- Create: `scripts/enrich_trip.py`
- Create: `scripts/enrichment/config.py`
- Create: `scripts/enrichment/models.py`
- Test: `tests/enrichment/test_enrich_trip.py`

Provide `--input`, `--output`, `--dry-run`, `--refresh`, and `--offline-fixture` options. Make results idempotent: unchanged inputs plus unexpired sources produce no semantic diff. Emit an enrichment report listing every resolved field, source, and review item.

## Task 3: Geocoding and hotel navigation

**Files:**
- Create: `scripts/enrichment/geocode.py`
- Test: `tests/enrichment/test_geocode.py`

Resolve phase/hotel address to validated latitude/longitude; retain original query, formatted address, provider ID and confidence. Derive Google Maps and Waze links only from validated coordinates. Ambiguous/no-result locations become `needs_review`.

## Task 4: Always-live seven-day weather

**Files:**
- Create: `scripts/enrichment/weather.py`
- Modify: `site/app.js`
- Test: `tests/enrichment/test_weather.py`, `tests/site/weather-dom.test.mjs`

Use coordinates to fetch the next seven days from Open-Meteo at page/API refresh time. Do not emit climate fallbacks. Render a clear unavailable state when an API lookup fails; never present static weather as forecast.

## Task 5: Emergency and consular contacts

**Files:**
- Create: `scripts/enrichment/emergency.py`
- Create: `scripts/enrichment/consular.py`
- Test: `tests/enrichment/test_emergency.py`

Keep `country-info.js` for unified emergency numbers. Add a source adapter for Israeli embassy/consular representation in visited countries/regions, with official URL, retrieval date, telephone and review marker. Design country selection around `organizer.home_country`, defaulting to `IL`.

## Task 6: Hero discovery and validation

**Files:**
- Create: `scripts/enrichment/hero_media.py`
- Create: `scripts/enrichment/media_sources.py`
- Test: `tests/enrichment/test_hero_media.py`
- Modify: `.agents/skills/create-trip/SKILL.md`

Require a destination-specific `landmark` or `landscape` intent. Verify source page/title, direct image HTTP 200, image MIME type, width/aspect ratio, license, attribution and credit data. Reject generic images and event-only images where a destination landmark/scenic view is required. Never type opaque image URLs from memory.

## Task 7: Derived home/phase content

**Files:**
- Create: `scripts/enrichment/phase_cards.py`
- Modify: `site/app.js`
- Test: `tests/site/phase-cards-dom.test.mjs`

Create phase cards/overview only from verified logistics: destination, dates, hotel, sourced hero, navigation and weather. Do not fabricate attractions; leave an explicit organizer-editable state for missing itinerary content.

## Task 8: UI contract tests

**Files:**
- Modify: `.agents/skills/create-trip/driver.mjs`
- Create: `tests/site/enrichment-dom.test.mjs`

Extend real happy-dom verification to assert every phase has valid title structures; confirmed hotel coordinates render Maps/Waze; forecast container is present; emergency contacts render; hero media includes credit metadata; and no rendered text contains `[object Object]`.

## Task 9: Python provisioning configuration

**Files:**
- Create: `provisioning/example.env`
- Create: `provisioning/example.topology.yaml`
- Create: `scripts/provision_trip.py`
- Create: `scripts/verify_deployment.py`
- Test: `tests/provisioning/test_topology.py`

No IP address, username, private key path, token or hostname is hard-coded. Read public topology from YAML and secrets from environment. Validate required variables before touching infrastructure.

## Task 10: Idempotent deployment workflow

**Files:**
- Create: `scripts/provisioning/proxmox.py`
- Create: `scripts/provisioning/npm.py`
- Create: `scripts/provisioning/cloudflare.py`
- Create: `scripts/provisioning/rollback.py`
- Test: `tests/provisioning/test_idempotency.py`

Implement `plan`, `apply`, `verify`, and `rollback`. Provision LXC/site assets, NPM proxy host, Cloudflare ingress/DNS using configured adapters; snapshot mutable state; never delete an unrelated resource; use SSH keys and externally supplied tokens only.

## Task 11: End-to-end verification against CT 202

**Files:**
- Create: `provisioning/fixtures/ct202-topology.yaml`
- Modify: `README.md`

After unit/DOM tests pass, run `enrich_trip.py --dry-run`, provisioning `plan`, then non-destructive `verify` against the general CT 202 test target. Confirm API health, config fields, public HTTPS, asset cache versions, and rendered UI selectors. Do not alter production trips during this validation.

## Verification and acceptance criteria

1. `driver.mjs generate` creates a base config from lean interview input.
2. `enrich_trip.py` completes derived data or lists explicit review items, with sources.
3. Weather always represents the next seven days from the time the site loads/refreshes.
4. No image enters a config without source/licensing/mime/quality validation.
5. Deployment scripts run dry-run safely and use only config/env inputs.
6. Verify proves real UI behavior, not only HTTP 200.
7. Run the generalized workflow against CT 202 before using it for a new production trip.
