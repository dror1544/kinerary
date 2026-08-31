import json, subprocess, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class Tests(unittest.TestCase):
    def go(self, d=None):
        td = tempfile.TemporaryDirectory()
        out = Path(td.name) / 'bundle'
        inp = Path(td.name) / 'in.json'
        inp.write_text(json.dumps(d if d is not None else json.loads((ROOT / 'example.setup.json').read_text())))
        cp = subprocess.run(
            ['python3', str(ROOT / 'render_extract.py'), '--input', str(inp), '--output', str(out)],
            text=True, capture_output=True
        )
        return td, out, cp

    def test_render_and_validate(self):
        td, o, c = self.go()
        self.addCleanup(td.cleanup)
        self.assertEqual(c.returncode, 0, c.stderr)
        v = subprocess.run(['python3', str(ROOT / 'validate_bundle.py'), str(o)], text=True, capture_output=True)
        self.assertEqual(v.returncode, 0, v.stderr)

    def test_no_secrets_in_bundle(self):
        td, o, c = self.go()
        self.addCleanup(td.cleanup)
        self.assertEqual(c.returncode, 0, c.stderr)
        text = '\n'.join(p.read_text(errors='ignore') for p in o.rglob('*') if p.is_file())
        self.assertNotIn('ANTHROPIC_API_KEY=', text)
        self.assertNotIn('OPENAI_API_KEY=', text)

    def test_rejects_unknown_key(self):
        d = json.loads((ROOT / 'example.setup.json').read_text())
        d['extra_key'] = 'x'
        td, o, c = self.go(d)
        self.addCleanup(td.cleanup)
        self.assertNotEqual(c.returncode, 0)
        self.assertIn('unknown keys', c.stderr)

    def test_rejects_invalid_profile_name(self):
        d = json.loads((ROOT / 'example.setup.json').read_text())
        d['profile']['name'] = 'INVALID NAME'
        td, o, c = self.go(d)
        self.addCleanup(td.cleanup)
        self.assertNotEqual(c.returncode, 0)
        self.assertIn('invalid profile name', c.stderr)

    def test_refuses_nonempty_output(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        out = Path(td.name) / 'bundle'
        out.mkdir()
        (out / 'keep').write_text('x')
        cp = subprocess.run(
            ['python3', str(ROOT / 'render_extract.py'),
             '--input', str(ROOT / 'example.setup.json'), '--output', str(out)],
            text=True, capture_output=True
        )
        self.assertNotEqual(cp.returncode, 0)
        self.assertIn('not empty', cp.stderr)

if __name__ == '__main__':
    unittest.main()
