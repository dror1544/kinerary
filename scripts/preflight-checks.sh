#!/usr/bin/env bash
# scripts/preflight-checks.sh — the CLAUDE.md hard rules, as code.
#
# Every rule checked here was already prose in CLAUDE.md and already had a
# mechanism (shift-trip-dates.py --status exits 1 while shifted; a symlink is
# either a symlink or it isn't). Nothing called them. This is the one place
# that does, and it has two callers so no commit path escapes it:
#
#   .githooks/pre-commit          every commit, whoever makes it (Codex, Hermes, you)
#   .claude/settings.json hooks   Claude Code, early enough to steer rather than refuse
#
# Modes:
#   --staged          inspect the git index (pre-commit). All checks.
#   --paths f1 f2...  inspect files about to be written. Fast checks only (B3, B4).
#   --all             inspect the whole working tree. All checks, plus warnings.
#
# Exit 0 = clean, 1 = at least one BLOCK. Warnings never affect the exit code.
set -uo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "preflight: not inside a git repository" >&2; exit 0; }
cd "$REPO_ROOT" || exit 0

BLOCKED=0
# Reviewed exceptions (see .preflight-allow). Blanket rules with a recorded
# exception list beat blanket rules everyone learns to override.
allowed() {
  [ -f .preflight-allow ] || return 1
  grep -v '^[[:space:]]*#' .preflight-allow | sed 's/[[:space:]]*#.*$//' \
    | grep -qxF "$(printf '%s' "$1" | sed 's/[[:space:]]*$//')"
}
block() { printf 'BLOCK  %s\n' "$1"; [ -n "${2:-}" ] && printf '       fix: %s\n' "$2"; BLOCKED=1; }
warn()  { printf 'warn   %s\n' "$1"; [ -n "${2:-}" ] && printf '       fix: %s\n' "$2"; }

MODE="${1:---all}"; shift || true
PATHS=("$@")

# ── what to inspect ──────────────────────────────────────────────────────────
# No mapfile: macOS ships bash 3.2.
FILES=()
collect() { while IFS= read -r line; do [ -n "$line" ] && FILES+=("$line"); done; }
case "$MODE" in
  --staged) collect < <(git diff --cached --name-only --diff-filter=ACMR) ;;
  --paths)  FILES=(${PATHS+"${PATHS[@]}"}) ;;
  --all)    collect < <(git ls-files) ;;
  *) echo "usage: $0 [--staged|--paths <file>...|--all]" >&2; exit 2 ;;
esac

# Paths arrive absolute from Claude hooks and repo-relative from git. Normalise
# to repo-relative so one set of patterns matches both.
REL=()
for f in ${FILES+"${FILES[@]}"}; do
  case "$f" in
    "$REPO_ROOT"/*) REL+=("${f#"$REPO_ROOT"/}") ;;
    /*)             continue ;;   # outside the repo; not our business
    *)              REL+=("$f") ;;
  esac
done

# ── B3 · hard rule 4 — never write to trip/ (singular) ───────────────────────
# trip/ is reserved for whatever TRIP_DIR defaults to when unset; new trips go
# in trips/<slug>/. A write here silently shadows a live default.
for f in ${REL+"${REL[@]}"}; do
  case "$f" in
    trip/*) block "hard rule 4 — writes to trip/ (singular): $f" \
                  "new trips go in trips/<slug>/ — see .agents/skills/create-trip/SKILL.md" ;;
  esac
done

# ── B4 · skill-mirror integrity ──────────────────────────────────────────────
# mcp/provision.js shells out to .agents/skills/create-trip/driver.mjs by path.
# If .claude/skills/create-trip stops being a symlink, two real copies start
# drifting and the fallback path wins silently.
check_symlink() {
  local link=".claude/skills/create-trip" want=".agents/skills/create-trip"
  [ -e "$link" ] || [ -L "$link" ] || return 0
  if [ ! -L "$link" ]; then
    block "skill mirror broken — $link is a real directory, not a symlink" \
          "rm -rf $link && ln -s ../../$want $link"
    return
  fi
  local got; got="$(cd "$(dirname "$link")" && readlink "$(basename "$link")")"
  if [ "$got" != "../../$want" ]; then
    block "skill mirror points at '$got', expected '../../$want'" \
          "rm -rf $link && ln -s ../../$want $link"
  fi
}
check_symlink

# --paths is on the per-write path and must stay fast: no python, no recursive
# diffs. B3 and B4 above are all of it.
[ "$MODE" = "--paths" ] && exit $BLOCKED

# ── B2 · hard rule 3 — no binaries in git ────────────────────────────────────
# Two detectors: extension catches the obvious, numstat catches anything git
# itself considers binary regardless of what it is named.
BINARY_EXT='\.(pdf|png|jpe?g|gif|webp|bmp|tiff?|ico|heic|mp3|m4a|wav|aac|flac|ogg|mov|mp4|avi|mkv|webm|zip|tar|gz|tgz|bz2|7z|rar|woff2?|ttf|otf|eot|sqlite3?|db|dylib|so|dll|exe|o|a|class|jar|pyc)$'
for f in ${REL+"${REL[@]}"}; do
  if printf '%s' "$f" | grep -qiE "$BINARY_EXT"; then
    allowed "$f" && continue
    block "hard rule 3 — binary file: $f" \
          "binaries live outside the repo (NFS, iCloud, wherever deployment syncs media from)"
  fi
done
if [ "$MODE" = "--staged" ]; then
  while IFS=$'\t' read -r add del path; do
    [ "$add" = "-" ] && [ "$del" = "-" ] || continue
    printf '%s' "$path" | grep -qiE "$BINARY_EXT" && continue   # already reported
    allowed "$path" && continue
    block "hard rule 3 — git sees this as binary: $path" \
          "binaries live outside the repo"
  done < <(git diff --cached --numstat --diff-filter=ACMR)
fi

# ── B1 · shifted trip dates ──────────────────────────────────────────────────
# trips/*/trip.config.json is tracked, so a forgotten --restore commits fake
# dates. --root pins the check to the repo copy: shift-trip-dates.py otherwise
# resolves ~/kinerary-deploy/trips first, which git does not track.
if command -v python3 >/dev/null 2>&1; then
  for cfg in trips/*/trip.config.json; do
    [ -e "$cfg" ] || continue
    slug="$(basename "$(dirname "$cfg")")"
    if ! python3 scripts/shift-trip-dates.py --slug "$slug" --root "$REPO_ROOT/trips" --status >/dev/null 2>&1; then
      block "trip '$slug' is date-shifted — committing it would commit fake dates" \
            "python3 scripts/shift-trip-dates.py --slug $slug --restore"
    fi
  done
fi

# ── B5 · Hermes profile drift ────────────────────────────────────────────────
# ~/.hermes has no history, so any repo-owned content that also lives in a
# profile must not be allowed to diverge — the profile copy becoming the only
# copy is how content gets destroyed by the next deploy.
#
# Blocks on divergence of something the repo already owns. Only warns about
# profile content the repo does not own yet: that is a backlog to capture, not
# a reason no one can commit.
#
# ONE PROFILE, SEVERAL CHECKOUTS. A profile is often served from a worktree
# rather than from the checkout you happen to be committing in: the interviewer
# runs from the Sprint 5 worktree while `main` sits a whole flow behind, so
# `main`'s copy differing from the profile is correct, not drift. Blocking on it
# blocks every commit on main for as long as the branch is unmerged.
#
# What the rule actually protects is "~/.hermes is the ONLY copy". So the
# question is not "does THIS checkout match?" but "does ANY checkout of this
# repo?" — and when another one does, this reports which, rather than refusing.
# It still says so when that checkout has the content only as an uncommitted
# edit, because an uncommitted file has no more history than the profile does.
served_from_other_worktree() {
  # $1 repo-relative path · $2 the profile's copy. Echoes a description of the
  # worktree serving it, or nothing.
  local rel="$1" dest="$2" wt
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    [ "$wt" = "$REPO_ROOT" ] && continue
    [ -e "$wt/$rel" ] || continue
    if diff -r "$wt/$rel" "$dest" >/dev/null 2>&1; then
      local branch dirty
      branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
      dirty=""
      if [ -n "$(git -C "$wt" status --porcelain -- "$rel" 2>/dev/null)" ]; then
        dirty=" — UNCOMMITTED there, so it still has no history"
      fi
      printf '%s (%s)%s' "$(basename "$wt")" "$branch" "$dirty"
      return 0
    fi
  done <<EOF
$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
EOF
  return 1
}

HERMES_PROFILES="${HERMES_HOME:-$HOME/.hermes}/profiles"
if [ -d "$HERMES_PROFILES" ]; then
  # Mapped pairs (profile SOULs and anything install-hermes-skill.sh cannot express).
  if [ -f .agents/hermes-sync.tsv ]; then
    while IFS=$'\t' read -r repo_path profile prof_path; do
      case "$repo_path" in ''|'#'*) continue ;; esac
      [ -n "${profile:-}" ] && [ -n "${prof_path:-}" ] || continue
      dest="$HERMES_PROFILES/$profile/$prof_path"
      [ -e "$repo_path" ] || { warn "hermes-sync.tsv lists a missing repo path: $repo_path"; continue; }
      [ -e "$dest" ]      || { warn "not present in profile '$profile': $prof_path"; continue; }
      if ! diff -r "$repo_path" "$dest" >/dev/null 2>&1; then
        if server="$(served_from_other_worktree "$repo_path" "$dest")"; then
          warn "profile '$profile' is served from another checkout, not this one: $server" \
               "nothing to do here unless you meant to deploy this checkout's $repo_path"
        else
          block "hermes drift — $repo_path differs from profile '$profile'" \
                "diff $repo_path $dest    # then capture the profile side or deploy the repo side"
        fi
      fi
    done < .agents/hermes-sync.tsv
  fi

  # Auto-discovered skill directories: .agents/skills/<n> <-> profiles/*/skills/travel/<n>
  for src in .agents/skills/*/; do
    [ -d "$src" ] || continue
    name="$(basename "$src")"
    for dest in "$HERMES_PROFILES"/*/skills/travel/"$name"; do
      [ -d "$dest" ] || continue
      profile="$(basename "$(dirname "$(dirname "$(dirname "$dest")")")")"
      if ! diff -r "$src" "$dest" >/dev/null 2>&1; then
        if server="$(served_from_other_worktree "$src" "$dest")"; then
          warn "profile '$profile' runs $name from another checkout, not this one: $server" \
               "nothing to do here unless you meant to deploy this checkout's $name"
        else
          block "hermes drift — $name differs between the repo and profile '$profile'" \
                "scripts/install-hermes-skill.sh $name $profile --capture"
        fi
      fi
    done
  done

  # Profile-only skills: no repo copy at all, so ~/.hermes holds the only one.
  UNCAPTURED=""
  UNCAPTURED_N=0
  for dest in "$HERMES_PROFILES"/*/skills/travel/*/; do
    [ -d "$dest" ] || continue
    name="$(basename "$dest")"
    profile="$(basename "$(dirname "$(dirname "$(dirname "$dest")")")")"
    if [ ! -d ".agents/skills/$name" ]; then
      UNCAPTURED="$UNCAPTURED $profile/$name"
      UNCAPTURED_N=$((UNCAPTURED_N + 1))
    fi
  done
  if [ "$UNCAPTURED_N" -gt 0 ]; then
    warn "$UNCAPTURED_N profile skills have no repo copy — ~/.hermes holds the only one:$UNCAPTURED" \
         "review each and capture what is worth keeping: scripts/install-hermes-skill.sh <skill> <profile> --capture"
  fi
fi

# ── warnings ─────────────────────────────────────────────────────────────────
if [ "$MODE" = "--staged" ] || [ "$MODE" = "--all" ]; then
  # A runbook or rule that names a path which no longer exists.
  for doc in CLAUDE.md AGENTS.md README.md FRAMEWORK.md docs/landing-spa-test-runbook.md; do
    [ -f "$doc" ] || continue
    while read -r p; do
      [ -n "$p" ] || continue
      [ -e "$p" ] || warn "$doc references a path that no longer exists: $p"
    done < <(grep -oE '`(control-plane|server|mcp|shared|scripts|site|web|provisioning)/[A-Za-z0-9_./-]+`' "$doc" \
             | tr -d '`' | sed 's#/$##' | sort -u)
  done
fi

exit $BLOCKED
