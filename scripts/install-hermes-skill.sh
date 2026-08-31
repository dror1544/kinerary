#!/usr/bin/env bash
# scripts/install-hermes-skill.sh
#
# Moves a skill between .agents/skills/ (source control) and a Hermes profile
# (where it runs). Traffic goes both ways, deliberately:
#
#   deploy   repo -> profile   ship a reviewed skill to an agent
#   capture  profile -> repo   bring back what the agent learned, to be committed
#
# Hermes accumulates insight in the profile — sharper scoring notes, a metric
# that turned out to matter, a trap worth warning about. That content is real
# and lives somewhere with no history, so a deploy that silently overwrote it
# would destroy the only copy. Deploy therefore REFUSES when the profile has
# diverged, and tells you to capture first.
#
#   scripts/install-hermes-skill.sh <skill> <profile>            # deploy, refuses on drift
#   scripts/install-hermes-skill.sh <skill> <profile> --check    # report drift, exit 1
#   scripts/install-hermes-skill.sh <skill> <profile> --capture  # profile -> repo, then commit
#   scripts/install-hermes-skill.sh <skill> <profile> --force    # deploy, discarding profile changes
set -euo pipefail

die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m[ ok ]\033[0m %s\n' "$*"; }
info() { printf '\033[1;34m[info]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }

SKILL_NAME="${1:-}"
PROFILE_NAME="${2:-}"
MODE="${3:-deploy}"
[ -n "$SKILL_NAME" ] && [ -n "$PROFILE_NAME" ] || die "usage: $0 <skill-name> <hermes-profile> [--check|--capture|--force]"

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SRC="$REPO_ROOT/.agents/skills/$SKILL_NAME"
PROFILE_SKILLS="${HERMES_HOME:-$HOME/.hermes}/profiles/$PROFILE_NAME/skills"
DEST="$PROFILE_SKILLS/travel/$SKILL_NAME"

in_sync() { diff -r "$SRC" "$DEST" >/dev/null 2>&1; }

# Refreshed on every deploy so the warning is present wherever the skill runs.
# Lives above the skill directory, which a deploy replaces wholesale.
write_profile_notice() {
  mkdir -p "$PROFILE_SKILLS"
  cat > "$PROFILE_SKILLS/README-kinerary-skills.md" <<'NOTICE'
# Kinerary skills in this profile — read before editing

Skills under this directory are **deployed** from the kinerary repo
(`.agents/skills/`). A deploy replaces the skill directory wholesale, so an
edit made only here is one `install-hermes-skill.sh` away from being gone, with
no history to recover it — `~/.hermes` is not version controlled.

**That does not mean local changes are worthless.** This is where the agent is
actually working, so it is where insight shows up first: a scoring note that
turned out to be wrong, a metric worth adding, a failure mode worth warning the
next agent about, anything learned that other agents should reuse.

So the rule is capture-then-deploy, never deploy-over:

```bash
# 1. bring what this profile learned back into source control
scripts/install-hermes-skill.sh <skill> <profile> --capture

# 2. review the diff and commit it in the repo
git -C <kinerary-repo> diff .agents/skills/<skill>

# 3. now deploy
scripts/install-hermes-skill.sh <skill> <profile>
```

Deploy refuses when this profile has diverged, so the ordering is enforced
rather than remembered. `--force` overrides it and discards local changes; only
use it when you have confirmed there is nothing here worth keeping.

Anything durable — reusable prompts, deployment takeaways, insights meant for
other agents — belongs in the repo skill, not only here.
NOTICE
}

[ -d "$SRC" ] || die "no such skill in the repo: $SRC"
[ -f "$SRC/SKILL.md" ] || die "$SKILL_NAME has no SKILL.md"

case "$MODE" in
  --check)
    [ -d "$DEST" ] || die "not installed in profile '$PROFILE_NAME': $DEST"
    if in_sync; then ok "$SKILL_NAME is in sync with $PROFILE_NAME"; exit 0; fi
    printf '\033[1;31m[fail]\033[0m %s\n' "$SKILL_NAME has diverged from $PROFILE_NAME:" >&2
    diff -r "$SRC" "$DEST" >&2 || true
    printf '\n%s\n' "Capture it before deploying:  $0 $SKILL_NAME $PROFILE_NAME --capture" >&2
    exit 1
    ;;

  --capture)
    [ -d "$DEST" ] || die "nothing to capture; not installed in '$PROFILE_NAME'"
    if in_sync; then ok "$SKILL_NAME already matches the repo; nothing to capture"; exit 0; fi
    info "capturing $DEST -> $SRC"
    rm -rf "$SRC"
    cp -R "$DEST" "$SRC"
    # The notice is a deploy artifact, not skill content; never capture it back.
    rm -f "$SRC/README-kinerary-skills.md"
    ok "captured into .agents/skills/$SKILL_NAME — review and commit:"
    printf '  git -C %s diff .agents/skills/%s\n' "$REPO_ROOT" "$SKILL_NAME"
    ;;

  deploy|--force)
    if [ -d "$DEST" ] && ! in_sync && [ "$MODE" != "--force" ]; then
      warn "$PROFILE_NAME has diverged from the repo copy of $SKILL_NAME:"
      diff -r "$SRC" "$DEST" >&2 || true
      die "refusing to overwrite. Capture it first:
    $0 $SKILL_NAME $PROFILE_NAME --capture
  or discard those changes deliberately:
    $0 $SKILL_NAME $PROFILE_NAME --force"
    fi
    [ "$MODE" = "--force" ] && [ -d "$DEST" ] && ! in_sync && warn "discarding profile changes (--force)"
    info "skill:   $SRC"
    info "profile: $DEST"
    mkdir -p "$(dirname "$DEST")"
    # Replace rather than merge: a file deleted from the repo skill must not
    # survive in the profile as an orphan a later reader mistakes for current.
    rm -rf "$DEST"
    cp -R "$SRC" "$DEST"
    write_profile_notice
    ok "deployed $SKILL_NAME into profile $PROFILE_NAME"
    ;;

  *) die "unknown mode '$MODE' (expected --check, --capture or --force)" ;;
esac
