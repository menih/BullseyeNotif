#!/usr/bin/env bash
# UserPromptSubmit hook: surface notify-mcp inbox drops for this session (tag claude-code) + untagged broadcasts.
INBOX="$HOME/.notify-mcp/inbox"
TAG="claude-code"
[ -d "$INBOX" ] || exit 0
shopt -s nullglob
found=0
for f in "$INBOX"/*.md; do
  base="$(basename "$f" .md)"
  case "$base" in
    *.*) [ "${base##*.}" = "$TAG" ] || continue ;;
  esac
  if [ "$found" -eq 0 ]; then
    echo "📨 Full-duplex inbound delivered to this session via notify-mcp:"
    echo
    found=1
  fi
  cat "$f"
  echo
  rm -f "$f"
done
exit 0