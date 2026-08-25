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

Deliberately excluded: auth/config secrets, `.env`, tokens, provider chat IDs, channel/session state, Telegram or WhatsApp stores, raw interview answers, logs, cron jobs, memories, organizer/participant names, bot names, trip URLs, booking confirmations, passwords, and runtime endpoints.

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
