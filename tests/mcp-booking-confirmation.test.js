/**
 * End-to-end MCP coverage for protected booking confirmations.
 *
 * The mock below represents the trip site's authenticated API boundary. The
 * test calls the real MCP tool over SSE and verifies that both uploaded and
 * bundled/seed confirmation filenames are fetched with the trip API key.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestMcp, stopTestMcp, mcpCallTool, TRIP_API_KEY } from './helpers/mcp.js';

const UPLOADED_PDF = Buffer.from('%PDF-1.4\nuploaded confirmation');
const BUNDLED_PDF  = Buffer.from('%PDF-1.4\nbundled confirmation');

const bookings = [
  { id: 1, name: 'Uploaded hotel', conf_file: 'uploaded-42.pdf' },
  { id: 2, name: 'Bundled rail pass', conf_file: 'Japan rail pass #1.pdf' },
  { id: 3, name: 'No confirmation', conf_file: null },
];

let apiServer;
let apiBaseUrl;
const requests = [];

function parseToolJson(result) {
  assert.notEqual(result.isError, true);
  assert.equal(result.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
}

describe('get_booking_confirmation MCP tool', () => {
  before(async () => {
    apiServer = createServer((req, res) => {
      requests.push({ url: req.url, apiKey: req.headers['x-api-key'] });
      if (req.headers['x-api-key'] !== TRIP_API_KEY) {
        res.writeHead(401).end('unauthorized');
        return;
      }

      if (req.url === '/api/bookings') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bookings));
        return;
      }
      if (req.url === '/api/bookings/confirmation/uploaded-42.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(UPLOADED_PDF);
        return;
      }
      if (req.url === '/api/bookings/confirmation/Japan%20rail%20pass%20%231.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(BUNDLED_PDF);
        return;
      }
      res.writeHead(404).end('not found');
    });

    await new Promise((resolve, reject) => {
      apiServer.once('error', reject);
      apiServer.listen(0, '127.0.0.1', resolve);
    });
    const address = apiServer.address();
    apiBaseUrl = `http://127.0.0.1:${address.port}`;
    await startTestMcp({ API_BASE_URL: apiBaseUrl, MCP_PORT: '3112' });
  });

  after(async () => {
    stopTestMcp();
    await new Promise(resolve => apiServer.close(resolve));
  });

  test('retrieves an uploaded confirmation through the authenticated API', async () => {
    const data = parseToolJson(await mcpCallTool('get_booking_confirmation', { id: 1 }));
    assert.equal(data.conf_file, 'uploaded-42.pdf');
    assert.deepEqual(Buffer.from(data.pdf_base64, 'base64'), UPLOADED_PDF);
  });

  test('retrieves a bundled confirmation and safely URL-encodes its filename', async () => {
    const data = parseToolJson(await mcpCallTool('get_booking_confirmation', { id: 2 }));
    assert.equal(data.conf_file, 'Japan rail pass #1.pdf');
    assert.deepEqual(Buffer.from(data.pdf_base64, 'base64'), BUNDLED_PDF);
    assert.ok(requests.some(r => r.url === '/api/bookings/confirmation/Japan%20rail%20pass%20%231.pdf'));
  });

  test('does not request a document when the booking has no confirmation', async () => {
    const documentRequestsBefore = requests.filter(r => r.url.startsWith('/api/bookings/confirmation/')).length;
    const data = parseToolJson(await mcpCallTool('get_booking_confirmation', { id: 3 }));
    assert.deepEqual(data, { id: 3, name: 'No confirmation', conf_file: null });
    const documentRequestsAfter = requests.filter(r => r.url.startsWith('/api/bookings/confirmation/')).length;
    assert.equal(documentRequestsAfter, documentRequestsBefore);
  });

  test('uses the trip API key for every upstream request', () => {
    assert.ok(requests.length >= 5);
    assert.ok(requests.every(r => r.apiKey === TRIP_API_KEY));
  });
});
