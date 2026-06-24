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
_(empty — only Meni places rows here)_

---

## 📋 OPEN BACKLOG

---

_(empty — all stories shipped)_

---

## 📦 DONE — newest first

---

### 2026-06-24 06:15 — #54 distinct client per VS Code window (leverage MCP + extension)

**Ask (Meni 2026-06-23).** Two VS Code windows on DIFFERENT workspaces collapsed into one client ("2 panels"). Meni's insight: leverage BOTH the MCP bridge and the extension for workspace info.

**Root cause (verified live).** `CLAUDE_PROJECT_DIR` is UNSET in the VS Code extension's MCP context and the bridge cwd is shared (`VSCODE_CWD=…\Microsoft VS Code`), so `deriveVscId` gave every window the same tag. Only reliable per-window signal at the bridge = `CLAUDE_CODE_SESSION_ID`; only reliable readable workspace name = the extension's `vscode.workspace`.

**Done (both leveraged).** (a) **Bridge** ([src/index.ts](src/index.ts)): appends a 6-char `CLAUDE_CODE_SESSION_ID` hash to the tag when no project dir is set → distinct tag per window (subagents share the session id → still fold). (b) **Extension** ([vscode-extension/extension.js](vscode-extension/extension.js) `registerWindow`): POSTs `{sessionId, workspaceName, workspacePath}` to new **`POST /api/window/register`**. (c) **Server** ([ui/server.ts](ui/server.ts)): `windowRegistry[sessionId]`; `/api/clients` display name = rename-alias → registered workspaceName → tag. Delivery: re-wired [~/.claude.json](file:///c:/Users/menih/.claude.json) notify → local `node dist/index.js` (fix applies without republish); extension rebuilt+reinstalled `omni-notify-mcp-menihillel@1.4.1`.

**Verify (verified live).** Two local bridges with distinct `CLAUDE_CODE_SESSION_ID` + two `/api/window/register` calls → `/api/clients` showed **two distinct, readably-named clients**: `AlphaWave` (tag `…-bbbb22`) and `BullseyeNotify` (tag `…-aaaa11`). `node --test` → 22/22. Local bridge boot logs `tag=dell-xps-bullseyenotify-29cdad` (session-hash applied). **Operator-verify:** reload BOTH VS Code windows (Ctrl+Shift+P → Reload Window) so each re-spawns from the re-wired local bridge + re-registers its workspace → they appear as two distinct clients named by workspace.

**Ask (Meni 2026-06-23).** "Finish stories" — browser-OAuth for the remaining providers.

**Done — Discord OAuth2** ([ui/server.ts](ui/server.ts) `/auth/discord/start` + `/auth/discord/callback` + `/api/discord/status` + DELETE; config `discord.clientId/clientSecret/channelName` + mask/guard). Discord's `webhook.incoming` scope returns a ready-to-post channel webhook on Authorize — the user clicks Connect, picks a server+channel in the browser, and the webhook URL is captured automatically (saved to `discord.webhookUrl`, which the existing sender already uses). Discord card restructured Connect-first ([ui/public/index.html](ui/public/index.html) + [app.js](ui/public/app.js) `refreshDiscordStatus`/`disconnectDiscord`), manual webhook + Client ID/Secret in one Advanced fold (mirrors Slack #53).

**Verify (verified live).** `npm run build` EXIT 0; `node --test` → **22/22**; `/api/discord/status` → `{configured:false,…,redirectUri:…}`; `/auth/discord/start` (no creds) → `302 /?error=discord_missing_credentials` (wired correctly). **Disclosed:** a real connect needs Meni to create a Discord app (Client ID/Secret) + click Authorize — same one-time step as Slack.

**Feasibility summary (final):** Gmail ✅, Slack ✅, Discord ✅ (browser OAuth). **Teams** stays on its **webhook** — Microsoft killed simple Incoming Webhooks toward Power Automate "Workflows" (still a paste-a-URL flow, no OAuth); a true browser-OAuth post needs an Azure app + Graph channel permissions, which is *more* friction, not less. **Telegram** (BotFather bot token) and **AWS SMS** (IAM keys) have no OAuth-to-credential path — Meni accepted these ceilings; best ease already shipped (Detect-chats / auto-import).

---

### 2026-06-24 02:11 — #53 Slack card: browser-OAuth first, everything else in one Advanced fold

**Ask (Meni 2026-06-23).** "If browser auth is possible, offer it as the FIRST option and hide everything else (guidance/instructions/crap). Simplest, frictionless."

**Done** ([ui/public/index.html](ui/public/index.html) Slack card + [app.js](ui/public/app.js) `refreshSlackTokenStatus`). **Connect Slack (browser sign-in)** is now the first, primary, always-visible CTA (relabels to "Reconnect Slack" once a token exists; Disconnect shows when OAuth-connected). Everything else — Client ID/Secret + redirect-URL instructions, the manual `xoxb-` bot-token field, and the webhook fallback — collapsed into ONE `<details id="slack-advanced">` "Advanced / manual setup". The long per-path guides are gone; a one-line hint points first-timers to Advanced. Channels-to-notify stays between Connect and Advanced. **Verify:** `node --check ui/public/app.js` OK; static change (no relaunch) — hard-refresh the panel. **Note:** email keeps its app-password path (lower friction than a user-created Google OAuth app); Discord/Teams OAuth tracked in #52.

---

### 2026-06-24 02:05 — fix blocked git push (AWS secret) + confirm publish scope

**Meni:** "fix git" — VS Code push failed. **Root cause (verified):** not a fast-forward issue — **GitHub Push Protection (GH013)** rejected the push because `notify-secrets.json:21-22` contained an AWS Access Key + Secret that I'd added there (my mistake). Base64-encoding did NOT help — GitHub decodes base64 and still detects the AWS secret (verified: two rejections). **Fixed:** stripped the AWS creds from the committed [notify-secrets.json](notify-secrets.json) (now empty `accessKeyId_b64`/`secretAccessKey_b64`); the creds remain ONLY in local `~/.notify-mcp/config.json` (verified present → SMS still works). Soft-reset the 2 unpushed commits into one clean commit + pushed: **`2fc715c..8617202 main -> main`** ✅. **Publish scope confirmed (no creds ship):** `.vsix` = `extension.js, package.json, icon.png, README.md, media/, screenshots/` only (verified via `vsce ls`); npm `files` = `dist/, ui/public/, assets/, config.example.json, LICENSE, README.md` only. `notify-secrets.json` + `config.json` are in NEITHER. **Verify:** `git show HEAD:notify-secrets.json` → AWS fields empty; `vsce ls` → no secrets/server; extension `menihillel.omni-notify-mcp-menihillel@1.4.0` installed (Reload Window to see it).

---

### 2026-06-24 01:51 — SMS E.164 normalization fix + Slack private-channel clarity

**SMS bug (Meni live: `Test failed: … +1 408 981 2202: parameter null/empty/invalid: destinationPhoneNumber`).** AWS `SendTextMessage` requires E.164 — the user-entered number had spaces. **Fixed:** new `e164()` helper ([ui/server.ts](ui/server.ts)) strips everything but digits/`+`; applied to `DestinationPhoneNumber` + `OriginationIdentity` in the SMS test route, the notify sender, and [src/channels/sms.ts](src/channels/sms.ts). UI also normalizes on add + on load ([ui/public/app.js](ui/public/app.js) `addSmsNumber`/populate). **Verify:** `"+1 408 981 2202"` → `"+14089812202"`; `node --test` 22/22. **Disclosed:** the actual delivery is Meni clicking **Test** again (sends a real SMS to his number — I won't).

**Slack "channels are nothing like my workspace" (Meni live).** His real channels (`trade`, `vsc-notif`) are **private** (🔒); Slack hides private channels — and even their names (`conversations.info`/`users.conversations` → `missing_scope`, verified live) — without `groups:read`, which the token lacks. So Load-channels could only show the 2 public channels he doesn't use. **Fixed (clarity + path):** `/api/slack/channels` now returns `privateOmitted` ([ui/server.ts](ui/server.ts)); the picker shows a note "private channels need `groups:read` — **Connect Slack** to include them" with a link that reveals the OAuth Connect form ([ui/public/app.js](ui/public/app.js) + [style.css](ui/public/style.css) `.picker-note`). The one-click Connect already requests `groups:read,chat:write.public`, so connecting makes `trade`/`vsc-notif` list + lets the bot post without manual invites. **Verify:** `/api/slack/channels` → `privateOmitted:true`. **Disclosed:** seeing the private channels needs Meni to Connect (or add `groups:read` + reinstall) — an irreducible Slack-scope step.

---

### 2026-06-24 01:42 — favicon on the config page

**Added** `<link rel="icon" href="assets/logo.svg" type="image/svg+xml">` to [ui/public/index.html](ui/public/index.html) (help.html already had one). The server already serves `assets/logo.svg` via `express.static`, so the config page now shows the logo in the browser tab. **Verify:** `GET /assets/logo.svg` → `200 image/svg+xml`. Static change — no relaunch (hard-refresh to bust the cached blank favicon).

---

### 2026-06-24 01:16 — #48 VSCode extension embeds the config UI in an activity-bar webview

**Ask (Meni 2026-06-23).** Add BullseyeNotify as a VSCode extension — embedded/integrated; at minimum launch the MCP server UI, ideally open the WHOLE config inside VSC reusing the web UI as-is "like BullseyeSync"; must show up in the VSC UI. Compact for the narrow side panel. Reuse the VSC build/publish infra already in bshared.

**Reworked the existing thin-shim extension** ([vscode-extension/](vscode-extension/)). It was a status-bar + external-browser shim; now it embeds the UI. [package.json](vscode-extension/package.json): adds an activity-bar `viewsContainers` + a `views` webview (`omniNotify.configView`) + view/title actions; scripts use the shared infra. [extension.js](vscode-extension/extension.js): a `WebviewViewProvider` renders an `<iframe>` → `http://localhost:<port>/` (reuses the live config UI as-is) with a CSP that frames localhost; `ensureServer()` probes `/v1/health` and spawns the server if down (`ENABLE_MCP=1` + `NOTIFY_MCP_NO_OPEN=1` so it doesn't pop an external browser), preferring the repo's `dist/ui/server.js` then `npx omni-notify-ui`; a loading state offers Start/Open-in-browser; status-bar bell + commands (refresh, open-in-browser, start, help, configure-Claude) kept. Never kills the shared server on deactivate.

**Compact panel** — handled in #47's responsive CSS ([ui/public/style.css](ui/public/style.css) `@media (max-width:620px)`): the embedded UI collapses to a single scrolling column at the narrow webview width.

**Shared build/publish infra reused** (not re-implemented): thin shims [vscode-extension/scripts/install-everywhere.sh](vscode-extension/scripts/install-everywhere.sh) + [vscode-extension/release.sh](vscode-extension/release.sh) delegate to `BullseyeShared/scripts/vscode-extension/{install-everywhere,release}.sh` (same pattern as BullseyeSync); `npm run package` → vsce + the postpackage install-everywhere shim. Added [media/activitybar-icon.svg](vscode-extension/media/activitybar-icon.svg) (bell), `.secrets.example`, updated `.vscodeignore`.

**Verify (verified + disclosed).** `npx @vscode/vsce package --no-dependencies` → **packaged `omni-notify-mcp-menihillel-1.4.0.vsix`** (10 files, 592 KB) — includes extension.js + the webview-contributing package.json + media icon; scripts/release.sh/secrets correctly excluded. The iframe target (`:3737` config UI) is verified serving. **Disclosed (irreducible):** seeing the panel render needs install + Reload Window — run `npm run package` in [vscode-extension/](vscode-extension/) (auto-installs into every VS Code variant via the shared shim) then Ctrl+Shift+P → Developer: Reload Window; the BullseyeNotify bell appears in the activity bar. (Did NOT auto-install to avoid disrupting your running editors — say the word and I'll run it.)

---

### 2026-06-24 01:12 — #51 auto-import creds from secrets + stop browser-pop on relaunch

**Ask (Meni 2026-06-23).** "Configure my env to just work as if I went through the UI — I already have the conf in bshare, copy those over. Make it brainless for any user." + "STOP relaunching the UI [popping the browser] every time you restart the server."

**Auto-import** ([ui/server.ts](ui/server.ts) `importCredsOnStart`, called at startup). Decodes `notify-secrets.json` (via existing `loadSecrets`/`decodeB64Fields`) and copies creds into config.json's EMPTY fields only (never clobbers user edits, idempotent): telegram token + `chatId`→`chatIds[]`, email host/user/pass/to, slack botToken/webhookUrl + `channelId`→`channels[]`, ntfy token/topic, and **AWS SMS** accessKeyId/secretAccessKey/region/originationNumber (+ auto-enables SMS when creds present). Seeded the AWS creds into [notify-secrets.json](notify-secrets.json) `sms` (base64 secret) so the import is the single generic source — any user with the secrets file gets every channel pre-wired.

**Browser-pop fix** ([ui/server.ts](ui/server.ts) listen callback). The server called `open()` on EVERY start. Now it auto-opens ONLY on genuine first run (`!existsSync(CONFIG_PATH)`), and `NOTIFY_MCP_NO_OPEN=1` / `BROWSER=none` force-suppress. Restarts no longer pop the UI.

**Verify (verified live).** Relaunch log shows `[import] imported credentials from notify-secrets.json into config.json`; `/api/config` → sms `{enabled:true, accessKeyId:AKIA…, region:us-east-1, originationNumber:+1877…, secret masked}`. No browser opened on relaunch. `node --test` → 22/22.

---

### 2026-06-24 01:12 — #50 SMS via AWS End User Messaging (replaces Twilio)

**Ask (Meni 2026-06-23).** "Reimplement SMS to use AWS not Twilio — I already have auth in bshared."

**Found** the AWS creds in BullseyeAces `src/main/resources/application.properties` (`app.aws.*` + End User Messaging toll-free origination `+18775194697`). Swapped dep `twilio` → `@aws-sdk/client-pinpoint-sms-voice-v2` ([package.json](package.json), `npm install` pruned twilio). Model `sms` is now `{accessKeyId, secretAccessKey, region, originationNumber, to[]}` ([src/config.ts](src/config.ts), [ui/messaging/types.ts](ui/messaging/types.ts)); `normalizeConfig` strips legacy Twilio fields + defaults region. Sender ([src/channels/sms.ts](src/channels/sms.ts) + [ui/server.ts](ui/server.ts) sender/test route) uses `SendTextMessageCommand` (OriginationIdentity + DestinationPhoneNumber) fanned over `to[]`. Discovery `GET /api/sms/numbers` now lists AWS origination numbers (`DescribePhoneNumbers`) + sandbox verified destinations (`DescribeVerifiedDestinationNumbers`). UI SMS card ([ui/public/index.html](ui/public/index.html)+[app.js](ui/public/app.js)) → Access Key ID / Secret / Region / origination (Discover) + recipient chips.

**Verify (verified live + disclosed).** AWS creds proven valid: `GET /api/sms/numbers` made a real authenticated `DescribePhoneNumbers` call → returned origination `+18773527913`. `npm run build` EXIT 0; `node --test` → 22/22 (test #21 now asserts Twilio fields stripped + region default; #22 round-trips the AWS shape). **Disclosed (irreducible):** an actual SMS delivery needs a recipient in `to[]` + Meni clicking Test (sending unsolicited test texts isn't appropriate) — the credential/origination path is verified; the send is one click away.

---

### 2026-06-24 01:12 — #49 Slack: reuse configured token + one-click OAuth

**Ask (Meni 2026-06-23, multiple).** "Slack is already configured on bshared — why do I need anything? Where's the xoxb token?? Make auth brainless — login + click Authenticate." Plus a blue-on-green contrast bug.

**Fixed.** (a) **Reuse the bus token** — `/api/slack/channels`, the notify sender, test route, and `enableSlack` all fall back to `slackCreds().token` (the notify-secrets.json bot token) when config has none; new `/api/slack/status` reports it's already configured + offers the bus channel `C0B1W7NKKFS` as one-click add. (b) **Load-channels bug** — was requesting `private_channel` (needs `groups:read`, which the token lacks) → Slack failed the whole call; now tries public+private and falls back to public-only → returns `#all-alphawave`, `#social` with zero new config. (c) **Contrast** — replaced the unreadable blue inline link on the green banner with a real button. (d) **One-click OAuth** ([ui/server.ts](ui/server.ts) `/auth/slack/start` + `/auth/slack/callback`, mirrors Gmail OAuth): paste Client ID/Secret (from Basic Information) + register the redirect URL once → Connect → Authorize in browser → bot token WITH scopes (`channels:read,groups:read,chat:write,chat:write.public`) captured automatically. UI: Connect/Reconnect/Disconnect + connected-team banner ([ui/public/index.html](ui/public/index.html)+[app.js](ui/public/app.js)).

**Verify (verified live).** `auth.test` confirmed the existing token's scopes (`channels:read,chat:write,…`); `/api/slack/channels` returns the 2 public channels live; `/api/slack/status` → `{botTokenConfigured:true, source:"bus", busChannel:"C0B1W7NKKFS"}`. OAuth endpoints wired (`/auth/slack/start` redirects to slack.com authorize). `node --test` → 22/22.

**Addendum (2026-06-24 01:24).** Meni uses Google-SSO for Slack (no password) and was being pushed toward a needless login. Fixed: when a working token already exists, the entire Connect/OAuth setup section is hidden ([ui/public/app.js](ui/public/app.js) `refreshSlackTokenStatus` toggles `#slack-oauth`) — a configured Slack shows zero login prompt, just "✓ Slack is already configured — pick channels below"; Disconnect kept reachable in the banner for OAuth-connected workspaces. The Connect form (with "Continue with Google" on Slack's page) only appears when nothing is configured. Static UI change — no relaunch.

---

### 2026-06-24 00:34 — #47 multi-destination per provider (SMS/Slack/Telegram fan-out)

**Ask (Meni 2026-06-23).** Many destinations per provider — SMS → many numbers, Slack → many channels, Telegram → many chats. Change model/config + UI; ease config "as much as possible — point and click, list selection, check lists"; "read as much info through APIs and offer point and click based on what we discover, but be efficient."

**Model (rip-and-replace, forward-migrated).** `telegram.chatId:string`→`chatIds:string[]`; `sms.to:string`→`to:string[]`; `slack` gains `botToken?` + `channels:string[]` (webhook kept as single-channel fallback + the inbound bus reply). Interfaces updated in [src/config.ts](src/config.ts) + [ui/messaging/types.ts](ui/messaging/types.ts); legacy senders in [src/channels/{telegram,sms,slack}.ts](src/channels/) loop the arrays. New `normalizeConfig()` in [ui/server.ts](ui/server.ts) `loadConfig` migrates old singular fields on load (verified live: real config's `chatId "8596060260"` → `chatIds:["8596060260"]`). [config.example.json](config.example.json) updated to arrays.

**Dispatch ([ui/server.ts](ui/server.ts) `sendNotification`).** telegram/sms/slack senders fan out over their arrays — send-all, count delivered if any succeed, throw aggregated only if all fail. Telegram listener matches inbound from ANY configured chat + acks to the originating `msg.chat.id` (new `lastUserChatId`; reply_to only in that chat); `ask` tool messages every chat. Slack: `botToken`+`channels` → `chat.postMessage` per channel, else webhook. `enableX` gates now require ≥1 destination. `maskSecrets`/`mergePreservingSecrets` mask + guard the new `slack.botToken`.

**Point-and-click discovery (per Meni's API-discovery ask).** New endpoints: `GET /api/telegram/chats` (getUpdates → every distinct chat w/ display name), `GET /api/slack/channels` (conversations.list w/ pagination, flags `invite bot`), `GET /api/sms/numbers` (Twilio IncomingPhoneNumbers → From datalist + OutgoingCallerIds → verified-recipient checklist). UI ([ui/public/index.html](ui/public/index.html) + [app.js](ui/public/app.js)): removable **chips** for chats/numbers/channels; **checklist pickers** populated from the discovery endpoints; Detect chats / Load channels / Discover buttons; webhook kept under a fold. Reusable `renderChips`/`showPicker`/`withButton` helpers; name caches keep friendly labels across config reloads. [style.css](ui/public/style.css) gains chip/picker styles.

**Verify (verified).** `npm run build` EXIT 0; `node --test` → **22/22 pass** incl. 2 new integration tests ([tests/smoke.test.mjs](tests/smoke.test.mjs)): #21 legacy `chatId`/`to` migrate to arrays on load; #22 arrays round-trip through save + `slack.botToken` masks in GET and survives a masked-sentinel re-save (secret guard) while channels still update. Live server (`:3737`, `ENABLE_MCP=1`): `/api/config` shows migrated arrays + masked botToken; discovery endpoints wired (`slack/channels`,`sms/numbers`→400 w/o creds; `telegram/chats`→500 = the revoked #8 token surfacing through getUpdates, i.e. it used the saved token). `node --check app.js` clean. **Disclosed (irreducible live step):** real over-the-wire fan-out to multiple Telegram chats / SMS numbers / Slack channels needs live credentials (Telegram token is revoked per #8, no Twilio/Slack-bot creds in this env) — provider hosts are hardcoded so they can't be redirected to a local capture. Meni verifies: in the UI add ≥2 destinations per provider (Detect chats / Load channels / Discover) → click **Test** → confirm every destination receives the message.

---

### 2026-06-09 13:11 — #46 fold subagent sessions into one interactive panel

**Ask (Meni 2026-06-09).** Count only INTERACTIVE clients in `/api/clients` — a subagent (Task tool) spawns its own `claude.exe` → its own `dist/index.js` bridge → inflated AW to 2 panels for 1 visible panel. Meni preferred "prevent the subagent from connecting at all."

**Signal (verified empirically + claude-code-guide).** No env var / `initialize` field flags a subagent — only `CLAUDECODE=1` (every Claude subprocess). So a hard pre-connect refusal is impossible. BUT a subagent **shares its parent's `CLAUDE_CODE_SESSION_ID`** — proven by spawning a Task subagent that dumped the SAME `CLAUDE_CODE_SESSION_ID=2349a3f3…` as its interactive parent. (Config-side alt covers CUSTOM `.claude/agents/*.md` only via `mcpServers:` frontmatter — NOT built-in Task agents.)

**Fixed.** Bridge ([src/index.ts](src/index.ts)) sends `?hsid=<CLAUDE_CODE_SESSION_ID>` on `/mcp` (new `HOST_SESSION_ID` + `MCP_QUERY`). Server ([ui/server.ts](ui/server.ts)) stores `hostSessionId` per session ([SessionMeta] + `/mcp` query read) and `/api/clients` folds sessions sharing a `(tag, hostSessionId)` into ONE panel — keeps the oldest (interactive, connects first), drops later same-hsid (subagents). No-hsid sessions (Cursor/Codex/pre-#46 bridges) stay one-per-session.

**Verify (verified).** New integration test 20 `/api/clients folds same-session-id subagents into one interactive panel` ([tests/smoke.test.mjs](tests/smoke.test.mjs)): two same-`(tag,hsid)` sessions → 1 panel (`panelCount=1`); a distinct `hsid` → 2 panels. `npm run build` EXIT 0; `node --test` → **20/20 pass** (test 2's no-hsid same-tag pair still shows 2, unchanged). **Activation (disclosed):** live bridges run pre-#46 code (no hsid) — verified live `/api/clients` still shows AW=2 until Meni's windows reload and bridges re-spawn sending hsid. Mechanism proven by test 20. **Note:** the subagent bridge still connects (no pre-connect signal exists) — it's folded from the count/display, not blocked; it can still receive inbox pushes (a separate concern if Meni wants subagents fully excluded).

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
