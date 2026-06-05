# Slack Bus — multi-VSC notify-mcp architecture

One shared Slack channel is the cross-machine message bus. Every Claude Code / Copilot VSC instance on every machine connects to the same notify-mcp server and the same Slack channel, identifies itself uniquely, and the human addresses a specific one by name. The agents reply and report back through the channel.

## Why this shape

The only delivery mechanism shared by every host (Claude Code CLI, Claude VSCode extension, Copilot, Cursor) is **MCP tools** — and a tool only delivers if something CALLS it. Two host-specific shortcuts do NOT generalize:
- **Channels** (`notifications/claude/channel`) are CLI-only — dead in the VSCode extension and Copilot.
- **Hooks** (`.claude/*.sh`) are Claude-Code-only.

So the bus is built on the lowest common denominator: an HTTP inbox on the notify-mcp server, fed and drained by loops any host can run.

## Components

| Piece | Role |
|---|---|
| `ui/server.ts` (`:3737`) | The notify-mcp server. Holds the inbox (in-memory queue + SSE stream + `~/.notify-mcp/inbox/*.md` file-drops), tracks connected sessions (`/api/sessions`, `listActiveSessions`), runs all outbound channels (Slack webhook, email, …). |
| `startSlackListener` (in `ui/server.ts`) | The **central Slack bus**, folded INTO the always-on server (no separate script — #16). `pollSlackOnce` polls the channel (`conversations.history`, every 2s), ingests human messages, routes them by tag, executes bot commands, and posts ACKs/results via the webhook. Runs as long as `:3737` runs. |
| `src/index.ts` (stdio bridge) | One per VSC. Self-identifies as `<hostname>-<vsc-id>` (`vsc-id` = `NOTIFY_MCP_TAG` or the workspace folder name), subscribes to the inbox SSE for its tag, proxies the tool surface. |
| `.claude/notify-inbox-drain.sh` | Claude-Code-only Stop/UserPromptSubmit hook — surfaces inbox drops for this session's `<hostname>-<vsc-id>` tag (+ untagged) into an active session with no manual drain. |
| `notify-watch.sh` | Host-agnostic external loop — long-polls the inbox and launches an agent (`NOTIFY_AGENT_CMD`) per message; covers the idle / Copilot case. |

## Identity & addressing

Each VSC registers as **`<hostname>-<vsc-id>`** (e.g. `dell-xps-claude-code`, `dell-xps-bullseyenotify`). Set `NOTIFY_MCP_TAG` distinctly per window for unique names; unset it to default to the workspace folder.

- **`@<client> <message>`** / **`#<id> <message>`** in Slack → injected with that tag → only the matching VSC handles it.
- **untagged message** → broadcast to every connected VSC.
- **`list clients`** → the bus replies in-channel with all connected VSCs (their `<hostname>-<vsc-id>` tags). Handled centrally — it never goes to the VSCs.

## Message flow

**Inbound (human → a VSC):** Slack channel → in-server poller (`pollSlackOnce`; filters bot/webhook/system messages; parses leading `@tag`/`#id`) → `ingestInboxEntry` (origin=`slack`) → inbox → delivered to the VSC via its Stop hook (Claude Code, keyed on `<hostname>-<vsc-id>`), `wait_for_inbox` long-poll (any host), or `notify-watch.sh` (idle). The `slack`-origin file-drop carries a reply-curl instruction.

**Commands (human → the bus):** the poller intercepts known commands (`list clients`, `help`) before routing, executes them in-process (`listActiveSessions` + live SSE subscribers), and posts the result back to Slack via the incoming webhook in ≤2s.

**Outbound (a VSC → human):** the agent replies in-channel via `POST /api/agent/slack/reply {text,tag}` → `[@<tag>] …` to the channel (#20); or `notify`/`reply` → server → all configured channels, prefixed with the VSC's tag.

## Loop prevention

The poller only ingests genuine human messages: `!subtype && !bot_id && !app_id && user && text`. The bot's own webhook posts (command replies, dispatch ACKs, agent notifs) carry `bot_id`/`app_id`, so they are filtered and never re-ingested.

## Secrets

Slack creds resolve `notify-secrets.json` (git-tracked; secret values base64-encoded with a `_b64` key suffix, decoded at load by `loadSecrets`/`decodeB64Fields` so GitHub push-protection + Slack auto-revoke can't pattern-match them — #18) → env `SLACK_BOT_TOKEN`/`SLACK_CHANNEL_ID` → `~/.notify-mcp/config.json` webhook. Bot needs `channels:history` and must be `/invite`d to the channel.

## Operating it

1. Server up on `:3737` (auto-spawned by any bridge, or `npm run ui`). The Slack poller starts with it — nothing else to launch.
2. Each VSC: set `NOTIFY_MCP_TAG` for a unique name; reload the window so the bridge re-registers.
3. After editing `ui/server.ts`/`src/index.ts`: `npm run build` + relaunch `:3737` (kill the listening PID, `node dist/ui/server.js` detached) — the running build is stale until relaunched.

## Known limitations

- Cursor is in-memory with a 300s startup backfill, so a brief restart re-answers the last ~5 min of commands (closes the gap; no flood). A multi-minute outage drops anything older.
- Identity changes require the VSC window to reload (the bridge re-registers its tag on reconnect — #15).
- Agent auto-reply latency = one agent turn while active (Stop-hook surfaces the message); an idle agent needs `notify-watch.sh` running to wake it.
