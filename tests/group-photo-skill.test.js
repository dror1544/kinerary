/**
 * group-photo-skill.test.js — what the companion is TOLD about the Telegram group photo
 * (docs/specs/sprint-9/x-trip-group-photo.md: "offer after a logo change; ask before doing it; report the real status").
 *
 * Like trip-logo-skill.test.js, this pins the text and the tool names it uses (which must be real tools of mcp/mcp.js); it
 * does NOT prove a model follows it. The behaviour that can be proved is in group-photo-connectors.test.js (the tools say
 * "requested", never "done") and group-photo-site.test.js (the request row is the only status).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(HERE, '..', '.agents', 'skills', 'trip-site-operations', 'SKILL.md'), 'utf8');
const template = readFileSync(join(HERE, '..', 'profile-templates', 'familytrip-companion', 'templates', 'skills', 'travel', 'familytrip-companion-operations', 'SKILL.md'), 'utf8');
const mcpSource = readFileSync(join(HERE, '..', 'mcp', 'mcp.js'), 'utf8');
const toolsSource = readFileSync(join(HERE, '..', 'server', 'trip-mcp', 'tools.js'), 'utf8');

function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `has "## ${heading}"`);
  const next = text.indexOf('\n## ', start + 3);
  return text.slice(start, next < 0 ? undefined : next);
}
const workflow = section(skill, 'Workflow: Telegram group photo');
const brief = section(template, 'Telegram group photo');

describe('the Telegram group photo workflow in the companion\'s skill', () => {
  test('it is reachable from the trigger list and from the end of the logo workflow', () => {
    assert.match(section(skill, 'When to use'), /Workflow: Telegram group photo/);
    assert.match(section(skill, 'Workflow: Trip logo (set, replace or remove)'), /Offer the group photo/);
  });

  test('the tools it names are real, on the companion\'s MCP and on the trip connector', () => {
    for (const name of ['set_group_photo_from_logo', 'get_group_photo_status']) {
      assert.ok(workflow.includes(`mcp__trip_mcp__${name}`), name);
      assert.ok(mcpSource.includes(`mcp.tool('${name}'`), `${name} is registered in mcp/mcp.js`);
      assert.ok(toolsSource.includes(`'${name}'`), `${name} is registered in server/trip-mcp/tools.js`);
      assert.ok(brief.includes(name), `${name} is in the profile template`);
    }
  });

  test('only an organizer, in their own private chat; a member or the group gets neither tool called', () => {
    assert.match(workflow, /Only an organizer, and only in their own private chat/);
    assert.match(workflow, /refuse, call neither tool, and say who can/);
    assert.match(brief, /Only an organizer, in their own private chat/);
    assert.match(brief, /call neither tool/);
  });

  test('it asks first: the offer, then a clear yes, and never as a side effect of a logo change', () => {
    assert.match(workflow, /Call `set_group_photo_from_logo` only after a clear yes/);
    assert.match(workflow, /never as a side effect of a logo change/);
    assert.match(section(skill, 'Workflow: Trip logo (set, replace or remove)'), /Do not ask the tools anything about it until the organizer says yes/);
    assert.match(brief, /only after a clear yes/);
  });

  test('it is a request, not a result: the companion says it has asked, and reports exactly the status', () => {
    assert.match(workflow, /never "done"/);
    assert.match(workflow, /Report the real status/);
    for (const status of ['done', 'bot_lacks_rights', 'no_group', 'failed', 'expired']) assert.ok(workflow.includes(`\`${status}\``), status);
    assert.match(workflow, /Never say "done" before the status says `done`/);
    assert.match(workflow, /make the bot an admin with "Change group info", then ask again/);
    assert.match(brief, /make the bot an admin with "Change group info", then ask again/);
  });

  test('the switch off: the tools request nothing and the companion relays that plainly', () => {
    assert.match(workflow, /`feature_off`/);
    assert.match(workflow, /do not promise a date/);
  });

  test('the verification list requires the status read, and the rules say it is only ever the logo', () => {
    assert.match(skill, /verify with `get_group_photo_status` that its `status` is `done`/);
    assert.match(skill, /only ever the trip logo/);
  });
});
