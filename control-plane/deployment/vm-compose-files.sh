#!/usr/bin/env bash
# vm-compose-files.sh — SOURCED, never run: which compose files this VM's stack is made of.
#
#   . "$DIR/vm-compose-files.sh"
#   vm_compose_files_init "$DIR" "$PROVISIONING_ENV" "$VM_ENV" || die "..."
#   sudo docker compose "${VM_COMPOSE_FILES[@]}" --env-file ... up -d relay
#
# Sets VM_COMPOSE_FILES to `-f compose.vm.yml`, plus `-f compose.vm.whatsapp.yml` when
# WHATSAPP_BRIDGE_ENABLED is on in the env files (the last file to set it wins, as with
# compose's own --env-file order) AND this checkout carries the overlay.
#
# WHY A SHARED HELPER: the overlay gives the relay its two WhatsApp secrets. A relay
# recreated from compose.vm.yml alone has none, logs `relay.whatsapp_disabled` and
# serves Telegram as ever — nothing fails, WhatsApp is simply gone. So every command
# that can recreate the relay, or `up --remove-orphans` (which would remove the bridge as
# an orphan), takes its file set from here. vm-release.py computes the same answer in
# Python; tests/scripts/test_vm_whatsapp.py runs both against the same env files.
#
# The env files are root-only on the VM, so they are read through `sudo cat`.
# VM_COMPOSE_READ overrides that (the tests set it to `cat`).

# The accepted spellings of "on": the same four vm-release.py's truthy() accepts.
vm_compose_flag_on() {
  local v
  v="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/^[[:space:]"'"'"']*//' -e 's/[[:space:]"'"'"']*$//')"
  case "$v" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac
}

# vm_compose_env_value KEY FILE...  — KEY's value as compose reads it (the last file to set it
# wins, quotes dropped), on stdout; empty when no file sets it. Status 1 when a file that
# exists cannot be read: reading it as "unset" is the silent downgrade this helper prevents.
vm_compose_env_value() {
  local key="$1" file hit text value=""
  shift
  for file in "$@"; do
    [ -e "$file" ] || continue
    if ! text="$(${VM_COMPOSE_READ:-sudo cat} "$file")"; then
      printf 'vm-compose-files: cannot read %s\n' "$file" >&2
      return 1
    fi
    hit="$(printf '%s\n' "$text" | grep -E "^[[:space:]]*${key}=" | tail -n 1 || true)"
    [ -z "$hit" ] || value="${hit#*=}"
  done
  printf '%s' "$value" | sed -e 's/^[[:space:]"'"'"']*//' -e 's/[[:space:]"'"'"']*$//'
}

vm_compose_files_init() {
  local dir="$1" value
  shift
  VM_COMPOSE_FILES=(-f "$dir/compose.vm.yml")
  value="$(vm_compose_env_value WHATSAPP_BRIDGE_ENABLED "$@")" || return 1
  if vm_compose_flag_on "$value" && [ -f "$dir/compose.vm.whatsapp.yml" ]; then
    VM_COMPOSE_FILES=("${VM_COMPOSE_FILES[@]}" -f "$dir/compose.vm.whatsapp.yml")
  fi
  return 0
}
