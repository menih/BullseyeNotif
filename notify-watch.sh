#!/usr/bin/env bash
set -u
export MSYS_NO_PATHCONV=1
BASE="${NOTIFY_MCP_BASE:-http://localhost:3737}"
_host="$(hostname | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]//g')"
ROOT="$(cd "$(dirname "$0")" && pwd)"
_folder="$(basename "$ROOT" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]//g')"
TAG="${NOTIFY_MCP_TAG:-${_host}-${_folder}-bot}"
SECS="${NOTIFY_POLL_SECS:-45}"

mkdir -p "$ROOT/.run"
PIDFILE="$ROOT/.run/notify-watch.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "[notify-watch] another instance alive ($(cat "$PIDFILE")) — exiting"; exit 0
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

slack_reply() {
  curl -s -X POST "$BASE/api/agent/slack/reply" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg t "$1" --arg g "$TAG" '{text:$t,tag:$g}')" >/dev/null
}

handle_msg() {
  local msg="$1"
  ( cd "$(mktemp -d 2>/dev/null || echo /tmp)" && timeout 150 claude -p \
    "A user sent this via the Slack bus: \"$msg\". Do EXACTLY what they ask — follow every detail literally, with no conversion or substitution. Do NOT call the notify, ask, or any notification/MCP tool — your ONE AND ONLY output channel is the curl below. If they ask you to say/speak something ALOUD, speak it by running: curl -s -X POST $BASE/api/test/tts -H 'Content-Type: application/json' -d '{\"text\":\"<exact words>\"}' . Post your text answer back by running exactly once: curl -s -X POST $BASE/api/agent/slack/reply -H 'Content-Type: application/json' -d '{\"text\":\"<your answer>\",\"tag\":\"$TAG\"}'" \
    >/dev/null 2>&1 ) &
}

echo "[notify-watch] $(date '+%H:%M:%S') started — $BASE tag=$TAG long-poll=${SECS}s"
while true; do
  resp="$(curl -sf "$BASE/api/agent/inbox/wait?timeout_seconds=${SECS}&tag=${TAG}")" || { sleep 2; continue; }
  while IFS= read -r msg; do
    [ -z "$msg" ] && continue
    echo "[notify-watch] $(date '+%H:%M:%S') got: $msg"
    handle_msg "$msg"
  done < <(printf '%s' "$resp" | jq -r '.messages[]?.text // empty')
done
