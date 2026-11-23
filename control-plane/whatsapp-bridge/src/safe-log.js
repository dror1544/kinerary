/**
 * The bridge's only logger. It is a filter, not a formatter: whatever a caller
 * hands it, a log line carries states and counts and nothing a participant said
 * or is (spec 625, AC-27).
 *
 *  - A key must be a plain identifier.
 *  - A value must be a finite number, a boolean, or a short lower-case token
 *    (`connected`, `restart_required`, `515`). Anything else — an id, a name, a
 *    message, an error's message — is written as "[redacted]", whoever called
 *    and however innocent the call looked.
 *  - A token that carries a run of five or more digits is refused too: that is
 *    the shape of a phone number or an id, and a "state" is never one.
 *
 * Errors are reduced to `errorCode(err)`: a status code or a short code, never
 * the message, because a library error message is free to quote an id.
 */

const KEY_RE = /^[a-z][A-Za-z0-9_]{0,30}$/;
const TOKEN_RE = /^[a-z][a-z0-9_.:-]{0,39}$/;
const LONG_DIGITS_RE = /[0-9]{5,}/;

export function safeValue(value) {
  if (typeof value === "boolean") return value;
  // A number that long is shaped like a phone number or an id, not a count or a code.
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) < 1_000_000 ? value : "[redacted]";
  if (typeof value === "string" && TOKEN_RE.test(value) && !LONG_DIGITS_RE.test(value)) return value;
  return "[redacted]";
}

/** A status code or short code from an error, never its message. */
export function errorCode(err) {
  const status = err?.output?.statusCode ?? err?.statusCode ?? err?.data;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  const code = err?.code;
  if (typeof code === "string" && TOKEN_RE.test(code.toLowerCase())) return code.toLowerCase();
  return "error";
}

/**
 * What a crash may say: the error's NAME and the top stack frame's file and line,
 * never its message (a library error message is free to quote an id). The message
 * is stripped from the stack by value before the first frame is read, so a message
 * that imitates a frame cannot be mistaken for one.
 */
export function crashSummary(err) {
  const name = typeof err?.name === "string" && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "Error";
  let at = "unknown";
  try {
    let stack = String(err?.stack ?? "");
    const message = String(err?.message ?? "");
    const head = `${err?.name ?? "Error"}: ${message}`;
    if (message && stack.startsWith(head)) stack = stack.slice(head.length);
    else if (message) stack = stack.split(message).join("");
    const frame = stack.split("\n").find((l) => /^\s+at /.test(l));
    const m = frame && /([^\\/():\s]+):(\d+):\d+\)?\s*$/.exec(frame);
    if (m) at = `${m[1]}:${m[2]}`.toLowerCase();
  } catch {
    /* a crash report that crashes */
  }
  return { name: name.toLowerCase(), at };
}

/**
 * @param {(line: string) => void} [write] where a finished line goes; stderr by default
 */
export function createSafeLogger(write = (line) => process.stderr.write(`${line}\n`)) {
  function log(event, fields = {}) {
    const out = { event: safeValue(String(event)) };
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (!KEY_RE.test(key)) continue;
      out[key] = safeValue(value);
    }
    try {
      write(JSON.stringify(out));
    } catch {
      /* a logger that throws would take the handler with it */
    }
  }
  return { log };
}

/**
 * The object the library wants as its `logger`. Every method does nothing: the
 * library's own lines carry ids and keys, and it is not ours to filter.
 */
export function createSilentLibraryLogger() {
  const logger = {
    level: "silent",
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  };
  return logger;
}
