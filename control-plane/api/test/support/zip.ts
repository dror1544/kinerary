/**
 * A ZIP archive built in memory, for tests of the .docx and .xlsx readers.
 *
 * Built here rather than checked in as a fixture: a binary blob is something
 * nobody can review in a diff, and hard rule 3 keeps binaries out of the tree.
 * The reader does not check CRCs, so none are computed.
 */
import { deflateRawSync } from "node:zlib";

export function makeZip(files: readonly [string, string][]): Uint8Array {
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

/**
 * A PDF with one page per string, each page's text drawn in Helvetica. An empty
 * string is a page with no text at all — what a scanned page looks like to a
 * text extractor.
 */
export function makePdf(pages: readonly string[]): Uint8Array {
  const pageObjects: string[] = [];
  const kids: string[] = [];
  let next = 4;
  for (const text of pages) {
    const pageId = next++;
    const contentId = next++;
    kids.push(`${pageId} 0 R`);
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET` : "";
    pageObjects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
      `${contentId} 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  }
  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>\nendobj\n`,
    `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
    ...pageObjects,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += object;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
