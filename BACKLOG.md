# BullseyeNotify Backlog

**Jump:** [📊 AAG](#-at-a-glance) · [📋 Open](#-open-backlog) · [📦 Done](#-done--newest-first) · [🗄️ Archive](BACKLOG_ARCHIVE.md)

**Effort sizes:** `XS` <30m · `S` 30–90m · `M` half-day · `L` full-day+ · `XL` multi-day.

---

## 📊 AT A GLANCE

### 🎯 OUTSTANDING

_(empty)_

### 🔄 ONGOING
_(empty — only Meni places rows here)_

### ⏳ WAITING

| Theme / Epic | Pri | Story (effort) | % | Blocker | Headline |
|---|---|---|---|---|---|
| 📲 Telegram | 🟢 P3 | [#8](#8-telegram-token-replacement--xs--p3) (XS) | — | 🚧 shelved | Revoked bot token — shelved per Meni 2026-06-04. |

---

## 📋 OPEN BACKLOG

---

### #8 Telegram token replacement · XS · P3 · 🚧 SHELVED (Meni 2026-06-04)

**Shelved** per Meni — not active. Live token `8755252698:…` is revoked (`getMe`→`401`, verified). When resumed: replace `telegram.token` in `~/.notify-mcp/config.json` + `notify-secrets.json` with a fresh BotFather token; `chatId 8596060260` stays.

---

## 📦 DONE — newest first

---

### 2026-06-08 14:03 — #33 integration coverage for clients endpoints

**Added** (§7.5 coverage for #29/#31) 3 integration tests to [tests/smoke.test.mjs](tests/smoke.test.mjs) — real HTTP, no mocks: `/api/clients` lists a tagged session with `name`+`kinds`; rename sets + clears a persisted alias; reconnect drops ≥1 connection. **Config isolated** ([ui/server.ts](ui/server.ts)): `CONFIG_DIR` honors `NOTIFY_MCP_CONFIG_DIR`; the test points it at a `mkdtempSync` dir (sim/live separation, same pattern as #32) so rename never touches the live `~/.notify-mcp`.

**Verify (verified).** `node --test tests/smoke.test.mjs` → **10/10 pass, EXIT=0**. Real `~/.notify-mcp/config.json` `clientAliases` stayed `{}` after the run (no pollution); temp dirs cleaned up (0 leftover).

---

### 2026-06-08 13:52 — #32 isolate test inbox drops (sim/live separation)

**Found via slack-bus fallout.** Pre-#28 broken smoke runs (no waiter parked) injected `hello from test` via `/__test__/inject-inbox` → `writeInboxDrop` wrote to the SHARED `~/.notify-mcp/inbox/` dir the live hook/bridge read → 6 test pings surfaced to the live agent; a leaked test server (live slack poller, port 59528) even hijacked a real Slack message. #28 stops the leak in practice (green tests park waiters → no drop), but per the hard sim/live rule a test must NEVER touch the live inbox. **Fixed** ([ui/server.ts:1246](ui/server.ts#L1246)): `INBOX_DROP_DIR` → `~/.notify-mcp/inbox-test` when `NOTIFY_MCP_TEST_ENDPOINTS=1`, else the live `inbox`.

**Verify.** Build clean; smoke 7/7 still green; a smoke run leaves the live `~/.notify-mcp/inbox/` untouched (any drop lands in `inbox-test`). Also handled the live request that arrived over the bus mid-session — *"invalidate all clients and let them reconnect"* → invalidated both clients (9 connections dropped), both reconnected, replied in-channel `{ok:true}`.

---

### 2026-06-08 13:46 — #30 watchdog redeploy fixed (silent taskkill failure)

**Root cause (deeper than first thought).** `bus-up.sh` sets `MSYS_NO_PATHCONV=1`, which stops Git-Bash collapsing `//F`→`/F`, so `taskkill //F //PID` got the literal `//F` → `ERROR: Invalid argument/option - '//F'`. The kill **silently failed every redeploy** (output was `>/dev/null`), so the old listener kept `:3737`, the relaunch `EADDRINUSE`-crashed, and "auto-redeploy on build" (#22) never actually swapped the process — the manual kills I needed 3× this turn. **Fixed** ([bus-up.sh](bus-up.sh)): single-slash `taskkill /F /PID` (correct under `MSYS_NO_PATHCONV=1`); added a `port_listening` helper + wait-until-`:3737`-free (≤10s) before relaunch + verify-bind-or-log-`FAILED` loop (replacing the blind `sleep 1`/`sleep 4`).

**Verify (verified).** Confirmed `MSYS_NO_PATHCONV=1 taskkill //F //PID` errors but `/F /PID` succeeds. Single-watchdog redeploy (touch build → detect): **PID 69100 → 35588, 0 EADDRINUSE, clean "Claude Notify config UI" startup, 1 server + 1 watchdog**. (Earlier double-`(re)started` was a transient two-watchdog state from my manual restarts — cleaned to one.)

---

### 2026-06-08 13:34 — #31 Clients tab: Rename + Invalidate buttons

**Added** (Meni: *"Add button in clients - 1) rename, 2) invalidate (can we force reconnect?)"*) per-client row buttons. **Yes, force-reconnect works.** **Rename** → `POST /api/clients/:tag/rename {name}` ([ui/server.ts](ui/server.ts)) persists a `clientAliases[tag]=name` map in `~/.notify-mcp/config.json` (survives restart); applied to `/api/clients`, `list clients` (`slackClientsNumbered`), and `resolveSlackClient` (so `@alias` routes to the original tag's subscribers); blank name clears it. **Invalidate** → `POST /api/clients/:tag/reconnect` closes the tag's MCP transports (next request 404s → bridge reinits), ends SSE streams (subscriber reconnects), and resolves waiters (long-poll re-issues) — all auto-reconnect. **UI:** `renameClient`/`reconnectClient` ([app.js](ui/public/app.js), prompt/confirm + toast), button styles ([style.css](ui/public/style.css)).

**Verify (verified).** `curl` cycle: `/api/clients` carries `name`; rename bot→`watch-bot` reflected in `/api/clients` + persisted to `config.json` (`{"dell-xps-bullseyenotify-bot":"watch-bot"}`); reconnect → `{closed:1}`; clear → `{}` on disk (state restored clean). Headless Chrome @390px: 2 Rename + 2 Invalidate buttons render, row layout clean (badges line 1, buttons right, meta line 2), 0 JS errors. Live on `:3737`; ships in npm on next publish.

---

### 2026-06-08 13:25 — #29 "Clients" tab in the web UI

**Added** (Meni: *"add 'clients' tab next to activity logs"*) a **Clients** tab beside Activity Log in the config UI. **New endpoint** `GET /api/clients` ([ui/server.ts](ui/server.ts)) returns the unified live-client set the Slack `list clients` reports — tagged MCP sessions + live SSE subscribers + parked long-poll waiters (incl. the `-bot` responder, which `/api/sessions` misses), aggregated by tag with kinds/host/workspace/lastSeen, after `pruneDeadSessions()`. **UI:** tab switcher ([index.html](ui/public/index.html)), `selectPanelTab`/`refreshClients` with 3s auto-refresh + HTML-escaped rows + per-client status dot/kind badges/tooltip ([app.js](ui/public/app.js)), styles matching the pills/log theme ([style.css](ui/public/style.css)). Fixed an initial CSS bug (tag broke one-char-per-line under `word-break:break-all` in the flex row → `nowrap`+ellipsis+`min-width:0`).

**Verify (verified).** Headless Chrome @390px (mobile, §7.1): tabs render `ACTIVITY LOG | CLIENTS`, 0 JS errors; two rows — `dell-xps-bullseyenotify` (MCP+SSE, bridge·127.0.0.1·seen 0s) and `dell-xps-bullseyenotify-bot` (WAITER) — no `claude-code`, no overflow. `curl /api/clients` returns the same set. Static UI served from `ui/public` (live on `:3737` now); ships in npm package on next publish.

---

### 2026-06-08 13:05 — #28 fixed broken smoke suite (two pre-existing bugs)

**Both root causes pre-existed this turn's product code.** (1) `/mcp` is gated behind `ENABLE_MCP=1` ([ui/server.ts:2350](ui/server.ts#L2350)); the live bus passes it but the test's `startServer` ([tests/smoke.test.mjs](tests/smoke.test.mjs)) didn't → test server 404'd every `/mcp` request → 6/7 failed. **Fixed:** `startServer` launches with `ENABLE_MCP: "1"`. (2) The full server starts the live Slack + Telegram pollers (real creds from `notify-secrets.json`, 300s backfill), so **real channel messages were injected into the test inbox** → `wait_for_inbox` tests (#3/#4) flaked on whatever was in the channel. **Fixed (sim/live separation):** [ui/server.ts](ui/server.ts) skips `startTelegramListener`/`startSlackListener` when `NOTIFY_MCP_TEST_ENDPOINTS=1`. Diagnosed by proving bridge + live server work standalone while the harness failed identically serialized + concurrent (→ config, not regression), then the inbox-only failures pointing at live-poller pollution.

**Verify (verified).** `node --test tests/smoke.test.mjs` → **7/7 pass, 0 fail, EXIT=0**.

---

### 2026-06-08 13:12 — published omni-notify-mcp@1.3.12 (ships the naming fix)

**Published** (Meni: *"publish it"*) via `release.sh` (patch bump 1.3.11→1.3.12): npm `omni-notify-mcp@1.3.12` + marketplace `MeniHillel.omni-notify-mcp-menihillel@1.3.12`, both OK. This carries the #25 bridge `deriveVscId` fix to the published `npx -y omni-notify-mcp` bridge (picked up on its next launch). **Note:** version files (`package.json`, `vscode-extension/package.json`) are bumped + uncommitted — Meni commits.

---

### 2026-06-08 12:52 — #27 deleted banned pure-logic test (§7.0)

**Deleted** `tests/notification-engine.test.mjs` — a pure-function test (`computeDesktopOnlyMode` + hand-built fixtures + `assertEquals`, no real boundary), banned by §7.0 (Meni 2026-06-04: only integration tests). `computeDesktopOnlyMode` stays — it is production logic ([notificationEngine.ts:84](ui/messaging/notificationEngine.ts#L84)); only the useless test goes. The real integration coverage ([tests/smoke.test.mjs](tests/smoke.test.mjs) — spawns a live server + bridge, wire-level) is kept.

**Verify.** `node --test tests/smoke.test.mjs` runs the remaining integration suite (result below in the same turn).

---

### 2026-06-08 12:45 — #25 client names by folder/workspace, never "claude-code"

**Root cause (no AI naming exists).** Bus tags are `<hostname>-<vsc-id>`. The visible `dell-xps-claude-code` came from [notify-watch.sh](notify-watch.sh) — the headless auto-responder hardcoded its suffix `${_host}-claude-code`. **Fixed:** derives the suffix from the responder's own project folder → `dell-xps-bullseyenotify-bot` (workspace-aligned, distinct from the interactive bridge so tagged routing to `@bullseyenotify` still reaches the window, no collision). **Also hardened** the bridge ([src/index.ts](src/index.ts)): `deriveVscId()` skips a denylist of generic launcher/tool/system dirs (`claude-code`, `claude`, `code`, `cursor`, `vscode`, `bin`, `dist`, `src`, `node_modules`, …) and walks up to the nearest meaningful folder when `NOTIFY_MCP_TAG` is unset.

**Verify.** `deriveVscId` table: `…/BullseyeNotify`→`bullseyenotify`, `…/BullseyeNotify/dist`→`bullseyenotify` (skips dist), `…/Programs/claude-code`→skips claude-code, explicit tag wins — all pass. Live: `notify-watch.log` → `tag=dell-xps-bullseyenotify-bot`; `server.log` inbox/wait polls now `-bot`; `/api/sessions` SSE tags = only `dell-xps-bullseyenotify`; npx `claude-code` bridge gone. `dist/index.js` carries `deriveVscId`. **Note:** the bridge fix lands for the published `npx` bridge only on a republish (`release.sh`); local `dist` bridges on reload.

---

### 2026-06-08 12:45 — #24 Slack ack only when a live session is listening

**Mandate (Meni):** *"only show [the ack] if there are active sessions with slack. Detect session idle and make sure sessions are expired if there is no activity."* **Fixed** in [ui/server.ts](ui/server.ts): `pollSlackOnce` posted `"ack"` unconditionally — now gated on `liveListenerCount(tag) > 0` (live SSE + parked waiters + MCP sessions) for both tagged and untagged paths; with zero listeners the entry still queues but no misleading ack posts. **Accuracy:** new count helpers call `pruneDeadSessions()` first; `slackClientTags()` now prunes dead MCP sessions + filters dead SSE sockets, so the gate and `list clients` reflect only live agents. The 90s MCP reaper + 15s SSE prune already expire idle sessions; this wires that liveness into the ack decision.

**Verify (verified).** `npm run build` clean; watchdog redeployed `:3737` (PID 4632) on the new build, boots clean (no slack:error/EADDRINUSE in `server.log`); compiled `dist/ui/server.js` carries `liveListenerCount` + both gates (lines 1743/1748). **Operator-verify (disclosed — needs a real channel post in each state):** post in the Slack bus with an agent connected → `ack` appears; disconnect all agents (close the window, wait >90s) and post → no `ack`, message still queued for the next connector.

---

### 2026-06-08 12:45 — #26 notify-watch.sh self-singleton (no double-answers)

**Found while fixing #25.** The watchdog's `ps | grep` dedup ([bus-up.sh:42](bus-up.sh#L42)) races at the 45s long-poll boundary. **Fixed:** [notify-watch.sh](notify-watch.sh) now claims a `.run/notify-watch.pid` singleton (mirrors [bus-up.sh:7-12](bus-up.sh#L7-L12)) and `trap`s cleanup on EXIT; a second launch self-exits.

**Verify (verified).** Forced double-launch: first → `started — tag=dell-xps-bullseyenotify-bot`; second → `another instance alive (…) — exiting`. Steady-state one real responder (the extra `notify-watch.sh`-matching PID is its own read-loop child subshell, parent = the responder — not a duplicate).

