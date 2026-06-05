#!/usr/bin/env bash
set -u
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
[ -f "$HOME/.notify-mcp/slack-config.sh" ] && source "$HOME/.notify-mcp/slack-config.sh"
SECRETS="$(cd "$(dirname "$0")" && pwd)/notify-secrets.json"
TOKEN="${SLACK_BOT_TOKEN:-}"; CHANNEL="${SLACK_CHANNEL_ID:-}"
[ -z "$TOKEN" ] && [ -f "$SECRETS" ] && TOKEN="$(jq -r '.slack.botToken // empty' "$SECRETS")"
[ -z "$CHANNEL" ] && [ -f "$SECRETS" ] && CHANNEL="$(jq -r '.slack.channelId // empty' "$SECRETS")"
BASE="${NOTIFY_MCP_BASE:-http://localhost:3737}"
INTERVAL="${SLACK_POLL_INTERVAL:-2}"
CURSOR="$HOME/.notify-mcp/slack-cursor.txt"

if [ -z "$TOKEN" ] || [ -z "$CHANNEL" ]; then echo "[slack-poll] missing SLACK_BOT_TOKEN / SLACK_CHANNEL_ID"; exit 1; fi
NOW=$(date +%s); CUR=$(cut -d. -f1 "$CURSOR" 2>/dev/null); [ -z "$CUR" ] && CUR=0
[ $((NOW - CUR)) -gt 300 ] && echo "$NOW" > "$CURSOR"
log() { echo "[slack-poll $(date '+%H:%M:%S')] $*"; }
log "channel=$CHANNEL every ${INTERVAL}s -> $BASE"

slack_post() {
  local hook; hook="$(jq -r '.slack.webhookUrl // empty' "$SECRETS" 2>/dev/null || true)"
  [ -z "$hook" ] && hook="$(jq -r '.slack.webhookUrl // empty' "$HOME/.notify-mcp/config.json" 2>/dev/null || true)"
  [ -n "$hook" ] && curl -s -X POST "$hook" -H 'Content-Type: application/json' --data "$(jq -nc --arg t "$1" '{text:$t}')" >/dev/null
}
clients_raw() { curl -s --max-time 4 "$BASE/api/sessions" | jq -r '[.sessions[] | select(.tag != null and .tag != "") | .tag] | unique | .[]'; }
clients_numbered() { clients_raw | nl -w1 -s'. '; }
resolve_client() {
  local h="$1" list; list="$(clients_raw)"
  if printf '%s' "$h" | grep -qE '^[0-9]+$'; then printf '%s\n' "$list" | sed -n "${h}p"; else printf '%s\n' "$list" | grep -Fx -- "$h"; fi
}
handle_command() {
  case "$1" in
    "list clients"|"clients"|"list")
      local n; n="$(clients_numbered)"; [ -z "$n" ] && n="(none connected)"
      slack_post "$(printf 'Connected clients — reply with @<name> or #<id>:\n%s' "$n")"; return 0 ;;
    "help"|"commands"|"?")
      slack_post "Commands: \`list clients\`. Direct a client: \`@<name> your message\` or \`#<id> your message\`."; return 0 ;;
  esac
  return 1
}

while true; do
  curl -s -o /dev/null --max-time 4 "$BASE/v1/health" || { sleep "$INTERVAL"; continue; }
  LAST="$(cat "$CURSOR" 2>/dev/null || echo 0)"
  RESP="$(curl -s --max-time 8 -G -H "Authorization: Bearer $TOKEN" --data-urlencode "channel=$CHANNEL" --data-urlencode "oldest=$LAST" --data-urlencode "limit=50" https://slack.com/api/conversations.history)"
  [ "$(printf '%s' "$RESP" | jq -r '.ok // false')" = "true" ] || { sleep "$INTERVAL"; continue; }
  NEWEST="$(printf '%s' "$RESP" | jq -r '[.messages[].ts] | max // empty')"
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    TEXT="$(printf '%s' "$m" | jq -r '.text')"
    LC="$(printf '%s' "$TEXT" | sed -E 's/<@[A-Za-z0-9]+>//g' | tr 'A-Z' 'a-z' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    if handle_command "$LC"; then log "cmd: $LC"; continue; fi
    CLEAN="$(printf '%s' "$TEXT" | sed -E 's/<@[A-Za-z0-9]+>//g; s/^[[:space:]]+//')"
    if [[ "$CLEAN" =~ ^[@#]([^[:space:]]+)[[:space:]]+(.*)$ ]]; then
      HANDLE="${BASH_REMATCH[1]}"; MSG="${BASH_REMATCH[2]}"
      TAGM="$(resolve_client "$HANDLE")"
      if [ -z "$TAGM" ]; then
        slack_post "$(printf '❌ Unknown client "%s". Connected:\n%s' "$HANDLE" "$(clients_numbered)")"; log "unknown client: $HANDLE"; continue
      fi
      curl -s -X POST "$BASE/api/agent/inbox/inject" -H 'Content-Type: application/json' --data "$(jq -nc --arg t "$MSG" --arg g "$TAGM" '{text:$t,tag:$g}')" >/dev/null
      slack_post "✓ dispatched to @${TAGM}: \"${MSG}\""; log "dispatched @$TAGM: $MSG"
    else
      curl -s -X POST "$BASE/api/agent/inbox/inject" -H 'Content-Type: application/json' --data "$(jq -nc --arg t "$TEXT" '{text:$t}')" >/dev/null
      log "broadcast: $TEXT"
    fi
  done < <(printf '%s' "$RESP" | jq -c '.messages | sort_by(.ts) | .[] | select((.subtype==null) and (.bot_id|not) and (.app_id|not) and (.user!=null) and ((.text//"")!=""))')
  [ -n "$NEWEST" ] && printf '%s' "$NEWEST" > "$CURSOR"
  sleep "$INTERVAL"
done
