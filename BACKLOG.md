# BullseyeNotify Backlog

**Jump:** [📊 AAG](#-at-a-glance) · [📋 Open](#-open-backlog) · [📦 Done](#-done--newest-first) · [🗄️ Archive](BACKLOG_ARCHIVE.md)

**Effort sizes:** `XS` <30m · `S` 30–90m · `M` half-day · `L` full-day+ · `XL` multi-day.

---

## 📊 AT A GLANCE

### 🎯 OUTSTANDING

| Theme / Epic | Pri | Story (effort) | % | Blocker | Headline |
|---|---|---|---|---|---|
| 🔌 Bus reliability | 🔴 P0 | [#16](#16-run-slack-dispatcher-as-an-always-on-service--l--p0) (L) | 0% |  | Dispatcher must run always-on (poller gaps = no response / 40-min delays). |
| 💬 VSC auto-reply | 🟠 P1 | [#20](#20-vsc-agent-auto-reply-in-channel--m--p1) (M) | 0% |  | VSC replies in-channel to messages directed at it (close the loop). |
| 🖥 Client identity | 🟠 P1 | [#15](#15-machine-name-in-client-list--xs--p1) (XS) | 0% | 🚧 window reload | Machine name `<hostname>-<vsc-id>` in list (bridge needs reload). |
| 🔐 Tokens in git | 🟡 P2 | [#18](#18-tokens-in-git-blocked-by-github--s--p2) (S) | 0% | 🚧 GitHub | notify-secrets.json push blocked (Slack secrets) — unblock/decide. |
| 🏗 Build/restart | 🟡 P2 | [#19](#19-buildrestart-hygiene--s--p2) (S) | 0% |  | Bridge fix needs window reload; server fix needs restart — make routine. |

### 🔄 ONGOING
_(empty — only Meni places rows here)_

### ⏳ WAITING

| Theme / Epic | Pri | Story (effort) | % | Blocker | Headline |
|---|---|---|---|---|---|
| 📲 Telegram | 🟢 P3 | [#8](#8-telegram-token-replacement--xs--p3) (XS) | — | 🚧 shelved | Revoked bot token — shelved per Meni 2026-06-04. |

---

## 📋 OPEN BACKLOG

---

### #16 Run Slack dispatcher as an always-on service · L · P0

**Problem.** `slack-poll.sh` runs as a background task tied to an agent session → GAPS (between restarts, when the agent session ends). Messages arriving during a gap get NO response (Meni: "list clients … 40 mins later, no response"). The bus MUST run continuously, independent of any agent.

**Options.** (a) Move the Slack poll + command handling INTO the always-on notify server (`ui/server.ts`) — a `setInterval` poller surviving as long as :3737 runs. (b) Install `slack-poll.sh` as a Windows service / scheduled task / auto-started terminal. (a) is cleanest — one always-on process.

**Acceptance.** A `list clients` posted at any time replies within ≤2s, no agent session required.

---

### #20 VSC agent auto-reply in-channel · M · P1

**Problem.** When a VSC receives a channel-directed message (`@<client> do X`), it reaches the agent inbox but the agent doesn't auto-reply in the channel — the user sees nothing back. Commands (`list clients`) are answered by the bus; agent-directed messages need the agent to reply.

**Scope.** When the agent handles a channel-delivered message, reply to the channel (via `notify`/webhook, tagged `[@<client>]`). Contract: bus ACKs on receipt (instant) + agent posts final answer (when done).

**Acceptance.** `@dell-xps-claude-code <task>` → bus ACK "dispatched" → agent later "[@…] done: <result>".

---

### #15 Machine name in client list · XS · P1 · 🚧 window reload

**Problem.** `list clients` shows `claude-code`, not `dell-xps-claude-code`. The bridge identity fix (`src/index.ts` → `<hostname>-<vsc-id>`) is compiled but the running bridge keeps its old tag until the Claude Code window reloads.

**Acceptance.** After window reload, `list clients` shows `dell-xps-claude-code`.

---

### #18 Tokens in git blocked by GitHub · S · P2 · 🚧 GitHub push-protection

**Problem.** `git push` of `notify-secrets.json` REJECTED by GitHub secret-scanning (Slack webhook + bot token). Repo moved to `github.com/menih/BullseyeNotif.git`. Per §11 risk accepted, but GitHub blocks.

**Options.** (a) Use the unblock URLs GitHub printed, then push. (b) Confirm repo PRIVATE (else Slack auto-revokes a pushed token → bus breaks). (c) `git remote set-url origin …BullseyeNotif.git`.

**Acceptance.** Tokens in git per Meni's intent, push succeeds, token still valid.

---

### #19 Build/restart hygiene · S · P2

**Problem.** TS fixes don't auto-take-effect: the **bridge** (`src/index.ts`) re-registers only on window reload; the **server** (`ui/server.ts`) needs a process restart. This session's bridge-identity + server-build fixes are compiled but NOT live in the running processes.

**Scope.** Document + routine: bridge change → window reload; server change → restart :3737 (kill PID + `node dist/ui/server.js`), or fold polling into the server (#16) so one restart covers it.

**Acceptance.** Documented "after you change X, do Y" + a verified-live check.

---

### #8 Telegram token replacement · XS · P3 · 🚧 SHELVED (Meni 2026-06-04)

**Shelved** per Meni — not active. Live token `8755252698:…` is revoked (`getMe`→`401`, verified). When resumed: replace `telegram.token` in `~/.notify-mcp/config.json` + `notify-secrets.json` with a fresh BotFather token; `chatId 8596060260` stays.

---

## 📦 DONE — newest first

---

### 2026-06-05 00:15 — #14 Slack bus dispatch UX (ACK / errors / numeric IDs / 2s)

**Rewrote** [slack-poll.sh](slack-poll.sh): 2s poll, process-substitution loop (replaces the pipe-subshell that was silently dropping messages), dispatch ACK ("✓ dispatched to @<tag>"), invalid-client error reply ("❌ Unknown client … Connected: …"), numeric client IDs (`#1`/`@1` or full name), @mention stripping, timestamped logging.
**Verify.** Syntax OK; logic test: numbered `1. claude-code`; resolve `#1`/`claude-code`→tag, `bogus`→empty (triggers error). NOTE: reliability/latency is **#16** (poller-as-background-task gaps), tracked separately.

---

### 2026-06-05 00:15 — #17 slack-poll cursor replay cap

**Fixed** the replay bug (poller re-injected hours of channel history when the cursor file was stale → flooded the inbox with 16 old messages). On start, [slack-poll.sh](slack-poll.sh) resets the cursor to NOW if missing or >300s stale.
**Verify.** Running poller's cursor reset to now; no further replay.

---

### 2026-06-04 23:28 — #13 Windows Defender exclusions

**Done by Meni** (admin `Add-MpPreference`). Verified via `Get-MpPreference`: ExclusionPath includes `C:\Users\menih\Desktop` (+ `.notify-mcp`, `.m2`, `Temp`, `ms-playwright`); ExclusionProcess includes `rg.exe`, `node.exe`, `bash.exe`, `git.exe`, `Code.exe`, `claude.exe`, `npm.cmd`, `tsc.cmd`, etc. — the CPU/Defender storm (rg + node) is resolved. Bonus: full JDK/Maven/Gradle/JetBrains/Python toolchain also excluded.
**Verify.** Meni's `Get-MpPreference` output shows every required path + process present.

---

### 2026-06-04 23:00 — #9 slack-poll cursor durability

**Added** a health guard at the top of [slack-poll.sh](slack-poll.sh)'s loop: `curl -sf $BASE/v1/health || continue` — if the inbox server is down, the cycle is skipped WITHOUT advancing the cursor, so messages arriving during the outage are picked up when it recovers (no silent loss).
**Verify.** `bash -n` clean; poller restarted, healthy (server up → cycles run; server down → skip+retry).

---

### 2026-06-04 23:00 — #12 Persist auth tokens in git

**Added** [notify-secrets.json](notify-secrets.json) — one git-tracked store with every token (Slack bot token + channel + webhook, Telegram, email app-password, ntfy). **Pointed** [slack-poll.sh](slack-poll.sh) at it (reads `.slack.botToken/.channelId/.webhookUrl` from the committed file, falling back to `~/.notify-mcp/slack-config.sh`/`config.json`). Per §11, risk accepted.
**Verify.** `git check-ignore notify-secrets.json` → not ignored (TRACKED); token/channel/webhook read back from the file. **Disclosed — Meni commits:** `git add notify-secrets.json && git commit`.

---

### 2026-06-04 23:00 — #11 Multi-VSC Slack-bus architecture doc

**Added** [docs/SLACK-BUS.md](docs/SLACK-BUS.md) — components (server / bridge / slack-poll.sh / hooks / notify-watch.sh), `<hostname>-<vsc-id>` identity + `@tag` routing, inbound/command/outbound flow, loop prevention, operating steps, known limits.
**Verify.** File written; matches the shipped implementation.

---

### 2026-06-04 22:50 — #10 Slack `list clients` command + bridge `<hostname>-<vsc-id>` identity

**Added** a command interceptor to [slack-poll.sh](slack-poll.sh): `list clients` / `help` are executed centrally (query `/api/sessions`, post result to Slack via webhook) instead of routed to a VSC — "handled by the MCP side, replies right there." **Changed** the bridge ([src/index.ts:36](src/index.ts)) to self-identify as `<hostname>-<vsc-id>` (vsc-id = `NOTIFY_MCP_TAG` or the workspace folder name) instead of hardcoded `claude-code`.
**Verify.** `list clients` posted "Connected clients: claude-code" into the channel (live, observed). Bridge `tsc` exit 0; identity logic prints `dell-xps-claude-code` (or `dell-xps-bullseyenotify` if `NOTIFY_MCP_TAG` unset). **Disclosed — running bridge keeps `claude-code` until the Claude Code window is reloaded** (bridge re-registers its tag on reconnect); set `NOTIFY_MCP_TAG` per window for unique names.

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
