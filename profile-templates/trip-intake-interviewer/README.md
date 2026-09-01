# Portable Hermes intake interviewer template

A neutral template for deploying a private intake interviewer on any Hermes Agent installation. It contains no organizer, operator, product, bot, endpoint credential, chat ID, token, session, memory, log, or runtime state. The overlay includes the Kinerary cost-optimized model routing policy; credentials are still configured separately in the target Hermes profile.

It expects a narrowly scoped service implementing `start_interview`, `get_session_status`, `submit_answer`, and `confirm_intake`; see `INTERVIEW-SERVICE-CONTRACT.md`.

## Render

```bash
python3 render_interviewer.py --input example.setup.json --output /tmp/intake-interviewer
python3 validate_bundle.py /tmp/intake-interviewer
```

## Install on another Hermes instance

```bash
python3 render_interviewer.py --input setup.json --output /tmp/intake-interviewer \
  --install-profile intakebot --workspace "$HOME/.hermes-workspaces/intakebot"
```

The installer creates a fresh profile and workspace and bundles non-secret settings, including the project model-routing overlay. It never writes credentials, user IDs, or starts a gateway. The overlay must be deliberately merged into the generated profile config as described below.

Afterward:
1. Configure a model with `hermes -p <profile> model` if needed.
2. Add the service with `hermes -p <profile> mcp add interview --url <url> --auth header` (or its real auth mode), then `hermes -p <profile> mcp test interview`.
3. Verify discovery exposes only the four interview tools.
4. Run `hermes -p <profile> gateway setup`. Use a unique Telegram bot token in the profile `.env`, and restrict `TELEGRAM_ALLOWED_USERS` to authorized users.
5. Start and verify the dedicated gateway and one real enrollment flow before sending invitations.

Never use `--clone` or profile export/import for this template: they can carry personalization and runtime state.

## Doubling as the shared trip-companion host

`config.overlay.yaml.tpl` ships `gateway.multiplex_profiles: true`, which is
only correct **together with a `GATEWAY_RELAY_URL` env stamp**. The two travel
together; either alone is a misconfiguration, and getting it wrong doesn't fail
loudly — it silently starts a second connection for a bot token something else
already holds (Telegram answers that with a 409).

**The full operational knowledge lives in the
`hermes-multiplex-relay` skill** (`.agents/skills/hermes-multiplex-relay/`):
allowlist semantics, why the `default` profile cannot be excluded, the cron
duplication the relay does *not* fix, and copy-paste commands that verify the
whole thing against a live install. Read it before touching any of these
settings; it is deliberately the single durable copy, because config comments
do not survive `hermes config set`.

The three things most likely to bite, in short:

- **`multiplex_profile_allowlist: []` serves NOTHING** (only `default`).
  *Absent* is what serves every profile on the install. Set it explicitly,
  always, and add companion profiles one at a time.
- **`default` is always served and there is no deny list.** It is harmless
  under relay-exclusive mode — its Telegram adapter is swept off — but only if
  it has no enabled cron jobs, which the relay does not touch.
- **`GATEWAY_RELAY_URL` as an env var ≠ `gateway.relay_url` in config.yaml.**
  Only the env form disables directly-connected adapters. The config form keeps
  them running beside the relay.

`gateway.profile_routes` is no longer the routing input: the connector stamps
`source.profile` per inbound chat and the gateway serves that turn from that
profile. The static route table is vestigial under the relay.
