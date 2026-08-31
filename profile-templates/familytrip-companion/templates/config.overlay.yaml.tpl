# Merge deliberately into the fresh profile config. Secrets are absent.
# Cost-optimized routing for this Kinerary installation. These are model
# identifiers only; credentials remain in the target Hermes profile.
model:
  default: gpt-5.4-mini
  provider: openai-codex
fallback_providers:
  - provider: anthropic
    model: claude-haiku-4-5-20251001
  - provider: openrouter
    model: nvidia/nemotron-3-ultra-550b-a55b:free
  - provider: openrouter
    model: minimax/minimax-m3:free
  - provider: openrouter
    model: nvidia/nemotron-3-super-120b-a12b:free
  - provider: openrouter
    model: dots-studio/dots-3-note-preview:free
  - provider: ollama-cloud
    model: gpt-oss:120b
  - provider: openai-codex
    model: gpt-5.6-terra
display:
  show_cost: true
delegation:
  model: claude-sonnet-4-6
  provider: anthropic
mcp_servers:
  $SITE_CONNECTION_NAME:
    transport: sse
    url: "SET_VIA_SECURE_CONFIG"
agent:
  max_turns: 30
