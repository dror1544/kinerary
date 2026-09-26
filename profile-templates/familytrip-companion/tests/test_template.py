import json,re,subprocess,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class Tests(unittest.TestCase):
 def go(self,d=None):
  td=tempfile.TemporaryDirectory(); out=Path(td.name)/'bundle'; inp=Path(td.name)/'in.json'; inp.write_text(json.dumps(d if d is not None else json.loads((ROOT/'example.handoff.json').read_text()))); cp=subprocess.run(['python3',str(ROOT/'render_profile.py'),'--input',str(inp),'--output',str(out)],text=True,capture_output=True); return td,out,cp
 def test_render_validate(self):
  td,o,c=self.go(); self.addCleanup(td.cleanup); self.assertEqual(c.returncode,0,c.stderr); v=subprocess.run(['python3',str(ROOT/'validate_bundle.py'),str(o)],text=True,capture_output=True); self.assertEqual(v.returncode,0,v.stderr)
 def test_visibility_split(self):
  td,o,c=self.go(); self.addCleanup(td.cleanup); self.assertEqual(c.returncode,0,c.stderr); g=(o/'references/group-context.json').read_text(); p=(o/'references/interview-context.private.json').read_text(); self.assertNotIn('Reduce repeated logistics questions',g); self.assertIn('Reduce repeated logistics questions',p); self.assertNotIn('Vegetarian',g); self.assertIn('Vegetarian',p)
 def test_unconfirmed_rejected(self):
  d=json.loads((ROOT/'example.handoff.json').read_text()); d['interview']['confirmed']=False; td,o,c=self.go(d); self.addCleanup(td.cleanup); self.assertNotEqual(c.returncode,0); self.assertIn('organizer-confirmed',c.stderr)
 def test_secret_key_rejected(self):
  d=json.loads((ROOT/'example.handoff.json').read_text()); d['interview']['organizer_private']['bot_token']='x'; td,o,c=self.go(d); self.addCleanup(td.cleanup); self.assertNotEqual(c.returncode,0); self.assertIn('secret-like key',c.stderr)
 def test_raw_intake_rejected(self):
  d=json.loads((ROOT/'example.handoff.json').read_text()); d['interview']['raw_intake']={'answer':'x'}; td,o,c=self.go(d); self.addCleanup(td.cleanup); self.assertNotEqual(c.returncode,0); self.assertIn('raw intake must remain outside',c.stderr)
 def test_soul_states_the_assigned_gender(self):
  # The bug this covers: gender reached group-context.json and nothing else,
  # so the assistant inferred its own from how its name sounds — wrong in
  # every Hebrew first-person sentence. Asserted per value, not once, because
  # a hardcoded sentence in the template would pass a single-gender check.
  for gender,expected,forbidden in [('male','**masculine**','**feminine**'),('female','**feminine**','**masculine**'),('neutral','avoid gendering yourself','**masculine**')]:
   d=json.loads((ROOT/'example.handoff.json').read_text()); d['assistant']['gender']=gender
   td,o,c=self.go(d); self.addCleanup(td.cleanup); self.assertEqual(c.returncode,0,c.stderr)
   soul=(o/'SOUL.md').read_text()
   self.assertIn(expected,soul,gender); self.assertNotIn(forbidden,soul,gender)
   self.assertIn('assigned, never inferred',soul,gender)
   self.assertIn(d['assistant']['name'],soul.split('assigned, never inferred')[1][:400],gender)
 def test_soul_states_the_assigned_tone(self):
  # The bug this covers: tone reached group-context.json and nothing else, so
  # every companion spoke the same regardless of what was chosen. Asserted per
  # value, not once, because a hardcoded sentence would pass a single check.
  for tone,expected,forbidden in [('warm','Speak warmly','Speak playfully'),('playful','Speak playfully','Speak dryly'),('dry','Speak dryly','Speak warmly')]:
   d=json.loads((ROOT/'example.handoff.json').read_text()); d['assistant']['tone']=tone
   td,o,c=self.go(d); self.addCleanup(td.cleanup); self.assertEqual(c.returncode,0,c.stderr)
   soul=(o/'SOUL.md').read_text()
   self.assertIn(expected,soul,tone); self.assertNotIn(forbidden,soul,tone)
   self.assertIn('tone is set too, not defaulted',soul,tone)
 def test_profile_description_is_yaml_safe(self):
  d=json.loads((ROOT/'example.handoff.json').read_text()); d['profile']['description']='A trip: "quoted"'; td,o,c=self.go(d); self.addCleanup(td.cleanup); self.assertEqual(c.returncode,0,c.stderr); self.assertIn('description: "A trip: \\"quoted\\""',(o/'profile.yaml').read_text())
 def test_shipped_skills_find_their_own_files(self):
  # trip-kml-export ran its script from $PROFILE_SKILLS_DIR, which nothing
  # defines, so on every companion the path pointed at /travel/... (#71). A
  # skill locates its files through skill_view's skill_dir, never an env var
  # or a path copied from one machine's profile.
  for f in (ROOT/'templates/skills').rglob('SKILL.md'):
   t=f.read_text(); self.assertNotIn('$PROFILE_SKILLS_DIR',t,str(f)); self.assertNotIn('/Users/',t,str(f))
  td,o,c=self.go(); self.addCleanup(td.cleanup); self.assertEqual(c.returncode,0,c.stderr)
  self.assertTrue(list(o.rglob('trip-kml-export/scripts/trip_kml_export.py')),'the rendered profile must still ship the export script')

# ── #240: no example person, and no example need, reaches a companion ─────────
# SOUL.md.tpl said, as its worked example of a group-visible need, "the ramen
# place has a nut-free menu for Eitan". It was rendered verbatim into every
# companion; a companion on a trip with NO recorded needs and no Eitan on it
# told a real family a dinner had "nut-free options for Eitan". Whatever a
# prompt shows as an example, a model can hand back as a fact.
#
# The checks work on EXAMPLE SPANS, because that is the shape a model copies —
# text set off as something to say. A span is any of:
#   - a quotation on one line: "…", “…”, «…», „…“, '…', ‘…’ (a single quote
#     counts only when no letter touches its outside, so "organizer's" never
#     opens one);
#   - a markdown blockquote line (`> …`) — this package's own idiom for a
#     sample message (SOUL.md.tpl's escaping example);
#   - a line inside a ``` fence — the skills' idiom for a message template;
#   - what follows "e.g." / "for example" / "for instance" / «למשל» /
#     «לדוגמה» up to the end of the sentence, quoted or not.
# A span is "need-bearing" when it holds a health/dietary/mobility term. Three
# things are then checked, deliberately not by string-matching the one bad
# sentence (a rewording would pass that):
#  (a) a need-bearing span names no one: no capitalised Latin word except one
#      opening the span or a sentence in it; no single-letter initial ("E.");
#      no kin word pointing at a person ("for her son", «לבן שלה»); and no
#      name from EXAMPLE_NAMES in either script, in any letter case. A person
#      in such a span must be a placeholder (`<name>`), which is lower-case
#      inside angle brackets and so never matches.
#  (b) no name from EXAMPLE_NAMES appears anywhere in a rendered bundle, in any
#      letter case, unless the handoff put it there.
#  (c) (a) and (b) over the TEMPLATE SOURCES, so an edit is caught at the file
#      that was edited rather than at whatever a render happens to include.
# What this CANNOT see, every gap known on 2026-09-26 (each is pinned below as
# a case the check lets through, so a change that closes one shows up):
#  - a name not on EXAMPLE_NAMES that opens a sentence inside a need-bearing
#    span ("…nut-free menu. Lior will love it"): at a sentence start a capital
#    is grammar, and telling "Lior" from "Please" needs a name list;
#  - a Hebrew name not on EXAMPLE_NAMES (Hebrew has no capital letters), with
#    or without a prefix: «לליאור»;
#  - a name not on the list outside any need-bearing span;
#  - an example that is none of the span shapes above: plain prose with no
#    quote, blockquote, fence or "e.g." marker, or a quotation broken across
#    lines;
#  - a need term the vocabulary below does not hold.
# The list is the names this repo's own prompts use as examples (grep, #240
# handover); the Hebrew half leaves out the ones that are also ordinary words
# (גל wave, שי gift, אבי my father, אלה these, דנה judges), which would make
# the check fire on prose.
EXAMPLE_NAMES_EN=('Eitan','Noa','Sagi','Dana','Ruth','Yael','Omri','Tomer','Maya','Gal','Avi','Shai','Ella')
EXAMPLE_NAMES_HE=('נועה','שגיא','רות','יעל','עומרי','תומר','מאיה')
# איתן is also "with them" (fem.) — «לוודא איתן» is "check with them", which is
# exactly what the fix tells a companion to say. So it counts only with a
# prefix («לאיתן», for Eitan), which the preposition never takes.
HE_LETTER='\u05d0-\u05ea'
NAME_RE=re.compile(r'(?i:\b(?:'+'|'.join(EXAMPLE_NAMES_EN)+r')\b)'
 +r'|(?<!['+HE_LETTER+r'])(?:[ולבהמשכ]?(?:'+'|'.join(EXAMPLE_NAMES_HE)+r')|[ולבהמשכ]איתן)(?!['+HE_LETTER+r'])')
NEED_RE=re.compile(
 r'allerg|anaphyla|epi-?pen|\bnuts?\b|nut-free|peanut|tree.nut|sesame|shellfish|gluten|celiac|coeliac|lactose|dairy'
 r'|kosher|halal|vegan|vegetarian|pescatarian|diabet|insulin|asthma|wheelchair|mobility|medical|medication|dietary'
 r'|אלרג|אגוז|בוטנ|שומשום|גלוטן|צליאק|לקטוז|כשר|חלאל|טבעונ|צמחונ|סוכרת|אינסולין|אסתמה|כיסא גלגלים|תרופ',re.I)
# Bounded, so an unmatched quote cannot swallow a page.
QUOTE_RE=re.compile(r'"([^"\n]{3,300})"|“([^”\n]{3,300})”|«([^»\n]{3,300})»|„([^“\n]{3,300})“'
 r"|(?<![\w'])'([^'\n]{3,300})'(?![\w'])|‘([^’\n]{3,300})’")
EXAMPLE_MARK_RE=re.compile(r'(?:\be\.g\.|\bfor (?:example|instance)\b|למשל|לדוגמה)[:,]?\s*(.{3,300}?)(?=[.;!?](?:\s|$)|$)',re.I)
BLOCKQUOTE_RE=re.compile(r'^\s*>\s?(.{3,})$')
CAPITAL_RE=re.compile(r'(?<![\w<`$])[A-Z][a-z]+')
INITIAL_RE=re.compile(r'(?<![\w.])[A-Z]\.(?![\w.])')
KIN_RE=re.compile(r'\b(?:his|her|their|your|my|our|the)\s+(?:son|daughter|kids?|child(?:ren)?|husband|wife|partner'
 r'|mom|mum|mother|dad|father|grandma|grandmother|grandpa|grandfather|baby|toddler|brother|sister)\b'
 # Hebrew kin needs the possessive: bare בן/בת is also "aged" («בן 12»).
 r'|(?<!['+HE_LETTER+r'])[ולבהמשכ]?ה?(?:בן|בת|ילד|ילדה|אח|אחות)\s+של(?:ה|ו|כם|כן|ך|נו|י)(?!['+HE_LETTER+r'])'
 r'|(?<!['+HE_LETTER+r'])[ולבהמשכ]?(?:בנה|בתה|בנו|בתו|סבתא|סבא)(?!['+HE_LETTER+r'])',re.I)
TEXT_SUFFIXES={'.md','.tpl','.py','.json','.yaml','.txt'}

def example_spans(text):
 """Every (line number, span) a model could take as a sentence to say."""
 fenced=False
 for n,line in enumerate(text.splitlines(),1):
  if line.lstrip().startswith('```'): fenced=not fenced; continue
  if fenced and line.strip(): yield n,line.strip()
  m=BLOCKQUOTE_RE.match(line)
  if m: yield n,m.group(1)
  for m in QUOTE_RE.finditer(line): yield n,next(g for g in m.groups() if g is not None)
  for m in EXAMPLE_MARK_RE.finditer(line): yield n,m.group(1)

def need_quote_problems(text):
 """(a): every example span that holds a need term and also names someone."""
 out=[]
 for n,span in example_spans(text):
  if not NEED_RE.search(span): continue
  # A capital that opens the span, a sentence or a bullet inside it is
  # grammar, not a name. Anything else capitalised is someone.
  named=[w.group(0) for w in CAPITAL_RE.finditer(span)
         if not re.search(r'(^|[.!?:;—–]\s*)[\s(*_\'"•·>-]*$',span[:w.start()])]
  named+=INITIAL_RE.findall(span)+KIN_RE.findall(span)+NAME_RE.findall(span)
  if named: out.append(f'line {n}: "{span}" names {sorted(set(named))}')
 return out

def example_name_problems(text,roster=()):
 """(b): every example name in the text that the roster did not supply."""
 given={w.casefold() for r in roster for w in r.split()}
 out=[]
 for n,line in enumerate(text.splitlines(),1):
  for m in NAME_RE.finditer(line):
   name=m.group(0)
   if name.casefold() in given or name[1:].casefold() in given: continue
   out.append(f'line {n}: {name!r} in {line.strip()[:120]!r}')
 return out

def text_files(root):
 return [p for p in sorted(root.rglob('*')) if p.is_file() and p.suffix in TEXT_SUFFIXES]

# A roster with nobody from EXAMPLE_NAMES, obviously fictional, and no needs:
# the exact case the incident happened in — nothing on file to contradict an
# example.
FICTIONAL_ORGANIZER='Orla Brightwater'
FICTIONAL_ASSISTANT='Pim'

class NoExamplePeople(unittest.TestCase):
 def render_empty_needs(self):
  d=json.loads((ROOT/'example.handoff.json').read_text())
  d['organizer']['display_name']=FICTIONAL_ORGANIZER
  d['assistant']['name']=FICTIONAL_ASSISTANT; d['assistant']['name_en']=FICTIONAL_ASSISTANT
  d['interview']['participant_needs']=[]
  td,o,c=Tests.go(self,d); self.addCleanup(td.cleanup); self.assertEqual(c.returncode,0,c.stderr)
  return o

 def test_the_checks_are_not_vacuous(self):
  # Each check must fire on the sentence that reached a family, in both of
  # the forms it was delivered in, and on a Hebrew name — or a green run
  # proves nothing.
  self.assertTrue(need_quote_problems('so name it ("the ramen place has a nut-free menu for Eitan")'))
  self.assertTrue(need_quote_problems('«אפשרויות ללא אגוזים (מתאים ל‑Eitan)»'))
  self.assertTrue(need_quote_problems('“יש שם תפריט ללא גלוטן לנועה”'))
  self.assertTrue(need_quote_problems('"Dana can have the gluten-free pasta"'))
  self.assertTrue(example_name_problems('a menu for Eitan'))
  self.assertTrue(example_name_problems('מתאים לאיתן'))
  self.assertEqual(example_name_problems('כדאי לוודא איתן לפני שיוצאים'),[])
  # Round-2 rewordings of the incident, each one a shape the first lint let through.
  for caught in ('"the ramen place has a nut-free menu for eitan"',
                 '"the ramen place has a nut-free menu for E."',
                 "so name it ('the ramen place has a nut-free menu for Lior')",
                 '> the ramen place has a nut-free menu for Lior',
                 '```\nthe ramen place has a nut-free menu for Lior\n```',
                 'name it, e.g. the ramen place has a nut-free menu for Lior.',
                 'למשל: יש שם תפריט ללא גלוטן לבן שלה',
                 '"the ramen place has a nut-free menu for her son"'):
   self.assertTrue(need_quote_problems(caught),caught)
  # Known gaps, pinned so closing one is noticed (see the header).
  for gap in ('"the ramen place has a nut-free menu. Lior will love it"',
              '"יש שם תפריט ללא אגוזים לליאור"',
              'the ramen place has a nut-free menu for Lior'):
   self.assertEqual(need_quote_problems(gap),[],gap)
  # …and must NOT fire on the forms the fix uses, or on ordinary prose.
  self.assertEqual(need_quote_problems('"<venue>\'s site lists a <need> option for <name>; I couldn\'t confirm it"'),[])
  self.assertEqual(need_quote_problems('"Nut-free options are listed online; please check with the venue"'),[])
  self.assertEqual(need_quote_problems('"• Remember what people need — diets, allergies, preferences"'),[])
  self.assertEqual(need_quote_problems("the organizer's choice; a need's visibility isn't 'group' by default"),[])
  self.assertEqual(example_name_problems('Galapagos, Avignon, Mayan ruins, gallery'),[])
  self.assertEqual(example_name_problems('Eitan, Noa',roster=('Eitan','Noa')),[])

 def test_rendered_companion_pairs_no_person_with_a_need(self):
  o=self.render_empty_needs()
  soul=(o/'SOUL.md').read_text()
  # The scan reads the text that names people: the organizer is in it.
  self.assertIn(FICTIONAL_ORGANIZER,soul)
  problems=[]
  for p in text_files(o):
   if p.suffix=='.json': continue
   problems+=[f'{p.relative_to(o)}: {x}' for x in need_quote_problems(p.read_text())]
  self.assertEqual(problems,[],'a quoted example pairs a person with a need — a model can repeat it as a fact (#240)')

 def test_rendered_companion_names_no_one_outside_the_roster(self):
  o=self.render_empty_needs()
  problems=[]
  for p in text_files(o):
   problems+=[f'{p.relative_to(o)}: {x}' for x in example_name_problems(p.read_text(),roster=(FICTIONAL_ORGANIZER,FICTIONAL_ASSISTANT))]
  self.assertEqual(problems,[],'an example name reaches a companion whose roster does not have it (#240)')

 def test_template_sources_use_placeholders_for_people(self):
  # (c) the lint on the sources: whatever an edit puts back, it is caught in
  # the file that was edited, before any render.
  problems=[]
  for p in text_files(ROOT/'templates'):
   t=p.read_text()
   problems+=[f'{p.relative_to(ROOT)}: {x}' for x in need_quote_problems(t)+example_name_problems(t)]
  self.assertEqual(problems,[],'write example people as <name> and needs as <need> (#240)')

 def test_the_need_rules_survive_the_fix(self):
  # The fix must not over-correct: a recorded group-visible need is still
  # named when it matters, an organizer-visible one is still planned around
  # without naming, a critical one still needs a confirmed place — and the
  # new rules are present. Asserted on the RENDERED text, section by section.
  soul=(self.render_empty_needs()/'SOUL.md').read_text()
  privacy=soul.split('## Privacy and learning',1)[1].split('\n## ',1)[0]
  self.assertIn('`"group"`: the family knows, so when it matters name the person by their roster name',privacy)
  self.assertIn('plan around it without naming the person or the need',privacy)
  self.assertIn('A `critical` one, an allergy, is never optional',privacy)
  self.assertIn('A need is a recorded fact, never an inference',privacy)
  self.assertIn('With nothing recorded and nothing said',privacy)
  # A need the interview filed for the whole group is a standing instruction,
  # not a participant need; the rule must count it or it drops a real allergy.
  self.assertIn('is a `standing_instructions` entry',privacy)
  self.assertIn('never pin it on somebody',privacy)
  # Round 2: a need saved earlier (memory, a trip rule, the organizer's DM)
  # still exists; a chat-told need is organizer-only; people who are named in
  # the conversation but not on the roster can still be spoken of.
  self.assertIn("or earlier and you saved it to this trip's memory or as a trip rule",privacy)
  self.assertIn('A need told to you in chat has no `visibility` of its own: it is organizer-only',privacy)
  self.assertIn('nor named to you in this conversation, and never introduce a person nobody named',privacy)
  self.assertNotIn('never name anyone who is not on it',privacy)
  self.assertIn('never stated flatly',privacy)

if __name__=='__main__': unittest.main()
