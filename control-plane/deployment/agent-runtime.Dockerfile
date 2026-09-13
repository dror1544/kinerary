# agent-runtime — the control-plane API image plus the two model CLIs that
# model-runner.ts shells out to: the relay's interpret path (claude) and the
# interview-MCP sidecar's extract path. Pinned to the versions the Mac's relay
# runs, deliberately — not npm's latest. On 2026-09-11 an older CLI (2.1.197)
# with the same model id returned no proposal for a one-word answer the Mac's
# 2.1.236 read correctly 4 times out of 4, and the interview stalled. Same model,
# different wrapper: bump these together with the Mac, never one side alone.
#
# No credential is baked in. claude reads CLAUDE_CODE_OAUTH_TOKEN (minted with
# `claude setup-token` on a machine with a browser); codex reads CODEX_HOME,
# a volume logged in once with `codex login --device-auth`. Both are
# subscription logins, not API keys, and each instance holds its own — never a
# copy of the Mac's, whose rotating refresh tokens two holders would consume.
ARG BASE
FROM ${BASE}
USER root
RUN npm i -g @anthropic-ai/claude-code@2.1.236 @openai/codex@0.153.2 \
 && npm cache clean --force
USER node
