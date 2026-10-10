#!/usr/bin/env bash
# scripts/create-monitor-db-role.sh — give the fleet monitor a database login
# that can read what its MCP reads and nothing else, and write that login's
# connection URL to a private file.
#
# WHY. The monitor keeps its database URL in its Hermes profile, and a Hermes
# host can run every profile — traveller-facing companions included — in one
# container, as one uid, over one data directory. So the URL is readable by
# more than the monitor, and it must not carry the control plane's own
# read-write login. The role, its attributes and its column list are
# control-plane/deployment/monitor-db-role.sql; this script applies that file,
# sets the password, and produces the URL.
#
# GENERIC ON PURPOSE, like scripts/bootstrap-fleet-monitor.sh: it names no
# host, container, path or database of any deployment and REFUSES when a value
# is unset rather than defaulting to somebody's machine. The deployment's own
# wrapper supplies them.
#
#   PSQL_CMD='<command that runs psql as a superuser on the control-plane database>' \
#   MONITOR_DB_URL_FILE=/path/to/fleet_monitor_database_url MONITOR_DB_URL_OWNER=uid:gid \
#   MONITOR_DB_HOST=<as the monitor reaches it> MONITOR_DB_PORT=<port> MONITOR_DB_NAME=<db> \
#   scripts/create-monitor-db-role.sh [--check | --rotate]
#
# | variable | required | what |
# |---|---|---|
# | `PSQL_CMD`              | yes | runs psql as a SUPERUSER against the control-plane database and reads SQL on stdin; nothing is appended to it (e.g. a `docker exec -i <db container> psql -U <owner> -d <db>` wrapper) |
# | `MONITOR_DB_URL_FILE`   | yes | where the URL is written; its directory must exist |
# | `MONITOR_DB_URL_OWNER`  | yes | `user[:group]` or `uid[:gid]` that owns the file (mode 0600) |
# | `MONITOR_DB_HOST`       | yes | the database host AS THE MONITOR REACHES IT (goes into the URL) |
# | `MONITOR_DB_PORT`       | yes | ... and its port |
# | `MONITOR_DB_NAME`       | yes | the control-plane database name |
# | `MONITOR_DB_ROLE`       | no  | role name (default kinerary_fleet_ro) |
# | `MONITOR_DB_CONNECTION_LIMIT` | no | default 20 (see monitor-db-role.sql) |
# | `MONITOR_DB_URL_QUERY`  | no  | appended as `?<query>`, e.g. `sslmode=require` |
#
# Modes:
#   (none)    create the role or correct it; set a password only when the role
#             is new, the URL file is missing, or the file's password is not
#             the role's. Otherwise the password and the file are untouched,
#             so a second run changes nothing.
#   --rotate  always a new password and a new file.
#   --check   verify the role, its grants and the file, prove a write is
#             refused, and change nothing. Exit 1 on any difference.
#
# THE PASSWORD never appears in output, on any command line, or on the wire:
# 32 random bytes from `openssl rand`, turned into a SCRAM-SHA-256 verifier
# here (python3, fed over stdin), and only the verifier is sent to PostgreSQL —
# so neither a server log nor a failed statement can hold the password. The
# URL is written to a temporary file beside the target (umask 077, owner set)
# BEFORE the database changes, and moved into place after they commit; a failed
# run leaves the old file and the old password both in force.
#
# Bash 3.2 (macOS) and 5 compatible.
set -euo pipefail

ROLE_DEFAULT=kinerary_fleet_ro
LIMIT_DEFAULT=20
SQL_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/control-plane/deployment/monitor-db-role.sql"

die()  { printf '[fail] %s\n' "$*" >&2; exit 1; }
ok()   { printf '[ ok ] %s\n' "$*"; }
bad()  { printf '[FAIL] %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
usage() { echo "usage: $0 [--check | --rotate]" >&2; exit 2; }

MODE=apply
while [ $# -gt 0 ]; do
  case "$1" in
    --check)  [ "$MODE" = apply ] || usage; MODE=check ;;
    --rotate) [ "$MODE" = apply ] || usage; MODE=rotate ;;
    -h|--help) sed -n '2,52p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) usage ;;
  esac
  shift
done

# ── configuration: every value from the environment, checked before anything runs ──
require() {  # require <NAME> <what it is>
  local value="${!1:-}"
  [ -n "$value" ] || die "$1 is required — $2. This script names no deployment and guesses none."
}
shape() {  # shape <NAME> <regex> <what is allowed>
  local value="${!1:-}" re="$2"
  [[ $value =~ $re ]] || die "$1 is not usable: $3."
}
require PSQL_CMD "a command that runs psql as a superuser on the control-plane database, reading SQL on stdin"
require MONITOR_DB_URL_FILE "where the monitor's connection URL is written"
require MONITOR_DB_URL_OWNER "the user[:group] that owns the URL file"
require MONITOR_DB_HOST "the database host as the monitor reaches it"
require MONITOR_DB_PORT "the database port as the monitor reaches it"
require MONITOR_DB_NAME "the control-plane database name"

ROLE="${MONITOR_DB_ROLE:-$ROLE_DEFAULT}"
MONITOR_DB_ROLE="$ROLE"
LIMIT="${MONITOR_DB_CONNECTION_LIMIT:-$LIMIT_DEFAULT}"
MONITOR_DB_CONNECTION_LIMIT="$LIMIT"
QUERY="${MONITOR_DB_URL_QUERY:-}"
shape MONITOR_DB_ROLE '^[a-z_][a-z0-9_]{0,62}$' "a plain lower-case identifier"
shape MONITOR_DB_CONNECTION_LIMIT '^[0-9]{1,4}$' "a number"
shape MONITOR_DB_URL_OWNER '^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)?$' "user[:group] or uid[:gid]"
shape MONITOR_DB_HOST '^([A-Za-z0-9_.-]+|\[[0-9A-Fa-f:.]+\])$' "a host name or address (IPv6 in brackets)"
shape MONITOR_DB_PORT '^[0-9]{1,5}$' "a port number"
shape MONITOR_DB_NAME '^[A-Za-z0-9_.-]+$' "letters, digits, _ . -"
[ -z "$QUERY" ] || shape MONITOR_DB_URL_QUERY '^[A-Za-z0-9_.=&-]+$' "key=value pairs joined by &"

URL_FILE="$MONITOR_DB_URL_FILE"
URL_DIR="$(dirname "$URL_FILE")"
URL_BASE="$(basename "$URL_FILE")"
OWNER="$MONITOR_DB_URL_OWNER"
[ -d "$URL_DIR" ] || die "MONITOR_DB_URL_FILE's directory $URL_DIR does not exist — create it (private) first; this script does not guess where secrets live."
[ ! -L "$URL_FILE" ] || die "MONITOR_DB_URL_FILE $URL_FILE is a symlink; refusing to write a credential through it."
[ ! -e "$URL_FILE" ] || [ -f "$URL_FILE" ] || die "MONITOR_DB_URL_FILE $URL_FILE exists and is not a regular file."
[ -f "$SQL_FILE" ] || die "no monitor-db-role.sql beside this script ($SQL_FILE)."

command -v python3 >/dev/null 2>&1 || die "python3 is required (the password verifier is computed client-side)."
[ "$MODE" = check ] || command -v openssl >/dev/null 2>&1 || die "openssl is required (openssl rand)."

# PSQL_CMD split into words, without glob expansion.
read -r -a PSQL <<< "$PSQL_CMD"

umask 077
WORK="$(mktemp -d)"
TMP_URL=""
cleanup() {
  [ -z "$TMP_URL" ] || rm -f "$TMP_URL"
  rm -rf "$WORK"
}
trap cleanup EXIT

# One program for the two things that touch the password: making a verifier,
# and asking whether a URL's password is the one the role has. Both read the
# secret on stdin and print no secret.
PY=""
read -r -d '' PY <<'PYEOF' || true
import base64, hashlib, hmac, os, re, sys, urllib.parse

def keys(password, salt, iterations):
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    client = hmac.new(salted, b"Client Key", "sha256").digest()
    server = hmac.new(salted, b"Server Key", "sha256").digest()
    return hashlib.sha256(client).digest(), server

b64 = lambda raw: base64.b64encode(raw).decode()
mode = sys.argv[1]
if mode == "verifier":
    password = sys.stdin.readline().rstrip("\n")
    if not re.fullmatch(r"[0-9a-f]{64}", password):
        sys.exit("refusing: the generated password is not 32 random bytes of hex")
    salt, iterations = os.urandom(16), 4096
    stored, server = keys(password, salt, iterations)
    print("SCRAM-SHA-256$%d:%s$%s:%s" % (iterations, b64(salt), b64(stored), b64(server)))
elif mode == "compare":
    role, host, port, db, query = sys.argv[2:7]
    verifier = sys.stdin.readline().rstrip("\n")
    url = sys.stdin.readline().strip()
    try:
        u = urllib.parse.urlsplit(url)
        url_port = u.port
    except ValueError:
        print("the URL file does not hold a parseable URL"); sys.exit(0)
    if u.scheme not in ("postgres", "postgresql"):
        print("the URL file does not hold a postgresql:// URL"); sys.exit(0)
    if urllib.parse.unquote(u.username or "") != role:
        print("the URL file names another user"); sys.exit(0)
    if (u.hostname or "").lower() != host.strip("[]").lower() or str(url_port) != port:
        print("the URL file names another host or port"); sys.exit(0)
    if u.path != "/" + db or u.query != query:
        print("the URL file names another database or options"); sys.exit(0)
    m = re.fullmatch(r"SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)", verifier)
    if not m:
        print("the role has no SCRAM password to match the URL file's password against"); sys.exit(0)
    stored, server = keys(urllib.parse.unquote(u.password or ""), base64.b64decode(m.group(2)), int(m.group(1)))
    same = hmac.compare_digest(b64(stored), m.group(3)) and hmac.compare_digest(b64(server), m.group(4))
    print("match" if same else "the URL file's password is not the role's password")
PYEOF

redact() { sed -e 's/SCRAM-SHA-256\$[^ '"'"']*/SCRAM-SHA-256$<redacted>/g' -e '/^CONTEXT:/d' -e '/^PL\/pgSQL function/d'; }

# The role's stored verifier, or no-role / no-password. Never printed.
stored_verifier() {
  {
    printf '%s\n' '\set QUIET on' '\set ON_ERROR_STOP on' '\pset tuples_only on' '\pset format unaligned'
    printf '%s %s\n' '\set role' "$ROLE"
    printf '%s\n' "SELECT coalesce((SELECT coalesce(rolpassword, 'no-password') FROM pg_authid WHERE rolname = :'role'), 'no-role');"
  } | "${PSQL[@]}" 2>"$WORK/state.err" || {
    redact < "$WORK/state.err" >&2
    die "could not read the role through PSQL_CMD — it must run psql as a superuser (pg_authid is read to compare passwords)."
  }
}

# "match", or why not. Reads the URL file; prints no secret.
compare_file() {  # compare_file <stored verifier>
  { printf '%s\n' "$1"; cat "$URL_FILE"; } \
    | python3 -c "$PY" compare "$ROLE" "$MONITOR_DB_HOST" "$MONITOR_DB_PORT" "$MONITOR_DB_NAME" "$QUERY"
}

# "mode uid:gid user:group" — GNU stat, then BSD.
file_facts() {
  stat -c '%a %u:%g %U:%G' "$1" 2>/dev/null || stat -f '%Lp %u:%g %Su:%Sg' "$1"
}
owner_matches() {  # owner_matches <uid:gid> <user:group>
  case "$OWNER" in
    *:*) [ "$OWNER" = "$1" ] || [ "$OWNER" = "$2" ] ;;
    *)   [ "$OWNER" = "${1%%:*}" ] || [ "$OWNER" = "${2%%:*}" ] ;;
  esac
}

# Stream monitor-db-role.sql, with its variables, into PSQL_CMD.
run_sql() {  # run_sql <check_only: true|false> [verifier]
  {
    printf '%s\n' '\set QUIET on'
    printf '%s %s\n' '\set role' "$ROLE"
    printf '%s %s\n' '\set connection_limit' "$LIMIT"
    printf '%s %s\n' '\set check_only' "$1"
    [ -z "${2:-}" ] || printf "%s '%s'\n" '\set verifier' "$2"
    cat "$SQL_FILE"
  } | "${PSQL[@]}" >"$WORK/sql.out" 2>&1
}
# The database's own account of what it verified, from the NOTICEs the SQL raises.
report_notices() {
  sed -n -e 's/^NOTICE:  fleet_ro verified: /verified: /p' -e 's/^NOTICE:  fleet_ro probe: /probe: /p' "$WORK/sql.out" \
    | while IFS= read -r line; do ok "$line"; done
}

STORED="$(stored_verifier)"

# ── --check ─────────────────────────────────────────────────────────────────
if [ "$MODE" = check ]; then
  PROBLEMS=0
  if [ "$STORED" = no-role ]; then
    bad "role $ROLE does not exist — run this script without --check to create it"
  fi
  if [ ! -f "$URL_FILE" ]; then
    bad "no URL file at $URL_FILE"
  else
    read -r fmode fids fnames <<< "$(file_facts "$URL_FILE")"
    [ "$fmode" = 600 ] && ok "URL file mode 600" || bad "URL file $URL_FILE has mode $fmode, not 600"
    if owner_matches "$fids" "$fnames"; then ok "URL file owned by $OWNER"; else bad "URL file is owned by $fnames ($fids), not $OWNER"; fi
    if [ "$STORED" != no-role ]; then
      verdict="$(compare_file "$STORED")"
      if [ "$verdict" = match ]; then ok "URL file's user, address and password match role $ROLE"
      else bad "$verdict — rerun this script without --check to replace it"; fi
    fi
  fi
  if [ "$STORED" != no-role ]; then
    if run_sql true; then
      report_notices
    else
      redact < "$WORK/sql.out"
      bad "role $ROLE does not match monitor-db-role.sql (above) — rerun this script without --check to correct it"
    fi
  fi
  [ "$PROBLEMS" -eq 0 ] || die "$PROBLEMS problem(s); nothing was changed."
  ok "role $ROLE is as monitor-db-role.sql describes; nothing was changed"
  exit 0
fi

# ── apply / --rotate ────────────────────────────────────────────────────────
WHY=""
if [ "$MODE" = rotate ]; then
  WHY="password rotated (--rotate)"
elif [ "$STORED" = no-role ]; then
  WHY="created"
elif [ ! -f "$URL_FILE" ]; then
  WHY="password rotated: there was no URL file to keep"
else
  verdict="$(compare_file "$STORED")"
  [ "$verdict" = match ] || WHY="password rotated: $verdict"
fi

VERIFIER=""
if [ -n "$WHY" ]; then
  PASSWORD="$(openssl rand -hex 32)"
  VERIFIER="$(printf '%s\n' "$PASSWORD" | python3 -c "$PY" verifier)" || die "could not compute the password verifier."
  # Prepared, private and owned before the database changes; moved after.
  TMP_URL="$(mktemp "$URL_DIR/.$URL_BASE.XXXXXX")"
  printf 'postgresql://%s:%s@%s:%s/%s%s\n' "$ROLE" "$PASSWORD" "$MONITOR_DB_HOST" "$MONITOR_DB_PORT" \
    "$MONITOR_DB_NAME" "${QUERY:+?$QUERY}" > "$TMP_URL"
  PASSWORD=""
  chmod 600 "$TMP_URL"
  chown "$OWNER" "$TMP_URL" || die "could not give the URL file to $OWNER (run as root, or as that user)."
fi

if ! run_sql false "$VERIFIER"; then
  redact < "$WORK/sql.out" >&2
  die "monitor-db-role.sql did not apply; the database was rolled back and $URL_FILE is untouched."
fi

if [ -n "$TMP_URL" ]; then
  mv -f "$TMP_URL" "$URL_FILE" \
    || die "the role's password changed but $URL_FILE could not be replaced — rerun this script: it will set a new password and write the file."
  TMP_URL=""
  ok "role $ROLE: $WHY"
  ok "connection URL written to $URL_FILE (mode 600, owner $OWNER) — never printed"
else
  ok "role $ROLE: grants and attributes re-applied; password unchanged"
  ok "connection URL file $URL_FILE unchanged"
fi
report_notices
