"""Every shell script parses under macOS's own /bin/bash (3.2).

sshd runs a forced command, and launchd runs an agent, with whatever `bash`
the minimal PATH finds — /bin/bash 3.2 on this Mac, not Homebrew's 5.x. 3.2
mis-parses quotes inside a here-document inside `$( ... )`: on 2026-09-11 one
apostrophe in a Python comment inside companion-install-host.sh made the whole
forced command unparseable, and it failed with exit 0 and no output. A syntax
check under the interpreter that will actually run the file costs nothing.
"""
from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SYSTEM_BASH = "/bin/bash"


class ParsesUnderSystemBash(unittest.TestCase):
    @unittest.skipUnless(Path(SYSTEM_BASH).exists() or shutil.which("bash"), "no bash")
    def test_every_script_parses(self) -> None:
        bash = SYSTEM_BASH if Path(SYSTEM_BASH).exists() else shutil.which("bash")
        # control-plane/deployment/ was missing here until 2026-09-18, so every
        # vm-*.sh — relay restart, teardown, manual test, monitor bootstrap —
        # went unparsed. Those run on the VM, by hand, usually while something
        # is already wrong; a syntax error surfacing there is the worst place
        # for it.
        roots = ("scripts", ".agents/skills", "control-plane/deployment")
        scripts: list[Path] = []
        for root in roots:
            found = sorted(p for p in (REPO / root).rglob("*.sh") if p.is_file())
            self.assertTrue(found, f"no shell scripts under {root} — the glob is wrong")
            scripts += found
        for script in scripts:
            with self.subTest(script=str(script.relative_to(REPO))):
                result = subprocess.run([bash, "-n", str(script)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr.strip())


if __name__ == "__main__":
    unittest.main()
