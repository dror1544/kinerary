#!/usr/bin/env bash
# vm-interview-runner.sh — which model CLI the interview uses on the Proxmox VM.
#
#   control-plane/deployment/vm-interview-runner.sh status
#   control-plane/deployment/vm-interview-runner.sh login codex        # the interview's OWN codex login
#   control-plane/deployment/vm-interview-runner.sh probe codex        # one real call; changes nothing
#   control-plane/deployment/vm-interview-runner.sh codex              # switch both tasks to Codex
#   control-plane/deployment/vm-interview-runner.sh claude             # back to the default
#   control-plane/deployment/vm-interview-runner.sh openrouter [model]
#
# The interview never falls back to another model on its own: model-runner.ts
# retries the SAME pinned model and then gives up, because on 2026-09-07 a
# fallback chain swapped models mid-interview and it finished in the wrong
# language. Falling back is a deployment decision — this is that decision, as
# one command: it sets runner AND model for both tasks (a codex runner asked for
# provisioning.env's claude-sonnet-5 would fail), refuses a runner with no
# credential, and restarts the relay through vm-relay-restart.sh, which refuses
# while an interview is mid-turn.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM_ENV=/opt/kinerary-deploy/vm.env
C=(sudo docker compose -f "$DIR/compose.vm.yml" --env-file /opt/kinerary-deploy/provisioning.env --env-file "$VM_ENV")
RELAY=kinerary-cp-relay-1
die() { printf 'vm-interview-runner: %s\n' "$1" >&2; exit 1; }

probe() {  # probe <runner> [model]
  sudo docker cp "$DIR/runner-probe.mjs" "$RELAY:/tmp/runner-probe.mjs" >/dev/null
  sudo docker exec "$RELAY" node /tmp/runner-probe.mjs "$@"
}
has_credential() {
  case "$1" in
    claude)     sudo docker exec "$RELAY" sh -c '[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]' ;;
    codex)      sudo test -s /opt/agent-auth/codex/auth.json ;;
    openrouter) sudo docker exec "$RELAY" sh -c '[ -n "$OPENROUTER_API_KEY" ]' ;;
    *) return 1 ;;
  esac
}
# One default model per runner, shared by probe and switch so they cannot drift:
# claude has no runner default of its own (blank = NOT_CONFIGURED); codex's is
# model-runner's CODEX_LUNA_MODEL; blank for openrouter = its per-task default.
default_model() {
  case "$1" in claude) echo claude-sonnet-5 ;; codex) echo gpt-5.6-luna ;; *) echo "" ;; esac
}
current() { sudo docker exec "$RELAY" sh -c 'echo "interpret=$INTERPRET_RUNNER/${INTERPRET_MODEL:-default}  extract=$EXTRACT_RUNNER/${EXTRACT_MODEL:-default}"'; }

cmd="${1:-status}"
case "$cmd" in
  status)
    echo "in use: $(current)"
    for r in claude codex openrouter; do printf '  %-10s credential: %s\n' "$r" "$(has_credential $r && echo yes || echo no)"; done
    ;;
  login)
    [ "${2:-}" = codex ] || die "only 'login codex' is interactive here — claude uses a setup-token (runbook: Credentials)"
    # Its own device login into CODEX_HOME — never a copy of Hermes's or the
    # Mac's: codex refresh tokens are single-use, and two holders of one lock
    # each other out. Interactive (-it) so the code is read in YOUR terminal.
    sudo install -d -m 0700 -o 1000 -g 1000 /opt/agent-auth/codex
    rev="$(sudo sed -n 's/^KINERARY_REV=//p' "$VM_ENV")"
    sudo docker run --rm -it -e CODEX_HOME=/codex -v /opt/agent-auth/codex:/codex -w /tmp \
      "kinerary-cp/agent-runtime:$rev" codex login --device-auth
    has_credential codex || die "no codex credential was written — the login did not complete"
    echo "logged in — proving it with a real call:"
    probe codex
    ;;
  probe)
    r="${2:?probe needs a runner: claude|codex|openrouter}"; has_credential "$r" || die "$r has no credential on this VM"
    probe "$r" "${3:-$(default_model "$r")}"
    ;;
  claude|codex|openrouter)
    has_credential "$cmd" || die "$cmd has no credential on this VM — log it in first (runbook: Credentials)"
    model="${2:-$(default_model "$cmd")}"
    echo "probing $cmd before switching…"
    probe "$cmd" "$model" >/dev/null || die "$cmd failed a real call — not switching (run: $0 probe $cmd $model)"
    sudo sed -i '/^INTERPRET_RUNNER=/d;/^INTERPRET_MODEL=/d;/^EXTRACT_RUNNER=/d;/^EXTRACT_MODEL=/d' "$VM_ENV"
    printf 'INTERPRET_RUNNER=%s\nINTERPRET_MODEL=%s\nEXTRACT_RUNNER=%s\nEXTRACT_MODEL=%s\n' "$cmd" "$model" "$cmd" "$model" | sudo tee -a "$VM_ENV" >/dev/null
    "$DIR/vm-relay-restart.sh"
    "${C[@]}" up -d --wait interview-mcp >/dev/null 2>&1
    echo "in use: $(current)"
    ;;
  *) echo "usage: $0 status | login codex | probe <runner> [model] | claude|codex|openrouter [model]" >&2; exit 2 ;;
esac
