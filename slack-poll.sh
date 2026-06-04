#!/usr/bin/env bash
set -u
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
[ -f "$HOME/.notify-mcp/slack-config.sh" ] && source "$HOME/.notify-mcp/slack-config.sh"
TOKEN="${SLACK_BOT_TOKEN:-}"
CHANNEL="${SLACK_CHANNEL_ID:-}"
BASE="${NOTIFY_MCP_BASE:-http://localhost:3737}"
INTERVAL="${SLACK_POLL_INTERVAL:-5}"
CURSOR="$HOME/.notify-mcp/slack-cursor.txt"

if [ -z "$TOKEN" ] || [ -z "$CHANNEL" ]; then
  echo "[slack-poll] SLACK_BOT_TOKEN / SLACK_CHANNEL_ID not set (source ~/.notify-mcp/slack-config.sh)"
  exit 1
fi
[ -f "$CURSOR" ] || date +%s > "$CURSOR"
echo "[slack-poll] channel=$CHANNEL every ${INTERVAL}s -> $BASE"

while true; do
  LAST="$(cat "$CURSOR" 2>/dev/null || echo 0)"
  RESP="$(curl -s -G -H "Authorization: Bearer $TOKEN" \
    --data-urlencode "channel=$CHANNEL" --data-urlencode "oldest=$LAST" \
    --data-urlencode "limit=50" https://slack.com/api/conversations.history)"
  if [ "$(printf '%s' "$RESP" | jq -r '.ok // false')" != "true" ]; then sleep "$INTERVAL"; continue; fi
  NEWEST="$(printf '%s' "$RESP" | jq -r '[.messages[].ts] | max // empty')"
  printf '%s' "$RESP" | jq -c '.messages | sort_by(.ts) | .[] | select((.subtype==null) and (.bot_id|not) and (.app_id|not) and (.user!=null) and ((.text//"")!=""))' \
    | while IFS= read -r m; do
        TEXT="$(printf '%s' "$m" | jq -r '.text')"
        TAG=""
        if [[ "$TEXT" =~ ^@([^[:space:]]+)[[:space:]]+(.*)$ ]]; then TAG="${BASH_REMATCH[1]}"; TEXT="${BASH_REMATCH[2]}"; fi
        if [ -n "$TAG" ]; then BODY="$(jq -nc --arg t "$TEXT" --arg g "$TAG" '{text:$t,tag:$g}')"; else BODY="$(jq -nc --arg t "$TEXT" '{text:$t}')"; fi
        curl -s -X POST "$BASE/api/agent/inbox/inject" -H 'Content-Type: application/json' --data "$BODY" >/dev/null
        echo "[slack-poll] injected ${TAG:+@$TAG }$TEXT"
      done
  [ -n "$NEWEST" ] && printf '%s' "$NEWEST" > "$CURSOR"
  sleep "$INTERVAL"
done
