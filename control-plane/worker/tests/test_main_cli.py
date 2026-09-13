"""The provisioner CLI's defaults.

Two of these flags decide whether a newly onboarded trip gets a companion
profile and an MCP bridge at all. Both used to default OFF, which is why a
"no bridge" row in bring-up.sh's status table was almost never an operator
forgetting — it was the default, and the pipeline that already knew how to
wire both was simply never asked to.

They now default ON, and that is a claim worth reading off the parser rather
than trusting a comment.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

from control_plane_worker.__main__ import build_parser


def _parse(argv: list[str], env: dict[str, str] | None = None):
    # Defaults are captured at parser-construction time from os.environ, so the
    # parser has to be built inside the patched environment, not before it.
    with mock.patch.dict(os.environ, env or {}, clear=False):
        return build_parser().parse_args(argv)


class ProvisionDefaultsTests(unittest.TestCase):
    def test_mcp_bridge_is_on_by_default(self) -> None:
        args = _parse(["provision"])
        self.assertTrue(args.enable_mcp_bridge)

    def test_mcp_bridge_can_be_turned_off_by_env(self) -> None:
        args = _parse(["provision"], {"PROVISIONER_MCP_BRIDGE_ENABLED": "0"})
        self.assertFalse(args.enable_mcp_bridge)

    def test_mcp_bridge_can_be_turned_off_by_flag(self) -> None:
        args = _parse(["provision", "--no-enable-mcp-bridge"])
        self.assertFalse(args.enable_mcp_bridge)

    def test_companion_profile_is_on_by_default(self) -> None:
        args = _parse(["provision"])
        self.assertFalse(args.no_companion_profile)

    def test_companion_profile_can_be_turned_off_by_env(self) -> None:
        args = _parse(["provision"], {"PROVISIONER_COMPANION_PROFILE_ENABLED": "0"})
        self.assertTrue(args.no_companion_profile)

    def test_an_explicit_templates_dir_still_wins(self) -> None:
        args = _parse(["provision", "--companion-templates-dir", "/somewhere/else"])
        self.assertEqual(args.companion_templates_dir, "/somewhere/else")


class TemplatesDirResolutionTests(unittest.TestCase):
    """The derivation that makes "on by default" need no new configuration.

    Mirrors the resolution in main(): unset templates dir + a repo root that
    actually contains the templates => use them; anything else => leave it
    unset and deploy the site alone, exactly as before.
    """

    @staticmethod
    def _resolve(templates_dir: str | None, repo_root: str | None, opt_out: bool) -> str | None:
        resolved = templates_dir
        if not resolved and repo_root:
            candidate = os.path.join(repo_root, "profile-templates", "familytrip-companion")
            if os.path.isdir(candidate):
                resolved = candidate
        if opt_out:
            resolved = None
        return resolved

    def test_derived_from_repo_root_when_the_templates_are_there(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            expected = os.path.join(repo, "profile-templates", "familytrip-companion")
            os.makedirs(expected)
            self.assertEqual(self._resolve(None, repo, opt_out=False), expected)

    def test_a_repo_root_without_templates_stays_unset(self) -> None:
        # Quiet rather than fatal: a job that cannot find templates must still
        # deploy a site, which is what it did before this defaulted on.
        with tempfile.TemporaryDirectory() as repo:
            self.assertIsNone(self._resolve(None, repo, opt_out=False))

    def test_no_repo_root_stays_unset(self) -> None:
        self.assertIsNone(self._resolve(None, None, opt_out=False))

    def test_opting_out_beats_a_present_templates_dir(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            os.makedirs(os.path.join(repo, "profile-templates", "familytrip-companion"))
            self.assertIsNone(self._resolve(None, repo, opt_out=True))

    def test_opting_out_beats_an_explicit_templates_dir(self) -> None:
        self.assertIsNone(self._resolve("/somewhere/else", None, opt_out=True))

    def test_the_repo_really_does_carry_the_templates_at_that_path(self) -> None:
        # Guards the derivation against the layout moving underneath it: the
        # path is constructed, so nothing else would notice a rename.
        # tests/ -> worker/ -> control-plane/ -> repo root
        here = os.path.abspath(__file__)
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(here))))
        self.assertTrue(
            os.path.isdir(os.path.join(repo_root, "profile-templates", "familytrip-companion")),
            "profile-templates/familytrip-companion moved; the default derivation needs updating",
        )


if __name__ == "__main__":
    unittest.main()
