/**
 * What the reader says it read.
 *
 * A reader that returns text and a page count cannot tell a caller that page 3
 * of 5 was a scan, or that the last forty pages were past the budget. Both used
 * to disappear: a whole-document check passed any PDF with one typed page, and
 * truncation reached a log line and nothing else. Coverage is how "partly read"
 * becomes something the organizer can be told.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DOCUMENT_READER_VERSION, documentText, xlsxSheets, xlsxToText } from "../src/document-text.js";
import { makePdf, makeZip } from "./support/zip.js";

const text = (s: string) => new TextEncoder().encode(s);

describe("coverage", () => {
  test("a PDF reports every page, and a page with no text as unread", async () => {
    const pdf = makePdf([
      "Hotel Gracery Shinjuku check-in 19 September 2026 confirmation GR-4471",
      "",
      "Kyoto Granbell Hotel check-in 23 September 2026 confirmation KG-1180",
    ]);
    const read = await documentText(pdf, "application/pdf", "vouchers.pdf");
    assert.equal(read.ok, true, read.ok ? "" : `${read.reason} ${read.detail ?? ""}`);
    if (!read.ok) return;
    assert.equal(read.pages, 3);
    assert.deepEqual(read.coverage.map((u) => [u.unit, u.index, u.usable]), [
      ["page", 1, true],
      ["page", 2, false],
      ["page", 3, true],
    ]);
    assert.match(read.text, /GR-4471/);
    assert.match(read.text, /KG-1180/);
  });

  test("a spreadsheet reports each sheet it read, and an empty sheet is not an unread one", async () => {
    const xlsx = makeZip([
      ["xl/sharedStrings.xml", "<sst><si><t>Tokyo</t></si><si><t>Kyoto</t></si></sst>"],
      ["xl/worksheets/sheet1.xml", `<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>`],
      ["xl/worksheets/sheet2.xml", `<worksheet><sheetData></sheetData></worksheet>`],
      ["xl/worksheets/sheet3.xml", `<worksheet><sheetData><row><c t="s"><v>1</v></c></row></sheetData></worksheet>`],
    ]);
    assert.deepEqual(xlsxSheets(xlsx), ["Tokyo", "", "Kyoto"]);
    assert.equal(xlsxToText(xlsx), "Tokyo\nKyoto", "the joined text is unchanged");

    const read = await documentText(
      makeZip([
        ["xl/sharedStrings.xml", "<sst><si><t>Budget for the whole family trip to Japan in September</t></si></sst>"],
        ["xl/worksheets/sheet1.xml", `<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>`],
        ["xl/worksheets/sheet2.xml", `<worksheet><sheetData></sheetData></worksheet>`],
      ]),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "budget.xlsx",
    );
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.deepEqual(read.coverage.map((u) => [u.unit, u.index, u.usable]), [
      ["sheet", 1, true],
      ["sheet", 2, true],
    ]);
  });

  test("a document without reliable pages is one unit, never invented pages", async () => {
    const read = await documentText(text("Flight LY81 Tel Aviv to Tokyo Narita, 18 September 2026, PNR QX7Z2A"), "text/plain", "flight.txt");
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.deepEqual(read.coverage, [{ unit: "document", index: 1, chars: read.coverage[0]!.chars, usable: true }]);
  });

  test("units past the budget are marked cut, and the result says it was truncated", async () => {
    const pdf = makePdf([
      "Day one in Tokyo: Senso-ji in the morning, Ueno park after lunch",
      "Day two in Tokyo: Meiji shrine, Harajuku, and an early dinner nearby",
      "Day three in Hakone: the ropeway, Owakudani, and the lake cruise",
    ]);
    const read = await documentText(pdf, "application/pdf", "plan.pdf", { maxChars: 70 });
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.equal(read.truncated, true);
    assert.equal(read.text.length, 70);
    assert.equal(read.coverage[0]!.cut, undefined, "the first page starts inside the budget");
    assert.equal(read.coverage[2]!.cut, true, "the third page starts past it");
  });

  test("the reader names its version, so a reading can say which reader made it", () => {
    assert.match(DOCUMENT_READER_VERSION, /^reader-/);
  });
});
