"""Materialize the trip-runtime source at a promoted release's revision.

Sprint 4.7 — release-artifact hardening. The planner records which release a
provision job runs against; without this the worker would deploy whatever code
happens to be in the repo checkout, so a release scanned and promoted for
commit A could ship an unscanned commit B. This checks out `site/`, `server/`
and `shared/` at the release's `source_revision` into a throwaway directory and
verifies the tree against the release's `artifact_digest` before the deploy
adapter is pointed at it.

`tree_digest` is the Python twin of `computeArtifactDigest` in
`control-plane/api/src/release-artifact.ts` — change them together.
"""
from __future__ import annotations

import hashlib
import io
import subprocess
import tarfile
import tempfile

_PAYLOAD_ROOTS = ("site", "server", "shared")


class ReleaseSourceError(RuntimeError):
    """Raised when the release revision is missing or its tree does not match
    the recorded digest. Carries a safe_error_code for the job's failure row."""

    def __init__(self, message: str, safe_error_code: str) -> None:
        super().__init__(message)
        self.safe_error_code = safe_error_code


def _git(repo_root: str, *args: str, binary: bool = False):
    result = subprocess.run(
        ["git", "-C", repo_root, *args],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()[-300:]
        raise ReleaseSourceError(f"git {args[0]} failed: {detail}", "RELEASE_REVISION_UNAVAILABLE")
    return result.stdout if binary else result.stdout.decode("utf-8")


def tree_digest(repo_root: str, revision: str) -> str:
    """`sha256:` over `"<path> <blobsha>"` lines for every payload-root file at
    *revision*, sorted by path — byte-for-byte the value the TS build records as
    the release's artifact_digest."""
    listing = _git(repo_root, "ls-tree", "-r", revision, "--", *_PAYLOAD_ROOTS)
    rows: list[tuple[str, str]] = []
    for line in listing.splitlines():
        if not line:
            continue
        meta, _, path = line.partition("\t")
        parts = meta.split()
        if len(parts) < 3 or parts[1] != "blob":
            continue
        rows.append((path, parts[2]))
    rows.sort(key=lambda r: r[0])
    canonical = "\n".join(f"{path} {sha}" for path, sha in rows)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def materialize_release_source(
    repo_root: str, revision: str, expected_digest: str | None = None,
) -> str:
    """Extract `site/ server/ shared/` at *revision* into a fresh temp directory
    and return its path. When *expected_digest* is given, the tree must hash to
    it — a mismatch raises rather than deploying unverified bytes. The caller
    owns the returned directory and must remove it.
    """
    if not repo_root:
        raise ReleaseSourceError("no repo root configured for release materialization", "RELEASE_REPO_ROOT_UNSET")
    if not (isinstance(revision, str) and len(revision) == 40 and all(c in "0123456789abcdef" for c in revision)):
        raise ReleaseSourceError("release source_revision is not a commit id", "RELEASE_REVISION_INVALID")

    # Fail before extracting anything if the revision is not reachable here.
    _git(repo_root, "cat-file", "-e", f"{revision}^{{commit}}")

    if expected_digest is not None:
        actual = tree_digest(repo_root, revision)
        if actual != expected_digest:
            raise ReleaseSourceError(
                "release tree digest does not match the promoted artifact",
                "RELEASE_ARTIFACT_DIGEST_MISMATCH",
            )

    archive = _git(repo_root, "archive", "--format=tar", revision, "--", *_PAYLOAD_ROOTS, binary=True)
    dest = tempfile.mkdtemp(prefix="kinerary-release-")
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        # git archive emits only repo-relative regular files/dirs for the paths
        # we asked for; `data` filter is still applied as defense in depth.
        try:
            tar.extractall(dest, filter="data")  # type: ignore[call-arg]  # py>=3.12
        except TypeError:
            tar.extractall(dest)
    return dest
