#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_DIR="${SCRIPT_DIR}/.local-secrets"
PASSWORD_FILE="${SECRETS_DIR}/postgres_password"
DATABASE_URL_FILE="${SECRETS_DIR}/control_plane_database_url"

umask 077
mkdir -p "$SECRETS_DIR"

if [ ! -s "$PASSWORD_FILE" ]; then
  openssl rand -hex 32 > "$PASSWORD_FILE"
fi

if [ ! -s "$DATABASE_URL_FILE" ]; then
  password="$(tr -d '\r\n' < "$PASSWORD_FILE")"
  printf 'postgresql://kinerary_control_plane:%s@postgres:5432/kinerary_control_plane\n' "$password" > "$DATABASE_URL_FILE"
fi

chmod 600 "$PASSWORD_FILE" "$DATABASE_URL_FILE"
printf '%s\n' "Local secret files are ready in ${SECRETS_DIR}."
