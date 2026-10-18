#!/usr/bin/env python3
"""Canonicalize a path to every spelling that can alias the same file.

Shared by scripts/claude-hooks/codex-adapter.py (Codex's apply_patch route,
#261) and scripts/claude-hooks/pretooluse-write.sh (Claude's own Write/Edit
route, #262 — through this file's CLI mode below, since bash has no
Unicode/inode library of its own). One canonicalization routine, not two.

APFS (this Mac's filesystem, case- and Unicode-normalisation-insensitive by
default) answers MORE THAN ONE spelling with the SAME file: a different case,
and a Unicode "confusable" code point that folds to the same letter under the
comparison the filesystem itself performs (e.g. U+017F LATIN SMALL LETTER
LONG S folds to ASCII 's' under Unicode default case folding — CaseFolding.txt's
common mapping, "017F; C; 0073" — which is why APFS opens
`.project/ſprint.json` as the same file as `.project/sprint.json`). This
module never reimplements that folding in Python: on_disk() asks the
filesystem, by directory listing and inode comparison, which real entry a
given name opens. Whatever the filesystem itself folds — case, Unicode
canonical equivalence, a confusable that happens to fold under Unicode case
folding — is picked up for free, with no Unicode confusables table.

What this deliberately does NOT do: fold anything the filesystem itself does
not fold. A Unicode confusable the filesystem treats as a genuinely different
file (most of them — U+017F only rides along because Unicode's OWN case
folding happens to cover it, and APFS's case-insensitive comparison uses
Unicode case folding) is not caught here, and would need a full confusables
table (Unicode UTS #39) this module does not have. That is a real, stated gap
— see issue #262's report — not a silent one.

A path component that does not exist yet cannot be resolved by directory
listing (there is no entry to compare against): on_disk() keeps it exactly as
written from that point down. spellings() additionally ASCII-casefolds the
whole value, so a not-yet-existing leaf under a real but differently-cased
protected directory (`TRIP/newfile.txt`, where `trip/` exists but
`TRIP/newfile.txt` does not) still carries a spelling that matches a
lowercase-only protected pattern (trip/*, .project/sprint.json) even though
on_disk() alone could not resolve that one component.
"""
from __future__ import annotations

import os
import stat
import sys
from pathlib import Path


def on_disk(root: Path, path: Path) -> Path:
    """`path` (absolute, under `root`) spelled the way the filesystem stores it.

    Each existing component is replaced by the directory entry that is the
    same file — compared by inode (os.path.samestat), never by string, so
    whatever the filesystem folds (case, normalisation, a Unicode confusable
    that folds under Unicode case folding) is honoured automatically. A
    component that does not exist stays exactly as written: nothing can alias
    a name with no directory entry yet.
    """
    current = root
    for part in path.relative_to(root).parts:
        try:
            names = os.listdir(current)
            wanted = os.lstat(current / part)
        except OSError:
            current = current / part
            continue
        if part not in names:
            same = []
            for name in names:
                try:
                    if os.path.samestat(os.lstat(current / name), wanted):
                        same.append(name)
                except OSError:
                    pass
            if len(same) != 1:
                raise ValueError("Path spelling does not match one directory entry")
            part = same[0]
        current = current / part
    return current


def _lexical_and_resolved(value: str, cwd: Path) -> tuple[Path, Path]:
    path = Path(value)
    if not path.is_absolute():
        path = cwd / value
    return Path(os.path.abspath(path)), path.resolve()


def spellings(root: Path, value: str, *, cwd: Path | None = None) -> list[Path]:
    """Every spelling that can alias `value` on this filesystem.

    Returns absolute paths: the value as given, its symlink destination, each
    as the disk spells it, and each ASCII-casefolded (for a protected
    directory that does not exist yet, or exists spelled differently). A
    spelling may only ever ADD a denial at a call site — this never drops the
    original value.

    `value` resolving outside `root` is out of scope here (a call site only
    ever compares these against patterns rooted inside `root`): the single
    as-given path comes back unchanged, rather than raising. A caller with a
    narrower repository-boundary rule of its own (Codex's apply_patch route
    has one — see checked_paths()) enforces it separately.
    """
    cwd = cwd or Path.cwd()
    lexical, resolved = _lexical_and_resolved(value, cwd)
    try:
        lexical.relative_to(root)
        resolved.relative_to(root)
    except ValueError:
        return [lexical]
    out = [lexical, resolved, on_disk(root, lexical), on_disk(root, resolved)]
    out += [root.joinpath(*(part.casefold() for part in p.relative_to(root).parts))
            for p in out]
    # casefold alone cannot reach an UPPERCASE-only protected literal
    # (CLAUDE.md): casefold only ever lowers a spelling. Reserve the
    # root-level alias explicitly, matching the existing conservative
    # treatment of trip/ and .project/sprint.json (both already lowercase).
    if any(p.relative_to(root).parts == ("claude.md",) for p in out):
        out.append(root / "CLAUDE.md")
    return list(dict.fromkeys(out))


def checked_paths(root: Path, value: str, *, cwd: Path | None = None) -> list[str]:
    """`spellings()`, plus the refusals specific to Codex's apply_patch route:
    a path that resolves outside the repository, and a regular file reachable
    through more than one hard link (its other names cannot be established
    with a bounded repository-local scan)."""
    cwd = cwd or Path.cwd()
    lexical, resolved = _lexical_and_resolved(value, cwd)
    try:
        lexical.relative_to(root)
        resolved.relative_to(root)
    except ValueError:
        raise ValueError("Patch path is outside this repository")
    try:
        info = resolved.stat()
    except FileNotFoundError:
        pass
    else:
        if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
            raise ValueError("Cannot safely authorize a multiply-linked file")
    return [str(p) for p in spellings(root, value, cwd=cwd)]


def main(argv: list[str]) -> int:
    """CLI mode for pretooluse-write.sh: `path_canon.py <repo_root> <file_path>`
    prints one spelling per line. Deliberately lenient — an unreadable root, a
    value outside it, or any internal failure prints just the value as given
    rather than raising, so a caller that cannot run this still gets a safe,
    minimal result: exactly the single-spelling check this hook had before
    #262, never a wider denial than that.
    """
    if len(argv) != 2:
        print("usage: path_canon.py <repo_root> <file_path>", file=sys.stderr)
        return 2
    root, value = Path(argv[0]), argv[1]
    try:
        for p in spellings(root, value):
            print(p)
    except Exception:
        print(value)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
