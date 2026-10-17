"""Hands a trip's source documents to its site, and links them to what they support.

The control plane keeps each uploaded original once, content-addressed, in its
document store (``DOCUMENT_STORE_DIR/<trip_id>/<sha256>.<ext>``). A provisioned
trip needs those originals beside its config, so a hotel card can open the
voucher behind it. This module is that handoff — and nothing else decides where
a document lands or which card it belongs to.

WHY A HARD LINK FIRST. The deploy directory (``<deploy_root>/trips/<slug>``) and
the document store usually sit on the same filesystem, and a hard link there is
one set of bytes with two names: no transfer, nothing to drift, and deleting the
trip's name leaves the control plane's original — which its immutable intake
versions still reference — exactly where it was. Only when a link is refused
(separate filesystems, or a filesystem without links) does this fall back to a
copy, verified against the digest. The deploy step then carries the trip
directory onto the container, which cannot see the control plane's disk; that
second copy is the container's, and is unavoidable until the site can mount the
store.

WHY INDICES, NOT IDENTITY. Which document supports which answer is recorded by
the API in terms of an entry's identity, and those identity rules live in
TypeScript. Re-deriving them here would be a second copy free to drift. So the
API resolves identity once, at confirmation, into an index into the confirmed
answer (``source_document.sources``), and this module joins on that index alone.
The version is immutable; so is the index.

Best-effort throughout. A document that cannot be published is logged and left
unlinked; it never fails a provision. A missing link reads as "no source shown",
and that is recoverable on the next provision.
"""
from __future__ import annotations

import errno
import hashlib
import logging
import os
import re
import shutil
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

from .transformer import _parse_iso_date, _phase_id_for_date, _structured_list

logger = logging.getLogger(__name__)

#: The only shape a storage key may have. The trip id and the digest in it are
#: checked against the registry row, so a key cannot point at another trip's
#: original or outside the store.
STORAGE_KEY = re.compile(r"^([a-z]{2,12}_[A-Za-z0-9]{8,64})/([a-f0-9]{64})\.(pdf|docx|xlsx|html|txt|png|jpg|webp|gif)$")
DIGEST = re.compile(r"^sha256:([a-f0-9]{64})$")

_LINK_REFUSED = {
    errno.EXDEV,
    errno.EPERM,
    errno.EMLINK,
    getattr(errno, "ENOTSUP", -1),
    getattr(errno, "EOPNOTSUPP", -2),
}


@dataclass(frozen=True)
class TripDocumentFile:
    """One stored original, ready to publish."""

    document_id: str
    #: The published, content-addressed name — ``<sha256-hex>.<ext>``. Never the
    #: sender's filename, which is metadata and never a path component.
    file_name: str
    source_path: str
    content_digest: str
    filename: str | None
    mime: str | None


def load_trip_documents(
    conn: Any,
    trip_id: str,
    manifest: Mapping[str, Any] | None,
    store_root: str | None,
) -> list[TripDocumentFile]:
    """The originals a confirmed intake version names, as they sit in the store.

    Only documents the manifest marks as stored, that belong to this trip, whose
    registry row agrees with the storage key, and whose file is actually present
    are returned. Anything else is logged and skipped.
    """
    if not store_root or not isinstance(manifest, Mapping):
        return []
    wanted = [
        doc for doc in manifest.get("documents") or []
        if isinstance(doc, Mapping) and doc.get("stored") and isinstance(doc.get("documentId"), str)
    ]
    if not wanted:
        return []
    order = [doc["documentId"] for doc in wanted]
    names = {doc["documentId"]: doc.get("filename") for doc in wanted}

    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, content_digest, storage_key, mime FROM control_plane.trip_documents "
            "WHERE trip_id = %s AND id = ANY(%s) AND ingest_state = 'stored'",
            (trip_id, order),
        )
        rows = cur.fetchall()

    root = os.path.realpath(store_root)
    found: list[TripDocumentFile] = []
    for row in sorted(rows, key=lambda r: order.index(r["id"])):
        key = row["storage_key"] or ""
        key_match = STORAGE_KEY.match(key)
        digest_match = DIGEST.match(row["content_digest"] or "")
        if (
            not key_match or not digest_match
            or key_match.group(1) != trip_id
            or key_match.group(2) != digest_match.group(1)
        ):
            logger.warning("document_handoff.storage_key_rejected", extra={"document_id": row["id"]})
            continue
        source = os.path.join(root, key)
        if not os.path.isfile(source):
            logger.warning("document_handoff.original_missing", extra={"document_id": row["id"]})
            continue
        found.append(TripDocumentFile(
            document_id=row["id"],
            file_name=os.path.basename(key),
            source_path=source,
            content_digest=row["content_digest"],
            filename=names.get(row["id"]),
            mime=row["mime"],
        ))
    return found


def _digest_of(path: str) -> str:
    sha = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            sha.update(chunk)
    return "sha256:" + sha.hexdigest()


DOCUMENT_STORE_MARKER = ".kinerary-document-store"


def _mount_point_for(target: str, mountinfo: str) -> str | None:
    """The longest mount point in /proc/self/mountinfo text that contains ``target``."""
    best: str | None = None
    for line in mountinfo.splitlines():
        fields = line.split(" ")
        if len(fields) < 5:
            continue
        point = re.sub(r"\\(\d{3})", lambda m: chr(int(m.group(1), 8)), fields[4])
        prefix = point if point.endswith("/") else point + "/"
        inside = point == "/" or target == point or target.startswith(prefix)
        if inside and (best is None or len(point) > len(best)):
            best = point
    return best


def check_document_store(root: str | None, *, mountinfo_path: str = "/proc/self/mountinfo") -> tuple[bool, str, str]:
    """Whether ``root`` is the persistent document store. Returns (ok, reason, detail).

    The same checks, in the same order, as the relay's ``checkDocumentStore``
    (document-store.ts): configured, a directory, carrying the marker file
    created once on the real volume, writable, and — where /proc exists — on a
    mount of its own rather than the container's root filesystem.
    """
    if not root:
        return False, "NOT_CONFIGURED", "DOCUMENT_STORE_DIR is not set"
    resolved = os.path.realpath(root)
    if not os.path.exists(resolved):
        return False, "MISSING", f"{resolved} does not exist"
    if not os.path.isdir(resolved):
        return False, "NOT_A_DIRECTORY", f"{resolved} is not a directory"
    if not os.path.exists(os.path.join(resolved, DOCUMENT_STORE_MARKER)):
        return False, "NO_MARKER", (
            f"{resolved}/{DOCUMENT_STORE_MARKER} is missing — the persistent volume is not mounted here, "
            "or was never initialised"
        )
    probe = os.path.join(resolved, f".write-probe-{os.getpid()}")
    try:
        fd = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        os.unlink(probe)
    except OSError as exc:
        return False, "NOT_WRITABLE", f"{resolved}: {exc.strerror or 'cannot write'}"
    try:
        with open(mountinfo_path, encoding="utf-8") as fh:
            mountinfo = fh.read()
    except OSError:
        mountinfo = None
    if mountinfo is not None and _mount_point_for(resolved, mountinfo) == "/":
        return False, "NOT_A_MOUNT", f"{resolved} is on the container's own filesystem, not a mounted volume"
    return True, "OK", resolved


def publish_document(
    document: TripDocumentFile,
    destination_dir: str,
    *,
    link: Callable[[str, str], None] = os.link,
) -> str:
    """Make one original available under ``destination_dir``.

    Returns ``"hardlink"``, ``"copy"`` or ``"existing"`` (a retried handoff that
    finds the same bytes already there). Raises ``ValueError`` when bytes do not
    match the digest — a corrupt original, or a file of that name holding
    something else — rather than publishing the wrong document under a card.
    """
    os.makedirs(destination_dir, exist_ok=True)
    destination = os.path.join(destination_dir, document.file_name)

    try:
        link(document.source_path, destination)
        return "hardlink"
    except FileExistsError:
        if _digest_of(destination) != document.content_digest:
            raise ValueError(f"{document.file_name} already published with different content")
        return "existing"
    except OSError as exc:
        if exc.errno not in _LINK_REFUSED:
            raise

    if _digest_of(document.source_path) != document.content_digest:
        raise ValueError(f"{document.file_name}: stored original does not match its digest")
    try:
        # Exclusive create keeps the no-replace guarantee a link gives: a
        # retried handoff finds the file instead of overwriting it.
        with open(document.source_path, "rb") as src, open(destination, "xb") as out:
            shutil.copyfileobj(src, out)
            out.flush()
            os.fsync(out.fileno())
    except FileExistsError:
        if _digest_of(destination) != document.content_digest:
            raise ValueError(f"{document.file_name} already published with different content")
        return "existing"
    if _digest_of(destination) != document.content_digest:
        os.unlink(destination)
        raise ValueError(f"{document.file_name}: copy did not verify")
    return "copy"


@dataclass
class DocumentLinks:
    """Which published document supports which part of a provisioned trip."""

    files: Mapping[str, TripDocumentFile]
    #: phase id -> the one document shown on its hotel card.
    phase_primary: dict[str, str] = field(default_factory=dict)
    #: phase id -> every document that supports the phase, primary included.
    phase_sources: dict[str, list[str]] = field(default_factory=dict)
    #: travel_anchors index -> the document shown on that booking.
    anchor_primary: dict[int, str] = field(default_factory=dict)
    _phase_rank: dict[str, int] = field(default_factory=dict)

    def for_phase(self, phase_id: str) -> str | None:
        return self.phase_primary.get(phase_id)

    def for_anchor(self, index: int) -> str | None:
        return self.anchor_primary.get(index)


def build_document_links(
    config: Mapping[str, Any],
    answers: Mapping[str, Any],
    manifest: Mapping[str, Any] | None,
    published: Mapping[str, TripDocumentFile],
) -> DocumentLinks:
    """Resolve the confirmed manifest's sources onto the provisioned config.

    A phase source is placed by its entry's start date — the transformer merges
    consecutive stops in the same place, so the answer's index is not the
    config's. A stop with no start date gets no link; guessing which phase it is
    would put one stay's voucher on another's card.

    A hotel card shows the document that SUPPLIED the stay (its provenance says
    it filled ``accommodation``) in preference to one that merely introduced an
    entry already carrying a booked stay, and never a document that only named
    the city.
    """
    links = DocumentLinks(files=published)
    if not isinstance(manifest, Mapping):
        return links
    phases = list(config.get("phases") or [])
    phase_entries = _structured_list(answers, "phases")
    anchor_count = len(_structured_list(answers, "travel_anchors"))

    for source in manifest.get("sources") or []:
        if not isinstance(source, Mapping):
            continue
        document = published.get(source.get("documentId"))  # type: ignore[arg-type]
        index = source.get("index")
        if document is None or not isinstance(index, int) or isinstance(index, bool) or index < 0:
            continue
        question = source.get("questionId")
        paths = [p for p in source.get("paths") or [] if isinstance(p, str)]

        if question == "phases" and index < len(phase_entries):
            entry = phase_entries[index]
            if not isinstance(entry, Mapping):
                continue
            start = _parse_iso_date(entry.get("start"))
            phase_id = _phase_id_for_date(phases, start) if start else None
            if not phase_id:
                continue
            supporting = links.phase_sources.setdefault(phase_id, [])
            if document.file_name not in supporting:
                supporting.append(document.file_name)

            stay = entry.get("accommodation")
            supplied = any(p == "accommodation" or p.startswith("accommodation.") for p in paths)
            introduced = (
                source.get("disposition") == "accepted"
                and isinstance(stay, Mapping)
                and bool(stay.get("confirmation"))
            )
            rank = 2 if supplied else 1 if introduced else 0
            if rank and rank > links._phase_rank.get(phase_id, 0):
                links.phase_primary[phase_id] = document.file_name
                links._phase_rank[phase_id] = rank

        elif question == "travel_anchors" and index < anchor_count:
            links.anchor_primary.setdefault(index, document.file_name)

    return links


def documents_manifest(links: DocumentLinks, bookings: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """``documents.json`` for the site: every published document and everything it supports.

    A booking carries one ``conf_file`` and a hotel card one link; a document can
    support several things and a thing several documents. This sidecar is where
    that many-to-many relation reaches the site, keyed by the content-addressed
    file name and the booking's seed key — never by a filesystem path.
    """
    by_file: dict[str, dict[str, Any]] = {}
    for document in links.files.values():
        by_file[document.file_name] = {
            "file": document.file_name,
            "filename": document.filename,
            "mime": document.mime,
            "links": [],
        }
    for phase_id in sorted(links.phase_sources):
        for name in links.phase_sources[phase_id]:
            if name in by_file:
                by_file[name]["links"].append({"kind": "phase", "id": phase_id})
    for row in bookings:
        name = row.get("conf_file")
        if isinstance(name, str) and name in by_file and row.get("seed_key"):
            by_file[name]["links"].append({"kind": "booking", "seed_key": row["seed_key"]})
    return sorted(by_file.values(), key=lambda doc: doc["file"])
