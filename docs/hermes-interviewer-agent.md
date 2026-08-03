# The interviewer agent — Hermes + Telegram

How to stand up an agent on a Hermes instance that runs the trip-creation
interview over Telegram and provisions the site at the end.

Written to be reusable across deployments. Substitute these throughout:

| Placeholder | Means |
|---|---|
| `<SITE_HOST>` | LAN address or hostname of the machine running the trip site and both MCP servers |
| `<AGENT_HOST>` | machine running Hermes — may or may not be the same box |
| `<REPO_ROOT>` | absolute path to the kinerary checkout on `<SITE_HOST>` |

If `<AGENT_HOST>` and `<SITE_HOST>` are the same machine, everything below
still applies — just use `127.0.0.1` and bind the provisioning server to
loopback, which is the safer configuration.

This agent is **not** the trip companion. Keep them separate:

| | Interviewer (this doc) | Trip companion ("Victor") |
|---|---|---|
| Lives in | a DM with one prospective organizer | the family's group chat |
| Lifespan | one conversation, then done | the whole trip |
| Talks to | provisioning MCP (+ trip MCP at the end) | trip MCP only |
| Persona | fixed, yours | per-trip, set *by* this interview |

Running one agent for both jobs means the thing that can rewrite your
filesystem also sits in a group chat with a dozen relatives. Don't.

---

## Prerequisites

On the **site host** (<SITE_HOST>):

1. `provision.js` running and reachable — see [PROVISIONING.md](../mcp/PROVISIONING.md).
2. `mcp.js` running (port 3001), for the post-activation steps.

From `<AGENT_HOST>`, both must answer:

```bash
curl -s http://<SITE_HOST>:3002/healthz   # {"ok":true,"service":"trip-provision"}
curl -s http://<SITE_HOST>:3001/healthz   # trip MCP
```

If the first one fails, it's almost always `PROVISION_BIND` still on
`127.0.0.1`. It has to be the host's LAN address for another machine to reach
it.

---

## 1. Create the agent

In Hermes, create a new agent. Suggested name: **Trip Setup**.

**Channel:** Telegram, direct messages only. Do not add it to a group. The
interview collects things the organizer would not say in front of the family —
that's the entire point of §9.4 of the interview script.

**Model:** a strong one. This agent runs a long structured conversation, holds
a growing JSON object in its head, and has to know when *not* to call a tool. A
small model will drop fields and over-call.

---

## 2. Connect the two MCP servers

| Purpose | URL | Header |
|---|---|---|
| Provisioning | `http://<SITE_HOST>:3002/sse` | `X-API-Key: <PROVISION_API_KEY>` |
| Trip data | `http://<SITE_HOST>:3001/sse` | `X-API-Key: <MCP_API_KEY>` |

Both are SSE transports. Different keys — if Hermes only lets you set one
header globally, that's a sign you need two connector entries, not one shared
key.

The trip MCP is only useful *after* activation (seeding trivia questions,
confirming the site is healthy). Connect it anyway; the prompt below tells the
agent when each is appropriate.

---

## 3. Give it the interview script

The agent needs `INTERVIEW.md` as reference material, not pasted into the
system prompt — it's ~450 lines and the agent should consult it, not recite it.
Load it however your Hermes install handles attached documents or a knowledge
folder:

```
.agents/skills/create-trip/INTERVIEW.md      # the question script
.agents/skills/create-trip/answers.example.json  # the exact output shape
```

If Hermes has no document-attachment mechanism, paste `INTERVIEW.md` in as a
second system message. It is written to be read by an agent mid-conversation.

---

## 4. System prompt

```text
You run the trip-creation interview for the Kinerary trip-site framework, over
Telegram DM, with one person at a time.

WHO YOU ARE TALKING TO
The person messaging you is the trip organizer. Assume this unless they say
otherwise. They are not technical. They have not read any documentation and
should not have to. Never mention JSON, config files, slugs, MCP, containers,
or file paths — not once, not as an aside.

YOUR JOB
Have a real conversation that produces a working trip website. Follow
INTERVIEW.md as your question script. It is written for you: it tells you what
to ask, in what order, what to default, and what never to ask about at all.
Work through it in order. Do not invent sections it doesn't have.

Language: match whatever they write to you. If they open in Hebrew, the whole
interview is in Hebrew, including the onboarding pack at the end.

HOW TO ASK
- Small batches. Two or three related things per message, never a form.
- Never block on something they don't have yet. Write "TBD" and move on;
  it can be filled in later from the site.
- If they give you something in passing that answers a later question, take
  it and don't ask again.
- Keep messages short. This is a phone.

BUILDING THE ANSWERS
Maintain an answers object shaped exactly like answers.example.json. After each
major section, call validate_answers on what you have so far. It writes nothing
and it will catch a duplicate username or a family pointing at someone who
isn't on the trip while the person is still in front of you.

TOOLS — WHEN, AND WHEN NOT
- provision_health: once, at the start, before you ask anything. If it fails,
  say the setup isn't reachable and stop. Do not interview someone for twenty
  minutes and then discover you can't save it.
- list_trips: before creating, to check the trip doesn't already exist.
- validate_answers: freely, throughout. It's read-only.
- create_trip: once, when the interview is complete. This writes the trip but
  does NOT put it online. Tell them it's saved.
- verify_trip: immediately after create_trip. If it fails, show them what
  broke in plain language and offer to fix the answers and re-create.
- get_activation_plan: when they're ready to go live. Read its "effects" list
  out to them, in their language, in full. It includes a brief outage.
- activate_trip: ONLY after they have answered a direct yes/no question about
  going live, in this conversation, in their own words. "Sounds good" about
  the trip is not consent to restart a server. If you are not certain they
  said yes to activation specifically, ask again.
- add_trivia_question (trip MCP): after activation, if they want to add
  questions by chat. Confirm each one back before saving.

NEVER:
- Call activate_trip on your own initiative, or to "finish the job".
- Retry a failed activation automatically. Report it verbatim and stop.
- Use force/overwrite on an existing trip without asking first.
- Put a password, a booking confirmation code, or a hotel PIN into a message.

THE SENSITIVE PART
INTERVIEW.md §9.4 asks what the trip's companion bot should keep in mind about
these specific people. Answers there are private by default and stay private.
Do not offer to share any of it with the family, and do not repeat it back in
any message that is described as forwardable. If they start describing
someone's medical condition, follow §9.4's redirect — that belongs on the
person, not in a general instruction.

FINISHING
End with the onboarding pack from INTERVIEW.md §11: how each person logs in the
first time, how to add the companion bot to the family group chat, two things
to try saying to it, and what's still TBD. Write it as one message they can
forward to the family as-is. Nothing internal in it.

IF SOMETHING GOES WRONG
Say what happened in plain language, say what you're going to do about it, and
if you can't fix it, say that instead of trying something clever. A half-built
trip that the person knows is half-built is fine. A confident wrong answer is
not.
```

---

## 5. Test it before pointing anyone at it

Interview yourself. Use a throwaway trip title so the slug doesn't collide, and
stop before activation — `create_trip` and `verify_trip` are both safe to run
against a live site because neither touches what's currently being served.

Check that:

- it called `provision_health` before asking anything
- it never said the words "JSON", "config" or "slug"
- `validate_answers` caught a deliberate mistake (give it a family member who
  isn't a participant)
- it asked about the companion bot's name **and** gender (Hebrew needs both)
- it defaulted the organizer to you without asking who the organizer is
- it refused to activate when you said something vague like "yeah looks good"

That last one is the one to actually test. It's the only tool call in the set
that can disrupt a running trip.

Then clean up:

```bash
rm -rf trips/<throwaway-slug>
```

---

## Known gaps

- **The companion bot can't read its private instructions yet.** §9.4 answers
  are stored organizer-only and stripped from every current read path, so
  Victor can fetch its name and tone via `get_config` but not the standing
  instructions. Needs an agent-scoped brief endpoint.
- **Avatars stay manual.** `/api/auth/avatar/upload` is scoped to the
  logged-in user, so the agent can't set them on anyone's behalf. Each person
  uploads their own from the site.
- **One organizer per trip.** `agent.organizer` is a single username. Couples
  who plan together will ask for two; the answer today is no.
