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

# Sessions must NOT accumulate forever, and Hermes will not stop them on its
# own: SessionResetPolicy defaults to mode "none" — "sessions never auto-reset
# unless the user opts in" (changed from "both" in July 2026 because permanent
# history is what most users expect). For a general assistant that is a fine
# default. For a trip companion it is the wrong one, and expensively so:
#
#   - The trip's facts live on the SITE, reachable through the trip connection.
#     Conversation history is not the source of truth and is not supposed to be,
#     so discarding it costs little — the assistant re-reads what matters.
#   - Stale context is worse than absent context. A weeks-old thread invites the
#     assistant to answer from memory instead of reading, which is exactly the
#     false-provenance failure SOUL.md now forbids.
#   - Every turn re-sends the whole history. An unbounded thread on a trip that
#     runs for months is a bill that grows for no benefit.
#
# "both" resets at whichever comes first: a day boundary, or a day of silence.
# A family plans in bursts with long gaps, so either alone would miss half the
# cases.
session_reset:
  mode: both
  at_hour: 4
  idle_minutes: 1440
  notify: false
