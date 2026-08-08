#!/usr/bin/env bash
# scripts/hermes-pipeline/lib.sh — shared helpers. Sourced, never executed directly.

info()  { printf '\033[1;34m[info]\033[0m %s\n'  "$*"; }
ok()    { printf '\033[1;32m[ ok ]\033[0m %s\n'  "$*"; }
warn()  { printf '\033[1;33m[warn]\033[0m %s\n'  "$*" >&2; }
die()   { printf '\033[1;31m[fail]\033[0m %s\n'  "$*" >&2; exit 1; }

confirm() {
  # $1 = prompt. Returns 0 on yes. Never defaults to yes on empty input.
  local reply
  read -r -p "$1 [y/N] " reply
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

gen_key() {
  openssl rand -hex 32
}

# get_env_var <file> <KEY> — reads a KEY=value line from a dotenv-style file
# without sourcing it (sourcing an untrusted-ish .env as bash is how you get
# arbitrary code execution from a config file).
get_env_var() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  awk -F= -v k="$key" '$1==k { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

# set_env_var <file> <KEY> <value> — updates KEY in place if present, else
# appends. Creates the file if missing. Idempotent, safe to call repeatedly.
set_env_var() {
  local file="$1" key="$2" value="$3"
  touch "$file"
  if command grep -q "^${key}=" "$file" 2>/dev/null; then
    # BSD sed (macOS) needs an explicit (empty) backup extension for -i.
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}
