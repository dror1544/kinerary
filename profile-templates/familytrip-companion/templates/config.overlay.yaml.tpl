# Merge deliberately into the fresh profile config. Secrets are absent.
# Cost-optimized routing for this Kinerary installation. These are model
# identifiers only; credentials remain in the target Hermes profile.
model:
  default: gpt-5.4-mini
  provider: openai-codex
fallback_providers:
  - provider: anthropic
    model: claude-haiku-4-5-20251001
  - provider: ollama-cloud
    model: gpt-oss:120b
  - provider: openrouter
    model: nemotron-3-ultra-free
  - provider: openrouter
    model: gpt-4o-mini
  - provider: openai-codex
    model: gpt-5.5
display:
  show_cost: true
delegation:
  model: gpt-5.5
  provider: openai-codex
mcp_servers:
  $SITE_CONNECTION_NAME:
    transport: sse
    url: "SET_VIA_SECURE_CONFIG"
agent:
  max_turns: 30
