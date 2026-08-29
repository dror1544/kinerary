# Modern Trip SPA code review session

Date: 2026-08-29

## Scope reviewed

- New Modern participant SPA under `trip-web/`, built to `site/modern/`.
- Classic/Modern loader and Classic rollback path.
- Shared Kinerary brand assets and tokens.
- SQL-backed living itinerary model and compatibility adapters.
- Today/Journey/Moments/More beta surfaces.
- Control-plane landing SPA integration brought in from `feat/landing-spa`.

## Pre-commit findings fixed

1. Modern did not load `runtime-base.js`, which could break API calls and links behind gateway-prefixed routes such as `/t/<trip>/modern/`.
   - Fix: ship `runtime-base.js` with the Modern build and load it before the SPA bundle.

2. Modern looked only for `tripToken`/`token`, but the gateway session marker is `trip-token`.
   - Fix: accept `trip-token` as an authenticated runtime marker and clear all known token keys on logout.

3. Classic fallback links used `../classic.html`, which was fragile in local preview and gateway routing.
   - Fix: added a Classic URL helper that uses runtime prefixing and points local Vite preview to the API server that serves `classic.html`.

## Validation

- `trip-web` unit tests: passed, including Classic fallback URL and gateway token marker coverage.
- `trip-web` production build: passed.
- Earlier full runtime suite for this staged feature: 379 passed, 0 failed.
- Staged diff whitespace check: clean after generated bundle whitespace cleanup.
- Secret scan: clean.
- `japan-2025` date-shift status: clean.

## Known follow-up risks

- Modern is not yet feature-parity with Classic. Classic must remain available until parity acceptance.
- Some design issues are intentionally still open for organizer interview: Today emphasis, Journey phase semantics, More/fallback visibility, and Moments behavior during an active trip.
- Bot settings are future scope because organizer-editable bot personality requires Hermes-agent changes; the current UI should only display the configured bot name and open Telegram.

## Commit recommendation

Commit is reasonable after the Classic fallback fix because the feature is staged, tested, and still protected by Classic rollback. The next phase should start with stabilizing structure/design and the Classic switch, then rebuild bookings/tickets/maps.
