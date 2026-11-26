"""kinerary-cp-release — where its Telegram notices go.

Informational notices (upgraded, rolled back, a request locked, a run finished) go to
the operator chat when `CONTROL_PLANE_OPERATOR_CHAT_ID` is set in vm.env — the same
setting the control plane reads (#649/#656) — and not into the owner's private chat
with the trip bot. The notice carrying a one-time approval code stays on the private
chat, always. A failure notice goes to both. Nothing here makes a network call: urlopen
is replaced, and the token and chat ids are made-up values that must never be printed.
"""
from __future__ import annotations

import ast
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "control-plane" / "deployment" / "vm-release.py"

_tmp = Path(tempfile.mkdtemp(prefix="vm-release-notify-"))
for _key, _sub in (("KINERARY_CP_STATE_DIR", "state"), ("KINERARY_CP_BACKUP_DIR", "backups"), ("KINERARY_CP_LOG_DIR", "log")):
    os.environ.setdefault(_key, str(_tmp / _sub))
_spec = importlib.util.spec_from_file_location("vm_release_notify_under_test", TOOL)
vr = importlib.util.module_from_spec(_spec)
sys.modules["vm_release_notify_under_test"] = vr
_spec.loader.exec_module(vr)

TOKEN = "123456:TOKEN-that-must-not-be-printed"
PRIVATE = "5550001"          # the owner's private chat
OPS = "-1005550002"          # an ops group the bot is in


class Telegram:
    """A stand-in for urlopen: records (chat, text), can refuse chosen chats."""

    def __init__(self, refuse=()):
        self.sent = []
        self.refuse = set(refuse)

    def __call__(self, request, timeout=None):
        form = urllib.parse.parse_qs(request.data.decode())
        chat, text = form["chat_id"][0], form["text"][0]
        assert TOKEN in request.full_url
        if chat in self.refuse:
            # the real error text names the URL, and with it the token
            raise urllib.error.HTTPError(request.full_url, 403, f"Forbidden: bot is not a member ({request.full_url})", {}, None)
        self.sent.append((chat, text))
        return io.BytesIO(b'{"ok": true}')

    def chats(self):
        return [chat for chat, _ in self.sent]


class NotifyWorld(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vm-release-notify-world-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        secrets_dir = self.tmp / "secrets"
        secrets_dir.mkdir()
        (secrets_dir / "telegram_creds").write_text(TOKEN + "\n")
        (secrets_dir / "telegram_super_admin_chat_id").write_text(PRIVATE + "\n")
        self.vm_env = self.tmp / "vm.env"
        self.set_ops(OPS)
        for name, value in (("SECRETS_DIR", secrets_dir), ("VM_ENV", self.vm_env),
                            ("STATE_DIR", self.tmp / "state"), ("LOG_DIR", self.tmp / "log")):
            patcher = mock.patch.object(vr, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.out = io.StringIO()
        self.cp = vr.ControlPlane(vr.Report(self.out, color=False), actor="human")

    def set_ops(self, value):
        self.vm_env.write_text("KINERARY_REV=aaaa\n" + ("" if value is None else f"CONTROL_PLANE_OPERATOR_CHAT_ID={value}\n"))

    @contextmanager
    def telegram(self, **kw):
        fake = Telegram(**kw)
        with mock.patch.object(vr.urllib.request, "urlopen", fake):
            yield fake

    def assert_nothing_secret_printed(self, *extra):
        text = self.out.getvalue() + "".join(extra)
        for secret in (TOKEN, PRIVATE, OPS):
            self.assertNotIn(secret, text)


class InformationalNotices(NotifyWorld):
    def test_ops_chat_configured_gets_the_notice_and_the_private_chat_does_not(self):
        with self.telegram() as tg:
            self.assertTrue(self.cp.notify("Kinerary control plane upgraded a -> b (human). Verify passed."))
        self.assertEqual(tg.chats(), [OPS])
        self.assert_nothing_secret_printed()

    def test_unset_empty_or_the_private_chat_itself_keeps_todays_behaviour(self):
        for value in (None, "", '""', PRIVATE):
            self.set_ops(value)
            with self.telegram() as tg:
                self.assertTrue(self.cp.notify("x"))
            self.assertEqual(tg.chats(), [PRIVATE], repr(value))
        self.assert_nothing_secret_printed()

    def test_the_private_chat_itself_says_so(self):
        self.set_ops(PRIVATE)
        with self.telegram():
            self.cp.notify("x")
        self.assertIn("same chat as the private one", self.out.getvalue())

    def test_a_malformed_value_falls_back_to_the_private_chat_and_says_so(self):
        for value in ("not-a-chat", "-100abc", "https://t.me/somegroup", "12 34"):
            self.out.truncate(0), self.out.seek(0)
            self.set_ops(value)
            with self.telegram() as tg:
                self.assertTrue(self.cp.notify("x"))
            self.assertEqual(tg.chats(), [PRIVATE], value)
            self.assertIn("is not a Telegram chat id", self.out.getvalue(), value)
            self.assertNotIn(value, self.out.getvalue())  # the value is not echoed either

    def test_an_unreadable_vm_env_does_not_lose_the_notice(self):
        self.vm_env.unlink()
        with self.telegram() as tg:
            self.assertTrue(self.cp.notify("x"))
        self.assertEqual(tg.chats(), [PRIVATE])

    def test_ops_send_failing_falls_back_to_the_private_chat_once(self):
        with self.telegram(refuse=[OPS]) as tg:
            self.assertTrue(self.cp.notify("x"))
        self.assertEqual(tg.chats(), [PRIVATE])
        self.assertIn("did not take the notice", self.out.getvalue())
        self.assert_nothing_secret_printed()

    def test_success_is_reported_only_when_something_was_delivered(self):
        with self.telegram(refuse=[OPS, PRIVATE]) as tg:
            self.assertFalse(self.cp.notify("x"))
        self.assertEqual(tg.sent, [])
        self.assert_nothing_secret_printed()
        with self.telegram(refuse=[PRIVATE]) as tg:  # ops fine: delivered
            self.assertTrue(self.cp.notify("x"))

    def test_no_token_means_nothing_is_sent_and_false(self):
        (vr.SECRETS_DIR / "telegram_creds").unlink()
        with self.telegram() as tg:
            self.assertFalse(self.cp.notify("x"))
        self.assertEqual(tg.sent, [])


class FailureNotices(NotifyWorld):
    def test_both_chats_get_it_once_each(self):
        with self.telegram() as tg:
            self.assertTrue(self.cp.notify("VERIFY FAILED", audience="both"))
        self.assertEqual(sorted(tg.chats()), sorted([OPS, PRIVATE]))

    def test_both_without_an_ops_chat_is_one_private_message_not_two(self):
        self.set_ops(None)
        with self.telegram() as tg:
            self.assertTrue(self.cp.notify("VERIFY FAILED", audience="both"))
        self.assertEqual(tg.chats(), [PRIVATE])

    def test_both_when_ops_fails_still_reaches_private_and_says_so(self):
        with self.telegram(refuse=[OPS]) as tg:
            self.assertTrue(self.cp.notify("VERIFY FAILED", audience="both"))
        self.assertEqual(tg.chats(), [PRIVATE])
        self.assertIn("did not take the notice", self.out.getvalue())

    def test_both_when_private_fails_is_still_delivered_by_ops(self):
        with self.telegram(refuse=[PRIVATE]) as tg:
            self.assertTrue(self.cp.notify("VERIFY FAILED", audience="both"))
        self.assertEqual(tg.chats(), [OPS])


class DryRun(NotifyWorld):
    def dry(self):
        return vr.ControlPlane(vr.Report(self.out, color=False), dry_run=True)

    def test_sends_nothing_and_names_the_chat_kind_without_an_id(self):
        cases = (("ops", "to the operator chat"), ("both", "to the operator chat and his private chat"),
                 ("private", "to his private chat"))
        for audience, phrase in cases:
            self.out.truncate(0), self.out.seek(0)
            with self.telegram() as tg:
                self.assertTrue(self.dry().notify("x", audience=audience))
            self.assertEqual(tg.sent, [])
            self.assertIn(phrase, self.out.getvalue(), audience)
            self.assert_nothing_secret_printed()

    def test_without_an_ops_chat_it_says_private(self):
        self.set_ops(None)
        with self.telegram() as tg:
            self.dry().notify("x")
        self.assertEqual(tg.sent, [])
        self.assertIn("to his private chat", self.out.getvalue())


class ApprovalCodeStaysPrivate(NotifyWorld):
    def test_private_audience_ignores_the_ops_chat(self):
        with self.telegram() as tg:
            self.assertTrue(self.cp.notify("Code: 123456", audience="private"))
        self.assertEqual(tg.chats(), [PRIVATE])

    def test_a_private_notice_that_fails_is_never_redirected_to_ops(self):
        with self.telegram(refuse=[PRIVATE]) as tg:
            self.assertFalse(self.cp.notify("Code: 123456", audience="private"))
        self.assertEqual(tg.sent, [])

    def test_gate_request_with_an_ops_chat_sends_the_code_only_to_the_private_chat(self):
        action = ["upgrade", "abc1234"]
        with mock.patch.object(vr, "resolve_agent_revs", lambda cp, a: action), \
                mock.patch.object(vr, "run_action", lambda cp, a: 0), \
                self.telegram() as tg:
            out = io.StringIO()
            with mock.patch.object(vr.sys, "stdout", out):
                code = vr.cmd_gate(["request", "upgrade", "main"])
        self.assertEqual(code, 0, out.getvalue())
        listing = [("private" if chat == PRIVATE else "ops" if chat == OPS else "other", text.splitlines()[0])
                   for chat, text in tg.sent]
        print("\n(chat kind, first line) of the sends for a gate request with an ops chat configured:", listing)
        self.assertEqual([kind for kind, _ in listing], ["private"])
        secret = next(text for chat, text in tg.sent).split("Code: ")[1].split()[0]
        self.assertRegex(secret, r"^\d{6}$")
        for chat, text in tg.sent:
            if chat != PRIVATE:
                self.assertNotIn(secret, text)
        self.assertNotIn(secret, out.getvalue())  # the agent's own channel never carries it
        self.assertNotIn(TOKEN, out.getvalue())

    def test_gate_request_without_an_ops_chat_is_unchanged(self):
        self.set_ops(None)
        with mock.patch.object(vr, "resolve_agent_revs", lambda cp, a: ["upgrade", "abc1234"]), \
                mock.patch.object(vr, "run_action", lambda cp, a: 0), \
                self.telegram() as tg, mock.patch.object(vr.sys, "stdout", io.StringIO()):
            self.assertEqual(vr.cmd_gate(["request", "upgrade", "main"]), 0)
        self.assertEqual(tg.chats(), [PRIVATE])


class GateCallSites(NotifyWorld):
    def request_id(self, action=("upgrade", "abc1234")):
        requests = vr.Requests(vr.STATE_DIR / "requests")
        request, secret = requests.create(list(action), "summary")
        return requests, request["id"], secret

    def test_request_locked_after_wrong_codes_goes_to_ops_only(self):
        _, rid, secret = self.request_id()
        wrong = "000000" if secret != "000000" else "111111"
        with self.telegram() as tg, mock.patch.object(vr.sys, "stdout", io.StringIO()):
            for _ in range(vr.REQUEST_MAX_ATTEMPTS):
                vr.cmd_gate(["approve", rid, wrong])
        self.assertEqual(len(tg.sent), 1)
        chat, text = tg.sent[0]
        self.assertEqual(chat, OPS)
        self.assertIn("locked", text)
        self.assertNotIn(secret, text)

    def run_finished(self, exit_code):
        requests, rid, _ = self.request_id()
        requests.mark(rid, status="approved")

        @contextmanager
        def no_lock():
            yield

        def action_runs(cp, action):
            return exit_code

        with mock.patch.object(vr, "run_action", action_runs), mock.patch.object(vr, "lock", no_lock), self.telegram() as tg:
            self.assertEqual(vr.cmd_run_request(rid), exit_code)
        return tg

    def test_a_finished_run_goes_to_ops_only(self):
        self.assertEqual(self.run_finished(0).chats(), [OPS])

    def test_a_failed_run_goes_to_both(self):
        self.assertEqual(sorted(self.run_finished(1).chats()), sorted([OPS, PRIVATE]))


class CallSites(unittest.TestCase):
    """The call sites that need the whole upgrade to run to reach are pinned in the source:
    which audience each notice asks for."""

    def audiences(self):
        tree = ast.parse(TOOL.read_text())
        found = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "notify":
                head = ast.unparse(node.args[0])
                audience = next((ast.unparse(k.value) for k in node.keywords if k.arg == "audience"), "'ops'")
                for needle in ("Verify passed", "VERIFY FAILED", "rolled back", "Code: ", "locked after",
                               "finished"):
                    if needle in head:
                        found[needle] = audience
        return found

    def test_each_notice_asks_for_the_audience_it_should(self):
        found = self.audiences()
        self.assertEqual(found, {
            "Verify passed": "'ops'",                                  # routine: ops chat only
            "VERIFY FAILED": "'both'",                                 # upgraded but verify failed
            "rolled back": "'ops' if ok else 'both'",                  # rollback whose verify failed goes to both
            "Code: ": "'private'",                            # carries the approval code
            "locked after": "'ops'",
            "finished": "'ops' if code == 0 else 'both'",
        })

    def test_the_setting_is_the_one_the_control_plane_uses(self):
        self.assertEqual(vr.OPERATOR_CHAT_KEY, "CONTROL_PLANE_OPERATOR_CHAT_ID")
        example = (ROOT / "control-plane" / "deployment" / "vm.env.example").read_text()
        self.assertIn("\nCONTROL_PLANE_OPERATOR_CHAT_ID=", example)


if __name__ == "__main__":
    unittest.main()
