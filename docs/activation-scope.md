# Activation — scope before implementation

**Status: open product/design gap. Nothing here is committed work.**

Recorded 2026-09-05 (Dror). `activation_approved` and `active` exist in the
schema. **Do not implement them because they exist.** For the onboarding MVP, a
successfully provisioned `ready_private` trip is an acceptable endpoint.

> The existing state names do not dictate the eventual product flow. If the
> simpler product model does not need one of those states, we should remove it
> rather than invent behavior to justify it.

## 1. The questions to answer

1. What actually changes between `ready_private` and `active`?
2. Who initiates activation?
3. What prerequisites must be satisfied?
4. How are family members invited and enrolled?
5. What becomes accessible after activation?
6. Is `activation_approved` actually necessary, or is it leftover complexity
   from an earlier model?

Known intersections, which is why this is scoped separately rather than
answered inline: organizer/member onboarding, family access, Telegram linking,
and the shared companion-bot flow (one shared `@Kinerary_bot`; Telegram SSO is
ruled out permanently).

## 2. How cheap removal would be

If the answer is "we don't need these states", very little has to be undone.

- **`activation_approved`** — 4 references, **none behavioral**: the CHECK enum
  (`0001_foundation.sql:17`), the dead `lifecycle.ts` (10, 26, 27),
  `contracts/v1/records.schema.json:107`, `test/lifecycle.test.ts:8`, plus prose
  in `docs/architecture.html`.
- **trip-state `active`** — the only *product* reference is
  `web/src/pages/ProductApp.tsx`'s Ready grouping. Everything else is enum
  membership, the dead module, or negative-case test seeds.
- **`control_plane.activations`** (`0001_foundation.sql:150-158`) has **no
  reader or writer in any code** — the other half of the same never-built
  ceremony.

Neither state has a writer today. See also the lifecycle-enforcement debt
recorded under Sprint 4.7: the declared state machine has zero production
callers, so these states are documentation, not behavior.

## 3. Verified findings that should inform the answer

Measured against the running stack on 2026-09-05, **not inferred**. These are
**evidence for the scoping decision, not a build list and not a commitment.**
They matter here because they make question 1 concrete: today, "what changes
between `ready_private` and `active`" is mostly "these six things are true
instead of false."

```
control_plane.jobs           = 0     ← no provisioning job has ever run here
control_plane.runtime_routes = 0
telegram_chat_bindings       = 4
trips: intake_confirmed=6, intake_in_progress=2, ready_private=1 (hand-seeded)
```

Live runs 7–11 all stop at `intake_confirmed`; the provisioning half has never
executed end to end.

**Already armed, and worth knowing before scoping:**
`PROVISIONER_COMPUTE_ENABLED=1` (real LXC + NPM + Cloudflare provisioning is
on); `PROVISIONER_SEED_PASSWORD` is set, so a provisioned site *does* have a
working shared-password login; chat routing is built and tested
(`chat-router.ts`, relay dispatch, the wake-word group gate, 10 isolation
tests); the companion bundle and MCP bridge scripts are complete.

| # | Finding | Evidence |
|---|---|---|
| B1 | **The companion cannot be installed at all.** `provisioner.py` shells `render_profile.py`, which runs `hermes profile create`. It fails at *warning* level — and the MCP bridge, `assistant_names` and the chat binding are each gated on that profile existing, so one missing binary silently costs all four. The trip reaches `ready_private` and is unroutable: the organizer messages the bot and gets "I don't have a trip for this chat." | `docker exec …-worker-1 sh -c 'command -v hermes; command -v node; ls -d /root/.hermes'` → `NO_HERMES / NO_NODE / NO_HERMES_DIR` |
| B2 | **`runtime_routes` never gets a row.** The only writer repo-wide is a one-shot backfill in `0034_web_portal_addenda.sql:19-25`. `GET /internal/runtime-routes/:tripId` 404s `RUNTIME_NOT_READY` forever for a new trip, killing "Open trip", invite creation, participant lookup and the gateway proxy. `portal.ts` masks it in the dashboard with `\|\| lifecycle_state === "ready_private"`. | 0 rows; grep for writers |
| B3 | **The runtime has no control-plane endpoints.** `/api/internal/control-plane/session` and `/participants` exist only as test stubs in `runtime-gateway/test/gateway.test.js`. `CONTROL_PLANE_EXCHANGE_KEY` is never written into the container `.env`. | `provisioning/adapters.py:266-277` |
| B4 | **The SPA and runtime-gateway are not deployed, and the portal routes are not mounted.** `registerPortalRoutes` runs only when `profile.web` exists; the mounted profile has no `web` block, and compose runs only `postgres`, `migrate`, `api`, `worker`. | `architecture.local.example.json` keys: no `web` |
| B5 | **Per-trip MCP port collision.** `mcp_bridge.py` never passes `--port`; `setup-mcp.sh` hardcodes `3001` and kills whatever is listening there, so trip N+1 would kill trip N's bridge. | `mcp_bridge.py:100`, `setup-mcp.sh:76` |
| B6 | **Manual allowlisting, unsupervised services.** `multiplex_profile_allowlist` holds one entry and needs a hand config edit plus a gateway restart per trip. Four long-running services (relay, interview MCP, gateway, per-trip `trip-mcp`) are unsupervised `nohup` processes outside compose. | `~/.hermes/profiles/trip-intake/config.yaml:20-22` |

**Note on B3:** it is *not* required for a family to get in — the seed password
already gives a working login. B3 buys the clean per-member path, not first
access. Worth separating when answering question 5.

**B1 has an open architectural fork**, deliberately undecided:

- *Host-side step.* `ShellDeployAdapter` already shells out to host tooling for
  the LXC/NPM/DNS work; do the same for the companion profile and MCP bridge,
  keeping `hermes` and `~/.hermes` where they already live. No image change, no
  profile directory mounted into a credential-holding container.
- *Tooled worker.* Give the worker container `node` + `hermes` + a mounted
  `~/.hermes`. Self-contained, at the cost of a bigger image and that mount.

## 4. What this supersedes

Sprint 6 ("Verification, explicit activation, dashboard, and demo rehearsal")
currently asserts a separate expiring activation plan applied from a distinct
approval. That design predates this gap being named and should be treated as
**superseded pending this scoping**, not as a specification to build against.
