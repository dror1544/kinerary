# Telegram Login SSO

Telegram Login is optional and disabled unless every required environment value
is set. It signs an existing Kinerary participant into the same 30-day JWT
session used by password and Google login; it never creates a user account.

## Configuration

1. Copy `.env.example` to the deployment's untracked `.env` file.
2. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and
   `TELEGRAM_API_BASE_URL` from the Telegram deployment. Do not put any of
   them in `trip.config.json`, source code, or git.
3. Set `TELEGRAM_BOT_USERNAME` to the bot's public `@handle` (no `@`, e.g.
   `my_trip_bot`). Unlike the token, this is not a secret — it's what
   `GET /api/health` serves to the pre-auth browser so the login screen knows
   which widget to render. Leave it unset and the Telegram Login Widget stays
   hidden even if the login route itself is otherwise configured.
4. Make the bot an administrator in the configured group with permission to
   inspect membership. Telegram's `getChatMember` must be available to it.
5. Register the site's real HTTPS domain as this bot's Login Widget domain
   via `@BotFather` → the bot → domain setting. This is a manual, one-time,
   per-bot step; Telegram will not render or complete login for an
   unregistered domain.
6. Bind each allowed participant to their numeric Telegram account ID in that
   trip's server-side `trip.config.json`:

   ```json
   {
     "username": "participant-username",
     "telegram_id": "telegram-numeric-user-id"
   }
   ```

   `telegram_id` is removed by `sanitizeConfig()` and never returned from
   `GET /api/config`.

## Login endpoint

A Telegram Login widget or trusted browser client posts its complete callback
payload to `POST /api/auth/telegram-login` as JSON. The server:

1. Reconstructs Telegram's sorted data-check string (excluding `hash`) and
   validates the HMAC-SHA-256 signature using a SHA-256 hash of the bot token.
2. Rejects old or excessively future-dated callbacks. Configure the accepted
   age with `TELEGRAM_AUTH_MAX_AGE_SECONDS` (default: 86400 seconds).
3. Calls the configured Telegram API base's `getChatMember` for the configured
   group and permits only active member, administrator, creator, or active
   restricted statuses.
4. Matches the signed Telegram ID to an existing participant and returns the
   normal `{ token, user }` session response.

`GET /api/config` requires the resulting JWT (or the existing agent API key).
Do not proxy the bot token to the browser. Keep the configured API base URL in
environment configuration so a deployment can select its required Telegram API
endpoint without changing source code.

## Verification

```bash
cd tests
node --test --test-reporter=spec telegram-sso.test.js
npm test
```

The focused test uses a local Telegram API stub; it does not call Telegram or
require a real bot, chat, token, or account.
