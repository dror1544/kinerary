# Apply using hermes config set; do not blindly replace generated config.
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
security:
  redact_secrets: true
privacy:
  redact_pii: true
approvals:
  mode: smart
agent:
  max_turns: 30
gateway:
  # This profile doubles as the single shared "companion bot" host for
  # provisioned trips instead of a dedicated bot per trip. As of Sprint 5 the
  # routing input is NOT the static profile_routes list below: the Kinerary
  # Trip Bot runs as a RELAY CONNECTOR, owns the Telegram connection, resolves
  # each inbound chat to a trip via the control plane, and stamps
  # source.profile on the wire event. Hermes honours that stamp only when
  # multiplex_profiles is true — _resolve_profile_for_key returns None
  # otherwise and every turn collapses into the agent:main namespace.
  #
  # This was false for a real reason, resolved 2026-08-31 (Hermes 0.20.5).
  # profiles_to_serve(multiplex=True) unconditionally prepends the install's
  # "default" profile BEFORE the allowlist is applied, and the allowlist cannot
  # exclude it. If "default" holds a live TELEGRAM_BOT_TOKEN — common, it is
  # usually someone's personal assistant — its mere presence auto-enables a
  # Telegram adapter that collides with whatever gateway already holds that
  # bot. What makes multiplexing safe is RELAY-EXCLUSIVE mode: setting
  # GATEWAY_RELAY_URL as an ENV STAMP (in this profile's .env, NOT as
  # gateway.relay_url here) disables every directly-connected messaging
  # platform, per profile, including "default"'s. The stamp reaches every
  # served profile because GATEWAY_RELAY_URL is on secret_scope's global env
  # allowlist rather than being profile-scoped.
  #
  # So: enable this ONLY together with a GATEWAY_RELAY_URL env stamp. On its
  # own it reintroduces the collision. Verify on the CURRENT install, not from
  # this template.
  multiplex_profiles: true
  # An EMPTY list means "serve only default" — a provided list acts as a filter
  # and default is always served regardless. ABSENT means "serve every profile
  # directory on this install," which is the dangerous reading: it sweeps in
  # unrelated profiles that may hold their own bot tokens and their own cron
  # jobs. Never leave it unset. List ONLY the companion profiles this host is
  # meant to serve, added one at a time as their trips are provisioned.
  multiplex_profile_allowlist: []
  # Unused under relay routing, kept for the non-relay path. source.profile
  # decides the target; a static platform/chat_id route table does not.
  profile_routes: []
