# BullseyeNotify — App-Specific Bindings (BN)

Shared engineering + workflow rules live in `CLAUDE.md` (auto-synced from `../BullseyeShared` by the SessionStart `.claude/sync-shared.sh` hook; gitignored; never edit it here). TATOO short-name: **BN**. This file holds ONLY BullseyeNotify-specific bindings.

## Platform deviation — NOT on the Java/Vaadin baseline
BullseyeNotify (npm `omni-notify-mcp`) is the one Bullseye project that does NOT follow `PLATFORM.md` — no JDK / Spring / Vaadin / Maven. It is a **Node 18+ / TypeScript** MCP notification server.
- Shared-currency is kept by the **SessionStart `.claude/sync-shared.sh` hook** (copies `CLAUDE.md` + `.claude/rules.sh` from `../BullseyeShared`), not a Maven `validate` antrun. There are no `bullseye-*` libs to `mvn install`.
- Build: `npm run build` — `tsc` (`src/` → `dist/`) then `tsc -p ui/tsconfig.json` (`ui/` → `dist/ui/`).

## Architecture
- `src/index.ts` → `dist/index.js` — stdio MCP bridge (`omni-notify-mcp` bin). Declares the `claude/channel` capability, auto-spawns the UI server, subscribes to the inbox SSE. Registered in Claude Code (user scope) as stdio `node .../BullseyeNotify/dist/index.js`, env `NOTIFY_MCP_TAG=claude-code`.
- `ui/server.ts` → `dist/ui/server.js` — HTTP/UI server on `:3737`; all channel impls; the Streamable-HTTP `/mcp` endpoint; the inbound inbox.

## Full-duplex inbound (any sender → this running session)
External senders reach the inbox via `POST /api/agent/inbox/inject`, `/api/slack/events`, the Telegram listener, or email reply links. Delivery into a running Claude session, most-reliable first:
1. **MCP `wait_for_inbox`** long-poll tool-result (when the notify MCP is connected to the session).
2. **Channels** `notifications/claude/channel` synthetic turn (launch Claude Code with `--channels`).
3. **File-drop hook** — the server drops `~/.notify-mcp/inbox/<ts>.<tag>.md`; the `.claude/notify-inbox-drain.sh` UserPromptSubmit hook surfaces this session's (`claude-code`) + untagged drops on the next turn.
