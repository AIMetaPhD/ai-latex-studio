#!/usr/bin/env bash
# AI LaTeX Studio — startup diagnostics (P00 requirement).
# Read-only checks; prints PASS/WARN/FAIL lines with exact commands shown.
set -uo pipefail
cd "$(dirname "$0")/.."

. "$(dirname "$0")/lib-env.sh"
ok=0; warn=0; fail=0
line() { printf '%-6s %s\n' "$1" "$2"; case "$1" in PASS) ok=$((ok+1));; WARN) warn=$((warn+1));; FAIL) fail=$((fail+1));; esac; }

# 1) docker daemon
if docker info >/dev/null 2>&1; then
  line PASS "docker daemon reachable ($(docker --version | head -1))"
else
  line FAIL "docker daemon not reachable — start Docker Engine (or Docker Desktop) first"
fi

# 2) compose plugin
docker compose version >/dev/null 2>&1 && line PASS "compose plugin: $(docker compose version --short 2>/dev/null)" \
  || line FAIL "docker compose plugin missing"

# 3) platform/arch of daemon
arch=$(docker info --format '{{.Architecture}}' 2>/dev/null)
os=$(docker info --format '{{.OSType}}' 2>/dev/null)
if [[ "$os" == linux && ( "$arch" == x86_64 || "$arch" == amd64 ) ]]; then
  line PASS "daemon platform $os/$arch (verified reference)"
elif [[ -n "$arch" ]]; then
  line WARN "daemon platform $os/$arch — image arch support NOT verified for this host (see docs/SERVER_SUPPORT_MATRIX.md)"
else
  line WARN "cannot read daemon platform"
fi

# 4) env file + secrets
if [[ -f .env ]]; then
  line PASS ".env exists"
  load_env_file .env
  [[ -n "${OVERLEAF_INVITE_TOKEN_SECRET:-}" ]] && line PASS "OVERLEAF_INVITE_TOKEN_SECRET set" || line FAIL "missing OVERLEAF_INVITE_TOKEN_SECRET (run scripts/up.sh or scripts/gen-env.sh)"
  [[ -n "${AI_GATEWAY_SECRET:-}" ]] && line PASS "AI_GATEWAY_SECRET set" || line FAIL "missing AI_GATEWAY_SECRET"
  # CE renders this address on the register page ("contact X to create an account")
  # and silently falls back to placeholder@example.com when unset.
  if [[ -z "${ADMIN_EMAIL:-}" || "${ADMIN_EMAIL}" == "placeholder@example.com" ]]; then
    line WARN "ADMIN_EMAIL is not set (CE shows placeholder@example.com) — set it in .env and run scripts/create-admin.sh"
  else
    line PASS "ADMIN_EMAIL set"
  fi
else
  line FAIL ".env missing — cp .env.example .env && scripts/up.sh"
fi

# 5) port free / service up
port="${OVERLEAF_PORT:-8080}"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://${OVERLEAF_LISTEN_IP:-127.0.0.1}:${port}/login" 2>/dev/null || true)
if [[ "$code" == 200 ]]; then
  line PASS "CE answering on http://${OVERLEAF_LISTEN_IP:-127.0.0.1}:${port}"
elif ss -ltn 2>/dev/null | grep -q ":${port} " || netstat -ano 2>/dev/null | grep -q ":${port} .*LISTEN"; then
  line WARN "port ${port} occupied by something that is not answering CE /login (HTTP=$code)"
else
  line WARN "port ${port} free — stack not up yet (scripts/up.sh)"
fi

# 6) loopback-only check (B-10)
# Fail CLOSED, and normalize per-tool columns. An earlier version printed PASS
# whenever `ss` was absent (empty pipeline hit the else-branch without observing
# any socket); and a single awk keyed on `$1=="LISTEN"` only fits `ss` — netstat
# carries state in $6 with `tcp` in $1, so a naive netstat fallback matches nothing
# and re-introduces the same false PASS. Extract the LOCAL address using each
# tool's own layout, then classify. No tool at all => WARN, never PASS.
if command -v ss >/dev/null 2>&1; then
  addrs=$(ss -ltnH 2>/dev/null | awk '{print $4}' || true)
elif command -v netstat >/dev/null 2>&1; then
  addrs=$(netstat -tln 2>/dev/null | awk '$6=="LISTEN"{print $4}' || true)
else
  addrs="__NOTOOL__"
fi
if [[ "$addrs" == "__NOTOOL__" ]]; then
  line WARN "cannot enumerate listeners (no ss/netstat) — loopback-only posture UNVERIFIED"
else
  nonloop=$(printf '%s\n' "$addrs" | awk -v p=":${port}\$" '
      $0 ~ p {
        if ($0 ~ /(^|[^0-9])127\.[0-9.]+:/ || $0 ~ /^\[::1\]:/ || $0 ~ /^::1(:|$)/) next
        print
      }')
  if [[ -n "$nonloop" ]]; then
    line FAIL "port ${port} bound to NON-loopback address (${nonloop%% *}): refuse default public exposure"
  else
    line PASS "no non-loopback listener on ${port}"
  fi
fi

# 7) Ollama reachability from host and from sidecar
curl -s -m 3 "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1 \
  && line PASS "Ollama answering on host 127.0.0.1:11434" \
  || line WARN "Ollama not reachable on host loopback (start it, or set OLLAMA_URL)"
# The sidecar container name carries the prefix like every other service
# (docker-compose.yml:104 `container_name: ${AILS_PREFIX:-ails}-sidecar`), so it
# must be built from the variable. The hardcoded 'ails-sidecar' was measured
# 2026-11-03 to produce a FALSE PASS, not merely a skip: with
# AILS_PREFIX=ailsrc (the E2E harness's own project, qa/g0/restore-e2e.sh:15),
# `grep -q ails-sidecar` still matched the LIVE stack's container, so the check
# exec'd into a container that is not in the project being diagnosed and printed
# "PASS sidecar can reach Ollama" for it. Worse than a wrong answer, because it
# reads as a clearance. The anchored `grep -qx "$SIDECAR"` cannot match across
# prefixes, and the name is printed in the verdict either way.
# Every other docker lookup in this script already used ${AILS_PREFIX:-ails};
# this one had drifted. No harness runs doctor.sh today, so the trigger is an
# operator pointing it at a second stack -- which is exactly what a
# non-default prefix means.
SIDECAR="${AILS_PREFIX:-ails}-sidecar"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SIDECAR"; then
  st=$(docker exec "$SIDECAR" node -e "fetch(process.env.OLLAMA_URL+'/api/tags').then(r=>console.log(r.status)).catch(()=>console.log('ERR'))" 2>/dev/null || echo ERR)
  [[ "$st" == 200 ]] && line PASS "sidecar $SIDECAR can reach Ollama ($OLLAMA_URL)" \
    || line WARN "sidecar $SIDECAR -> Ollama returns '$st' (bridge not configured; G3 issue R-01)"
else
  line WARN "sidecar $SIDECAR not running (skipped sidecar->Ollama check)"
fi

# 8) Resolve one immutable image ID for both TeX and patch checks. Tags can
# move while the deployed container still uses its previous image.
CE_CONTAINER="${AILS_PREFIX:-ails}-ce"
img=''
have_ce=0
if img=$(docker container inspect "$CE_CONTAINER" --format '{{.Image}}' 2>/dev/null) && [[ -n "$img" ]]; then
  have_ce=1
else
  img=''
  if containers=$(docker container ls -a --format '{{.Names}}' 2>/dev/null); then
    if printf '%s\n' "$containers" | grep -Fxq "$CE_CONTAINER"; then
      line FAIL "cannot inspect image for container $CE_CONTAINER"
    else
      line WARN "$CE_CONTAINER absent -- deployment UNVERIFIED; checking configured image only"
      configured_image="ai-latex-studio/ce:${AILS_CE_TAG:-local}"
      img=$(docker image inspect "$configured_image" --format '{{.Id}}' 2>/dev/null) || img=''
      [[ -n "$img" ]] || line WARN "$configured_image not built yet (scripts/up.sh builds it)"
    fi
  else
    line FAIL "cannot inspect containers -- image checks UNVERIFIED"
  fi
fi
TEX_REQUIRED='IEEEtran.cls IEEEtran.bst cite.sty pcrr7t.tfm ptmr7t.tfm xcolor.sty'
if [[ -n "$img" ]]; then
  probe='for f in '"$TEX_REQUIRED"'; do kpsewhich "$f" >/dev/null 2>&1 || echo "MISSING:$f"; done; echo TELDONE'
  out=$(docker run --rm --entrypoint sh "$img" -c "$probe" 2>/dev/null || echo RUNFAIL)
  if [[ "$out" == *RUNFAIL* ]]; then
    line FAIL "could not run the TeX check inside $img (container failed to start)"
  else
    missing=$(printf '%s\n' "$out" | sed -n 's/^MISSING://p' | tr '\n' ' ')
    if [[ -n "${missing// /}" ]]; then
      line FAIL "Academic TeX Bundle incomplete in $img -- missing: ${missing% } (build gates these; $(wc -w <<< "$TEX_REQUIRED") required)"
    elif [[ "$out" == *TELDONE* ]]; then
      line PASS "Academic TeX Bundle present in $img (all $(wc -w <<< "$TEX_REQUIRED") gated files resolve)"
    else
      # Never report success without having seen the completion marker.
      line FAIL "TeX bundle check in $img returned no verdict (output: ${out:0:60})"
    fi
  fi
fi

# 9) Check patches against the same resolved image, and deadline on the container.
if [[ -n "$img" ]]; then
  out=$(docker run --rm --entrypoint sh "$img" -c \
    'f=/overleaf/services/clsi/app/js/LocalCommandRunner.js; grep -q AILS_COMPILE_DEADLINE "$f" && grep -q AILS_SECRET_STRIPPED "$f" && echo PATCHED || echo UNPATCHED' 2>/dev/null || echo RUNFAIL)
  if [[ "$out" == PATCHED ]]; then
    line PASS "local compile patches present in $img (deadline + secret strip)"
  else
    line FAIL "CE image $img does not carry the local compile patches ($out) — rebuild via scripts/up.sh"
  fi
  # The deadline is set per deployment, so also look at the container that runs.
  if [[ "$have_ce" == 1 ]]; then
    dl=$(docker inspect "$CE_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^AILS_COMPILE_TIMEOUT_MS=//p' | head -1)
    if [[ -n "$dl" && "$dl" != 0 ]]; then
      line PASS "compile deadline active in ${AILS_PREFIX:-ails}-ce (${dl} ms)"
    else
      line FAIL "compile deadline is not set in ${AILS_PREFIX:-ails}-ce (AILS_COMPILE_TIMEOUT_MS='${dl:-unset}') — a runaway document would never be stopped"
    fi
  fi
fi

# 10) disk headroom where the data actually lives.
# There is no per-container storage quota on this stack (see
# reports/COMPILER_TIMEOUT_AND_RESOURCE_E2E.md §10: the driver is overlayfs on
# ext4, and `storage-opt size` needs overlay2 on xfs with pquota). What can be
# checked is whether the disk is running out, which is the failure that actually
# hurts: a full disk breaks compiles, Mongo writes and backups at once.
if root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) && [[ -n "$root" ]]; then
  if avail_kb=$(df -Pk "$root" 2>/dev/null | awk 'NR==2{print $4}') && [[ -n "$avail_kb" ]]; then
    avail_gb=$((avail_kb / 1048576))
    if [[ "$avail_gb" -ge 5 ]]; then
      line PASS "disk headroom ${avail_gb} GB free under $root"
    elif [[ "$avail_gb" -ge 1 ]]; then
      line WARN "only ${avail_gb} GB free under $root — compiles and backups will start failing soon"
    else
      # Under a gigabyte the GB figure rounds to 0, which reads as a bug; show MB.
      line FAIL "only $((avail_kb / 1024)) MB free under $root — a compile or a Mongo write will fail; free space before continuing"
    fi
  else
    line WARN "cannot read free space under $root — disk headroom UNVERIFIED"
  fi
fi

echo
echo "doctor: PASS=$ok WARN=$warn FAIL=$fail"
[[ $fail -eq 0 ]] || exit 1
