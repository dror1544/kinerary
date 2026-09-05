---
name: interview-stack-deploy
description: Build and restart the four services the Trip Bot interview needs — control-plane API, interview MCP sidecar, trip-intake Hermes gateway, relay — with the checks that were skipped live on 2026-09-04/05 and cost real run time twice. Use whenever interview code, SOUL.md, or a migration needs to reach the running stack, or when asked to deploy/restart the interview bot.
---

Four services move together for the interview to work at all, and every
2026-09-04/05 deploy failure was one of them coming up in a state nothing
checked:

- **control-plane API** — restarted without `provisioning.env` sourced, came
  up with an **empty interview-agent key**. That's a designed "working state"
  (the `*_for_chat` routes just don't mount), so nothing failed loudly. Cost
  two live rounds before a grep in the gateway log found it.
- **interview MCP sidecar** — same missing key, so it silently exposed only
  the old token-based tools. The check that "confirmed" it was a `ps` env-var
  grep, which answers the wrong question — it proves the key exists in the
  process environment, not that the **gateway** ever registered anything.
- **trip-intake gateway** — has to reconnect to the sidecar and re-read SOUL
  after either changes, and the only trustworthy confirmation is what it
  itself logged, not what the deployer assumes happened.
- **relay** — restarting it mid-conversation drops whatever Telegram update
  is in flight. It's fetched by the dying process and never handled;
  Telegram considers it delivered regardless. This happened live and ate an
  organizer's message.

[deploy.sh](deploy.sh) is that checklist as a script that fails loudly instead
of assuming:

```bash
.agents/skills/interview-stack-deploy/deploy.sh
```

It builds, restarts the API, restarts the sidecar, deploys SOUL and restarts
the gateway, then **extracts the expected `*_for_chat` tool names straight
from `interview-mcp.ts`'s source** and greps the gateway's own post-restart
log line for every one of them — so "the agent has its tools" is a fact read
off the gateway, not inferred from an upstream process being alive. Then it
restarts the relay, but **not** if a session looks mid-turn
(`awaiting = 'machine'`, updated in the last 5 minutes) — it stops and prints
which chat, rather than silently eating someone's message.

Flags:

- `--skip-gateway` — when only control-plane code changed and SOUL did not,
  so there is nothing for the gateway to re-read.
- `--force-restart-relay` — restart the relay over its own live-conversation
  guard, once you have actually confirmed with the person on that chat that
  it's safe.

What it deliberately does **not** do: decide whether to deploy at all (still
a human call, per CLAUDE.md hard rule 2), reset a trip or mint a link
(`scripts/fresh-interview.py`), or touch git. Build → restart → verify, and
stop the moment a check fails rather than moving on to the next service on an
unverified assumption.
