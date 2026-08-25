# Merge deliberately into the fresh profile config. Secrets are absent.
mcp_servers:
  $SITE_CONNECTION_NAME:
    transport: sse
    url: "SET_VIA_SECURE_CONFIG"
agent:
  max_turns: 30
