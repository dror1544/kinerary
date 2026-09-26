#!/usr/bin/env python3
"""Translate Codex hook inputs/outputs; shared shell scripts own the policy.

Codex 0.153.2 does not implement PreToolUse `ask`: returning it fails open.
Represent that decision as a denial requiring the owner to take the action.
This adapter cannot force the runtime to execute a missing/untrusted hook or
make a runtime-level hook timeout fail closed. See the accompanying report.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
POLICY_TIMEOUT = 20


def denied(reason: str) -> dict:
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}


def run_policy(name: str, payload: dict, deadline: float) -> dict:
    for executable in ("bash", "git", "jq", "python3"):
        if not shutil.which(executable):
            raise ValueError("Required policy interpreter is unavailable: " + executable)
    checks = ROOT / "scripts" / "preflight-checks.sh"
    if not checks.is_file() or not os.access(checks, os.X_OK):
        raise ValueError("Required preflight policy is unavailable")
    if not (ROOT / "scripts" / "claude-hooks" / "match-command.py").is_file():
        raise ValueError("Required command classifier is unavailable")
    root_result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], text=True, capture_output=True,
        timeout=max(0.001, deadline - time.monotonic()),
    )
    if root_result.returncode or Path(root_result.stdout.strip()).resolve() != ROOT:
        raise ValueError("Policy is running outside its repository")
    script = ROOT / "scripts" / "claude-hooks" / name
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ValueError("Policy check exceeded its total time budget")
    result = subprocess.run(
        ["bash", str(script)], input=json.dumps(payload), text=True,
        capture_output=True, cwd=Path.cwd(), timeout=remaining,
    )
    if result.returncode:
        # Do not expose stderr: tool inputs and process diagnostics can contain secrets.
        raise ValueError("Shared policy failed (exit %s)" % result.returncode)
    output = json.loads(result.stdout) if result.stdout.strip() else {}
    if not isinstance(output, dict):
        raise ValueError("Shared policy returned a non-object")
    return output


def translate(output: dict) -> dict:
    if not output:
        return {}
    detail = output.get("hookSpecificOutput")
    if not isinstance(detail, dict) or detail.get("hookEventName") != "PreToolUse":
        raise ValueError("Shared policy returned an unsupported decision shape")
    decision = detail.get("permissionDecision")
    if decision not in ("allow", "ask", "deny"):
        raise ValueError("Shared policy returned an unsupported decision")
    reason = detail.get("permissionDecisionReason", "")
    if not isinstance(reason, str):
        raise ValueError("Shared policy returned an invalid reason")
    if decision == "ask":
        return denied("Owner approval required. Codex cannot turn this hook decision "
                      "into an approval prompt; the action is blocked. "
                      + reason)
    # A plain allow is not an input rewrite. Continue through the runtime's
    # normal sandbox/approval checks using its supported no-decision result.
    return {} if decision == "allow" else denied(reason)


def patch_paths(command: str) -> list[str]:
    lines = command.strip().splitlines()
    if not lines or lines[0] != "*** Begin Patch" or lines[-1] != "*** End Patch":
        raise ValueError("Expected a complete apply_patch envelope")
    paths = []
    for line in lines[1:-1]:
        for prefix in ("*** Add File: ", "*** Update File: ",
                       "*** Delete File: ", "*** Move to: "):
            if line.startswith(prefix):
                value = line[len(prefix):]
                if not value or "\x00" in value:
                    raise ValueError("Invalid patch path")
                paths.append(value)
                break
    if not paths:
        raise ValueError("No patch paths found")
    return list(dict.fromkeys(paths))


def checked_paths(value: str) -> list[str]:
    path = Path(value)
    if not path.is_absolute():
        path = Path.cwd() / path
    resolved = path.resolve()
    lexical = Path(os.path.abspath(path))
    try:
        resolved.relative_to(ROOT)
        lexical.relative_to(ROOT)
    except ValueError:
        raise ValueError("Patch path is outside this repository")
    # Preserve named policy paths as well as checking symlink destinations.
    return list(dict.fromkeys((str(lexical), str(resolved))))


def handle(mode: str, payload: dict) -> dict:
    deadline = time.monotonic() + POLICY_TIMEOUT
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object")
    if "agent_type" in payload and not isinstance(payload["agent_type"], str):
        raise ValueError("Invalid agent identity")
    if payload.get("agent_id") and not payload.get("agent_type"):
        raise ValueError("Subagent identity is missing its role")
    if mode == "session":
        result = run_policy("sessionstart.sh", payload, deadline)
        detail = result.get("hookSpecificOutput", {})
        if not isinstance(detail, dict) or detail.get("hookEventName") != "SessionStart":
            raise ValueError("Shared session hook returned invalid context")
        return result
    data = payload.get("tool_input")
    if not isinstance(data, dict):
        raise ValueError("Expected tool_input object")
    if mode == "bash":
        if not isinstance(data.get("command"), str) or not data["command"].strip():
            raise ValueError("Expected a nonempty shell command")
        return translate(run_policy("pretooluse-bash.sh", payload, deadline))
    if mode == "write":
        if isinstance(data.get("file_path"), str):
            paths = [data["file_path"]]
        elif isinstance(data.get("command"), str):
            paths = patch_paths(data["command"])
        else:
            raise ValueError("Expected patch command or file_path")
        checked = list(dict.fromkeys(p for path in paths for p in checked_paths(path)))
        for path in checked:
            translated = {**payload, "tool_input": {"file_path": path}}
            result = translate(run_policy("pretooluse-write.sh", translated, deadline))
            if result.get("hookSpecificOutput", {}).get("permissionDecision") == "deny":
                return result
        return {}
    raise ValueError("Unknown adapter mode")


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    try:
        result = handle(mode, json.load(sys.stdin))
    except Exception as exc:
        # A Python/OS failure must become a supported denial, not a nonzero
        # hook exit (which this Codex release treats as non-blocking).
        if mode == "session":
            # SessionStart cannot block tools; say clearly that context failed.
            result = {"systemMessage": "Kinerary SessionStart policy failed: " + str(exc)}
        else:
            result = denied("Kinerary hook adapter refused an invalid or failed policy check: "
                            + type(exc).__name__)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
