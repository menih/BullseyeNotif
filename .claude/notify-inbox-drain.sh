#!/usr/bin/env bash
# Auto-surface notify-mcp inbox drops to the agent, scoped to this session
# (tag claude-code + untagged broadcasts). Two injection points:
#   - UserPromptSubmit: emit hookSpecificOutput.additionalContext (reliable).
#   - Stop: block the stop and deliver pending messages as the reason, so
#     out-of-band messages reach the agent DURING a continuous work loop
#     (Stop fires every time the agent tries to end a turn).
# PostToolUse is deliberately NOT used: its context-injection is broken in
# Claude Code (issues #24788 / #55889 — additionalContext is dropped).
INBOX="$HOME/.notify-mcp/inbox"
# This session's tag = <hostname>-<vsc-id>, mirroring src/index.ts SESSION_TAG so
# drops the bus routes to this VSC (e.g. dell-xps-claude-code) actually surface.
_host="$(hostname 2>/dev/null | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]//g')"
_vsc="$(printf '%s' "${NOTIFY_MCP_TAG:-claude-code}" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]//g')"
TAG="${_host}-${_vsc}"

PAYLOAD="$(cat 2>/dev/null)"
EVENT="$(printf '%s' "$PAYLOAD" | jq -r '.hook_event_name // empty' 2>/dev/null)"
[ -z "$EVENT" ] && EVENT="UserPromptSubmit"

# Report this session busy/idle to the bus so it can say "Claude is busy" + ETA.
# Folded in here (an already-active hook) so it works with no window reload.
case "$EVENT" in Stop) _BUSY=false ;; *) _BUSY=true ;; esac
curl -s --max-time 2 -X POST http://localhost:3737/api/session/state \
  -H 'Content-Type: application/json' -d "{\"tag\":\"$TAG\",\"busy\":$_BUSY}" >/dev/null 2>&1 &

# Consume ONLY on events whose hook output Claude Code actually surfaces:
# UserPromptSubmit + SessionStart inject additionalContext; Stop delivers via
# decision:block. PreToolUse/PostToolUse output is DISCARDED (#24788/#55889) —
# draining there deletes the drop without delivering it. Skip them so the next
# Stop (fires at every turn end) delivers the message intact.
case "$EVENT" in
  UserPromptSubmit|Stop|SessionStart) ;;
  *) exit 0 ;;
esac

[ -d "$INBOX" ] || exit 0
shopt -s nullglob

msgs=""
for f in "$INBOX"/*.md; do
  base="$(basename "$f" .md)"
  case "$base" in
    *.*) [ "${base##*.}" = "$TAG" ] || continue ;;
  esac
  msgs+="$(cat "$f")"$'\n\n'
  rm -f "$f"
done

[ -z "$msgs" ] && exit 0

header="📨 Unsolicited message(s) auto-delivered to THIS session via notify-mcp (surfaced by the hook — NOT drained manually). Respond before continuing:"
body="${header}"$'\n\n'"${msgs}"

case "$EVENT" in
  Stop)
    jq -n --arg r "$body" '{decision:"block", reason:$r}'
    ;;
  *)
    jq -n --arg c "$body" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit", additionalContext:$c}}'
    ;;
esac
exit 0
