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

`config.overlay.yaml.tpl` ships `gateway.multiplex_profiles: false` by
default, and getting this wrong doesn't fail loudly — it silently starts a
second connection for a bot token something else already holds. Read this
whole section before changing it, not just the config comment.

**An allowlist alone does not make this safe.** In the installed Hermes
source (`hermes_cli/profiles.py`'s `profiles_to_serve`), turning on
`multiplex_profiles` unconditionally adds this Hermes install's `default`
profile to the served set *before* `multiplex_profile_allowlist` is even
consulted — the allowlist can add or remove named profiles, but it cannot
exclude `default`. If `default` on this install has its own live bot token
(it usually does — `default` is normally someone's personal assistant
profile, not an empty placeholder), turning this on will make this gateway
try to start that bot's adapter a second time, colliding with whatever
already-running gateway currently holds it.

Before setting `multiplex_profiles: true`, confirm one of:
- `default` on this specific Hermes install has no enabled platforms (check
  its `config.yaml` **and** its `.env` — a bare `TELEGRAM_BOT_TOKEN` there
  auto-enables Telegram even with no `platforms:` block saying so), or
- this profile has been promoted to actually **be** `default` (so the
  unconditional inclusion is itself, which Hermes's own
  `_start_secondary_profile_adapters` already skips), or
- per-trip companion profiles get their own dedicated gateway instead of
  being hosted here at all (see `profile-templates/familytrip-companion/`'s
  "Register with trip-intake" section for the tradeoff).

Only once that's confirmed: turn it on, set `gateway.multiplex_profile_allowlist`
to an explicit list of companion profile names (never leave it unset — unset
means "every profile this install has," not just these), add one
`gateway.profile_routes` entry per allowlisted profile, and restart this
gateway.
