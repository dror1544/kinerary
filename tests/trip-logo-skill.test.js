/**
 * trip-logo-skill.test.js — AC-13 (docs/specs/sprint-9/x-trip-logo.md): what the companion is TOLD about the trip logo.
 *
 * This pins the skill's text and the behavioural cases beside it. It proves the instruction is there, in the place the
 * companion reads it, and that the tool names it names are real tools of mcp/mcp.js. It does NOT prove that a model
 * follows it: the cases (references/trip-logo-cases.json) are written, not run against a live model, exactly as
 * profile-templates/familytrip-companion/eval/stop_editing_cases.json is. Say so wherever this test is cited.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(HERE, '..', '.agents', 'skills', 'trip-site-operations');
const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
const cases = JSON.parse(readFileSync(join(SKILL_DIR, 'references', 'trip-logo-cases.json'), 'utf8'));
const mcpSource = readFileSync(join(HERE, '..', 'mcp', 'mcp.js'), 'utf8');

function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `the skill has "## ${heading}"`);
  const next = text.indexOf('\n## ', start + 3);
  return text.slice(start, next < 0 ? undefined : next);
}
const logo = section(skill, 'Workflow: Trip logo (set, replace or remove)');

describe('AC-13: the Trip logo workflow in the skill', () => {
  test('it is reachable: the trigger list and the image workflow point at it', () => {
    assert.match(section(skill, 'When to use'), /Workflow: Trip logo/);
    assert.match(section(skill, 'Workflow: image / hero replacement requests'), /Trip logo workflow/);
    assert.match(skill, /^description: .*trip logo/m);
  });

  test('the tools it names are tools mcp/mcp.js really registers', () => {
    for (const name of ['upload_trip_logo', 'clear_trip_logo']) {
      assert.ok(logo.includes(`mcp__trip_mcp__${name}`), name);
      assert.ok(mcpSource.includes(`mcp.tool('${name}'`), `${name} is registered in mcp/mcp.js`);
    }
  });

  test('a member who asks is refused, and the companion names who can; neither tool is called', () => {
    assert.match(logo, /Only an organizer, and only in their own private chat/);
    assert.match(logo, /the check is yours/);
    assert.match(logo, /get_agent_brief/);
    assert.match(logo, /refuse, call neither tool, and say who can/);
    assert.match(logo, /name the organizers by their display names/);
  });

  test('with no image tool the companion says it cannot make one, offers the alternative, and never pretends', () => {
    assert.match(logo, /only if your toolset really has an image-generation tool/i);
    assert.match(logo, /I can't make images here/);
    assert.match(logo, /ChatGPT or Claude/);
    assert.match(logo, /Never pretend/);
    assert.match(logo, /never upload a placeholder/);
  });

  test('upload_trip_logo is only called with an image the organizer has seen and approved', () => {
    assert.match(logo, /Never call `upload_trip_logo` with anything the organizer has not seen and said yes to/);
    assert.match(logo, /one draft/);
    assert.match(logo, /upload only after a clear yes/);
  });

  test('it reads back before reporting, and does not claim installed apps were refreshed', () => {
    assert.match(logo, /`logo\.source` is `"upload"`/);
    assert.match(logo, /Do not say "done" on a tool error/);
    assert.match(logo, /a phone that already has the app installed keeps its old icon/);
  });

  test('it keeps the scaffold-time set_trip_logo out of reach', () => {
    assert.match(skill, /not the scaffold-time `set_trip_logo`/);
    assert.ok(!logo.includes('mcp__trip_mcp__set_trip_logo'));
  });

  test('the old claim that no write path exists no longer covers the logo', () => {
    assert.match(section(skill, 'Workflow: image / hero replacement requests'), /has its own workflow below, with a real write path/);
  });
});

describe('AC-13: the behavioural cases beside the skill', () => {
  const byId = Object.fromEntries(cases.cases.map((c) => [c.id, c]));

  test('written, not run — and says so', () => {
    assert.equal(cases.run_against_live_model, false);
    assert.match(cases._about.join(' '), /WRITTEN, NOT RUN/);
  });

  test('the member case: a member asks, nothing is uploaded or cleared, the reply names who can', () => {
    const c = byId.member_asks_for_new_logo;
    assert.equal(c.from, 'member');
    assert.deepEqual(c.expected.calls_in_order, []);
    assert.deepEqual(c.expected.forbidden_tools.sort(), ['clear_trip_logo', 'upload_trip_logo']);
    assert.ok(c.reply_must.some((line) => /only an organizer/i.test(line)));
    assert.ok(c.reply_must.some((line) => /names who can/i.test(line)));
  });

  test('the no-image-tool case: an organizer asks for a generated logo, the tool list has none, nothing is uploaded', () => {
    const c = byId.organizer_asks_generated_logo_without_an_image_tool;
    assert.equal(c.from, 'organizer');
    assert.equal(c.state.image_generation_tool, null);
    assert.ok(!c.state.tools_available.some((tool) => /image/i.test(tool)));
    assert.ok(c.expected.forbidden_tools.includes('upload_trip_logo'));
    assert.ok(c.reply_must.some((line) => /cannot make images/i.test(line)));
    assert.ok(c.reply_must.some((line) => /ChatGPT or Claude/.test(line)));
  });

  test('every case has both languages, and every tool it names is one the skill or mcp/mcp.js knows', () => {
    const known = new Set(['get_agent_brief', 'get_config', 'upload_trip_logo', 'clear_trip_logo', 'image_generate']);
    for (const c of cases.cases) {
      assert.ok(c.message.en && c.message.he, c.id);
      const named = [
        ...(c.expected.calls_in_order || []).map((call) => call.tool),
        ...(c.expected.forbidden_tools || []),
        ...(c.state.tools_available || []),
      ];
      for (const tool of named) assert.ok(known.has(tool), `${c.id}: ${tool}`);
    }
  });

  test('the approved-image case uploads exactly the attachment, after the organizer check, and the draft case waits for a yes', () => {
    const sent = byId.organizer_sends_an_image;
    assert.deepEqual(sent.expected.calls_in_order.map((call) => call.tool), ['get_agent_brief', 'upload_trip_logo']);
    assert.equal(sent.expected.calls_in_order[1].args.filePath, sent.attachment.path);
    const draft = byId.organizer_asks_generated_logo_with_an_image_tool;
    assert.ok(draft.expected.turn_1.forbidden_tools.includes('upload_trip_logo'));
    assert.deepEqual(draft.expected.turn_2.calls_in_order.map((call) => call.tool), ['upload_trip_logo']);
  });
});

describe('AC-13: the skill provisioned companions actually carry (familytrip-companion-operations)', () => {
  const carried = readFileSync(join(HERE, '..', 'profile-templates', 'familytrip-companion', 'templates', 'skills', 'travel', 'familytrip-companion-operations', 'SKILL.md'), 'utf8');
  const part = section(carried, 'Trip logo');

  test('it has the Trip logo section, naming both tools and the full workflow', () => {
    for (const name of ['upload_trip_logo', 'clear_trip_logo']) {
      assert.ok(part.includes(`\`${name}\``), name);
      assert.ok(mcpSource.includes(`mcp.tool('${name}'`), `${name} is registered in mcp/mcp.js`);
    }
    assert.match(part, /trip-site-operations/);
  });

  test('a member is refused and the organizers are named; an unapproved image is never uploaded; no image tool is said plainly', () => {
    assert.match(part, /call neither tool and say only an organizer can change the trip logo, naming the organizers/);
    assert.match(part, /Never call `upload_trip_logo` with an image they have not seen and said yes to/);
    assert.match(part, /cannot make images here/);
    assert.match(part, /ChatGPT or Claude/);
    assert.match(part, /Never pretend, never upload a placeholder/);
  });

  test('it reads back before reporting and does not claim installed apps changed', () => {
    assert.match(part, /logo\.source/);
    assert.match(part, /keeps its old icon/);
  });
});
