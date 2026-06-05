#!/usr/bin/env bash
set -u
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
mkdir -p .run
log() { echo "[bus-up $(date '+%H:%M:%S')] $*" >> .run/bus-up.log; }
log "watchdog started (keeps :3737 server + notify-watch worker alive, independent of any interactive session)"
while true; do
  if ! curl -s -o /dev/null --max-time 3 http://localhost:3737/v1/health 2>/dev/null; then
    ENABLE_MCP=1 nohup node dist/ui/server.js > .run/server.log 2>&1 &
    log "server was DOWN — relaunched (ENABLE_MCP=1)"
    sleep 4
  fi
  if ! ps -ef 2>/dev/null | grep -qE 'bash (\./)?notify-watch\.sh *$'; then
    nohup bash notify-watch.sh > .run/notify-watch.log 2>&1 &
    log "worker was DOWN — relaunched"
  fi
  sleep 15
done
