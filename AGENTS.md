# AGENTS.md

All guidance for working in this repository — hard rules, architecture
pointers, the skill-mirror setup, MCP trust boundaries, security-sensitive
paths, testing, working style — lives in [`CLAUDE.md`](CLAUDE.md). Read that
file; treat every rule in it as if it were written here too.

This file exists only so agents that look for `AGENTS.md` specifically (not
`CLAUDE.md`) find their way to the same rules, without a second copy that can
drift out of sync — the same reason `.claude/skills/create-trip` is a symlink
to `.agents/skills/create-trip` rather than a hand-maintained duplicate.

One addition specific to the `AGENTS.md` convention: the canonical location
for the create-trip skill is `.agents/skills/create-trip/` — that's the real
directory; `.claude/skills/create-trip` just symlinks to it.
