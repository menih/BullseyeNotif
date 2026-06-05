#!/usr/bin/env bash
set -u
export MSYS_NO_PATHCONV=1
BASE="${NOTIFY_MCP_BASE:-http://localhost:3737}"
_host="$(hostname | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]//g')"
TAG="${NOTIFY_MCP_TAG:-${_host}-claude-code}"
SECS="${NOTIFY_POLL_SECS:-45}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

slack_reply() {
  curl -s -X POST "$BASE/api/agent/slack/reply" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg t "$1" --arg g "$TAG" '{text:$t,tag:$g}')" >/dev/null
}

handle_msg() {
  local msg="$1" lc
  lc="$(printf '%s' "$msg" | tr 'A-Z' 'a-z')"
  case "$lc" in
    *time*)
      local now; now="$(date '+%I:%M %p')"
      curl -s -X POST "$BASE/api/test/tts" -H 'Content-Type: application/json' \
        -d "$(jq -nc --arg t "The current time is $now" '{text:$t}')" >/dev/null
      slack_reply "The current time is $now. (Handled by the detached bus-worker — your interactive window was never blocked.)"
      ;;
    *)
      ( cd "$(mktemp -d 2>/dev/null || echo /tmp)" && timeout 150 claude -p \
        "A user sent this task via the Slack bus: \"$msg\". Do it concisely, then post the result back to them by running exactly: curl -s -X POST $BASE/api/agent/slack/reply -H 'Content-Type: application/json' -d '{\"text\":\"<your result>\",\"tag\":\"$TAG\"}'" \
        >/dev/null 2>&1 ) &
      ;;
  esac
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
