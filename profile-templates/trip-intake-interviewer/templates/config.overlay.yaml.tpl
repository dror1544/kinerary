# Apply using hermes config set; do not blindly replace generated config.
security:
  redact_secrets: true
privacy:
  redact_pii: true
approvals:
  mode: smart
agent:
  max_turns: 30
