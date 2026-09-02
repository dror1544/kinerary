# FamilyTrip companion profile template

Neutral, duplicable Hermes profile material extracted from the reusable lessons in the mature FamilyTrip and trip-specific companion profiles. Organizer identity, assistant identity, trip facts, and interview preferences are injected only when rendering.

Reusable policy:
- separate family-group and organizer-private modes;
- use the live trip site as operational source of truth;
- update the same plan layer the site renders and verify both persisted and visible state;
- keep group answers concise, practical, and privacy-safe;
- never expose organizer-private instructions or participant needs;
- learn candidate facts from chat, but require organizer approval before durable/public writes;
- use observed Telegram group identity and current membership, never guessed IDs;
- publish only organizer-supplied trivia questions.

Deliberately excluded: auth/config secrets, `.env`, tokens, provider chat IDs, channel/session state, Telegram or WhatsApp stores, raw interview answers, logs, cron jobs, memories, organizer/participant names, bot names, trip URLs, booking confirmations, passwords, and runtime endpoints. The rendered overlay does include the approved, account-independent model identifiers and cheap-first fallback order for this Kinerary project; the target profile must have matching active credentials.

## Portable input contract

`handoff.schema.json` defines `trip_assistant_profile_input` version 1. It is generated only from an immutable, organizer-confirmed intake version. It uses opaque person/trip/handoff references, preserves the intake version and digest as provenance, and contains normalized group-safe, organizer-private, and participant-need records. Raw question-keyed answers and provider bindings remain in the control plane rather than being copied into the profile payload.

## Render and verify

```bash
python3 render_profile.py --input example.handoff.json --output /tmp/familytrip-profile
python3 validate_bundle.py /tmp/familytrip-profile
python3 -m unittest discover -s tests -v
```

## Create a real profile

```bash
hermes profile create <name> --no-skills --description "Trip companion for <trip>"
```

Then copy the rendered `SOUL.md`, `profile.yaml`, `references/`, and `skills/` into the fresh profile. Deliberately merge `config.overlay.yaml`; do not blindly replace the generated config. Configure site and messaging secrets through secure Hermes configuration, verify, and only then start the gateway.

The optional `--install-profile NAME` switch creates a fresh profile and copies the neutral overlay. It refuses to overwrite an existing profile and never writes tokens or starts a gateway.

## Required deployment bindings (not in the rendered bundle)

Two values are provider bindings, so `handoff.schema.json` deliberately keeps
them in the control plane rather than copying them into the profile payload.
The rendered bundle therefore cannot carry them, and a profile is not finished
until they are set in its own `.env`:

- **The trip connection.** `setup-mcp.sh` registers the MCP server and writes
  `MCP_<NAME>_API_KEY`. The server's name must match `site_connection_name`
  (default `trip-mcp`) — SOUL.md and `references/sources.md` tell the assistant
  to read through exactly that name, so a mismatch sends it scraping the public
  site instead. On japan-2026 it did: the bundle said `trip-site`, the server
  was `trip-mcp`, and the assistant fell back to fetching the URL and running
  code against it.
- **`TELEGRAM_HOME_CHANNEL`** — set it to the ORGANIZER'S DM, not the group.
  Unset, the gateway posts a "No home channel is set ... type /sethome" notice
  into whichever chat speaks first. It fires only on a session with no history,
  so with `session_reset` enabled it returns after every reset: an operations
  prompt in a family chat, on a schedule. It is also where cron output goes,
  and SOUL.md requires an organizer opt-in before anything proactive reaches
  the group.

## Register with trip-intake

This profile only receives messages if the shared bot (`trip-intake`, see
`profile-templates/trip-intake-interviewer/README.md`'s "Doubling as the
shared trip-companion host") is told to route to it — and as of this
writing, that path is not turned on: `trip-intake`'s `gateway.multiplex_profiles`
must stay `false` until one of the preconditions in that README section is
met (an allowlist entry alone does not make multiplexing safe — Hermes
always pulls the Hermes install's `default` profile into a multiplexed
gateway too, and colliding with `default`'s own bot is exactly the failure
this note exists to prevent). Check that section's status before assuming
this step is live.

Once it is safe to turn on, do both on the `trip-intake` profile before
starting this profile's gateway:

1. Add `<name>` to `trip-intake`'s `gateway.multiplex_profile_allowlist`.
   Never leave that key unset to "just add everyone" — an unset allowlist
   serves every profile the Hermes install has, including unrelated
   profiles that already run their own gateway, and collides with them.
2. Add a matching entry to `trip-intake`'s `gateway.profile_routes` for this
   trip's chat_id (platform/guild/channel — see
   `gateway/profile_routing.py` in hermes-agent for the exact shape).
3. Restart the `trip-intake` gateway so it picks up both changes.

Until then, give this trip's companion profile its own dedicated gateway
and bot token instead (`hermes -p <name> gateway setup` / `gateway start`,
same as the pre-shared-bot model) rather than waiting on `trip-intake` to
route to it.

Skipping registration (once it is live) is silent: the companion profile
exists and looks correctly configured, but the organizer's messages keep
going to `trip-intake` instead of this profile.
