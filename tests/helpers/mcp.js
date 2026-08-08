import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE     = dirname(fileURLToPath(import.meta.url));
const MCP_JS   = join(HERE, '..', '..', 'mcp', 'mcp.js');
const MCP_DIR  = join(HERE, '..', '..', 'mcp');
const TEST_PORT = 3098;
const BASE_URL  = `http://localhost:${TEST_PORT}`;

export const MCP_API_KEY  = 'test-mcp-key';
export const TRIP_API_KEY = 'test-trip-key';

let mcpProcess = null;

export async function startTestMcp() {
  return new Promise((resolve, reject) => {
    mcpProcess = spawn('node', [MCP_JS], {
      cwd: MCP_DIR,
      env: {
        ...process.env,
        MCP_PORT: String(TEST_PORT),
        MCP_API_KEY,
        TRIP_API_KEY,
        // Deliberately no ANTHROPIC_API_KEY — auth is checked before the key
        // is read, so these tests can prove the auth boundary without ever
        // making a real Anthropic call.
        ANTHROPIC_API_KEY: '',
        API_BASE_URL: 'http://127.0.0.1:1', // unused by /extract; never dialed
      },
    });

    let ready = false;
    mcpProcess.stdout.on('data', chunk => {
      if (!ready && chunk.toString().includes('listening on')) {
        ready = true;
        resolve();
      }
    });
    mcpProcess.stderr.on('data', chunk => {
      if (!ready) process.stderr.write(chunk);
    });
    mcpProcess.on('error', reject);
    mcpProcess.on('exit', code => {
      if (!ready) reject(new Error(`trip-mcp exited with code ${code} before becoming ready`));
    });

    setTimeout(() => {
      if (!ready) reject(new Error('Test trip-mcp did not start within 10s'));
    }, 10_000);
  });
}

export function stopTestMcp() {
  mcpProcess?.kill('SIGTERM');
  mcpProcess = null;
}

export async function mcpApi(path, { method = 'GET', body, apiKey } = {}) {
  const headers = {};
  if (apiKey) headers['X-API-Key'] = apiKey;
  let finalBody;
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    finalBody = JSON.stringify(body);
  }
  return fetch(`${BASE_URL}${path}`, { method, headers, body: finalBody });
}
