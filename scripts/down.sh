#!/usr/bin/env bash
# Stop the stack. Data stays in named volumes unless --purge is passed.
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
case "${1:-}" in
  --purge) ;; "") ;;
  *) echo "ERROR: unknown argument '$1' — only --purge is accepted" >&2; exit 2 ;;
esac
if [[ "${1:-}" == "--purge" ]]; then
  echo "WARNING: --purge deletes THIS project's volumes (COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-ai-latex-studio}): ce-data/mongo-data/redis-data. Other projects' volumes are untouched."
  # A bare `read -r -p` under `set -euo pipefail` exits 1 and prints NOTHING when
  # stdin is not a terminal (piped output, `< /dev/null`, a cron job): measured
  # 2026-11-03 in a throwaway script -- a silent refusal on the destructive path,
  # indistinguishable from "the script hung". Say which of the two it was.
  if read -r -p "Type 'purge' to confirm: " ans; then
    [[ "$ans" == "purge" ]] || { echo "aborted"; exit 1; }
  else
    echo "no answer on stdin (non-interactive) -- refusing to purge" >&2
    exit 1
  fi
  $COMPOSE down -v
else
  $COMPOSE down
  echo "stopped; volumes retained (scripts/backup.sh to export, scripts/up.sh to resume)"
fi
