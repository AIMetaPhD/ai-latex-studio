#!/usr/bin/env bash
# Read-only probe: is CE actually serving, and where does the chain stop?
echo "--- wait for CE inside WSL (up to ~120s) ---"
code=000
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 4 http://127.0.0.1:8081/login 2>/dev/null || true)
  if [[ "$code" == 200 ]]; then echo "CE ready inside WSL: HTTP 200 after ~$((i * 3))s of probing"; break; fi
  sleep 3
done
echo "last code from inside WSL: $code"
echo
echo "--- ports published for ails-ce ---"
docker port ails-ce 2>/dev/null || echo "(docker port gave nothing)"
echo
echo "--- does the container's own web app answer on its internal port? ---"
docker exec ails-ce curl -s -o /dev/null -w 'inside-container 127.0.0.1:80/login -> %{http_code}\n' -m 5 http://127.0.0.1:80/login 2>/dev/null || echo "(no curl in container / refused)"
echo
echo "--- runit service states ---"
docker exec ails-ce sv status /var/service/* 2>/dev/null | head -12 || echo "(sv not available)"
echo
echo "--- web.log tail (startup progress) ---"
docker exec ails-ce tail -n 5 /var/log/overleaf/web.log 2>/dev/null || echo "(no web.log)"
