import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE     = dirname(fileURLToPath(import.meta.url));
const MCP_JS   = join(HERE, '..', '..', 'mcp', 'mcp.js');
const MCP_DIR  = join(HERE, '..', '..', 'mcp');
const DEFAULT_TEST_PORT = 3098;

export const MCP_API_KEY  = 'test-mcp-key';
export const TRIP_API_KEY = 'test-trip-key';

let mcpProcess = null;
// Mutable — see the equivalent note in helpers/server.js. Two describe
// blocks in the same file reusing this same default port back-to-back also
// hit this: killing the old process and binding a new one to the identical
// port isn't instant, and got racy once enough other files' processes were
// competing for CPU/ports at the same time. Pass MCP_PORT in extraEnv for a
// dedicated one.
let BASE_URL = `http://localhost:${DEFAULT_TEST_PORT}`;

export async function startTestMcp(extraEnv = {}) {
  const port = extraEnv.MCP_PORT || DEFAULT_TEST_PORT;
  BASE_URL = `http://localhost:${port}`;
  return new Promise((resolve, reject) => {
    mcpProcess = spawn('node', [MCP_JS], {
      cwd: MCP_DIR,
      env: {
        ...process.env,
        MCP_PORT: String(port),
        MCP_API_KEY,
        TRIP_API_KEY,
        // Deliberately no HERMES_EXTRACT_PROFILE by default — auth is checked
        // before it's read, so the auth tests don't need a real hermes CLI.
        HERMES_EXTRACT_PROFILE: '',
        API_BASE_URL: 'http://127.0.0.1:1', // unreachable; apiGet() calls fail into their catch blocks
        ...extraEnv,
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
