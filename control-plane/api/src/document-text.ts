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

/**
 * Names this reader. Bumped whenever a change here could make the same file
 * read differently, because a stored extraction is keyed by the reader that
 * produced its text — and a reading made by an older, lossier reader must not
 * be served as if the improved one had made it.
 */
export const DOCUMENT_READER_VERSION = "reader-2026-09-13.2";

/** Below this many non-space characters a PDF page is taken to be unread — a scan. */
const PAGE_USABLE_CHARS = 20;

/**
 * What was read, one unit at a time: a PDF page, a spreadsheet sheet, or the
 * whole of a document that has no reliable pages (a Word file has no fixed
 * pagination, and inventing page numbers for one would be making them up).
 *
 * `usable: false` is a page that yielded next to no text — almost always a
 * scanned page inside an otherwise readable PDF. A whole-document check passes
 * such a PDF happily as long as ONE page has text, which is exactly how a
 * nineteen-page scan with a typed cover sheet used to be reported as read.
 *
 * `cut: true` marks a unit that starts beyond the character budget, so the
 * truncation can be said in terms of what was actually lost. Offsets are counted
 * before whitespace collapsing, so a unit straddling the limit is approximate by
 * a few characters.
 */
export interface DocumentCoverageUnit {
  /** `image`: the whole file was read by a vision model — see document-vision.ts. */
  unit: "page" | "sheet" | "document" | "image";
  index: number;
  chars: number;
  usable: boolean;
  cut?: boolean;
}

export type DocumentTextResult =
  | { ok: true; text: string; pages: number; truncated: boolean; coverage: DocumentCoverageUnit[] }
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
 * DATES are decoded, not guessed. In xlsx a date is a serial day count — 46284
 * is 19 September 2026 — and the only thing that says a number is a date rather
 * than a price is the cell's number format. Handing the model the raw serial
 * and asking it to work out which numbers were dates is asking it to guess, and
 * a spreadsheet itinerary is exactly where a wrong guess costs a day. So the
 * cell's style is followed to its number format, date-shaped formats are turned
 * into ISO text on the workbook's own date system (1900 or 1904), and everything
 * else stays the number it was.
 *
 * Cells keep their COLUMNS: a row is laid out by each cell's reference, so an
 * empty column stays an empty field rather than shifting every value after it
 * one column left under the wrong header. A formula reads as its cached value;
 * one with no cached value has nothing to read, and is counted as unread rather
 * than passing silently as an empty cell.
 */
export function xlsxToText(bytes: Uint8Array, maxSheets = 12): string | null {
  const sheets = xlsxSheets(bytes, maxSheets);
  return sheets ? sheets.filter((sheet) => sheet.trim()).join("\n") : null;
}

/** The same, one string per sheet, so a reader can say which sheets it read. */
export function xlsxSheets(bytes: Uint8Array, maxSheets = 12): string[] | null {
  return xlsxSheetDetails(bytes, maxSheets)?.map((sheet) => sheet.text) ?? null;
}

function xmlAttribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

type CellDateKind = "date" | "time" | "datetime";

/** Built-in number formats that are dates or times (ECMA-376 §18.8.30, plus the CJK date ids). */
const BUILTIN_FORMAT_KIND = new Map<number, CellDateKind>([
  ...[14, 15, 16, 17, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58].map((id) => [id, "date"] as const),
  ...[18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56].map((id) => [id, "time"] as const),
  [22, "datetime"] as const,
]);

/**
 * Whether a custom format code shows a date, a time, both, or neither. Quoted
 * literals, escaped characters and bracketed locale or colour sections are
 * removed first — `[$-he-IL]` and `"days"` must not read as date tokens — and
 * then d/y mark a date and h/s mark a time.
 */
function formatCodeKind(code: string): CellDateKind | null {
  const bare = decodeXmlEntities(code)
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, "");
  const hasDate = /[dy]/i.test(bare);
  const hasTime = /[hs]/i.test(bare);
  if (hasDate && hasTime) return "datetime";
  if (hasDate) return "date";
  if (hasTime) return "time";
  return null;
}

interface WorkbookFormats {
  /** cellXfs index -> what kind of date the cell's format shows, if any. */
  styleKind: (CellDateKind | null)[];
  date1904: boolean;
}

function workbookFormats(bytes: Uint8Array): WorkbookFormats {
  const styles = readZipEntry(bytes, "xl/styles.xml")?.toString("utf8") ?? "";
  const custom = new Map<number, string>();
  for (const tag of styles.match(/<numFmt\b[^>]*>/g) ?? []) {
    const id = Number(xmlAttribute(tag, "numFmtId"));
    const code = xmlAttribute(tag, "formatCode");
    if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const styleKind = (xfs.match(/<xf\b[^>]*>/g) ?? []).map((tag) => {
    const id = Number(xmlAttribute(tag, "numFmtId") ?? "0");
    const code = custom.get(id);
    return code !== undefined ? formatCodeKind(code) : BUILTIN_FORMAT_KIND.get(id) ?? null;
  });
  const workbook = readZipEntry(bytes, "xl/workbook.xml")?.toString("utf8") ?? "";
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/i.test(workbook);
  return { styleKind, date1904 };
}

/**
 * A serial date as ISO text, on the workbook's date system. The 1900 system
 * counts 1900-02-29, a day that never existed (a Lotus 1-2-3 bug Excel kept for
 * compatibility), so serials from 61 on are one day ahead of a plain count.
 */
export function serialToIsoText(serial: number, kind: CellDateKind, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const whole = Math.floor(serial);
  const seconds = Math.round((serial - whole) * 86_400);
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : whole < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const iso = new Date(epoch + whole * 86_400_000 + seconds * 1000).toISOString();
  const day = iso.slice(0, 10);
  const clock = iso.slice(11, 16);
  return kind === "date" ? day : kind === "time" ? clock : `${day} ${clock}`;
}

/** A cell reference's column as a zero-based index: A→0, Z→25, AA→26. */
function columnIndex(reference: string | undefined): number | null {
  const letters = /^([A-Z]+)\d+$/.exec(reference ?? "")?.[1];
  if (!letters) return null;
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** Each sheet's text, and how many formula cells had no cached value to read. */
export function xlsxSheetDetails(bytes: Uint8Array, maxSheets = 12): { text: string; unread: number }[] | null {
  const sharedXml = readZipEntry(bytes, "xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const shared = (sharedXml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) ?? []).map(xmlText);
  const { styleKind, date1904 } = workbookFormats(bytes);

  const sheets: { text: string; unread: number }[] = [];
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
    const lines: string[] = [];
    let unread = 0;
    sheets.push({ text: "", unread: 0 });
    for (const row of sheet.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const cell of row.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const open = /^<c\b[^>]*/.exec(cell)?.[0] ?? "";
        const type = xmlAttribute(open, "t");
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1];
        let value: string;
        if (type === "s") {
          const index = Number(raw);
          value = Number.isInteger(index) ? shared[index] ?? "" : "";
        } else if (type === "inlineStr") {
          value = xmlText(cell);
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : "";
        } else if (raw === undefined) {
          value = "";
          if (/<f\b/.test(cell)) unread += 1;
        } else if (type === undefined || type === "n") {
          const kind = styleKind[Number(xmlAttribute(open, "s") ?? "0")] ?? null;
          value = (kind ? serialToIsoText(Number(raw), kind, date1904) : null) ?? decodeXmlEntities(raw);
        } else {
          value = decodeXmlEntities(raw);
        }
        // Placed at its own column, so a gap stays a gap. A reference absurdly
        // far to the right is appended rather than padded out to it.
        const column = columnIndex(xmlAttribute(open, "r"));
        const at = column !== null && column - cells.length <= 256 ? Math.max(column, cells.length) : cells.length;
        while (cells.length < at) cells.push("");
        cells[at] = value;
      }
      const line = cells.join("\t").trimEnd();
      if (line.trim()) lines.push(line);
    }
    sheets[sheets.length - 1] = { text: lines.join("\n"), unread };
  }
  return found > 0 ? sheets : null;
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
  options: { maxChars?: number } = {},
): Promise<DocumentTextResult> {
  const maxChars = options.maxChars ?? MAX_DOCUMENT_CHARS;
  const kind = documentKindFor(mime, filename);
  if (!kind) return { ok: false, reason: "UNSUPPORTED_TYPE", detail: mime ?? filename ?? "unknown" };
  if (bytes.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: "TOO_LARGE", detail: String(bytes.length) };

  let units: { unit: DocumentCoverageUnit["unit"]; index: number; text: string; unread?: number }[];
  let pages = 1;
  if (kind === "text") {
    units = [{ unit: "document", index: 1, text: new TextDecoder().decode(bytes) }];
  } else if (kind === "docx") {
    const extracted = docxToText(bytes);
    if (extracted === null) return { ok: false, reason: "UNREADABLE", detail: "not a readable .docx" };
    units = [{ unit: "document", index: 1, text: extracted }];
  } else if (kind === "xlsx") {
    const sheets = xlsxSheetDetails(bytes);
    if (sheets === null) return { ok: false, reason: "UNREADABLE", detail: "not a readable .xlsx" };
    units = sheets.map((sheet, i) => ({ unit: "sheet" as const, index: i + 1, text: sheet.text, unread: sheet.unread }));
  } else if (kind === "html") {
    units = [{ unit: "document", index: 1, text: htmlToText(new TextDecoder().decode(bytes)) }];
  } else {
    try {
      // A COPY. pdf.js takes ownership of the buffer it is given and detaches
      // it, so the caller's bytes came back empty: hashed afterwards, every PDF
      // on a trip had the digest of nothing; hashed before, the store refused
      // the write as a digest mismatch and no PDF original was ever kept.
      const pdf = await getDocumentProxy(bytes.slice());
      // Page by page, so a scanned page inside a typed PDF can be SEEN as
      // unread rather than disappearing into one merged string.
      const out = await extractText(pdf, { mergePages: false });
      pages = out.totalPages;
      units = out.text.map((text, i) => ({ unit: "page" as const, index: i + 1, text }));
    } catch (e) {
      return { ok: false, reason: "UNREADABLE", detail: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  const raw = units.map((u) => u.text).join("\n");
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

  let offset = 0;
  const coverage = units.map((u): DocumentCoverageUnit => {
    const piece = tidyDocumentText(u.text);
    const chars = piece.replace(/\s+/g, "").length;
    const start = offset;
    offset += piece.length + 1;
    return {
      unit: u.unit,
      index: u.index,
      chars,
      // A page with next to no text is a scan. A sheet is unread only where a
      // formula had no cached value — an empty sheet is an empty sheet. A Word
      // or text file either reads or is refused whole above.
      usable: u.unit === "page" ? chars >= PAGE_USABLE_CHARS : (u.unread ?? 0) === 0,
      ...(start >= maxChars ? { cut: true } : {}),
    };
  });

  return {
    ok: true,
    text: tidied.slice(0, maxChars),
    pages,
    truncated: tidied.length > maxChars,
    coverage,
  };
}
