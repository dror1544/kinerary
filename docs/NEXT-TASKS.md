# Next tasks — handoff to Claude Code

Paste the **Shared context** block once at the start of a session, then paste
whichever task you want to work on. Each task is self-contained after that.

---

## Shared context (paste first)

```text
You're working in the kinerary repo (~/Code/kinerary). Read FRAMEWORK.md and
mcp/PROVISIONING.md before changing anything.

Current state: branch updates/mcp-photos-and-packing-fix, HEAD 16cc689.
Run the tests with `cd tests && npm test` — 111 should pass before you start.
If they don't, stop and tell me rather than working on top of a red suite.

Architecture you need to know:

- One trip site, config-driven from trips/<slug>/trip.config.json, loaded once
  at boot into TRIP_CONFIG. There is no write path for that file over HTTP.
- /api/config is served with NO authentication at all. sanitizeConfig() strips
  hotel PINs, organizer-only participant needs, and organizer-only agent
  standing instructions before anything is served.
- authRequired accepts EITHER a family member's JWT or the agent's X-API-Key.
  It is not an organizer check — every kid on the trip passes it. Where
  organizer-only scoping is needed, use organizerOrAgentRequired (server.js).
- Visibility rules live in shared/needs-schema.js and shared/agent-schema.js.
  They fail safe by design: anything unrecognized resolves to the restrictive
  option. Do not "fix" that by making unknown values pass through.
- GET /api/config/warnings holds a blanket invariant: no raw trip.config.json
  value ever appears in the response. The server log keeps every value. Three
  separate leaks came from judging fields case-by-case as harmless; don't
  reintroduce an exemption.
- Two MCP servers: mcp/mcp.js (trip data, safe to expose publicly) and
  mcp/provision.js (creates trips, writes files, restarts containers, must
  stay LAN-only). Keep that boundary.

Working style I want: write the test first where it's practical, run the suite
before telling me something works, and if you touch a security-relevant path,
show me the actual request/response proving the thing is hidden — not a
description of the code.
```

---

## Task 1 — Stand up the provisioning MCP

Do this on the machine running the trip site, not the Mac mini running Hermes.

```text
Set up mcp/provision.js to run as an always-on service on this machine.

1. Generate PROVISION_API_KEY with `openssl rand -hex 32`. It must be at
   least 32 chars and MUST NOT equal MCP_API_KEY / HERMES_API_KEY — the
   server refuses to start otherwise, deliberately.
2. Add to ~/Code/kinerary/.env:
     PROVISION_API_KEY=<generated>
     PROVISION_PORT=3002
     PROVISION_BIND=<this host's LAN address>
     REPO_ROOT=<absolute path to the repo>
     ACTIVE_TRIP_DIR=./trips/<whatever is currently live>
   PROVISION_BIND must be the LAN address, not 127.0.0.1, because Hermes
   runs on a different machine. It must NOT be 0.0.0.0.
3. Install a launchd service (or whatever this box already uses) that runs
   `node mcp/provision.js` on boot and restarts on failure.
4. Before you finish, verify from ANOTHER machine on the LAN:
     curl -s http://<host>:3002/healthz          -> {"ok":true,...}
     curl -s -o /dev/null -w '%{http_code}' http://<host>:3002/sse   -> 401

Then check something I care about more than whether it runs: confirm this
port is NOT reachable through whatever tunnel or reverse proxy already fronts
the trip site. Show me the proxy config you checked. This server can write to
my filesystem and restart my containers — if it's publicly reachable, that's
worse than it not working at all.

Do not open a firewall port for it. Do not add it to any tunnel.
```

---

## Task 2 — Let the agent set participant avatars

```text
Add the ability for an agent to set a specific participant's avatar. Today
POST /api/auth/avatar/upload derives the filename from req.user.username, so
an agent authenticating with the API key files every image under "hermes" —
it can't set an avatar for anyone else.

What I want:

1. server.js: accept an optional `username` field on that endpoint, honoured
   ONLY when the caller authenticated via the agent API key. A family member
   with a JWT must never be able to set someone else's avatar by passing this
   field — that's the whole risk here, so make it structural, not a check
   that can drift. Reject an unknown username with 400.
2. mcp/mcp.js: a `set_participant_avatar` tool taking `username` and an
   absolute `filePath` on the machine running the MCP server. Follow the
   existing add_photo tool for the multipart upload pattern.
3. Tests in tests/server.test.js:
   - agent key + username -> writes that participant's avatar
   - family-member JWT + someone else's username -> does NOT reassign it
   - agent key + unknown username -> 400

Show me the failing JWT case actually failing before you make it pass.

Scope: I do NOT want participants losing the ability to upload their own
avatar from the site. That path stays exactly as it is.
```

---

## Task 3 — Support more than one organizer per trip

Do this **before** scaffolding any new trip — it's a schema change, and
migrating configs later is worse than getting it right now.

```text
agent.organizer is currently a single username string. Couples who plan a trip
together need two. Change it to support a list.

Read first: shared/agent-schema.js, and the three places organizer is
consumed — validation in .agents/skills/create-trip/driver.mjs, the boot-time
warning in server.js, and organizerOrAgentRequired() in server.js.

What I want:

1. Accept `organizers: ["alice", "bob"]`. Keep accepting the existing
   `organizer: "alice"` string and normalize it to a one-element list, so
   configs already written don't break. Put the normalizer in
   shared/agent-schema.js next to the other normalizers, not inline.
2. organizerOrAgentRequired becomes a membership test. Keep the current
   fail-closed behaviour: if no organizer is configured at all, NOBODY
   qualifies. Do not treat "unset" as "everyone" — that would publish every
   organizer-only note the moment a trip is scaffolded without an agent block.
3. driver.mjs validates every name in the list against participants[] and
   hard-fails naming the invalid one.
4. GET /api/agent/brief returns `organizers` as an array.
5. Update INTERVIEW.md §9.2 — it currently tells the interviewer that two
   co-organizers aren't supported and to note the request rather than fudge
   it. Replace that with asking whether anyone else should share the private
   channel, defaulting to just the interviewee.
6. Tests: a two-organizer fixture where both get 200 on /api/agent/brief and
   a third participant gets 403; plus a test that the legacy string form
   still works.

Keep the group/organizer disclosure semantics identical. This is about who
counts as an organizer, not about changing what organizers can see.
```

---

## Still outstanding (not tasks for Claude Code — mine to do)

- `git push -u origin updates/mcp-photos-and-packing-fix` and open the PR.
- Deploy to the site host, then
  `docker compose up -d --force-recreate trip-server`, then hard-refresh for
  `app.js?v=40`.
- Collapse the skill mirrors to one source of truth:
  ```bash
  cd ~/Code/kinerary
  rm -rf .claude/skills/create-trip
  ln -s ../../.agents/skills/create-trip .claude/skills/create-trip
  ```

## Known gaps, deliberately not scheduled

- **The test fixture's phases are named `ny` and `colorado`** — the same ids as
  legacy hardcoded references in `site/app.js`. That's why two crashes shipped
  undetected. Renaming them to neutral ids would surface this whole class of
  bug, but it churns `render.test.js` and `config.test.js`.
- **`CONFIG_WARNINGS` is computed once at boot** from the live config, so
  version snapshots served by `/api/config/versions/:version` are sanitized but
  never validated.
- **japan-2025 demos badly** — every task expired, and `trivia.total_questions`
  claims 10 over an empty bank, so the trivia tab never appears. The countdown
  now shows a proper finished state instead of a broken timer, but the rest is
  stale content, not code.
