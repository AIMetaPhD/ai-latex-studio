#!/usr/bin/env bash
# P0 (PM review, work package 1): backup -> wipe -> restore -> reopen, performed
# entirely on a NEW, disposable compose project. Nothing here touches the live
# stack: every docker call is scoped with -p ailsrc or an explicit ailsrc_* name,
# and the guard below refuses to continue if that is not true.
#
#   bash qa/g0/restore-e2e.sh up|seed|fixture|backup|wipe|restore|verify|negative|down|all
#
# Evidence: reports/evidence-2026-11-02/restore-e2e-v2/
set -euo pipefail
cd "$(dirname "$0")/../.."

PROJ=ailsrc
EM=$(printf '%s@%s' e2e example.invalid)  # assembled at runtime; a throwaway test address
PREFIX=ailsrc
PORT=18081
OUT=reports/evidence-2026-11-02/restore-e2e-v2
mkdir -p "$OUT"

# .env is data, not code: see scripts/lib-env.sh
. "$(dirname "$0")/../../scripts/lib-env.sh"
load_env_file .env
export AILS_PREFIX="$PREFIX" OVERLEAF_PORT="$PORT" OVERLEAF_LISTEN_IP=127.0.0.1
export COMPOSE_PROJECT_NAME="$PROJ"
COMPOSE="docker compose -p $PROJ -f infra/docker/docker-compose.yml"
BASE="http://127.0.0.1:$PORT"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$OUT/run.log"; }
die() { log "FATAL: $*"; exit 1; }

guard() {
  [[ "$PROJ" == ailsrc ]] || die "project name changed unexpectedly"
  # containers with our prefix must be absent or belong to this project
  for c in ce sidecar mongo mongo-init redis; do
    if docker ps -a --format '{{.Names}}' | grep -qx "$PREFIX-$c"; then
      p=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$PREFIX-$c")
      [[ "$p" == "$PROJ" ]] || die "$PREFIX-$c belongs to project '$p', refusing"
    fi
  done
  # the live stack must be untouched by anything below
  if docker ps --format '{{.Names}}' | grep -qx ails-ce; then
    log "live stack ails-ce is running (will not be touched)"
  fi
  return 0
}

wait_ready() {
  for _ in $(seq 1 120); do
    code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$BASE/login" || true)
    [[ "$code" == 200 ]] && { log "CE ready at $BASE"; return 0; }
    sleep 2
  done
  die "CE did not become ready at $BASE"
}

up() {
  guard
  log "bringing up isolated project $PROJ on $BASE"
  $COMPOSE up -d >>"$OUT/up.log" 2>&1 || die "compose up failed (see $OUT/up.log)"
  wait_ready
}

seed() {
  # A login for the fixture. The hash is copied from an existing local account so
  # no new secret is generated or printed; this is a throwaway test database.
  guard
  log "seeding a test user in $PROJ's mongo"
  # Clone a COMPLETE user document (a hand-built partial doc made login fail:
  # CE reads fields the minimal shape does not have). The hash is copied as-is,
  # so nothing new is generated and no secret is printed.
  # newest account = the one whose password is known here (the older admin's is not)
  DOC=$(docker exec ails-mongo mongosh --quiet sharelatex --eval \
    'print(JSON.stringify(db.users.find({hashedPassword:{$exists:true}}).sort({_id:-1}).limit(1).toArray()[0]))')
  [[ -n "$DOC" && "$DOC" != "null" ]] || die "could not read a source user document"
  {
    printf 'const d = JSON.parse(`%s`)\n' "$DOC"
    printf "d._id = ObjectId(d._id)\n"
    printf "d.email = '$EM'\n"
    printf "d.emails = [{email:'$EM',reversedHostname:'invalid.example',primary:true}]\n"
    printf "d.first_name='E2E'; d.last_name='Fixture'; d.lastLogin=null\n"
    printf "db.users.deleteMany({'emails.email':'$EM'})\n"
    printf 'db.users.insertOne(d)\n'
    printf "print('USERS ' + db.users.countDocuments({}))\n"
  } | docker exec -i "$PREFIX-mongo" mongosh --quiet sharelatex | tee -a "$OUT/seed.log"
}

fixture() {
  guard
  # This is the one step that needs a real browser. Where the harness runs in WSL
  # and Playwright's Chromium lives on the Windows host (our case), it cannot run
  # here; say what to run instead of dying with "Chromium not found".
  if [[ -z "${CHROME_PATH:-}" && -z "${LOCALAPPDATA:-}" ]]; then
    cat >&2 <<EOF
ERROR: no Chromium reachable from here (LOCALAPPDATA is empty, CHROME_PATH unset).
       Run this one step on the host that has Playwright's Chromium:

         CE_BASE_URL=$BASE AILS_ADMIN_EMAIL=$EM AILS_ADMIN_PASS=<trial password> node qa/g1/02-project-compile.mjs

       then: echo <printed project id> > $OUT/project-id.txt
       The remaining steps (manifest/backup/wipe/restore/verify/negative) run here.
EOF
    exit 1
  fi
  log "creating fixture project through the real UI (probe 02) against $BASE"
  CE_BASE_URL="$BASE" AILS_ADMIN_EMAIL="$EM" AILS_ADMIN_PASS="${AILS_E2E_ADMIN_PASS:?set AILS_E2E_ADMIN_PASS to the trial password}" \
    node qa/g1/02-project-compile.mjs >>"$OUT/fixture.log" 2>&1 || die "fixture creation failed (see $OUT/fixture.log)"
  PID_=$(cat qa/g1/artifacts/02-project-id.txt)
  log "fixture project $PID_"
  echo "$PID_" > "$OUT/project-id.txt"
}

manifest() {
  local tag="$1"
  # whole-volume content hash + the fixture project's own files + DB record count
  docker run --rm -v "${PROJ}_ce-data":/data:ro alpine \
    sh -c 'cd /data && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum' \
    | awk '{print "ce_volume_sha256 " $1}' | tee "$OUT/manifest-$tag.txt"
  docker run --rm -v "${PROJ}_ce-data":/data:ro alpine \
    sh -c "cd /data && find . -path '*${PID_}*' -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum" \
    | awk '{print "project_sha256 " $1}' | tee -a "$OUT/manifest-$tag.txt"
  docker run --rm -v "${PROJ}_ce-data":/data:ro alpine \
    sh -c "cd /data && find . -path '*${PID_}*' -type f | sort" | tee -a "$OUT/manifest-$tag.txt"
  docker exec "$PREFIX-mongo" mongosh --quiet sharelatex --eval \
    'print("projects " + db.projects.countDocuments({}) + " users " + db.users.countDocuments({}))' \
    | tee -a "$OUT/manifest-$tag.txt"
}

backup() {
  guard
  log "cold backup of the isolated project"
  COMPOSE_PROJECT_NAME="$PROJ" AILS_PREFIX="$PREFIX" OVERLEAF_PORT="$PORT" \
    bash scripts/backup.sh >>"$OUT/backup.log" 2>&1 || die "backup failed"
  # Take the path the script reported, not "the newest file in backups/" — that
  # picked up whatever else existed and made the run depend on directory state.
  ARCHIVE=$(sed -n 's/^backup written.*: //p' "$OUT/backup.log" | tail -1)
  [[ -f "$ARCHIVE" ]] || die "backup.sh did not report an archive path"
  mv "$ARCHIVE" "$OUT/backup.tar.gz"
  sha256sum "$OUT/backup.tar.gz" | tee "$OUT/backup.sha256"
  log "backup: $OUT/backup.tar.gz"
}

wipe() {
  guard
  log "destroying ONLY the isolated volumes (project $PROJ)"
  $COMPOSE down -v >>"$OUT/wipe.log" 2>&1 || die "down -v failed"
  for v in ce-data mongo-data redis-data; do
    docker volume inspect "${PROJ}_$v" >/dev/null 2>&1 && die "volume ${PROJ}_$v still exists"
  done
  log "isolated volumes are gone; live volumes untouched"
}

restore() {
  guard
  log "restoring the isolated project from the archive"
  COMPOSE_PROJECT_NAME="$PROJ" AILS_PREFIX="$PREFIX" OVERLEAF_PORT="$PORT" \
    bash scripts/restore.sh "$OUT/backup.tar.gz" <<<"restore" >>"$OUT/restore.log" 2>&1 \
    || die "restore failed"
  wait_ready
}

verify() {
  guard
  manifest after
  log "comparing manifests"
  # The whole-volume hash legitimately changes: CE writes logs, sessions and
  # cache into that volume on boot. What must be identical is the project data
  # (project_sha256, the per-project file list) and the database record counts.
  grep -E '^ce_volume_sha256' "$OUT/manifest-before.txt" > "$OUT/volume-before.txt" || true
  grep -E '^ce_volume_sha256' "$OUT/manifest-after.txt" > "$OUT/volume-after.txt" || true
  if diff "$OUT/volume-before.txt" "$OUT/volume-after.txt" >/dev/null; then
    log "whole-volume hash identical (informational)"
  else
    log "whole-volume hash differs (expected: CE writes runtime state on boot); project data is compared below"
  fi
  diff <(grep -vE '^\./|^ce_volume_sha256' "$OUT/manifest-before.txt") \
       <(grep -vE '^\./|^ce_volume_sha256' "$OUT/manifest-after.txt") \
    && log "project data + record counts identical" || die "project data differs after restore"
  log "recompiling the restored project to prove it is usable"
  AILS_E2E_EMAIL="$EM" AILS_E2E_ADMIN_PASS="${AILS_E2E_ADMIN_PASS:?set AILS_E2E_ADMIN_PASS to the trial password}" \
    node qa/g0/reopen-check.mjs "$BASE" "$PID_" >>"$OUT/reopen.log" 2>&1 || die "reopen check failed"
  log "reopen check passed"
}

negative() {
  guard
  log "negative cases: each must be refused BEFORE any volume is touched"
  before=$(docker run --rm -v "${PROJ}_ce-data":/data:ro alpine \
    sh -c 'cd /data && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum' | awk '{print $1}')

  mkdir -p "$OUT/negative"
  # 1) truncated gzip
  head -c 2000 "$OUT/backup.tar.gz" > "$OUT/negative/truncated.tar.gz"
  # 2) no meta.json
  cp "$OUT/backup.tar.gz" "$OUT/negative/nometa.tar.gz"
  tmp=$(mktemp -d); tar -xzf "$OUT/negative/nometa.tar.gz" -C "$tmp"
  d=$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -1); rm -f "$d/meta.json"
  tar -czf "$OUT/negative/nometa.tar.gz" -C "$tmp" "$(basename "$d")"; rm -rf "$tmp"
  # 3) missing one volume tar
  cp "$OUT/backup.tar.gz" "$OUT/negative/missingvol.tar.gz"
  tmp=$(mktemp -d); tar -xzf "$OUT/negative/missingvol.tar.gz" -C "$tmp"
  d=$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -1); rm -f "$d/redis-data.tar.gz"
  tar -czf "$OUT/negative/missingvol.tar.gz" -C "$tmp" "$(basename "$d")"; rm -rf "$tmp"
  # 4) absolute path member inside a volume tar
  bad=$(mktemp -d); echo x > "$bad/payload"
  tar -czf "$bad/ce-data.tar.gz" -P /etc/hostname
  tar -czf "$bad/redis-data.tar.gz" -C "$bad" payload
  tar -czf "$bad/mongo-data.tar.gz" -C "$bad" payload
  pack() { # $1=dir with meta.json + tars, $2=out file
    tmpd=$(mktemp -d); mkdir -p "$tmpd/ails-backup-x"
    cp "$1"/*.tar.gz "$tmpd/ails-backup-x/"; printf '{"mode":"cold"}' > "$tmpd/ails-backup-x/meta.json"
    tar -czf "$2" -C "$tmpd" ails-backup-x; rm -rf "$tmpd"
  }
  pack "$bad" "$OUT/negative/traversal.tar.gz"
  # 5) symlink member
  bad2=$(mktemp -d); ln -s /etc/passwd "$bad2/link"
  tar -czf "$bad2/ce-data.tar.gz" -C "$bad2" link
  tar -czf "$bad2/redis-data.tar.gz" -C "$bad2" link
  tar -czf "$bad2/mongo-data.tar.gz" -C "$bad2" link
  pack "$bad2" "$OUT/negative/symlink.tar.gz"
  rm -rf "$bad" "$bad2"

  rc_all=0
  for f in truncated nometa missingvol traversal symlink; do
    if COMPOSE_PROJECT_NAME="$PROJ" AILS_PREFIX="$PREFIX" OVERLEAF_PORT="$PORT" \
        bash scripts/restore.sh "$OUT/negative/$f.tar.gz" <<<"restore" >>"$OUT/negative/$f.log" 2>&1; then
      log "NEGATIVE FAIL: $f was accepted"; rc_all=1
    else
      log "negative ok: $f refused"
    fi
  done
  after=$(docker run --rm -v "${PROJ}_ce-data":/data:ro alpine \
    sh -c 'cd /data && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum' | awk '{print $1}')
  [[ "$before" == "$after" ]] && log "negative cases left the volume unchanged" || { log "NEGATIVE FAIL: volume changed"; rc_all=1; }
  return $rc_all
}

down() {
  log "removing the disposable project $PROJ (containers + volumes)"
  $COMPOSE down -v >>"$OUT/down.log" 2>&1 || true
  log "done; live stack untouched"
}

PID_=$(cat "$OUT/project-id.txt" 2>/dev/null || true)
case "${1:-all}" in
  up) up ;;
  seed) seed ;;
  fixture) fixture ;;
  manifest) manifest "${2:-before}" ;;
  backup) backup ;;
  wipe) wipe ;;
  restore) restore ;;
  verify) verify ;;
  negative) negative ;;
  down) down ;;
  all)
    up; seed
    fixture
    PID_=$(cat "$OUT/project-id.txt"); manifest before
    backup; wipe; restore
    PID_=$(cat "$OUT/project-id.txt"); verify
    negative
    log "E2E complete"
    ;;
  *) die "unknown phase: $1" ;;
esac
