#!/usr/bin/env python3
"""Remove what merged work leaves behind: worktrees, local and remote branches.

    scripts/sweep-merged.py              # what would go, and why the rest stays
    scripts/sweep-merged.py --execute    # do it
    scripts/sweep-merged.py --count      # one line, or nothing (session start)

Why this is a script and not only a role: pr-steward's Sweep 4 was correct, but
it ran only when somebody asked, and on 2026-11-09 the repository held 39
worktrees and some 300 branches for work merged weeks before. The post-merge
hook (scripts/claude-hooks/posttooluse-bash.sh) now runs `--execute` after every
merge, and GitHub deletes a merged PR's head branch on its own. A branch merged
locally, with no PR, is what this catches on the remote side.

"Merged" is one of two things, and nothing else:

- the tip is reachable from origin/main or an origin/integration/* branch, and
  is NOT on that branch's first-parent line. A merge commit brings work in as
  its second parent; a branch whose tip sits ON the mainline has no commits of
  its own: somebody just created it, and it is not done, it is not started;
- a MERGED pull request has this head branch, and the tip is that PR's head or
  an ancestor of it (a squash merge changes every SHA, so ancestry alone misses
  it).

A worktree is removed only when it is under <repo>/.claude/worktrees/, on a
merged branch, clean, without an open PR, not mounted by a running container
(staging's Postgres read its password out of one), and no process has its
working directory inside it. A detached HEAD, a codex/* branch and the
long-lived branches (main, integration/*, release/*) are never touched. An
untracked __pycache__ is not dirt: a test run leaves one in every worktree.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

LONG_LIVED = ("main", "HEAD")
LONG_LIVED_PREFIXES = ("integration/", "release/")


def run(*cmd: str, cwd: Path | None = None, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, check=check)


def git(repo: Path, *args: str) -> str:
    return run("git", "-C", str(repo), *args).stdout.strip()


def untouchable(branch: str) -> bool:
    return branch in LONG_LIVED or branch.startswith(LONG_LIVED_PREFIXES) or branch.startswith("codex/")


class Sweep:
    def __init__(self, repo: Path, fetch: bool):
        common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
        self.root = common.parent
        self.wt_dir = (self.root / ".claude" / "worktrees").resolve()
        if fetch:
            run("git", "-C", str(self.root), "fetch", "--quiet", "--prune", "origin")
        self.mainlines = [r for r in git(self.root, "for-each-ref", "--format=%(refname:short)",
                                         "refs/remotes/origin/main", "refs/remotes/origin/integration/").split() if r]
        self.first_parent: set[str] = set()
        for ref in self.mainlines:
            self.first_parent.update(git(self.root, "rev-list", "--first-parent", ref).split())
        self.prs = self._prs()

    def _prs(self) -> list[dict]:
        if not shutil.which("gh"):
            return []
        r = run("gh", "pr", "list", "--state", "all", "--limit", "1000",
                "--json", "number,headRefName,headRefOid,state", cwd=self.root)
        try:
            return json.loads(r.stdout) if r.returncode == 0 else []
        except json.JSONDecodeError:
            return []

    def ancestor(self, a: str, b: str) -> bool:
        return run("git", "-C", str(self.root), "merge-base", "--is-ancestor", a, b).returncode == 0

    def open_pr(self, branch: str) -> dict | None:
        return next((p for p in self.prs if p["headRefName"] == branch and p["state"] == "OPEN"), None)

    def merged(self, branch: str, sha: str) -> str | None:
        """Why `sha` (the tip of `branch`) counts as merged, or None."""
        if sha not in self.first_parent:
            for ref in self.mainlines:
                if self.ancestor(sha, ref):
                    return f"in {ref}"
        for p in self.prs:
            if p["headRefName"] == branch and p["state"] == "MERGED":
                if sha == p["headRefOid"] or self.ancestor(sha, p["headRefOid"]):
                    return f"PR #{p['number']} merged"
        return None

    # ── what is in use ─────────────────────────────────────────────────────
    def mounted_paths(self) -> list[str]:
        if not shutil.which("docker"):
            return []
        ids = run("docker", "ps", "-q").stdout.split()
        if not ids:
            return []
        out = run("docker", "inspect", "--format", "{{range .Mounts}}{{.Source}}\n{{end}}", *ids).stdout
        return [l.strip() for l in out.splitlines() if l.strip()]

    def process_cwds(self) -> list[str]:
        if not shutil.which("lsof"):
            return []
        out = run("lsof", "-d", "cwd", "-Fn").stdout
        return [l[1:] for l in out.splitlines() if l.startswith("n")]

    @staticmethod
    def inside(paths: list[str], wt: Path) -> bool:
        w = str(wt)
        return any(p == w or p.startswith(w + "/") for p in paths)

    # ── the three sweeps ───────────────────────────────────────────────────
    def worktrees(self):
        """Yield (path, branch, verdict, reason) for every worktree under .claude/worktrees/."""
        mounts, cwds = self.mounted_paths(), self.process_cwds()
        entry: dict = {}
        for line in git(self.root, "worktree", "list", "--porcelain").splitlines() + [""]:
            if line:
                k, _, v = line.partition(" ")
                entry[k] = v
                continue
            if "worktree" in entry:
                yield self._judge(entry, mounts, cwds)
            entry = {}

    def _judge(self, e: dict, mounts: list[str], cwds: list[str]):
        path = Path(e["worktree"])
        real = path.resolve() if path.exists() else path
        branch = e.get("branch", "").removeprefix("refs/heads/")
        if real.parent != self.wt_dir:
            return path, branch, "skip", "not under .claude/worktrees/"
        if not path.exists():
            return path, branch, "prune", "directory is gone"
        if "detached" in e:
            return path, branch, "keep", "detached HEAD"
        if untouchable(branch):
            return path, branch, "keep", "long-lived or codex branch"
        if pr := self.open_pr(branch):
            return path, branch, "keep", f"PR #{pr['number']} is open"
        why = self.merged(branch, e["HEAD"])
        if not why:
            return path, branch, "keep", "not merged"
        dirt = [l for l in git(path, "status", "--porcelain", "--untracked-files=all").splitlines()
                if "__pycache__/" not in l and not l.endswith(".pyc")]
        if dirt:
            return path, branch, "keep", f"merged ({why}) but {len(dirt)} uncommitted change(s)"
        if self.inside(mounts, real):
            return path, branch, "keep", f"merged ({why}) but a running container mounts it"
        if self.inside(cwds, real):
            return path, branch, "keep", f"merged ({why}) but a process is working in it"
        return path, branch, "remove", why

    def local_branches(self, checked_out: set[str]):
        fmt = "%(refname:short) %(objectname)"
        for line in git(self.root, "for-each-ref", f"--format={fmt}", "refs/heads/").splitlines():
            b, sha = line.split()
            if b in checked_out or untouchable(b) or self.open_pr(b):
                continue
            if why := self.merged(b, sha):
                yield b, why

    def remote_branches(self):
        fmt = "%(refname:short) %(objectname)"
        for line in git(self.root, "for-each-ref", f"--format={fmt}", "refs/remotes/origin/").splitlines():
            ref, sha = line.split()
            b = ref.removeprefix("origin/")
            if b == "origin" or untouchable(b) or self.open_pr(b):
                continue
            if why := self.merged(b, sha):
                yield b, why


def remove_worktree(root: Path, path: Path, branch: str) -> str | None:
    for cache in path.rglob("__pycache__"):
        if not git(path, "ls-files", str(cache.relative_to(path))):
            shutil.rmtree(cache, ignore_errors=True)
    r = run("git", "-C", str(root), "worktree", "remove", str(path))
    if r.returncode:
        return r.stderr.strip()
    run("git", "-C", str(root), "branch", "-D", branch)
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--execute", action="store_true", help="remove what is merged (default: report only)")
    ap.add_argument("--count", action="store_true", help="print one summary line, or nothing")
    ap.add_argument("--no-fetch", action="store_true", help="judge against the refs already fetched")
    ap.add_argument("--no-remote", action="store_true", help="leave remote branches alone")
    ap.add_argument("--repo", default=".", help="any checkout of the repository")
    a = ap.parse_args()

    s = Sweep(Path(a.repo), fetch=not a.no_fetch)
    wts = list(s.worktrees())
    checked_out = {b for _, b, _, _ in wts if b} | {
        l.removeprefix("branch refs/heads/") for l in git(s.root, "worktree", "list", "--porcelain").splitlines()
        if l.startswith("branch ")}
    gone_wt = [w for w in wts if w[2] in ("remove", "prune")]
    locals_ = list(s.local_branches(checked_out))
    remotes = [] if a.no_remote else list(s.remote_branches())

    if a.count:
        n = (len(gone_wt), len(locals_), len(remotes))
        if any(n):
            print(f"Sweep: {n[0]} merged worktree(s), {n[1]} local and {n[2]} remote merged branch(es) "
                  f"are left over — run scripts/sweep-merged.py --execute.")
        return 0

    verb = "removed" if a.execute else "would remove"
    for path, branch, verdict, why in wts:
        if verdict == "skip":
            continue
        if verdict == "prune":
            print(f"{verb}  worktree {path.name}: {why}")
        elif verdict == "remove":
            err = remove_worktree(s.root, path, branch) if a.execute else None
            print(f"{'FAILED ' if err else verb}  worktree {path.name} [{branch}]: {err or why}")
        else:
            print(f"kept     worktree {path.name} [{branch or 'detached'}]: {why}")
    if a.execute:
        run("git", "-C", str(s.root), "worktree", "prune")
        for b, _ in locals_:
            run("git", "-C", str(s.root), "branch", "-D", b)
        if remotes:
            r = run("git", "-C", str(s.root), "push", "--quiet", "origin", "--delete", *[b for b, _ in remotes])
            if r.returncode:
                print(f"FAILED  remote delete: {r.stderr.strip()}")
    for b, why in locals_:
        print(f"{verb}  local branch {b}: {why}")
    for b, why in remotes:
        print(f"{verb}  remote branch {b}: {why}")
    print(f"{len(gone_wt)} worktree(s), {len(locals_)} local, {len(remotes)} remote branch(es) "
          f"{'removed' if a.execute else 'to remove — dry run; pass --execute'}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
