import json,os,subprocess,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class Tests(unittest.TestCase):
 def go(self,d=None):
  td=tempfile.TemporaryDirectory(); out=Path(td.name)/'bundle'; inp=Path(td.name)/'in.json'; inp.write_text(json.dumps(d if d is not None else json.loads((ROOT/'example.setup.json').read_text()))); cp=subprocess.run(['python3',str(ROOT/'render_interviewer.py'),'--input',str(inp),'--output',str(out)],text=True,capture_output=True); return td,out,cp
 def test_render_and_validate(self):
  td,o,c=self.go(); self.addCleanup(td.cleanup); self.assertEqual(c.returncode,0,c.stderr); q=subprocess.run(['python3',str(ROOT/'validate_bundle.py'),str(o)],text=True,capture_output=True); self.assertEqual(q.returncode,0,q.stderr)
 def test_no_runtime_secrets_or_provider_ids(self):
  td,o,c=self.go(); self.addCleanup(td.cleanup); self.assertEqual(c.returncode,0,c.stderr); text='\n'.join(p.read_text(errors='ignore') for p in o.rglob('*') if p.is_file()); self.assertNotIn('TELEGRAM_BOT_TOKEN=',text); self.assertNotRegex(text,r'\b-?100\d{6,}\b')
 def test_rejects_secret_key(self):
  d=json.loads((ROOT/'example.setup.json').read_text()); d['backend']['api_key']='x'; td,o,c=self.go(d); self.addCleanup(td.cleanup); self.assertNotEqual(c.returncode,0); self.assertIn('secret-like key',c.stderr)
 def test_rejects_group_mode(self):
  d=json.loads((ROOT/'example.setup.json').read_text()); d['messaging']['allow_group_chats']=True; td,o,c=self.go(d); self.addCleanup(td.cleanup); self.assertNotEqual(c.returncode,0); self.assertIn('private and enrollment-authorized',c.stderr)
 def test_rejects_unknown_setting(self):
  d=json.loads((ROOT/'example.setup.json').read_text()); d['profile']['custom']='x'; td,o,c=self.go(d); self.addCleanup(td.cleanup); self.assertNotEqual(c.returncode,0); self.assertIn('profile contract mismatch',c.stderr)
 def test_rejects_no_enrollment(self):
  d=json.loads((ROOT/'example.setup.json').read_text()); d['backend']['enrollment_required']=False; td,o,c=self.go(d); self.addCleanup(td.cleanup); self.assertNotEqual(c.returncode,0); self.assertIn('enrollment verification',c.stderr)
 def test_refuses_nonempty_output(self):
  td=tempfile.TemporaryDirectory(); self.addCleanup(td.cleanup); out=Path(td.name)/'bundle'; out.mkdir(); (out/'keep').write_text('x'); cp=subprocess.run(['python3',str(ROOT/'render_interviewer.py'),'--input',str(ROOT/'example.setup.json'),'--output',str(out)],text=True,capture_output=True); self.assertNotEqual(cp.returncode,0); self.assertIn('output is not empty',cp.stderr)
 # --- #31: multiplex_profiles: true must travel with a GATEWAY_RELAY_URL stamp ---
 def install(self,*extra):
  """Run a real install against a TEMP HOME with a fake `hermes` on PATH; never touches ~/.hermes."""
  td=tempfile.TemporaryDirectory(); self.addCleanup(td.cleanup); t=Path(td.name); home=t/'home'; home.mkdir(); fb=t/'bin'; fb.mkdir()
  fake=fb/'hermes'; fake.write_text('#!/bin/sh\nif [ "$1" = profile ] && [ "$2" = create ]; then mkdir -p "$HOME/.hermes/profiles/$3"; printf "FOO=1" > "$HOME/.hermes/profiles/$3/.env"; fi\nexit 0\n'); fake.chmod(0o755)
  env=dict(os.environ,HOME=str(home),PATH=f"{fb}:/usr/bin:/bin")
  d=json.loads((ROOT/'example.setup.json').read_text()); name=d['profile']['name']; inp=t/'in.json'; inp.write_text(json.dumps(d))
  cp=subprocess.run(['python3',str(ROOT/'render_interviewer.py'),'--input',str(inp),'--output',str(t/'bundle'),'--install-profile',name,'--workspace',str(t/'ws'),*extra],text=True,capture_output=True,env=env)
  return cp,home/'.hermes/profiles'/name,t/'bundle'
 def test_install_refuses_without_relay_url_and_creates_nothing(self):
  cp,prof,_=self.install(); self.assertNotEqual(cp.returncode,0); self.assertIn('--relay-url',cp.stderr); self.assertFalse(prof.exists())
 def test_install_with_relay_url_stamps_the_profile_env(self):
  cp,prof,_=self.install('--relay-url','http://relay.example.test:4312'); self.assertEqual(cp.returncode,0,cp.stderr)
  self.assertIn('GATEWAY_RELAY_URL=http://relay.example.test:4312\n',(prof/'.env').read_text())
 def test_install_keeps_an_existing_env_and_appends_on_its_own_line(self):
  cp,prof,_=self.install('--relay-url','https://relay.example.test'); self.assertEqual(cp.returncode,0,cp.stderr)
  self.assertEqual((prof/'.env').read_text().splitlines(),['FOO=1','GATEWAY_RELAY_URL=https://relay.example.test'])
 def test_relay_url_without_install_is_an_error(self):
  cp=subprocess.run(['python3',str(ROOT/'render_interviewer.py'),'--input',str(ROOT/'example.setup.json'),'--output','/nonexistent-never-written/x','--relay-url','http://r.example.test'],text=True,capture_output=True); self.assertNotEqual(cp.returncode,0); self.assertIn('--install-profile',cp.stderr)
 def test_install_rejects_a_relay_url_that_could_inject_env_lines(self):
  for bad in ('not-a-url','http://x\nTELEGRAM_BOT_TOKEN=1','http://x y'):
   cp,prof,_=self.install('--relay-url',bad); self.assertNotEqual(cp.returncode,0,bad); self.assertIn('--relay-url',cp.stderr); self.assertFalse(prof.exists(),bad)
 def test_install_md_documents_the_stamp(self):
  td,o,c=self.go(); self.addCleanup(td.cleanup); self.assertEqual(c.returncode,0,c.stderr); text=(o/'INSTALL.md').read_text()
  self.assertIn('GATEWAY_RELAY_URL',text); self.assertIn('--relay-url',text)
if __name__=='__main__': unittest.main()
