# Merge deliberately into the fresh profile config. Secrets are absent.
# Cost-optimized routing for this Kinerary installation. These are model
# identifiers only; credentials remain in the target Hermes profile.
#
# THE PRIMARY MUST BE A MODEL THE ACCOUNT ACTUALLY SERVES. Until 2026-09-12
# this said `gpt-5.4-mini`, and every single turn began with
#
#   HTTP 400: "The 'gpt-5.4-mini' model is not supported when using Codex with
#              a ChatGPT account."
#
# followed by "anthropic requested but no Anthropic credentials found" — so
# every answer a family ever got came from the free OpenRouter tier, and on the
# evening it was found that tier was answering "Upstream error from Nvidia:
# Service temporarily overloaded". A companion improvising a shell command to
# reach tools it could not see is what a free overloaded model does under
# pressure; the model chain is the reason it was under pressure.
#
# `gpt-5.6-terra` is verified against this deployment's own Codex login (a
# one-word prompt, exit 0). Anthropic is NOT in the chain: the credential lists
# in `hermes auth list` and still does not resolve in the agent runtime — on the
# VM root profile as well as in a companion — so an entry for it buys a failed
# round trip per turn and nothing else. The `claude` CLI is this host's working
# Claude path, and that is the interview's runner, not a Hermes provider.
#
# The free tiers stay as LAST resorts rather than second choices: a slow answer
# from a real model beats a fast one from an overloaded free endpoint.
model:
  default: gpt-5.6-terra
  provider: openai-codex
fallback_providers:
  - provider: ollama-cloud
    model: gpt-oss:120b
  - provider: openrouter
    model: minimax/minimax-m3:free
  - provider: openrouter
    model: nvidia/nemotron-3-super-120b-a12b:free
  - provider: openrouter
    model: nvidia/nemotron-3-ultra-550b-a55b:free
  - provider: openrouter
    model: dots-studio/dots-3-note-preview:free
display:
  show_cost: true
# Same account, same reason as the chain above: a delegation configured onto a
# provider with no working credential fails at the moment it is needed.
delegation:
  model: gpt-5.6-terra
  provider: openai-codex
mcp_servers:
  $SITE_CONNECTION_NAME:
    transport: sse
    url: "SET_VIA_SECURE_CONFIG"
  # The companion's one line to the control plane (companion-mcp.ts): renaming
  # itself so the router hears the new name. The doubled dollar below is the
  # template's escape: the rendered file carries a single-dollar reference to
  # COMPANION_CONTROL_TOKEN, which Hermes expands from the profile's .env, where
  # the installer writes it at enrollment.
  trip-control:
    transport: sse
    url: http://127.0.0.1:4313/sse
    headers:
      Authorization: "Bearer $${COMPANION_CONTROL_TOKEN}"
agent:
  max_turns: 30
  # No shell, ever. A trip companion answers about a trip; it has never had a
  # reason to run a command, and on 2026-09-12 the reason it tried was that its
  # trip-mcp tools had not connected — so it improvised
  # `python3 -c "...subprocess... mcp call trip-mcp get_config..."` and the
  # family group got a security-scan approval prompt instead of an answer.
  #
  # Disabling the toolsets removes the improvisation rather than gating it: an
  # approval prompt in a family group is unanswerable (nobody there can judge
  # it, and a "yes" from a child would be a real shell command), and a
  # companion that cannot reach its tools should say so, not reach around them.
  #
  # `file` and `memory` stay: the companion reads its own references and
  # remembers its family. `cronjob` stays too — trip reminders are the job.
  disabled_toolsets:
    - terminal
    - code_execution

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

# Hermes's own first-contact onboarding, switched OFF.
#
# On 2026-09-12 a family group's first message to their companion was answered
# with Hermes's install-onboarding rather than the trip's: a self-introduction
# ending "type /help to see the available commands", followed by an offer to
# build a user profile ("tell me your name, what you do, how you like me to
# work"). Neither belongs in a family group. The arrival message is composed by
# the router, from facts, and pinned; the assistant's job is the trip, and the
# runtime it happens to run on is not the family's business.
#
# QUOTED deliberately. Bare `off` is a YAML 1.1 boolean, and the reader
# (agent/onboarding.py) tests `isinstance(mode, str) and mode.lower() == "off"`
# — so an unquoted value silently leaves the default "ask" in place, which is
# exactly the behaviour this block exists to switch off.
#
# `seen` is pre-marked as well, so the one-shot flag is already spent on a
# profile that has never spoken: the offer firing even once is the whole damage.
#
# What is NOT fixable from here: the plain first-contact note (gateway/run.py —
# "briefly introduce yourself and mention that /help shows available commands")
# has no config switch, and Hermes's slash gate cannot be closed from a profile
# either (gateway/slash_access.py enables gating only when a scope names at
# least one admin, and keeps `help`/`whoami` reachable for everyone regardless).
# Both are contained by the ROUTER instead, which sees every update and now
# answers commands itself rather than forwarding them — see companionHelpText.
onboarding:
  profile_build: "off"
  seen:
    profile_build_offered: true
