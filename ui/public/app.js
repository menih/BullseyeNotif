// ── State ─────────────────────────────────────────────────────────────────

let config = {};

// Multi-destination working state (the source of truth while editing; saved to
// config as plain ID arrays). Name caches survive config reloads so chips keep
// their friendly labels even though the server only stores IDs.
const MASKED = "••••••••";
let telegramChats = [];          // [{ id, name }]
let smsNumbers = [];             // [string]
let slackChannels = [];          // [{ id, name }]
const tgNameCache = {};          // id → name
const slackNameCache = {};       // id → name

// Returns the field value only when it's a real (non-masked) secret, so detect/
// discover calls fall back to the server-saved secret instead of sending "••••".
function realSecret(id) {
  const v = $(id).value.trim();
  return v && v !== MASKED ? v : "";
}

// ── Card collapse/expand ──────────────────────────────────────────────────

function toggleCard(id) {
  const card = document.getElementById('card-' + id);
  if (card) card.classList.toggle('expanded');
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function init() {
  handleUrlParams();
  await loadConfig();
  renderOsHint();
}

function handleUrlParams() {
  const params = new URLSearchParams(location.search);
  if (params.has("success")) {
    const s = params.get("success");
    const msg = s === "gmail_connected" ? "Gmail connected successfully!"
      : s === "slack_connected" ? "Slack connected!"
      : s === "discord_connected" ? "Discord connected!"
      : "Success!";
    toast(msg, "ok");
  }
  if (params.has("error")) {
    const e = decodeURIComponent(params.get("error"));
    const msg = e === "slack_missing_credentials"
      ? "Add your Slack Client ID + Client Secret first, then Connect."
      : e === "discord_missing_credentials"
      ? "Add your Discord Client ID + Client Secret (under Advanced) first, then Connect."
      : "Error: " + e;
    toast(msg, "error");
  }
  if (params.toString()) {
    history.replaceState({}, "", location.pathname);
  }
}

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    config = await res.json();
    populateForm();
    updateBadges();
  } catch (e) {
    toast("Failed to load config: " + e, "error");
  }
}

// ── Populate form from config ─────────────────────────────────────────────

function populateForm() {
  // Desktop
  $("desktop-enabled").checked = !!config.desktop?.enabled;
  $("desktop-sound").checked = config.desktop?.sound !== false; // default on
  $("desktop-tts").checked = !!config.desktop?.tts; // default off
  updateTtsVoiceRow();
  loadVoices().catch(() => {});

  // Email / Gmail
  const email = config.email ?? {};
  if (email.connectedEmail) {
    showGmailConnected(email.connectedEmail, email.to);
  } else {
    showGmailSetup(email);
  }

  // Telegram
  const tg = config.telegram ?? {};
  $("telegram-enabled").checked = !!tg.enabled;
  $("telegram-token").value = tg.token ?? "";
  telegramChats = (Array.isArray(tg.chatIds) ? tg.chatIds : []).map(id => ({ id: String(id), name: tgNameCache[id] || String(id) }));
  renderTelegramChips();

  // SMS
  const sms = config.sms ?? {};
  $("sms-enabled").checked = !!sms.enabled;
  $("sms-accesskey").value = sms.accessKeyId ?? "";
  $("sms-secret").value = sms.secretAccessKey ?? "";
  $("sms-region").value = sms.region ?? "us-east-1";
  $("sms-from").value = sms.originationNumber ?? "";
  smsNumbers = Array.isArray(sms.to) ? sms.to.map(s => String(s).replace(/[^\d+]/g, "")) : [];
  renderSmsChips();
  const smsStatus = $("sms-status");
  if (smsStatus) {
    if (sms.accessKeyId) { smsStatus.textContent = "✓ AWS credentials configured."; smsStatus.classList.remove("hidden"); }
    else smsStatus.classList.add("hidden");
  }

  // ntfy
  const ntfy = config.ntfy ?? {};
  $("ntfy-enabled").checked = !!ntfy.enabled;
  $("ntfy-topic").value = ntfy.topic ?? "";
  const defaultUrl = `${location.protocol}//${location.hostname}:${location.port || (location.protocol === 'https:' ? 443 : 80)}`;
  $("ntfy-server-url").value = (ntfy.serverUrl || defaultUrl).replace(/\/ntfy\/?$/, "");

  // Discord
  const dc = config.discord ?? {};
  $("discord-enabled").checked = !!dc.enabled;
  $("discord-webhook").value = dc.webhookUrl ?? "";
  $("discord-username").value = dc.username ?? "";
  $("discord-clientid").value = dc.clientId ?? "";
  $("discord-clientsecret").value = dc.clientSecret ?? "";
  refreshDiscordStatus();

  // Slack
  const sl = config.slack ?? {};
  $("slack-enabled").checked = !!sl.enabled;
  $("slack-webhook").value = sl.webhookUrl ?? "";
  $("slack-bottoken").value = sl.botToken ?? "";
  $("slack-clientid").value = sl.clientId ?? "";
  $("slack-clientsecret").value = sl.clientSecret ?? "";
  slackChannels = (Array.isArray(sl.channels) ? sl.channels : []).map(id => ({ id: String(id), name: slackNameCache[id] || String(id) }));
  renderSlackChips();
  refreshSlackTokenStatus();

  // Teams
  const tm = config.teams ?? {};
  $("teams-enabled").checked = !!tm.enabled;
  $("teams-webhook").value = tm.webhookUrl ?? "";

  // Master mute (kill switch)
  const muted = !!config.muteAll;
  $("mute-all").checked = muted;
  applyMuteState(muted);

  // DND
  const dnd = config.dnd ?? {};
  $("dnd-enabled").checked = !!dnd.enabled;
  const sched = dnd.schedule ?? {};
  $("dnd-schedule-enabled").checked = !!sched.enabled;
  $("dnd-quiet-start").value = sched.quietStart ?? "22:00";
  $("dnd-quiet-end").value = sched.quietEnd ?? "08:00";
  const days = Array.isArray(sched.days) ? sched.days : [0,1,2,3,4,5,6];
  document.querySelectorAll("#dnd-days input[type=checkbox]").forEach(el => {
    el.checked = days.includes(parseInt(el.dataset.day, 10));
  });

  // Idle gating
  const idle = config.idle ?? {};
  $("idle-enabled").checked = idle.enabled !== false; // default on
  $("idle-threshold").value = idle.thresholdSeconds ?? 120;
  $("idle-always-desktop").checked = idle.alwaysDesktopWhenActive !== false; // default on
}

function showGmailConnected(email, to) {
  $("gmail-connected-state").classList.remove("hidden");
  $("gmail-setup-state").classList.add("hidden");
  $("gmail-connected-email").textContent = email;
  $("gmail-to-connected").value = to ?? email;
  $("email-enabled").checked = !!config.email?.enabled;
}

function showGmailSetup(email) {
  $("gmail-connected-state").classList.add("hidden");
  $("gmail-setup-state").classList.remove("hidden");
  $("gmail-address").value = email.user ?? email.connectedEmail ?? "";
  $("gmail-guide").removeAttribute("open");
}

// ── Badges ────────────────────────────────────────────────────────────────

function updateBadges() {
  setBadge("desktop",   config.desktop?.enabled  ? "ok"   : "idle",
    config.desktop?.enabled ? "Enabled" : "Disabled");

  const email = config.email ?? {};
  setBadge("email",
    email.connectedEmail ? "ok" : email.clientId ? "warn" : "idle",
    email.connectedEmail ? "Connected" : email.clientId ? "Credentials saved" : "Not configured");

  const tg = config.telegram ?? {};
  const tgCount = Array.isArray(tg.chatIds) ? tg.chatIds.length : 0;
  const tgReady = tg.token && tgCount > 0;
  setBadge("telegram",
    tg.enabled && tgReady ? "ok" : tgReady ? "warn" : tg.token ? "warn" : "idle",
    tg.enabled && tgReady ? `${tgCount} chat${tgCount === 1 ? "" : "s"}` : tgReady ? "Disabled" : tg.token ? "Incomplete" : "Not configured");

  const sms = config.sms ?? {};
  const smsCount = Array.isArray(sms.to) ? sms.to.length : 0;
  const smsReady = sms.accessKeyId && sms.secretAccessKey && sms.region && smsCount > 0;
  setBadge("sms",
    sms.enabled && smsReady ? "ok" : smsReady ? "warn" : sms.accessKeyId ? "warn" : "idle",
    sms.enabled && smsReady ? `${smsCount} number${smsCount === 1 ? "" : "s"}` : smsReady ? "Disabled" : sms.accessKeyId ? "Incomplete" : "Not configured");

  const ntfyC = config.ntfy ?? {};
  if (ntfyC.topic) {
    fetch(`/ntfy/${encodeURIComponent(ntfyC.topic)}/subscribers`).then(r => r.json()).then(d => {
      const count = d.subscribers ?? 0;
      if (ntfyC.enabled) {
        setBadge("ntfy", count > 0 ? "ok" : "warn", count > 0 ? `${count} subscriber${count===1?"":"s"}` : "No subscribers");
      } else {
        setBadge("ntfy", "idle", count > 0 ? `Disabled (${count} connected)` : "Disabled");
      }
    }).catch(() => setBadge("ntfy", ntfyC.enabled ? "warn" : "idle", ntfyC.enabled ? "Configured" : "Disabled"));
  } else {
    setBadge("ntfy", "idle", "Not configured");
  }

  const dcC = config.discord ?? {};
  setBadge("discord", dcC.enabled && dcC.webhookUrl ? "ok" : dcC.webhookUrl ? "warn" : "idle",
    dcC.enabled && dcC.webhookUrl ? "Configured" : dcC.webhookUrl ? "Disabled" : "Not configured");

  const slC = config.slack ?? {};
  const slCount = Array.isArray(slC.channels) ? slC.channels.length : 0;
  const slReady = (slC.botToken && slCount > 0) || slC.webhookUrl;
  const slLabel = slC.botToken && slCount > 0 ? `${slCount} channel${slCount === 1 ? "" : "s"}` : slC.webhookUrl ? "Webhook" : "Not configured";
  setBadge("slack", slC.enabled && slReady ? "ok" : slReady ? "warn" : "idle",
    slC.enabled && slReady ? slLabel : slReady ? "Disabled" : "Not configured");

  const tmC = config.teams ?? {};
  setBadge("teams", tmC.enabled && tmC.webhookUrl ? "ok" : tmC.webhookUrl ? "warn" : "idle",
    tmC.enabled && tmC.webhookUrl ? "Configured" : tmC.webhookUrl ? "Disabled" : "Not configured");

  // DND badge: "Active" (red), "Scheduled" (warn), or "Off" (idle)
  const dnd = config.dnd ?? {};
  const sched = dnd.schedule ?? {};
  if (dnd.enabled) {
    setBadge("dnd", "warn", "Active (manual)");
  } else if (sched.enabled) {
    setBadge("dnd", "warn", `Scheduled ${sched.quietStart ?? "22:00"}-${sched.quietEnd ?? "08:00"}`);
  } else {
    setBadge("dnd", "idle", "Off");
  }

  // Idle badge
  const idle = config.idle ?? {};
  setBadge("idle",
    idle.enabled !== false ? "ok" : "idle",
    idle.enabled !== false ? `Gate < ${idle.thresholdSeconds ?? 120}s idle` : "Disabled");
}

function setBadge(channel, type, text) {
  const el = $("badge-" + channel);
  el.className = "badge badge-" + type;
  el.textContent = text;
}

// ── Save handlers ─────────────────────────────────────────────────────────

function saveDesktop() {
  updateTtsVoiceRow();
  const ttsVoice = $("desktop-tts-voice").value || undefined;
  patch({
    desktop: {
      enabled: $("desktop-enabled").checked,
      sound: $("desktop-sound").checked,
      tts: $("desktop-tts").checked,
      ttsVoice,
    },
  });
}

function updateTtsVoiceRow() {
  const row = $("tts-voice-row");
  row.style.display = $("desktop-tts").checked ? "" : "none";
}

let voicesLoaded = false;
async function loadVoices() {
  if (voicesLoaded) return;
  const res = await fetch("/api/voices");
  if (!res.ok) return;
  const { voices } = await res.json();
  const sel = $("desktop-tts-voice");
  const current = config.desktop?.ttsVoice || "en-US-AndrewMultilingualNeural";
  const byLocale = {};
  for (const v of voices) (byLocale[v.locale] ??= []).push(v);
  sel.innerHTML = "";
  for (const locale of Object.keys(byLocale).sort()) {
    const og = document.createElement("optgroup");
    og.label = locale;
    for (const v of byLocale[locale].sort((a, b) => a.shortName.localeCompare(b.shortName))) {
      const opt = document.createElement("option");
      opt.value = v.shortName;
      const name = v.shortName.replace(locale + "-", "").replace(/Neural$/, "").replace(/Multilingual$/, " (Multi)");
      opt.textContent = `${name} · ${v.gender}`;
      if (v.shortName === current) opt.selected = true;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  voicesLoaded = true;
}

async function saveEmail() {
  const to = $("gmail-to-connected").value.trim();
  const enabled = $("email-enabled").checked;
  await patch({ email: { to, enabled } });
}

async function saveTelegram() {
  await patch({
    telegram: {
      enabled: $("telegram-enabled").checked,
      token: $("telegram-token").value.trim(),
      chatIds: telegramChats.map(c => c.id),
    },
  });
}

function renderTelegramChips() {
  renderChips("telegram-chips", telegramChats.map(c => c.name), i => {
    telegramChats.splice(i, 1);
    renderTelegramChips();
    saveTelegram();
  });
}

function addTelegramChatManual() {
  const id = $("telegram-chat-manual").value.trim();
  if (!id) return;
  if (!telegramChats.some(c => c.id === id)) {
    telegramChats.push({ id, name: tgNameCache[id] || id });
    renderTelegramChips();
    saveTelegram();
  }
  $("telegram-chat-manual").value = "";
}

async function detectTelegramChats() {
  const q = realSecret("telegram-token");
  const url = "/api/telegram/chats" + (q ? `?token=${encodeURIComponent(q)}` : "");
  await withButton(event, async () => {
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    json.chats.forEach(c => { tgNameCache[c.id] = c.name; });
    showPicker("telegram-chat-picker", json.chats.map(c => ({
      id: c.id, label: `${c.name}${c.type && c.type !== "private" ? ` · ${c.type}` : ""}`,
    })), telegramChats.map(c => c.id), picked => {
      telegramChats = picked.map(id => ({ id, name: tgNameCache[id] || id }));
      renderTelegramChips();
      saveTelegram();
    });
  }, "Detecting…");
}

function applyMuteState(muted) {
  const bar = $("mute-all-bar");
  const sub = $("mute-all-sub");
  if (bar) bar.classList.toggle("muted", muted);
  const body = document.body;
  if (body) body.classList.toggle("all-muted", muted);
  if (sub) sub.textContent = muted
    ? "ALL NOTIFICATIONS DISABLED — nothing is delivered on any channel or client, even high-priority."
    : "Master kill switch — silences every channel & client, including high-priority. Overrides DND.";
}

async function saveMuteAll() {
  const muted = $("mute-all").checked;
  applyMuteState(muted);
  await patch({ muteAll: muted });
}

async function saveDnd() {
  const days = [];
  document.querySelectorAll("#dnd-days input[type=checkbox]").forEach(el => {
    if (el.checked) days.push(parseInt(el.dataset.day, 10));
  });
  await patch({
    dnd: {
      enabled: $("dnd-enabled").checked,
      schedule: {
        enabled: $("dnd-schedule-enabled").checked,
        quietStart: $("dnd-quiet-start").value || "22:00",
        quietEnd: $("dnd-quiet-end").value || "08:00",
        days,
      },
    },
  });
}

async function saveIdle() {
  const thresh = parseInt($("idle-threshold").value, 10);
  await patch({
    idle: {
      enabled: $("idle-enabled").checked,
      thresholdSeconds: Number.isFinite(thresh) && thresh > 0 ? thresh : 120,
      alwaysDesktopWhenActive: $("idle-always-desktop").checked,
    },
  });
}

async function saveSms() {
  await patch({
    sms: {
      enabled: $("sms-enabled").checked,
      accessKeyId: $("sms-accesskey").value.trim(),
      secretAccessKey: $("sms-secret").value.trim(),
      region: $("sms-region").value.trim() || "us-east-1",
      originationNumber: $("sms-from").value.trim(),
      to: [...smsNumbers],
    },
  });
}

function renderSmsChips() {
  renderChips("sms-chips", smsNumbers, i => {
    smsNumbers.splice(i, 1);
    renderSmsChips();
    saveSms();
  });
}

function addSmsNumber(num) {
  // Normalize to E.164 (strip spaces/dashes/parens) — AWS rejects formatted numbers.
  const n = (num || "").replace(/[^\d+]/g, "");
  if (n && !smsNumbers.includes(n)) {
    smsNumbers.push(n);
    renderSmsChips();
    saveSms();
  }
}

function addSmsNumberManual() {
  addSmsNumber($("sms-to-manual").value);
  $("sms-to-manual").value = "";
}

async function discoverSmsNumbers() {
  const key = $("sms-accesskey").value.trim();
  const sec = realSecret("sms-secret");
  const region = $("sms-region").value.trim() || "us-east-1";
  const params = new URLSearchParams();
  if (key) params.set("accessKeyId", key);
  if (sec) params.set("secretAccessKey", sec);
  params.set("region", region);
  await withButton(event, async () => {
    const res = await fetch(`/api/sms/numbers?${params}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    // Origination numbers → datalist suggestions for the From field.
    $("sms-from-list").innerHTML = (json.from || [])
      .map(n => `<option value="${escHtml(n.phoneNumber)}">${escHtml(n.label)}</option>`).join("");
    if ((json.from || []).length && !$("sms-from").value.trim()) { $("sms-from").value = json.from[0].phoneNumber; saveSms(); }
    // Sandbox verified destinations → quick-add recipient checklist.
    const verified = (json.verified || []).filter(n => !smsNumbers.includes(n.phoneNumber));
    if (verified.length) {
      showPicker("sms-verified-picker", verified.map(n => ({ id: n.phoneNumber, label: n.label })),
        [], picked => { picked.forEach(addSmsNumber); }, "Add selected recipients");
    } else {
      $("sms-verified-picker").classList.add("hidden");
    }
    toast(`Found ${(json.from || []).length} origination + ${(json.verified || []).length} verified number(s)`, "ok");
  }, "Discovering…");
}

async function saveNtfy() {
  await patch({ ntfy: { enabled: $("ntfy-enabled").checked, topic: $("ntfy-topic").value.trim(), serverUrl: $("ntfy-server-url").value.trim() } });
}

function copyNtfyUrl() {
  const url = $("ntfy-server-url").value.trim();
  navigator.clipboard.writeText(url).then(() => toast("Server URL copied!", "ok")).catch(() => toast("Copy failed", "error"));
}
async function saveDiscord() {
  await patch({ discord: {
    enabled: $("discord-enabled").checked,
    webhookUrl: $("discord-webhook").value.trim(),
    username: $("discord-username").value.trim() || "Claude Notify",
    clientId: $("discord-clientid").value.trim(),
    clientSecret: $("discord-clientsecret").value.trim(),
  } });
}

async function disconnectDiscord() {
  if (!confirm("Disconnect Discord? You can reconnect with one click.")) return;
  try { await fetch("/auth/discord", { method: "DELETE" }); toast("Discord disconnected", "ok"); await loadConfig(); }
  catch (e) { toast("Error: " + e, "error"); }
}

async function refreshDiscordStatus() {
  const el = $("discord-status");
  if (!el) return;
  try {
    const s = await (await fetch("/api/discord/status")).json();
    if (s.redirectUri && $("discord-redirect")) $("discord-redirect").textContent = s.redirectUri;
    if ($("discord-connect-btn")) $("discord-connect-btn").textContent = s.configured ? "🔗 Reconnect Discord" : "🔗 Connect Discord (browser sign-in)";
    if ($("discord-disconnect-btn")) $("discord-disconnect-btn").classList.toggle("hidden", !s.configured);
    if (s.configured) { el.textContent = s.channelName ? `✓ Connected — posting to ${s.channelName}.` : "✓ Discord webhook configured."; el.classList.remove("hidden"); }
    else el.classList.add("hidden");
  } catch { el.classList.add("hidden"); }
}
async function saveSlack() {
  await patch({
    slack: {
      enabled: $("slack-enabled").checked,
      webhookUrl: $("slack-webhook").value.trim(),
      botToken: $("slack-bottoken").value.trim(),
      channels: slackChannels.map(c => c.id),
      clientId: $("slack-clientid").value.trim(),
      clientSecret: $("slack-clientsecret").value.trim(),
    },
  });
}

async function disconnectSlack() {
  if (!confirm("Disconnect Slack? You can reconnect with one click.")) return;
  try {
    await fetch("/auth/slack", { method: "DELETE" });
    toast("Slack disconnected", "ok");
    await loadConfig();
  } catch (e) { toast("Error: " + e, "error"); }
}

function renderSlackChips() {
  renderChips("slack-chips", slackChannels.map(c => c.name), i => {
    slackChannels.splice(i, 1);
    renderSlackChips();
    saveSlack();
  });
}

function addSlackChannelManual() {
  const id = $("slack-channel-manual").value.trim();
  if (!id) return;
  if (!slackChannels.some(c => c.id === id)) {
    slackChannels.push({ id, name: slackNameCache[id] || id });
    renderSlackChips();
    saveSlack();
  }
  $("slack-channel-manual").value = "";
}

async function refreshSlackTokenStatus() {
  const el = $("slack-token-status");
  if (!el) return;
  try {
    const s = await (await fetch("/api/slack/status")).json();
    if (s.redirectUri && $("slack-redirect")) $("slack-redirect").textContent = s.redirectUri;
    // OAuth Connect is the primary, always-visible option (#53): relabel to
    // Reconnect when a token already exists; show Disconnect when OAuth-connected.
    if ($("slack-connect-btn")) $("slack-connect-btn").textContent = s.botTokenConfigured ? "🔗 Reconnect Slack" : "🔗 Connect Slack (browser sign-in)";
    if ($("slack-disconnect-btn")) $("slack-disconnect-btn").classList.toggle("hidden", !s.team);
    if (!s.botTokenConfigured) { el.classList.add("hidden"); return; }
    el.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = s.team
      ? `✓ Connected to ${s.team}.`
      : s.source === "bus"
        ? "✓ Slack is already configured — pick channels below."
        : "✓ Slack bot token saved.";
    el.appendChild(span);
    // Offer the already-configured bus channel as a one-click add.
    if (s.busChannel && !slackChannels.some(c => c.id === s.busChannel)) {
      const btn = document.createElement("button");
      btn.className = "btn btn-sm btn-primary";
      btn.style.marginLeft = "auto";
      btn.textContent = `+ Add ${s.busChannel}`;
      btn.onclick = () => addSlackChannel(s.busChannel, s.busChannel);
      el.appendChild(btn);
    }
    el.classList.remove("hidden");
  } catch { el.classList.add("hidden"); }
}

function addSlackChannel(id, name) {
  if (!slackChannels.some(c => c.id === id)) {
    slackChannels.push({ id, name: name || id });
    renderSlackChips();
    saveSlack();
  }
}

async function loadSlackChannels() {
  const q = realSecret("slack-bottoken");
  const url = "/api/slack/channels" + (q ? `?token=${encodeURIComponent(q)}` : "");
  await withButton(event, async () => {
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    json.channels.forEach(c => { slackNameCache[c.id] = c.name; });
    showPicker("slack-channel-picker", json.channels.map(c => ({
      id: c.id, label: `${c.name}${c.isPrivate ? " 🔒" : ""}${c.isMember ? "" : " · invite bot"}`,
    })), slackChannels.map(c => c.id), picked => {
      slackChannels = picked.map(id => ({ id, name: slackNameCache[id] || id }));
      renderSlackChips();
      saveSlack();
    });
    // Private channels (e.g. #trade) are invisible without groups:read — say so
    // and surface the OAuth Connect (which requests that scope).
    if (json.privateOmitted) {
      const el = $("slack-channel-picker");
      const note = document.createElement("div");
      note.className = "picker-note";
      note.innerHTML = 'Only <b>public</b> channels shown. Your <b>private</b> channels (e.g. #trade, #vsc-notif) need the <code>groups:read</code> scope — <a href="#" id="slack-reconnect-link">Connect Slack</a> to include them.';
      el.insertBefore(note, el.firstChild);
      const link = $("slack-reconnect-link");
      if (link) link.onclick = (e) => { e.preventDefault(); const o = $("slack-oauth"); if (o) { o.classList.remove("hidden"); o.scrollIntoView({ behavior: "smooth", block: "center" }); } };
    }
  }, "Loading…");
}
async function saveTeams() {
  await patch({ teams: { enabled: $("teams-enabled").checked, webhookUrl: $("teams-webhook").value.trim() } });
}

async function patch(update) {
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    toast("Saved", "ok");
    await loadConfig();
  } catch (e) {
    toast("Save failed: " + e, "error");
  }
}

// ── gcloud auth ───────────────────────────────────────────────────────────

async function checkGcloud() {
  const res = await fetch("/api/gcloud/status");
  const status = await res.json();
  renderGcloudPanel(status);
  return status;
}

function renderGcloudPanel(status) {
  const panel = $("gcloud-auth-panel");
  const row = $("gcloud-status-row");
  panel.classList.remove("hidden");

  if (!status.installed) {
    row.innerHTML = `
      <span class="dot dot-warn"></span>
      <span class="status-text">gcloud not installed —
        <code class="cp" onclick="copyText(this)" style="font-size:11px">brew install --cask google-cloud-sdk</code>
        then refresh
      </span>`;
    return;
  }

  if (status.authenticated) {
    row.innerHTML = `
      <span class="dot dot-ok"></span>
      <span class="status-text">gcloud logged in as</span>
      <span class="status-account">${status.account}</span>`;
    return;
  }

  row.innerHTML = `
    <span class="dot dot-warn"></span>
    <span class="status-text">gcloud not logged in</span>
    <button class="btn btn-secondary" style="margin-left:auto;padding:4px 12px;font-size:12px"
      onclick="gcloudLogin()">Login with Google</button>`;
}

async function gcloudLogin() {
  const row = $("gcloud-status-row");
  const logPanel = $("gcloud-log");

  row.innerHTML = `<span class="dot dot-spin"></span>
    <span class="status-text">Opening browser for Google login…</span>`;
  logPanel.classList.remove("hidden");
  logPanel.textContent = "";

  const es = new EventSource("/api/gcloud/login");

  es.onmessage = (e) => {
    const { type, msg } = JSON.parse(e.data);

    if (type === "already_authed") {
      renderGcloudPanel({ installed: true, authenticated: true, account: msg });
      logPanel.classList.add("hidden");
      es.close();
      return;
    }

    if (type === "done") {
      renderGcloudPanel({ installed: true, authenticated: true, account: msg });
      logPanel.classList.add("hidden");
      toast("Logged in as " + msg, "ok");
      es.close();
      return;
    }

    if (type === "error") {
      row.innerHTML = `<span class="dot dot-warn"></span>
        <span class="status-text" style="color:var(--danger)">${msg}</span>`;
      es.close();
      return;
    }

    if (type === "open_browser") {
      logPanel.textContent += "Browser opened for login. Complete auth there, then come back here.\n";
      return;
    }

    if (type === "log") {
      logPanel.textContent += msg + "\n";
      logPanel.scrollTop = logPanel.scrollHeight;
    }
  };

  es.onerror = () => {
    row.innerHTML = `<span class="dot dot-warn"></span>
      <span class="status-text" style="color:var(--danger)">Connection lost</span>`;
    es.close();
  };
}

// ── Gmail App Password setup ──────────────────────────────────────────────

function openAppPasswords() {
  fetch("/api/google/open-apppasswords").catch(() => {});
}

async function saveAppPassword() {
  const gmailAddress = $("gmail-address").value.trim();
  const appPassword = $("gmail-app-password").value.replace(/\s/g, "");
  if (!gmailAddress || !appPassword) {
    toast("Enter your Gmail address and app password.", "error");
    return;
  }
  const btn = document.querySelector("#gmail-setup-state .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "Connecting…"; }
  try {
    const res = await fetch("/api/google/apppassword", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gmailAddress, appPassword }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    toast("Gmail connected!", "ok");
    await loadConfig();
  } catch (e) {
    toast("Failed: " + e, "error");
    if (btn) { btn.disabled = false; btn.textContent = "Connect"; }
  }
}

async function disconnectGmail() {
  if (!confirm("Disconnect Gmail? You'll need to re-authenticate to send emails.")) return;
  try {
    const res = await fetch("/auth/google", { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error);
    toast("Gmail disconnected", "ok");
    await loadConfig();
  } catch (e) {
    toast("Error: " + e, "error");
  }
}

async function testSound() {
  try {
    const res = await fetch("/api/test/sound", { method: "POST" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    toast(json.message, "ok");
  } catch (e) {
    toast("Sound test failed: " + e, "error");
  }
}

async function testTts() {
  try {
    const voice = $("desktop-tts-voice").value || undefined;
    const res = await fetch("/api/test/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    toast(json.message, "ok");
  } catch (e) {
    toast("TTS test failed: " + e, "error");
  }
}

// ── Test channels ─────────────────────────────────────────────────────────

async function testChannel(channel) {
  const btn = document.querySelector(`#card-${channel === "email" ? "email" : channel} .btn-secondary`);
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }

  try {
    const res = await fetch(`/api/test/${channel}`, { method: "POST" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    toast(json.message, "ok");
    setBadge(channel, "ok", "✓ Works");
  } catch (e) {
    toast("Test failed: " + e, "error");
    setBadge(channel, "error", "Failed");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send test";
    }
  }
}

// ── OS hint ───────────────────────────────────────────────────────────────

function renderOsHint() {
  const ua = navigator.userAgent;
  const hint = $("os-hint");
  if (ua.includes("Mac")) {
    hint.textContent = "macOS: allow notifications for Terminal in System Settings";
    hint.classList.add("visible");
  } else if (ua.includes("Linux")) {
    hint.textContent = "Linux: needs libnotify (sudo apt install libnotify-bin)";
    hint.classList.add("visible");
  }
}

// ── Debounced auto-save ───────────────────────────────────────────────────

function debounce(fn, ms = 400) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const saveEmailDebounced = debounce(saveEmail);
const saveTelegramDebounced = debounce(saveTelegram);
const saveSmsDebounced = debounce(saveSms);
const saveNtfyDebounced = debounce(saveNtfy);
const saveDiscordDebounced = debounce(saveDiscord);
const saveSlackDebounced = debounce(saveSlack);
const saveTeamsDebounced = debounce(saveTeams);
const saveIdleDebounced = debounce(saveIdle);

// ── Toast ─────────────────────────────────────────────────────────────────

let toastTimer;
function toast(msg, type = "ok") {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast toast-" + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

// ── Utils ─────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

// ── Multi-destination chips + checklist pickers ─────────────────────────────

// Press-feedback wrapper: disables the clicked button + shows a busy label while
// an async action runs, restores it after, and toasts any error.
async function withButton(ev, fn, busyLabel) {
  const btn = ev && (ev.currentTarget || ev.target);
  const orig = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; if (busyLabel) btn.innerHTML = busyLabel; }
  try { await fn(); }
  catch (e) { toast("" + (e && e.message ? e.message : e), "error"); }
  finally { if (btn && orig !== null) { btn.disabled = false; btn.innerHTML = orig; } }
}

function renderChips(containerId, labels, onRemove) {
  const el = $(containerId);
  if (!labels.length) { el.innerHTML = `<span class="chip-empty">None yet</span>`; return; }
  el.innerHTML = labels.map((l, i) =>
    `<span class="chip">${escHtml(l)}<span class="chip-x" data-i="${i}" title="Remove">×</span></span>`).join("");
  el.querySelectorAll(".chip-x").forEach(x => { x.onclick = () => onRemove(parseInt(x.dataset.i, 10)); });
}

// Renders a checklist of discovered items (pre-ticking already-selected ids) with
// Apply / Close. onApply receives the array of checked ids.
function showPicker(containerId, items, preselected, onApply, applyLabel) {
  const el = $(containerId);
  el.classList.remove("hidden");
  if (!items.length) { el.innerHTML = `<div class="picker-empty">Nothing found.</div>`; return; }
  const pre = new Set(preselected || []);
  el.innerHTML =
    items.map(it =>
      `<label class="picker-item"><input type="checkbox" value="${escHtml(it.id)}" ${pre.has(it.id) ? "checked" : ""}><span>${escHtml(it.label)}</span></label>`).join("") +
    `<div class="picker-actions"><button class="btn btn-sm btn-primary" data-apply>${escHtml(applyLabel || "Apply selection")}</button><button class="btn btn-sm btn-ghost" data-cancel>Close</button></div>`;
  el.querySelector("[data-apply]").onclick = () => {
    onApply([...el.querySelectorAll("input:checked")].map(i => i.value));
    el.classList.add("hidden");
  };
  el.querySelector("[data-cancel]").onclick = () => el.classList.add("hidden");
}

// ── Page visibility reporting ─────────────────────────────────────────────
// Tell the server when this tab is focused so it can skip external channels
// while the user is actively watching the UI.

function reportVisibility(visible) {
  fetch("/api/ui/visibility", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visible }),
  }).catch(() => {});
}

let visibilityHeartbeat;
function startVisibilityHeartbeat() {
  clearInterval(visibilityHeartbeat);
  visibilityHeartbeat = setInterval(() => {
    if (!document.hidden) reportVisibility(true);
  }, 15000);
}

document.addEventListener("visibilitychange", () => {
  reportVisibility(!document.hidden);
  if (!document.hidden) startVisibilityHeartbeat();
  else clearInterval(visibilityHeartbeat);
});
window.addEventListener("focus", () => { reportVisibility(true); startVisibilityHeartbeat(); });
window.addEventListener("blur",  () => reportVisibility(false));

// Report on load and start heartbeat
reportVisibility(!document.hidden);
if (!document.hidden) startVisibilityHeartbeat();

function copyText(el) {
  const text = el.textContent.replace(" 📋", "").trim();
  navigator.clipboard.writeText(text).then(() => {
    const orig = el.textContent;
    el.textContent = "Copied!";
    setTimeout(() => (el.textContent = orig), 1500);
  });
}

// ── Log panel ─────────────────────────────────────────────────────────────

// Each unique client gets a stable color
const clientColors = ["#7c6dfa","#38bdf8","#f472b6","#fb923c","#a3e635","#e879f9","#34d399","#facc15"];
const clientColorMap = {};
let clientColorIndex = 0;

function clientColor(id) {
  if (!clientColorMap[id]) {
    clientColorMap[id] = clientColors[clientColorIndex % clientColors.length];
    clientColorIndex++;
  }
  return clientColorMap[id];
}

function parseLogEntry(raw) {
  // Format: [ISO_TS][opt: [client]] DIR [channel] message
  const m = raw.match(/^\[([^\]]+)\](?:\s\[([^\]]+)\])?\s([→←·])\s\[([^\]]+)\]\s(.*)$/s);
  if (!m) return null;
  return { ts: m[1], client: m[2] || null, dir: m[3], channel: m[4], msg: m[5] };
}

let logFilterClient = "";

function selectLogFilter(clientId) {
  logFilterClient = clientId;
  document.querySelectorAll("#session-pills .pill").forEach(p => {
    p.classList.toggle("pill-active", (p.dataset.client || "") === clientId);
  });
  // Re-apply hidden class to all entries based on the new filter.
  document.querySelectorAll("#log-panel .log-entry").forEach(el => {
    const c = el.dataset.client || "";
    el.style.display = (!clientId || c === clientId || (!c && clientId === "")) ? "" : "none";
  });
  const panel = $("log-panel");
  panel.scrollTop = panel.scrollHeight;
}

function renderLogEntry(raw) {
  const panel = $("log-panel");
  const p = parseLogEntry(raw);
  const el = document.createElement("div");
  el.className = "log-entry";
  el.dataset.client = (p && p.client) ? p.client : "";

  if (p) {
    const ts = new Date(p.ts).toLocaleTimeString([], { hour12: false });
    const dirClass = p.dir === "→" ? "log-dir-out" : p.dir === "←" ? "log-dir-in" : "log-dir-info";
    const clientHtml = p.client
      ? `<span class="log-client" style="color:${clientColor(p.client)}">${p.client}</span>`
      : "";
    el.innerHTML = `
      <span class="log-ts">${ts}</span>
      ${clientHtml}
      <span class="${dirClass}">${p.dir}</span>
      <span class="log-channel">[${p.channel}]</span>
      <span class="log-msg">${p.msg.replace(/</g,"&lt;")}</span>`;
  } else {
    el.innerHTML = `<span class="log-msg">${raw.replace(/</g,"&lt;")}</span>`;
  }

  if (logFilterClient && el.dataset.client !== logFilterClient) {
    el.style.display = "none";
  }
  const atBottom = panel.scrollHeight - panel.scrollTop <= panel.clientHeight + 20;
  panel.appendChild(el);
  if (atBottom) panel.scrollTop = panel.scrollHeight;
}

function sessionStatus(lastSeen) {
  const age = Date.now() - lastSeen;
  if (age < 35_000) return "live";
  if (age < 95_000) return "idle";
  return "stale";
}

async function dismissSession(clientId) {
  await fetch(`/api/sessions/${encodeURIComponent(clientId)}`, { method: "DELETE" });
  refreshSessions();
}

async function refreshSessions() {
  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) return;
    const { sessions } = await res.json();
    const bar = $("session-pills");
    const existing = new Map();
    bar.querySelectorAll(".pill[data-client]").forEach(p => {
      if (p.dataset.client !== "") existing.set(p.dataset.client, p);
    });
    const desired = new Set([""]);
    for (const s of sessions) desired.add(s.clientId);

    // Remove pills for sessions the server no longer knows about.
    for (const [id, el] of existing) {
      if (!desired.has(id)) el.remove();
    }

    // Add or update pills.
    for (const s of sessions) {
      const status = sessionStatus(s.lastSeen);
      const label = s.tag ? `@${s.tag}` : s.clientId;
      const title = [s.workspaceName ?? s.clientName, s.host, `last seen ${Math.round((Date.now() - s.lastSeen) / 1000)}s ago`].filter(Boolean).join(" · ");

      if (!existing.has(s.clientId)) {
        const btn = document.createElement("button");
        btn.className = "pill";
        btn.dataset.client = s.clientId;
        btn.onclick = () => selectLogFilter(s.clientId);
        bar.appendChild(btn);
        existing.set(s.clientId, btn);
      }

      const btn = existing.get(s.clientId);
      btn.title = title;
      btn.innerHTML =
        `<span class="pill-dot pill-dot-${status}"></span>` +
        `<span class="pill-label">${label}</span>` +
        (status === "stale"
          ? `<span class="pill-dismiss" title="Remove" onclick="event.stopPropagation();dismissSession('${s.clientId.replace(/'/g,"\\'")}')">×</span>`
          : "");
    }

    // If the currently-selected client disconnected, fall back to "All".
    if (logFilterClient && !desired.has(logFilterClient)) {
      selectLogFilter("");
    } else {
      bar.querySelectorAll(".pill[data-client]").forEach(p => {
        p.classList.toggle("pill-active", (p.dataset.client || "") === logFilterClient);
      });
    }
  } catch { /* ignore */ }
}

setInterval(refreshSessions, 3000);
refreshSessions();

function selectPanelTab(tab) {
  document.querySelectorAll(".log-tab").forEach(t => t.classList.toggle("log-tab-active", t.dataset.ptab === tab));
  const showLog = tab === "log";
  $("log-panel").style.display = showLog ? "" : "none";
  $("clients-panel").style.display = showLog ? "none" : "";
  $("session-pills").style.display = showLog ? "" : "none";
  const clearBtn = $("clear-log-btn");
  if (clearBtn) clearBtn.style.display = showLog ? "" : "none";
  if (!showLog) refreshClients();
}

function escHtml(s) {
  return String(s ?? "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

async function refreshClients() {
  const panel = $("clients-panel");
  if (!panel || panel.style.display === "none") return;
  try {
    const res = await fetch("/api/clients");
    if (!res.ok) return;
    const { clients } = await res.json();
    if (!clients.length) {
      panel.innerHTML = `<div class="clients-empty">No clients connected.</div>`;
      return;
    }
    panel.innerHTML = clients.map(c => {
      const status = sessionStatus(c.lastSeen);
      const ago = Math.round((Date.now() - c.lastSeen) / 1000);
      const ref = c.tag || c.id;
      const label = c.name || ref;
      const aliased = c.name && c.name !== c.tag;
      const kinds = c.kinds.map(k => `<span class="client-kind">${escHtml(k)}</span>`).join("");
      const connAgo = c.connectedAt ? Math.round((Date.now() - c.connectedAt) / 60000) : null;
      const panelBadge = c.panelCount > 1
        ? `<span class="client-panel" style="opacity:.6;font-size:.85em">panel ${c.panel}/${c.panelCount}${c.sessionId ? " · " + escHtml(c.sessionId) : ""}${connAgo !== null ? " · conn " + connAgo + "m" : ""}</span>`
        : "";
      const where = [aliased ? c.tag : null, c.workspaceName || c.clientName, c.host].filter(Boolean).join(" · ");
      const refArg = ref.replace(/'/g, "\\'");
      const labelArg = label.replace(/'/g, "\\'");
      const idArg = String(c.id).replace(/'/g, "\\'");
      const panelBtn = (c.panelCount > 1 && c.sessionId)
        ? `<button class="btn btn-sm btn-ghost" onclick="invalidatePanel('${refArg}','${c.sessionId}')">Invalidate panel</button>`
        : "";
      const disabledChip = c.disabled ? `<span class="client-kind client-kind-off">disabled</span>` : "";
      const disableBtn = `<button class="btn btn-sm ${c.disabled ? "btn-warn" : "btn-ghost"}" onclick="toggleClientDisabled('${idArg}', ${c.disabled ? "true" : "false"})">${c.disabled ? "Enable" : "Disable"}</button>`;
      return `<div class="client-row${c.disabled ? " client-row-off" : ""}">
        <span class="pill-dot pill-dot-${status}"></span>
        <span class="client-tag" style="color:${clientColor(ref)}" title="${escHtml(ref)}">${escHtml(label)}</span>
        ${disabledChip}
        ${panelBadge}
        <span class="client-kinds">${kinds}</span>
        <span class="client-actions">
          ${disableBtn}
          <button class="btn btn-sm btn-ghost" onclick="renameClient('${refArg}','${labelArg}')">Rename</button>
          <button class="btn btn-sm btn-ghost" onclick="reconnectClient('${refArg}')">Invalidate</button>
          ${panelBtn}
        </span>
        <span class="client-meta">${where ? escHtml(where) + " · " : ""}seen ${ago}s ago</span>
      </div>`;
    }).join("");
  } catch { /* ignore */ }
}

async function renameClient(tag, current) {
  const name = prompt(`Rename "${tag}"\nLetters, digits, - and _ only. Leave blank to clear the alias.`, current || "");
  if (name === null) return;
  try {
    await fetch(`/api/clients/${encodeURIComponent(tag)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    toast("Client renamed");
  } catch { toast("Rename failed", "error"); }
  refreshClients();
}

async function reconnectClient(tag) {
  if (!confirm(`Force "${tag}" to reconnect?\nIt will drop and re-establish its connection within a few seconds.`)) return;
  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(tag)}/reconnect`, { method: "POST" });
    const { closed } = await res.json();
    toast(`Invalidated ${tag} — ${closed} connection(s) dropped`);
  } catch { toast("Invalidate failed", "error"); }
  setTimeout(refreshClients, 1000);
}

async function invalidatePanel(tag, sessionId) {
  if (!confirm(`Invalidate panel ${sessionId} of "${tag}"?\nOnly this one panel's session is dropped — its sibling panels stay connected. A live panel reconnects; an orphan disappears.`)) return;
  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(tag)}/panel/${encodeURIComponent(sessionId)}/reconnect`, { method: "POST" });
    const { closed } = await res.json();
    toast(`Invalidated panel ${sessionId} — ${closed} session(s) dropped`);
  } catch { toast("Invalidate panel failed", "error"); }
  setTimeout(refreshClients, 1000);
}

async function toggleClientDisabled(id, currentlyDisabled) {
  const disabled = !currentlyDisabled;
  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(id)}/disable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
    const json = await res.json();
    toast(`Client ${json.disabled ? "disabled" : "enabled"}`);
  } catch { toast("Toggle failed", "error"); }
  refreshClients();
}

setInterval(refreshClients, 3000);

function clearLog() {
  $("log-panel").innerHTML = "";
}

function toggleLog() {
  const sec = $("log-section");
  if (sec) sec.classList.toggle("collapsed");
}

function connectLogStream() {
  const dot = $("log-dot");
  const es = new EventSource("/api/logs");

  es.onmessage = (e) => {
    renderLogEntry(JSON.parse(e.data));
  };

  es.onopen = () => {
    if (dot) { dot.className = "dot dot-ok"; dot.style.display = "inline-block"; }
  };

  es.onerror = () => {
    if (dot) { dot.className = "dot dot-warn"; dot.style.display = "inline-block"; }
    es.close();
    setTimeout(connectLogStream, 3000);
  };
}

// ── Init ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => { init(); connectLogStream(); });
