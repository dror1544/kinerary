# B1 — the companion cannot be installed

**Scope: `activation-scope.md` §3 finding B1, and nothing beyond it.** Written
2026-09-06 after run 13. This is a build plan; `activation-scope.md` remains
the authority on what activation *is*, and its instruction stands — a
successfully provisioned `ready_private` trip is an acceptable MVP endpoint,
and `activation_approved` / `active` are not to be implemented because they
exist in an enum.

## 1. Why one missing binary costs four things

The code is careful about isolating these failures from each other. It does not
help, because the failure happens upstream of all of them.

```
provisioner.py:824    hermes_profile = self._companion.install(handoff)
provisioner.py:830      └─ if hermes_profile:  mcp_bridge.setup(...)
provisioner.py:865      └─ if hermes_profile:  UPDATE trips SET assistant_names
provisioner.py:873      └─ if hermes_profile and recipient_chat_id:  chat binding
```

`RenderProfileAdapter.install` (`companion_profile.py:189-209`) shells
`render_profile.py --install-profile`, and **raises** on a non-zero exit. That
script's line 47 is `subprocess.run(['hermes','profile','create',...],
check=True)`. In the worker container `hermes` does not exist:

```
docker exec …-worker-1 sh -c 'command -v hermes; command -v node; ls -d /root/.hermes'
  → NO_HERMES / NO_NODE / NO_HERMES_DIR
```

So `install()` raises, the broad handler at `provisioner.py:807` logs a
warning, and control jumps past all three gated blocks at once. The chat
binding is written to be *deliberately* outside that broad handler — its own
comment says an unbound trip is unroutable and must not be filed under a
best-effort warning — but it never runs, because it sits inside
`if hermes_profile`, and `hermes_profile` was never assigned.

Net effect for a family: the interview confirms, the site provisions, the
organizer messages the bot, and gets **"I don't have a trip for this chat."**

## 2. The fork, re-analysed — and a correction

`activation-scope.md` leaves two options open. I recommended the *host-side
step* earlier on the reasoning that `ShellDeployAdapter` "already shells out to
host tooling" and that the alternative would mount `~/.hermes` into a
credential-holding container. **Both halves of that were wrong**, and reading
`compose.local.yml:112-216` is what corrects them:

- `ShellDeployAdapter` does **not** run on the host. It runs `deploy.sh` *inside
  the worker container*, against `/deploy-root` (rw) and `/repo` (ro) bind
  mounts, reaching Proxmox and the RPi over SSH with two mounted keys.
- The container is **already** the credential-holding, privileged, root thing.
  It holds two SSH private keys, Proxmox/NPM/Cloudflare tokens, and runs as
  root. The compose file says so in as many words: *"This container already
  performs real, privileged infra actions… nobody's isolation wasn't buying
  much extra safety over that regardless."*

So the objection to the tooled worker — that it crosses a trust boundary —
describes a boundary that was crossed before this feature existed. And the
host-side option is not the cheap reuse I claimed: the worker is in Docker
Desktop and cannot execute on the Mac host, so it would need a new mechanism
(SSH back to the host, or a host-side agent) with its own auth, failure modes
and supervision. That is new surface, not an existing pattern.

**Recommendation: the tooled worker.** It is the option that matches the shape
the worker already has.

## 3. The work

1. **Worker image** — add `node` and the `hermes` CLI to
   `control-plane/worker/Dockerfile`. Pin both; a companion profile rendered by
   a different Hermes than the one that runs it is a drift class we do not want
   to discover live.
2. **Profile home** — mount `~/.hermes` into the worker (`HOME` is already
   `/root`, so `/root/.hermes`). Read-write: `render_profile.py:45` writes
   `Path.home()/'.hermes/profiles'/<name>`. Scope the mount to `profiles/` if
   the rest of `~/.hermes` proves unnecessary — worth checking, since it also
   holds unrelated profiles' state and credentials.
3. **Fail loudly at the boundary, not silently past it.** Today a missing
   binary is indistinguishable from "this deployment has no templates dir".
   Have the worker verify `hermes` and `node` are present at startup when
   `PROVISIONER_COMPANION_PROFILE_ENABLED` is on, and refuse to start
   otherwise — the same instinct as `interview-stack-deploy`'s tool-registration
   check: prove the capability, don't infer it from an upstream process being
   alive.
4. **Un-gate the chat binding from the companion install.** Even with 1-3 done,
   the current shape means any future companion failure silently takes the
   binding with it. The binding needs `recipient_chat_id` and the trip; it does
   not need the profile to have rendered. Separating them makes an unroutable
   trip impossible for this reason rather than unlikely.

Steps 1-3 make the companion install. Step 4 makes it not matter as much when
something else in that chain breaks later.

## 4. What "done" means

Not "the code looks right" — `control_plane.jobs = 0` means nothing in this
path has ever been exercised, so the only acceptance test that counts is a run:

- `control_plane.jobs` has a row with a successful outcome (it has never had
  one);
- `~/.hermes/profiles/<slug>` exists on the host;
- `trips.assistant_names` is non-empty for that trip;
- a `telegram_chat_bindings` row exists;
- **the organizer messages the bot and gets a real answer** rather than "I
  don't have a trip for this chat."

The last one is the only one a family would notice, and it is the one to
demonstrate.

## 5. Deliberately out of scope

- **B2 (`runtime_routes`)** — the next blocker, and a separate change. It gates
  Open trip, invites and participant lookup, none of which the acceptance test
  above needs.
- **B3** — `activation-scope.md` is explicit that the seed password already
  gives first access; B3 buys the clean per-member path, not the ability to get
  in. Note this is an *operational* fact, not a code one:
  `PROVISIONER_SEED_PASSWORD` empty means, per `compose.local.yml:173-177`, the
  site has no usable login at all. It is set on the running stack. It should be
  asserted somewhere, not remembered.
- **B5, B6** — both are trip N+1 problems (port collision, manual allowlisting).
  A first family is trip N.
- **Activation states** — see the top of this file.
