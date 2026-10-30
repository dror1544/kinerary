#!/usr/bin/env python3
"""Capture what the relay assumes about Hermes, from Hermes' SOURCE (#380).

The relay copies Hermes wording and behaviour by hand: the error classifier it
must satisfy, the gateway's outbound wait, the approval and status lines the
leak filter stops, the relay contract, two log formats and the config keys the
companion overlay sets. This script reads those from a Hermes source tree and
writes them as one JSON fixture (`control-plane/api/test/fixtures/hermes-mirror.json`);
the relay's tests assert against the fixture, and `hermes-patches/BASE_REV`
names the revision the fixture must describe.

    python3 -I scripts/capture-hermes-mirror.py --source DIR --out FIXTURE [--revision REV]
    python3 -I scripts/capture-hermes-mirror.py --source DIR --check FIXTURE [--revision REV]

It never imports or runs Hermes: Python files are parsed with `ast`, the locale
catalog with a small line reader. Every anchor is a SYMBOL (a module constant, a
function and the variable or call inside it, a catalog key, a log format), never
a line number. An anchor that is missing or ambiguous is DRIFT: the script exits
2 naming it and writes nothing. An empty list is never a valid extraction.

Exit codes: 0 captured / equal, 1 --check found a difference, 2 anchor drift or
bad usage.

Strings are recorded lower-cased, as Hermes compares them. A templated string is
recorded as its template: `{name}` for a catalog placeholder, `{}` for an
f-string expression. Nothing here decides what the relay does with them.
"""
from __future__ import annotations

import argparse
import ast
import datetime
import difflib
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SCHEMA = 1


class AnchorError(Exception):
    """An anchor the capture looks for is missing, ambiguous or unreadable."""


# --------------------------------------------------------------------------- #
# What is read, by symbol. Adding a thing the relay mirrors = adding a line here.
# --------------------------------------------------------------------------- #
BASE_PY = "gateway/platforms/base.py"
WS_PY = "gateway/relay/ws_transport.py"
DESCRIPTOR_PY = "gateway/relay/descriptor.py"
ADAPTER_PY = "gateway/relay/adapter.py"
LOCALE = "locales/en.yaml"
CONFIG_DEFAULTS_PY = "hermes_cli/config_defaults.py"

#: Catalog keys of the text a chat sees when Hermes asks to run a command.
APPROVAL_LOCALE_KEYS = [
    "gateway.exec_approval.header",
    "gateway.exec_approval.smart_deny_heading",
    "gateway.exec_approval.smart_deny_line",
    "gateway.exec_approval.text_choice_once",
    "gateway.exec_approval.text_choice_session",
    "gateway.exec_approval.text_choice_always",
    "gateway.exec_approval.text_choice_deny",
    "gateway.exec_approval.deadline",
    "gateway.exec_approval.timed_out_notice",
]

#: Catalog keys of the gateway's own status lines (busy acks, home channel).
STATUS_LOCALE_KEYS = [
    "gateway.busy.steered_subagents_head",
    "gateway.busy.steered_head",
    "gateway.busy.redirected_head",
    "gateway.busy.subagent_working_head",
    "gateway.busy.compressing_head",
    "gateway.busy.queued_head",
    "gateway.busy.interrupting_head",
    "gateway.set_home.success",
    "gateway.notify.no_home_channel",
]

#: (file, function, what to read inside it) for status text that is built in code.
#: what: a variable name (every assignment to it) or "return".
STATUS_CODE_ANCHORS: List[Tuple[str, str, str]] = [
    ("agent/chat_completion_helpers.py", "try_activate_fallback", "notice"),
    ("agent/agent_init.py", "_build_codex_gpt5_autoraise_notice", "return"),
    ("agent/prompt_builder.py", "_truncate_content", "msg"),
    ("agent/prompt_builder.py", "_truncate_content", "remedy"),
]

#: (file, substrings that identify the logger call's format string).
LOG_FORMAT_ANCHORS: Dict[str, Tuple[str, List[str]]] = {
    "mcp_registered": ("tools/mcp_tool_discovery.py", ["MCP server '%s'", "registered %d tool(s):"]),
    "tool_completed": ("agent/tool_executor.py", ["tool %s completed ("]),
}

LOGGER_METHODS = {"debug", "info", "warning", "error", "critical", "exception", "log"}


# --------------------------------------------------------------------------- #
# Reading the tree
# --------------------------------------------------------------------------- #
class Source:
    """A Hermes source tree. Records every file it reads, for the hash list."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.read: Dict[str, str] = {}
        self._trees: Dict[str, ast.Module] = {}

    def text(self, rel: str) -> str:
        path = self.root / rel
        if not path.is_file():
            raise AnchorError(f"{rel}: file not found in the Hermes tree")
        data = path.read_bytes()
        self.read[rel] = hashlib.sha256(data).hexdigest()
        return data.decode("utf-8")

    def tree(self, rel: str) -> ast.Module:
        if rel not in self._trees:
            try:
                self._trees[rel] = ast.parse(self.text(rel), filename=rel)
            except SyntaxError as exc:
                raise AnchorError(f"{rel}: does not parse ({exc.msg}, line {exc.lineno})")
        return self._trees[rel]


def _one(items: List[Any], what: str) -> Any:
    if not items:
        raise AnchorError(f"{what}: not found")
    if len(items) > 1:
        raise AnchorError(f"{what}: ambiguous ({len(items)} matches)")
    return items[0]


def module_assign(tree: ast.Module, rel: str, name: str) -> ast.expr:
    found = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            if any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
                found.append(node.value)
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name) and node.target.id == name and node.value is not None:
                found.append(node.value)
    return _one(found, f"{rel}: module constant {name}")


def find_function(tree: ast.Module, rel: str, name: str) -> ast.AST:
    found = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name]
    return _one(found, f"{rel}: function {name}")


def find_class(tree: ast.Module, rel: str, name: str) -> ast.ClassDef:
    found = [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == name]
    return _one(found, f"{rel}: class {name}")


def str_tuple(node: ast.AST, what: str) -> List[str]:
    if not isinstance(node, (ast.Tuple, ast.List)) or not node.elts:
        raise AnchorError(f"{what}: expected a non-empty tuple of strings")
    out = []
    for elt in node.elts:
        if not (isinstance(elt, ast.Constant) and isinstance(elt.value, str)):
            raise AnchorError(f"{what}: expected only string constants")
        out.append(elt.value)
    return out


# --------------------------------------------------------------------------- #
# Templates from string expressions
# --------------------------------------------------------------------------- #
def templates(node: ast.AST, what: str) -> List[str]:
    """Every string a (possibly conditional) string expression can be, lower-cased.

    A placeholder (f-string expression) is `{}`. An expression that is not a
    string at all is drift, not an empty template.
    """
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value.lower()]
    if isinstance(node, ast.JoinedStr):
        parts = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            else:
                parts.append("{}")
        return ["".join(parts).lower()]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return [a + b for a in templates(node.left, what) for b in templates(node.right, what)]
    if isinstance(node, ast.IfExp):
        return templates(node.body, what) + templates(node.orelse, what)
    if isinstance(node, ast.Call) or isinstance(node, ast.Name) or isinstance(node, ast.Attribute):
        return ["{}"]
    raise AnchorError(f"{what}: not a string expression ({type(node).__name__})")


def code_strings(src: Source, rel: str, function: str, what: str) -> Dict[str, str]:
    tree = src.tree(rel)
    func = find_function(tree, rel, function)
    label = f"{rel}:{function}:{what}"
    exprs: List[ast.AST] = []
    if what == "return":
        exprs = [n.value for n in ast.walk(func) if isinstance(n, ast.Return) and n.value is not None]
    else:
        # Every assignment to the variable, in source order; `+=` appends to the previous value.
        pieces: List[List[str]] = []
        for n in sorted((n for n in ast.walk(func) if isinstance(n, (ast.Assign, ast.AugAssign))),
                        key=lambda n: (n.lineno, n.col_offset)):
            targets = n.targets if isinstance(n, ast.Assign) else [n.target]
            if any(isinstance(t, ast.Name) and t.id == what for t in targets):
                alts = templates(n.value, label)
                if isinstance(n, ast.AugAssign):
                    if not pieces:
                        raise AnchorError(f"{label}: `+=` before any assignment")
                    pieces = [[p + alt for p in prev for alt in alts] for prev in pieces]
                else:
                    pieces.append(alts)
        if not pieces:
            raise AnchorError(f"{label}: no assignment to {what}")
        out = {}
        flat = [alt for group in pieces for alt in group]
        for i, alt in enumerate(flat):
            out[label if len(flat) == 1 else f"{label}#{i}"] = alt
        return out
    if not exprs:
        raise AnchorError(f"{label}: nothing found")
    flat = [alt for expr in exprs for alt in templates(expr, label)]
    return {(label if len(flat) == 1 else f"{label}#{i}"): alt for i, alt in enumerate(flat)}


# --------------------------------------------------------------------------- #
# The locale catalog (YAML subset: nested mappings, quoted scalar values)
# --------------------------------------------------------------------------- #
_KEY_LINE = re.compile(r"^( *)([A-Za-z0-9_.\-]+):(?:[ \t]+(.*))?$")


def _scalar(raw: str, what: str) -> Optional[str]:
    raw = raw.strip()
    if not raw or raw.startswith("#"):
        return None  # a mapping opens here
    if raw[0] == '"':
        i = 1
        while i < len(raw):
            if raw[i] == "\\":
                i += 2
                continue
            if raw[i] == '"':
                break
            i += 1
        else:
            raise AnchorError(f"{what}: unterminated double-quoted value")
        try:
            return json.loads(raw[: i + 1])
        except ValueError:
            raise AnchorError(f"{what}: double-quoted value uses an escape this reader does not know")
    if raw[0] == "'":
        m = re.match(r"'((?:[^']|'')*)'", raw)
        if not m:
            raise AnchorError(f"{what}: unterminated single-quoted value")
        return m.group(1).replace("''", "'")
    if raw[0] in "|>":
        raise AnchorError(f"{what}: block scalars are not read by this script")
    return re.sub(r"\s+#.*$", "", raw)


def locale_scalars(text: str) -> Dict[str, List[str]]:
    out: Dict[str, List[str]] = {}
    stack: List[Tuple[int, str]] = []
    skip_deeper_than: Optional[int] = None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if skip_deeper_than is not None:
            if indent > skip_deeper_than:
                continue
            skip_deeper_than = None
        m = _KEY_LINE.match(line)
        if not m:
            continue
        indent, key, raw = len(m.group(1)), m.group(2), m.group(3) or ""
        while stack and stack[-1][0] >= indent:
            stack.pop()
        path = ".".join([k for _, k in stack] + [key])
        if raw.strip()[:1] in ("|", ">"):
            skip_deeper_than = indent
            continue
        value = _scalar(raw, path)
        if value is None:
            stack.append((indent, key))
        else:
            out.setdefault(path, []).append(value)
    return out


def locale_strings(src: Source, keys: List[str]) -> Dict[str, str]:
    scalars = locale_scalars(src.text(LOCALE))
    out = {}
    for key in keys:
        out[key] = _one(scalars.get(key, []), f"{LOCALE}: catalog key {key}").lower()
    return out


# --------------------------------------------------------------------------- #
# Sections
# --------------------------------------------------------------------------- #
def error_classifier(src: Source) -> Dict[str, List[str]]:
    tree = src.tree(BASE_PY)
    patterns = [p.lower() for p in str_tuple(module_assign(tree, BASE_PY, "_RETRYABLE_ERROR_PATTERNS"),
                                             f"{BASE_PY}: _RETRYABLE_ERROR_PATTERNS")]
    retryable = find_function(tree, BASE_PY, "_is_retryable_error")
    if not any(isinstance(n, ast.Name) and n.id == "_RETRYABLE_ERROR_PATTERNS" for n in ast.walk(retryable)):
        raise AnchorError(f"{BASE_PY}: _is_retryable_error no longer reads _RETRYABLE_ERROR_PATTERNS")
    timeout = find_function(tree, BASE_PY, "_is_timeout_error")
    tuples = [n for n in ast.walk(timeout) if isinstance(n, ast.Tuple)
              and n.elts and all(isinstance(e, ast.Constant) and isinstance(e.value, str) for e in n.elts)]
    timeout_patterns = [p.lower() for p in str_tuple(_one(tuples, f"{BASE_PY}: _is_timeout_error substring tuple"),
                                                     f"{BASE_PY}: _is_timeout_error")]
    return {"timeout_substrings": timeout_patterns, "retryable_substrings": patterns}


def outbound_timeout(src: Source) -> float:
    node = module_assign(src.tree(WS_PY), WS_PY, "_OUTBOUND_TIMEOUT_S")
    if not (isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool)):
        raise AnchorError(f"{WS_PY}: _OUTBOUND_TIMEOUT_S is not a number literal")
    return float(node.value)


def relay_contract(src: Source) -> Dict[str, Any]:
    dtree = src.tree(DESCRIPTOR_PY)
    version = module_assign(dtree, DESCRIPTOR_PY, "CONTRACT_VERSION")
    if not (isinstance(version, ast.Constant) and isinstance(version.value, int)):
        raise AnchorError(f"{DESCRIPTOR_PY}: CONTRACT_VERSION is not an int literal")
    cls = find_class(dtree, DESCRIPTOR_PY, "CapabilityDescriptor")
    fields = [n.target.id for n in cls.body if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name)]
    if not fields:
        raise AnchorError(f"{DESCRIPTOR_PY}: CapabilityDescriptor has no annotated fields")
    legacy = []
    for n in cls.body:
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "LEGACY_OPS" for t in n.targets):
            legacy.append(n.value)
    legacy_ops = str_tuple(_one(legacy, f"{DESCRIPTOR_PY}: CapabilityDescriptor.LEGACY_OPS"),
                           f"{DESCRIPTOR_PY}: LEGACY_OPS")

    ops = set()
    for rel in (ADAPTER_PY, WS_PY):
        for node in ast.walk(src.tree(rel)):
            if isinstance(node, ast.Dict):
                for k, v in zip(node.keys, node.values):
                    if (isinstance(k, ast.Constant) and k.value == "op"
                            and isinstance(v, ast.Constant) and isinstance(v.value, str)):
                        ops.add(v.value)
    # Task-card ops are built in one helper from its `op` argument, not as a literal frame.
    for node in ast.walk(src.tree(ADAPTER_PY)):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "_card_frame"
                and len(node.args) >= 2 and isinstance(node.args[1], ast.Constant)
                and isinstance(node.args[1].value, str)):
            ops.add(node.args[1].value)
    if not ops:
        raise AnchorError(f"{ADAPTER_PY}, {WS_PY}: no outbound `\"op\": <literal>` frame found")

    wtree = src.tree(WS_PY)
    request = find_function(wtree, WS_PY, "_request_response")
    frames = [n for n in ast.walk(request) if isinstance(n, ast.Dict)
              and any(isinstance(k, ast.Constant) and k.value == "type" for k in n.keys)
              and any(isinstance(k, ast.Constant) and k.value == "type" and isinstance(v, ast.Constant)
                      and v.value == "outbound" for k, v in zip(n.keys, n.values))]
    frame_dict = _one(frames, f"{WS_PY}: _request_response outbound frame dict")
    frame_fields = {k.value for k in frame_dict.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)}
    for node in ast.walk(request):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if (isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == "frame"
                        and isinstance(t.slice, ast.Constant) and isinstance(t.slice.value, str)):
                    frame_fields.add(t.slice.value)

    scope = find_function(src.tree(ADAPTER_PY), ADAPTER_PY, "_with_scope")
    meta_fields: List[str] = []
    for node in ast.walk(scope):
        if isinstance(node, ast.For) and isinstance(node.iter, ast.Tuple):
            for pair in node.iter.elts:
                if (isinstance(pair, ast.Tuple) and pair.elts and isinstance(pair.elts[0], ast.Constant)
                        and isinstance(pair.elts[0].value, str)):
                    meta_fields.append(pair.elts[0].value)
    if not meta_fields:
        raise AnchorError(f"{ADAPTER_PY}: _with_scope no longer loops over (key, cache) pairs")

    return {
        "contract_version": version.value,
        "descriptor_fields": fields,
        "legacy_ops": legacy_ops,
        "ops": sorted(ops),
        "outbound_frame_fields": sorted(frame_fields),
        "outbound_metadata_fields": sorted(meta_fields),
    }


def log_formats(src: Source) -> Dict[str, str]:
    out = {}
    for name, (rel, needles) in LOG_FORMAT_ANCHORS.items():
        found = set()
        for node in ast.walk(src.tree(rel)):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in LOGGER_METHODS and node.args):
                arg = node.args[0]
                if (isinstance(arg, ast.Constant) and isinstance(arg.value, str)
                        and all(n in arg.value for n in needles)):
                    found.add(arg.value)
        # Identical formats at several call sites are one format; different ones are ambiguous.
        out[name] = _one(sorted(found), f"{rel}: log format {name} ({' + '.join(needles)})")
    return out


def config_keys(src: Source) -> Dict[str, List[str]]:
    node = module_assign(src.tree(CONFIG_DEFAULTS_PY), CONFIG_DEFAULTS_PY, "DEFAULT_CONFIG")
    if not isinstance(node, ast.Dict):
        raise AnchorError(f"{CONFIG_DEFAULTS_PY}: DEFAULT_CONFIG is not a dict literal")
    keys: List[str] = []
    spreads: List[str] = []

    def walk(d: ast.Dict, prefix: List[str]) -> None:
        for k, v in zip(d.keys, d.values):
            if k is None:  # `**other`: keys we cannot know statically
                spreads.append(".".join(prefix))
                continue
            if not (isinstance(k, ast.Constant) and isinstance(k.value, str)):
                raise AnchorError(f"{CONFIG_DEFAULTS_PY}: DEFAULT_CONFIG has a non-literal key under {'.'.join(prefix) or '<top>'}")
            path = prefix + [k.value]
            keys.append(".".join(path))
            if isinstance(v, ast.Dict):
                walk(v, path)

    walk(node, [])
    if not keys:
        raise AnchorError(f"{CONFIG_DEFAULTS_PY}: DEFAULT_CONFIG is empty")
    return {"config_keys": sorted(set(keys)), "config_key_spreads": sorted(set(spreads))}


def extract(root: Path, revision: str, captured: str) -> Dict[str, Any]:
    src = Source(root)
    result: Dict[str, Any] = {"schema": SCHEMA, "revision": revision, "captured": captured}
    classifier = error_classifier(src)
    timeout = outbound_timeout(src)
    contract = relay_contract(src)
    approval = locale_strings(src, APPROVAL_LOCALE_KEYS)
    status = locale_strings(src, STATUS_LOCALE_KEYS)
    for rel, function, what in STATUS_CODE_ANCHORS:
        status.update(code_strings(src, rel, function, what))
    logs = log_formats(src)
    config = config_keys(src)
    result["source_files"] = dict(sorted(src.read.items()))
    result["error_classifier"] = classifier
    result["outbound_timeout_seconds"] = timeout
    result["approval_prompt_strings"] = approval
    result["status_strings"] = status
    result["relay_contract"] = contract
    result["log_formats"] = logs
    result["config_keys"] = config["config_keys"]
    result["config_key_spreads"] = config["config_key_spreads"]
    return result


# --------------------------------------------------------------------------- #
# Git: only to name the revision and refuse a patched read file. Never runs Hermes.
# --------------------------------------------------------------------------- #
def _git(root: Path, *args: str) -> str:
    proc = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise AnchorError(f"git {' '.join(args)} failed in the Hermes tree: {proc.stderr.strip()}")
    return proc.stdout


def render(data: Dict[str, Any]) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--source", required=True, help="a Hermes source tree (read, never imported or run)")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--out", help="write the fixture here")
    mode.add_argument("--check", metavar="FIXTURE", help="exit 1 with a diff when the tree no longer matches FIXTURE")
    ap.add_argument("--revision", help="the Hermes revision the tree is at (default: git rev-parse --short=10 HEAD)")
    ap.add_argument("--captured", help="capture date for --out (default: today); ignored by --check")
    ap.add_argument("--allow-dirty", action="store_true",
                    help="capture although a file read differs from the tree's git HEAD (records patched bytes)")
    args = ap.parse_args(argv)

    root = Path(args.source)
    try:
        if not root.is_dir():
            raise AnchorError(f"--source {root}: not a directory")
        revision = args.revision
        if not revision:
            if not (root / ".git").exists():
                raise AnchorError("--revision is required: the tree is not a git checkout")
            revision = _git(root, "rev-parse", "--short=10", "HEAD").strip()
        captured = args.captured or datetime.date.today().isoformat()
        data = extract(root, revision, captured)
        if (root / ".git").exists() and not args.allow_dirty:
            dirty = [f for f in data["source_files"]
                     if _git(root, "status", "--porcelain", "--", f).strip()]
            if dirty:
                raise AnchorError(
                    "these files differ from the tree's git HEAD, so the fixture would describe patched bytes, "
                    f"not revision {revision}: {', '.join(dirty)} (use --allow-dirty to capture anyway)")
    except AnchorError as exc:
        print(f"capture-hermes-mirror: DRIFT or bad input: {exc}", file=sys.stderr)
        print("no fixture written", file=sys.stderr)
        return 2

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(render(data), encoding="utf-8")
        print(f"wrote {out} (revision {revision}, {len(data['source_files'])} source files)")
        return 0

    try:
        recorded = json.loads(Path(args.check).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"capture-hermes-mirror: cannot read fixture {args.check}: {exc}", file=sys.stderr)
        return 2
    recorded["captured"] = data["captured"]  # a date is not a difference
    if recorded == data:
        print(f"fixture matches Hermes source at {revision}")
        return 0
    diff = difflib.unified_diff(render(recorded).splitlines(), render(data).splitlines(),
                                "fixture", f"hermes@{revision}", lineterm="", n=2)
    print("\n".join(diff))
    print("\nfixture differs from the Hermes source: recapture with "
          f"`python3 -I scripts/capture-hermes-mirror.py --source <tree> --revision {revision} --out {args.check}` "
          "after reading the diff", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
