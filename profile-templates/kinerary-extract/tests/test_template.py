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

class OneSourceForTheRouting(unittest.TestCase):
    """The overlay is the only place a model id is written.

    It was not. `install()` carried its own copy of every key and of the whole
    fallback chain, under a comment asking whoever edited one to edit the other.
    Both said `minimax/minimax-m3:free`, which is not a model id on OpenRouter,
    so the profile ran its fallback chain from the day it was written and no
    error was ever raised. A correction applied to the YAML alone would have
    changed nothing live, because the `config set` calls are what the profile
    gets. These tests fail if that split is reintroduced.
    """

    def overlay(self):
        import yaml
        return yaml.safe_load((ROOT / 'templates' / 'config.overlay.yaml').read_text())

    def rendered(self):
        td = tempfile.TemporaryDirectory()
        out = Path(td.name) / 'bundle'
        cp = subprocess.run(
            ['python3', str(ROOT / 'render_extract.py'),
             '--input', str(ROOT / 'example.setup.json'), '--output', str(out)],
            text=True, capture_output=True)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        return td, (out / 'INSTALL.md').read_text()

    def test_the_pinned_model_is_a_real_openrouter_id(self):
        """`:free` is a marketing suffix, not part of the id it is appended to."""
        self.assertNotIn(':free', self.overlay()['model']['default'])

    def test_install_instructions_are_derived_from_the_overlay(self):
        """Planted in the overlay, it must appear in what render writes — which
        it cannot if the script is reciting a list of its own."""
        y = ROOT / 'templates' / 'config.overlay.yaml'
        before = y.read_text()
        self.addCleanup(y.write_text, before)
        y.write_text(before.replace('provider: openrouter', 'provider: planted-provider', 1))
        td, install_md = self.rendered()
        self.addCleanup(td.cleanup)
        self.assertIn('planted-provider', install_md)

    def test_every_scalar_setting_reaches_the_instructions(self):
        td, install_md = self.rendered()
        self.addCleanup(td.cleanup)
        routing = self.overlay()
        for section, value in routing.items():
            if section == 'fallback_providers':
                continue
            for key, val in value.items():
                val = 'true' if val is True else 'false' if val is False else str(val)
                self.assertIn(f'config set {section}.{key} {val}', install_md)


if __name__ == '__main__':
    unittest.main()
