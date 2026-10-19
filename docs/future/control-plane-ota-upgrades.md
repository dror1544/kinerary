# Control-plane upgrades: from SSH script to pull-based, verified, self-rolling-back

Status: **proposal — not built.** Raised by Dror 2026-10-18, right after the
`130924b` → `f69536c` VM upgrade's verify step failed on a real gap (the
`trip-intake` Hermes gateway process never gets restarted by the switch
phase, so it kept a stale `interview-mcp` connection — see
[#420](https://github.com/dror1544/kinerary/issues/420) and the debrief in
the owner's notes vault, `insights/2026-10-18-vm-upgrade-debrief.md`). That
incident was resolved by hand; this document is about not needing hands next
time.

Status: **pulled into Sprint 7 in part (2026-10-19, Dror)** — the switch
phase restarts every Hermes gateway (#420), verify checks tool registration
for every profile (#294, #289), and a failed verify retries once and then rolls
back automatically. See Sprint 7 Track 2 in `docs/onboarding-mvp-sprint-plan.md`.
GHCR images and the offer/gate flow stay future, and this document stays here
for them.

## Where things stand today

`kinerary-cp-release` (`control-plane/deployment/vm-release.py`) is a real,
working five-phase upgrade tool — Prepare, Guards, Safety point, Switch,
Verify — with a genuine backup (pg_dump, proved by restoring it into a scratch
database) and a genuine rollback (Proxmox snapshot of the whole VM, taken
*before* the switch). It is not a toy. But every run of it today:

- is **initiated by a person**, SSHed in from the Mac, who typed
  `kinerary-cp-release upgrade main`;
- **builds the images on the VM itself** — `git worktree add` to the target
  commit, then three local `docker build`s — rather than installing something
  already built and tested elsewhere;
- **computes a verify verdict and stops.** A failure prints "but verify
  FAILED. To go back: `kinerary-cp-release rollback`" and waits for a human
  to read it, decide, and type the next command. Nothing pages anyone;
  nothing rolls back on its own; nothing retries a known-fixable cause first.

The 2026-10-18 debrief found that gap is not hypothetical: it is exactly what
happened, and the only reason it got noticed and fixed within the hour is
that an agent was already in the loop watching for the Telegram notification.
A VM that is supposed to upgrade itself unattended cannot depend on that.

## The target: an OTA model, not an SSH script

Dror's framing (2026-10-18): the product should offer a new version, and the
upgrade should be **initiated from the VM itself**, triggered by an API call,
**pulling already-packaged versions from GitHub** rather than building them
locally — the way a phone or an IoT device takes an over-the-air update,
rather than the way an operator currently patches a server by hand.

Concretely, four shifts from today:

1. **Package once, centrally, and store the result at GitHub.** CI builds
   `kinerary-cp/api`, `kinerary-cp/worker` and `kinerary-cp/agent-runtime` on
   merge to `main` (or on a tag) and pushes them to GHCR
   (`ghcr.io/dror1544/kinerary/...:<sha>`) — a GitHub-hosted registry, so both
   halves of "packaging version... stored at GitHub" are literal: the tag/release
   lives in the repo's own history, the image lives in GitHub's registry next
   to it. The VM's Prepare phase becomes `docker pull`, not `git worktree add`
   + `docker build` — faster, and it guarantees the artifact running on the VM
   is byte-for-byte what CI already tested, not a fresh local rebuild of the
   same source.
2. **Offer, don't push.** When a new version is published, the control plane
   records that it exists (an API call — `POST /internal/operator/release/offer`
   or similar) and tells Dror, the way the upgrade-complete Telegram message
   already does today. This is the "we offer a new version" half.
3. **A gated API command initiates the pull, on the VM, as the VM's own
   process.** Not a new trust model: `trip-monitor`'s existing `gate`
   subcommand already does the hard part of this — it can read, plan and
   dry-run, it can *request* an upgrade, and a request sends Dror a one-time
   code over Telegram that only approves the exact action frozen at request
   time (`vm-release.py --help`, the GATE section). The natural shape here is
   the same mechanism with the human role shrunk to "approve," never
   "execute": the owner types a code, the VM-resident process does the pull,
   not a person SSHed in running commands by hand.
4. **Guards, safety point, switch and verify stay — but verify has to act on
   its own verdict, and switch has to cover every long-lived process, not just
   containers.** Both of these are called out in the 2026-10-18 debrief as
   real, present-day gaps independent of the pull-vs-build question:
   - Switch must restart every active Hermes gateway process (the #420 fix,
     generalized past just `trip-intake`), because container restarts don't
     reach them.
   - Verify's tool-registration check (today hard-coded to `trip-intake`
     against `interview-mcp`'s source) needs to generalize to every gateway
     profile against whichever MCP server(s) it actually uses — otherwise the
     same staleness can sit silently on a *live* trip's companion with verify
     reporting green throughout, which is strictly worse than failing loud on
     `trip-intake` did.
   - A verify failure should trigger an automatic, bounded response — retry a
     known remediation (e.g. the gateway restart `restart-bridges` already
     proves works for stale trip-mcp bridges, issue #193) and re-verify, then
     roll back automatically if that doesn't clear it — with no step that
     waits on a human reading terminal output.

## Why this is additive, not a rewrite

Every piece above already has a working precedent in this codebase:
`restart-bridges` is the existing proof that "detect staleness, fix it,
don't wait for a person" works for trip-mcp bridges. `gate` is the existing
proof that "an agent can request a privileged production action, and only a
human-typed one-time code converts the request into an approved action" works
for exactly the kind of command this proposes. GHCR and GitHub Releases are
existing GitHub features, not new infrastructure to stand up. The work is
extending three patterns that already hold, not inventing a fourth.

## Open questions for whoever scopes this

- Does every control-plane release need this, or only ones that touch a
  gateway's tool surface — i.e., is there a cheaper interim step (automate
  verify-failure → rollback only, keep local builds) worth doing before the
  full pull-from-GitHub model?
- Where does the "offer" notification belong relative to the existing
  release-channel/per-trip-version thinking in
  `docs/future/release-channels-and-organizer-spinoffs.md` — that document is
  about which *version a trip* runs; this one is about how the *control
  plane itself* gets a version. They will eventually need to agree on one
  packaging story.
- Does the gated-initiation step reuse `trip-monitor`'s existing `gate`
  mechanism as-is, or does "initiated from the VM after an API command" imply
  a different trigger (e.g. the API call itself, not an agent's periodic
  check, is what starts the countdown to the one-time code)?

Unrouted — no sprint, track or owner assigned. Surfacing for Dror's call on
priority and timing, same as any other plan gap with no current owner.
