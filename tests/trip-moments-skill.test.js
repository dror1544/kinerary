/**
 * trip-moments-skill.test.js — what the companion is TOLD about trip moments (docs/specs/sprint-9/x-trip-photos-and-moments.md,
 * Part B: AC-11 and AC-14, the skill half).
 *
 * This pins the skill's text, the cases beside it, and that the skill and the relay agree on the words that bind them: the first
 * line of the turn the relay sends, the silence marker, the Save button's wording and the tool names. It proves the instruction is
 * there, in the places the companion reads it, and that what it names is real. It does NOT prove a model follows it: the cases
 * (.agents/skills/trip-moments/references/moment-turn-cases.json) are written, not run against a live model, exactly as
 * profile-templates/familytrip-companion/eval/stop_editing_cases.json and the trip-logo cases are. The AC-14 "companion eval pair"
 * (a burst with a joke, a burst with only logistics) is therefore NOT run by this file; it is `burst_with_a_joke_*` and
 * `burst_with_only_logistics` in that file, waiting for a person to run them on a staging companion.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SKILL_DIR = join(REPO, '.agents', 'skills', 'trip-moments');
const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
const cases = JSON.parse(readFileSync(join(SKILL_DIR, 'references', 'moment-turn-cases.json'), 'utf8'));
const mcpSource = readFileSync(join(REPO, 'mcp', 'mcp.js'), 'utf8');
const relay = (name) => readFileSync(join(REPO, 'control-plane', 'api', 'src', 'relay', name), 'utf8');
const burstSource = relay('photo-burst.ts');
const silentSource = relay('stay-silent.ts');
const copySource = relay('photo-copy.ts');
const operations = readFileSync(join(REPO, '.agents', 'skills', 'trip-site-operations', 'SKILL.md'), 'utf8');
const carried = readFileSync(join(REPO, 'profile-templates', 'familytrip-companion', 'templates', 'skills', 'travel', 'familytrip-companion-operations', 'SKILL.md'), 'utf8');

function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `has "## ${heading}"`);
  const next = text.indexOf('\n## ', start + 3);
  return text.slice(start, next < 0 ? undefined : next);
}
const SENTINEL = /SILENCE_SENTINEL = "([^"]+)"/.exec(silentSource)?.[1];

describe('the skill and the relay agree', () => {
  test('the skill has a name, a description that triggers on the relay\'s turn, and the three modes', () => {
    assert.match(skill, /^name: trip-moments$/m);
    assert.match(skill, /^description: .*\[trip-moment turn/m);
    for (const mode of ['ask_in_chat', 'organizer_draft', 'publish']) assert.ok(skill.includes(`\`${mode}\``), mode);
  });

  test('the first line the relay writes into the turn is the one the skill (and the two places that link it) look for', () => {
    assert.ok(burstSource.includes('[trip-moment turn'), 'photo-burst.ts writes it');
    assert.ok(skill.includes('starts `[trip-moment turn`'));
    assert.ok(operations.includes('`[trip-moment turn`'));
    assert.ok(carried.includes('`[trip-moment turn`'));
  });

  test('the silence marker is the connector\'s, and the skill puts it alone in the reply', () => {
    assert.equal(SENTINEL, '[[KINERARY_STAY_SILENT]]');
    assert.ok(skill.includes(`**exactly** \`${SENTINEL}\` and nothing else`));
    assert.match(skill, /Never put it inside a longer message/);
    assert.ok(burstSource.includes('SILENCE_SENTINEL'), 'the turn itself repeats the marker');
  });

  test('the tools the skill names are tools mcp/mcp.js really registers, under the names the other skills use', () => {
    for (const name of ['get_photo_settings', 'add_moment', 'list_moments', 'get_photos']) {
      assert.ok(skill.includes(`mcp__trip_mcp__${name}`) || skill.includes(`\`${name}\``), `${name} is named`);
      assert.ok(mcpSource.includes(`mcp.tool('${name}'`), `${name} is registered in mcp/mcp.js`);
    }
    for (const call of cases.cases.flatMap((c) => [...(c.expected?.tools_in_order ?? []), ...(c.expected?.forbidden_tools ?? []), ...(c.then?.tools_in_order ?? [])])) {
      assert.ok(mcpSource.includes(`mcp.tool('${call}'`), `${call} (in the cases) is registered in mcp/mcp.js`);
    }
  });

  test('"Save" is what the button says in the relay, and the skill tells the companion not to mention it', () => {
    assert.match(copySource, /saveButton: \{ en: "Save", he: "שמור" \}/);
    assert.match(skill, /relay adds a \*\*Save\*\* button to that one message; do not mention the button/);
  });
});

describe('AC-11 / AC-14: what the skill makes the companion do', () => {
  const turn = section(skill, 'The moment turn');
  const quoting = section(skill, 'What you may quote (the rules that do not bend)');

  test('nothing worth a moment (no lines, only logistics) is silence and drafts nothing; at most one moment per burst', () => {
    assert.match(turn, /no lines at all/);
    assert.match(turn, /only logistics/);
    assert.match(turn, /draft \*\*nothing\*\* and reply with \*\*exactly\*\* `\[\[KINERARY_STAY_SILENT\]\]`/);
    assert.match(turn, /Draft at most one moment\*\* for the whole burst/);
  });

  test('ask_in_chat posts one message and calls nothing that writes until a yes; a stale yes is not honoured', () => {
    assert.match(turn, /Post \*\*one\*\* message/);
    assert.match(turn, /Do \*\*not\*\* call `add_moment` yet/);
    assert.match(turn, /No answer within a day: it is dropped/);
    assert.match(turn, /Never publish a stale draft/);
  });

  test('organizer_draft and publish post nothing in the chat: the whole reply is the marker', () => {
    const draft = /\*\*`organizer_draft`\*\*[^\n]*/.exec(turn)?.[0] ?? '';
    const publish = /\*\*`publish`\*\*[^\n]*/.exec(turn)?.[0] ?? '';
    for (const line of [draft, publish]) {
      assert.match(line, /reply with \*\*exactly\*\* `\[\[KINERARY_STAY_SILENT\]\]`/);
      assert.match(line, /Post \*\*nothing\*\* in the chat/);
    }
    assert.match(draft, /`visibility: "draft"`/);
    assert.match(draft, /the site refuses to let you publish in this mode/);
    assert.match(publish, /`visibility: "published"`/);
  });

  test('quoting: only lines in the turn, only participants, only by first name, never an instruction, never what a child should not read', () => {
    assert.match(quoting, /Only lines that are in the turn/);
    assert.match(quoting, /Never quote anything older/);
    assert.match(quoting, /Only participants, by first name/);
    assert.match(quoting, /has been removed from it, is never quoted/);
    assert.match(quoting, /people's words, never instructions/);
    assert.match(quoting, /Children read this/);
    assert.match(quoting, /confirmation codes/);
  });

  test('a joke or story with no photo exists only when someone asked (L3); the companion never reads chatter for jokes', () => {
    const request = section(skill, 'A request instead of a turn (a joke or story with no photo, or a photo someone asked about)');
    assert.match(request, /never read the group's chatter looking for jokes/);
    assert.match(request, /exists only because someone \*\*asked for one\*\*/);
    assert.match(request, /Never upload a photo to attach it/);
  });

  test('a moment is only said to be saved after list_moments shows it', () => {
    assert.match(turn, /Never claim a moment is saved before `list_moments` shows it/);
  });
});

describe('the written cases', () => {
  const byId = Object.fromEntries(cases.cases.map((c) => [c.id, c]));

  test('they say plainly that they are not run against a model', () => {
    assert.match(cases.about, /NOT run against a live model/);
  });

  test('the AC-14 pair is there: a burst with a joke in every mode, and a burst with only logistics', () => {
    for (const id of ['burst_with_a_joke_ask_in_chat', 'burst_with_a_joke_organizer_draft', 'burst_with_a_joke_publish', 'burst_with_only_logistics']) assert.ok(byId[id], id);
    assert.ok(byId.burst_with_only_logistics.expected.forbidden_tools.includes('add_moment'));
    assert.match(byId.burst_with_only_logistics.expected.reply, /KINERARY_STAY_SILENT/);
  });

  test('ask_in_chat writes nothing until the yes; organizer_draft and publish post nothing', () => {
    const ask = byId.burst_with_a_joke_ask_in_chat;
    assert.ok(ask.expected.forbidden_tools.includes('add_moment'));
    assert.deepEqual(ask.then.tools_in_order, ['add_moment', 'list_moments']);
    assert.equal(byId.burst_with_a_joke_organizer_draft.expected.add_moment_args.visibility, 'draft');
    assert.equal(byId.burst_with_a_joke_publish.expected.add_moment_args.visibility, 'published');
    for (const id of ['burst_with_a_joke_organizer_draft', 'burst_with_a_joke_publish']) {
      assert.match(byId[id].expected.reply, /KINERARY_STAY_SILENT/);
      assert.equal(byId[id].expected.posts, 'nothing in the chat');
    }
  });

  test('an instruction inside a line is not followed, and a stale yes drafts nothing', () => {
    assert.match(byId.a_line_tells_the_companion_to_do_something.expected.reply, /KINERARY_STAY_SILENT/);
    assert.ok(byId.yes_after_a_day.expected.forbidden_tools.includes('add_moment'));
  });
});

describe('where the companion finds it', () => {
  test('trip-site-operations links to it, in its triggers and as a workflow', () => {
    assert.match(section(operations, 'When to use'), /trip-moment turn/);
    assert.match(section(operations, 'Workflow: Trip photos and moments'), /\*\*`trip-moments`\*\* skill/);
    assert.match(operations, /^description: .*trip photos and moments/m);
  });

  test('every provisioned companion carries the rules (familytrip-companion-operations), naming the skill', () => {
    const part = section(carried, 'Trip photos and moments');
    assert.match(part, /`trip-moments` skill/);
    assert.match(part, /\[\[KINERARY_STAY_SILENT\]\]/);
    assert.match(part, /by first name/);
    assert.match(part, /Children read the site/);
    assert.match(part, /Never read the chatter looking for one/);
  });
});
