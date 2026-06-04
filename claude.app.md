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
External senders reach the inbox via `POST /api/agent/inbox/inject`, `/api/slack/events`, the Telegram listener, email reply links, or **`slack-poll.sh`** — each lands in the in-memory queue, the SSE stream, AND a `~/.notify-mcp/inbox/<ts>.<tag>.md` file-drop.

**Slack channel listening (`slack-poll.sh`, multi-VSC vision):** one shared Slack channel is the cross-machine bus. `slack-poll.sh` polls `conversations.history` (bot token `xoxb-…` + channel id in `~/.notify-mcp/slack-config.sh`; cursor in `slack-cursor.txt`; only `subtype==null` human messages, bot/webhook posts filtered to avoid loops; `MSYS_NO_PATHCONV=1` so leading-`/` text isn't mangled by Git Bash) and injects each message. A message starting `@<tag> …` injects with that tag → only the VSC whose `NOTIFY_MCP_TAG` matches handles it; untagged → broadcast to every VSC. So all VSCs across all machines watch one channel, each uniquely tagged, and Meni addresses a specific VSC by `@<tag>`.

**Lowest-common-denominator principle (Meni mandate 2026-06-04):** the ONLY delivery mechanism shared by every host (Claude Code CLI, Claude VSCode extension, Copilot, Cursor) is **MCP tools** — and a tool only delivers if SOMETHING calls it. The agent does NOT self-poll when idle, so "someone must CALL the poll." Design for the LCD; never assume host-specific push.

Delivery paths and where each actually works:
1. **MCP `wait_for_inbox` long-poll** (tool-result) — works in EVERY MCP host; the cross-host primary. Caveat: the agent only self-calls it while active; an idle agent needs an external caller (path 3).
2. **`.claude/notify-inbox-drain.sh` hook** — Claude Code ONLY. Wired to UserPromptSubmit + **Stop**; on Stop it blocks with pending file-drops as the reason, surfacing messages during a continuous work loop with no manual drain. Reads `claude-code`-tagged + untagged drops. (PostToolUse is unusable — CC issues #24788/#55889 drop its injected context.)
3. **`notify-watch.sh` external loop** — host-agnostic. Standalone process that long-polls the inbox and LAUNCHES an agent (`NOTIFY_AGENT_CMD`, default `claude -p`) per message — the "someone who calls it" for the idle / away / Copilot case. Run it when NOT in an active Claude Code session (else it and the Stop hook can both grab the same message).
4. **Channels** `notifications/claude/channel` synthetic turn — ⛔ **CLI-ONLY (`claude --channels`). NOT available in the VSCode extension OR in Copilot — do NOT recommend channels for this project's runtime.** Verified against the official Channels reference: the bridge's notification shape is spec-correct, but the host never registers the listener without the CLI launch flag, so events are silently dropped here.
