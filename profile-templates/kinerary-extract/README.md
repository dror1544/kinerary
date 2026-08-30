# kinerary-extract profile template

Single-turn document/URL data extraction profile for Kinerary's "Add Booking"
AI-extract feature. Reads one prompt (PDF, photo, URL, or raw text), returns
structured JSON, and exits. No memory, no persistence, no gateway.

Deliberately excluded: auth/config secrets, `.env`, tokens, credentials,
chat IDs, session state, logs, and runtime endpoints. The overlay includes
the approved model routing policy; the target Hermes profile must have
matching active credentials.

## Render and verify

```bash
python3 render_extract.py --input example.setup.json --output /tmp/kinerary-extract
python3 validate_bundle.py /tmp/kinerary-extract
python3 -m unittest discover -s tests -v
```

## Install on a Hermes instance

```bash
python3 render_extract.py --input setup.json --output /tmp/kinerary-extract \
  --install-profile kinerary-extract
```

The installer creates a fresh profile and copies the overlay. It never writes
credentials, starts a gateway, or enables persistence tools.

Afterward:
1. Ensure `openai-codex` OAuth and `anthropic` OAuth are active on the target Hermes install.
2. Verify the profile responds: `hermes -p kinerary-extract -z "reply OK only"`
3. Check which model handled it via `hermes -p kinerary-extract sessions list --limit 1`
   to confirm fallback is working if the primary is quota-limited.

## Model routing

Primary model is `gpt-5.6-luna-900k` (large context window — handles big PDFs
and multi-photo prompts). On quota exhaustion Hermes falls through automatically:

```
gpt-5.6-luna-900k  (openai-codex)   ← primary, large context
claude-sonnet-4-6  (anthropic)      ← fallback 1
gpt-oss:120b       (ollama-cloud)   ← fallback 2, free
gpt-5.6-sol        (openai-codex)   ← fallback 3, last resort
```

Delegation (complex reasoning tasks) routes to `claude-opus-4-6` via anthropic.
