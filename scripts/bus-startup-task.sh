#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_NAME="BullseyeNotify Bus Watchdog"
STARTUP_DIR_WIN="$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"
STARTUP_FILE_WIN="$STARTUP_DIR_WIN\\BullseyeNotify Bus Watchdog.cmd"

if command -v cygpath >/dev/null 2>&1; then
  BASH_EXE="$(cygpath -d "$(command -v bash)")"
  BUS_SCRIPT_WIN="$(cygpath -d "$ROOT/bus-up.sh")"
else
  echo "This script must run in Git Bash/MSYS (cygpath not found)."
  exit 1
fi

TR="$BASH_EXE $BUS_SCRIPT_WIN"

install_startup_fallback() {
  mkdir -p "$(cygpath -u "$STARTUP_DIR_WIN")"
  cat >"$(cygpath -u "$STARTUP_FILE_WIN")" <<EOF
@echo off
start "" /min "$BASH_EXE" "$BUS_SCRIPT_WIN"
EOF
  echo "installed startup fallback: $STARTUP_FILE_WIN"
}

remove_startup_fallback() {
  local startup_file_unix
  startup_file_unix="$(cygpath -u "$STARTUP_FILE_WIN")"
  if [ -f "$startup_file_unix" ]; then
    rm -f "$startup_file_unix"
    echo "removed startup fallback: $STARTUP_FILE_WIN"
  fi
}

status_startup_fallback() {
  if [ -f "$(cygpath -u "$STARTUP_FILE_WIN")" ]; then
    echo "startup_fallback: present"
    echo "startup_file: $STARTUP_FILE_WIN"
    return 0
  fi
  echo "startup_fallback: missing"
  return 1
}

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
    set +e
    out="$(schtasks.exe /Create /F /SC ONLOGON /TN "$TASK_NAME" /TR "$TR" 2>&1)"
    rc=$?
    set -e
    if [ $rc -eq 0 ]; then
      echo "installed: $TASK_NAME"
    else
      echo "$out"
      if printf '%s' "$out" | grep -qi "Access is denied"; then
        echo "task scheduler denied create; falling back to Startup folder"
        install_startup_fallback
      else
        exit $rc
      fi
    fi
    ;;
  remove)
    if schtasks.exe /Query /TN "$TASK_NAME" >/dev/null 2>&1; then
      schtasks.exe /Delete /F /TN "$TASK_NAME"
      echo "removed: $TASK_NAME"
    else
      echo "not found: $TASK_NAME"
    fi
    remove_startup_fallback
    ;;
  status)
    task_ok=1
    if schtasks.exe /Query /TN "$TASK_NAME" >/dev/null 2>&1; then
      schtasks.exe /Query /TN "$TASK_NAME" /V /FO LIST
      task_ok=0
    else
      echo "missing: $TASK_NAME"
      task_ok=1
    fi
    status_startup_fallback || true
    if [ $task_ok -ne 0 ] && [ ! -f "$(cygpath -u "$STARTUP_FILE_WIN")" ]; then
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
