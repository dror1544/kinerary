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
import { inflateRawSync } from "node:zlib";
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
  | {
      ok: false;
      reason: "UNSUPPORTED_TYPE" | "TOO_LARGE" | "UNREADABLE" | "NO_TEXT" | "IDENTITY_DOCUMENT";
      detail?: string;
    };

/**
 * A passport or ID, refused before its text goes anywhere.
 *
 * An organizer sending one is not a mistake — they are handing over "the trip
 * documents" and a passport scan is in that pile. But it answers none of the
 * interview's questions, so the only thing sending it to a model achieves is
 * putting a passport number in a third party's logs. Declining costs nothing
 * and is the correct default for a bot that has just promised the organizer
 * their documents are safe with it.
 *
 * Two signals, because either alone is weak. The MRZ is decisive — the
 * `P<ISRSURNAME<<GIVEN<<<<<` band is a format almost nothing else produces —
 * and the filename catches a scan whose MRZ did not extract, which is common
 * for photographs of a page.
 *
 * Deliberately NOT a general "sensitive document" filter. Booking
 * confirmations carry names, ticket numbers and partial cards, and refusing
 * those would refuse the entire feature.
 */
export function looksLikeIdentityDocument(text: string, filename: string | undefined): boolean {
  const name = (filename ?? "").toLowerCase();
  // Latin terms take a word boundary; Hebrew ones must NOT. `\b` is defined
  // against `\w`, which is ASCII-only, so every Hebrew letter is a non-word
  // character and `\bדרכון\b` matches nothing at all — a Hebrew-named passport
  // would have gone straight through, which for these organizers is the likely
  // spelling. Caught by the test, not by reading the regex.
  if (/\b(passports?|identity card|id card)\b/.test(name)) return true;
  if (/(דרכון|דרכונים|תעודת זהות)/.test(name)) return true;
  if (/(^|[^a-z])pass\.(pdf|jpe?g|png)$/.test(name)) return true;
  // THE MRZ, and the `<` is the whole signature.
  //
  // The first attempt was `^[PIAC][<A-Z][A-Z]{3}[A-Z<]{6,}` — a document-type
  // letter followed by capitals — which matches the word CONFIRMATION. It
  // refused four of the USA trip's Booking.com confirmations as passports and
  // said nothing about it: the most valuable documents in the folder, silently
  // discarded by a privacy check.
  //
  // A machine readable zone is a long line of capitals, digits and `<` filler,
  // and the filler is what nothing else has. Requiring it costs no real
  // detection — no passport lacks it — and gives back every document whose
  // only crime was shouting.
  const MRZ_LINE = /^[A-Z0-9<]{28,}$/;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.includes("<") && MRZ_LINE.test(trimmed)) return true;
  }
  // A filler run on its own, for a scan whose lines came out wrapped.
  if (/<{8,}/.test(text)) return true;
  return false;
}

/** Types worth attempting. Anything else is refused by name, not guessed at. */
export function documentKindFor(mime: string | undefined, filename: string | undefined): "pdf" | "docx" | "xlsx" | "html" | "text" | null {
  const m = (mime ?? "").toLowerCase();
  const name = (filename ?? "").toLowerCase();
  if (m.includes("pdf") || name.endsWith(".pdf")) return "pdf";
  // A Word plan is one of the most common things an organizer already has —
  // the USA trip's own folder holds תוכנית_טיול_ארהב_יולי_2026.docx. Legacy
  // `.doc` is deliberately NOT here: it is a binary OLE format needing a real
  // parser, and almost nobody produces one by accident any more.
  if (m.includes("wordprocessingml") || name.endsWith(".docx")) return "docx";
  // A budget is a spreadsheet more often than anything else, and the USA
  // trip's folder has תכנון תקציב.xlsx beside the plan. Legacy `.xls` is left
  // out for the same reason as `.doc`.
  if (m.includes("spreadsheetml") || name.endsWith(".xlsx")) return "xlsx";
  // HTML earns its own kind rather than falling into `text`, because
  // `text/html` decoded raw is 90% markup and a model asked to read it spends
  // its attention on div soup. Real case: the USA trip's ESTA applications are
  // saved web pages, and an organizer saving a confirmation from a browser is
  // an entirely ordinary thing to do.
  if (m.includes("html") || /\.(html?|xhtml)$/.test(name)) return "html";
  // TODO(images): a photographed confirmation is refused here, and people
  // photograph confirmations constantly — the USA trip's own folder has a JPG
  // sitting among nineteen PDFs. This needs a vision model rather than a text
  // extractor, which is a different call with a different cost, so it is a
  // deliberate gap and not an oversight. `UNSUPPORTED_TYPE` already gives the
  // organizer an honest answer in the meantime.
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
 * One file out of a ZIP archive, or null.
 *
 * Hand-rolled rather than a dependency, because a `.docx` is the only reason
 * this exists and the part of ZIP it needs is small: find the entry in the
 * central directory, seek to its local header, inflate. `zlib.inflateRawSync`
 * does the actual work.
 *
 * Deliberately not a general ZIP reader — no encryption, no ZIP64, no
 * directory traversal, no recursion. It reads one named entry from an archive
 * an organizer sent, and anything it does not understand it declines.
 */
export function readZipEntry(bytes: Uint8Array, entryName: string): Buffer | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory, searched from the back — the comment field means
  // it is not at a fixed offset.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const wanted = Buffer.from(entryName, "utf8");

  for (let n = 0; n < entries; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen);

    if (name.equals(wanted)) {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
      // The LOCAL header's name/extra lengths, not the central one — they
      // differ often enough that using the central directory's values here
      // reads from the wrong offset.
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compressedSize);
      try {
        if (method === 0) return Buffer.from(data);
        if (method === 8) return inflateRawSync(data);
      } catch {
        return null;
      }
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * The readable text of a Word document.
 *
 * `word/document.xml` inside the archive, with paragraph and break tags turned
 * into newlines before every other tag is dropped — otherwise a trip plan's
 * every line runs into one paragraph and the dates stop being readable as
 * dates.
 */
export function docxToText(bytes: Uint8Array): string | null {
  const xml = readZipEntry(bytes, "word/document.xml");
  if (!xml) return null;
  return xml
    .toString("utf8")
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<\/w:(p|tr)>/g, "\n")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Every `<t>` run inside one XML element, joined — a cell's text can be split
 *  across several runs by formatting nobody cares about here. */
function xmlText(fragment: string): string {
  const runs = fragment.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [];
  return runs
    .map((r) => r.replace(/<[^>]+>/g, ""))
    .join("")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * The readable text of a spreadsheet.
 *
 * A budget is a spreadsheet more often than it is anything else — the USA
 * trip's planning folder has תכנון תקציב.xlsx sitting beside the Word plan —
 * and `budget_detail` is a question the interview asks.
 *
 * Rows become lines and cells become tabs, because that is the shape a model
 * reads a table in. `t="s"` cells are indexes into the shared string table,
 * which is the one piece of xlsx that cannot be skipped: without resolving it
 * every text cell reads as a small integer.
 *
 * KNOWN LOSS: dates are serial numbers in xlsx and come out as numbers, since
 * telling a date from a quantity needs the cell's format record. A budget's
 * amounts survive, which is what `budget_detail` is actually after; a
 * spreadsheet used as an itinerary would not fare as well.
 */
export function xlsxToText(bytes: Uint8Array, maxSheets = 12): string | null {
  const sharedXml = readZipEntry(bytes, "xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const shared = (sharedXml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) ?? []).map(xmlText);

  const lines: string[] = [];
  let found = 0;
  for (let n = 1; n <= maxSheets; n += 1) {
    const sheet = readZipEntry(bytes, `xl/worksheets/sheet${n}.xml`)?.toString("utf8");
    if (!sheet) {
      // Sheets are numbered from 1 and contiguous in every writer worth
      // supporting; stop at the first gap once something has been found.
      if (found > 0) break;
      continue;
    }
    found += 1;
    for (const row of sheet.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const cell of row.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const type = cell.match(/\st="([^"]+)"/)?.[1];
        if (type === "s") {
          const index = Number(cell.match(/<v>(\d+)<\/v>/)?.[1]);
          cells.push(Number.isInteger(index) ? shared[index] ?? "" : "");
        } else if (type === "inlineStr") {
          cells.push(xmlText(cell));
        } else {
          cells.push(cell.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "");
        }
      }
      const line = cells.join("\t").trimEnd();
      if (line.trim()) lines.push(line);
    }
  }
  return found > 0 ? lines.join("\n") : null;
}

/**
 * The readable text of an HTML page.
 *
 * Deliberately crude — drop what can never be prose, unwrap the rest, decode
 * the handful of entities that actually appear. A real parser would be a
 * dependency for no gain: nothing downstream cares about structure, only about
 * the words, and a booking confirmation's words survive this intact.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    // Block-level tags become newlines so lines do not run together; the rest
    // become spaces. A table of booking details is unreadable either way if
    // every cell collapses onto one line.
    .replace(/<\/?(p|div|br|tr|li|h[1-6]|table|section|article)\b[^>]*>/gi, "\n")
    .replace(/<\/(td|th)>/gi, "  ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
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
  } else if (kind === "docx") {
    const extracted = docxToText(bytes);
    if (extracted === null) return { ok: false, reason: "UNREADABLE", detail: "not a readable .docx" };
    raw = extracted;
  } else if (kind === "xlsx") {
    const extracted = xlsxToText(bytes);
    if (extracted === null) return { ok: false, reason: "UNREADABLE", detail: "not a readable .xlsx" };
    raw = extracted;
  } else if (kind === "html") {
    raw = htmlToText(new TextDecoder().decode(bytes));
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

  // Checked on the extracted text, before it is returned to anything that
  // would send it onward. The filename half could have been checked earlier;
  // both live here so there is exactly one place a passport can be refused.
  if (looksLikeIdentityDocument(tidied, filename)) {
    return { ok: false, reason: "IDENTITY_DOCUMENT" };
  }
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
