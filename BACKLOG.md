# BullseyeNotify Backlog

**Jump:** [📊 AAG](#-at-a-glance) · [📋 Open](#-open-backlog) · [📦 Done](#-done--newest-first) · [🗄️ Archive](BACKLOG_ARCHIVE.md)

**Effort sizes:** `XS` <30m · `S` 30–90m · `M` half-day · `L` full-day+ · `XL` multi-day.

---

## 📊 AT A GLANCE

### 🎯 OUTSTANDING

| Theme / Epic | Pri | Story (effort) | % | Blocker | Headline |
|---|---|---|---|---|---|
| 🖥️ Clients | 🟠 P1 | [#36](#36-vsc-level-client--per-panel-reply-id--s--p1) (S) | 0% | — | Client = VSC (broadcast to all panels); each panel tags its replies with a Panel ID. Fix located: [ui/server.ts:2106](ui/server.ts#L2106). |
| 🔔 Notify | 🟡 P2 | [#40](#40-normal-priority-notifs-must-still-reach-vsc_notif--s--p2) (S) | 0% | — | Normal-priority notifs idle-gated when active — ensure they still reach vsc_notif. |
| 🔔 Notify | 🟡 P2 | [#38](#38-bridge-misreports-delivered-as-n-chunks--s--p2) (S) | 0% | — | Bridge says "Delivered as N chunks" even when server delivered nothing. |
| 🖥️ Clients | 🟡 P2 | [#39](#39-investigate-duplicate--orphan-sessions-per-window--s--p2) (S) | 0% | — | 3 live bridges for 2 windows — investigate orphan/duplicate sessions. |

### 🔄 ONGOING
_(empty — only Meni places rows here)_

### ⏳ WAITING

| Theme / Epic | Pri | Story (effort) | % | Blocker | Headline |
|---|---|---|---|---|---|
| 📲 Telegram | 🟢 P3 | [#8](#8-telegram-token-replacement--xs--p3) (XS) | — | 🚧 shelved | Revoked bot token — shelved per Meni 2026-06-04. |

---

## 📋 OPEN BACKLOG

---

### #36 VSC-level client + per-panel reply id · S · P1 · OPEN

**Decision (Meni, revised).** Per-panel *addressing* is NOT required. Client = VSC/workspace (tag) is fine — preferred, even. Requirements: (a) addressing a client broadcasts to **all** its panels (already true — tag SSE fan-out); (b) each panel identifies itself with a **Panel ID** when it notifies/replies, so the user knows which panel answered. Not a routing change — an identity-on-reply change.

**Root cause (located, verified).** The reply/notify prefix is the per-session IDENTITY built in `createMcpServer` at [ui/server.ts:2106](ui/server.ts#L2106): `const identity = sessionTag ? ` + "`@${sessionTag}`" + ` : clientId;` → `identityLine` ([ui/server.ts:2107](ui/server.ts#L2107)) tells the agent to prefix replies with `[${identity}]`. Because every panel of a VSC sends the same `sessionTag`, `identity` is identical (`@dell-xps-bullseyenotify`) for all panels — the per-panel-suffixed `clientId` (`foo`, `foo-2`, `foo-3`) is computed at [ui/server.ts:2523](ui/server.ts#L2523) but discarded here.

**Plan (server-only, no bridge change).** Change [ui/server.ts:2106](ui/server.ts#L2106) to use the already-disambiguated `clientId` as the identity (e.g. `const identity = ` + "`@${clientId}`" + `;`). Panel 2's reply prefix then becomes `[@dell-xps-bullseyenotify-2]` — distinct per panel AND it exactly matches the `id` field `/api/clients` already returns (#35), so a reply maps to the Clients tab with zero extra plumbing. Add a test: two same-tag sessions yield distinct identity lines. Durable human names still via `NOTIFY_MCP_TAG` (#35/B). NOTE: identity activates per new MCP session, so restart/reconnect the bridge to pick it up.

---

### #40 Normal-priority notifs must still reach vsc_notif · S · P2 · OPEN

**Confirmed working at high priority (Meni 2026-06-08 19:36).** A `priority:high` notif landed in vsc_notif — webhook→channel wiring is correct. Gap: `normal`-priority notifs are idle-gated to desktop-only while the user is active ([notificationEngine.ts:44](ui/messaging/notificationEngine.ts#L44)) + desktop is disabled → they silently vanish. Requirement: notifs must reliably land in vsc_notif.

**Plan (decide policy).** Options: (a) treat Slack/vsc_notif as exempt from idle gating (always deliver to the channel, gate only phone/SMS/desktop); (b) lower/clear `idle.thresholdSeconds`; (c) agent sends important notifs as `priority:high`. Recommend (a) — the channel is a passive log, not an interrupt, so gating it adds no value. Implement as a per-channel "ignoreIdle" flag in routing.

---

### #38 Bridge misreports "Delivered as N chunks" · S · P2 · OPEN

**Problem (verified).** `sendNotifyChunked` ([src/index.ts:278](src/index.ts#L278)) returns `Delivered as N chunks` regardless of the server's real result. When a notif is idle-gated to desktop-only and desktop is disabled, the HTTP server returns `No channels delivered` per chunk, but the bridge still claims delivery — which misled both Meni and the agent during the vsc_notif debug.

**Plan.** Capture each chunk's server result string; if every chunk was suppressed / zero channels delivered, surface that verbatim (e.g. `Suppressed (idle-gated) — 0 channels`); only report "delivered" when ≥1 channel actually sent.

---

### #39 Investigate duplicate / orphan sessions per window · S · P2 · OPEN

**Observation (Meni: 2 windows × 1 panel; server shows 3).** Verified via process tree: 3 live `claude.exe` bridges, but TWO share one VSC extension host (parent **61808** → claude 64204 + 33784 → bridges 52276 + 30956); the third is a separate window (parent 66216 → bridge 45032). All 3 heartbeat live → NOT stale ghosts; there genuinely are 3 bridges, so one window holds 2 Claude sessions (a lingering/orphaned conversation or hidden second panel). Server count is correct; the surprise is editor-side.

**Plan.** Determine whether the extension leaves an orphaned `claude.exe` session on panel close/reopen (resume); document how to clear it. Optionally add a server-side dedup hint (same tag+host, overlapping `connectedAt`) to flag likely-duplicate panels in the UI. Investigation first — no fix until cause confirmed.

---

### #8 Telegram token replacement · XS · P3 · 🚧 SHELVED (Meni 2026-06-04)

**Shelved** per Meni — not active. Live token `8755252698:…` is revoked (`getMe`→`401`, verified). When resumed: replace `telegram.token` in `~/.notify-mcp/config.json` + `notify-secrets.json` with a fresh BotFather token; `chatId 8596060260` stays.

---

## 📦 DONE — newest first

---

### 2026-06-09 03:18 — #41 Remove Save buttons — auto-save on change

**Removed** all 9 per-card **Save** buttons from [ui/public/index.html](ui/public/index.html) (email, telegram, sms, ntfy, discord, slack, teams, dnd, idle); the Desktop card already auto-saved. Every card's inputs now persist immediately, mirroring Desktop:
- **Checkboxes / `<select>` / `<input type=time>` → `onchange="save<Card>()"`:** email-enabled, telegram-enabled, sms-enabled, ntfy-enabled, discord-enabled, slack-enabled, teams-enabled, dnd-enabled, dnd-schedule-enabled, dnd-quiet-start/end, the 7 DND day checkboxes, idle-enabled, idle-always-desktop.
- **Text / password / number / url / email → debounced `oninput="save<Card>Debounced()"` (400ms):** gmail-to-connected, telegram-token, telegram-chatid, sms-sid/token/from/to, ntfy-server-url, ntfy-topic, discord-webhook, discord-username, slack-webhook, teams-webhook, idle-threshold.

**[app.js](ui/public/app.js):** deleted the `dirty` Set + `markDirty`/`clearDirty` machinery and the 7 standalone `toggle<Card>Enabled` handlers (full `save<Card>()` now patches enabled+credentials together); stripped all `clearDirty(...)` calls from save functions. Added one generic `debounce(fn, 400)` helper + 8 `save<Card>Debounced` const wrappers. `detectChatId` now calls `await saveTelegram()` (was `markDirty`). Each `save<Card>()` still routes through `patch()`, which toasts "Saved"/"Save failed" — feedback preserved, debounce keeps it non-spammy.

**[style.css](ui/public/style.css):** deleted the now-dead `.btn-primary.dirty::after { content: " •"; }` rule + its section comment. `.btn-primary` base/hover kept (Connect button still uses it).

**Non-Save buttons intact:** Test, Test sound, Test voice, Detect, Copy, Connect (saveAppPassword), Open Google Account, Clear, log/clients tabs, card toggles — all 29 handlers verified present.

**Verify.** Static assets (no build). Open the config UI, expand any non-Desktop card, toggle a checkbox or edit a field → toast "Saved" fires (debounced ~400ms for text) with NO Save button present; reload page → value persists. `grep -n 'id="save-\|markDirty\|clearDirty\|dirty\|toggle.*Enabled'` over `ui/public/` returns 0 matches.

---

### 2026-06-08 19:55 — #37 hide `-bot` waiter from addressable list

**Problem (Meni).** Slack `list clients` listed `dell-xps-bullseyenotify-bot` (the notify-watch auto-responder — waiter-only, tag hardcoded `…-bot` at [notify-watch.sh:8](notify-watch.sh#L8)) as addressable client **#2**. Meaningless to `@`-address.

**Fixed** ([ui/server.ts](ui/server.ts) `slackClientTags()`). Dropped the `inboxWaiters` loop so the addressable set = tags backed by a live MCP session or live SSE stream. Waiter-only tags (the `…-bot` long-poller on `/api/agent/inbox/wait`) are excluded from `list clients` + `resolveSlackClient`, but still **receive broadcasts** (delivery is unchanged — `liveListenerCount`/fan-out still count waiters). Added a gated `/__test__/slack-clients` endpoint exposing `slackClientTags()`/`slackClientsNumbered()`.

**Verify (verified).** `npm test` (= `npm run build` then `node --test`) → **build EXIT 0, 12/12 pass, 0 fail**. New test `list clients excludes a -bot waiter, keeps real panels` (**ok 3**) parks a `botfiltertest-bot` waiter alongside a real tagged session and asserts only the real tag is addressable. **Activation:** the notify UI server must be restarted to take effect (the running PID still serves the old `list clients`).

---

### 2026-06-08 19:28 — #35 per-panel client identity

**Problem (verified, not guessed).** N Claude extension panels in one VSC window each spawn their own `claude.exe` → own bridge (`dist/index.js`) → own `/mcp` session (confirmed live: 3 bridge PIDs under 3 `anthropic.claude-code` parents). But every bridge derives the same tag `<host>-<workspace>` ([src/index.ts:64](src/index.ts#L64)), and both `/api/clients` and `list clients` aggregated by `tag`, collapsing N panels into 1 logical client. Claude Code passes NO per-session id to MCP subprocesses (only `CLAUDECODE=1`, `CLAUDE_PROJECT_DIR` — verified via claude-code-guide), but the server already mints a per-session `clientId` auto-suffixed `foo`/`foo-2`/… ([ui/server.ts:2523](ui/server.ts#L2523)) — the latent per-panel id was just never surfaced.

**Fixed (A+B).** **A** — [ui/server.ts](ui/server.ts) `/api/clients` now enumerates one logical client per live MCP session (panel), keyed off `clientId`, adding `id`, `sessionId` (8-char), `panel`, `panelCount`; same-tag panels get ordinals `1..n`. SSE/long-poll-only tags with no MCP session (e.g. the notify-watch `…-bot` responder) still collapse to one row. `slackClientsNumbered()` annotates `(N panels)` while @N routing stays tag-scoped (delivery is per-tag SSE — per-panel addressing is a separate, larger change). UI Clients tab ([ui/public/app.js](ui/public/app.js)) shows a `panel n/total · <sessionId>` badge when >1. `tag`/`name`/`kinds` preserved for back-compat. **B** — [README.md](README.md): documented `NOTIFY_MCP_TAG` as the only durable per-bridge name + the multi-panel behavior.

**Verify (verified).** `npm test` (= `npm run build` [tsc + ui tsconfig] then `node --test`) → **build EXIT 0, 11/11 pass, 0 fail**. New test `/api/clients lists one entry per panel for same-tag sessions` (two same-tag initialize calls → 2 entries, distinct `id`, panels `[1,2]`, `panelCount===2`) → `ok 2`; back-compat test `…tagged session with name + kinds` → `ok 1`. Tests run against compiled `dist/` on a random port with isolated `NOTIFY_MCP_CONFIG_DIR` — live `:3737` server + connected panels untouched. **Activation:** server-side logic (`/api/clients`, `list clients`) needs the UI server restarted to take effect; the static UI `app.js` updates on browser refresh.

---

### 2026-06-08 08:24 — #34 auto-chunk notify bodies over 500 chars

**Root cause (verified, not guessed).** The 500-char rejection lived ONLY in the stdio bridge: `notify`/`reply` declared `message: z.string().max(500)` ([src/index.ts:275](src/index.ts#L275)), so the MCP SDK rejected any >500-char body with `MCP error -32602: too_big` BEFORE the handler ran — the agent was forced to hand-split every long update. The HTTP server has NO length cap (grep `max(500` over `ui/server.ts` → 0 hits; only delivery gate is [ui/server.ts:1099](ui/server.ts#L1099), no length check), so ≤500 chunks pass through cleanly. (The separate `No channels delivered` string is that same line's no-success fallback — `result.delivered` empty, no error, not suppressed — NOT a validation failure; out of scope here.)

**Fixed.** New pure splitter module [src/chunk.ts](src/chunk.ts) (`splitForNotify`) — side-effect-free so it is verifiable without spawning the bridge or sending live Slack. Iteratively sizes N so each `(k/N) `-prefixed chunk is ≤500 chars incl. prefix, packs on word/newline boundaries with a hard-split fallback that guarantees the bound. [src/index.ts](src/index.ts): raised `notify` cap `500 → 5000`; both `notify` and `reply` now route through `sendNotifyChunked`, which forwards each chunk to the HTTP notify in order and reports `Delivered as N chunks`. Tool description + server `instructions` block updated — agent sends the full body in one call, server splits.

**Verify (verified).** `npm run build:mcp` → EXIT=0, `dist/chunk.js`+`dist/index.js` emitted. Throwaway invariant check against compiled `dist/chunk.js` (8 cases: empty, short, exactly-500, 501, 1120, 2300 no-spaces, 826 realistic, 5000 cap): **ALL PASS** — every chunk ≤500, zero characters lost (whitespace-insensitive reassembly), sequential `(k/N)` prefixes, exactly-500 stays 1 chunk, 5000→11 chunks; script deleted after. `node --test tests/smoke.test.mjs` → **10/10 pass, EXIT=0** (incl. test 10 initializing the edited bridge). **Activation:** bridge `dist/index.js` is re-spawned per MCP client connection, so the change takes effect after the VSCode notify MCP server is reloaded/restarted (the HTTP watchdog does NOT redeploy the bridge).

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

