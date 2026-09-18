---
name: organizer-invites
description: Hand somebody an interview link — create their trip and print an invitation to forward, in English or Hebrew, with a returning organizer greeted as one. Use when asked to invite, sign up or onboard an organizer, to re-send someone's interview link, or when a signup went quiet and you need to know whether their link was ever opened.
---

An operator says "invite this person", and a link comes back with a message to
forward. That is the whole feature. Everything below exists because doing it any
other way meant inventing a password on somebody's behalf, or writing SQL.

## The shape

```
agent ──▶ invite-mcp.mjs ──▶ ssh cpinvite@host (forced command)
                                   │
                                   └─▶ kinerary-invite ──▶ POST /internal/operator/invitations
                                                                    │
                                        a trip, a single-use link, a row saying who asked
```

Two verbs and no third one. `invite_preview` reads; `invite_create` writes. No
tool takes a command, a trip id, a token or a password, and nothing in either
half reaches a shell: the MCP checks an address against a strict pattern, the
forced command refuses any character outside `A-Za-z0-9._:@+-`, and the host
tool checks everything again before it becomes a call.

## The three kinds, which are about the person

| kind | what it means | what it does |
|---|---|---|
| `new` | nobody holds that address | creates an account and a first trip |
| `resume` | they have a draft they never started | revokes the old link, issues a fresh one — **no second trip** |
| `returning` | they have had a trip built | opens another trip beside it, and the interview greets them as a returning organizer |

`resume` is the common one in practice. On production, four real signups are
sitting on links that expired before anyone opened them, and from the outside
that looks exactly like somebody who has not got round to it.

## What it refuses, and why each refusal is not an obstacle

- **They are in an interview right now.** A link issued now would collide with
  the conversation they are in the middle of. Let them finish.
- **Their last trip is still building.** A second trip started now races the
  first one for their attention and for their private chat. Wait for ready.
- **Their interview was closed for idleness.** The trip is past `draft`, so no
  link can be issued for it; `scripts/fresh-interview.py` is the tool that
  restarts that trip's interview, and it destroys the answers it replaces.
- **More than ten invitations in an hour.** More than this has ever legitimately
  needed.

There is no `--force`, and there is no password reset: the control plane has no
such route for organizers at all.

## Install

The MCP, in the monitoring agent's profile:

```bash
scripts/install-hermes-skill.sh organizer-invites <profile>
hermes --profile <profile> mcp add invitations --command "$(command -v node)" \
  --args ~/.hermes/profiles/<profile>/skills/travel/organizer-invites/invite-mcp.mjs
node ~/.hermes/profiles/<profile>/skills/travel/organizer-invites/invite-mcp.mjs --self-test
```

`--self-test` prints the ssh argv a call would use and contacts nothing, so it
answers "is this pointed at the right host with the right key" before any
invitation exists. Append `SOUL-section.md` to the profile's `SOUL.md`: the
rules an agent needs are there, not here.

On the control-plane host:

```bash
install -m 755 control-plane/deployment/vm-invite.py      /usr/local/sbin/kinerary-invite
install -m 755 control-plane/deployment/vm-invite-gate.sh /usr/local/sbin/kinerary-invite-gate
useradd --system --create-home --shell /usr/sbin/nologin cpinvite
# ~cpinvite/.ssh/authorized_keys:
#   restrict,command="/usr/local/sbin/kinerary-invite-gate" ssh-ed25519 AAAA… trip-monitor
# /etc/sudoers.d/kinerary-invite:
#   cpinvite ALL=(root) NOPASSWD: /usr/local/sbin/kinerary-invite gate *
```

Then set `CONTROL_PLANE_OPERATOR_KEY` in the deployment's env file **and**
restart the API: the routes are not mounted without it, and a key set on one
side only produces a 401 that looks like a broken gate.

## Configuration lives in the deploy repo, not here

`control-plane.env` in the private deploy repo:

| key | what it is |
|---|---|
| `CP_INVITE_GATE_TARGET` | `cpinvite@<host>` — refused if it names another user |
| `CP_INVITE_GATE_KEY_ON_MAC` | the private key authorized for that forced command |
| `CP_INVITE_GATE_KNOWN_HOSTS_ON_MAC` | pinned host key; `StrictHostKeyChecking=yes` is not optional |

On the host, `kinerary-invite` reads `KINERARY_API`,
`CONTROL_PLANE_OPERATOR_KEY`, and either a bot token file or
`KINERARY_BOT_USERNAME` from that deployment's own env file
(`KINERARY_INVITE_ENV`, default `/opt/kinerary-deploy/vm.env`).

The handle in the link comes from the bot's own `getMe` wherever a token is
reachable, and falls back to the configured value. A handle written down
somewhere is a handle that survives a rename, and a renamed bot's link opens a
chat with nothing at all.

## From a terminal, with no agent involved

The same tool, on any host that has the deployment's env file:

```bash
# on the control-plane host
kinerary-invite preview someone@example.com
kinerary-invite create someone@example.com --language he --invited-by dror

# on a laptop running its own stack
KINERARY_INVITE_ENV=~/kinerary-deploy/provisioning.env \
  control-plane/deployment/vm-invite.py preview someone@example.com
```

## What is written down, and what is not

An invitation leaves a row in `organizer_invitations`: the address **as a
digest**, the user and trip it produced, which kind it was, the language, and
who asked for it. That is the audit record, kept separately from the act.

No address is ever logged in readable form, and the invited account gets **no
password credential and no identity row** — deliberately. `user_identities` is
unique on (provider, digest) and is the authentication path, so a password
identity with no credential behind it would leave that address unable to ever
sign up for itself, with no reset to undo it.

## The link is printed, never sent

Nothing here messages anybody. The tool prints the invitation between `--- send
this ---` markers and a person decides who receives it — which is also what
keeps a mistyped address from becoming a message to a stranger.
