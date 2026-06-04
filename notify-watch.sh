#!/usr/bin/env bash
set -u
BASE="${NOTIFY_MCP_BASE:-http://localhost:3737}"
TAG="${NOTIFY_MCP_TAG:-claude-code}"
KEY="${NOTIFY_MCP_KEY:-}"
AGENT_CMD="${NOTIFY_AGENT_CMD:-claude -p}"
SECS="${NOTIFY_POLL_SECS:-50}"

auth=(); [ -n "$KEY" ] && auth=(-H "x-notify-key: $KEY")
echo "[notify-watch] $BASE tag=$TAG long-poll=${SECS}s handler='$AGENT_CMD'"

while true; do
  resp="$(curl -sf "${auth[@]}" "$BASE/api/agent/inbox/wait?timeout_seconds=${SECS}&tag=${TAG}")" || { sleep 2; continue; }
  printf '%s' "$resp" | jq -r '.messages[]?.text // empty' | while IFS= read -r msg; do
    [ -z "$msg" ] && continue
    echo "[notify-watch] $(date '+%H:%M:%S') -> $msg"
    $AGENT_CMD "$msg" || echo "[notify-watch] handler exit $?"
  done
done
