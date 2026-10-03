"""assistant_events — Hermes plugin reporting a trip companion's own tool-call
outcomes to the control plane's analytics pipeline (#177/#326's missing
assistant-side slice).

WHY THIS EXISTS. The relay's own emitter (control-plane/api/src/analytics/
emitter.ts) can record that a reply reached Telegram, but never whether the
tool behind it actually worked — it is blind to tools by construction, and
its contract (analytics/contract.ts) refuses an outcome of `answered` for
exactly that reason, on purpose, permanently. A trip's companion, running
under Hermes, is NOT blind to tools: it sees every `trip-mcp` call's result
directly. This plugin is that missing half, shaped the same way the
`langfuse` plugin in this same `plugins/` tree is shaped (`register(ctx)` +
`ctx.register_hook(name, fn)`) but reporting to Kinerary's own control plane
instead of a third-party tracer, and reporting a two-value VERDICT instead of
a full trace.

WHAT IT SENDS, AND WHAT IT NEVER SENDS. One POST per flushed batch to
`POST {ASSISTANT_EVENTS_INGEST_URL}` (control-plane/api, `/internal/
assistant-events/tool-outcomes`):

    {"profile": "<this trip's Hermes profile name>",
     "events": [{"event_id": "<uuid4>", "outcome": "grounded_answer"|"failed_tool"}]}

No tool name, no arguments, no result payload, no trip id, no chat id, no
message text — see analytics/contract.ts's own module doc for why that
allow-list exists; this plugin writes to the same closed vocabulary, not a
looser one of its own. `outcome` is NEVER `"answered"` — see
`classify_tool_outcome`'s docstring for the (deliberately conservative)
two-value classification and why "narrower, not looser" cuts the way it does
here specifically.

INERT BY DEFAULT. With `ASSISTANT_EVENTS_INGEST_URL` or
`ASSISTANT_EVENTS_INGEST_KEY` unset, `register()` still runs but every hook
no-ops immediately (checked first, before anything else) — the same posture
`ASSISTANT_EVENTS_ENABLED` gives the relay's own emitter: a deployment that
has not turned this on carries zero behavioural change and zero network
calls, not a silently-degraded one.

FAIL OPEN. Every hook function is wrapped so NOTHING it does can raise into
Hermes's own tool-call loop or add synchronous latency to it: classification
is pure and in-process (microseconds), and the actual HTTP POST — the one
part that can be slow or fail — runs on a short-lived daemon thread and is
never awaited. A dropped event here costs a few rows off a rate's
denominator; a delayed tool-call turn costs a family waiting on their
assistant. See `emitter.ts`'s own module doc for the relay-side statement of
the same principle — this plugin is the assistant-side one.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from typing import Any, Dict, FrozenSet, List, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request

logger = logging.getLogger(__name__)

# ── Configuration — inert unless both are set ───────────────────────────────

_INGEST_URL_ENV = "ASSISTANT_EVENTS_INGEST_URL"
_INGEST_KEY_ENV = "ASSISTANT_EVENTS_INGEST_KEY"
# Override for the resolved Hermes profile name; see _resolve_profile_name.
_PROFILE_OVERRIDE_ENV = "ASSISTANT_EVENTS_HERMES_PROFILE"
_DEBUG_ENV = "ASSISTANT_EVENTS_DEBUG"
_DEFAULT_TIMEOUT_S = 3.0


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _debug(message: str) -> None:
    if _env(_DEBUG_ENV).lower() in {"1", "true", "yes", "on"}:
        logger.info("assistant_events plugin: %s", message)


def _configured() -> bool:
    return bool(_env(_INGEST_URL_ENV) and _env(_INGEST_KEY_ENV))


# ── The trip-mcp / trip-control tools this plugin reports on ──────────────
#
# Deliberately an allow-list, not "every tool Hermes ever calls": a companion
# also carries file, web and delegation tools (CLAUDE.md, "Companion/monitor
# toolset exposure") that have nothing to do with trip data, and this plugin
# has no business emitting a trip-outcome fact for those. The list is the
# tool names `mcp/mcp.js` and `control-plane/api/src/companion-mcp.ts`
# register today (2026-10-03) — kept here as a literal rather than imported,
# because this file has to load inside a Python Hermes process with no access
# to this repo's TypeScript. A tool added to either file and not here simply
# gets no event, the same safe-by-omission failure shape `rollupAssistantEvents`
# already accepts for an event type it does not recognise — not a crash, not
# a wrong classification.
KNOWN_TOOL_NAMES: FrozenSet[str] = frozenset({
    # mcp/mcp.js (the trip SITE bridge)
    "health_check", "get_config", "get_agent_brief", "get_photos", "add_photo",
    "delete_photo", "set_participant_avatar", "add_participant",
    "reset_participant_password", "bind_participant_telegram", "remove_participant",
    "set_telegram_group", "get_today", "get_companion_inbox", "publish_companion_reply",
    "publish_companion_group_update", "set_companion_connection", "set_trip_timezone",
    "publish_daily_message", "get_budget", "add_budget_item", "update_budget_item",
    "delete_budget_item", "get_rsvps", "get_ratings", "get_tasks", "get_lost_found",
    "post_lost_found", "resolve_lost_found", "get_venue_comments", "post_venue_comment",
    "get_photo_comments", "post_photo_comment", "get_bookings", "add_booking",
    "update_booking", "delete_booking", "upload_booking_confirmation",
    "get_booking_confirmation", "get_trivia_state", "trivia_control", "get_trivia_scores",
    "get_trivia_questions", "add_trivia_question", "get_phase_plan", "swap_plan_days",
    "set_plan_day_label", "add_plan_item", "update_plan_item", "delete_plan_item",
    "import_plan_from_bookings",
    # control-plane/api/src/companion-mcp.ts (the trip CONTROL server)
    "get_assistant_names", "set_assistant_names", "report_bug",
})

# Read-only tools where "did this retrieve something real" is the natural
# question; a write tool's "real data" instead means "a confirmation of what
# changed" (e.g. update_plan_item echoing the updated item). Kept as one set
# because the classifier below treats both the same way — see its docstring.


# ── Classification: conservative on purpose ─────────────────────────────────

def _looks_like_error(value: Any) -> bool:
    """True for the MCP error shape (`{"isError": true, ...}`) or a bare
    `{"error": <truthy>}` — the two shapes `mcp.js`'s tools and a thrown
    `apiGet`/`apiPost` can surface as a completed (not exception-raising)
    tool result."""
    if not isinstance(value, dict):
        return False
    if value.get("isError") is True:
        return True
    error = value.get("error")
    return bool(error) if isinstance(error, (str, dict)) else False


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, (list, dict, tuple, set)):
        return len(value) == 0
    return False


def _unwrap_mcp_content(value: Any) -> Any:
    """Hermes's own tool-calling layer may hand this hook either the raw MCP
    envelope (`{"content": [{"type": "text", "text": "<json>"}], ...}`, what
    `mcp.js`'s `ok()` produces) or an already-unwrapped value, depending on
    which layer normalizes first. Unwrap the former; pass the latter through
    unchanged — never raises, falls back to the original value on anything
    that doesn't parse."""
    if not isinstance(value, dict):
        return value
    content = value.get("content")
    if not isinstance(content, list):
        return value
    texts = [block.get("text") for block in content if isinstance(block, dict) and block.get("type") == "text"]
    texts = [t for t in texts if isinstance(t, str)]
    if not texts:
        return value
    joined = "\n".join(texts)
    try:
        return json.loads(joined)
    except (TypeError, ValueError):
        return joined


def classify_tool_outcome(tool_name: str, result: Any) -> Optional[str]:
    """`"grounded_answer"` | `"failed_tool"` | `None` (not a tool this plugin
    reports on at all — `tool_name` is not in `KNOWN_TOOL_NAMES`).

    DELIBERATELY CONSERVATIVE, and the direction of the conservatism matters:
    this REQUIRES a positive signal of real content before calling something
    `grounded_answer`; the absence of an explicit error is NOT enough. A
    `grounded_answer` feeds `grounded_answer_rate` (analytics/rates.ts), a
    rate the daily report treats as evidence the companion is trustworthy —
    a false POSITIVE there is a wrong claim about product quality. A false
    NEGATIVE (calling a real answer `failed_tool`) only costs one row off
    that rate's denominator, undercounting rather than overclaiming. So:

      1. An explicit MCP/HTTP error shape (`isError: true`, or a truthy
         `error` field, before or after unwrapping) → `failed_tool`.
      2. The unwrapped result is empty — `None`, `""`, `[]`, `{}` → `failed_tool`.
      3. The unwrapped result is a dict whose every value is itself empty by
         rule 2 (e.g. `get_phase_plan` returning `{"phases": []}`, or
         `get_today` returning `{"phase": null, "day": null}`) → `failed_tool`.
         KNOWN LIMIT, deliberately accepted rather than engineered around: an
         all-empty result can sometimes be a genuinely informative answer
         ("the trip hasn't started yet", "no bookings filed yet") rather than
         a failure to retrieve anything — this classifier cannot tell those
         apart from the shape alone, and per the asymmetry above, calling it
         `failed_tool` is the side to err on. A per-tool refinement (e.g.
         `get_today` before the trip starts is legitimately informative) is
         real follow-up work, not done here — see the handover.
      4. Anything else (non-empty, no error shape) → `grounded_answer`.
    """
    if tool_name not in KNOWN_TOOL_NAMES:
        return None
    unwrapped = _unwrap_mcp_content(result)
    if _looks_like_error(result) or _looks_like_error(unwrapped):
        return "failed_tool"
    if _is_empty(unwrapped):
        return "failed_tool"
    if isinstance(unwrapped, dict) and all(_is_empty(v) for v in unwrapped.values()):
        return "failed_tool"
    return "grounded_answer"


# ── Profile resolution ───────────────────────────────────────────────────────

def _resolve_profile_name() -> str:
    """The Hermes profile this process serves — `trips.hermes_profile`'s own
    value (migration 20260922060000), resolved server-side from this name by
    the ingest route; this plugin never learns or sends a trip id.

    An explicit override wins (useful for a multiplexed host or a test
    harness that cannot rely on the process's own Hermes home); otherwise
    `hermes_constants.get_process_hermes_home().name` — the per-trip
    profile directory's own basename, matching the shape
    `docs/per-trip-gateway-architecture.md` documents
    (`~/.hermes/profiles/<trip-derived-name>`). NOT independently verified
    against a running Hermes process by this change — see the handover for
    why, and for what to check before this ships live.
    """
    override = _env(_PROFILE_OVERRIDE_ENV)
    if override:
        return override
    try:
        from hermes_constants import get_process_hermes_home  # type: ignore

        return get_process_hermes_home().name
    except Exception as exc:  # pragma: no cover - fail-open
        _debug(f"could not resolve the Hermes profile name: {exc}")
        return ""


# ── Delivery: fire-and-forget, never on the agent's own path ───────────────

def _post_batch(url: str, key: str, profile: str, events: List[Dict[str, Any]], timeout_s: float) -> None:
    """Runs on its own daemon thread. Never raises — the thread has no
    handler above it, so an uncaught exception here would only ever become a
    silent, unobserved thread death; catching it and debug-logging is simply
    making that failure visible instead of invisible."""
    payload = json.dumps({"profile": profile, "events": events}).encode("utf-8")
    req = urllib_request.Request(
        url, data=payload, method="POST",
        headers={"Content-Type": "application/json", "X-Api-Key": key},
    )
    try:
        with urllib_request.urlopen(req, timeout=timeout_s) as response:
            _debug(f"posted {len(events)} event(s), status {response.status}")
    except urllib_error.HTTPError as exc:
        # Read-and-discard: never let the error body (which never carries
        # the key, per the ingest route's own contract, but may carry a
        # reason string) escape past a debug log.
        _debug(f"ingest route refused the batch: HTTP {exc.code}")
    except Exception as exc:  # pragma: no cover - fail-open
        _debug(f"could not reach the ingest route: {exc}")


def _send_async(events: List[Dict[str, Any]]) -> None:
    if not events:
        return
    url, key = _env(_INGEST_URL_ENV), _env(_INGEST_KEY_ENV)
    profile = _resolve_profile_name()
    if not profile:
        _debug("no Hermes profile resolved; dropping the batch rather than guessing a trip")
        return
    timeout_s = float(_env("ASSISTANT_EVENTS_TIMEOUT_S") or _DEFAULT_TIMEOUT_S)
    thread = threading.Thread(
        target=_post_batch, args=(url, key, profile, events, timeout_s),
        name="assistant-events-post", daemon=True,
    )
    thread.start()


def _build_event(outcome: str) -> Dict[str, Any]:
    return {"event_id": str(uuid.uuid4()), "outcome": outcome}


# ── Hooks ─────────────────────────────────────────────────────────────────

def on_post_tool_call(*, tool_name: str = "", result: Any = None, **_: Any) -> None:
    """Fires after every tool call completes (Hermes's `post_tool_call`
    hook). The one hook this plugin needs: a trip-mcp tool's SUCCESS or
    FAILURE is a fact about its *result*, which only this hook carries —
    see this module's own doc and the handover for why `api_request_error`
    (the other hook the brief suggested) is NOT registered: it fires for a
    failed LLM API request, not a tool call, and carries no `tool_name` or
    `result` at all, so there is nothing here to attribute to a specific
    trip-mcp tool's outcome.
    """
    if not _configured():
        return
    try:
        outcome = classify_tool_outcome(tool_name, result)
        if outcome is None:
            return
        _send_async([_build_event(outcome)])
    except Exception as exc:  # pragma: no cover - fail-open
        _debug(f"on_post_tool_call failed: {exc}")


def register(ctx) -> None:
    ctx.register_hook("post_tool_call", on_post_tool_call)
