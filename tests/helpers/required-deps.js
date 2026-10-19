/**
 * The npm packages the suite needs from three directories, checked before it
 * runs (issue #366).
 *
 * A worktree that has never had `npm ci` does not fail: a test that imports a
 * missing package dies on import, node:test reports it as a cancelled subtest,
 * and the run reads like a flake or a hang — the same quiet shape as a real
 * one, wearing a different cause. Naming the missing package and the command
 * that fixes it, in the first second, is the whole job here.
 *
 * Each entry is resolved the way the code that needs it resolves it: from its
 * own directory, with createRequire, so a package found only in some OTHER
 * directory's node_modules (or the main checkout's) does not count.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

export const REQUIRED_DEPS = [
  { dir: 'server', request: 'express', why: 'every trip-server test starts server/server.js' },
  { dir: 'mcp', request: '@modelcontextprotocol/sdk/server/mcp.js', why: 'the mcp-* tests start mcp/mcp.js' },
  { dir: 'tests', request: 'happy-dom', why: 'the DOM-rendering tests' },
];

/** Entries of REQUIRED_DEPS that do not resolve from their directory under `root`. */
export function findMissingDeps(root) {
  const missing = [];
  for (const dep of REQUIRED_DEPS) {
    const dir = path.join(root, dep.dir);
    try {
      createRequire(path.join(dir, 'package.json')).resolve(dep.request);
    } catch {
      missing.push({ ...dep, path: dir });
    }
  }
  return missing;
}

export function describeMissingDeps(missing) {
  const lines = ['Test dependencies are not installed — the suite would report cancelled tests, not failures:'];
  for (const m of missing) lines.push(`  ${m.request}  (${m.dir}/: ${m.why})`);
  lines.push('Install them, then rerun:');
  for (const dir of [...new Set(missing.map(m => m.dir))]) lines.push(`  npm ci --prefix ${dir}`);
  return lines.join('\n');
}
