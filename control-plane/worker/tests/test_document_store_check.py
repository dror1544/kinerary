"""The worker refuses an ephemeral document store, exactly as the relay does."""

import os
import tempfile
import unittest

from control_plane_worker.document_handoff import (
    DOCUMENT_STORE_MARKER,
    _mount_point_for,
    check_document_store,
)


def _mountinfo(points):
    return "\n".join(f"{20 + i} 1 0:{i} / {p} rw,relatime - fs src rw" for i, p in enumerate(points))


class MountPointTests(unittest.TestCase):
    def test_longest_containing_mount_with_escapes(self):
        info = _mountinfo(["/", "/srv/kinerary-nfs", "/srv", "/mnt/with\\040space"])
        self.assertEqual(_mount_point_for("/srv/kinerary-nfs/.kinerary-document-store", info), "/srv/kinerary-nfs")
        self.assertEqual(_mount_point_for("/srv/other", info), "/srv")
        self.assertEqual(_mount_point_for("/opt/app", info), "/")
        self.assertEqual(_mount_point_for("/mnt/with space/x", info), "/mnt/with space")
        self.assertEqual(_mount_point_for("/srvx/y", info), "/")


class CheckDocumentStoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="worker-store-check-")
        self.addCleanup(lambda: os.chmod(self.dir, 0o755) if os.path.isdir(self.dir) else None)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def _write_mountinfo(self, points):
        path = os.path.join(tempfile.mkdtemp(prefix="mountinfo-"), "mountinfo")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(_mountinfo(points))
        return path

    def test_each_failure_is_named(self):
        self.assertEqual(check_document_store(None)[1], "NOT_CONFIGURED")
        self.assertEqual(check_document_store(os.path.join(self.dir, "missing"))[1], "MISSING")
        not_dir = os.path.join(self.dir, "file")
        open(not_dir, "w").close()
        self.assertEqual(check_document_store(not_dir)[1], "NOT_A_DIRECTORY")
        self.assertEqual(check_document_store(self.dir, mountinfo_path="/nonexistent")[1], "NO_MARKER")

    def test_root_filesystem_refused_and_mounted_volume_accepted(self):
        open(os.path.join(self.dir, DOCUMENT_STORE_MARKER), "w").close()
        on_root = check_document_store(self.dir, mountinfo_path=self._write_mountinfo(["/"]))
        self.assertEqual(on_root[:2], (False, "NOT_A_MOUNT"))
        resolved = os.path.realpath(self.dir)
        mounted = check_document_store(self.dir, mountinfo_path=self._write_mountinfo(["/", resolved]))
        self.assertEqual(mounted, (True, "OK", resolved))
        self.assertTrue(check_document_store(self.dir, mountinfo_path="/nonexistent")[0], "no /proc: marker and write decide")

    @unittest.skipIf(hasattr(os, "getuid") and os.getuid() == 0, "root can write a read-only directory")
    def test_unwritable_refused(self):
        open(os.path.join(self.dir, DOCUMENT_STORE_MARKER), "w").close()
        os.chmod(self.dir, 0o555)
        self.assertEqual(check_document_store(self.dir, mountinfo_path="/nonexistent")[1], "NOT_WRITABLE")
        os.chmod(self.dir, 0o755)


if __name__ == "__main__":
    unittest.main()
