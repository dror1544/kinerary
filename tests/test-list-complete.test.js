/**
 * test-list-complete.test.js — every tests/*.test.js file is in package.json's "test" list, or is named below on purpose.
 *
 * `npm test` runs an explicit list of files, so a new test file that is not added to it is never run by CI and never
 * fails: the boundary review of the group photo (PR #664, F1) found three such files, and four older ones the same way.
 * A green run that never ran a file is not a pass. This fails the moment a *.test.js file is neither listed nor allowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// A file that is deliberately NOT part of `npm test`, with the reason. Adding a name here is a decision, not a convenience:
// it says why CI should not run it. Empty today.
const NOT_IN_THE_LIST_ON_PURPOSE = {
  // 'example.test.js': 'needs a live Hermes; run by hand (docs/testing-runbook.md)',
};

const script = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).scripts.test;
const listed = script.split(/\s+/).filter((word) => word.endsWith('.test.js'));
const onDisk = readdirSync(HERE).filter((name) => name.endsWith('.test.js'));

test('every tests/*.test.js file is in the "test" list, unless it is allowed by name with a reason', () => {
  const missing = onDisk.filter((name) => !listed.includes(name) && !(name in NOT_IN_THE_LIST_ON_PURPOSE));
  assert.deepEqual(missing, [], `these test files would never run in CI: add them to the "test" script in tests/package.json, or name them in NOT_IN_THE_LIST_ON_PURPOSE with a reason`);
});

test('the list names only files that exist, once each, and the allow-list names no file that is listed or gone', () => {
  assert.deepEqual(listed.filter((name) => !onDisk.includes(name)), [], 'listed but not on disk');
  assert.deepEqual(listed.filter((name, i) => listed.indexOf(name) !== i), [], 'listed twice');
  for (const [name, reason] of Object.entries(NOT_IN_THE_LIST_ON_PURPOSE)) {
    assert.ok(onDisk.includes(name), `${name} is allowed but does not exist`);
    assert.ok(!listed.includes(name), `${name} is allowed but is listed`);
    assert.ok(typeof reason === 'string' && reason.length > 10, `${name} needs a reason`);
  }
});

test('this file is itself in the list', () => {
  assert.ok(listed.includes('test-list-complete.test.js'));
});
