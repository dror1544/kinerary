/**
 * Deterministic, source-only confirmation fixtures for CA-01 transport tests.
 * No traveler document or generated binary is committed to the repository.
 */
import { createServer } from 'node:http';

export const OVERSIZE_BYTES = 128 * 1024;

function pdfText(value) {
  if (!/^[\x20-\x7e]{1,80}$/.test(value)) throw new TypeError('synthetic PDF text must be short printable ASCII');
  return value.replace(/[()\\]/g, '\\$&');
}

export function makeConfirmationPdf(traveler, bookingCode) {
  const words = `Synthetic booking for ${pdfText(traveler)} - ${pdfText(bookingCode)}`;
  const stream = `BT /F1 12 Tf 36 250 Td (${words}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document);
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, 'ascii');
}

const original = makeConfirmationPdf('Example Traveler', 'ABC-123');
const revised = makeConfirmationPdf('Example Traveler', 'ABC-124');
const oversized = Buffer.alloc(OVERSIZE_BYTES, 0x41);

export async function startConfirmationFixtureServer() {
  let retryAttempts = 0;
  const server = createServer((request, response) => {
    let body;
    let mime = 'application/pdf';
    switch (request.url) {
      case '/original':
      case '/duplicate':
        body = original;
        break;
      case '/revised':
        body = revised;
        break;
      case '/wrong-mime':
        body = original;
        mime = 'text/plain';
        break;
      case '/empty':
        body = Buffer.alloc(0);
        break;
      case '/oversized':
        body = oversized;
        mime = 'application/octet-stream';
        break;
      case '/retry-once':
        retryAttempts += 1;
        if (retryAttempts === 1) {
          response.writeHead(503, { 'retry-after': '0' });
          response.end();
          return;
        }
        body = original;
        break;
      case '/interrupted':
        response.writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': String(original.length),
        });
        response.end(original.subarray(0, 24));
        return;
      case '/private-redirect':
        response.writeHead(302, { location: 'http://127.0.0.1:9/private' });
        response.end();
        return;
      default:
        response.writeHead(404);
        response.end();
        return;
    }
    response.writeHead(200, {
      'content-type': mime,
      'content-length': String(body.length),
      'content-disposition': 'attachment; filename="synthetic-confirmation.pdf"',
      'cache-control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
