"""Handing source documents to a trip site, and linking them to what they support.

Pure: a temporary directory stands in for the document store and the deploy
directory, and a transformed config stands in for a provisioned trip. A local
directory is not evidence about an NFS mount; these tests pin the logic.
"""
from __future__ import annotations

import errno
import hashlib
import os
import tempfile
import unittest

from control_plane_worker.document_handoff import (
    TripDocumentFile,
    build_document_links,
    documents_manifest,
    publish_document,
)
from control_plane_worker.transformer import derive_bookings, transform_intake

TRIP = "trip_" + "a" * 32


def _structured(data: list) -> dict:
    return {"kind": "structured", "schema_version": 3, "data": data}


INTAKE = {
    "trip_type": {"kind": "choice", "option_id": "family", "schema_version": 3, "other_text": None},
    "destination": {"kind": "text", "schema_version": 3, "text": "Japan"},
    "phases": _structured([
        {"name": "Tokyo", "start": "2026-09-19", "end": "2026-09-23",
         "accommodation": {"name": "Hotel Gracery Shinjuku", "confirmation": "GR-4471"}},
        {"name": "Kyoto", "start": "2026-09-23", "end": "2026-09-26",
         "accommodation": {"name": "Kyoto Granbell"}},
    ]),
    "travel_anchors": _structured([
        {"type": "activity", "name": "TeamLab Planets", "date": "2026-09-20", "confirmation": "TL-1"},
    ]),
}


def _stored(root: str, content: bytes, document_id: str, filename: str) -> TripDocumentFile:
    hexdigest = hashlib.sha256(content).hexdigest()
    path = os.path.join(root, TRIP, f"{hexdigest}.pdf")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(content)
    return TripDocumentFile(
        document_id=document_id,
        file_name=f"{hexdigest}.pdf",
        source_path=path,
        content_digest=f"sha256:{hexdigest}",
        filename=filename,
        mime="application/pdf",
    )


class PublishTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = os.path.join(self.tmp.name, "store")
        self.trip_documents = os.path.join(self.tmp.name, "trips", "japan-2026", "documents")
        self.voucher = _stored(self.store, b"voucher bytes", "doc_" + "1" * 32, "voucher.pdf")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_a_hard_link_is_one_set_of_bytes_and_a_retry_is_not_a_second_copy(self) -> None:
        self.assertEqual("hardlink", publish_document(self.voucher, self.trip_documents))
        published = os.path.join(self.trip_documents, self.voucher.file_name)
        self.assertEqual(os.stat(published).st_ino, os.stat(self.voucher.source_path).st_ino)
        self.assertEqual("existing", publish_document(self.voucher, self.trip_documents))

    def test_separate_filesystems_fall_back_to_a_verified_copy(self) -> None:
        def cross_device(_src: str, _dst: str) -> None:
            raise OSError(errno.EXDEV, "cross-device link")

        self.assertEqual("copy", publish_document(self.voucher, self.trip_documents, link=cross_device))
        published = os.path.join(self.trip_documents, self.voucher.file_name)
        with open(published, "rb") as fh:
            self.assertEqual(b"voucher bytes", fh.read())
        self.assertNotEqual(os.stat(published).st_ino, os.stat(self.voucher.source_path).st_ino)

    def test_a_published_name_holding_other_bytes_is_refused_not_overwritten(self) -> None:
        os.makedirs(self.trip_documents, exist_ok=True)
        published = os.path.join(self.trip_documents, self.voucher.file_name)
        with open(published, "wb") as fh:
            fh.write(b"something else")
        with self.assertRaises(ValueError):
            publish_document(self.voucher, self.trip_documents)
        with open(published, "rb") as fh:
            self.assertEqual(b"something else", fh.read(), "left for a person to look at")

    def test_a_corrupt_original_is_never_copied_under_its_name(self) -> None:
        with open(self.voucher.source_path, "wb") as fh:
            fh.write(b"bit rot")

        def refused(_src: str, _dst: str) -> None:
            raise OSError(errno.EPERM, "links not permitted")

        with self.assertRaises(ValueError):
            publish_document(self.voucher, self.trip_documents, link=refused)
        self.assertFalse(os.path.exists(os.path.join(self.trip_documents, self.voucher.file_name)))


class LinkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        store = os.path.join(self.tmp.name, "store")
        self.plan = _stored(store, b"plan", "doc_" + "2" * 32, "Yapan Tours.pdf")
        self.voucher = _stored(store, b"voucher", "doc_" + "3" * 32, "Gracery voucher.pdf")
        self.ticket = _stored(store, b"ticket", "doc_" + "4" * 32, "TeamLab ticket.pdf")
        self.published = {d.document_id: d for d in (self.plan, self.voucher, self.ticket)}
        self.manifest = {
            "documents": [],
            "sources": [
                {"questionId": "phases", "index": 0, "documentId": self.plan.document_id, "disposition": "accepted", "paths": []},
                {"questionId": "phases", "index": 1, "documentId": self.plan.document_id, "disposition": "accepted", "paths": []},
                {"questionId": "phases", "index": 0, "documentId": self.voucher.document_id, "disposition": "filled", "paths": ["accommodation"]},
                {"questionId": "travel_anchors", "index": 0, "documentId": self.ticket.document_id, "disposition": "accepted", "paths": []},
                # Neither of these may produce a link.
                {"questionId": "phases", "index": 9, "documentId": self.plan.document_id, "disposition": "accepted", "paths": []},
                {"questionId": "phases", "index": 0, "documentId": "doc_" + "9" * 32, "disposition": "filled", "paths": ["accommodation"]},
            ],
        }
        self.config = transform_intake(INTAKE)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_the_document_that_supplied_a_stay_is_its_card_link_and_a_plan_that_named_the_city_is_not(self) -> None:
        links = build_document_links(self.config, INTAKE, self.manifest, self.published)
        self.assertEqual(self.voucher.file_name, links.for_phase("tokyo"))
        self.assertIsNone(links.for_phase("kyoto"), "the plan never supplied Kyoto's stay")
        self.assertEqual({self.plan.file_name, self.voucher.file_name}, set(links.phase_sources["tokyo"]))
        self.assertEqual([self.plan.file_name], links.phase_sources["kyoto"])
        self.assertEqual(self.ticket.file_name, links.for_anchor(0))

    def test_bookings_carry_their_source_only_when_one_is_known(self) -> None:
        links = build_document_links(self.config, INTAKE, self.manifest, self.published)
        rows = derive_bookings(self.config, INTAKE, links)
        by_name = {row["name"]: row for row in rows}
        self.assertEqual(self.voucher.file_name, by_name["Hotel Gracery Shinjuku"]["conf_file"])
        self.assertNotIn("conf_file", by_name["Kyoto Granbell"])
        teamlab = next(row for row in rows if row["type"] == "attraction")
        self.assertEqual(self.ticket.file_name, teamlab["conf_file"])

        for row in derive_bookings(self.config, INTAKE):
            self.assertNotIn("conf_file", row, "without links, bookings are exactly what they were")

    def test_the_documents_sidecar_says_everything_each_document_supports_and_no_paths(self) -> None:
        links = build_document_links(self.config, INTAKE, self.manifest, self.published)
        rows = derive_bookings(self.config, INTAKE, links)
        sidecar = {doc["file"]: doc for doc in documents_manifest(links, rows)}

        self.assertEqual(
            [{"kind": "phase", "id": "kyoto"}, {"kind": "phase", "id": "tokyo"}],
            sidecar[self.plan.file_name]["links"],
        )
        self.assertIn({"kind": "booking", "seed_key": "hotel_tokyo"}, sidecar[self.voucher.file_name]["links"])
        self.assertEqual("Gracery voucher.pdf", sidecar[self.voucher.file_name]["filename"])
        for doc in sidecar.values():
            self.assertNotIn(os.sep, doc["file"], "a content-addressed name, never a path")
            self.assertNotIn("source_path", doc)

    def test_no_manifest_means_no_links(self) -> None:
        links = build_document_links(self.config, INTAKE, None, self.published)
        self.assertEqual({}, links.phase_primary)
        self.assertEqual({}, links.anchor_primary)


if __name__ == "__main__":
    unittest.main()
