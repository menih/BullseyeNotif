#!/usr/bin/env bash
# ── SHARED sync for build-less Bullseye projects (no Maven `validate` to auto-copy) ──
# Wired to SessionStart in .claude/settings.json. Pulls latest BullseyeShared and
# copies CLAUDE.md + the canonical rules.sh into this project, so they are ALWAYS
# in sync with SHARED (operator mandate 2026-05-31: "always in sync, PERIOD").
# Kept SEPARATE from rules.sh so the canonical rules.sh (which this copies in) never
# clobbers the sync logic. No output / never fails the session.

set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ_DIR="$(cd "$SELF_DIR/.." && pwd)"
SHARED="$PROJ_DIR/../BullseyeShared"

if [ -d "$SHARED/.git" ]; then
    git -C "$SHARED" pull --ff-only --quiet 2>/dev/null || true
    cp "$SHARED/CLAUDE.md" "$PROJ_DIR/CLAUDE.md" 2>/dev/null || true
    cp "$SHARED/.claude/rules.sh" "$SELF_DIR/rules.sh" 2>/dev/null || true
fi
exit 0