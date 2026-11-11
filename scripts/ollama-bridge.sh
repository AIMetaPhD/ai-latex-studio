#!/usr/bin/env bash
# Ollama bridge for hosts where the engine is native Linux/WSL (NOT Docker Desktop).
#
# Problem (R-01, measured): on Docker Desktop, host.docker.internal routes to the
# host and reaches Ollama on 127.0.0.1:11434. On native Linux Docker Engine the
# name resolves to the docker0 gateway (172.17.0.1) where *nothing* listens, and
# binding the same port there can conflict with an already-bound Ollama. Containers
# therefore get ECONNREFUSED.
#
# This bridge listens ONLY on the docker bridge gateway (never 0.0.0.0, never the
# LAN) and forwards to the host loopback, so Ollama itself stays unexposed.
#
# usage: scripts/ollama-bridge.sh [start|stop|status]
set -euo pipefail
PORT="${AILS_OLLAMA_BRIDGE_PORT:-11435}"
GW="${AILS_DOCKER_GW:-}"
if [[ -z "$GW" ]]; then
  GW=$(ip -4 addr show docker0 2>/dev/null | grep -oE 'inet [0-9.]+' | awk '{print $2}' | head -1)
fi
GW="${GW:-172.17.0.1}"
UPSTREAM="${AILS_OLLAMA_UPSTREAM:-127.0.0.1:11434}"
PIDFILE="/tmp/ails-ollama-bridge.pid"

need() { command -v "$1" >/dev/null || { echo "ERROR: need $1"; exit 1; }; }

case "${1:-start}" in
  start)
    need socat
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "bridge already running (pid $(cat "$PIDFILE")) on $GW:$PORT"; exit 0
    fi
    echo "starting Ollama bridge $GW:$PORT -> $UPSTREAM (loopback upstream, bridge-only listener)"
    nohup socat "TCP-LISTEN:$PORT,bind=$GW,fork,reuseaddr" "TCP:$UPSTREAM" >/tmp/ails-ollama-bridge.log 2>&1 &
    echo $! > "$PIDFILE"
    sleep 1
    if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "ERROR: socat exited; see /tmp/ails-ollama-bridge.log"; exit 1
    fi
    echo "OK. Set OLLAMA_URL=http://host.docker.internal:$PORT in .env"
    ;;
  stop)
    if [[ -f "$PIDFILE" ]]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; echo "stopped"; else echo "not running"; fi
    ;;
  status)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "running pid=$(cat "$PIDFILE") listen=$GW:$PORT upstream=$UPSTREAM"
      curl -s -m 3 -o /dev/null -w "host-check:%{http_code}\n" "http://$GW:$PORT/api/tags" || true
    else
      echo "not running"
    fi
    ;;
  *) echo "usage: $0 [start|stop|status]"; exit 2;;
esac
