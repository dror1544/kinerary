import { spawn, execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PORTS, TRIP_BRIDGE_PORT_RANGE } from './ports.js';

/**
 * Who is listening on this port, as a sentence, or null if we cannot tell.
 *
 * Best-effort and never throws: this only ever runs while building a failure
 * message, and a missing `lsof` must not replace the real error with its own.
 */
function portHolder(port) {
  const probes = [
    ['lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']],
    ['ss', ['-lptnH', `sport = :${port}`]],
  ];
  for (const [bin, args] of probes) {
    try {
      const out = execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out) return out.split('\n').slice(0, 3).join('\n       ');
    } catch {
      // Not installed, or nothing listening. Try the next probe.
    }
  }
  return null;
}

/**
 * Why trip-mcp never came up, said in enough detail to act on.
 *
 * "trip-mcp exited with code 1 before becoming ready" was the whole message,
 * and on 2026-09-18 it cost an hour: the real cause was that a provisioned
 * trip's own bridge already held the port (`mcp_port_for_vmid` = 3000 + vmid,
 * and the test suite used to allocate from 3095). Nothing in the error named
 * a port, so it read as a broken MCP server. Whatever the cause, the port and
 * whoever holds it are the two facts worth having.
 */
function startupFailure(what, port, stderr) {
  const lines = [`${what} (trip-mcp on port ${port})`];
  const holder = portHolder(port);
  if (holder) {
    lines.push(`  port ${port} is already held by:`, `       ${holder}`);
  }
  const { first, last } = TRIP_BRIDGE_PORT_RANGE;
  if (port >= first && port <= last) {
    lines.push(
      `  ${port} is inside ${first}-${last}, where provisioned trips run their own`,
      `  trip-mcp bridge (3000 + vmid, so this is VMID ${port - 3000}). Test ports`,
      '  belong above 38000 — see helpers/ports.js.',
    );
  }
  const tail = (stderr || '').trim();
  if (tail) lines.push('  its stderr:', ...tail.split('\n').slice(-6).map(l => `       ${l}`));
  return new Error(lines.join('\n'));
}

const HERE     = dirname(fileURLToPath(import.meta.url));
const MCP_JS   = join(HERE, '..', '..', 'mcp', 'mcp.js');
const MCP_DIR  = join(HERE, '..', '..', 'mcp');
const DEFAULT_TEST_PORT = PORTS.mcpDefault;

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
    let startupTimer;
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
    // Kept, not only echoed: EADDRINUSE arrives here, and it is the single
    // most useful line in the failure it causes.
    let stderr = '';
    mcpProcess.stdout.on('data', chunk => {
      if (!ready && chunk.toString().includes('listening on')) {
        ready = true;
        clearTimeout(startupTimer);
        resolve();
      }
    });
    mcpProcess.stderr.on('data', chunk => {
      if (!ready) {
        stderr += chunk.toString();
        process.stderr.write(chunk);
      }
    });
    mcpProcess.on('error', err => {
      clearTimeout(startupTimer);
      reject(err);
    });
    mcpProcess.on('exit', code => {
      if (!ready) {
        clearTimeout(startupTimer);
        reject(startupFailure(`exited with code ${code} before becoming ready`, port, stderr));
      }
    });

    startupTimer = setTimeout(() => {
      if (!ready) reject(startupFailure('did not start within 10s', port, stderr));
    }, 10_000);
  });
}

export function stopTestMcp() {
  mcpProcess?.kill('SIGTERM');
  mcpProcess = null;
}

/**
 * Complete an MCP session against the running server and return its advertised
 * tools, as `{ name: {description, inputSchema} }`.
 *
 * Speaks the SSE transport by hand rather than pulling in the SDK client: the
 * point of the routing tests is to assert on exactly what an agent is told,
 * which is the tools/list payload on the wire, and this stays readable across
 * SDK versions.
 */
async function mcpRequest(method, params, { apiKey = MCP_API_KEY, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const stream = await fetch(`${BASE_URL}/sse`, {
    headers: { 'X-API-Key': apiKey, Accept: 'text/event-stream' },
    signal:  ctrl.signal,
  });
  if (!stream.ok) throw new Error(`GET /sse failed: ${stream.status}`);

  const messages = [];
  let endpoint = null;
  const reader  = stream.body.getReader();
  const decoder = new TextDecoder();

  (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let split;
        // SSE frames are separated by a blank line; \r\n\r\n is equally legal.
        while ((split = buf.search(/\r?\n\r?\n/)) !== -1) {
          const frame = buf.slice(0, split);
          buf = buf.slice(split + buf.slice(split).match(/^\r?\n\r?\n/)[0].length);
          let event = 'message';
          const data = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('event:'))     event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          const payload = data.join('\n');
          if (event === 'endpoint') endpoint = payload;
          else if (payload) { try { messages.push(JSON.parse(payload)); } catch { /* keepalive */ } }
        }
      }
    } catch { /* aborted on close */ }
  })();

  const deadline = Date.now() + timeoutMs;
  const waitFor = async (pred, what) => {
    for (;;) {
      const hit = pred();
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise(r => setTimeout(r, 20));
    }
  };

  const send = async (msg) => {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      method:  'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify(msg),
    });
    if (!res.ok) throw new Error(`POST ${endpoint} failed: ${res.status}`);
  };

  try {
    await waitFor(() => endpoint, 'the endpoint event');
    await send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities:    {},
        clientInfo:      { name: 'kinerary-tests', version: '1.0.0' },
      },
    });
    await waitFor(() => messages.find(m => m.id === 1), 'the initialize result');
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await send({ jsonrpc: '2.0', id: 2, method, params });
    const response = await waitFor(() => messages.find(m => m.id === 2), `the ${method} result`);
    if (response.error) throw new Error(`${method} error: ${JSON.stringify(response.error)}`);
    return response.result;
  } finally {
    ctrl.abort();
  }
}

export async function mcpListTools(options = {}) {
  const result = await mcpRequest('tools/list', {}, options);
  return Object.fromEntries((result?.tools || []).map(t => [t.name, t]));
}

export async function mcpCallTool(name, args = {}, options = {}) {
  return mcpRequest('tools/call', { name, arguments: args }, options);
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
