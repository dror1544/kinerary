# Hermes Agent Remote-Control Guide

Verified on 2026-08-04 against the public `NousResearch/hermes-agent` repository and current project documentation.

## Bottom Line

Hermes Agent does expose supported remote-control surfaces:

1. **HTTP API server**: an OpenAI-compatible API exposed by the gateway process. This is the closest fit for programmatic remote control.
2. **Messaging gateway**: chat-based remote control through Telegram, Discord, Slack, WhatsApp, Signal, Email, Teams, and other supported platforms.
3. **CLI**: a local command-line entry point for starting chat, setup, model/tool configuration, gateway lifecycle, cron, and service management. It is not a standalone remote management client, but you run it on the host where Hermes is installed to expose the API or messaging gateway.

The installed package exposes these console scripts:

```toml
hermes = "hermes_cli.main:main"
hermes-agent = "run_agent:main"
hermes-acp = "acp_adapter.entry:main"
```

Sources:

- Repository README: https://github.com/NousResearch/hermes-agent
- API server docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/
- Messaging gateway docs: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/
- CLI commands docs: https://hermes-agent.nousresearch.com/docs/reference/cli-commands
- API server source: https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py
- Gateway config source: https://github.com/NousResearch/hermes-agent/blob/main/gateway/config.py
- CLI source: https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/main.py
- Project metadata: https://github.com/NousResearch/hermes-agent/blob/main/pyproject.toml

## Architecture

Hermes remote control is centered on the **gateway**. The gateway loads platform adapters, dispatches incoming messages or API requests into `AIAgent`, keeps per-session state, and delivers results back through the selected surface.

The API server is implemented as `APIServerAdapter` in `gateway/platforms/api_server.py`. It runs an `aiohttp` HTTP server and creates server-side Hermes agent runs. Tool execution happens on the API-server host unless Hermes is configured to use a remote terminal backend such as SSH, Docker, Modal, Daytona, Singularity, or Vercel Sandbox.

The messaging gateway uses platform adapters. Each incoming platform message goes through authorization, session lookup, transcript loading, normal Hermes agent execution, and response delivery.

## Setup

Install Hermes:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

On Windows PowerShell:

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

Run setup:

```bash
hermes setup
```

Optional Nous Portal setup:

```bash
hermes setup --portal
```

Start the interactive CLI:

```bash
hermes
```

Configure model and tools:

```bash
hermes model
hermes tools
hermes config set
hermes config get
hermes doctor
```

## Remote Control Through the HTTP API

### Enable the API server

The public docs show this in `~/.hermes/.env`:

```env
API_SERVER_ENABLED=true
API_SERVER_KEY=change-me-local-dev
API_SERVER_CORS_ORIGINS=http://localhost:3000
```

Current source behavior is stricter and slightly different: `gateway/config.py` requires a usable `API_SERVER_KEY` and then enables the `api_server` platform. `API_SERVER_ENABLED` alone is not enough. Use a strong token, at least 16 characters.

Recommended local-only config:

```env
API_SERVER_KEY=replace-with-a-long-random-token
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_MODEL_NAME=hermes-agent
```

Start the gateway:

```bash
hermes gateway
```

Or manage it as a service:

```bash
hermes gateway install
hermes gateway start
hermes gateway status
hermes gateway stop
hermes gateway restart
```

### Call the API

Base URL:

```text
http://127.0.0.1:8642/v1
```

Chat Completions example:

```bash
curl http://127.0.0.1:8642/v1/chat/completions \
  -H "Authorization: Bearer replace-with-a-long-random-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hermes-agent",
    "messages": [
      {"role": "user", "content": "Check the current directory and summarize what you find."}
    ]
  }'
```

Model discovery:

```bash
curl http://127.0.0.1:8642/v1/models \
  -H "Authorization: Bearer replace-with-a-long-random-token"
```

Capability discovery:

```bash
curl http://127.0.0.1:8642/v1/capabilities \
  -H "Authorization: Bearer replace-with-a-long-random-token"
```

Health check:

```bash
curl http://127.0.0.1:8642/health
curl http://127.0.0.1:8642/health/detailed
```

### Supported API surfaces

Current source lists these major endpoints:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/responses/{response_id}`
- `DELETE /v1/responses/{response_id}`
- `GET /v1/models`
- `GET /v1/capabilities`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/{session_id}`
- `PATCH /api/sessions/{session_id}`
- `DELETE /api/sessions/{session_id}`
- `GET /api/sessions/{session_id}/messages`
- `POST /api/sessions/{session_id}/fork`
- `POST /api/sessions/{session_id}/chat`
- `POST /api/sessions/{session_id}/chat/stream`
- `POST /v1/runs`
- `GET /v1/runs/{run_id}`
- `GET /v1/runs/{run_id}/events`
- `POST /v1/runs/{run_id}/approval`
- `POST /v1/runs/{run_id}/stop`
- `GET /health`
- `GET /health/detailed`

Use `/v1/capabilities` at runtime instead of assuming every deployment has the same endpoint set.

### Session continuity

The API server supports:

- `X-Hermes-Session-Id`: continue a specific Hermes session.
- `X-Hermes-Session-Key`: scope long-term memory for a stable external channel/user.
- `previous_response_id`: stateful continuation on the Responses API.

Session continuation requires API-key authentication because it can expose conversation history.

### Streaming and runs

For OpenAI-style clients, use streaming on Chat Completions or Responses if supported by the client.

For control-plane style integrations, prefer the runs API:

```bash
curl http://127.0.0.1:8642/v1/runs \
  -H "Authorization: Bearer replace-with-a-long-random-token" \
  -H "Content-Type: application/json" \
  -d '{"input": "Run a repository health check and report findings."}'
```

Then inspect status or stream events:

```bash
curl http://127.0.0.1:8642/v1/runs/RUN_ID \
  -H "Authorization: Bearer replace-with-a-long-random-token"

curl http://127.0.0.1:8642/v1/runs/RUN_ID/events \
  -H "Authorization: Bearer replace-with-a-long-random-token"
```

Stop a run:

```bash
curl -X POST http://127.0.0.1:8642/v1/runs/RUN_ID/stop \
  -H "Authorization: Bearer replace-with-a-long-random-token"
```

## Remote Control Through Messaging

Run the gateway setup wizard:

```bash
hermes gateway setup
```

Start the gateway:

```bash
hermes gateway
```

Or run it as a service:

```bash
hermes gateway install
hermes gateway start
hermes gateway status
```

Hermes supports many messaging platforms, including Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, Home Assistant, Mattermost, Matrix, DingTalk, Feishu/Lark, WeCom, Weixin, BlueBubbles, QQ, Yuanbao, Microsoft Teams, LINE, ntfy, and browser-based access.

Useful shared chat commands include:

```text
/new
/reset
/model [provider:model]
/personality [name]
/retry
/undo
/compress
/usage
/skills
/stop
/status
```

Messaging is a practical remote-control path because authorized users can DM or mention the bot while Hermes runs on a VPS, workstation, or cloud VM.

## CLI Commands

Core commands verified from docs/source:

```bash
hermes                         # interactive terminal chat
hermes chat                    # interactive chat
hermes model                   # choose provider/model
hermes tools                   # configure tools
hermes config set              # set config values
hermes config get              # read config values
hermes setup                   # full setup wizard
hermes gateway                 # run gateway in foreground
hermes gateway setup           # configure messaging platforms
hermes gateway install         # install service
hermes gateway start           # start service
hermes gateway stop            # stop service
hermes gateway restart         # restart service
hermes gateway status          # service status
hermes gateway list            # list profile gateways
hermes cron                    # manage scheduled jobs
hermes doctor                  # diagnose installation/config
hermes update                  # update Hermes
hermes send --to <target> "message text"
hermes acp                     # run ACP server for editor integration
```

`hermes send` is useful for one-shot delivery to configured messaging platforms from scripts or monitoring jobs. It does not start a full agent conversation loop by itself.

For multiple profiles:

```bash
hermes -p research gateway start
hermes -p research gateway status
hermes -p research gateway stop
```

## Security Considerations

- Treat API access as full agent access. The API server can drive tools, terminal commands, file operations, memory, and skills.
- Keep `API_SERVER_HOST=127.0.0.1` unless you intentionally expose it over a private network, VPN, reverse proxy, or SSH tunnel.
- Always set a strong `API_SERVER_KEY`; current source requires a usable key for normal startup.
- Do not expose `0.0.0.0:8642` directly to the public internet.
- If browser clients call Hermes directly, set `API_SERVER_CORS_ORIGINS` to a narrow allowlist.
- Prefer a reverse proxy with TLS, IP allowlisting, and request-size/rate limits for any non-local deployment.
- For messaging platforms, configure allowed users, roles, groups, or channels. Do not enable allow-all settings except in trusted environments.
- Remember that tool execution happens where Hermes runs unless a remote/sandbox terminal backend is configured.
- Use Docker, SSH, Modal, Daytona, Singularity, or another supported terminal backend when you need stronger isolation from the host.
- Protect `~/.hermes/.env`, because it contains provider keys, bot tokens, and API server credentials.

## Limitations

- The API server is OpenAI-compatible but not identical to every OpenAI API feature. Check `/v1/capabilities` for the running version.
- The API adapter is mostly request/response oriented; source marks `supports_async_delivery = False`, so background delivery semantics differ from chat platforms.
- API clients need to send full conversation history unless they use supported session or response continuation mechanisms.
- The CLI is primarily local. For remote CLI use, connect to the machine running Hermes through SSH or a remote shell, then run `hermes` commands there.
- Messaging gateways depend on third-party platform availability, bot permissions, allowlists, and platform-specific mention/thread rules.
- Some docs lag source. In current source, a usable `API_SERVER_KEY` is the meaningful API-server enablement trigger; `API_SERVER_ENABLED=true` by itself is not sufficient.

## Recommended Deployment Patterns

### Local frontend

Use this when Open WebUI, LobeChat, or another frontend runs on the same host:

```env
API_SERVER_KEY=long-random-token
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
```

Point the frontend to:

```text
http://127.0.0.1:8642/v1
```

### Remote private access

Keep Hermes bound to localhost and tunnel over SSH:

```bash
ssh -L 8642:127.0.0.1:8642 user@hermes-host
```

Then call:

```text
http://127.0.0.1:8642/v1
```

### Mobile/chat access

Run:

```bash
hermes gateway setup
hermes gateway start
```

Configure Telegram, Discord, Slack, or another platform with strict allowed-user settings.

### Programmatic orchestrator

Use:

- `/v1/capabilities` for discovery.
- `/v1/runs` for asynchronous run submission.
- `/v1/runs/{run_id}/events` for lifecycle events.
- `/v1/runs/{run_id}/stop` for cancellation.
- `X-Hermes-Session-Key` to isolate memory per external user/channel.

