/**
 * Turning an uploaded file into text.
 *
 * This did not exist. Reading a document was the interviewer AGENT's job, done
 * with pymupdf inside its own sandbox, so removing the agent removed the
 * ability to read a PDF at all — the ingress kept working, the organizer was
 * told "got it, reading it now", and nothing read anything. Three live runs
 * asked for information that was sitting in a file the bot had accepted.
 *
 * Deliberately just text. Whatever a document MEANS is `extractIntake`'s
 * problem, and keeping the two apart means the interesting half stays testable
 * without a model and this half stays testable without a prompt.
 */
import { extractText, getDocumentProxy } from "unpdf";

/** Beyond this a document is almost certainly not a trip plan. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/**
 * What a model can usefully be given. MiniMax M3 has a million tokens of
 * context and Codex is generous too, so this is not a model limit — it is a
 * "this is not a trip document any more" limit, and a booking PDF that runs
 * past it has almost certainly picked up a scanned appendix.
 */
export const MAX_DOCUMENT_CHARS = 200_000;

export type DocumentTextResult =
  | { ok: true; text: string; pages: number; truncated: boolean }
  | { ok: false; reason: "UNSUPPORTED_TYPE" | "TOO_LARGE" | "UNREADABLE" | "NO_TEXT"; detail?: string };

/** Types worth attempting. Anything else is refused by name, not guessed at. */
export function documentKindFor(mime: string | undefined, filename: string | undefined): "pdf" | "text" | null {
  const m = (mime ?? "").toLowerCase();
  const name = (filename ?? "").toLowerCase();
  if (m.includes("pdf") || name.endsWith(".pdf")) return "pdf";
  if (
    m.startsWith("text/") ||
    m.includes("json") ||
    m.includes("csv") ||
    /\.(txt|md|markdown|csv|json|ics)$/.test(name)
  ) {
    return "text";
  }
  return null;
}

/**
 * Collapses the whitespace a PDF extractor leaves behind without touching the
 * characters themselves.
 *
 * NOT a repair. A Hebrew PDF comes out with its RTL runs reversed — the Japan
 * booking prints check-in as "אין ק'צ19 Sep, 2026" — and it is tempting to try
 * to fix that here. It must not be: reversing runs by rule mangles the mixed
 * Hebrew/Latin lines that carry the actual dates, and a model reads the
 * scrambled form correctly anyway (verified on this document, 0 warnings). A
 * lossy repair upstream of a model that does not need it can only lose.
 */
export function tidyDocumentText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** Whether extraction produced anything a model could work with. */
export function hasUsableText(text: string): boolean {
  // A scanned PDF extracts to a handful of stray glyphs. The threshold is
  // deliberately low: a one-page hotel confirmation is a legitimate document.
  return text.replace(/\s+/g, "").length >= 40;
}

export async function documentText(
  bytes: Uint8Array,
  mime: string | undefined,
  filename: string | undefined,
): Promise<DocumentTextResult> {
  const kind = documentKindFor(mime, filename);
  if (!kind) return { ok: false, reason: "UNSUPPORTED_TYPE", detail: mime ?? filename ?? "unknown" };
  if (bytes.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: "TOO_LARGE", detail: String(bytes.length) };

  let raw: string;
  let pages = 1;
  if (kind === "text") {
    raw = new TextDecoder().decode(bytes);
  } else {
    try {
      const pdf = await getDocumentProxy(bytes);
      const out = await extractText(pdf, { mergePages: true });
      pages = out.totalPages;
      raw = Array.isArray(out.text) ? out.text.join("\n") : out.text;
    } catch (e) {
      return { ok: false, reason: "UNREADABLE", detail: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  const tidied = tidyDocumentText(raw);
  // A scan is the common case here, and it is not a fault anyone can fix by
  // retrying — it needs its own answer to the organizer, so it gets its own
  // reason rather than being folded into UNREADABLE.
  if (!hasUsableText(tidied)) return { ok: false, reason: "NO_TEXT" };

  return {
    ok: true,
    text: tidied.slice(0, MAX_DOCUMENT_CHARS),
    pages,
    truncated: tidied.length > MAX_DOCUMENT_CHARS,
  };
}
