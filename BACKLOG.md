# BullseyeNotify Backlog

**Jump:** [📊 AAG](#-at-a-glance) · [📋 Open](#-open-backlog) · [📦 Done](#-done--newest-first) · [🗄️ Archive](BACKLOG_ARCHIVE.md)

**Effort sizes:** `XS` <30m · `S` 30–90m · `M` half-day · `L` full-day+ · `XL` multi-day.

---

## 📊 AT A GLANCE

### 🎯 OUTSTANDING

_(empty — all stories shipped)_

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

### 2026-06-09 06:24 — #45 bridge self-exits when its claude.exe peer dies

**Root cause (verified live, process tree).** Meni: 1 AW panel + 1 BN panel, but `/api/clients` showed AW=**2 panels**. His AW VSCode window (`Code.exe` 26124) held TWO `claude.exe` — fresh `27524` + `--resume e9e49e9e-1a1a-4441-92eb-6f5b97644d38` session-restore ghost `61712` — each spawning a `dist/index.js` bridge (`dell-xps-alphawave` + `-2`). VSCode session-restore artifact. The DURABLE defect was ours: the bridge never exited on stdio-peer loss — `startSessionKeepalive()` (30s) + `subscribeInbox()` keep the event loop alive, so an orphaned bridge heartbeats forever, `lastSeen` never goes stale, the 90s reaper never fires → phantom panel lingers indefinitely.

**Fixed** ([src/index.ts](src/index.ts) `main()` + new `shutdownOnPeerLoss`). On `process.stdin` `end`/`close` (EOF = parent gone) the bridge best-effort `DELETE`s its `/mcp` session (instant removal) then `process.exit(0)`. A closed window/panel now vanishes from the clients tab immediately instead of never.

**Verify (verified).** New integration test 19 `bridge exits and drops its session when stdin closes` ([tests/smoke.test.mjs](tests/smoke.test.mjs)): spawns the real bridge (`NOTIFY_MCP_TAG=peerlosstest`), polls `/api/clients` until `-peerlosstest` registers, calls `child.stdin.end()`, awaits process exit, then polls until the tag disappears. `npm run build:mcp` EXIT 0; `node --test` → **19/19 pass** (existing 18 unchanged — bridge stays alive while stdin is held open). **Activation:** live bridges keep old code until they re-spawn (window reload); the fix engages on the next bridge spawn. **Does NOT reduce a count while both `claude.exe` are alive** — a live `--resume` duplicate is a Claude Code/VSCode session-restore behavior, not removable server-side; it only stops the *lingering* after one ends.

---

### 2026-06-09 04:05 — #43 AlphaWave (every workspace) mislabeled `bullseyenotify`

**Root cause (verified, not guessed).** Notify MCP is wired GLOBALLY (top-level `mcpServers`, [~/.claude.json](file:///c:/Users/menih/.claude.json)) with a HARDCODED `env.NOTIFY_MCP_TAG: "bullseyenotify"`. `deriveVscId()` returns the explicit tag first ([src/index.ts:45](src/index.ts#L45)), so EVERY window's bridge — AlphaWave included — self-tagged `bullseyenotify` and collapsed into one client. AlphaWave WAS connected, just mislabeled; the "3 panels I don't have" were panels from different windows (BullseyeNotify + AlphaWave + a `--resume` panel per #39) all forced under one tag. Confirmed: all 3 live bridges run `BullseyeNotify/dist/index.js`; `/api/clients` showed only `dell-xps-bullseyenotify`.

**Fixed (two parts).** **(a) Code** ([src/index.ts](src/index.ts)) — `deriveVscId()` now derives from `CLAUDE_PROJECT_DIR` (the per-workspace dir Claude Code sets) before `process.cwd()`, so one globally-wired bridge self-tags per window. **(b) Config** ([~/.claude.json](file:///c:/Users/menih/.claude.json)) — removed the hardcoded `env.NOTIFY_MCP_TAG` from the global notify block (JSON re-validated). Each window now self-tags by its real project.

**Verify (verified).** Test 18 `bridge self-tags from CLAUDE_PROJECT_DIR when NOTIFY_MCP_TAG is unset` ([tests/smoke.test.mjs](tests/smoke.test.mjs)): spawns the bridge with `CLAUDE_PROJECT_DIR=…/awderivetest` + empty `NOTIFY_MCP_TAG` → `/api/clients` shows a client tagged `…-awderivetest`. `npm run build` EXIT 0; `node --test` → **18/18 pass**. Config JSON re-parsed clean. **Operator-verify (activation needs restart):** restart/reload the VSC windows → AlphaWave appears as `dell-xps-alphawave` (or `-trade`), distinct from `dell-xps-bullseyenotify`; the UI server must also restart to serve the rebuilt bridge users connect through. **✅ LIVE-CONFIRMED 2026-06-09 06:10** — AlphaWave window reloaded → live `/api/clients` shows `dell-xps-alphawave` (2 panels, connAt 06:10:36Z), distinct from `dell-xps-bullseyenotify-3`. Operator-verify satisfied.

---

### 2026-06-09 04:04 — #44 hide `-bot` waiter from the Clients UI

**Fixed** ([ui/server.ts](ui/server.ts) `/api/clients`). The notify-watch `…-bot` auto-responder (a long-poll waiter, meaningless to address) was shown as a Clients-tab row. Added `isBot = t => t.endsWith("-bot")` and excluded `-bot` tags from the MCP-session list AND the SSE/waiter `extra` loops. It still RECEIVES broadcasts (delivery unchanged, per #37) — just no longer displayed.

**Verify (verified + live).** Test 17 `/api/clients hides a -bot waiter, keeps real panels` ([tests/smoke.test.mjs](tests/smoke.test.mjs)): parks a `uibotfilter-bot` waiter beside a real `uibotfilter` session → `/api/clients` returns the real tag and NOT the `-bot`. `node --test` → **18/18 pass**. **Live-confirmed:** the watchdog redeployed the build to `:3737`; live `/api/clients` now returns zero `-bot` rows (tags = the 3 `dell-xps-bullseyenotify` panels only). #43's per-window re-tag still needs a window restart (live bridges show the old tag until they re-spawn).

---

### 2026-06-09 03:42 — #42 per-panel "Invalidate this panel" endpoint + button

**Shipped** the worthwhile piece of #39's recommendation (the naive tag+host dedup hint stays rejected). **Server** ([ui/server.ts](ui/server.ts)): new `POST /api/clients/:tag/panel/:sessionId/reconnect` closes ONLY the MCP session whose 8-char id matches `:sessionId` (`httpTransports[sid].close()` + `delete sessions[sid]`), leaving sibling panels of the same tag connected. **UI** ([ui/public/app.js](ui/public/app.js)): per-panel **"Invalidate panel"** button shown when `panelCount > 1 && sessionId`, wired to `invalidatePanel(tag, sessionId)`; the panel badge now also shows each panel's `conn <N>m` age so an orphan (divergent connect time) stands out.

**Verify (verified).** New integration test `per-panel invalidate drops only the targeted session, siblings survive` ([tests/smoke.test.mjs](tests/smoke.test.mjs), test 16): opens 2 same-tag sessions, invalidates ONE by its `sessionId` → response `closed:1`, then `/api/clients` shows the victim gone and the sibling still present. `npm run build` EXIT 0; `node --test` → **16/16 pass**. **Activation:** server route needs the UI server restarted; the static button shows on browser refresh.

---

### 2026-06-09 03:30 — #36 per-panel reply identity

**Fixed (server-only, no bridge change)** in [ui/server.ts](ui/server.ts) `createMcpServer`. The identity ([ui/server.ts:2106](ui/server.ts#L2106)) was `sessionTag ? @${sessionTag} : clientId` → identical (`@dell-xps-bullseyenotify`) for every panel of a window. Now `const identity = @${clientId}` — the already-disambiguated per-session id (derived at [ui/server.ts:2577](ui/server.ts#L2577) as `baseId`→`baseId-2`/`-3`), so panel 2's reply prefix is `[@dell-xps-bullseyenotify-2]`, distinct per panel and exactly matching the `id` `/api/clients` returns (#35). Also switched the two server-side outbound auto-prefixes to clientId for consistency: the `notify` body prefix ([ui/server.ts:2125](ui/server.ts#L2125)) and the `ask` Telegram prefix ([ui/server.ts:2154](ui/server.ts#L2154)). Left the Telegram **reply-routing hint** (`Reply with: @${sessionTag}`) tag-scoped — addressing stays VSC/tag-level per the decision (a reply to `@tag` broadcasts to all panels).

**Verify (verified).** New integration test `same-tag panels get distinct per-panel identity in instructions` ([tests/smoke.test.mjs](tests/smoke.test.mjs), test 13): two same-tag `initialize` calls return instructions containing `YOUR SESSION IDENTITY: "@identitytest"` and `"@identitytest-2"` respectively (asserted distinct). `npm run build` EXIT 0; `node --test` → **15/15 pass**. **Activation:** identity is set per new MCP session — restart/reconnect the bridge to pick it up.

---

### 2026-06-09 03:29 — #40 normal-priority notifs reach vsc_notif (Slack idle-exempt)

**Fixed (policy (a) — Slack is a passive channel-log, exempt from idle gating)** in [ui/messaging/notificationEngine.ts](ui/messaging/notificationEngine.ts). Deleted the `suppressedReason === "idle"` early-return that dropped everything; idle now folds into `desktopOnly` (`const desktopOnly = mode.desktopOnly || mode.suppressedReason === "idle"`), and the Slack send is no longer behind `!desktopOnly` — `if (enableSlack)` fires regardless of idle/desktopOnly. All other channels (telegram/email/ntfy/discord/teams/sms) keep their existing gating; **DND still suppresses everything including Slack** (its early-return is untouched). No config flag added (anti-gating) — Slack-exempt is unconditional.

**Verify (verified).** New integration test `normal-priority notify reaches Slack even while idle-gated` ([tests/smoke.test.mjs](tests/smoke.test.mjs), test 15): forces UI active (`POST /api/ui/visibility {visible:true}` → idle-gated), points `slack.webhookUrl` at a local capture HTTP server, fires a `priority:normal` notify → capture server hit **exactly once** with the message body, and the notify result reads `Sent via: … slack`. `node --test` → **15/15 pass**.

---

### 2026-06-09 03:29 — #38 bridge reports real delivery result

**Fixed** in [src/index.ts](src/index.ts) `sendNotifyChunked`. It returned `Delivered as N chunks` unconditionally. Now it captures each chunk's server result text and uses `"Sent via:"` as the single source of truth for "delivered": all delivered → `Delivered as N chunks (L chars).`; zero delivered → `Suppressed — 0 of N chunks reached any channel. Server said: "<deduped summaries>"`; partial → `Delivered k/N chunks …; N-k reached no channel — server said: …`. Preserves the `isError` short-circuit and appends any `⚠️ USER SENT YOU A MESSAGE` inbox block (stripped from the quoted summaries so suppression reasons stay clean).

**Verify (verified).** New integration test `bridge reports suppression when a multi-chunk notify reaches no channel` ([tests/smoke.test.mjs](tests/smoke.test.mjs), test 14): spawns the real `dist/index.js` bridge, sends a ~1500-char notify with all channels disabled → bridge returns `Suppressed — 0 of N chunks reached any channel` and does NOT claim `Delivered as N chunks`. `npm run build` EXIT 0; `node --test` → **15/15 pass**. **Activation:** bridge re-spawns per MCP client connection — takes effect after the notify MCP server reloads (republish for the `npx` bridge).

---

### 2026-06-09 03:28 — #39 duplicate / orphan sessions — investigation complete

**Investigated (read-only, verified — no code changed; "investigation first" per the story).** Live process tree + `/api/clients` + `/api/sessions` + server.log: the server's 3-client count is CORRECT — each maps to a live heartbeating bridge, no stale ghost. The extra "client" is a **real, still-alive resumed Claude panel** in one window: of two `claude.exe` under ext-host 61808, one carries `--resume 53295aa6-…` (a startup panel-restore, spawned 12s after its sibling). All panels of one project derive the identical tag (`dell-xps-bullseyenotify`) / host (`127.0.0.1`), and the bridge sends NO per-window id, so the server fundamentally cannot tell a legit 2nd window from an orphan panel. The 90s idle reaper ([ui/server.ts:2408](ui/server.ts#L2408)) only clears genuinely-dead sessions; a backgrounded-but-alive resumed panel keeps heartbeating (SSE keepalive + `get_idle_seconds`), so it never reaps.

**Clear it today:** close the duplicate panel in the editor (socket close → session removed immediately), or kill the specific bridge by PID (`taskkill //F //PID <bridge>` — verify cmdline first, never `//IM`). The tag-scoped "Invalidate" button drops ALL panels and the live one reconnects, so it does not durably remove the orphan.

**Recommendation → spun out as proposed #42** (per-session "Invalidate this panel" endpoint + UI button). The literal "same tag+host + overlapping connectedAt → duplicate" dedup hint is **rejected** — it false-flags every genuine multi-panel/multi-window user.

---

### 2026-06-09 03:18 — #41 Remove Save buttons — auto-save on change

**Removed** all 9 per-card **Save** buttons from [ui/public/index.html](ui/public/index.html) (email, telegram, sms, ntfy, discord, slack, teams, dnd, idle); the Desktop card already auto-saved. Every card's inputs now persist immediately, mirroring Desktop:
- **Checkboxes / `<select>` / `<input type=time>` → `onchange="save<Card>()"`:** email-enabled, telegram-enabled, sms-enabled, ntfy-enabled, discord-enabled, slack-enabled, teams-enabled, dnd-enabled, dnd-schedule-enabled, dnd-quiet-start/end, the 7 DND day checkboxes, idle-enabled, idle-always-desktop.
- **Text / password / number / url / email → debounced `oninput="save<Card>Debounced()"` (400ms):** gmail-to-connected, telegram-token, telegram-chatid, sms-sid/token/from/to, ntfy-server-url, ntfy-topic, discord-webhook, discord-username, slack-webhook, teams-webhook, idle-threshold.

**[app.js](ui/public/app.js):** deleted the `dirty` Set + `markDirty`/`clearDirty` machinery and the 7 standalone `toggle<Card>Enabled` handlers (full `save<Card>()` now patches enabled+credentials together); stripped all `clearDirty(...)` calls from save functions. Added one generic `debounce(fn, 400)` helper + 8 `save<Card>Debounced` const wrappers. `detectChatId` now calls `await saveTelegram()` (was `markDirty`). Each `save<Card>()` still routes through `patch()`, which toasts "Saved"/"Save failed" — feedback preserved, debounce keeps it non-spammy.

**[style.css](ui/public/style.css):** deleted the now-dead `.btn-primary.dirty::after { content: " •"; }` rule + its section comment. `.btn-primary` base/hover kept (Connect button still uses it).

**Non-Save buttons intact:** Test, Test sound, Test voice, Detect, Copy, Connect (saveAppPassword), Open Google Account, Clear, log/clients tabs, card toggles — all 29 handlers verified present.

**Verify.** Static assets (no build). Open the config UI, expand any non-Desktop card, toggle a checkbox or edit a field → toast "Saved" fires (debounced ~400ms for text) with NO Save button present; reload page → value persists. `grep -n 'id="save-\|markDirty\|clearDirty\|dirty\|toggle.*Enabled'` over `ui/public/` returns 0 matches.
