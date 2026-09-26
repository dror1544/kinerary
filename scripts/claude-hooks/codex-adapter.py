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
import unicodedata

ROOT = Path(__file__).resolve().parents[2]
POLICY_TIMEOUT = 20
# What Codex 0.153.2's apply_patch trims from a header line before taking its
# path: exactly Unicode White_Space (Rust str::trim), proven offline per code
# point in docs/test-reports/codex-hooks-2026-09-26.md ("Review round 1").
CODEX_TRIM = ("\t\n\x0b\x0c\r \x85\xa0\u1680" + "".join(map(chr, range(0x2000, 0x200b)))
              + "\u2028\u2029\u202f\u205f\u3000")


def denied(reason: str) -> dict:
    # Codex treats a deny with an empty reason as a failed hook and runs the call.
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny",
        "permissionDecisionReason": reason.strip() or "Kinerary policy denied this call",
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


def patch_path(value: str) -> str:
    # Codex writes the value as it stands: a leading U+0020 stays in the name,
    # and so would any other whitespace or control/format character, which
    # the shared hooks cannot be trusted to read the same way. Refuse those.
    if not value or any(ch != " " and (ch.isspace() or unicodedata.category(ch)[0] == "C")
                        for ch in value):
        raise ValueError("Invalid patch path")
    return value


def patch_paths(command: str) -> list[str]:
    """Every path Codex 0.153.2's apply_patch would touch, parsed as Codex parses.

    A state machine, not a per-line scan (measured against the offline engine,
    docs/test-reports/codex-hooks-2026-09-26.md): a file header is read, after
    trimming, only at header position; an Add body is the raw '+' lines after
    it; an Update body is everything up to a line whose RAW text starts with
    '***' (a trimmed '*** End of File' stays inside it). So an indented header
    inside an Update body is context, and anything else at header position
    that is not a header is refused, as Codex refuses it.
    """
    add, update, delete, move = ("*** Add File: ", "*** Update File: ",
                                 "*** Delete File: ", "*** Move to: ")
    # Split on "\n" (dropping a CR before it) as Rust's lines() does:
    # splitlines() also breaks on U+000B, U+001C-U+001E, U+0085, U+2028/9.
    lines = [line[:-1] if line.endswith("\r") else line
             for line in command.strip(CODEX_TRIM).split("\n")]
    if (len(lines) < 2 or lines[0].strip(CODEX_TRIM) != "*** Begin Patch"
            or lines[-1].strip(CODEX_TRIM) != "*** End Patch"):
        raise ValueError("Expected a complete apply_patch envelope")
    body, paths, i = lines[1:-1], [], 0
    while i < len(body):
        header = body[i].strip(CODEX_TRIM)
        i += 1
        kind = next((p for p in (add, update, delete) if header.startswith(p)), None)
        if kind is None:
            raise ValueError("Unrecognised apply_patch hunk header")
        paths.append(patch_path(header[len(kind):]))
        if kind == add:
            while i < len(body) and body[i].startswith("+"):
                i += 1
        elif kind == update:
            if i < len(body) and body[i].startswith(move):
                paths.append(patch_path(body[i].strip(CODEX_TRIM)[len(move):]))
                i += 1
            while i < len(body) and not (body[i].startswith("***") and
                                         body[i].strip(CODEX_TRIM) != "*** End of File"):
                i += 1
    if not paths:
        raise ValueError("No patch paths found")
    return list(dict.fromkeys(paths))


def on_disk(path: Path) -> Path:
    """`path` (absolute, under ROOT) spelled the way the filesystem stores it.

    On a case- or normalisation-insensitive filesystem `.PROJECT/sprint.json`
    and `.project/<U+017F>print.json` open the existing `.project/sprint.json`, and
    Path.resolve() keeps the spelling it was given. Each existing component is
    replaced by the directory entry that is the same file; a component that
    does not exist stays as written, because nothing can alias it.
    """
    current = ROOT
    for part in path.relative_to(ROOT).parts:
        try:
            names = os.listdir(current)
            wanted = os.lstat(current / part)
        except OSError:
            current = current / part
            continue
        if part not in names:
            same = []
            for name in names:
                try:
                    if os.path.samestat(os.lstat(current / name), wanted):
                        same.append(name)
                except OSError:
                    pass
            if len(same) != 1:
                raise ValueError("Patch path spelling does not match one directory entry")
            part = same[0]
        current = current / part
    return current


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
    # Preserve named policy paths as well as checking symlink destinations,
    # each in the spelling the filesystem will actually write.
    return list(dict.fromkeys(str(on_disk(p)) for p in (lexical, resolved)))


def handle(mode: str, payload: dict) -> dict:
    deadline = time.monotonic() + POLICY_TIMEOUT
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object")
    role = payload.get("agent_type")
    if "agent_type" in payload and not (
            isinstance(role, str) and role.strip()
            and not any(unicodedata.category(ch)[0] == "C" for ch in role)):
        # The shared hooks read it with $(jq ...): a shell drops NUL and strips
        # trailing newlines, so "\n" or "\u0000" would arrive empty, as the lead.
        raise ValueError("Invalid agent identity")
    if payload.get("agent_id") is not None and "agent_type" not in payload:
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
