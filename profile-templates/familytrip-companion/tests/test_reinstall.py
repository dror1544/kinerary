"""render_profile.py --reinstall-profile: an existing companion re-rendered in place (#568 slice R2, AC-14).

What is pinned here:

  * after a re-render the profile's rendered files are exactly a fresh render of the release for that trip;
  * what is not rendered — conversation state, memory, the relay's .env, the profile's own config.yaml — is not touched,
    byte for byte, and neither is anything outside the profile;
  * a profile somebody edited in place is reported and NOT overwritten (Decision 2). So is one whose provenance is
    unknown (installed before the digest of what was rendered was recorded). Only an explicit allow overwrites, and the
    edited files are copied aside first;
  * `--check` writes nothing, whatever it finds.

No Hermes is needed: `hermes profile create` is a stand-in that makes the directory, and HOME is a temp directory.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RENDER = ROOT / "render_profile.py"
NAME = "tripexample"
HOME_FILES = {          # what a live profile holds that no render owns
    "state.db": b"SQLite format 3\x00 conversations travellers had",
    "memories/MEMORY.md": b"the organizer prefers mornings\n",
    "sessions/s1.json": b'{"turns": 12}',
    ".env": b"GATEWAY_RELAY_SECRET=do-not-touch\n",
    "config.yaml": b"model:\n  default: kept\n",
    "kinerary-managed": b"kinerary-managed\n",
    "write-sandbox/.keep": b"",
    "logs/agent.log": b"registered 5 tools\n",
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree(path: Path) -> dict:
    """Every file and symlink under `path` -> (kind, content digest or link target, mode)."""
    out = {}
    for p in sorted(path.rglob("*")):
        rel = str(p.relative_to(path))
        if p.is_symlink():
            out[rel] = ("link", os.readlink(p), None)
        elif p.is_file():
            out[rel] = ("file", digest(p), stat.S_IMODE(p.stat().st_mode))
    return out


class Reinstall(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.bin = Path(self.tmp.name) / "bin"
        self.bin.mkdir()
        fake = self.bin / "hermes"
        fake.write_text('#!/bin/sh\n[ "$1 $2" = "profile create" ] && mkdir -p "$HOME/.hermes/profiles/$3"\nexit 0\n')
        fake.chmod(0o755)
        self.profile = self.home / ".hermes" / "profiles" / NAME
        self.handoff = json.loads((ROOT / "example.handoff.json").read_text())
        self.handoff["profile"]["name"] = NAME

    # -- running it

    def env(self) -> dict:
        return {"HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin"}

    def render(self, *args: str, script: Path = RENDER, handoff: dict | None = None, out: str = "rendered"):
        inp = Path(self.tmp.name) / f"in-{out}.json"
        inp.write_text(json.dumps(handoff or self.handoff))
        output = Path(self.tmp.name) / out
        if output.exists():
            shutil.rmtree(output)
        proc = subprocess.run([sys.executable, str(script), "--input", str(inp), "--output", str(output), *args],
                              capture_output=True, text=True, env=self.env(), timeout=120)
        return proc, output

    def install(self, script: Path = RENDER, handoff: dict | None = None) -> None:
        proc, _ = self.render("--install-profile", NAME, script=script, handoff=handoff, out="installed")
        self.assertEqual(0, proc.returncode, proc.stderr)
        for rel, body in HOME_FILES.items():
            p = self.profile / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body)

    def reinstall(self, *args: str, script: Path = RENDER, handoff: dict | None = None, out: str = "again"):
        proc, output = self.render("--reinstall-profile", NAME, *args, script=script, handoff=handoff, out=out)
        verdict = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.stdout.strip() else None
        return proc, verdict, output

    def fresh(self, script: Path = RENDER, handoff: dict | None = None) -> Path:
        proc, output = self.render(script=script, handoff=handoff, out="fresh")
        self.assertEqual(0, proc.returncode, proc.stderr)
        return output

    def other_release(self) -> Path:
        """A copy of this template package as a LATER release would carry it: SOUL changed, a skill file gone, one added."""
        copy = Path(self.tmp.name) / "release2"
        if copy.exists():
            return copy / "render_profile.py"
        shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns("tests", "eval", "__pycache__"))
        soul = copy / "templates" / "SOUL.md.tpl"
        soul.write_text(soul.read_text() + "\nRelease two says one more thing.\n")
        (copy / "templates" / "skills" / "planning" / "trip-daily-planning" / "SKILL.md").unlink()
        added = copy / "templates" / "skills" / "travel" / "a-new-skill" / "SKILL.md"
        added.parent.mkdir(parents=True)
        added.write_text("---\nname: a-new-skill\n---\nNew in release two.\n")
        return copy / "render_profile.py"

    def assertRenderedIs(self, fresh: Path, *, skip: tuple = ()) -> None:
        """The profile's rendered files are the fresh render's, file for file (AC-14)."""
        for p in sorted(fresh.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(fresh)
            if str(rel) in skip:
                continue
            self.assertTrue((self.profile / rel).is_file(), f"{rel} is missing from the profile")
            self.assertEqual(p.read_bytes(), (self.profile / rel).read_bytes(), f"{rel} differs from a fresh render")

    def not_rendered(self) -> dict:
        return {k: v for k, v in tree(self.profile).items()
                if k.split("/")[0] not in ("SOUL.md", "profile.yaml", "INSTALL.md", "config.overlay.yaml", "references", "skills")
                and k != ".kinerary-render.json"}

    # -- the record of what was rendered

    def test_a_fresh_install_records_what_it_rendered(self) -> None:
        self.install()
        manifest = json.loads((self.profile / ".kinerary-render.json").read_text())
        self.assertEqual(1, manifest["schema"])
        for rel in ("SOUL.md", "profile.yaml", "INSTALL.md", "config.overlay.yaml", "references/sources.md",
                    "references/group-context.json", "references/interview-context.private.json",
                    "skills/travel/familytrip-companion-operations/SKILL.md"):
            self.assertEqual(digest(self.profile / rel), manifest["files"][rel], rel)
        self.assertNotIn("state.db", manifest["files"])
        self.assertEqual(0, stat.S_IMODE((self.profile / ".kinerary-render.json").stat().st_mode) & 0o077,
                         "the record is private to the account, like the profile")

    # -- AC-14: matches a fresh render; everything else untouched

    def test_a_reinstall_of_an_untouched_profile_leaves_it_equal_to_a_fresh_render_of_the_new_release(self) -> None:
        self.install()
        release2 = self.other_release()
        before = self.not_rendered()
        outside = {"marker": (Path(self.tmp.name) / "outside.txt")}
        outside["marker"].write_text("not part of any profile")
        backups = self.home / "bk"
        proc, verdict, _ = self.reinstall("--backup-root", str(backups), script=release2)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual("applied", verdict["status"])
        self.assertEqual(["skills/planning/trip-daily-planning/SKILL.md"], verdict["removed_names"])
        self.assertTrue(list(backups.rglob("trip-daily-planning/SKILL.md")), "what an apply deletes is copied aside first, even when nobody edited it")
        self.assertRenderedIs(self.fresh(script=release2))
        self.assertIn("Release two says one more thing", (self.profile / "SOUL.md").read_text())
        self.assertFalse((self.profile / "skills/planning/trip-daily-planning/SKILL.md").exists(),
                         "a file the release no longer renders is removed when nobody edited it")
        self.assertTrue((self.profile / "skills/travel/a-new-skill/SKILL.md").is_file())
        self.assertEqual(before, self.not_rendered(), "history, memory, .env, config.yaml, logs: byte-identical")
        self.assertEqual("not part of any profile", outside["marker"].read_text())

    def test_the_new_record_matches_the_new_files_and_names_the_release(self) -> None:
        self.install()
        proc, verdict, _ = self.reinstall("--release-id", "rls_abc12345", "--release-commit", "a" * 40, "--backup-root", str(self.home / "bk"), script=self.other_release())
        self.assertEqual(0, proc.returncode, proc.stderr)
        manifest = json.loads((self.profile / ".kinerary-render.json").read_text())
        self.assertEqual({"id": "rls_abc12345", "commit": "a" * 40}, manifest["release"])
        for rel, want in manifest["files"].items():
            self.assertEqual(want, digest(self.profile / rel), rel)
        self.assertNotIn("skills/planning/trip-daily-planning/SKILL.md", manifest["files"])
        # and the profile is therefore clean for the NEXT rollout
        proc, verdict, _ = self.reinstall("--backup-root", str(self.home / "bk"), script=self.other_release(), out="third")
        self.assertEqual((0, "unchanged"), (proc.returncode, verdict["status"]))

    def test_a_release_or_commit_that_is_not_what_it_says_is_refused(self) -> None:
        self.install()
        for args in (("--release-id", "x y"), ("--release-commit", "HEAD"), ("--release-id", "../../x")):
            proc, _, _ = self.reinstall(*args)
            self.assertEqual(2, proc.returncode, args)

    def test_a_reinstall_for_the_same_release_changes_nothing_and_says_so(self) -> None:
        self.install()
        before = tree(self.profile)
        proc, verdict, _ = self.reinstall()
        self.assertEqual((0, "unchanged"), (proc.returncode, verdict["status"]))
        self.assertEqual(before, tree(self.profile))

    def test_a_rendered_private_file_keeps_its_mode(self) -> None:
        self.install()
        private = self.profile / "references" / "interview-context.private.json"
        private.chmod(0o600)
        self.handoff["organizer"]["display_name"] = "Someone Else"
        proc, verdict, _ = self.reinstall(handoff=self.handoff)
        self.assertEqual("applied", verdict["status"], proc.stderr)
        self.assertIn("Someone Else", private.read_text())
        self.assertEqual(0o600, stat.S_IMODE(private.stat().st_mode))

    # -- Decision 2: edited in place is refused and reported, never overwritten

    def edited_cases(self):
        return {
            "SOUL.md": lambda p: p.write_text(p.read_text() + "\nOrganizer's own rule.\n"),
            "skills/travel/familytrip-companion-operations/SKILL.md": lambda p: p.write_text("rewritten"),
            "references/sources.md": lambda p: p.unlink(),
        }

    def test_an_edit_in_place_is_reported_and_nothing_is_overwritten(self) -> None:
        for rel, edit in self.edited_cases().items():
            with self.subTest(rel):
                self.setUp()
                self.install()
                edit(self.profile / rel)
                before = tree(self.profile)
                proc, verdict, _ = self.reinstall(script=self.other_release())
                self.assertEqual(3, proc.returncode, proc.stderr)
                self.assertEqual("edited", verdict["status"])
                self.assertEqual([rel], verdict["edited"])
                self.assertEqual(before, tree(self.profile), "not one byte moved")
                self.assertFalse((Path(self.home) / ".hermes" / "profile-backups").exists())

    def test_a_file_the_render_would_write_that_somebody_put_there_is_an_edit_too(self) -> None:
        self.install()
        added = self.profile / "skills/travel/a-new-skill/SKILL.md"
        added.parent.mkdir(parents=True)
        added.write_text("the organizer wrote this skill by hand")
        proc, verdict, _ = self.reinstall(script=self.other_release())
        self.assertEqual((3, "edited"), (proc.returncode, verdict["status"]))
        self.assertEqual(["skills/travel/a-new-skill/SKILL.md"], verdict["edited"])
        self.assertEqual("the organizer wrote this skill by hand", added.read_text())

    def test_a_file_nobody_rendered_is_left_alone_and_is_not_an_edit(self) -> None:
        self.install()
        mine = self.profile / "skills/travel/my-own/SKILL.md"
        mine.parent.mkdir(parents=True)
        mine.write_text("learned in the profile")
        proc, verdict, _ = self.reinstall("--backup-root", str(self.home / "bk"), script=self.other_release())
        self.assertEqual((0, "applied"), (proc.returncode, verdict["status"]), proc.stderr)
        self.assertEqual("learned in the profile", mine.read_text())

    def test_a_profile_with_no_record_has_unknown_provenance_and_is_refused_not_guessed_at(self) -> None:
        # A profile installed before the record existed. Its files may match the old render exactly or be heavily
        # edited; nothing says which, so it is refused as "unknown", the same as an edit.
        self.install()
        (self.profile / ".kinerary-render.json").unlink()
        before = tree(self.profile)
        proc, verdict, _ = self.reinstall(script=self.other_release())
        self.assertEqual(3, proc.returncode, proc.stderr)
        self.assertEqual("unknown_provenance", verdict["status"])
        self.assertEqual(before, tree(self.profile))

    def test_a_record_that_is_not_one_is_unknown_provenance_not_a_crash(self) -> None:
        for body in ("{nope", "[]", json.dumps({"schema": 9, "files": {}}), json.dumps({"schema": 1, "files": []}),
                     json.dumps({"schema": 1, "files": {"SOUL.md": 5}})):
            with self.subTest(body):
                self.setUp()
                self.install()
                (self.profile / ".kinerary-render.json").write_text(body)
                proc, verdict, _ = self.reinstall()
                self.assertEqual((3, "unknown_provenance"), (proc.returncode, verdict["status"]), proc.stderr)

    def test_a_record_naming_paths_outside_the_rendered_set_cannot_make_a_write_or_a_delete_land_there(self) -> None:
        for evil in ("../escape.txt", "/etc/passwd", "config.yaml", "state.db", "skills/../config.yaml", ".env", "kinerary-managed"):
            with self.subTest(evil):
                shutil.rmtree(self.home / ".hermes", ignore_errors=True)
                self.install()
                manifest = json.loads((self.profile / ".kinerary-render.json").read_text())
                manifest["files"][evil] = "0" * 64
                (self.profile / ".kinerary-render.json").write_text(json.dumps(manifest))
                before = self.not_rendered()
                proc, verdict, _ = self.reinstall("--allow-edited", "--backup-root", str(self.home / "bk"), script=self.other_release())
                self.assertIn(verdict["status"], ("unknown_provenance", "applied"), proc.stderr)
                self.assertEqual(before, self.not_rendered(), "nothing a render does not own moved")
                self.assertFalse((self.profile.parent / "escape.txt").exists())

    def test_the_same_record_without_the_allow_is_refused_as_unknown_provenance(self) -> None:
        self.install()
        manifest = json.loads((self.profile / ".kinerary-render.json").read_text())
        manifest["files"]["config.yaml"] = "0" * 64
        (self.profile / ".kinerary-render.json").write_text(json.dumps(manifest))
        proc, verdict, _ = self.reinstall()
        self.assertEqual((3, "unknown_provenance"), (proc.returncode, verdict["status"]))

    def test_only_an_explicit_allow_overwrites_and_it_copies_the_edited_files_aside_first(self) -> None:
        self.install()
        soul = self.profile / "SOUL.md"
        edited = soul.read_text() + "\nOrganizer's own rule.\n"
        soul.write_text(edited)
        backup_root = Path(self.tmp.name) / "backups"
        proc, verdict, _ = self.reinstall("--allow-edited", "--backup-root", str(backup_root), script=self.other_release())
        self.assertEqual((0, "applied"), (proc.returncode, verdict["status"]), proc.stderr)
        self.assertRenderedIs(self.fresh(script=self.other_release()))
        self.assertNotIn("Organizer's own rule", soul.read_text())
        # captured first
        saved = [p for p in backup_root.rglob("SOUL.md")]
        self.assertEqual(1, len(saved), "the edited file was copied aside")
        self.assertEqual(edited, saved[0].read_text())
        self.assertEqual(NAME, saved[0].relative_to(backup_root).parts[0])
        self.assertEqual(0o700, stat.S_IMODE(saved[0].parent.stat().st_mode))
        self.assertEqual(verdict["backup"], str(saved[0].parent))
        # and still nothing but rendered files moved
        self.assertEqual({k: v for k, v in tree(self.profile).items() if k in HOME_FILES},
                         {k: ("file", hashlib.sha256(HOME_FILES[k]).hexdigest(), tree(self.profile)[k][2]) for k in HOME_FILES})

    def test_an_allow_on_a_profile_with_unknown_provenance_overwrites_it_after_the_same_backup(self) -> None:
        self.install()
        (self.profile / ".kinerary-render.json").unlink()
        before_soul = (self.profile / "SOUL.md").read_text()
        backup_root = Path(self.tmp.name) / "backups"
        proc, verdict, _ = self.reinstall("--allow-edited", "--backup-root", str(backup_root), script=self.other_release())
        self.assertEqual((0, "applied"), (proc.returncode, verdict["status"]), proc.stderr)
        self.assertEqual(before_soul, next(backup_root.rglob("SOUL.md")).read_text())
        self.assertTrue((self.profile / ".kinerary-render.json").is_file(), "from now on its provenance is known")

    def test_allow_without_a_backup_place_is_refused_rather_than_overwriting_unrecorded(self) -> None:
        self.install()
        (self.profile / "SOUL.md").write_text("edited")
        proc, verdict, _ = self.reinstall("--allow-edited")
        self.assertEqual(2, proc.returncode)
        self.assertEqual("edited", (self.profile / "SOUL.md").read_text())

    def test_an_allow_given_to_a_clean_profile_makes_no_backup(self) -> None:
        self.install()
        backup_root = Path(self.tmp.name) / "backups"
        self.handoff["organizer"]["display_name"] = "Someone Else"       # changes a file, deletes none
        proc, verdict, _ = self.reinstall("--allow-edited", "--backup-root", str(backup_root), handoff=self.handoff)
        self.assertEqual("applied", verdict["status"])
        self.assertFalse(backup_root.exists())

    # -- review round 1: deletions, backups, the record

    def test_a_record_that_lists_a_file_no_release_rendered_cannot_get_it_deleted_unrecorded(self) -> None:
        # An operator's own skill, with its real digest added to the record: a clean-looking profile whose apply
        # would delete it. It is always copied aside first, and the apply says what it removed.
        self.install()
        mine = self.profile / "skills/custom/operator-skill/SKILL.md"
        mine.parent.mkdir(parents=True)
        mine.write_text("the operator wrote this by hand")
        manifest = json.loads((self.profile / ".kinerary-render.json").read_text())
        manifest["files"]["skills/custom/operator-skill/SKILL.md"] = digest(mine)
        (self.profile / ".kinerary-render.json").write_text(json.dumps(manifest))
        proc, verdict, _ = self.reinstall()                       # no backup place: refused, nothing deleted
        self.assertEqual(2, proc.returncode)
        self.assertTrue(mine.exists())
        backups = self.home / "bk"
        proc, verdict, _ = self.reinstall("--backup-root", str(backups))
        self.assertEqual((0, "applied"), (proc.returncode, verdict["status"]), proc.stderr)
        self.assertIn("skills/custom/operator-skill/SKILL.md", verdict["removed_names"])
        self.assertFalse(mine.exists())
        saved = list(backups.rglob("operator-skill/SKILL.md"))
        self.assertEqual(["the operator wrote this by hand"], [p.read_text() for p in saved], "recoverable")

    def test_backups_keep_only_the_newest_three_per_profile(self) -> None:
        self.install()
        backups = self.home / "bk"
        for n in range(5):
            (self.profile / "SOUL.md").write_text(f"edit {n}")
            proc, verdict, _ = self.reinstall("--allow-edited", "--backup-root", str(backups))
            self.assertEqual(0, proc.returncode, proc.stderr)
        kept = sorted(p.name for p in (backups / NAME).iterdir())
        self.assertEqual(3, len(kept))
        self.assertEqual(["edit 2", "edit 3", "edit 4"], [(backups / NAME / k / "SOUL.md").read_text() for k in kept],
                         "the newest three, by their stamp")
        # another profile's backups, and anything that is not a stamp, are not this module's to delete
        other = backups / "otherprofile" / "20200101T000000000000Z"
        other.mkdir(parents=True)
        stray = backups / NAME / "keep-me"
        stray.mkdir()
        (self.profile / "SOUL.md").write_text("edit 5")
        self.reinstall("--allow-edited", "--backup-root", str(backups))
        self.assertTrue(other.exists())
        self.assertTrue(stray.exists())

    def test_a_reinstall_that_changes_nothing_does_not_touch_the_record_even_a_second_later(self) -> None:
        import time
        self.install()
        record = self.profile / ".kinerary-render.json"
        before = (record.read_bytes(), record.stat().st_mtime_ns)
        time.sleep(1.2)
        proc, verdict, _ = self.reinstall()
        self.assertEqual("unchanged", verdict["status"], proc.stderr)
        self.assertEqual(before, (record.read_bytes(), record.stat().st_mtime_ns))

    def test_the_same_files_under_a_new_release_update_only_the_release_in_the_record(self) -> None:
        self.install()
        proc, verdict, _ = self.reinstall("--release-id", "rls_new00001", "--release-commit", "b" * 40)
        self.assertEqual("unchanged", verdict["status"], proc.stderr)
        self.assertEqual({"id": "rls_new00001", "commit": "b" * 40},
                         json.loads((self.profile / ".kinerary-render.json").read_text())["release"])

    # -- --check changes nothing

    def test_check_reports_every_verdict_and_writes_nothing(self) -> None:
        self.install()
        release2 = self.other_release()
        cases = {"clean": lambda: None,
                 "edited": lambda: (self.profile / "SOUL.md").write_text("edited"),
                 "unknown_provenance": lambda: (self.profile / ".kinerary-render.json").unlink()}
        for want, setup in cases.items():
            setup()
            before = tree(self.profile)
            proc, verdict, _ = self.reinstall("--check", script=release2)
            self.assertEqual(want, verdict["status"], proc.stderr)
            self.assertEqual(0 if want == "clean" else 3, proc.returncode)
            self.assertEqual(before, tree(self.profile), f"--check wrote something for {want}")
            self.assertFalse((self.home / ".hermes" / "profile-backups").exists())

    # -- the profile itself

    def test_a_profile_that_does_not_exist_is_not_created_by_a_reinstall(self) -> None:
        proc, _, _ = self.reinstall()
        self.assertEqual(2, proc.returncode)
        self.assertIn("no profile", proc.stderr)
        self.assertFalse(self.profile.exists())

    def test_a_profile_directory_that_is_a_symlink_is_refused_and_its_target_untouched(self) -> None:
        elsewhere = Path(self.tmp.name) / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "SOUL.md").write_text("somebody else's")
        self.profile.parent.mkdir(parents=True)
        self.profile.symlink_to(elsewhere)
        proc, _, _ = self.reinstall()
        self.assertEqual(2, proc.returncode)
        self.assertEqual("somebody else's", (elsewhere / "SOUL.md").read_text())
        self.assertEqual(["SOUL.md"], [p.name for p in elsewhere.iterdir()])

    def test_a_rendered_file_that_became_a_symlink_is_an_edit_and_is_never_written_through(self) -> None:
        self.install()
        target = Path(self.tmp.name) / "target.txt"
        target.write_text("the link's target")
        soul = self.profile / "SOUL.md"
        soul.unlink()
        soul.symlink_to(target)
        proc, verdict, _ = self.reinstall(script=self.other_release())
        self.assertEqual((3, "edited"), (proc.returncode, verdict["status"]))
        proc, verdict, _ = self.reinstall("--allow-edited", "--backup-root", str(self.home / "bk"), script=self.other_release(), out="again2")
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual("the link's target", target.read_text(), "the write replaced the link, it did not follow it")
        self.assertFalse(soul.is_symlink())
        self.assertIn("Release two", soul.read_text())

    def test_a_rendered_directory_that_became_a_symlink_is_never_written_through(self) -> None:
        self.install()
        elsewhere = Path(self.tmp.name) / "elsewhere"
        elsewhere.mkdir()
        shutil.rmtree(self.profile / "references")
        (self.profile / "references").symlink_to(elsewhere)
        proc, verdict, _ = self.reinstall("--allow-edited", "--backup-root", str(self.home / "bk"))
        self.assertNotEqual(0, proc.returncode)
        self.assertEqual([], list(elsewhere.iterdir()), "nothing was written through the link")

    def test_the_handoff_for_another_profile_is_refused(self) -> None:
        self.install()
        proc, output = self.render("--reinstall-profile", "someoneelse", out="other")
        self.assertEqual(2, proc.returncode)
        self.assertIn("must match", proc.stderr)

    def test_install_and_reinstall_cannot_be_asked_for_together(self) -> None:
        proc, _ = self.render("--install-profile", NAME, "--reinstall-profile", NAME)
        self.assertNotEqual(0, proc.returncode)


if __name__ == "__main__":
    unittest.main()
