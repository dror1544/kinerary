/**
 * Spreadsheet dates are decoded from the workbook, not left for a model to guess.
 *
 * In xlsx a date is a serial day count and only the cell's number format says it
 * is a date. These build real workbooks in memory (hard rule 3: no binaries in
 * the tree) with a styles part, a date system, empty columns and formulas.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { documentText, serialToIsoText, xlsxSheetDetails } from "../src/document-text.js";
import { makeZip } from "./support/zip.js";

const DAY = 86_400_000;
const serial1900 = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / DAY;
const serial1904 = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1904, 0, 1)) / DAY;

const STYLES = [
  `<styleSheet>`,
  `<numFmts count="2">`,
  `<numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/>`,
  `<numFmt numFmtId="165" formatCode="#,##0 &quot;days&quot; [$-he-IL]"/>`,
  `</numFmts>`,
  // 0 General, 1 built-in date (14), 2 custom datetime, 3 built-in time (20), 4 custom non-date
  `<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="20"/><xf numFmtId="165"/></cellXfs>`,
  `</styleSheet>`,
].join("");

const inline = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;

function itinerarySheet(serial: (iso: string) => number): string {
  return [
    `<worksheet><sheetData>`,
    `<row r="1">${inline("A1", "Date")}${inline("B1", "Time")}${inline("C1", "Place")}${inline("D1", "Cost")}</row>`,
    // B2 is missing: an empty column that must stay a column.
    `<row r="2"><c r="A2" s="1"><v>${serial("2026-09-19")}</v></c>${inline("C2", "Hotel Gracery Shinjuku")}<c r="D2" s="4"><v>4</v></c></row>`,
    `<row r="3"><c r="A3" s="2"><v>${serial("2026-09-20") + 0.375}</v></c><c r="B3" s="3"><v>0.5</v></c>${inline("C3", "Senso-ji")}<c r="D3"><v>1250</v></c></row>`,
    // A formula with a cached value reads as its value; one without has nothing to read.
    `<row r="4"><c r="A4"><f>SUM(D2:D3)</f><v>1254</v></c><c r="B4"><f>NOW()</f></c><c r="C4" t="b"><v>1</v></c></row>`,
    `</sheetData></worksheet>`,
  ].join("");
}

describe("spreadsheet dates", () => {
  test("date, time and datetime cells read as ISO text, and everything else stays what it was", () => {
    const xlsx = makeZip([
      ["xl/styles.xml", STYLES],
      ["xl/worksheets/sheet1.xml", itinerarySheet(serial1900)],
    ]);
    const [sheet] = xlsxSheetDetails(xlsx)!;
    assert.deepEqual(sheet!.text.split("\n"), [
      "Date\tTime\tPlace\tCost",
      "2026-09-19\t\tHotel Gracery Shinjuku\t4",
      "2026-09-20 09:00\t12:00\tSenso-ji\t1250",
      "1254\t\tTRUE",
    ]);
    assert.equal(sheet!.unread, 1, "the formula with no cached value is counted, not passed as empty");
  });

  test("a 1904-system workbook is read on its own calendar", () => {
    const xlsx = makeZip([
      ["xl/workbook.xml", `<workbook><workbookPr date1904="1"/></workbook>`],
      ["xl/styles.xml", STYLES],
      ["xl/worksheets/sheet1.xml", itinerarySheet(serial1904)],
    ]);
    const [sheet] = xlsxSheetDetails(xlsx)!;
    assert.match(sheet!.text, /^2026-09-19\t/m);
    assert.match(sheet!.text, /^2026-09-20 09:00\t/m);
  });

  test("the 1900 system's phantom leap day is accounted for on both sides of it", () => {
    assert.equal(serialToIsoText(1, "date"), "1900-01-01");
    assert.equal(serialToIsoText(59, "date"), "1900-02-28");
    assert.equal(serialToIsoText(61, "date"), "1900-03-01");
    assert.equal(serialToIsoText(serial1900("2026-09-19"), "date"), "2026-09-19");
    assert.equal(serialToIsoText(-3, "date"), null);
  });

  test("a sheet with an unread formula reports as partly read", async () => {
    const xlsx = makeZip([
      ["xl/styles.xml", STYLES],
      ["xl/worksheets/sheet1.xml", itinerarySheet(serial1900)],
    ]);
    const read = await documentText(xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "plan.xlsx");
    assert.ok(read.ok, read.ok ? "" : read.reason);
    if (!read.ok) return;
    assert.deepEqual(read.coverage.map((u) => [u.unit, u.usable]), [["sheet", false]]);
    assert.doesNotMatch(read.text, /\b46\d{3}\b/, "no raw serial reaches the text a model reads");
  });
});
