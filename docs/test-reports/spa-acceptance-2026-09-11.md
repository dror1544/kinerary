# SPA acceptance — 2026-09-11

Revision inspected: `2500e07` on `feat/modern-spa-classic-parity`.
Result: local automated checks pass; deployed end-to-end acceptance remains open.

## Evidence

| Check | Result |
|---|---|
| `npm test --prefix web` | 10 passed |
| `npm test --prefix trip-web` | 41 passed |
| Runtime session, event HTTP, event revision, and logout suites | 16 passed, no skips |
| `npm run build --prefix web` | Passed |
| `npm run build --prefix trip-web` | Passed; Vite reports the external runtime-base script and large MapLibre chunk warnings |
| Browser at `http://localhost:8081/modern/` | Journey itinerary, booking with confirmation/download controls, budget, and photo empty state render |

Integration command:

```sh
node --test --test-timeout=60000 --test-reporter=spec \
  tests/control-plane-session.test.js tests/trip-events.test.js \
  tests/trip-events-http.test.js tests/runtime-logout.test.js
```

These integration tests use disposable runtime data and the real gateway and
MCP. Control-plane grant consumption and route lookup are fixture responses.
They prove owner/member scoping, wrong-trip refusal, two-client event delivery,
MCP budget persistence, reconnect, document/photo/comment notifications,
rejected-write behavior, and logout. They do not prove Google sign-in, real
portal grant issuance, or a Telegram companion turn.

The initial integration attempt could not bind ports in the sandbox; the
authorized retry passed. Modern dependencies were absent and were installed
from the existing lockfile before testing. No application source changed.

## Remaining acceptance

The local container inventory contains the control-plane API/worker/database
and direct trip site/server. No portal or runtime-gateway container appeared,
and no separate portal/gateway listener was identified. The existing browser
session opens Modern directly, rather than through a portal launch grant.
This is evidence about this machine, not a claim that no remote deployment exists.

1. Identify or prepare the test portal and runtime-gateway deployment, with
   the runtime identity sidecar and matching exchange key described in
   `runtime-session-exchange.md`. Do not put secrets into this record.
2. Sign in through that portal, select the test trip, and confirm the expected
   trip identity and organizer/member permissions in Modern.
3. In two browser tabs, verify persisted companion edits for itinerary,
   bookings/documents, budget, photos, reactions, and comments without reload.
4. Verify reconnect and an unsaved editor draft while the other client changes
   or removes its underlying record. Automated event checks alone do not close
   this browser acceptance gate.

No live trip data was edited, no Telegram message was sent, and no live service
was restarted. Deployment and human acceptance have not been recorded as approved.

## Planning correction

The organizer dashboard already exists in `web/src/pages/ProductApp.tsx` and
is mounted by `web/src/App.tsx`. It includes trip grouping, interview handoff,
setup progress, plan review, safe provisioning errors, and runtime launch.
The next task is integration acceptance of those existing surfaces, rather
than implementing another dashboard. `web/src/pages/TripsPage.tsx` is an older
interface preview and is not the mounted `/trips` route.
