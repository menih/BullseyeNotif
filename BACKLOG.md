# BullseyeNotify Backlog

**Jump:** [📊 AAG](#-at-a-glance) · [📋 Open](#-open-backlog) · [📦 Done](#-done--newest-first) · [🗄️ Archive](BACKLOG_ARCHIVE.md)

**Effort sizes:** `XS` <30m · `S` 30–90m · `M` half-day · `L` full-day+ · `XL` multi-day.

---

## 📊 AT A GLANCE

### 🎯 OUTSTANDING

| Theme / Epic | Pri | Story (effort) | % | Blocker | Headline |
|---|---|---|---|---|---|
| 📲 Telegram | 🟢 P3 | [#8](#8-telegram-token-replacement--xs--p3) (XS) | 0% | 🚧 needs BotFather token | Replace revoked bot token in config. |

### 🔄 ONGOING
_(empty — only Meni places rows here)_

### ⏳ WAITING
_(empty — only Meni places rows here)_

---

## 📋 OPEN BACKLOG

---

### #8 Telegram token replacement · XS · P3 · 🚧 needs BotFather token

**Scope.** Live token `8755252698:…` is revoked — `getMe` returns `401 Unauthorized` (verified). Replace `telegram.token` in `~/.notify-mcp/config.json` with a fresh BotFather token; `chatId 8596060260` stays.

**Blocker.** Needs Meni to mint a new token via BotFather (`/token` or `/revoke`→new) — external.

---

## 📦 DONE — newest first

---

### 2026-06-04 22:21 — #7 Slack inbound poller (multi-VSC → one channel)

**Added** [slack-poll.sh](slack-poll.sh) — polls the shared Slack channel via `conversations.history` (bot token + channel id in `~/.notify-mcp/slack-config.sh`, cursor in `slack-cursor.txt`) and injects human messages into the notify-mcp inbox, routing `@<tag> …` to that VSC's `NOTIFY_MCP_TAG` (untagged → broadcast). Reuses the verified inbox → hook/loop/wait delivery. Filters bot/webhook/system messages (`subtype==null and bot_id|not and app_id|not`) to prevent loops; `MSYS_NO_PATHCONV=1` fixes Git-Bash mangling of leading-`/` text. Creds stored in `~/.notify-mcp/slack-config.sh` (chmod 600). Running live (cursor=now).
**Verify (IT-mandate §4).** `auth.test`→`ok:true` (bot `yaroksoft`@AlphaWave); `conversations.history`→`ok:true` (channel `C0B1W7NKKFS` readable, in-channel). Dry-parse extracted human messages, filtered joins/bots. End-to-end: fetched a real Slack msg → injected (tag `slacktest`) → drained → matched. MSYS fix confirmed: `/run the build now and fix /etc/hosts` round-trips intact (was mangled to `C:/Program Files/Git/…` pre-fix). **Live-loop demo pending** one human post in the channel.

---

### 2026-06-04 19:41 — #6 ui MCP_INSTRUCTIONS LCD coverage (no edit)

**Verified** the HTTP server's `MCP_INSTRUCTIONS` ([ui/server.ts:1610](ui/server.ts)) rule 6 already establishes `wait_for_inbox` as the most-reliable cross-host delivery path and states SSE/channel notifications are silently dropped. No edit needed — adding one would be gratuitous churn (§4 smallest-change).
**Verify.** Read lines 1706–1714; LCD long-poll guidance present.

---

### 2026-06-04 19:41 — #5 Fix ui/server.ts build break

**Fixed** the red `npm run build`: added the three missing imports to [ui/server.ts](ui/server.ts) (`z` from zod, `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StreamableHTTPServerTransport` from `…/streamableHttp.js`) and declared `const ENABLE_MCP = (process.env.ENABLE_MCP ?? "").trim() === "1"` — an existing intentional gate (src/index.ts:74 spawns the UI with `ENABLE_MCP: "1"`; the /mcp endpoint has "Set ENABLE_MCP=1" messages), just never declared. Not a new gate (§4 OK).
**Verify.** `npm run build` → exit 0 (both `tsc` + `tsc -p ui/tsconfig.json` clean). Import paths confirmed via `require.resolve`.

---

### 2026-06-04 19:41 — #4 Document delivery design in claude.app.md

**Replaced** the "Full-duplex inbound" section of [claude.app.md](claude.app.md): channels marked ⛔ CLI-ONLY (dead in the VSCode extension + Copilot — never recommend for this runtime), the lowest-common-denominator principle ("someone must CALL the poll"; MCP tools are the only shared mechanism), and the dual design (Stop hook for Claude Code active loop + `notify-watch.sh` external loop for idle/Copilot).
**Verify.** Section rewritten; channels demoted with verified-against-spec note.

---

### 2026-06-04 19:25 — #3 notify-watch.sh external launcher loop

**Added** [notify-watch.sh](notify-watch.sh) — standalone loop that is the external "someone who calls it": long-polls `/api/agent/inbox/wait` (50s) and launches a handler (`claude -p` default, `NOTIFY_AGENT_CMD`-configurable) per message. Covers the idle / away / Copilot case where hooks (Claude-only) and channels (CLI-only) can't fire. Env-configurable; executable.
**Verify.** `bash -n notify-watch.sh` clean. **Not fully verified — needs** a live run + injected message to confirm the handler launches (test steps handed to Meni).

---

### 2026-06-04 19:25 — #2 LCD: MCP instructions reframed to wait_for_inbox long-poll

**Replaced** the channels-first framing in the stdio bridge's MCP `instructions` ([src/index.ts:192](src/index.ts)) with a wait_for_inbox-long-poll-first framing. Both Claude Code and Copilot inject this into the agent's system prompt.
**Verify.** `npm run build` exit 0 → `dist/index.js` emitted. **Disclosed — takes effect on MCP reconnect/session restart**, not mid-session.

---

### 2026-06-04 19:25 — #1 Auto-delivery via Stop hook

**Replaced** [.claude/notify-inbox-drain.sh](.claude/notify-inbox-drain.sh) to branch on hook event (Stop → `decision:block` + pending drops as reason; UserPromptSubmit → `additionalContext`) and **wired it into the Stop event** in [.claude/settings.json](.claude/settings.json). Fixes the bug where the drain only ran on UserPromptSubmit and never fired during a continuous work loop. PostToolUse deliberately avoided (CC #24788/#55889 drop its context).
**Verify.** VERIFIED live — 3 pending messages auto-surfaced via the Stop hook with zero manual draining; 4 unit cases pass.

---

### 2026-06-04 19:25 — Diagnostics (no code) — Telegram + Channels

**Telegram:** token `8755252698:…` revoked — `getMe`→`401` (verified curl). Fix tracked in #8.
**Channels:** verified against the official Channels reference — `notifications/claude/channel` is CLI-only (`--channels`), unavailable in the VSCode extension + Copilot; bridge notification shape is spec-correct. Drove the LCD pivot (#2, #3).
