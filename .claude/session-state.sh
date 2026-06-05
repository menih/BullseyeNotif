#!/usr/bin/env bash
# Report this interactive session's busy/idle to the notify server so the bus
# can tell users "Claude is busy" + a rough ETA. busy on UserPromptSubmit /
# PreToolUse / PostToolUse, idle on Stop. Fire-and-forget; never blocks the turn.
EVENT="$(cat 2>/dev/null | jq -r '.hook_event_name // "UserPromptSubmit"' 2>/dev/null)"
[ -z "$EVENT" ] && EVENT="UserPromptSubmit"
_host="$(hostname 2>/dev/null | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]//g')"
_vsc="$(printf '%s' "${NOTIFY_MCP_TAG:-claude-code}" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]//g')"
TAG="${_host}-${_vsc}"
case "$EVENT" in
  Stop) BUSY=false ;;
  *)    BUSY=true ;;
esac
curl -s --max-time 2 -X POST http://localhost:3737/api/session/state \
  -H 'Content-Type: application/json' -d "{\"tag\":\"$TAG\",\"busy\":$BUSY}" >/dev/null 2>&1
exit 0
