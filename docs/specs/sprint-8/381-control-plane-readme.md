# `control-plane/README.md` describes the current layout

Status: draft (2026-10-19) · Issue: #381 · Track: Housekeeping · Size: S · Tier: Small (docs-only)
Security path: no · Migration: no · Live-trip behaviour: no

> **Built in Sprint 7** (`4fccad1`, released 2026-10-27). Kept as the record.

> **Built on integration/sprint-7 (2026-10-19):** `4fccad1` (PR #426 carry-in). This spec is kept as the record; the verifier checks AC-1..n against that commit.

`control-plane/README.md` opened as the "Sprint 0" boundary note while the
directory now holds the API, relay, worker, runtime gateway, deployment scripts
and migrations; the root `README.md` sends readers there for the repository
layout. The fix is in the Sprint 7 docs-sync change (branch
`docs/sprint-7-prep`, not yet committed), which rewrites the opening as an "in
service, built across Sprints 0 to 6" status line and refreshes the layout
section. **Acceptance:** (AC-1) the title and opening name no sprint as the
current state and point to `docs/onboarding-mvp-sprint-plan.md` for history;
(AC-2) every top-level entry under `control-plane/` is listed with a one-line
purpose, and nothing that no longer exists is; (AC-3) no host, IP, container
name or deployment path is named (hard rule 6); (AC-4) `doc-keeper` confirms
the root `README.md` link still lands on it. **Test plan:** compare
`ls control-plane/` with the README's list; `scripts/preflight-checks.sh
--staged` passes; the docs-only commit takes the MVP item-1 path. Closes #381
when the docs-sync PR merges.
