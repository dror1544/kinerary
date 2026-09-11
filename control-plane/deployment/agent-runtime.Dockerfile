# agent-runtime — the control-plane API image plus the two model CLIs that
# model-runner.ts shells out to: the relay's interpret path (claude) and the
# interview-MCP sidecar's extract path. Versions pinned to the pair verified on
# node:20-alpine on 2026-09-11.
#
# No credential is baked in. claude reads CLAUDE_CODE_OAUTH_TOKEN (minted with
# `claude setup-token` on a machine with a browser); codex reads CODEX_HOME,
# a volume logged in once with `codex login --device-auth`. Both are
# subscription logins, not API keys, and each instance holds its own — never a
# copy of the Mac's, whose rotating refresh tokens two holders would consume.
ARG BASE
FROM ${BASE}
USER root
RUN npm i -g @anthropic-ai/claude-code@2.1.197 @openai/codex@0.154.0 \
 && npm cache clean --force
USER node
