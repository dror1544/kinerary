# Apply using hermes config set; do not blindly replace generated config.
security:
  redact_secrets: true
privacy:
  redact_pii: true
approvals:
  mode: smart
agent:
  max_turns: 30
gateway:
  # This profile CAN double as the single shared "companion bot" for
  # provisioned trips instead of a dedicated bot per trip: with multiplexing
  # on, Hermes swaps HERMES_HOME (SOUL.md/skills/config) per inbound chat
  # using the static profile_routes list below - see gateway/profile_routing.py
  # and gateway/run.py's _resolve_profile_home_for_source. There is no
  # dynamic control-plane lookup for this; profile_routes is the only input.
  #
  # DO NOT set this true without reading this: hermes_cli/profiles.py's
  # profiles_to_serve(multiplex=True) unconditionally includes the Hermes
  # install's "default" profile in the served set BEFORE the allowlist below
  # is applied - the allowlist cannot exclude it. If "default" on this
  # install has its own live bot token (common - it's usually someone's
  # personal assistant profile), turning multiplexing on here will try to
  # start that bot's adapter a second time and collide with whatever
  # already-running gateway holds it. An allowlist alone does not make this
  # safe. Confirm (per the CURRENT install, not this template) either that
  # "default" has no enabled platforms, or that this profile itself has been
  # promoted to BE "default", before flipping this on.
  multiplex_profiles: false
  # Once multiplex_profiles is safe to enable (see above), never leave this
  # unset: unset means "serve every profile directory this Hermes install
  # has," not just intended companions - including unrelated profiles that
  # already run their own separate gateway service. List ONLY the companion
  # profile names this host is meant to serve.
  multiplex_profile_allowlist: []
  # One entry per served companion profile. Add a route the moment its
  # profile is registered in the allowlist above - an allowlisted profile
  # with no route here is unreachable, not dangerous, but it means whoever
  # registered it forgot this line.
  profile_routes: []
