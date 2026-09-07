# The companion's first message

**Status: design, not implemented.** Written 2026-09-07, from a live-run
request: when a new trip companion comes to life it must introduce itself
rather than sit silent until spoken to.

Today it sits silent. Nothing in `profile-templates/familytrip-companion/`
sends a first message, and nothing in the provisioner triggers one. The
organizer's site goes up, a Hermes profile appears, and the only way to
discover any of it is to already know.

## 1. What it has to carry

Two audiences, two messages, one trigger.

| | Organizer (DM) | Group |
|---|---|---|
| Who it is, its name | ✅ | ✅ |
| What it can do | full | the shared half |
| Change the plan / add days & items | ✅ | ✅ |
| Store booking confirmations for later retrieval | ✅ | ✅ |
| Site URL | ✅ | ✅ |
| How to log in | ✅ with the password | see §4 |
| How to add it to a group | ✅ | — (already there) |
| Group invite link | — (no group yet) | ✅ if it can read one |
| Scheduled/proactive messages, if configured | ✅ | ✅ |
| Pinned | if permitted | if permitted |

The split is not cosmetic. The organizer's message is a **setup** message —
it exists to get them from "a site was provisioned" to "my family is in a
group talking to the assistant". The group's message is an **arrival** message
— everyone is already here, tell them what this is and how to get in.

## 2. Composed by the control plane, not the agent

Every line of this is a fact: a name, a URL, a password, whether a schedule is
configured. None of it is judgement, and all of it is wrong if hallucinated —
a mistyped password or an invented URL is worse than no message.

So the router composes and sends it, the same way it owns the interview's
questions. This follows the standing instruction from the itinerary work:
*"It should be by the script not by LLM."*

Phrasing still has to be the trip's, so the strings are templated per language
the way `intake-copy.ts` already does for the interview, with the assistant's
own name and tone substituted in. Deterministic text, localised — not a prompt.

## 3. What Telegram actually allows

Worth stating plainly, because two of the requests are only partly possible.

**Adding the bot to a group** — `https://t.me/<bot>?startgroup=<payload>` opens
Telegram's group picker. The clients offer existing groups; creating a brand-new
group *from the link itself* is not something a URL can do. So the honest
wording is "tap this and pick the group — or make one first and pick it".

**Admin rights at add-time** — the same deep link takes
`&admin=pin_messages+invite_users`. This matters more than it looks: it is how
the bot ends up *able* to pin its own arrival message and read an invite link,
without the organizer being walked through a promote-to-admin flow afterwards.
Ask for the rights at the moment they are granted anyway.

**The group's URL** — only `exportChatInviteLink`, only once the bot is in the
group and has `invite_users`. So it can never appear in the organizer's setup
message (no group exists yet); it belongs in the group's own arrival message.

**Pinning** — `pinChatMessage`, needs `pin_messages`. Attempt it, and treat
failure as ordinary: an unpinned intro is a worse intro, not a failed
provisioning.

None of these three methods exist in `relay/telegram-api.ts` today. They are
the only new Telegram surface this needs.

## 4. The password question — a real decision

`PROVISIONER_SEED_PASSWORD` is the shared family login. It reaches the site
through `compute.py` and is deliberately not in the companion handoff today.

Putting it in the **organizer's DM** is uncontroversial.

Putting it in the **group message** is the actual ask, and it is coherent:
every member needs it, the group is where they are, and pinning it is
precisely so a member who joins later can scroll to it. But it is worth saying
out loud that a password posted to a group is durable, searchable, and visible
to everyone ever added to that group, including after the trip.

The mitigation is not to hide it — a login nobody can find is a site nobody
uses — it is that this password is a **stopgap**, already recorded as such:
per-user credentials replace it once member signup exists, and at that point
this message changes with it.

**Decision needed:** password in the group message, or "ask <organizer> for the
login" with the password only in the DM.

## 5. The trigger

Provisioning completing is the event — the same point that already records
reachability and enqueues the operator DM. The intro is one more row in
`notification_outbox`, which means it inherits retry and the "never a gate"
property: a failed intro must never fail a provisioning.

Ordering matters in one place. The organizer's DM can go the moment the site is
up. The group's message cannot exist until there is a group, so it is sent on
the bot's `my_chat_member` join event, not on a timer.

## 6. What the handoff must gain

- `login.seed_password` (or a flag saying one was set), for §4
- `login.url` — already present as `trip.canonical_site_url`
- `group_add_url` — derived, not stored: bot username plus trip payload
- `assistant.proactive` — already present; §1's schedule line is rendered from
  it, and omitted entirely when it is empty rather than saying "no schedule"

## 7. Not in scope

Re-sending on re-provision (an organizer who re-runs setup should not get a
second identical DM), and the `?startgroup` payload being used to bind the
group to the trip automatically. The second is tempting and is a separate
decision: it is a binding created from a link, which is a trust question, not
a convenience one.
