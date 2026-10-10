# `.project/` — state a fresh session must be able to read

`sprint.json` is the single source of truth for the active sprint, its locked
scope, the baseline commit, and whether the sprint or the baseline is
**locked**. It exists because on 2026-09-20 both locks lived in a memory file
and in Dror's head, and a session with no prior context could not tell whether
`integration/sprint-6` was ready to leave or whether the baseline it was about
to build on was still moving.

**Discover it:** every Claude Code and Codex session gets one line of it at
start (`scripts/claude-hooks/sessionstart.sh`). For the rest:

```bash
scripts/project-state.py show          # for a person
scripts/project-state.py show --json   # for an agent
scripts/project-state.py check         # consistent with the tree? exit 1 says why
```

**Change it** only through the script — the Write hook refuses a hand edit,
because a hand edit carries no who, when or why:

```bash
scripts/project-state.py lock   baseline --by "Dror" --reason "baseline fixes landed and verified"
scripts/project-state.py unlock sprint   --by "Dror" --reason "ready to assess, merge and deploy"
scripts/project-state.py set-baseline --commit HEAD --by … --reason …          # refuses while locked
scripts/project-state.py set-sprint --id 7 --integration-branch integration/sprint-7 --by … --reason …
```

**What the two locks mean:**

| | `locked` | `open` |
|---|---|---|
| sprint | the integration branch is not to be assessed, deployed, or merged to `main` | it may be, through the normal gates |
| baseline | settled: `baseline.commit` is what sprint work builds on; the agent team may start | still being prepared: the commit moves with each fix; the agent team does not start |

**What needs an override:** moving `baseline.commit` while the baseline is
locked, and changing the sprint while the sprint is locked. Both refuse without
`--override`, and an override is written into `history`. The change is then a
commit; hard rule 1 makes every commit a human approval, and
`scripts/preflight-checks.sh` (B8) prints every lock, baseline and override
change inside that approval prompt, so it is approved by name rather than as
one more JSON diff.

**Which copy is authoritative:** the one on the active integration branch. It
reaches `main` when the sprint does.
