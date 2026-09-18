#!/usr/bin/env bash
# proxmox-snapshot-runner.sh — take, list and delete release snapshots of a VM,
# run ON the Proxmox host, where recovery from a stuck snapshot is possible.
#
# It is never installed on the host. The caller streams it over ssh:
#
#   ssh <user>@<proxmox> env REFUSE_STORAGE='…' bash -s -- preflight <vmid>  < proxmox-snapshot-runner.sh
#   ssh <user>@<proxmox> bash -s -- list <vmid>                             < proxmox-snapshot-runner.sh
#   ssh <user>@<proxmox> bash -s -- create <vmid> pre-3a9f1c2-202609161830 "aa61f6e -> 3a9f1c2"
#   ssh <user>@<proxmox> bash -s -- delete <vmid> pre-aa61f6e-202609011200
#
# The host, user, VMID and REFUSE_STORAGE come from the caller, which reads them
# from the private kinerary-deploy repo (control-plane.env, provisioning.env):
# the kinerary repo is public and holds no infrastructure facts.
#
# Output is key=value lines only, so the caller parses rather than guesses:
#   check.<name>=pass|fail <detail>     one per precondition
#   snapshot=<name>\t<snaptime>\t<description>
#   recovery.<step>=<what happened>
#   result=ok|refused|failed <detail>
#
# WHY IT RUNS HERE AND NOT IN THE GUEST. A snapshot of a running VM with the
# guest agent enabled freezes the guest's filesystems first
# (PVE::QemuConfig::__snapshot_check_freeze_needed). If the freeze or the
# snapshot stalls, a tool inside that guest is blocked on its own frozen disk
# and can never issue the thaw. The only place a stuck snapshot can be undone
# from is the host — so the timeout, the thaw, the unlock and the cleanup of a
# half-made snapshot all live in this one script, in one ssh call.
#
# WHY SO MANY PRECONDITIONS. On 2026-09-13 a container dump into an NFS share
# served by a VM on the same host froze that VM, every NFS mount and the
# control-plane VM until the host was rebooted. And a thin pool is shared by
# every guest on it: exhausting its data or its (small) metadata volume would
# stall all of them. So nothing here touches NFS,
# nothing here uses vzdump or vmstate, and a snapshot is refused outright unless
# the pool has room for the worst case.
#
# Bash 3.2 compatible on purpose: the test suite runs it on a Mac against fake
# qm/pvesh/lvs binaries.
set -uo pipefail

MODE="${1:-}"; VMID="${2:-}"
SNAP_NAME="${3:-}"; SNAP_DESC="${4:-}"

POOL_DATA_MAX="${POOL_DATA_MAX:-70}"          # refuse at or above, percent
POOL_META_MAX="${POOL_META_MAX:-50}"          # refuse at or above, percent
VG_FREE_MIN_G="${VG_FREE_MIN_G:-10}"          # metadata autoextend headroom
WORST_CASE_MARGIN_G="${WORST_CASE_MARGIN_G:-50}"
MAX_EXISTING_PRE="${MAX_EXISTING_PRE:-1}"     # so at most 2 exist after a create
SNAPSHOT_TIMEOUT="${SNAPSHOT_TIMEOUT:-120}"
DELETE_TIMEOUT="${DELETE_TIMEOUT:-180}"
AGENT_TIMEOUT="${AGENT_TIMEOUT:-10}"
TASK_WAIT_SECONDS="${TASK_WAIT_SECONDS:-90}"
RECOVERY_POLL="${RECOVERY_POLL:-5}"
STORAGE_CFG="${STORAGE_CFG:-/etc/pve/storage.cfg}"
IGNORE_SNAPSHOTS="${IGNORE_SNAPSHOTS:-}"
REFUSE_STORAGE="${REFUSE_STORAGE:-}"

# Tasks that take a guest lock or hammer shared storage. Any of them running
# anywhere on the node is a reason not to start a snapshot now.
BUSY_TASK_TYPES="vzdump qmsnapshot qmdelsnapshot qmrollback qmclone qmmove qmigrate vzsnapshot vzdelsnapshot vzrollback vzclone vzmigrate move_volume"

FAILED=0
say() { printf '%s\n' "$*"; }
pass() { say "check.$1=pass ${2:-}"; }
fail() { say "check.$1=fail ${2:-}"; FAILED=$((FAILED + 1)); }

valid_vmid() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
# Proxmox's own snapshot-name rule, narrowed to the prefix this tooling owns:
# create and delete can never touch a snapshot a person made by hand.
valid_release_snap() {
  case "$1" in pre-*) ;; *) return 1 ;; esac
  printf '%s' "$1" | grep -Eq '^[A-Za-z][A-Za-z0-9_-]{1,39}$'
}

node_name() { hostname 2>/dev/null | cut -d. -f1; }

# A QUERY THAT FAILED IS NOT AN EMPTY ANSWER. pvesh can fail (the API down, a
# renamed node, no permission) and its JSON can arrive truncated; reading either
# as "no snapshots" or "no tasks" is how a preflight passes while a vzdump runs,
# and how the pool's worst case gets counted as zero snapshots. These two
# helpers exit 3 when they could not read, and every caller turns that into a
# failed precondition or a failed run — never into "nothing found".
EXIT_UNREADABLE=3

# name<TAB>snaptime<TAB>description for every snapshot except "current". 3 = unreadable.
list_snapshots() {
  local json
  json="$(pvesh get "/nodes/$(node_name)/qemu/$VMID/snapshot" --output-format json 2>/dev/null)" || return $EXIT_UNREADABLE
  printf '%s' "$json" | perl -MJSON::PP -e '
        local $/; my $in = <STDIN>;
        my $list = eval { decode_json($in) };
        exit 3 unless ref $list eq "ARRAY";
        for my $s (@$list) {
          next if ($s->{name} // "") eq "current";
          my $d = $s->{description} // ""; $d =~ s/[\t\n]/ /g;
          printf "%s\t%s\t%s\n", $s->{name}, ($s->{snaptime} // 0), $d;
        }'
}

# Release (pre-*) snapshot names in the list it is given, minus IGNORE_SNAPSHOTS.
# A function rather than inline: bash 3.2 cannot parse a case pattern's ")"
# inside "$( … )".
release_snapshots_kept() {
  local n
  printf '%s\n' "$1" | cut -f1 | grep '^pre-' | while read -r n; do
    case " $IGNORE_SNAPSHOTS " in *" $n "*) ;; *) printf '%s\n' "$n" ;; esac
  done
  return 0
}

active_task_types() {  # type<TAB>id<TAB>upid per active task. 3 = unreadable.
  local json
  json="$(pvesh get "/nodes/$(node_name)/tasks" --source active --output-format json 2>/dev/null)" || return $EXIT_UNREADABLE
  printf '%s' "$json" | perl -MJSON::PP -e '
        local $/; my $in = <STDIN>;
        my $list = eval { decode_json($in) };
        exit 3 unless ref $list eq "ARRAY";
        for my $t (@$list) { printf "%s\t%s\t%s\n", ($t->{type} // ""), ($t->{id} // ""), ($t->{upid} // ""); }'
}

# "type:id" per busy task, optionally only those on this VM. 3 = unreadable.
busy_tasks() {
  local only_vm="${1:-}" tasks type id upid
  tasks="$(active_task_types)" || return $EXIT_UNREADABLE
  printf '%s\n' "$tasks" | while IFS="$(printf '\t')" read -r type id upid; do
    case " $BUSY_TASK_TYPES " in *" $type "*) ;; *) continue ;; esac
    if [ -n "$only_vm" ] && [ "$id" != "$only_vm" ]; then continue; fi
    printf '%s:%s\n' "$type" "$id"
  done
}

vm_config() { qm config "$VMID" 2>/dev/null; }

# storage:volume<TAB>size for every disk the snapshot will include.
vm_volumes() {
  vm_config | grep -E '^(scsi|sata|ide|virtio|efidisk|tpmstate)[0-9]+: ' | while IFS= read -r line; do
    value="${line#*: }"
    volume="${value%%,*}"
    case "$volume" in none|cdrom) continue ;; esac
    # An installer ISO is read-only and not snapshotted; a cloud-init drive is.
    case "$value" in *media=cdrom*) case "$volume" in *cloudinit*) ;; *) continue ;; esac ;; esac
    size="$(printf '%s' "$value" | grep -oE 'size=[0-9.]+[KMGT]?' | head -1 | cut -d= -f2)"
    printf '%s\t%s\n' "$volume" "${size:-0}"
  done
}

to_gib() {  # 80G -> 80, 512M -> 0.5, 1T -> 1024
  printf '%s' "$1" | awk '{
    n = $0 + 0; u = substr($0, length($0), 1);
    if (u == "T") n = n * 1024; else if (u == "M") n = n / 1024; else if (u == "K") n = n / 1048576;
    printf "%.2f", n }'
}

storage_type() { pvesm status 2>/dev/null | awk -v s="$1" '$1 == s { print $2 }'; }

# vgname/thinpool for an lvmthin storage id, read from storage.cfg.
lvmthin_pool() {
  awk -v s="$1" '
    /^[a-z]+: / { inblock = ($1 == "lvmthin:" && $2 == s) ; next }
    inblock && $1 == "vgname" { vg = $2 }
    inblock && $1 == "thinpool" { pool = $2 }
    END { if (vg != "" && pool != "") printf "%s/%s\n", vg, pool }' "$STORAGE_CFG"
}

preflight() {
  valid_vmid "$VMID" || { fail vmid "not a vmid: '$VMID'"; return; }
  if ! vm_config >/dev/null || [ -z "$(vm_config)" ]; then fail vm "qm config $VMID failed"; return; fi
  pass vm "$VMID exists"

  local status; status="$(qm status "$VMID" 2>/dev/null | awk '{print $2}')"
  say "vm.status=${status:-unknown}"

  # Every disk on lvmthin: a snapshot is then a thin volume in that pool and
  # nothing else. REFUSE_STORAGE names storage ids refused whatever their type
  # (belt and braces for the deployment's network shares).
  local volumes storages bad="" total_g=0 pools=""
  volumes="$(vm_volumes)"
  [ -n "$volumes" ] || { fail disks "no disks found in qm config"; return; }
  storages="$(printf '%s\n' "$volumes" | cut -f1 | cut -d: -f1 | sort -u)"
  for s in $storages; do
    t="$(storage_type "$s")"
    case " $REFUSE_STORAGE " in *" $s "*) bad="$bad $s(refused-by-config)"; continue ;; esac
    if [ "$t" != "lvmthin" ]; then bad="$bad $s(${t:-unknown})"; continue; fi
    p="$(lvmthin_pool "$s")"; [ -n "$p" ] || { bad="$bad $s(no-pool-in-storage.cfg)"; continue; }
    case " $pools " in *" $p "*) ;; *) pools="$pools $p" ;; esac
  done
  while IFS="$(printf '\t')" read -r vol size; do
    total_g="$(awk -v a="$total_g" -v b="$(to_gib "$size")" 'BEGIN { printf "%.2f", a + b }')"
  done <<EOF
$volumes
EOF
  if [ -n "$bad" ]; then fail storage "disks not on lvmthin:$bad"; else pass storage "all disks on lvmthin:$(printf '%s' "$storages" | tr '\n' ' ')"; fi
  say "vm.disk_total_g=$total_g"

  local lock; lock="$(vm_config | awk -F': ' '$1 == "lock" { print $2 }')"
  if [ -n "$lock" ]; then fail lock "VM $VMID is locked ($lock)"; else pass lock "not locked"; fi

  local busy busy_rc=0
  busy="$(busy_tasks)" || busy_rc=$?
  busy="$(printf '%s' "$busy" | tr '\n' ' ')"
  if [ "$busy_rc" -ne 0 ]; then
    fail tasks "could not read the node's active tasks — a vzdump, snapshot or clone may be running right now"
  elif [ -n "${busy// /}" ]; then
    fail tasks "busy tasks on the node: $busy"
  else
    pass tasks "no snapshot/backup/clone/migrate task running"
  fi

  if [ "$status" = "running" ]; then
    if timeout "$AGENT_TIMEOUT" qm agent "$VMID" ping >/dev/null 2>&1; then
      pass agent "guest agent answers"
      local fz; fz="$(timeout "$AGENT_TIMEOUT" qm guest cmd "$VMID" fsfreeze-status 2>/dev/null | tr -d '"[:space:]')"
      if [ "$fz" = "thawed" ]; then pass freeze "filesystems thawed"; else fail freeze "fsfreeze-status is '${fz:-no answer}'"; fi
    else
      # Proxmox would then skip the freeze and take a crash-consistent snapshot,
      # but an agent that does not answer a ping is also the agent most likely
      # to hang a freeze. Refuse rather than find out.
      fail agent "guest agent did not answer within ${AGENT_TIMEOUT}s"
    fi
  else
    pass agent "VM not running; no guest freeze will happen"
  fi

  local snaps snaps_rc=0 existing count names="" hand_made all_count=""
  snaps="$(list_snapshots)" || snaps_rc=$?
  if [ "$snaps_rc" -ne 0 ]; then
    # Unknown, not zero: the worst case below is a count of snapshots.
    fail snapshots "could not read VM $VMID's snapshots — how much the pool must be able to absorb cannot be judged"
    say "snapshots.release_count=unknown"
    say "snapshots.total_count=unknown"
  else
    # IGNORE_SNAPSHOTS: release snapshots the caller deletes before it creates,
    # so a dry run and the guard step judge the state the create will really see.
    existing="$(release_snapshots_kept "$snaps")"
    count="$(printf '%s' "$existing" | grep -c . || true)"
    names="$(printf '%s' "$existing" | tr '\n' ' ')"
    # Hand-made snapshots are never created or deleted here, but they diverge
    # from the disk like any other, so they count toward the worst case below.
    hand_made="$(printf '%s' "$snaps" | cut -f1 | grep -v '^pre-' | grep -c . || true)"
    all_count=$(( count + hand_made ))
    say "snapshots.release_count=$count"
    say "snapshots.total_count=$all_count"
    if [ "$count" -gt "$MAX_EXISTING_PRE" ]; then
      fail snapshots "$count release snapshot(s) exist ($names) — at most $MAX_EXISTING_PRE before taking another; delete the oldest first"
    else
      pass snapshots "$count existing release snapshot(s)${names:+: $names}"
    fi
  fi

  local vg pool data meta size vgfree free_g need_g
  for vgpool in $pools; do
    vg="${vgpool%%/*}"; pool="${vgpool#*/}"
    read -r data meta size <<EOF
$(lvs --noheadings --nosuffix --units g -o data_percent,metadata_percent,lv_size "$vg/$pool" 2>/dev/null)
EOF
    vgfree="$(vgs --noheadings --nosuffix --units g -o vg_free "$vg" 2>/dev/null | tr -d ' ')"
    if [ -z "${data:-}" ] || [ -z "${meta:-}" ] || [ -z "${size:-}" ]; then fail pool "could not read $vg/$pool with lvs"; continue; fi
    say "pool.$vg/$pool=data ${data}% meta ${meta}% size ${size}G vg_free ${vgfree:-?}G"
    if awk -v d="$data" -v m="$POOL_DATA_MAX" 'BEGIN { exit !(d + 0 >= m + 0) }'; then fail pool_data "$vg/$pool data ${data}% >= ${POOL_DATA_MAX}%"; else pass pool_data "$vg/$pool data ${data}% < ${POOL_DATA_MAX}%"; fi
    if awk -v d="$meta" -v m="$POOL_META_MAX" 'BEGIN { exit !(d + 0 >= m + 0) }'; then fail pool_meta "$vg/$pool metadata ${meta}% >= ${POOL_META_MAX}%"; else pass pool_meta "$vg/$pool metadata ${meta}% < ${POOL_META_MAX}%"; fi
    if awk -v f="${vgfree:-0}" -v m="$VG_FREE_MIN_G" 'BEGIN { exit !(f + 0 < m + 0) }'; then fail vg_free "$vg has ${vgfree:-0}G free, need ${VG_FREE_MIN_G}G for metadata autoextend"; else pass vg_free "$vg has ${vgfree}G free"; fi
    # Worst case: every snapshot that will exist — release and hand-made — and
    # the new one each diverge from the disk completely. Refused unless the
    # pool could absorb that.
    free_g="$(awk -v s="$size" -v d="$data" 'BEGIN { printf "%.0f", s * (1 - d / 100) }')"
    if [ -z "$all_count" ]; then
      fail worst_case "$vg/$pool has ${free_g}G free, but the snapshots to count against it could not be read"
      continue
    fi
    need_g="$(awk -v n="$all_count" -v t="$total_g" -v m="$WORST_CASE_MARGIN_G" 'BEGIN { printf "%.0f", (n + 1) * t + m }')"
    if [ "$free_g" -lt "$need_g" ]; then fail worst_case "$vg/$pool has ${free_g}G free, worst case needs ${need_g}G"; else pass worst_case "$vg/$pool has ${free_g}G free, worst case needs ${need_g}G"; fi
  done
}

# 0 = listed, 1 = not listed, 3 = the list could not be read. "Not listed"
# decides whether a snapshot was taken and whether a delete is already done, so
# an unreadable list must never pass for it.
snapshot_listed() {
  local snaps
  snaps="$(list_snapshots)" || return $EXIT_UNREADABLE
  printf '%s' "$snaps" | cut -f1 | grep -qx "$1"
}

# After a snapshot or delete that failed or timed out: never leave the guest
# frozen, never leave the VM locked, never leave a half-made snapshot.
recover() {
  local name="$1" remove_partial="$2" deadline busy fz i

  # A killed `qm snapshot` may leave its worker task running. Unlocking under a
  # running task corrupts its bookkeeping, so wait for it first. A deadline,
  # not a counter: the poll interval may be fractional, and bash arithmetic on
  # "0.1" aborts the script in the middle of the one path that must finish.
  deadline=$(( $(date +%s) + TASK_WAIT_SECONDS ))
  while :; do
    # Unreadable counts as busy: unlocking under a running task corrupts its
    # bookkeeping, and "I could not look" is not "there is none".
    busy="$(busy_tasks "$VMID")" || busy="unknown (the node's task list could not be read)"
    busy="$(printf '%s' "$busy" | tr '\n' ' ')"
    [ -z "${busy// /}" ] && break
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep "$RECOVERY_POLL"
  done
  if [ -n "${busy// /}" ]; then say "recovery.task=still running after ${TASK_WAIT_SECONDS}s: $busy"; else say "recovery.task=none running"; fi

  if [ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = "running" ]; then
    for i in 1 2 3; do
      fz="$(timeout "$AGENT_TIMEOUT" qm guest cmd "$VMID" fsfreeze-status 2>/dev/null | tr -d '"[:space:]')"
      [ "$fz" = "thawed" ] && break
      timeout 15 qm guest cmd "$VMID" fsfreeze-thaw >/dev/null 2>&1 || true
      sleep "$RECOVERY_POLL"
    done
    fz="$(timeout "$AGENT_TIMEOUT" qm guest cmd "$VMID" fsfreeze-status 2>/dev/null | tr -d '"[:space:]')"
    say "recovery.freeze=${fz:-no answer}"
  fi

  if [ -n "${busy// /}" ]; then
    say "recovery.lock=left alone: a task still holds VM $VMID (or could not be read) — rerun '$MODE' later, or inspect the task"
    return
  fi
  local lock; lock="$(vm_config | awk -F': ' '$1 == "lock" { print $2 }')"
  case "$lock" in
    snapshot|snapshot-delete) qm unlock "$VMID" >/dev/null 2>&1 && say "recovery.lock=unlocked (was $lock)" || say "recovery.lock=unlock FAILED (was $lock)" ;;
    "") say "recovery.lock=not locked" ;;
    *) say "recovery.lock=left alone: locked by '$lock', not by a snapshot" ;;
  esac

  local listed=1
  if [ "$remove_partial" = 1 ]; then snapshot_listed "$name"; listed=$?; fi
  if [ "$listed" -eq "$EXIT_UNREADABLE" ]; then
    say "recovery.partial=unknown: VM $VMID's snapshots could not be read — check for $name by hand"
  elif [ "$remove_partial" = 1 ] && [ "$listed" -eq 0 ]; then
    if timeout --kill-after=15 "$DELETE_TIMEOUT" qm delsnapshot "$VMID" "$name" --force >/dev/null 2>&1; then
      say "recovery.partial=removed $name"
    else
      say "recovery.partial=could not remove $name — delete it by hand once the VM is unlocked"
    fi
  elif [ "$remove_partial" = 1 ]; then
    say "recovery.partial=none left"
  fi
}

case "$MODE" in
  preflight)
    preflight
    if [ "$FAILED" -eq 0 ]; then say "result=ok preflight passed"; exit 0; fi
    say "result=refused $FAILED precondition(s) failed"; exit 3
    ;;
  list)
    valid_vmid "$VMID" || { say "result=refused not a vmid"; exit 2; }
    snaps="$(list_snapshots)" || { say "result=failed could not read VM $VMID's snapshots"; exit 4; }
    [ -z "$snaps" ] || printf '%s\n' "$snaps" | sed 's/^/snapshot=/'
    say "result=ok"
    ;;
  create)
    valid_release_snap "$SNAP_NAME" || { say "result=refused snapshot name must be pre-<...>, letters/digits/-/_ only, max 40"; exit 2; }
    SNAP_DESC="$(printf '%s' "$SNAP_DESC" | tr -cd 'A-Za-z0-9 ._:>-' | cut -c1-120)"
    preflight
    if [ "$FAILED" -gt 0 ]; then say "result=refused $FAILED precondition(s) failed — no snapshot taken"; exit 3; fi
    snapshot_listed "$SNAP_NAME"; listed=$?
    [ "$listed" -eq "$EXIT_UNREADABLE" ] && { say "result=failed could not read VM $VMID's snapshots — no snapshot taken"; exit 4; }
    [ "$listed" -eq 0 ] && { say "result=refused a snapshot named $SNAP_NAME already exists"; exit 3; }
    started="$(date +%s)"
    if timeout --kill-after=15 "$SNAPSHOT_TIMEOUT" qm snapshot "$VMID" "$SNAP_NAME" --vmstate 0 --description "$SNAP_DESC" >/dev/null 2>&1 \
       && snapshot_listed "$SNAP_NAME"; then  # unreadable (3) is not "taken": it falls through to recover
      say "snapshot.seconds=$(( $(date +%s) - started ))"
      for vgpool in $(for s in $(vm_volumes | cut -f1 | cut -d: -f1 | sort -u); do lvmthin_pool "$s"; done | sort -u); do
        say "pool.after.$vgpool=$(lvs --noheadings --nosuffix -o data_percent,metadata_percent "$vgpool" 2>/dev/null | awk '{print "data " $1 "% meta " $2 "%"}')"
      done
      say "result=ok $SNAP_NAME"
      exit 0
    fi
    say "snapshot.seconds=$(( $(date +%s) - started )) (limit ${SNAPSHOT_TIMEOUT}s)"
    recover "$SNAP_NAME" 1
    say "result=failed snapshot did not complete — nothing was switched; see recovery.* above"
    exit 4
    ;;
  delete)
    valid_vmid "$VMID" || { say "result=refused not a vmid"; exit 2; }
    valid_release_snap "$SNAP_NAME" || { say "result=refused only release snapshots (pre-*) are deleted here"; exit 2; }
    snapshot_listed "$SNAP_NAME"; listed=$?
    [ "$listed" -eq "$EXIT_UNREADABLE" ] && { say "result=failed could not read VM $VMID's snapshots — nothing was deleted"; exit 4; }
    [ "$listed" -eq 0 ] || { say "result=ok $SNAP_NAME does not exist"; exit 0; }
    busy="$(busy_tasks "$VMID")" || { say "result=failed could not read the node's active tasks — nothing was deleted"; exit 4; }
    busy="$(printf '%s' "$busy" | tr '\n' ' ')"
    [ -z "${busy// /}" ] || { say "result=refused a task is running on VM $VMID: $busy"; exit 3; }
    if timeout --kill-after=15 "$DELETE_TIMEOUT" qm delsnapshot "$VMID" "$SNAP_NAME" >/dev/null 2>&1; then
      snapshot_listed "$SNAP_NAME"; listed=$?
      [ "$listed" -eq 1 ] && { say "result=ok deleted $SNAP_NAME"; exit 0; }
    fi
    recover "$SNAP_NAME" 0
    say "result=failed could not delete $SNAP_NAME"; exit 4
    ;;
  *)
    say "result=refused usage: preflight|list <vmid> | create <vmid> <pre-name> <description> | delete <vmid> <pre-name>"
    exit 2
    ;;
esac
