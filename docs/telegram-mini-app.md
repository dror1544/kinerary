# Telegram Mini App entry shell

The web SPA has an optional, mobile-oriented entry shell. It reuses the existing
account session and runtime launch APIs; Telegram launch data does not sign a
person in or grant access to a trip.

## Entry paths

- `/mini-app` or `/mini-app?startapp=account`: existing My trips account view.
- `/mini-app?startapp=trip_<opaque-id>`: redirects within the SPA to
  `/mini-app/trips/trip_<opaque-id>` and opens the existing runtime view.
- `tgWebAppStartParam` accepts the same selectors as `startapp`, as an untrusted
  routing hint. The opaque trip identifier must match `trip_` followed by
  8–64 ASCII letters or digits. Duplicate or conflicting selector parameters,
  arbitrary URLs and invalid identifiers show an unavailable-link message with
  a link to My trips.

The current shell does not resolve a Telegram chat to a trip. A group launch
requires an explicit trip selector and a person who already has runtime access.
The existing session login, CSRF token and server membership checks authorize
`POST /v1/trips/:tripId/launch`. Changing trip selection clears the previous runtime frame. Only a successful
launch for the currently selected trip renders an iframe.
Unauthenticated visitors use the ordinary sign-in page with the Mini App path as
its return destination. Telegram identity and chat hints are never used as
credentials.

## Host presentation and fallback

The official Telegram Web App SDK script is loaded only while a Mini App entry
is mounted. Optional `ready`, `expand`, back-button and presentation event
methods are guarded for hosts that lack them or throw. Back from a trip returns
to the Mini App account entry; ordinary on-screen links remain available.
Subscriptions and the entry's script element are cleaned up when it unmounts.

The outer shell accepts only six-digit hex theme colors and finite safe-area
insets between 0 and 256 pixels. It takes the larger device/content inset on each
side as a bounded union/max interpretation; the SDK documentation does not
specify a composition formula, so real mobile validation remains owed. SDK values change presentation only; `initData`, `initDataUnsafe`, user and
chat data are not read. If the SDK is missing or fails to load, the existing web
views remain usable in an ordinary browser. Existing links can continue into
ordinary SPA routes; this slice does not replace all account/trip navigation
with Mini App routes or retheme the full trip runtime. The existing fixed runtime
is scoped back into the shell layout so its iframe occupies the space remaining
below the headers and inside the safe-area padding.

Telegram's [Mini Apps documentation](https://core.telegram.org/bots/webapps)
describes the optional SDK, lifecycle events, theme parameters, safe areas and
back-button APIs used here. Installing bot menu buttons, configuring a public
HTTPS URL and choosing Telegram launch links are deployment concerns, outside
this product change.

## Verification and remaining acceptance

Run `npm test` and `npm run build` from `web/`. The Mini App tests cover account
launch, authorized runtime launch, denied runtime access despite forged SDK user
and chat hints, strict selectors, sign-in return paths, trip selection changes including delayed
responses, browser fallback, scoped
SDK loading, safe presentation values and back-handler cleanup.

Combined-tree verification must also cover trip-password sign-in for Mini App
return paths alongside the recovery change. Independent combined-tree
verification remains owed before merge.

Real Telegram acceptance remains required on mobile and desktop hosts: launch
private and group entries, sign in with an existing account, confirm access and
rejection for actual memberships, check safe areas and back behavior, and verify
that the existing runtime iframe works under the deployment's cookie and framing
policies. This shell does not add Telegram SSO, account grants, bot configuration,
recovery, provisioning or a deployment.
