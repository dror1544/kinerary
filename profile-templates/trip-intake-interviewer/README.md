# Portable Hermes intake interviewer template

A neutral template for deploying a private intake interviewer on any Hermes Agent installation. It contains no organizer, operator, product, bot, model/provider, endpoint credential, chat ID, token, session, memory, log, or runtime state.

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

The installer creates a fresh profile and workspace and applies only non-secret safety settings. It never writes tokens, credentials, user IDs, model/provider settings, or starts a gateway.

Afterward:
1. Configure a model with `hermes -p <profile> model` if needed.
2. Add the service with `hermes -p <profile> mcp add interview --url <url> --auth header` (or its real auth mode), then `hermes -p <profile> mcp test interview`.
3. Verify discovery exposes only the four interview tools.
4. Run `hermes -p <profile> gateway setup`. Use a unique Telegram bot token in the profile `.env`, and restrict `TELEGRAM_ALLOWED_USERS` to authorized users.
5. Start and verify the dedicated gateway and one real enrollment flow before sending invitations.

Never use `--clone` or profile export/import for this template: they can carry personalization and runtime state.
