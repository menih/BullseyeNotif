# Slack Bus — multi-VSC notify-mcp architecture

One shared Slack channel is the cross-machine message bus. Every Claude Code / Copilot VSC instance on every machine connects to the same notify-mcp server and the same Slack channel, identifies itself uniquely, and the human addresses a specific one by name. The agents reply and report back through the channel.

## Why this shape

The only delivery mechanism shared by every host (Claude Code CLI, Claude VSCode extension, Copilot, Cursor) is **MCP tools** — and a tool only delivers if something CALLS it. Two host-specific shortcuts do NOT generalize:
- **Channels** (`notifications/claude/channel`) are CLI-only — dead in the VSCode extension and Copilot.
- **Hooks** (`.claude/*.sh`) are Claude-Code-only.

So the bus is built on the lowest common denominator: an HTTP inbox on the notify-mcp server, fed and drained by standalone loops that any host can run.

## Components

| Piece | Role |
|---|---|
| `ui/server.ts` (`:3737`) | The notify-mcp server. Holds the inbox (in-memory queue + SSE stream + `~/.notify-mcp/inbox/*.md` file-drops), tracks connected sessions (`/api/sessions`), runs all outbound channels (Slack webhook, email, …). |
| `src/index.ts` (stdio bridge) | One per VSC. Self-identifies as `<hostname>-<vsc-id>` (`vsc-id` = `NOTIFY_MCP_TAG` or the workspace folder name), subscribes to the inbox SSE for its tag, proxies the tool surface. |
| `slack-poll.sh` | The **central Slack bus**. Polls the channel (`conversations.history`), ingests human messages, routes them by tag, and executes bot commands. One instance serves all VSCs. |
| `.claude/notify-inbox-drain.sh` | Claude-Code-only Stop/UserPromptSubmit hook — surfaces inbox messages into an active session with no manual drain. |
| `notify-watch.sh` | Host-agnostic external loop — long-polls the inbox and launches an agent (`NOTIFY_AGENT_CMD`) per message; covers the idle / Copilot case. |

## Identity & addressing

Each VSC registers as **`<hostname>-<vsc-id>`** (e.g. `dell-xps-claude-code`, `dell-xps-bullseyenotify`). Set `NOTIFY_MCP_TAG` distinctly per window for unique names; unset it to default to the workspace folder.

- **`@<client> <message>`** in Slack → injected with that tag → only the matching VSC handles it.
- **untagged message** → broadcast to every connected VSC.
- **`list clients`** → the bus replies in-channel with all connected VSCs (their `<hostname>-<vsc-id>` tags). It is handled centrally — it never goes to the VSCs.

## Message flow

**Inbound (human → a VSC):** Slack channel → `slack-poll.sh` (filters bot/webhook/system messages; parses leading `@tag`) → `POST /api/agent/inbox/inject` → inbox → delivered to the VSC via its Stop hook (Claude Code), `wait_for_inbox` long-poll (any host), or `notify-watch.sh` (idle).

**Commands (human → the bus):** `slack-poll.sh` intercepts known commands (`list clients`, `help`) before routing, executes them locally (e.g. `GET /api/sessions`), and posts the result back to Slack via the incoming webhook.

**Outbound (a VSC → human):** the agent calls `notify`/`reply` → server → Slack webhook (+ any other configured channels), prefixed with the VSC's tag.

## Loop prevention

`slack-poll.sh` only ingests genuine human messages: `select(.subtype==null and (.bot_id|not) and (.app_id|not) and .user!=null and (.text//"")!="")`. The bot's own webhook posts (command replies, agent notifs) carry `bot_id`/`app_id`, so they are filtered and never re-ingested.

## Operating it

1. Server up on `:3737` (auto-spawned by any bridge, or `npm run ui`).
2. Creds in `~/.notify-mcp/slack-config.sh`: `export SLACK_BOT_TOKEN=xoxb-…` + `export SLACK_CHANNEL_ID=C…`. Bot needs `channels:history` and must be `/invite`d to the channel.
3. Run the bus: `./slack-poll.sh` (env: `NOTIFY_MCP_BASE`, `SLACK_POLL_INTERVAL`). For persistence, run it as a service — it is not tied to any one VSC.
4. Each VSC: set `NOTIFY_MCP_TAG` for a unique name; reload the window so the bridge re-registers.

## Known limitations

- `slack-poll.sh` advances its cursor unconditionally, so a message arriving while the server is briefly down is skipped (BACKLOG #9).
- Identity changes require the VSC window to reload (the bridge re-registers its tag on reconnect).
