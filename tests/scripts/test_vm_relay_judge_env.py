"""The VM's relay receives every group-judge variable the relay reads.

compose.vm.yml lists the relay's environment by name, so a variable it does not
list never reaches the process. Until 2026-11-27 no JUDGE_* variable was listed:
the VM's relay logged `model_runner.judge_unset` and its groups (Telegram and
WhatsApp) were answered only when the assistant was named, while the Mac stack,
which reads its environment directly, had a judge.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "control-plane" / "deployment" / "compose.vm.yml"
SRC = ROOT / "control-plane" / "api" / "src"


FALLBACK_VARIABLES = {
    "JUDGE_FALLBACK_RUNNER",
    "JUDGE_FALLBACK_MODEL",
    "JUDGE_FALLBACK_EFFORT",
    "JUDGE_FALLBACK_TIMEOUT_MS",
}


def relay_block(text: str) -> str:
    start = text.index("\n  relay:\n")
    nxt = re.search(r"\n  [a-z][a-z0-9-]*:\n", text[start + 1:])
    return text[start: start + 1 + nxt.start()] if nxt else text[start:]


def judge_variables() -> set:
    found = set()
    for path in SRC.rglob("*.ts"):
        found.update(re.findall(r"env\.(JUDGE_[A-Z_]+)", path.read_text(errors="replace")))
    # The binding itself: the model runner resolves the task's model and effort by name.
    found.update({"JUDGE_RUNNER", "JUDGE_MODEL", "JUDGE_EFFORT"})
    # The quota fallback (2026-11-27): listed by name as well as found in the source, so
    # a rewrite of how model-runner.ts reads them cannot quietly take them out of the net.
    found.update(FALLBACK_VARIABLES)
    return found


class RelayJudgeEnv(unittest.TestCase):
    def test_every_judge_variable_reaches_the_relay(self):
        block = relay_block(COMPOSE.read_text())
        wanted = judge_variables()
        self.assertGreaterEqual(len(wanted), 5, wanted)
        missing = sorted(v for v in wanted if not re.search(rf"^\s+{v}: \$\{{{v}:-\}}$", block, re.M))
        self.assertEqual(missing, [], "compose.vm.yml's relay does not pass these through (optional, `:-`)")

    def test_the_source_reads_the_four_fallback_variables(self):
        # If the source stops naming one, the pass-through test above would stop
        # requiring it; this keeps the two ends honest.
        source = "\n".join(p.read_text(errors="replace") for p in SRC.rglob("*.ts"))
        for name in sorted(FALLBACK_VARIABLES):
            self.assertIn(name, source, f"{name} is no longer read by the relay's source")

    def test_the_fallback_is_documented_in_vm_env_example(self):
        example = (ROOT / "control-plane" / "deployment" / "vm.env.example").read_text()
        for name in sorted(FALLBACK_VARIABLES):
            self.assertRegex(example, rf"(?m)^{name}=", f"vm.env.example does not list {name}")

    def test_unset_stays_optional(self):
        # The judge is optional: a stack without one must still come up.
        self.assertNotRegex(relay_block(COMPOSE.read_text()), r"JUDGE_[A-Z_]+: \$\{JUDGE_[A-Z_]+:\?")


if __name__ == "__main__":
    unittest.main()
