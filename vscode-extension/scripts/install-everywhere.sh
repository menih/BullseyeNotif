#!/usr/bin/env bash
# Thin shim → BullseyeShared/scripts/vscode-extension/install-everywhere.sh.
# The real logic is shared across every Bullseye VS Code extension; this stub
# keeps the original entry-point path (npm `postpackage`, release.sh) working
# and passes this extension's dir. Override location with BULLSEYE_SHARED.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SHARED="${BULLSEYE_SHARED:-}"
if [ -z "$SHARED" ]; then
  for cand in "$SCRIPT_DIR/../../../BullseyeShared" "$SCRIPT_DIR/../../BullseyeShared"; do
    [ -d "$cand/scripts/vscode-extension" ] && SHARED="$(cd "$cand" && pwd)" && break
  done
fi
if [ -z "$SHARED" ] || [ ! -f "$SHARED/scripts/vscode-extension/install-everywhere.sh" ]; then
  echo "✗ BullseyeShared not found next to this repo. Set BULLSEYE_SHARED to its path." >&2
  exit 1
fi
exec bash "$SHARED/scripts/vscode-extension/install-everywhere.sh" "$EXT_DIR" "$@"
