#!/usr/bin/env bash
# Export a restorable snapshot of all three volumes + image digests.
# Output: backups/ails-backup-<UTC>.tar.gz containing:
#   meta.json                 (image ids, compose hash, timestamp, mode)
#   ce-data.tar.gz mongo-data.tar.gz redis-data.tar.gz
#
# CONSISTENCY: by default this is a COLD snapshot -- the services that write to
# these volumes (ce, mongo, redis) are stopped first, so the files are quiescent.
# Copying a running mongod's data directory is NOT safe (WiredTiger needs a
# storage-engine-consistent snapshot), and a live ce-data/redis copy can be torn
# mid-write. Stop, copy, then bring the stack back up and wait for readiness.
# `--hot` skips the stop for operators who accept that risk; it is logged loudly
# and recorded in meta.json so a restored backup's provenance is never ambiguous.
set -euo pipefail
cd "$(dirname "$0")/.."
# compose interpolates ${...} from the shell environment; without this the
# required-variable checks fail when the script is run on its own (up.sh also
# sources .env, which is why the bring-up path never showed the problem).
# Load .env, but never clobber a variable the caller already exported: the E2E
# harness runs these scripts against an isolated project with its own port and
# container prefix, and a plain `source .env` silently reset OVERLEAF_PORT to
# the live stack's value (measured: restore then tried to bind the live port).
# .env is loaded without executing it -- see scripts/lib-env.sh for why.
. "$(dirname "$0")/lib-env.sh"
load_env_file .env
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-ai-latex-studio}"
# -p makes the target project explicit instead of relying on COMPOSE_PROJECT_NAME
# winning over the compose file's `name:` field. Measured on Compose 5.5.0 it does
# win, but a silent change in that precedence would point stop/up at another project.
COMPOSE="docker compose -p $COMPOSE_PROJECT_NAME -f infra/docker/docker-compose.yml"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="backups/ails-backup-$STAMP"
case "${1:-}" in
  "") MODE=cold ;;
  --hot) MODE=hot ;;
  *) echo "ERROR: unknown argument '${1}' — only --hot is accepted" >&2; exit 2 ;;
esac
# The snapshot directory is created only once the checks have passed: creating it
# up front left an empty backups/ails-backup-* behind every time a run aborted
# (an independent reviewer saw the empty directories and I could reproduce them with a failing
# `ps`). A directory now means "something was actually written here".

# Is a compose service's container running? Asked from the container's own state
# instead of parsing `docker compose ps --services` against a name regex: that
# output is bare names today, and a format change would make every count read 0,
# i.e. "nothing is running" -- the exact fail-open that once labelled a live copy
# as cold. A container that does not exist answers "no". Exit 2 means the ps call
# itself failed, which callers must treat as "cannot tell" and abort.
service_running() {
  local id
  id=$($COMPOSE ps -q "$1" 2>/dev/null) || return 2
  [[ -n "$id" ]] || return 1
  docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null | grep -qx true
}

WAS_RUNNING=0
cleanup() {
  # always bring back what we stopped, even on error
  if [[ "$MODE" == cold && "$WAS_RUNNING" == 1 ]]; then
    echo "restarting stack…"
    $COMPOSE up -d >/dev/null 2>&1 || echo "WARN: could not auto-restart; run scripts/up.sh"
  fi
}
trap cleanup EXIT

if [[ "$MODE" == cold ]]; then
  # Never treat a failed `ps` as "nothing is running": that is how a live copy
  # gets labelled cold. an independent reviewer flagged this branch; reproduced by making `ps`
  # fail and `stop` a no-op -- the archive was written as cold while the stack
  # was still up.
  running=0
  for svc in ce mongo redis; do
    if service_running "$svc"; then
      running=$((running + 1))
    elif [[ $? -eq 2 ]]; then
      echo "ERROR: 'docker compose ps' failed — cannot tell whether the stack is running; refusing to guess" >&2
      exit 1
    fi
  done
  [[ "$running" -gt 0 ]] && WAS_RUNNING=1
  echo "stopping ce/mongo/redis for a consistent snapshot…"
  if ! $COMPOSE stop ce mongo redis >/dev/null 2>&1; then
    echo "ERROR: 'docker compose stop' failed — refusing to label a live copy as a cold backup" >&2
    exit 1
  fi
  # Stopping can "succeed" while a service keeps running (e.g. a restart policy
  # or a partial stop). A cold label is a promise the data is quiescent, so check.
  still=0
  for svc in ce mongo redis; do
    if service_running "$svc"; then
      still=$((still + 1))
    elif [[ $? -eq 2 ]]; then
      echo "ERROR: 'docker compose ps' failed after stop — cannot confirm the stack is quiet" >&2
      exit 1
    fi
  done
  if [[ "$still" -gt 0 ]]; then
    echo "ERROR: $still service(s) still running after stop — refusing to label a live copy as cold" >&2
    exit 1
  fi
else
  echo "WARNING: --hot backs up live volumes; a running MongoDB copy may not restore cleanly."
fi

mkdir -p "$OUT"
for v in ce-data mongo-data redis-data; do
  vol="${COMPOSE_PROJECT_NAME}_${v}"
  if ! docker volume inspect "$vol" >/dev/null 2>&1; then
    echo "ERROR: volume $vol not found"; exit 1
  fi
  echo "exporting $vol ($MODE) …"
  docker run --rm -v "$vol":/data:ro -v "$PWD/$OUT":/backup alpine \
    tar -czf "/backup/$v.tar.gz" -C /data .
done

node - "$OUT" "$MODE" <<'NODE'
const fs = require('node:fs')
const { execSync } = require('node:child_process')
const [out, mode] = process.argv.slice(2)
const digests = {}
for (const img of ['ai-latex-studio/ce:local', 'ai-latex-studio/sidecar:local']) {
  try { digests[img] = execSync(`docker image inspect ${img} --format '{{.Id}}'`).toString().trim() } catch { digests[img] = 'MISSING' }
}
const composeHash = execSync('sha256sum infra/docker/docker-compose.yml').toString().split(' ')[0]
fs.writeFileSync(`${out}/meta.json`, JSON.stringify({
  created_at: new Date().toISOString(), images: digests, compose_sha256: composeHash,
  mode, // 'cold' (quiesced, restore-safe) or 'hot' (live, may be inconsistent)
  restore_safe: mode === 'cold',
  note: 'restore with scripts/restore.sh <this dir>',
}, null, 2))
NODE

tar -czf "$OUT.tar.gz" -C backups "$(basename "$OUT")"
rm -rf "$OUT"
echo "backup written ($MODE): $OUT.tar.gz"
sha256sum "$OUT.tar.gz"
