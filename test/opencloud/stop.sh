#!/usr/bin/env bash
# Stop the throwaway OpenCloud started by start.sh. Data/config/env are kept (use RESET=1 ./start.sh to wipe).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$DIR/run/opencloud.pid"

pids="$(cat "$PIDFILE" 2>/dev/null || true) $(pgrep -f "^$DIR/bin/opencloud server" || true)"
pids="$(echo $pids | tr ' ' '\n' | sort -u | while read -r p; do [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"; done)"
if [ -z "$pids" ]; then echo "[stop.sh] not running"; rm -f "$PIDFILE"; exit 0; fi

echo "[stop.sh] stopping pid(s): $pids"
kill -TERM $pids 2>/dev/null
for i in $(seq 1 30); do
  alive=""; for p in $pids; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
  [ -z "$alive" ] && break
  sleep 1
done
if [ -n "${alive:-}" ]; then echo "[stop.sh] force-killing:$alive"; kill -KILL $alive 2>/dev/null; fi
rm -f "$PIDFILE"
echo "[stop.sh] stopped"
