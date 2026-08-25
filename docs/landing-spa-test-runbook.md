# Landing SPA test-environment runbook

This runbook describes validation on an HTTPS test domain. It does not
authorize deployment or production cutover.

## Required topology

- Organizer origin: SPA/Nginx and same-origin `/v1` proxy.
- Runtime origin: `control-plane/runtime-gateway`, on a different HTTPS origin.
- Private network: control-plane API, PostgreSQL, worker, and isolated trip
  runtimes. The gateway and API share `RUNTIME_EXCHANGE_KEY`; runtimes receive
  the same key only for their private exchange endpoints.
- Google OIDC redirect: `<organizer-origin>/v1/auth/google/callback`.

Start from `control-plane/config/architecture.web.example.json`. Replace all
example origins, secret references, upstream suffixes, bot username, and admin
subject digests. Production profiles reject non-HTTPS web origins. Set the
gateway's `CONTROL_PLANE_INTERNAL_ORIGIN`, `RUNTIME_EXCHANGE_KEY`,
`RUNTIME_COOKIE_SECRET`, `PORTAL_ORIGIN`, and `RUNTIME_ORIGIN`. Set each runtime's
`CONTROL_PLANE_EXCHANGE_KEY` to the exchange key.

`RUNTIME_COOKIE_SECRET` must be independently generated and at least 32 random
bytes. Do not reuse a Google, Telegram, JWT, database, or approval secret.

## Preflight

Run migrations before the API or worker. Then verify:

```sh
cd control-plane/api && npm run build && npm test
cd ../runtime-gateway && npm test
cd ../../web && npm run build && npm test
cd ../tests && npm test
cd ../control-plane/worker && PYTHONPATH=../.. python3 -m unittest discover -s tests
cd ../.. && python3 -m unittest discover -s tests/provisioning
```

Run the DB-backed API suite with `CONTROL_PLANE_TEST_DATABASE_URL` pointing to
a disposable migrated PostgreSQL database. Never aim it at production.

## Browser acceptance

Use two Google identities (organizer and operations admin) plus one participant
invitation. Prove the complete flow: landing CTA, organizer sign-in, draft,
Telegram interview and confirmation, provisioning request, separate admin
approval, ready state, iframe launch without a second login, invite redemption,
and correct participant runtime access.

Also verify refresh/direct navigation for every SPA route; iframe behavior on
mobile; SSE reconnect; a large upload and streamed download; a rejected and a
failed provisioning request; invite expiry/revocation/replay; and cross-trip
404 responses with two organizer accounts.

Inspect access logs to confirm launch and invite tokens never appear in URLs.
Confirm public API responses contain no upstream hostnames, raw job errors,
transcripts, credentials, or invitation tokens after initial creation.

## Cutover

Backfill/migration `0020_web_portal.sql` registers successful existing trips
with opaque runtime route references. Keep legacy hostnames operator-only until
all acceptance checks pass. Deployment, restart, hostname presentation changes,
and production cutover each require explicit operator approval.
