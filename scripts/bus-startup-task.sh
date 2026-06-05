#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_NAME="BullseyeNotify Bus Watchdog"

if command -v cygpath >/dev/null 2>&1; then
  BASH_EXE="$(cygpath -d "$(command -v bash)")"
  BUS_SCRIPT_WIN="$(cygpath -d "$ROOT/bus-up.sh")"
else
  echo "This script must run in Git Bash/MSYS (cygpath not found)."
  exit 1
fi

TR="$BASH_EXE $BUS_SCRIPT_WIN"

usage() {
  cat <<'EOF'
Usage: bash scripts/bus-startup-task.sh <install|remove|status|run>

  install  Create/overwrite logon task for current user
  remove   Delete the task if it exists
  status   Show task details (or missing)
  run      Trigger task immediately (for verification)
EOF
}

cmd="${1:-status}"

case "$cmd" in
  install)
    schtasks.exe /Create /F /SC ONLOGON /TN "$TASK_NAME" /TR "$TR"
    echo "installed: $TASK_NAME"
    ;;
  remove)
    if schtasks.exe /Query /TN "$TASK_NAME" >/dev/null 2>&1; then
      schtasks.exe /Delete /F /TN "$TASK_NAME"
      echo "removed: $TASK_NAME"
    else
      echo "not found: $TASK_NAME"
    fi
    ;;
  status)
    if schtasks.exe /Query /TN "$TASK_NAME" >/dev/null 2>&1; then
      schtasks.exe /Query /TN "$TASK_NAME" /V /FO LIST
    else
      echo "missing: $TASK_NAME"
      exit 1
    fi
    ;;
  run)
    schtasks.exe /Run /TN "$TASK_NAME"
    echo "run requested: $TASK_NAME"
    ;;
  *)
    usage
    exit 2
    ;;
esac
