#!/usr/bin/env bash
# AI LaTeX Studio — one-shot bring-up for the verified reference server
# (Linux x86_64 + Docker Engine/Compose). Idempotent: safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f infra/docker/docker-compose.yml"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-ai-latex-studio}"

# up.sh takes NO arguments (verified 2026-11-03: no script, doc or harness calls
# it with one). The sibling operator scripts -- backup.sh, down.sh,
# scan-secrets.sh, ollama-bridge.sh -- all reject unknown arguments with exit 2.
# The pre-fix up.sh had no such guard at all. Measured 2026-11-03 with the
# pre-fix code run as an unmodified copy inside a throwaway temp dir (the repo's
# own .env was NOT touched; mtime unchanged):
#   * verbatim, on this shell (no docker CLI in PATH): `up.sh --reset` printed
#     nothing about the argument and exited 1 at `need docker`. That is a docker
#     issue, not an argument rejection -- the flag was silently accepted.
#   * with `need docker` + `$COMPOSE version` stubbed to succeed: the same call
#     went on to `generated OVERLEAF_INVITE_TOKEN_SECRET` / `generated
#     AI_GATEWAY_SECRET` and reached `pull sharelatex/sharelatex:6.3.2 (direct)`,
#     stopping only at the next unsstubbed `docker pull` (exit 127).
# So a real `up.sh --reset` on a host with a daemon would write new secrets into
# .env and start rebuilding the stack while appearing to honour a flag that does
# not exist. That is a "looks like it did something" failure of the same class
# this project keeps having to remove. Fail fast now, before touching docker
# or .env.
if [[ $# -gt 0 ]]; then
  echo "ERROR: up.sh takes no arguments (got: $*) -- it is idempotent, just re-run it plain" >&2
  exit 2
fi

need() { command -v "$1" >/dev/null || { echo "ERROR: need $1 in PATH"; exit 1; }; }
need docker
$COMPOSE version >/dev/null 2>&1 || { echo "ERROR: docker compose plugin missing"; exit 1; }

# 1) env + secrets -------------------------------------------------------------
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "created .env from example"
fi
# Load it as DATA, not as code. `set -a; source .env` executes every line:
# measured 2026-11-03 with a .env containing `CANARY=$(touch <tmp>/canary-was-created)`,
# the file appeared while the script was "just reading" it. Same pattern as
# backup.sh / down.sh / doctor.sh / restore.sh / qa/g0/restore-e2e.sh -- see
# scripts/lib-env.sh for the full reasoning and the measured reproduction.
# Everything this script needs from .env (CE_BASE_REF, MONGO_IMAGE, REDIS_IMAGE,
# CE_MIRROR_URL, MIRROR_LIBRARY_URL, OVERLEAF_PORT, OVERLEAF_LISTEN_IP) is a
# plain KEY=value line, and gen() reads its keys through ${!key}, so the loader
# supplies all of them exactly as `source` did.
. "$(dirname "$0")/lib-env.sh"
load_env_file .env

# Bind surface guard: v1.2 default is loopback and publishing is a deliberate,
# threat-model-gated choice, so refuse a wildcard bind unless explicitly overridden
# (mirrors infra/ollama-bridge's posture). Not a hard prohibition -- an opt-in.
case "${OVERLEAF_LISTEN_IP:-127.0.0.1}" in
  0.0.0.0|""|::)
    if [[ "${AILS_ALLOW_PUBLIC_BIND:-false}" != "true" ]]; then
      echo "ERROR: OVERLEAF_LISTEN_IP=${OVERLEAF_LISTEN_IP:-} would publish CE to every interface."
      echo "       CE compiles untrusted LaTeX and is NOT a sandbox (docs/THREAT-MODEL.md)."
      echo "       Keep the loopback default, or set AILS_ALLOW_PUBLIC_BIND=true deliberately."
      exit 1
    fi
    echo "WARNING: binding ${OVERLEAF_LISTEN_IP} per explicit override -- read docs/THREAT-MODEL.md."
    ;;
esac

gen() { # ensure a non-empty secret var exists AND is persisted to .env
  local key="$1" val="$2"
  [[ -n "${!key:-}" ]] && return 0
  export "$key=$val"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
  # Fail closed if it did not land: previously a key absent from .env made this
  # export-only, so the next run silently generated a DIFFERENT secret.
  grep -q "^${key}=${val}$" .env || { echo "ERROR: could not persist ${key} to .env"; exit 1; }
  echo "generated $key"
}
gen OVERLEAF_INVITE_TOKEN_SECRET "$(openssl rand -base64 32 | tr -d '\n=/+' | cut -c1-40)"
gen AI_GATEWAY_SECRET "$(openssl rand -hex 32)"

# 2) base images ---------------------------------------------------------------
# Official reference material is pulled by DIGEST. On networks that cannot reach
# Docker Hub directly, CE_MIRROR_URL may point at a mirror of the CE image and
# MIRROR_LIBRARY_URL at a mirror of the docker.io/library images. We still verify
# the official digest afterwards, so a mirror is a transport, never a trust root.
BASE_PIN=sha256:ada39211c54a1e748065834ec44d3a49094cc475c28d8b803a251901592a94b2
ensure_image() { # $1 canonical ref, $2 optional mirror ref
  local ref=$1 mirror=${2:-}
  docker image inspect "$ref" >/dev/null 2>&1 && { echo "have $ref"; return 0; }
  if [[ -n "$mirror" ]]; then
    echo "pulling $ref via mirror $mirror …"
    if docker pull "$mirror" && docker tag "$mirror" "$ref"; then
      docker image inspect "$ref" >/dev/null 2>&1 && return 0
    fi
    echo "WARN: mirror pull failed for $mirror; falling back to direct"
  fi
  echo "pulling $ref (direct) …"
  docker pull "$ref"
}

# canonical refs come from .env; derive mirror equivalents when configured
CE_REF="${CE_BASE_REF:?CE_BASE_REF missing in .env}"
if [[ -n "${CE_MIRROR_URL:-}" ]]; then
  CE_MIRROR="${CE_MIRROR_URL%%@*}"   # allow a full mirror ref incl. digest
  [[ "$CE_MIRROR_URL" == *"@"* ]] && CE_MIRROR="$CE_MIRROR_URL" || CE_MIRROR="$CE_MIRROR_URL@${BASE_PIN}"
else
  CE_MIRROR=""
fi
MONGO_REF="$MONGO_IMAGE"
REDIS_REF="$REDIS_IMAGE"
LIB_MIRROR="${MIRROR_LIBRARY_URL:-}"

ensure_image "$CE_REF" "$CE_MIRROR"
ensure_image "$MONGO_REF" "${LIB_MIRROR:+${LIB_MIRROR}/mongo@${MONGO_REF#*@}}"
ensure_image "$REDIS_REF" "${LIB_MIRROR:+${LIB_MIRROR}/redis@${REDIS_REF#*@}}"

verify_digest() { # $1 ref, $2 expected digest
  local digests
  digests=$(docker image inspect "$1" --format '{{json .RepoDigests}}')
  if ! grep -q "$2" <<<"$digests"; then
    echo "ERROR: $1 is not the pinned official digest."
    echo "  expected: $2"; echo "  found:    $digests"; exit 1
  fi
  echo "digest OK $2 ($1)"
}
verify_digest "$CE_REF" "$BASE_PIN"
verify_digest "$MONGO_REF" "${MONGO_IMAGE#*@}"
verify_digest "$REDIS_REF" "${REDIS_IMAGE#*@}"

# 3) build application images ---------------------------------------------------
$COMPOSE build

# 4) bring the stack up --------------------------------------------------------
# The compose graph now owns ordering: `ce` depends on mongo (healthy), the
# one-shot mongo-init (rs.initiate, service_completed_successfully), redis and
# sidecar. Previously this script re-implemented that with `config --services`
# minus three names plus hand-rolled wait loops; a reviewer showed the lookup
# resolves to mongo-init, not CE (order-dependent), and the loops fell through on
# timeout. Both were real. The service is named "ce" so there is nothing to guess.
if [[ "${OLLAMA_URL:-}" == *":11435"* ]]; then
  echo "starting Ollama loopback bridge (profile native-bridge)…"
  $COMPOSE --profile native-bridge up -d ollama-bridge
fi
$COMPOSE up -d ce

# Assert the replica set actually has a primary before declaring success, so a
# mongo problem is reported as a mongo problem (not only via the HTTP gate).
# Give it a short window: a just-elected primary can take a moment to report.
# The container name carries the prefix like every other service
# (docker-compose.yml:149 `container_name: ${AILS_PREFIX:-ails}-mongo`), so it
# must be built from the variable. load_env_file already populated AILS_PREFIX
# from .env (or the default "ails").
MONGO="${AILS_PREFIX:-ails}-mongo"
echo "verifying replica set primary…"
have_primary=0
for i in $(seq 1 20); do
  if docker exec "$MONGO" mongosh --quiet --eval 'quit(db.hello().primary ? 0 : 1)' >/dev/null 2>&1; then
    have_primary=1; break
  fi
  sleep 2
done
if [[ "$have_primary" != 1 ]]; then
  echo "ERROR: mongo has no PRIMARY after ~40s (replica set not initiated)."
  echo "       Check: $COMPOSE logs --tail 40 mongo-init mongo"
  exit 1
fi
echo "replica set primary OK"

# 5) readiness -----------------------------------------------------------------
echo "waiting for http healthcheck…"
ok=0
for i in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://${OVERLEAF_LISTEN_IP:-127.0.0.1}:${OVERLEAF_PORT:-8080}/login" || true)
  [[ "$code" == 200 ]] && { ok=1; break; }
  sleep 2
done
if [[ "$ok" == 1 ]]; then
  echo "READY: http://${OVERLEAF_LISTEN_IP:-127.0.0.1}:${OVERLEAF_PORT:-8080}"
  # CE 6.3.2 has no first-visit signup (/register has no form and no POST route,
  # checked in the image), so do not tell people to just open it.
  echo "       no account yet? bash scripts/create-admin.sh you@example.com"
else
  echo "ERROR: CE did not answer (last HTTP=$code). Inspect: $COMPOSE logs --tail 80 ce ; then run scripts/doctor.sh"
  exit 1
fi
