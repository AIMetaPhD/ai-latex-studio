#!/usr/bin/env bash
# Restore a backup produced by scripts/backup.sh.
# Usage: scripts/restore.sh backups/ails-backup-<UTC>.tar.gz
# Destructive: stops the stack and replaces volume contents. Requires explicit "restore".
set -euo pipefail
cd "$(dirname "$0")/.."
# see backup.sh: compose needs these in the environment, not just in .env
# Load .env, but never clobber a variable the caller already exported: the E2E
# harness runs these scripts against an isolated project with its own port and
# container prefix, and a plain `source .env` silently reset OVERLEAF_PORT to
# the live stack's value (measured: restore then tried to bind the live port).
# .env is loaded without executing it -- see scripts/lib-env.sh for why.
. "$(dirname "$0")/lib-env.sh"
load_env_file .env
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-ai-latex-studio}"
COMPOSE="docker compose -p $COMPOSE_PROJECT_NAME -f infra/docker/docker-compose.yml"
ARCHIVE="${1:?usage: restore.sh <backup.tar.gz>}"
[[ -f "$ARCHIVE" ]] || { echo "ERROR: $ARCHIVE not found"; exit 1; }

# Validate BEFORE the destructive confirm and before any service stop/wipe.
# Previously the script asked the operator to type "restore" and only then
# extracted, so a corrupt or non-AILS archive was confirmed blind; and a tar
# member missing mid-list could wipe a volume before failing. an independent reviewer flagged
# both. We now: extract to scratch, require meta.json, and require all three
# per-volume tars to be present AND readable, before touching anything real.
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
# The outer archive is checked too: it is unpacked into a scratch dir, but a
# member with an absolute path or ".." would escape that dir before we ever get
# to the per-volume checks.
bad_outer=$(tar -tzf "$ARCHIVE" 2>/dev/null | grep -E '^/|(^|/)\.\.(/|$)' | head -3 || true)
[[ -z "$bad_outer" ]] || { echo "ERROR: archive contains path-escaping members: $bad_outer"; exit 1; }
tar -xzf "$ARCHIVE" -C "$WORK" 2>/dev/null || { echo "ERROR: archive is not a readable gzip tar"; exit 1; }
DIR=$(find "$WORK" -maxdepth 1 -mindepth 1 -type d | head -1)
[[ -n "$DIR" && -f "$DIR/meta.json" ]] || { echo "ERROR: meta.json missing — not an AILS backup"; exit 1; }
# A backup archive is untrusted input: it may be attacker-supplied or damaged.
# Reject members that could write outside the target volume (absolute paths,
# ".." components) and link entries, which can point anywhere once extracted.
check_members() {
  local f="$1" bad
  # The listings below swallow tar's stderr, so a tar that cannot read the file
  # yields empty output and would pass both checks vacuously. Callers also test
  # readability first, but this helper must not depend on being called in that
  # order (an independent reviewer's point). Prove the archive lists before judging its members.
  tar -tzf "$f" >/dev/null 2>&1 || { echo "ERROR: $f cannot be listed — refusing to trust it"; return 1; }
  bad=$(tar -tzf "$f" 2>/dev/null | grep -E '^/|(^|/)\.\.(/|$)' | head -3 || true)
  [[ -z "$bad" ]] || { echo "ERROR: $f contains path-escaping members: $bad"; return 1; }
  # links (l/h) and device/fifo nodes (b/c/p) have no business in a volume backup,
  # and a setuid/setgid/sticky bit restored as root would be a privilege change.
  # Match the letters anywhere in the mode string: an earlier version tested
  # fixed positions (^.[sS] / ^..[sS]) which are the user/group *execute* slots,
  # so it could never fire -- caught by an independent reviewer reading the code.
  bad=$(tar -tvzf "$f" 2>/dev/null | awk '$1 ~ /^[lhbcp]/ || $1 ~ /[sStT]/ {print; exit}')
  [[ -z "$bad" ]] || { echo "ERROR: $f contains an unsafe member type: $bad"; return 1; }
  return 0
}

for v in ce-data mongo-data redis-data; do
  [[ -f "$DIR/$v.tar.gz" ]] || { echo "ERROR: $v.tar.gz missing from archive — refusing to restore a partial backup"; exit 1; }
  tar -tzf "$DIR/$v.tar.gz" >/dev/null 2>&1 || { echo "ERROR: $v.tar.gz is corrupt — refusing (would leave torn volume)"; exit 1; }
  check_members "$DIR/$v.tar.gz" || exit 1
done

# mode is a single string field; extract it with grep/sed (no runtime, no dep).
# An earlier `node -I` attempt silently failed to "?" every time (-I is not a node
# option), so the hot-vs-cold warning below never fired -- caught only by testing.
MODE=$(sed -n 's/.*"mode"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$DIR/meta.json" 2>/dev/null | head -1)
[[ -n "$MODE" ]] || MODE='?'
echo "Validated AILS backup (mode=$MODE). This REPLACES ce-data/mongo-data/redis-data from: $ARCHIVE"
if [[ "$MODE" != cold && "${AILS_ALLOW_HOT_RESTORE:-false}" != "true" ]]; then
  echo "ERROR: this archive was not taken as a quiesced cold snapshot (mode='$MODE')."
  echo "       Restoring it can bring back torn data. Re-run with AILS_ALLOW_HOT_RESTORE=true to accept that."
  exit 1
fi
# Same guard as down.sh: with no stdin a bare `read` under `set -euo pipefail`
# exits 1 silently (measured 2026-11-03), and this script is destructive too.
if read -r -p "Type 'restore' to confirm: " ans; then
  [[ "$ans" == "restore" ]] || { echo "aborted"; exit 1; }
else
  echo "no answer on stdin (non-interactive) -- refusing to restore" >&2
  exit 1
fi

$COMPOSE stop

# --- rollback protection -----------------------------------------------------
# The old flow wiped the volumes and extracted in place: a failure halfway
# through (disk full, bad member, a volume that will not mount) left a mix of
# old and new data with the stack unable to start. We now take a quiesced
# snapshot of what is there BEFORE touching it, and put it back if anything in
# the destructive phase fails -- including a stack that comes up but does not
# answer (that used to be a warning only).
ROLLBACK=$(mktemp -d)
PRESERVE=0
trap 'if [[ "$PRESERVE" == 1 ]]; then echo "keeping $ROLLBACK for manual recovery" >&2; else rm -rf "$WORK" "$ROLLBACK"; fi' EXIT
: > "$ROLLBACK/volumes.txt"
snapshot_current() {
  local v vol
  for v in ce-data mongo-data redis-data; do
    vol="${COMPOSE_PROJECT_NAME}_${v}"
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      echo "snapshotting $vol for rollback …"
      docker run --rm -v "$vol":/data:ro -v "$ROLLBACK":/backup alpine \
        tar -czf "/backup/$v.tar.gz" -C /data . || return 1
      echo "$v" >> "$ROLLBACK/volumes.txt"
    fi
  done
  return 0
}

extract_archive() {
  local dir="$1" v vol
  for v in ce-data mongo-data redis-data; do
    vol="${COMPOSE_PROJECT_NAME}_${v}"
    docker volume inspect "$vol" >/dev/null 2>&1 || docker volume create "$vol" >/dev/null || return 1
    echo "restoring $vol …"
    # rm and tar are joined with && on purpose, and the wipe is asserted to have
    # emptied the volume before anything is extracted. With ";", a wipe that
    # fails (busy mount, EIO) still let tar run and the container exited 0, so a
    # half-old volume was reported as a finished restore -- an independent reviewer read this out
    # of the source and it reproduced: with a second volume mounted under /data
    # the rm failed, tar succeeded, exit code was 0 and the old directory was
    # still there. With "&&" the same case exits 1 and tar never runs.
    docker run --rm -v "$vol":/data -v "$dir":/backup alpine \
      sh -c "rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null && [ -z \"\$(ls -A /data)\" ] && tar -xzf /backup/$v.tar.gz -C /data" || return 1
  done
  return 0
}

wait_healthy() {
  local port="${OVERLEAF_PORT:-8080}" host="${OVERLEAF_LISTEN_IP:-127.0.0.1}" code=000
  for _ in $(seq 1 60); do
    code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$host:$port/login" 2>/dev/null || true)
    [[ "$code" == 200 ]] && { echo "CE answers on http://$host:$port"; return 0; }
    sleep 2
  done
  echo "CE did not answer on http://$host:$port within 120s" >&2
  return 1
}

rollback() {
  echo "ROLLING BACK to the pre-restore state …" >&2
  extract_archive "$ROLLBACK" || { PRESERVE=1; echo "ROLLBACK FAILED — the snapshot is still in $ROLLBACK; do not delete it" >&2; exit 1; }
  $COMPOSE up -d >/dev/null 2>&1 || true
  wait_healthy || { PRESERVE=1; echo "WARN: rollback data restored but CE still does not answer; snapshot kept at $ROLLBACK" >&2; }
  echo "rollback complete: the volumes hold the pre-restore data" >&2
  exit 1
}

snapshot_current || { echo "ERROR: could not snapshot current volumes; nothing was changed" >&2; $COMPOSE up -d >/dev/null 2>&1 || true; exit 1; }
extract_archive "$DIR" || rollback
# `up -d` (not `start`): containers may have been removed by `down -v` before restore.
$COMPOSE up -d || rollback
wait_healthy || rollback
rm -rf "$ROLLBACK"
echo "verify with scripts/doctor.sh and a project open in the browser"
