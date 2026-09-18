/**
 * Reading a document must leave the caller's bytes alone.
 *
 * pdf.js detaches the buffer it is handed. Before the reader copied, a PDF's
 * bytes were empty by the time ingest hashed or stored them — every PDF on a
 * trip collapsed into one "document" with the digest of nothing, or, hashed
 * first, none of them was ever kept. Nothing about the reading itself looked
 * wrong, which is why this is a test of its own.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contentDigest } from "../src/document-store.js";
import { documentText } from "../src/document-text.js";
import { makePdf } from "./support/zip.js";

describe("documentText and the caller's bytes", () => {
  for (const [label, pages] of [
    ["a typed PDF", ["Hotel Kyoto Riverside Inn, check-in 14 October 2026, confirmation KRI-58213"]],
    ["a PDF with no text layer", [""]],
  ] as const) {
    test(`${label} is read without emptying the bytes it was read from`, async () => {
      const bytes = makePdf([...pages]);
      const digest = contentDigest(bytes);
      const length = bytes.byteLength;
      await documentText(bytes, "application/pdf", "x.pdf");
      assert.equal(bytes.byteLength, length);
      assert.equal(contentDigest(bytes), digest);
    });
  }
});
