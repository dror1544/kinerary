import { spawn } from 'child_process';
import { mkdtempSync, rmSync, cpSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'fixtures');
const SERVER_JS    = join(HERE, '..', '..', 'server', 'server.js');
const DEFAULT_TEST_PORT = 3099;

let serverProcess = null;
let dataDir = null;
let tripDir = null;
// Mutable, not a module-level constant: node:test runs listed files
// concurrently by default, and every file importing this helper used to
// share one hardcoded port — harmless while few files raced for it, but
// adding one more contender (booking-extract-proxy.test.js) turned that
// latent risk into an actual EADDRINUSE-driven startup failure. Each file
// can now pass its own PORT via extraEnv to get a dedicated one.
let BASE_URL = `http://localhost:${DEFAULT_TEST_PORT}`;

export async function startTestServer(extraEnv = {}) {
  dataDir = mkdtempSync(join(tmpdir(), 'trip-test-'));
  // The trip dir is a throwaway copy, never the committed fixtures directory.
  // Endpoints that persist config changes (participant binding, plan export)
  // write trip.config.json in place, which used to dirty a tracked file — the
  // other test files already copy for exactly this reason.
  tripDir = join(dataDir, 'trip');
  cpSync(FIXTURES_DIR, tripDir, { recursive: true });
  const port = extraEnv.PORT || DEFAULT_TEST_PORT;
  BASE_URL = `http://localhost:${port}`;

  return new Promise((resolve, reject) => {
    serverProcess = spawn('node', [SERVER_JS], {
      cwd: join(HERE, '..', '..', 'server'),
      env: {
        ...process.env,
        TRIP_DIR:     tripDir,
        DATA_DIR:     dataDir,
        AVATARS_DIR:  join(dataDir, 'avatars'),
        PORT:       String(port),
        JWT_SECRET: 'test-secret-000',
        IMMICH_URL: '',
        IMMICH_API_KEY: '',
        HERMES_API_KEY: 'test-hermes-key',
        SEED_PASSWORD: '1234',
        ...extraEnv,
      },
    });

    let ready = false;
    serverProcess.stdout.on('data', chunk => {
      const s = chunk.toString();
      if (!ready && s.includes('Trip server running on')) {
        ready = true;
        resolve();
      }
    });
    serverProcess.stderr.on('data', chunk => {
      // surface errors only if they cause startup failure
      if (!ready) process.stderr.write(chunk);
    });
    serverProcess.on('error', reject);
    serverProcess.on('exit', code => {
      if (!ready) reject(new Error(`Server exited with code ${code} before becoming ready`));
    });

    // Timeout safety net
    setTimeout(() => {
      if (!ready) reject(new Error('Test server did not start within 10s'));
    }, 10_000);
  });
}

export function stopTestServer() {
  serverProcess?.kill('SIGTERM');
  serverProcess = null;
  if (dataDir) {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    dataDir = null;
  }
}

/** Fetch against the test server. Pass `auth: true` to send the cached token. */
let _token = null;
export async function api(path, { method = 'GET', body, auth = false, token, apiKey } = {}) {
  const headers = {};
  const t = token ?? (auth ? _token : null);
  if (t) headers['Authorization'] = `Bearer ${t}`;
  // Service-account path — how the companion agent authenticates, as distinct
  // from a family member's JWT. Matches HERMES_API_KEY in startTestServer().
  if (apiKey) headers['X-API-Key'] = apiKey;
  // FormData sets its own multipart boundary via Content-Type — must not be
  // overridden or fetch serializes it as a plain object instead.
  let finalBody;
  if (body instanceof FormData) {
    finalBody = body;
  } else if (body != null) {
    headers['Content-Type'] = 'application/json';
    finalBody = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: finalBody,
  });
  return res;
}

/** Login as alice (default test user) and cache the token for subsequent api() calls. */
export async function loginAsAlice() {
  // HTTP readiness is logged before async bcrypt user seeding completes.
  // Retry the normal login briefly so parallel test files cannot race it.
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: '1234' },
    });
    if (res.ok) {
      const { token } = await res.json();
      _token = token;
      return token;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Login as alice never succeeded');
}
