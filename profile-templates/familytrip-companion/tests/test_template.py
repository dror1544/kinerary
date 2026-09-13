import json,subprocess,tempfile,unittest
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
 def test_profile_description_is_yaml_safe(self):
  d=json.loads((ROOT/'example.handoff.json').read_text()); d['profile']['description']='A trip: "quoted"'; td,o,c=self.go(d); self.addCleanup(td.cleanup); self.assertEqual(c.returncode,0,c.stderr); self.assertIn('description: "A trip: \\"quoted\\""',(o/'profile.yaml').read_text())
if __name__=='__main__': unittest.main()
