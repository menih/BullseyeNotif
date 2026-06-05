#!/usr/bin/env bash
set -u
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"; mkdir -p .run
log() { echo "[bus-up $(date '+%H:%M:%S')] $*" >> .run/bus-up.log; }

PIDFILE=".run/bus-up.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  log "another bus-up alive ($(cat "$PIDFILE")) — exiting"; exit 0
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

RUN_BUILD=""
start_server() {
  local p
  p="$(netstat -ano 2>/dev/null | grep ':3737' | grep LISTENING | awk '{print $5}' | head -1)"
  [ -n "$p" ] && taskkill //F //PID "$p" >/dev/null 2>&1
  sleep 1
  ENABLE_MCP=1 nohup node dist/ui/server.js > .run/server.log 2>&1 &
  RUN_BUILD="$(stat -c %Y dist/ui/server.js 2>/dev/null)"
  log "server (re)started (build=$RUN_BUILD)"
  sleep 4
}

log "watchdog started — singleton, sole manager of :3737 + notify-watch (lenient health, auto-redeploy on build)"
FAILS=0
while true; do
  CUR_BUILD="$(stat -c %Y dist/ui/server.js 2>/dev/null)"
  if netstat -ano 2>/dev/null | grep ':3737' | grep -q 'LISTENING'; then
    FAILS=0
    if [ -z "$RUN_BUILD" ]; then
      RUN_BUILD="$CUR_BUILD"
    elif [ -n "$CUR_BUILD" ] && [ "$CUR_BUILD" != "$RUN_BUILD" ]; then
      log "new build detected — redeploying"; start_server
    fi
  else
    FAILS=$((FAILS + 1))
    log "port :3737 not listening ($FAILS/2)"
    [ "$FAILS" -ge 2 ] && { start_server; FAILS=0; }
  fi
  if ! ps -ef 2>/dev/null | grep -qE 'bash (\./)?notify-watch\.sh *$'; then
    nohup bash notify-watch.sh > .run/notify-watch.log 2>&1 &
    log "worker (re)started"
  fi
  sleep 5
done
