"""Materialize the trip-runtime source at a promoted release's revision.

Sprint 4.7 — release-artifact hardening. The planner records which release a
provision job runs against; without this the worker would deploy whatever code
happens to be in the repo checkout, so a release scanned and promoted for
commit A could ship an unscanned commit B. This checks out the release's payload
at its `source_revision` into a throwaway directory and verifies the tree
against the release's `artifact_digest` before the deploy adapter is pointed at
it.

The payload is `site/ server/ shared/` (what a trip site runs) and, since #568
slice R2, `mcp/` (the trip's bridge) and `profile-templates/` (its companion), so
that one release is one version of all three. A release sealed BEFORE R2 covers
only the first three: its digest is over those and nothing else, and it must stay
valid for the site step. Which seal a digest is, is read off the digest itself
(`release_payload_roots`) rather than guessed from the checkout, so a revision
that happens to hold `mcp/` today is not shipped to a release that never sealed it.

`tree_digest` is the Python twin of `computeArtifactDigest` in
`control-plane/api/src/release-artifact.ts`, and `PAYLOAD_ROOTS` of its
`PAYLOAD_ROOTS` — change them together.
"""
from __future__ import annotations

import hashlib
import io
import os
import subprocess
import tarfile
import tempfile

# What a trip site runs, then what runs beside it. TS twin: PAYLOAD_ROOTS in release-artifact.ts.
SITE_ROOTS = ("site", "server", "shared")
RUNTIME_ROOTS = ("mcp", "profile-templates")
PAYLOAD_ROOTS = SITE_ROOTS + RUNTIME_ROOTS


class ReleaseSourceError(RuntimeError):
    """Raised when the release revision is missing or its tree does not match
    the recorded digest. Carries a safe_error_code for the job's failure row."""

    def __init__(self, message: str, safe_error_code: str) -> None:
        super().__init__(message)
        self.safe_error_code = safe_error_code


def _safe_directory(repo_root: str) -> list[str]:
    """`-c safe.directory=` for exactly this repository.

    The worker runs as root against a repository it did not create. On the
    Proxmox VM /repo is a bind mount owned by the operator's uid, and git
    refuses that ("detected dubious ownership"), which failed every release
    verification. Only the repository the worker was handed is trusted — the
    path as given and, if different, its real path — never a wildcard."""
    paths = {os.path.abspath(repo_root), os.path.realpath(repo_root)}
    return [arg for path in sorted(paths) for arg in ("-c", f"safe.directory={path}")]


def _git(repo_root: str, *args: str, binary: bool = False):
    result = subprocess.run(
        ["git", *_safe_directory(repo_root), "-C", repo_root, *args],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()[-300:]
        raise ReleaseSourceError(f"git {args[0]} failed: {detail}", "RELEASE_REVISION_UNAVAILABLE")
    return result.stdout if binary else result.stdout.decode("utf-8")


def _listing(repo_root: str, revision: str, roots: tuple[str, ...]) -> list[tuple[str, str]]:
    listing = _git(repo_root, "ls-tree", "-r", revision, "--", *roots)
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
    return rows


def _digest_of(rows: list[tuple[str, str]]) -> str:
    canonical = "\n".join(f"{path} {sha}" for path, sha in rows)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def tree_digest(repo_root: str, revision: str, roots: tuple[str, ...] = PAYLOAD_ROOTS) -> str:
    """`sha256:` over `"<path> <blobsha>"` lines for every file under *roots* at
    *revision*, sorted by path — byte-for-byte the value the TS build records as
    the release's artifact_digest. *roots* is every payload root for a release
    built now and `SITE_ROOTS` for one sealed before #568 R2."""
    return _digest_of(_listing(repo_root, revision, roots))


def release_payload_roots(repo_root: str, revision: str, expected_digest: str) -> tuple[str, ...] | None:
    """The roots a release's digest covers: every payload root, or the three site
    roots for a release sealed before the bridge and the companion templates were
    part of it. None when the tree at *revision* matches neither — the caller
    refuses it as a digest mismatch. Both seals are tried on the SAME revision, so
    a tree is accepted only by hashing to the exact digest the release recorded;
    nothing is relaxed by there being two."""
    for roots in (PAYLOAD_ROOTS, SITE_ROOTS):
        if tree_digest(repo_root, revision, roots) == expected_digest:
            return roots
    return None


def materialize_release_source(
    repo_root: str, revision: str, expected_digest: str | None = None,
) -> str:
    """Extract the release's payload at *revision* into a fresh temp directory
    and return its path. When *expected_digest* is given, the tree must hash to
    it — a mismatch raises rather than deploying unverified bytes — and exactly
    the roots that digest covers are extracted (`release_payload_roots`); without
    one, every payload root the revision has. The caller owns the returned
    directory and must remove it.
    """
    if not repo_root:
        raise ReleaseSourceError("no repo root configured for release materialization", "RELEASE_REPO_ROOT_UNSET")
    if not (isinstance(revision, str) and len(revision) == 40 and all(c in "0123456789abcdef" for c in revision)):
        raise ReleaseSourceError("release source_revision is not a commit id", "RELEASE_REVISION_INVALID")

    # Fail before extracting anything if the revision is not reachable here.
    _git(repo_root, "cat-file", "-e", f"{revision}^{{commit}}")

    roots = PAYLOAD_ROOTS
    if expected_digest is not None:
        covered = release_payload_roots(repo_root, revision, expected_digest)
        if covered is None:
            raise ReleaseSourceError(
                "release tree digest does not match the promoted artifact",
                "RELEASE_ARTIFACT_DIGEST_MISMATCH",
            )
        roots = covered
    # `git archive` fails on a path the revision does not have (a commit from before mcp/ existed
    # carries a digest that covers it as an empty set), so ask only for what is there.
    present = {path.split("/", 1)[0] for path, _ in _listing(repo_root, revision, roots)}
    roots = tuple(root for root in roots if root in present)
    if not roots:
        # `git archive <rev> --` with no path is the WHOLE repository, which is exactly what a release must never ship.
        raise ReleaseSourceError("release revision has no payload", "RELEASE_PAYLOAD_EMPTY")

    archive = _git(repo_root, "archive", "--format=tar", revision, "--", *roots, binary=True)
    dest = tempfile.mkdtemp(prefix="kinerary-release-")
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        # git archive emits only repo-relative regular files/dirs for the paths
        # we asked for; `data` filter is still applied as defense in depth.
        try:
            tar.extractall(dest, filter="data")  # type: ignore[call-arg]  # py>=3.12
        except TypeError:
            tar.extractall(dest)
    return dest
