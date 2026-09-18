/**
 * A minimal one-page PDF with a text stream, built at test time.
 *
 * The TypeScript twin of `write_pdf` in fixtures/make_documents.py, for the
 * same reason: the point is to exercise a real PDF READER, any generator would
 * be a dependency, and a PDF is never committed to the repo. Latin-1 text only
 * (Helvetica, no embedded font).
 */
export function minimalPdf(lines: readonly string[]): Buffer {
  const content = ["BT", "/F1 10 Tf", "1 0 0 1 40 750 Tm", "12 TL"];
  for (const line of lines) {
    const escaped = line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    content.push(`(${escaped}) Tj`, "T*");
  }
  content.push("ET");
  const stream = Buffer.from(content.join("\n"), "latin1");

  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
        "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      Buffer.from("\nendstream"),
    ]),
  ];

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
  ].join("");
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}
