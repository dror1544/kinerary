import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #367: server/Dockerfile copied only server/*.js, so server/trip-mcp/
// was missing from a Docker-hosted trip. server.js loads it inside a
// try/catch, so the site booted and the MCP connector silently never
// registered. Every local directory server.js requires must be COPYed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'server');
const dockerfile = fs.readFileSync(path.join(serverDir, 'Dockerfile'), 'utf8');
const source = fs.readFileSync(path.join(serverDir, 'server.js'), 'utf8');

const copies = dockerfile.split('\n')
  .map(l => l.trim())
  .filter(l => /^COPY\s/i.test(l))
  .map(l => l.replace(/^COPY\s+/i, '').split(/\s+/));

test('every local directory server.js requires is copied into the image', () => {
  const localRequires = [...source.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)].map(m => m[1].slice(2));
  const dirs = [...new Set(localRequires)].filter(name => {
    const p = path.join(serverDir, name);
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  });
  assert.ok(dirs.includes('trip-mcp'), 'sanity: server.js requires ./trip-mcp (a directory)');
  for (const dir of dirs) {
    const covered = copies.some(([src]) => src === `server/${dir}` || src === `server/${dir}/`);
    assert.ok(covered, `server.js requires ./${dir} (a directory) but server/Dockerfile has no COPY server/${dir} line`);
  }
});

test('the server/*.js COPY is still there for the single-file requires', () => {
  assert.ok(copies.some(([src]) => src === 'server/*.js'), 'server/*.js is copied');
});

test("trip-mcp's relative requires out of its directory resolve inside the image layout", () => {
  // /app/server/trip-mcp/index.js requires ../../shared/... -> /app/shared.
  assert.ok(copies.some(([src, dst]) => src === 'shared' && dst === '/app/shared'), 'shared is copied to /app/shared');
  for (const f of fs.readdirSync(path.join(serverDir, 'trip-mcp')).filter(n => n.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(serverDir, 'trip-mcp', f), 'utf8');
    for (const m of text.matchAll(/require\(\s*['"](\.\.\/[^'"]+)['"]\s*\)/g)) {
      assert.ok(m[1].startsWith('../../shared/'),
        `trip-mcp/${f} requires ${m[1]}; only ../../shared/* is present in the image`);
    }
  }
});

// ── The trip-site image (control-plane/deployment/trip-site.Dockerfile) ───────
// One trip's site as a container, built from a sealed release tree (server/, site/, shared/).
// Unlike server/Dockerfile it copies those roots whole, so the #367 class (a directory
// server.js requires that never reaches the image) cannot recur; what could drift instead is
// the wiring between the Dockerfile, the entrypoint and the one nginx config an LXC also uses.
const deployDir = path.join(root, 'control-plane', 'deployment');
const tripSiteDockerfile = fs.readFileSync(path.join(deployDir, 'trip-site.Dockerfile'), 'utf8');
const tripSiteEntrypoint = fs.readFileSync(path.join(deployDir, 'trip-site-entrypoint.sh'), 'utf8');
const tripSiteNginxMain = fs.readFileSync(path.join(deployDir, 'trip-site-nginx-main.conf'), 'utf8');
const sharedNginx = fs.readFileSync(path.join(root, 'provisioning', 'trip-site-nginx.conf'), 'utf8');
const tripSiteLines = tripSiteDockerfile.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const tripSiteCopies = tripSiteLines
  .filter(l => /^COPY\s/i.test(l))
  .map(l => l.replace(/^COPY\s+/i, '').split(/\s+/).filter(t => !t.startsWith('--')));
const tripSiteCopyFlags = tripSiteLines
  .filter(l => /^COPY\s/i.test(l))
  .map(l => Object.fromEntries(l.split(/\s+/).filter(t => t.startsWith('--')).map(t => t.slice(2).split('='))));

test('trip-site image: the release tree roots are copied whole, so no required directory can be missed', () => {
  const copied = tripSiteCopies.filter((_, i) => !tripSiteCopyFlags[i].from).map(([src, dst]) => `${src}>${dst}`);
  for (const dir of ['server', 'shared', 'site']) {
    assert.ok(copied.includes(`${dir}>./${dir}`), `trip-site.Dockerfile has no COPY ${dir} ./${dir} from the release tree`);
  }
  const localRequires = [...source.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)].map(m => m[1].slice(2));
  const dirs = localRequires.filter(n => fs.existsSync(path.join(serverDir, n)) && fs.statSync(path.join(serverDir, n)).isDirectory());
  assert.ok(dirs.includes('trip-mcp'), 'sanity: server.js requires ./trip-mcp');
  // server/ goes in whole (COPY server ./server), so trip-mcp comes with it; ../shared resolves to /opt/kinerary/shared.
  assert.ok(copied.includes('server>./server'));
});

test('trip-site image: the deployment files come from the named `tool` context and exist there', () => {
  const fromTool = tripSiteCopies.filter((_, i) => tripSiteCopyFlags[i].from === 'tool');
  const sources = fromTool.map(([src]) => src);
  assert.deepEqual(sources.sort(), [
    'control-plane/deployment/trip-site-entrypoint.sh',
    'control-plane/deployment/trip-site-nginx-main.conf',
    'provisioning/trip-site-nginx.conf',
  ]);
  for (const src of sources) assert.ok(fs.existsSync(path.join(root, src)), `${src} is COPYed from the tool context but does not exist`);
});

test('trip-site image: the nginx site is the shared file, included by the main config, rooted where the image puts the site', () => {
  const dest = tripSiteCopies.find(([src]) => src === 'provisioning/trip-site-nginx.conf')[1];
  assert.match(tripSiteNginxMain, new RegExp(`include\\s+${dest.replace(/[.]/g, '\\.')};`), 'the main config includes the shared file where the Dockerfile puts it');
  assert.match(sharedNginx, /root \/opt\/kinerary\/site;/);
  assert.match(tripSiteDockerfile, /^WORKDIR \/opt\/kinerary$/m, 'the app root is the LXC layout the nginx config assumes');
  assert.match(tripSiteDockerfile, /APP_DIR=\/opt\/kinerary\b/, 'the entrypoint is told the app root by the image');
  assert.match(tripSiteEntrypoint, /APP_DIR="\$\{APP_DIR:-\}"/);
  assert.match(sharedNginx, /listen 8080;/);
  assert.match(sharedNginx, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.match(tripSiteEntrypoint, /export PORT=3000/, 'node listens where nginx proxies');
  assert.match(tripSiteDockerfile, /^EXPOSE 8080$/m);
});

test('trip-site image: non-root numeric uid, curl and nginx present, native modules can build, entrypoint is the entry', () => {
  assert.match(tripSiteDockerfile, /^ARG TRIP_CONTAINER_UID=10001$/m);
  assert.match(tripSiteDockerfile, /^USER \$\{TRIP_CONTAINER_UID\}$/m, 'runs as the numeric uid, not root');
  assert.match(tripSiteDockerfile, /apt-get install -y --no-install-recommends nginx curl/);
  assert.match(tripSiteDockerfile, /build-essential/, 'better-sqlite3 needs a compiler when no prebuilt binary matches');
  assert.match(tripSiteDockerfile, /^ENTRYPOINT \["\/usr\/local\/bin\/trip-site-entrypoint"\]$/m);
  const entry = tripSiteCopies.find(([src]) => src.endsWith('trip-site-entrypoint.sh'));
  assert.equal(entry[1], '/usr/local/bin/trip-site-entrypoint');
  assert.ok(fs.statSync(path.join(deployDir, 'trip-site-entrypoint.sh')).mode & 0o100, 'the entrypoint is executable in the tree');
});

test('trip-site image: the mount path and the avatar link agree between Dockerfile and entrypoint', () => {
  assert.match(tripSiteDockerfile, /TRIP_STORE_DIR=\/trip-store/);
  assert.match(tripSiteEntrypoint, /STORE="\$\{TRIP_STORE_DIR:-\/trip-store\}"/);
  assert.match(tripSiteDockerfile, /ln -sfn \/trip-store\/media\/avatars \/opt\/kinerary\/site\/avatars/);
  assert.match(tripSiteEntrypoint, /AVATARS_DIR="\$STORE\/media\/avatars"/);
});

test('trip-site image: the entrypoint refuses without TRIP.txt and .env, and forces the mount paths', () => {
  assert.match(tripSiteEntrypoint, /\[ -f "\$STORE\/TRIP\.txt" \] \|\| die/);
  assert.match(tripSiteEntrypoint, /\[ -f "\$STORE\/\.env" \] \|\| die/);
  for (const v of ['TRIP_DIR', 'DATA_DIR', 'TRIP_DOCUMENTS_DIR', 'ENV_FILE_PATH']) {
    assert.match(tripSiteEntrypoint, new RegExp(`export ${v}="\\$STORE/`), `${v} is forced to the mount`);
  }
  // The refusal comes before anything is started.
  assert.ok(tripSiteEntrypoint.indexOf('TRIP.txt" ] || die') < tripSiteEntrypoint.indexOf('node server.js'));
  assert.ok(!/^\s*(\.|source)\s+"?\$STORE\/\.env/m.test(tripSiteEntrypoint), '.env is parsed as data, never sourced');
});
