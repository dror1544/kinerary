/**
 * Reading an upload into text.
 *
 * The ZIP half is hand-rolled binary parsing, so it gets a real archive built
 * here rather than a fixture checked into the repo — a .docx is a zip and
 * building one is a dozen lines, which is cheaper than a binary blob nobody
 * can review in a diff.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { docxToText, documentKindFor, documentText, readZipEntry, xlsxToText } from "../src/document-text.js";

/** A minimal single-entry ZIP, deflated, with correct local + central headers. */
/** A ZIP with several entries — an xlsx needs at least the sheet and the
 *  shared string table. */
function makeMultiZip(files: [string, string][]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [entryName, content] of files) {
    const name = Buffer.from(entryName, "utf8");
    const raw = Buffer.from(content, "utf8");
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localBlock = Buffer.concat([local, name, data]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));

    locals.push(localBlock);
    offset += localBlock.length;
  }
  const localAll = Buffer.concat(locals);
  const centralAll = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralAll.length, 12);
  eocd.writeUInt32LE(localAll.length, 16);
  return new Uint8Array(Buffer.concat([localAll, centralAll, eocd]));
}

function makeZip(entryName: string, content: string, store = false): Uint8Array {
  const name = Buffer.from(entryName, "utf8");
  const raw = Buffer.from(content, "utf8");
  const data = store ? raw : deflateRawSync(raw);
  const method = store ? 0 : 8;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(0, 14); // crc — not checked by the reader
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localBlock = Buffer.concat([local, name, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  const centralBlock = Buffer.concat([central, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return new Uint8Array(Buffer.concat([localBlock, centralBlock, eocd]));
}

describe("readZipEntry", () => {
  test("finds and inflates a deflated entry", () => {
    const zip = makeZip("word/document.xml", "<w:p>Tokyo</w:p>");
    assert.equal(readZipEntry(zip, "word/document.xml")?.toString("utf8"), "<w:p>Tokyo</w:p>");
  });

  test("reads a stored (uncompressed) entry too", () => {
    const zip = makeZip("word/document.xml", "<w:p>Kyoto</w:p>", true);
    assert.equal(readZipEntry(zip, "word/document.xml")?.toString("utf8"), "<w:p>Kyoto</w:p>");
  });

  test("null for an entry that is not there", () => {
    assert.equal(readZipEntry(makeZip("other.xml", "x"), "word/document.xml"), null);
  });

  // It parses bytes an organizer sent, so every malformed input has to be a
  // null rather than a throw.
  test("null rather than a throw for anything that is not a zip", () => {
    assert.equal(readZipEntry(new Uint8Array([1, 2, 3]), "word/document.xml"), null);
    assert.equal(readZipEntry(new Uint8Array(0), "word/document.xml"), null);
    assert.equal(readZipEntry(new TextEncoder().encode("%PDF-1.4 not a zip"), "word/document.xml"), null);
  });
});

describe("docxToText", () => {
  test("paragraphs become lines, tags go", () => {
    const xml = "<w:body><w:p><w:r><w:t>Tokyo</w:t></w:r></w:p><w:p><w:r><w:t>Kyoto</w:t></w:r></w:p></w:body>";
    const text = docxToText(makeZip("word/document.xml", xml));
    assert.equal(text?.trim(), "Tokyo\nKyoto");
  });

  test("entities decode, so a plan reads as words", () => {
    const xml = "<w:p><w:t>Bed &amp; Breakfast</w:t></w:p>";
    assert.match(docxToText(makeZip("word/document.xml", xml))!, /Bed & Breakfast/);
  });

  test("null for a zip with no document in it", () => {
    assert.equal(docxToText(makeZip("word/other.xml", "x")), null);
  });
});

describe("documentKindFor", () => {
  test("recognises what an organizer actually sends", () => {
    assert.equal(documentKindFor("application/pdf", "booking.pdf"), "pdf");
    assert.equal(documentKindFor(undefined, "תוכנית_טיול.docx"), "docx");
    assert.equal(documentKindFor(undefined, "ESTA-Application.html"), "html");
    assert.equal(documentKindFor(undefined, "plan.md"), "text");
  });

  // Legacy .doc is a binary OLE format needing a real parser. Refusing it by
  // name gives an honest answer; guessing at it would give a corrupt one.
  test("declines what it cannot actually read", () => {
    assert.equal(documentKindFor(undefined, "old-plan.doc"), null);
    assert.equal(documentKindFor("image/jpeg", "Vonderbilt.jpg"), null);
    assert.equal(documentKindFor(undefined, "budget.xls"), null);
  });
});

describe("documentText end to end", () => {
  test("a .docx round-trips to readable text", async () => {
    const xml =
      "<w:p><w:t>Dallas, July 6 — World Cup match</w:t></w:p>" +
      "<w:p><w:t>Five travellers: Dror, Hagit, Hadar, Shaked, Ron</w:t></w:p>";
    const result = await documentText(makeZip("word/document.xml", xml), undefined, "plan.docx");
    assert.equal(result.ok, true, "ok, or the 40-character floor rejected it as a scan");
    assert.match(result.ok ? result.text : "", /Dallas, July 6/);
    assert.match(result.ok ? result.text : "", /Shaked/);
  });

  test("a corrupt .docx is UNREADABLE, not a crash", async () => {
    const result = await documentText(new Uint8Array([80, 75, 3, 4, 0]), undefined, "plan.docx");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "UNREADABLE");
  });

  test("too little text to be a document is NO_TEXT, which a scan usually is", async () => {
    const result = await documentText(new TextEncoder().encode("hi"), "text/plain", "note.txt");
    assert.equal(result.ok === false && result.reason, "NO_TEXT");
  });
});

/**
 * A budget is a spreadsheet more often than it is anything else, and
 * `budget_detail` is a question the interview asks.
 *
 * The zip fixture here carries two entries, because the shared string table is
 * the one part of xlsx that cannot be skipped: `t="s"` cells hold an INDEX,
 * and without resolving it every text cell reads as a small integer.
 */
describe("xlsxToText", () => {
  function makeXlsx(shared: string[], rows: string[][]): Uint8Array {
    const sharedXml =
      '<sst>' + shared.map((v) => `<si><t>${v}</t></si>`).join("") + "</sst>";
    const sheetXml =
      "<worksheet><sheetData>" +
      rows
        .map(
          (cells, r) =>
            `<row r="${r + 1}">` +
            cells
              .map((c, i) => {
                const index = shared.indexOf(c);
                return index >= 0
                  ? `<c r="A${i}" t="s"><v>${index}</v></c>`
                  : `<c r="A${i}"><v>${c}</v></c>`;
              })
              .join("") +
            "</row>",
        )
        .join("") +
      "</sheetData></worksheet>";
    return makeMultiZip([
      ["xl/sharedStrings.xml", sharedXml],
      ["xl/worksheets/sheet1.xml", sheetXml],
    ]);
  }

  test("resolves shared strings and lays rows out as lines", () => {
    const out = xlsxToText(makeXlsx(["Hotel", "Flights"], [["Hotel", "756"], ["Flights", "981.88"]]));
    assert.equal(out, "Hotel\t756\nFlights\t981.88");
  });

  test("null for a zip that is not a spreadsheet", () => {
    assert.equal(xlsxToText(makeMultiZip([["word/document.xml", "<w:p/>"]])), null);
  });

  test("a text cell without the shared table would read as an integer — so it is resolved", () => {
    const out = xlsxToText(makeXlsx(["Breckenridge"], [["Breckenridge", "1200"]]));
    assert.match(out!, /Breckenridge/);
    assert.equal(/^0\t/.test(out!), false, "not the raw shared-string index");
  });
});
