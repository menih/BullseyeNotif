#!/usr/bin/env node
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import express from "express";
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { homedir, networkInterfaces } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { spawnSync, spawn } from "child_process";
import open from "open";
import notifier from "node-notifier";
import nodemailer from "nodemailer";
import { PinpointSMSVoiceV2Client, SendTextMessageCommand, DescribePhoneNumbersCommand, DescribeVerifiedDestinationNumbersCommand } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { tmpdir } from "os";
import { sendWithRouting } from "./messaging/notificationEngine.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3737;
const REDIRECT_URI = `http://localhost:${PORT}/auth/google/callback`;
const SLACK_REDIRECT_URI = `http://localhost:${PORT}/auth/slack/callback`;
// Bot scopes requested during the one-click OAuth connect. chat:write.public
// lets the bot post to public channels without being invited first.
const SLACK_OAUTH_SCOPES = "channels:read,groups:read,chat:write,chat:write.public";
const DISCORD_REDIRECT_URI = `http://localhost:${PORT}/auth/discord/callback`;
// webhook.incoming makes Discord return a ready-to-use channel webhook on Authorize.
const DISCORD_OAUTH_SCOPE = "webhook.incoming";

const PUBLIC_DIR = join(fileURLToPath(new URL("../../ui/public", import.meta.url)));

const CONFIG_DIR = process.env.NOTIFY_MCP_CONFIG_DIR || join(homedir(), ".notify-mcp");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const ADC_PATH = join(homedir(), ".config", "gcloud", "application_default_credentials.json");
const AGENT_API_KEY = (process.env.NOTIFY_AGENT_KEY ?? "").trim();
const SLACK_SIGNING_SECRET = (process.env.SLACK_SIGNING_SECRET ?? "").trim();
const ENABLE_MCP = (process.env.ENABLE_MCP ?? "").trim() === "1";

function defaultConfig() {
  return {
    muteAll: false,
    desktop: { enabled: false, sound: true },
    telegram: { enabled: false, token: "", chatIds: [] },
    whatsapp: { enabled: false, instanceId: "", apiToken: "", phone: "" },
    sms: { enabled: false, accessKeyId: "", secretAccessKey: "", region: "us-east-1", originationNumber: "", to: [] },
    email: { enabled: false, to: "" },
    ntfy: { enabled: false, topic: "", serverUrl: "" },
    discord: { enabled: false, webhookUrl: "", username: "Claude Notify", clientId: "", clientSecret: "", channelName: "" },
    slack: { enabled: false, webhookUrl: "", botToken: "", channels: [], clientId: "", clientSecret: "", team: "" },
    teams: { enabled: false, webhookUrl: "" },
    dnd: {
      enabled: false,      // manual toggle — when true, suppress all non-priority=high notifs
      schedule: {          // scheduled DND windows — evaluated if dnd.enabled === false
        enabled: false,
        quietStart: "22:00", // HH:mm local time
        quietEnd: "08:00",   // HH:mm local time (wraps past midnight if end < start)
        days: [0, 1, 2, 3, 4, 5, 6], // 0=Sunday..6=Saturday
      },
    },
    idle: {
      enabled: true,         // when true, the server gates non-urgent notifs based on user activity
      thresholdSeconds: 120, // <= this → user considered "active" → suppress remote channels
      alwaysDesktopWhenActive: true, // when active+gated, still play desktop sound+banner so the user knows *something* happened (cheap local signal, doesn't blast the phone)
    },
  };
}

/**
 * Returns true if notifications should be suppressed right now based on DND config.
 * priority=high always bypasses DND (handled by caller, not here).
 */
function isDndActive(cfg: Record<string, any>): boolean {
  const dnd = cfg.dnd ?? {};
  if (dnd.enabled === true) return true;          // manual toggle wins
  const sched = dnd.schedule;
  if (!sched || !sched.enabled) return false;

  const now = new Date();
  const day = now.getDay();
  if (!Array.isArray(sched.days) || !sched.days.includes(day)) return false;

  const [sH, sM] = String(sched.quietStart ?? "22:00").split(":").map((s: string) => parseInt(s, 10) || 0);
  const [eH, eM] = String(sched.quietEnd ?? "08:00").split(":").map((s: string) => parseInt(s, 10) || 0);
  const startMin = sH * 60 + sM;
  const endMin = eH * 60 + eM;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (startMin === endMin) return false;
  // Wrap past midnight: e.g. start=22:00, end=08:00 → "in quiet" if nowMin >= start OR nowMin < end
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  } else {
    return nowMin >= startMin || nowMin < endMin;
  }
}

// Forward-migrate legacy single-destination fields to the multi-destination
// arrays so old config.json files keep working after the multi-destination
// change. Mutates and returns the same object.
function normalizeConfig(cfg: Record<string, any>): Record<string, any> {
  if (cfg.telegram) {
    if (!Array.isArray(cfg.telegram.chatIds)) {
      const legacy = typeof cfg.telegram.chatId === "string" ? cfg.telegram.chatId.trim() : "";
      cfg.telegram.chatIds = legacy ? [legacy] : [];
    }
    delete cfg.telegram.chatId;
  }
  if (cfg.sms) {
    if (!Array.isArray(cfg.sms.to)) {
      const legacy = typeof cfg.sms.to === "string" ? cfg.sms.to.trim() : "";
      cfg.sms.to = legacy ? [legacy] : [];
    }
    // SMS moved from Twilio to AWS End User Messaging — drop the dead Twilio
    // fields and ensure the AWS shape exists.
    delete cfg.sms.accountSid; delete cfg.sms.authToken; delete cfg.sms.from;
    if (typeof cfg.sms.region !== "string" || !cfg.sms.region) cfg.sms.region = "us-east-1";
    if (typeof cfg.sms.originationNumber !== "string") cfg.sms.originationNumber = "";
  }
  if (cfg.slack && !Array.isArray(cfg.slack.channels)) {
    cfg.slack.channels = [];
  }
  return cfg;
}

function loadConfig(): Record<string, any> {
  if (!existsSync(CONFIG_PATH)) return defaultConfig();
  return normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
}

function saveConfig(config: Record<string, any>): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function clientAliasMap(): Record<string, string> {
  const a = loadConfig().clientAliases;
  return (a && typeof a === "object") ? a : {};
}

function displayTag(tag: string): string {
  return clientAliasMap()[tag] || tag;
}

const MASKED = "••••••••";

// AWS SendTextMessage requires E.164 (e.g. +14089812202) — strip spaces, dashes,
// parens, dots so a user-entered "+1 408 981 2202" is accepted.
function e164(s: unknown): string {
  return String(s ?? "").replace(/[^\d+]/g, "");
}

function maskSecrets(config: Record<string, any>): Record<string, any> {
  const c = JSON.parse(JSON.stringify(config));
  if (c.email?.pass) c.email.pass = MASKED;
  if (c.email?.clientSecret) c.email.clientSecret = MASKED;
  if (c.email?.refreshToken) c.email.refreshToken = MASKED;
  if (c.email?.accessToken) c.email.accessToken = MASKED;
  if (c.sms?.secretAccessKey) c.sms.secretAccessKey = MASKED;
  if (c.telegram?.token) c.telegram.token = MASKED;
  if (c.whatsapp?.apiToken) c.whatsapp.apiToken = MASKED;
  if (c.discord?.webhookUrl) c.discord.webhookUrl = MASKED;
  if (c.discord?.clientSecret) c.discord.clientSecret = MASKED;
  if (c.slack?.webhookUrl) c.slack.webhookUrl = MASKED;
  if (c.slack?.botToken) c.slack.botToken = MASKED;
  if (c.slack?.clientSecret) c.slack.clientSecret = MASKED;
  if (c.teams?.webhookUrl) c.teams.webhookUrl = MASKED;
  return c;
}

function mergePreservingSecrets(
  existing: Record<string, any>,
  update: Record<string, any>
): Record<string, any> {
  const merged: Record<string, any> = { ...defaultConfig(), ...existing };
  for (const section of ["desktop", "telegram", "whatsapp", "sms", "email", "ntfy", "discord", "slack", "teams", "dnd", "idle"] as const) {
    merged[section] = { ...(merged[section] || {}), ...(update[section] || {}) };
  }
  // Nested schedule inside dnd
  if (update.dnd?.schedule) {
    merged.dnd.schedule = { ...(merged.dnd.schedule || {}), ...update.dnd.schedule };
  }
  if (typeof update.muteAll === "boolean") merged.muteAll = update.muteAll;
  const guard = (path: [string, string]) => {
    const [sec, field] = path;
    if (update[sec]?.[field] === MASKED) {
      merged[sec][field] = existing[sec]?.[field] ?? "";
    }
  };
  guard(["email", "pass"]);
  guard(["email", "clientSecret"]);
  guard(["email", "refreshToken"]);
  guard(["email", "accessToken"]);
  guard(["sms", "secretAccessKey"]);
  guard(["telegram", "token"]);
  guard(["whatsapp", "apiToken"]);
  guard(["discord", "webhookUrl"]);
  guard(["discord", "clientSecret"]);
  guard(["slack", "webhookUrl"]);
  guard(["slack", "botToken"]);
  guard(["slack", "clientSecret"]);
  guard(["teams", "webhookUrl"]);
  return merged;
}

const app = express();
app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} UA:${req.headers['user-agent']?.slice(0,60)}`); next(); });
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
  },
}));
app.use(express.urlencoded({
  extended: true,
  verify: (req, _res, buf) => {
    const r = req as express.Request & { rawBody?: Buffer };
    if (!r.rawBody) r.rawBody = Buffer.from(buf);
  },
}));
app.use(express.static(PUBLIC_DIR));

function requireAgentAuth(req: express.Request, res: express.Response): boolean {
  if (!AGENT_API_KEY) return true;
  const got = String(req.headers["x-notify-key"] ?? "").trim();
  if (!got || got !== AGENT_API_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

function verifySlackSignature(req: express.Request): boolean {
  if (!SLACK_SIGNING_SECRET) return true;
  const sig = String(req.headers["x-slack-signature"] ?? "");
  const ts = String(req.headers["x-slack-request-timestamp"] ?? "");
  if (!sig || !ts) return false;
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 300) return false;
  const rawBody = ((req as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("{}")).toString("utf8");
  const base = `v0:${ts}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", SLACK_SIGNING_SECRET).update(base).digest("hex")}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Built-in ntfy server ──────────────────────────────────────────────────────
// Implements the ntfy publish/subscribe protocol internally so the ntfy mobile
// app can point directly at this server. No external service, fully private.

interface NtfySubscriber {
  res: import("express").Response;
  topic: string;
}

const ntfySubscribers: Map<string, Set<NtfySubscriber>> = new Map();

function ntfyFanout(topic: string, message: string, title: string, priority: number, tags: string): void {
  const subs = ntfySubscribers.get(topic);
  if (!subs || subs.size === 0) return;
  const id = Date.now();
  const event = [
    `id: ${id}`,
    `event: message`,
    `data: ${JSON.stringify({ id: String(id), time: Math.floor(id / 1000), event: "message", topic, title, message, priority, tags: tags ? tags.split(",") : [] })}`,
    "",
    "",
  ].join("\n");
  for (const sub of subs) {
    try { sub.res.write(event); } catch { subs.delete(sub); }
  }
}

function handleNtfySse(req: import("express").Request, res: import("express").Response): void {
  const topic = (req.params.topic as string);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`: connected to omni-notify-mcp ntfy\n\n`);
  const sub: NtfySubscriber = { res, topic };
  if (!ntfySubscribers.has(topic)) ntfySubscribers.set(topic, new Set());
  ntfySubscribers.get(topic)!.add(sub);
  const keepalive = setInterval(() => { try { res.write(": keepalive\n\n"); } catch { clearInterval(keepalive); } }, 30_000);
  req.on("close", () => { clearInterval(keepalive); ntfySubscribers.get(topic)?.delete(sub); });
}

function handleNtfyJson(req: import("express").Request, res: import("express").Response): void {
  const topic = (req.params.topic as string);
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const sub: NtfySubscriber = { res, topic };
  if (!ntfySubscribers.has(topic)) ntfySubscribers.set(topic, new Set());
  ntfySubscribers.get(topic)!.add(sub);
  const keepalive = setInterval(() => {
    try { res.write(JSON.stringify({ event: "keepalive", time: Math.floor(Date.now() / 1000) }) + "\n"); }
    catch { clearInterval(keepalive); }
  }, 30_000);
  req.on("close", () => { clearInterval(keepalive); ntfySubscribers.get(topic)?.delete(sub); });
}

// ntfy health + info endpoints — app checks these before subscribing
app.get("/v1/health", (_req, res) => res.json({ healthy: true }));
app.get("/v1/info", (_req, res) => res.json({ version: "2.11.0", sha: "n/a" }));

// ntfy app hits /:topic/sse or /:topic/json (no /ntfy/ prefix)
app.get("/:topic/sse",  (req, res) => {
  if (["api", "auth", "mcp", "assets", "ntfy"].includes(req.params.topic)) { res.status(404).end(); return; }
  handleNtfySse(req, res);
});
app.get("/:topic/json", (req, res) => {
  if (["api", "auth", "mcp", "assets", "ntfy"].includes(req.params.topic)) { res.status(404).end(); return; }
  handleNtfyJson(req, res);
});

// Also with /ntfy/ prefix for internal use
app.get("/ntfy/:topic/sse",  (req, res) => handleNtfySse(req, res));
app.get("/ntfy/:topic/json", (req, res) => handleNtfyJson(req, res));

// Publish endpoint — ntfy protocol POST (with and without /ntfy/ prefix)
app.put("/:topic", express.text({ type: "*/*" }), (req, res, next) => {
  if (["api", "auth", "mcp", "assets", "ntfy"].includes(req.params.topic)) { next(); return; }
  handleNtfyPublish(req, res);
});
app.post("/:topic", express.text({ type: "*/*" }), (req, res, next) => {
  if (["api", "auth", "mcp", "assets", "ntfy"].includes(req.params.topic)) { next(); return; }
  handleNtfyPublish(req, res);
});
app.get("/:topic/subscribers", (req, res) => {
  if (["api", "auth", "mcp", "assets", "ntfy"].includes(req.params.topic)) { res.status(404).end(); return; }
  const count = ntfySubscribers.get(req.params.topic)?.size ?? 0;
  res.json({ topic: req.params.topic, subscribers: count });
});

function handleNtfyPublish(req: import("express").Request, res: import("express").Response): void {
  const topic = req.params.topic as string;
  const message = typeof req.body === "string" ? req.body : "";
  const title = decodeURIComponent((req.headers["title"] || req.headers["x-title"] || "Claude Notify") as string);
  const priority = parseInt((req.headers["priority"] || req.headers["x-priority"] || "3") as string) || 3;
  const tags = (req.headers["tags"] || req.headers["x-tags"] || "") as string;
  ntfyFanout(topic, message, title, priority, tags);
  res.json({ id: String(Date.now()), time: Math.floor(Date.now() / 1000), event: "message", topic, title, message, priority });
}

app.put("/ntfy/:topic", express.text({ type: "*/*" }), (req, res) => {
  const { topic } = req.params;
  const message = typeof req.body === "string" ? req.body : "";
  const title = decodeURIComponent(req.headers["title"] as string || req.headers["x-title"] as string || "Claude Notify");
  const priority = parseInt((req.headers["priority"] || req.headers["x-priority"] || "3") as string) || 3;
  const tags = ((req.headers["tags"] || req.headers["x-tags"] || "") as string);
  ntfyFanout(topic, message, title, priority, tags);
  res.json({ id: String(Date.now()), time: Math.floor(Date.now() / 1000), event: "message", topic, title, message, priority });
});
app.post("/ntfy/:topic", express.text({ type: "*/*" }), (req, res) => {
  const { topic } = req.params;
  const message = typeof req.body === "string" ? req.body : "";
  const title = decodeURIComponent(req.headers["title"] as string || req.headers["x-title"] as string || "Claude Notify");
  const priority = parseInt((req.headers["priority"] || req.headers["x-priority"] || "3") as string) || 3;
  const tags = ((req.headers["tags"] || req.headers["x-tags"] || "") as string);
  ntfyFanout(topic, message, title, priority, tags);
  res.json({ id: String(Date.now()), time: Math.floor(Date.now() / 1000), event: "message", topic, title, message, priority });
});

// Subscriber count endpoint (for badge)
app.get("/ntfy/:topic/subscribers", (req, res) => {
  const count = ntfySubscribers.get(req.params.topic)?.size ?? 0;
  res.json({ topic: req.params.topic, subscribers: count });
});

// ── Config API ────────────────────────────────────────────────────────────────

app.get("/api/config", (_req, res) => {
  res.json(maskSecrets(loadConfig()));
});

app.post("/api/config", (req, res) => {
  try {
    const merged = mergePreservingSecrets(loadConfig(), req.body);
    saveConfig(merged);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/mute", (_req, res) => {
  res.json({ muted: loadConfig().muteAll === true });
});

app.post("/api/mute", (req, res) => {
  const muted = req.body?.muted === true;
  const cfg = loadConfig();
  cfg.muteAll = muted;
  saveConfig(cfg);
  log("·", "mute", muted ? "ALL notifications disabled (master mute ON)" : "master mute OFF");
  res.json({ ok: true, muted });
});

// ── Per-window workspace registry ───────────────────────────────────────────
// The VS Code extension knows its window's real workspace (the MCP bridge
// can't), so it registers {sessionId → workspaceName} here. /api/clients then
// shows the readable workspace name for the bridge session sharing that
// CLAUDE_CODE_SESSION_ID — giving two windows on different workspaces two
// distinct, readably-named clients.
const windowRegistry: Record<string, { workspaceName?: string; workspacePath?: string; at: number }> = {};

app.post("/api/window/register", (req, res) => {
  const sessionId = String(req.body?.sessionId ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  const workspaceName = typeof req.body?.workspaceName === "string" ? req.body.workspaceName.slice(0, 80) : "";
  const workspacePath = typeof req.body?.workspacePath === "string" ? req.body.workspacePath.slice(0, 300) : "";
  if (!sessionId) { res.status(400).json({ error: "sessionId required" }); return; }
  windowRegistry[sessionId] = { workspaceName, workspacePath, at: Date.now() };
  log("·", "window", `registered ${sessionId.slice(0, 8)} → ${workspaceName || "(no workspace)"}`);
  res.json({ ok: true });
});

// ── Test routes ───────────────────────────────────────────────────────────────

// Sound-only test — fires a system sound regardless of the saved 'sound'
// toggle, so the user can preview the chime. On Windows, SnoreToast's
// notification-sound is often muted per-app by Windows, so we ALSO trigger
// a PowerShell console beep as a guaranteed-audible fallback. On mac/Linux
// node-notifier's `sound: true` works reliably, no fallback needed.
app.post("/api/test/sound", (_req, res) => {
  if (process.platform === "win32") {
    // Use System.Media.SystemSounds.Asterisk — plays through the sound card
    // (Windows notification sound), works on every machine. console::beep
    // uses the PC speaker which modern hardware lacks.
    spawn("powershell", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 600",
    ], { windowsHide: true, stdio: "ignore" });
    res.json({ ok: true, message: "Sound played (System.Media)" });
    return;
  }
  notifier.notify(
    { title: "Claude Notify", message: "Sound test", sound: true, wait: false },
    (err) => {
      if (err) res.status(500).json({ error: String(err) });
      else res.json({ ok: true, message: "System sound triggered" });
    }
  );
});

async function speakText(text: string, voice: string): Promise<void> {
  const mod: any = await import("msedge-tts");
  const { MsEdgeTTS, OUTPUT_FORMAT } = mod;
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { mkdtempSync } = await import("fs");
  const outDir = mkdtempSync(join(tmpdir(), "notify-tts-"));
  const { audioFilePath } = await tts.toFile(outDir, text);
  if (process.platform === "win32") {
    spawn("powershell", [
      "-NoProfile", "-Command",
      `Add-Type -AssemblyName presentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $done = $false; Register-ObjectEvent $p MediaEnded -Action { $script:done = $true } | Out-Null; $p.Open([uri]'${audioFilePath.replace(/\\/g, "\\\\")}'); $p.Play(); while (-not $done) { Start-Sleep -Milliseconds 200 }`,
    ], { windowsHide: true, stdio: "ignore" });
  } else if (process.platform === "darwin") {
    spawn("afplay", [audioFilePath], { stdio: "ignore" });
  } else {
    spawn("aplay", [audioFilePath], { stdio: "ignore" });
  }
}

app.post("/api/test/tts", async (req, res) => {
  try {
    const cfg = loadConfig();
    const voice =
      (typeof req.body?.voice === "string" && req.body.voice) ||
      cfg.desktop?.ttsVoice ||
      "en-US-AndrewMultilingualNeural";
    const text = (typeof req.body?.text === "string" && req.body.text.trim()) || "Notification from Claude. This is a voice test.";
    await speakText(text, voice);
    res.json({ ok: true, message: `TTS played (${voice})` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

let voiceCache: { ts: number; voices: any[] } | null = null;
app.get("/api/voices", async (_req, res) => {
  try {
    if (!voiceCache || Date.now() - voiceCache.ts > 24 * 60 * 60 * 1000) {
      const mod: any = await import("msedge-tts");
      const tts = new mod.MsEdgeTTS();
      const all = await tts.getVoices();
      voiceCache = {
        ts: Date.now(),
        voices: all
          .filter((v: any) => v.Locale.startsWith("en-") && v.ShortName.includes("Neural"))
          .map((v: any) => ({ shortName: v.ShortName, gender: v.Gender, locale: v.Locale })),
      };
    }
    res.json({ voices: voiceCache.voices });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/test/desktop", (_req, res) => {
  const time = new Date().toLocaleTimeString();
  const cfg = loadConfig();
  const wantSound = cfg.desktop?.sound !== false;
  if (wantSound && process.platform === "win32") {
    spawn("powershell", [
      "-NoProfile", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 600",
    ], { windowsHide: true, stdio: "ignore" });
  }
  notifier.notify(
    {
      title: "Claude Notify",
      message: `Desktop is working! (${time})`,
      sound: wantSound && process.platform !== "win32",
    },
    (err) => {
      if (err) res.status(500).json({ error: String(err) });
      else res.json({ ok: true, message: "Desktop notification sent!" });
    }
  );
});

app.post("/api/test/telegram", async (_req, res) => {
  const config = loadConfig();
  const { token, chatIds } = config.telegram ?? {};
  if (!token || !Array.isArray(chatIds) || chatIds.length === 0) {
    res.status(400).json({ error: "Token and at least one chat are required." });
    return;
  }
  const errors: string[] = [];
  let sent = 0;
  for (const chatId of chatIds) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: "Test from Claude Notify — Telegram is working!" }),
      });
      if (r.ok) sent++;
      else errors.push(`${chatId}: ${r.status} ${await r.text()}`);
    } catch (err) {
      errors.push(`${chatId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (sent === 0) { res.status(500).json({ error: errors.join("; ") }); return; }
  res.json({ ok: true, message: `Telegram sent to ${sent} chat${sent === 1 ? "" : "s"}${errors.length ? ` (${errors.length} failed)` : ""}` });
});

// List every distinct chat that has messaged the bot — drives the UI checklist
// so the user picks chats by point-and-click instead of pasting numeric IDs.
app.get("/api/telegram/chats", async (req, res) => {
  const token = (req.query.token as string) ?? loadConfig().telegram?.token;
  if (!token || token === MASKED) {
    res.status(400).json({ error: "Token required" });
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const json = await r.json() as any;
    if (json.ok === false) throw new Error(json.description ?? "getUpdates failed");
    const byId = new Map<string, { id: string; name: string; type: string }>();
    for (const u of json.result ?? []) {
      const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
      if (!chat?.id) continue;
      const id = String(chat.id);
      const name = chat.title
        || [chat.first_name, chat.last_name].filter(Boolean).join(" ")
        || (chat.username ? `@${chat.username}` : "")
        || id;
      byId.set(id, { id, name, type: chat.type ?? "private" });
    }
    const chats = [...byId.values()];
    if (chats.length === 0) {
      res.status(404).json({ error: "No chats yet — send any message to your bot (or add it to a group) first" });
      return;
    }
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/test/whatsapp", async (_req, res) => {
  const config = loadConfig();
  const { instanceId, apiToken, phone } = config.whatsapp ?? {};
  if (!instanceId || !apiToken || !phone) {
    res.status(400).json({ error: "Instance ID, API token and phone are required." });
    return;
  }
  try {
    const r = await fetch(
      `https://api.green-api.com/waInstance${instanceId}/sendMessage/${apiToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: `${phone}@c.us`, message: "Test from Claude Notify — WhatsApp is working!" }),
      }
    );
    if (!r.ok) throw new Error(`Green API ${r.status}: ${await r.text()}`);
    res.json({ ok: true, message: "WhatsApp message sent!" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/test/sms", async (_req, res) => {
  const config = loadConfig();
  const { accessKeyId, secretAccessKey, region, originationNumber, to } = config.sms ?? {};
  if (!accessKeyId || !secretAccessKey || !region || !Array.isArray(to) || to.length === 0) {
    res.status(400).json({ error: "AWS Access Key ID, Secret, Region and at least one recipient are required." });
    return;
  }
  const client = new PinpointSMSVoiceV2Client({ region, credentials: { accessKeyId, secretAccessKey } });
  const errors: string[] = [];
  let sent = 0;
  for (const num of to) {
    try {
      await client.send(new SendTextMessageCommand({
        DestinationPhoneNumber: e164(num),
        OriginationIdentity: e164(originationNumber) || undefined,
        MessageBody: "Test from Claude Notify — SMS is working!",
      }));
      sent++;
    } catch (err) {
      errors.push(`${num}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (sent === 0) { res.status(500).json({ error: errors.join("; ") }); return; }
  res.json({ ok: true, message: `SMS sent to ${sent} number${sent === 1 ? "" : "s"}${errors.length ? ` (${errors.length} failed)` : ""}` });
});

app.post("/api/test/email", async (_req, res) => {
  const config = loadConfig();
  const email = config.email ?? {};
  if (!email.to) {
    res.status(400).json({ error: "No recipient address configured." });
    return;
  }
  try {
    let transport;
    if (email.refreshToken && email.clientId && email.clientSecret) {
      transport = nodemailer.createTransport({
        service: "gmail",
        auth: {
          type: "OAuth2",
          user: email.connectedEmail ?? email.to,
          clientId: email.clientId,
          clientSecret: email.clientSecret,
          refreshToken: email.refreshToken,
          accessToken: email.accessToken,
        },
      });
    } else if (email.host && email.user && email.pass) {
      transport = nodemailer.createTransport({
        host: email.host,
        port: email.port ?? 587,
        secure: email.secure ?? false,
        auth: { user: email.user, pass: email.pass },
      });
    } else {
      res.status(400).json({ error: "Email not fully configured. Connect Gmail or set SMTP." });
      return;
    }
    await transport.sendMail({
      from: email.connectedEmail ?? email.user ?? email.to,
      to: email.to,
      subject: "Claude Notify — test email",
      text: "Test from Claude Notify — email is working!",
    });
    res.json({ ok: true, message: `Email sent to ${email.to}` });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/test/ntfy", async (_req, res) => {
  const cfg = loadConfig();
  const ntfy = cfg.ntfy ?? {};
  if (!ntfy.topic) { res.status(400).json({ error: "Topic is required." }); return; }
  try {
    const subs = ntfySubscribers.get(ntfy.topic)?.size ?? 0;
    if (subs === 0) { res.status(400).json({ error: `No subscribers on topic '${ntfy.topic}'. Open the ntfy app and subscribe to this topic first.` }); return; }
    ntfyFanout(ntfy.topic, "Test from Claude Notify - ntfy is working!", "Claude Notify - test", 3, "white_check_mark");
    res.json({ ok: true, message: `ntfy notification sent to ${subs} subscriber(s) on topic '${ntfy.topic}'` });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});


app.post("/api/test/discord", async (_req, res) => {
  const cfg = loadConfig();
  const dc = cfg.discord ?? {};
  if (!dc.webhookUrl) { res.status(400).json({ error: "Webhook URL is required." }); return; }
  try {
    const r = await fetch(dc.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: dc.username ?? "Claude Notify", embeds: [{ title: "Claude Notify — test", description: "Test from Claude Notify — Discord is working!", color: 0x7c6dfa, timestamp: new Date().toISOString() }] }) });
    if (!r.ok) throw new Error(`Discord ${r.status}: ${await r.text()}`);
    res.json({ ok: true, message: "Discord message sent!" });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post("/api/test/slack", async (_req, res) => {
  const cfg = loadConfig();
  const sl = cfg.slack ?? {};
  const text = "🔔 *Claude Notify — test*\nTest from Claude Notify — Slack is working!";
  // Bot-token + channel-checklist path posts to each selected channel (reusing
  // the configured notify-bus token when no separate one is set); the legacy
  // webhook path posts to its single bound channel.
  const botToken = sl.botToken || slackCreds().token;
  if (botToken && Array.isArray(sl.channels) && sl.channels.length > 0) {
    const errors: string[] = [];
    let sent = 0;
    for (const channel of sl.channels) {
      try {
        const r = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${botToken}` },
          body: JSON.stringify({ channel, text }),
        });
        const json = await r.json() as any;
        if (r.ok && json.ok) sent++;
        else errors.push(`${channel}: ${json.error ?? r.status}`);
      } catch (err) {
        errors.push(`${channel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (sent === 0) { res.status(500).json({ error: errors.join("; ") }); return; }
    res.json({ ok: true, message: `Slack sent to ${sent} channel${sent === 1 ? "" : "s"}${errors.length ? ` (${errors.length} failed)` : ""}` });
    return;
  }
  if (!sl.webhookUrl) { res.status(400).json({ error: "Pick channels (uses your configured Slack bus token), or set a webhook URL." }); return; }
  try {
    const r = await fetch(sl.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error(`Slack ${r.status}: ${await r.text()}`);
    res.json({ ok: true, message: "Slack message sent!" });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// List the bot's joinable channels — drives the UI checklist so the user picks
// channels by point-and-click. Needs a bot token with channels:read (+ groups:read
// for private channels). chat.postMessage to a channel also needs the bot to be a
// member, so we surface is_member to flag channels the bot must be invited to.
app.get("/api/slack/channels", async (req, res) => {
  // Reuse the already-configured Slack bus bot token (notify-secrets.json / env)
  // when the config UI hasn't been given a separate one — no re-pasting xoxb-.
  const token = (req.query.token as string && req.query.token !== MASKED ? req.query.token as string : "")
    || loadConfig().slack?.botToken
    || slackCreds().token;
  if (!token || token === MASKED) {
    res.status(400).json({ error: "No Slack bot token found. Configure the notify bus token (notify-secrets.json) or paste an xoxb- token." });
    return;
  }
  // Listing private channels needs groups:read; public needs channels:read.
  // Try both, but if the token lacks groups:read, gracefully fall back to
  // public-only instead of failing the whole call (Slack rejects the request
  // entirely when ANY requested type's scope is missing).
  const listFor = async (types: string) => {
    const out: { id: string; name: string; isMember: boolean; isPrivate: boolean }[] = [];
    let cursor = "";
    do {
      const url = `https://slack.com/api/conversations.list?limit=200&exclude_archived=true&types=${types}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const json = await r.json() as any;
      if (!json.ok) throw new Error(json.error ?? "conversations.list failed");
      for (const c of json.channels ?? []) {
        out.push({ id: c.id, name: `#${c.name}`, isMember: !!c.is_member, isPrivate: !!c.is_private });
      }
      cursor = json.response_metadata?.next_cursor ?? "";
    } while (cursor);
    return out;
  };
  try {
    let out: Awaited<ReturnType<typeof listFor>>;
    let privateOmitted = false;
    try {
      out = await listFor("public_channel,private_channel");
    } catch (e) {
      if (!String(e).includes("missing_scope")) throw e;
      out = await listFor("public_channel"); // token lacks groups:read — public only
      privateOmitted = true;
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ channels: out, privateOmitted });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("missing_scope")) {
      res.status(400).json({ error: "Your Slack bot token can't list channels (needs channels:read). Add it at api.slack.com/apps → OAuth & Permissions → Bot Token Scopes → Reinstall — or add a channel ID manually below." });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

// Tells the UI whether a Slack bot token is already available (so it doesn't
// nag the user to paste one). "bus" = the token the notify Slack bus already
// uses (notify-secrets.json / env); "config" = one entered in the config UI.
app.get("/api/slack/status", (_req, res) => {
  const sl = loadConfig().slack ?? {};
  const creds = slackCreds();
  const source = sl.botToken ? "config" : creds.token ? "bus" : "none";
  res.json({
    botTokenConfigured: source !== "none",
    source,
    busChannel: creds.channel ?? null,
    team: sl.team || null,
    hasOAuthApp: !!(sl.clientId && sl.clientSecret),
    redirectUri: SLACK_REDIRECT_URI,
  });
});

// ── Slack one-click OAuth (browser "Authorize") ───────────────────────────────
// Mirrors the Gmail OAuth flow: the user clicks Connect, authorizes in the
// browser, and we capture the bot token WITH the right scopes via the callback —
// no token-hunting, no manual scope toggling.
app.get("/auth/slack/start", (_req, res) => {
  const { clientId } = loadConfig().slack ?? {};
  if (!clientId) { res.redirect("/?error=slack_missing_credentials"); return; }
  const url = `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}`
    + `&scope=${encodeURIComponent(SLACK_OAUTH_SCOPES)}`
    + `&redirect_uri=${encodeURIComponent(SLACK_REDIRECT_URI)}`;
  res.redirect(url);
});

app.get("/auth/slack/callback", async (req, res) => {
  const { code, error } = req.query as Record<string, string>;
  if (error) { res.redirect(`/?error=${encodeURIComponent(error)}`); return; }
  const cfg = loadConfig();
  const { clientId, clientSecret } = cfg.slack ?? {};
  if (!clientId || !clientSecret || !code) { res.redirect("/?error=slack_missing_credentials"); return; }
  try {
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: SLACK_REDIRECT_URI });
    const r = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = await r.json() as any;
    if (!json.ok) throw new Error(json.error ?? "oauth.v2.access failed");
    cfg.slack = cfg.slack ?? {};
    cfg.slack.botToken = json.access_token;       // xoxb- with the requested scopes
    cfg.slack.team = json.team?.name ?? cfg.slack.team ?? "";
    cfg.slack.enabled = true;
    saveConfig(cfg);
    res.redirect("/?success=slack_connected");
  } catch (err) {
    res.redirect(`/?error=${encodeURIComponent(String(err))}`);
  }
});

app.delete("/auth/slack", (_req, res) => {
  const cfg = loadConfig();
  if (cfg.slack) { delete cfg.slack.botToken; delete cfg.slack.team; }
  saveConfig(cfg);
  res.json({ ok: true });
});

// ── Discord one-click OAuth (browser "Authorize" → channel webhook) ───────────
// Discord's webhook.incoming scope returns a ready-to-use channel webhook on
// authorize — the user picks a server+channel in the browser, no URL to copy.
app.get("/api/discord/status", (_req, res) => {
  const dc = loadConfig().discord ?? {};
  res.json({
    configured: !!dc.webhookUrl,
    hasOAuthApp: !!(dc.clientId && dc.clientSecret),
    channelName: dc.channelName || null,
    redirectUri: DISCORD_REDIRECT_URI,
  });
});

app.get("/auth/discord/start", (_req, res) => {
  const { clientId } = loadConfig().discord ?? {};
  if (!clientId) { res.redirect("/?error=discord_missing_credentials"); return; }
  const url = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(clientId)}`
    + `&scope=${encodeURIComponent(DISCORD_OAUTH_SCOPE)}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}`;
  res.redirect(url);
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code, error } = req.query as Record<string, string>;
  if (error) { res.redirect(`/?error=${encodeURIComponent(error)}`); return; }
  const cfg = loadConfig();
  const { clientId, clientSecret } = cfg.discord ?? {};
  if (!clientId || !clientSecret || !code) { res.redirect("/?error=discord_missing_credentials"); return; }
  try {
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code, redirect_uri: DISCORD_REDIRECT_URI });
    const r = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = await r.json() as any;
    if (!r.ok || !json.webhook?.url) throw new Error(json.error_description ?? json.error ?? "discord token exchange failed");
    cfg.discord = cfg.discord ?? {};
    cfg.discord.webhookUrl = json.webhook.url;     // ready-to-post channel webhook
    cfg.discord.channelName = json.webhook.name || json.webhook.channel_id || "";
    cfg.discord.enabled = true;
    saveConfig(cfg);
    res.redirect("/?success=discord_connected");
  } catch (err) {
    res.redirect(`/?error=${encodeURIComponent(String(err))}`);
  }
});

app.delete("/auth/discord", (_req, res) => {
  const cfg = loadConfig();
  if (cfg.discord) { delete cfg.discord.webhookUrl; delete cfg.discord.channelName; }
  saveConfig(cfg);
  res.json({ ok: true });
});

// Discover AWS numbers for point-and-click: `from` = your origination phone
// numbers (DescribePhoneNumbers) for the From field; `verified` = sandbox
// verified destinations (DescribeVerifiedDestinationNumbers) as quick-add chips
// (accounts still in the SMS sandbox can only text verified numbers).
app.get("/api/sms/numbers", async (req, res) => {
  const cfg = loadConfig().sms ?? {};
  const accessKeyId = (req.query.accessKeyId as string) || cfg.accessKeyId;
  const secretRaw = (req.query.secretAccessKey as string) || cfg.secretAccessKey;
  const secretAccessKey = secretRaw === MASKED ? cfg.secretAccessKey : secretRaw;
  const region = (req.query.region as string) || cfg.region || "us-east-1";
  if (!accessKeyId || !secretAccessKey) {
    res.status(400).json({ error: "AWS Access Key ID and Secret required" });
    return;
  }
  try {
    const client = new PinpointSMSVoiceV2Client({ region, credentials: { accessKeyId, secretAccessKey } });
    const [phones, verified] = await Promise.all([
      client.send(new DescribePhoneNumbersCommand({})).then(r => r.PhoneNumbers ?? []).catch(() => []),
      client.send(new DescribeVerifiedDestinationNumbersCommand({})).then(r => r.VerifiedDestinationNumbers ?? []).catch(() => []),
    ]);
    res.json({
      from: phones.map((n: any) => ({ phoneNumber: n.PhoneNumber, label: `${n.PhoneNumber}${n.PhoneNumberType ? ` (${n.PhoneNumberType})` : ""}` })).filter((n: any) => n.phoneNumber),
      verified: verified.map((n: any) => ({ phoneNumber: n.VerifiedDestinationNumber, label: n.VerifiedDestinationNumber })).filter((n: any) => n.phoneNumber),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/test/teams", async (_req, res) => {
  const cfg = loadConfig();
  const tm = cfg.teams ?? {};
  if (!tm.webhookUrl) { res.status(400).json({ error: "Webhook URL is required." }); return; }
  try {
    const r = await fetch(tm.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.2", body: [{ type: "TextBlock", size: "Medium", weight: "Bolder", text: "Claude Notify — test" }, { type: "TextBlock", text: "Test from Claude Notify — Teams is working!", wrap: true }] } }] }) });
    if (!r.ok) throw new Error(`Teams ${r.status}: ${await r.text()}`);
    res.json({ ok: true, message: "Teams message sent!" });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── Google ADC auto-setup ─────────────────────────────────────────────────────

async function adcEmail(): Promise<string | null> {
  if (!existsSync(ADC_PATH)) return null;
  try {
    const adc = JSON.parse(readFileSync(ADC_PATH, "utf-8"));
    if (!adc.refresh_token || !adc.client_id || !adc.client_secret) return null;
    const oauth2Client = new google.auth.OAuth2(adc.client_id, adc.client_secret);
    oauth2Client.setCredentials({ refresh_token: adc.refresh_token });
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    return data.email ?? null;
  } catch {
    return null;
  }
}

app.get("/api/google/open-apppasswords", (_req, res) => {
  open("https://myaccount.google.com/apppasswords").catch(() => {});
  res.json({ ok: true });
});

app.post("/api/google/apppassword", async (req, res) => {
  const { gmailAddress, appPassword } = req.body as { gmailAddress: string; appPassword: string };
  if (!gmailAddress || !appPassword) {
    res.status(400).json({ error: "Gmail address and app password required" });
    return;
  }
  try {
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: gmailAddress, pass: appPassword },
    });
    await transport.verify();
    const cfg = loadConfig();
    cfg.email = {
      ...cfg.email,
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      user: gmailAddress,
      pass: appPassword,
      connectedEmail: gmailAddress,
      to: cfg.email?.to || gmailAddress,
      enabled: true,
    };
    saveConfig(cfg);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── gcloud auth ───────────────────────────────────────────────────────────────

function gcloudStatus(): { installed: boolean; authenticated: boolean; account?: string } {
  const check = spawnSync("gcloud", ["--version"], { encoding: "utf-8" });
  if (check.status !== 0) return { installed: false, authenticated: false };

  const list = spawnSync(
    "gcloud",
    ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
    { encoding: "utf-8" }
  );
  const account = list.stdout.trim().split("\n")[0];
  return { installed: true, authenticated: !!account, account: account || undefined };
}

app.get("/api/gcloud/status", (_req, res) => {
  res.json(gcloudStatus());
});

app.get("/api/gcloud/login", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (type: string, msg: string) =>
    res.write(`data: ${JSON.stringify({ type, msg })}\n\n`);

  const status = gcloudStatus();
  if (!status.installed) {
    send("error", "gcloud not found. Install: brew install --cask google-cloud-sdk");
    res.end();
    return;
  }
  if (status.authenticated) {
    send("already_authed", status.account!);
    res.end();
    return;
  }

  send("info", "Opening browser for Google login…");

  const child = spawn("gcloud", ["auth", "login", "--brief"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n").filter(Boolean))
      send("log", line);
  });

  child.stderr.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      if (line.includes("Go to the following link"))
        send("open_browser", line.replace("Go to the following link in your browser:", "").trim());
      else
        send("log", line);
    }
  });

  child.on("close", (code) => {
    if (code === 0) {
      const after = gcloudStatus();
      send("done", after.account ?? "Logged in");
    } else {
      send("error", `gcloud auth login exited with code ${code}`);
    }
    res.end();
  });

  req.on("close", () => child.kill());
});

// ── Google OAuth ──────────────────────────────────────────────────────────────

app.get("/auth/google/start", (req, res) => {
  const config = loadConfig();
  const { clientId, clientSecret } = config.email ?? {};
  if (!clientId || !clientSecret) {
    res.redirect("/?error=missing_credentials");
    return;
  }
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, error } = req.query as Record<string, string>;
  if (error) {
    res.redirect(`/?error=${encodeURIComponent(error)}`);
    return;
  }
  const config = loadConfig();
  const { clientId, clientSecret } = config.email ?? {};
  try {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    config.email.refreshToken = tokens.refresh_token ?? config.email.refreshToken;
    config.email.accessToken = tokens.access_token;
    config.email.connectedEmail = data.email;
    config.email.enabled = true;
    saveConfig(config);

    res.redirect("/?success=gmail_connected");
  } catch (err) {
    res.redirect(`/?error=${encodeURIComponent(String(err))}`);
  }
});

app.delete("/auth/google", (_req, res) => {
  const config = loadConfig();
  delete config.email.refreshToken;
  delete config.email.accessToken;
  delete config.email.connectedEmail;
  config.email.enabled = false;
  saveConfig(config);
  res.json({ ok: true });
});

// ── Log buffer + SSE broadcast ────────────────────────────────────────────────

const LOG_BUFFER_SIZE = 500;
const logBuffer: string[] = [];
const logClients = new Set<express.Response>();

function log(direction: "→" | "←" | "·", channel: string, text: string, client?: string) {
  const ts = new Date().toISOString();
  const clientPart = client ? ` [${client}]` : "";
  const entry = `[${ts}]${clientPart} ${direction} [${channel}] ${text}`;
  console.log(entry);
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  for (const res of logClients) {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch {}
  }
}

app.get("/api/sessions", (_req, res) => {
  const now = Date.now();
  const list = [...inboxStreamClients].map((c, i) => ({
    clientId: `sse-${i + 1}`,
    tag: c.tag,
    transport: "sse",
    connectedAt: now,
    lastSeen: now,
  }));
  res.json({ sessions: list });
});

app.delete("/api/sessions/:clientId", (_req, res) => {
  res.status(410).json({ error: "session_disconnect_unsupported", message: "HTTP mode does not support remote disconnect." });
});

// Live-client view for the UI "Clients" tab. Each live MCP session is one
// logical client = one VSC Claude extension panel (its own bridge process);
// clientId already disambiguates same-tag panels (foo, foo-2, …), and panel/
// panelCount expose that as ordinals. Tags present only as SSE streams or parked
// long-poll waiters (e.g. the notify-watch `…-bot` responder) get one row each.
app.get("/api/clients", (_req, res) => {
  pruneDeadSessions();
  const now = Date.now();
  const isBot = (t?: string) => !!t && t.endsWith("-bot");
  const allActive = Object.entries(sessions)
    .map(([sid, s]) => ({ sid, ...s }))
    .filter(s => !isBot(s.tag))
    .sort((a, b) => a.connectedAt - b.connectedAt);
  // Fold subagents into their interactive parent. A subagent (Task tool) shares
  // its parent's CLAUDE_CODE_SESSION_ID, so multiple bridges with the same
  // (tag, hostSessionId) are one interactive panel + its subagents — keep the
  // oldest (the interactive session, which connects first) and drop the rest so
  // subagents never inflate the clients tab. Sessions with no hostSessionId
  // (non-Claude hosts / pre-#46 bridges) stay one-per-session.
  const seenHostSession = new Set<string>();
  const active = allActive.filter(s => {
    if (!s.hostSessionId) return true;
    const key = `${s.tag ?? s.clientId}::${s.hostSessionId}`;
    if (seenHostSession.has(key)) return false;
    seenHostSession.add(key);
    return true;
  });
  const panelTotals = new Map<string, number>();
  for (const s of active) {
    const key = s.tag ?? s.clientId;
    panelTotals.set(key, (panelTotals.get(key) ?? 0) + 1);
  }
  const ordinals = new Map<string, number>();
  const clients = active.map(s => {
    const key = s.tag ?? s.clientId;
    const panel = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, panel);
    const kinds = ["mcp"];
    if (s.tag && sseSubscribersForTag(s.tag) > 0) kinds.push("sse");
    // Display name priority: explicit rename alias → the workspace name the
    // extension registered for this window's session → the derived tag.
    const regWs = s.hostSessionId ? windowRegistry[s.hostSessionId]?.workspaceName : "";
    const name = clientAliasMap()[s.tag ?? ""] || regWs || displayTag(s.tag ?? s.clientId);
    return {
      id: s.clientId,
      sessionId: s.sid.slice(0, 8),
      tag: s.tag,
      name,
      panel,
      panelCount: panelTotals.get(key) ?? 1,
      kinds,
      lastSeen: s.lastSeen,
      connectedAt: s.connectedAt,
      host: s.host,
      workspaceName: regWs || s.workspaceName,
      clientName: s.clientName,
    };
  });
  const tagsWithSession = new Set(active.map(s => s.tag).filter(Boolean) as string[]);
  const extra = new Map<string, Set<string>>();
  const addExtra = (tag: string, kind: string) => {
    const set = extra.get(tag) ?? new Set<string>();
    set.add(kind);
    extra.set(tag, set);
  };
  for (const c of inboxStreamClients) {
    if (c.res.destroyed || c.res.writableEnded || !c.res.writable) continue;
    if (c.tag && !isBot(c.tag) && !tagsWithSession.has(c.tag)) addExtra(c.tag, "sse");
  }
  for (const [, w] of inboxWaiters) {
    if (w.tag && !isBot(w.tag) && !tagsWithSession.has(w.tag)) addExtra(w.tag, "waiter");
  }
  for (const [tag, kinds] of extra) {
    clients.push({
      id: tag,
      sessionId: "",
      tag,
      name: displayTag(tag),
      panel: 1,
      panelCount: 1,
      kinds: [...kinds],
      lastSeen: now,
      connectedAt: now,
      host: undefined,
      workspaceName: undefined,
      clientName: undefined,
    });
  }
  clients.sort((a, b) => a.name.localeCompare(b.name) || a.panel - b.panel);
  res.json({ clients });
});

// Rename a client → a persisted display alias keyed by the client's self-reported
// tag. Applied to /api/clients, `list clients`, and @routing. Empty name clears it.
app.post("/api/clients/:tag/rename", (req, res) => {
  const tag = String(req.params.tag);
  const name = String(req.body?.name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const cfg = loadConfig();
  cfg.clientAliases = (cfg.clientAliases && typeof cfg.clientAliases === "object") ? cfg.clientAliases : {};
  if (name) cfg.clientAliases[tag] = name;
  else delete cfg.clientAliases[tag];
  saveConfig(cfg);
  log("·", "clients", `rename ${tag} → ${name || "(cleared)"}`);
  res.json({ ok: true, tag, name: name || null });
});

// Force-reconnect a client: drop every connection carrying its tag — MCP
// transports (next request 404s → bridge reinitializes), SSE streams (bridge's
// subscriber reconnects), and parked waiters (long-poll re-issues). All clients
// reconnect on their own; this just clears stale/ghost state on demand.
app.post("/api/clients/:tag/reconnect", (req, res) => {
  const tag = String(req.params.tag);
  let closed = 0;
  for (const [sid, meta] of Object.entries(sessions)) {
    if (meta.tag !== tag) continue;
    try { httpTransports[sid]?.close(); } catch { /* transport already gone */ }
    delete httpTransports[sid];
    delete sessions[sid];
    closed++;
  }
  for (const c of [...inboxStreamClients]) {
    if (c.tag !== tag) continue;
    try { c.res.end(); } catch { /* stream already closed */ }
    inboxStreamClients.delete(c);
    closed++;
  }
  for (const [id, w] of [...inboxWaiters]) {
    if (w.tag !== tag) continue;
    clearTimeout(w.timer);
    w.resolve([]);
    inboxWaiters.delete(id);
    closed++;
  }
  log("·", "clients", `force-reconnect ${tag} — ${closed} connection(s) dropped`);
  res.json({ ok: true, tag, closed });
});

app.post("/api/clients/:tag/panel/:sessionId/reconnect", (req, res) => {
  const tag = String(req.params.tag);
  const prefix = String(req.params.sessionId);
  let closed = 0;
  for (const sid of Object.keys(sessions)) {
    if (sid.slice(0, 8) !== prefix) continue;
    try { httpTransports[sid]?.close(); } catch { /* transport already gone */ }
    delete httpTransports[sid];
    delete sessions[sid];
    closed++;
  }
  log("·", "clients", `invalidate panel ${tag}/${prefix} — ${closed} session(s) dropped`);
  res.json({ ok: true, tag, sessionId: prefix, closed });
});

app.get("/api/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  for (const entry of logBuffer) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  logClients.add(res);
  req.on("close", () => logClients.delete(res));
});

// ── Notification sender ───────────────────────────────────────────────────────

async function sendNotification(message: string, priority: "low" | "normal" | "high", client?: string) {
  const cfg = loadConfig();
  if (cfg.muteAll === true) {
    log("·", "notify", `suppressed — all notifications disabled (master mute), priority=${priority}`, client);
    return "Suppressed — all notifications are disabled (master mute is ON).";
  }
  const inTelegramConvo = Date.now() - lastTelegramInboundAt < TELEGRAM_CONVO_TTL_MS;
  const idleSecs = getOsIdleSeconds();

  const result = await sendWithRouting({
    message,
    priority,
    policy: {
      idleEnabled: cfg.idle?.enabled !== false,
      idleThresholdSeconds: cfg.idle?.thresholdSeconds ?? 120,
      alwaysDesktopWhenActive: cfg.idle?.alwaysDesktopWhenActive !== false,
      dndActive: isDndActive(cfg),
    },
    ctx: {
      inTelegramConversation: inTelegramConvo,
      uiActive: isUiActivelyOpen(),
      idleSeconds: idleSecs,
    },
    enableDesktop: !!cfg.desktop?.enabled,
    enableTelegram: !!(cfg.telegram?.enabled && cfg.telegram.token && cfg.telegram.chatIds?.length),
    enableEmail: !!(cfg.email?.enabled && cfg.email.to),
    enableSms: !!(cfg.sms?.enabled && cfg.sms.accessKeyId && cfg.sms.secretAccessKey && cfg.sms.region && cfg.sms.to?.length),
    enableNtfy: !!(cfg.ntfy?.enabled && cfg.ntfy.topic),
    enableDiscord: !!(cfg.discord?.enabled && cfg.discord.webhookUrl),
    enableSlack: !!(cfg.slack?.enabled && ((cfg.slack.channels?.length && (cfg.slack.botToken || slackCreds().token)) || cfg.slack.webhookUrl)),
    enableTeams: !!(cfg.teams?.enabled && cfg.teams.webhookUrl),
    senders: {
      desktop: async () => {
        const wantSound = cfg.desktop?.sound !== false;
        if (wantSound && process.platform === "win32") {
          spawn("powershell", [
            "-NoProfile", "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 600",
          ], { windowsHide: true, stdio: "ignore" });
        }
        const soundOpt = wantSound && process.platform !== "win32";
        if (cfg.desktop?.tts) {
          const voice = cfg.desktop?.ttsVoice ?? "en-US-AndrewMultilingualNeural";
          speakText(message, voice).catch((err) =>
            log("→", "tts", `ERROR: ${err instanceof Error ? err.message : String(err)}`, client));
        }
        await new Promise<void>((resolve, reject) => {
          notifier.notify({ title: "Claude Notify", message, sound: soundOpt }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      telegram: async () => {
        const errors: string[] = [];
        let sent = 0;
        for (const chatId of cfg.telegram.chatIds as string[]) {
          const body: Record<string, any> = { chat_id: chatId, text: message };
          // reply_to only resolves in the chat the last inbound came from.
          if (lastUserMessageId && chatId === lastUserChatId) body.reply_to_message_id = lastUserMessageId;
          const r = await fetch(`https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (r.ok) sent++;
          else errors.push(`${chatId}: ${await r.text()}`);
        }
        if (sent === 0 && errors.length) throw new Error(errors.join("; "));
      },
      sms: async () => {
        const smsClient = new PinpointSMSVoiceV2Client({
          region: cfg.sms.region,
          credentials: { accessKeyId: cfg.sms.accessKeyId, secretAccessKey: cfg.sms.secretAccessKey },
        });
        const errors: string[] = [];
        let sent = 0;
        for (const num of cfg.sms.to as string[]) {
          try {
            await smsClient.send(new SendTextMessageCommand({
              DestinationPhoneNumber: e164(num),
              OriginationIdentity: e164(cfg.sms.originationNumber) || undefined,
              MessageBody: message,
            }));
            sent++;
          } catch (err) { errors.push(`${num}: ${err instanceof Error ? err.message : String(err)}`); }
        }
        if (sent === 0 && errors.length) throw new Error(errors.join("; "));
      },
      email: async () => {
        const email = cfg.email;
        let transport;
        if (email.refreshToken && email.clientId && email.clientSecret) {
          transport = nodemailer.createTransport({
            service: "gmail",
            auth: {
              type: "OAuth2",
              user: email.connectedEmail ?? email.to,
              clientId: email.clientId,
              clientSecret: email.clientSecret,
              refreshToken: email.refreshToken,
              accessToken: email.accessToken,
            },
          });
        } else if (email.host && email.user && email.pass) {
          transport = nodemailer.createTransport({
            host: email.host,
            port: email.port ?? 587,
            secure: email.secure ?? false,
            auth: { user: email.user, pass: email.pass },
          });
        } else {
          return;
        }
        await transport.sendMail({
          from: email.connectedEmail ?? email.user ?? email.to,
          to: email.to,
          subject: "Claude Notify",
          text: message,
        });
      },
      ntfy: async (_text, prio) => {
        const priorityMap: Record<string, number> = { low: 2, normal: 3, high: 5 };
        const tags = prio === "high" ? "rotating_light" : "bell";
        const subs = ntfySubscribers.get(cfg.ntfy.topic)?.size ?? 0;
        if (subs === 0) throw new Error(`ntfy: no subscribers on topic '${cfg.ntfy.topic}'`);
        ntfyFanout(cfg.ntfy.topic, message, "Claude Notify", priorityMap[prio] ?? 3, tags);
      },
      discord: async (_text, prio) => {
        const colorMap: Record<string, number> = { low: 0x6b7280, normal: 0x7c6dfa, high: 0xef4444 };
        const r = await fetch(cfg.discord.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: cfg.discord.username ?? "Claude Notify",
            embeds: [{
              title: "Claude Notify",
              description: message,
              color: colorMap[prio] ?? colorMap.normal,
              timestamp: new Date().toISOString(),
            }],
          }),
        });
        if (!r.ok) throw new Error(`Discord ${r.status}: ${await r.text()}`);
      },
      slack: async (_text, prio) => {
        const emojiMap: Record<string, string> = { low: "ℹ️", normal: "🔔", high: "🚨" };
        const emoji = emojiMap[prio] ?? emojiMap.normal;
        const blocks = [
          { type: "section", text: { type: "mrkdwn", text: `${emoji} *Claude Notify*\n${message}` } },
          { type: "context", elements: [{ type: "mrkdwn", text: `Priority: ${prio}` }] },
        ];
        // Bot token + selected channels → one chat.postMessage per channel
        // (reusing the configured notify-bus token when none is set in config);
        // otherwise the legacy single-channel webhook.
        const slackBotToken = cfg.slack.botToken || slackCreds().token;
        if (slackBotToken && cfg.slack.channels?.length) {
          const errors: string[] = [];
          let sent = 0;
          for (const channel of cfg.slack.channels as string[]) {
            const r = await fetch("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${slackBotToken}` },
              body: JSON.stringify({ channel, text: `${emoji} *Claude Notify*`, blocks }),
            });
            const json = await r.json().catch(() => ({})) as { ok?: boolean; error?: string };
            if (r.ok && json.ok) sent++;
            else errors.push(`${channel}: ${json.error ?? r.status}`);
          }
          if (sent === 0 && errors.length) throw new Error(`Slack — ${errors.join("; ")}`);
          return;
        }
        const r = await fetch(cfg.slack.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `${emoji} *Claude Notify*`, blocks }),
        });
        if (!r.ok) throw new Error(`Slack ${r.status}: ${await r.text()}`);
      },
      teams: async (_text, prio) => {
        const colorMap: Record<string, string> = { low: "Default", normal: "Accent", high: "Attention" };
        const r = await fetch(cfg.teams.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "message",
            attachments: [{
              contentType: "application/vnd.microsoft.card.adaptive",
              contentUrl: null,
              content: {
                $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                type: "AdaptiveCard",
                version: "1.2",
                body: [
                  { type: "TextBlock", size: "Medium", weight: "Bolder", text: "Claude Notify", color: colorMap[prio] ?? "Default" },
                  { type: "TextBlock", text: message, wrap: true },
                  { type: "TextBlock", text: `Priority: ${prio}`, isSubtle: true, size: "Small" },
                ],
              },
            }],
          }),
        });
        if (!r.ok) throw new Error(`Teams ${r.status}: ${await r.text()}`);
      },
    },
  });

  if (result.suppressedReason) {
    log("·", "notify", `suppressed (${result.suppressedReason})`, client);
    return result.suppressedReason;
  }

  for (const delivered of result.delivered) {
    log("→", delivered, message, client);
  }
  for (const err of result.errors) {
    log("→", "notify", `ERROR: ${err}`, client);
  }

  return [
    result.delivered.length ? `Sent via: ${result.delivered.join(", ")}` : null,
    result.errors.length ? `Errors: ${result.errors.join("; ")}` : null,
  ].filter(Boolean).join(" | ") || "No channels delivered";
}

// ── OS idle-time (cross-platform) ─────────────────────────────────────────────
// Returns seconds since last keyboard/mouse input. -1 on error/unsupported.
// Clients call the `get_idle_seconds` tool and decide whether to fire a notif.

const IDLE_SCRIPT_PS1 = join(fileURLToPath(new URL("../../scripts/idle-check.ps1", import.meta.url)));

function getOsIdleSeconds(): number {
  try {
    if (process.platform === "win32") {
      // PowerShell + Win32 GetLastInputInfo via bundled script
      const r = spawnSync("powershell", ["-NoProfile", "-File", IDLE_SCRIPT_PS1], {
        encoding: "utf-8", windowsHide: true,
      });
      if (r.status === 0) {
        const n = parseInt((r.stdout || "").trim(), 10);
        return Number.isFinite(n) ? n : -1;
      }
      return -1;
    }
    if (process.platform === "darwin") {
      // macOS: ioreg exposes HIDIdleTime in nanoseconds
      const r = spawnSync("sh", ["-c",
        "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'"],
        { encoding: "utf-8" });
      if (r.status === 0) {
        const n = parseInt((r.stdout || "").trim(), 10);
        return Number.isFinite(n) ? n : -1;
      }
      return -1;
    }
    // Linux: xprintidle (if installed) returns ms
    const r = spawnSync("xprintidle", [], { encoding: "utf-8" });
    if (r.status === 0) {
      const ms = parseInt((r.stdout || "").trim(), 10);
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : -1;
    }
    return -1;
  } catch {
    return -1;
  }
}

function getLocalIp() {
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

// ── Ask / reply + inbox system ────────────────────────────────────────────────

interface InboxEntry { text: string; ts: string; messageId?: number; tag?: string; origin?: string }

const pendingAsks = new Map<string, { resolve: (v: string) => void; timer: NodeJS.Timeout; tag?: string }>();
const inboxQueue: InboxEntry[] = [];

// Long-poll waiters for `wait_for_inbox`. Keyed by token; filtered by tag the
// same way as `drainInboxFor`. When a new inbox entry arrives, resolve all
// matching waiters immediately with that entry — they get the message as a
// tool *result*, which every MCP client surfaces reliably (unlike server
// notifications, which Claude Code and others frequently drop).
interface InboxWaiter {
  resolve: (entries: InboxEntry[]) => void;
  timer: NodeJS.Timeout;
  tag?: string;
}
const inboxWaiters = new Map<string, InboxWaiter>();

// Match waiters the same way `matchesSession` matches SSE subscribers:
// - untagged entry → every waiter is a match (broadcast)
// - tagged entry   → only waiters with the same tag match
function takeWaitersFor(entryTag: string | undefined): InboxWaiter[] {
  const taken: InboxWaiter[] = [];
  for (const [id, w] of inboxWaiters) {
    const match = entryTag === undefined ? true : w.tag === entryTag;
    if (match) {
      inboxWaiters.delete(id);
      taken.push(w);
    }
  }
  return taken;
}
let tgPollOffset = -1;
let lastUserMessageId: number | undefined;
let lastUserChatId: string | undefined;
// When the user pings us from Telegram, bypass idle-gating on outbound
// notifs for a while — clearly they want a Telegram reply back, so we
// shouldn't gate remote channels just because they're at the keyboard
// typing. TTL is short so normal idle-gating resumes once the conversation
// goes quiet.
let lastTelegramInboundAt = 0;
const TELEGRAM_CONVO_TTL_MS = 5 * 60 * 1000;

// Page visibility: the web UI reports when it becomes visible/hidden so the
// server can skip external channels while the user is actively watching the UI.
let uiVisibleAt = 0;   // last time UI reported visible
let uiHiddenAt  = 0;   // last time UI reported hidden (0 = never seen)
const UI_VISIBLE_TTL_MS = 30_000; // if no heartbeat for 30s, treat as unknown

app.post("/api/ui/visibility", (req, res) => {
  const { visible } = req.body ?? {};
  if (visible) { uiVisibleAt = Date.now(); }
  else         { uiHiddenAt  = Date.now(); }
  res.json({ ok: true });
});

function isUiActivelyOpen(): boolean {
  if (uiVisibleAt === 0) return false;  // never reported
  if (uiHiddenAt > uiVisibleAt) return false;  // last report was hidden
  return Date.now() - uiVisibleAt < UI_VISIBLE_TTL_MS;
}

// Session tagging: a session may declare a tag (e.g. "alphawave") when it
// connects to /mcp?tag=alphawave. Telegram messages starting with "@<tag>"
// are routed only to sessions with that exact tag (tag prefix stripped).
// Untagged messages broadcast to every session — backward compatible.
const TAG_RE = /^@([A-Za-z0-9_-]+)\s+/;

function parseTag(text: string): { tag?: string; text: string } {
  const m = text.match(TAG_RE);
  if (!m) return { text };
  return { tag: m[1].toLowerCase(), text: text.slice(m[0].length) };
}

function matchesSession(entry: InboxEntry, sessionTag: string | undefined): boolean {
  if (!entry.tag) return true;            // untagged → everyone
  return entry.tag === sessionTag;        // tagged   → only matching session
}

// ── /btw file-drop bridge ─────────────────────────────────────────────────────
// Claude Code has no API for injecting a prompt into a running session while a
// tool call is executing (anthropics/claude-code#27441, still open). The only
// in-band channel is the `FileChanged` hook: when a watched file changes on
// disk, Claude Code's hook script stdout is injected as additional context on
// the next turn — without the agent having to poll.
//
// We drop every unsolicited user message into ~/.notify-mcp/inbox/<ts>.md, and
// ship a one-liner hook in the README that globs that directory. This is the
// closest thing to a "/btw" we can get until the client exposes a real inject
// endpoint.
// Test mode drops to an isolated dir so a smoke run never pollutes the live
// inbox the hook/bridge read (sim/live separation).
const INBOX_DROP_DIR = join(CONFIG_DIR, process.env.NOTIFY_MCP_TEST_ENDPOINTS === "1" ? "inbox-test" : "inbox");
const INBOX_DROP_TTL_MS = 24 * 60 * 60 * 1000; // 24h — hook should have consumed within seconds

function writeInboxDrop(entry: InboxEntry): void {
  try {
    if (!existsSync(INBOX_DROP_DIR)) mkdirSync(INBOX_DROP_DIR, { recursive: true });
    const safeTs = entry.ts.replace(/[:.]/g, "-");
    const tagPart = entry.tag ? `.${entry.tag}` : "";
    const path = join(INBOX_DROP_DIR, `${safeTs}${tagPart}.md`);
    const header = `# Unsolicited user message\n\n` +
      `- Time: ${entry.ts}\n` +
      (entry.tag ? `- Tag: @${entry.tag}\n` : "") +
      `- Origin: ${entry.origin ?? "user"} (out-of-band)\n\n`;
    const replyHint = entry.origin === "slack"
      ? `\n---\n↩ This arrived over the Slack bus — the user is WAITING in the channel. Reply there ASAP when done:\n\`\`\`\ncurl -s -X POST http://localhost:${PORT}/api/agent/slack/reply -H 'Content-Type: application/json' -d '{"text":"YOUR ANSWER","tag":"${entry.tag ?? ""}"}'\n\`\`\`\n`
      : "";
    writeFileSync(path, header + entry.text + "\n" + replyHint);
  } catch (err) {
    log("·", "inbox-drop", `write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Reap old drops so the directory doesn't grow forever. Hooks consume within
// seconds, so anything older than a day is a message the agent never saw —
// keep it for forensics but eventually clean up.
setInterval(() => {
  try {
    if (!existsSync(INBOX_DROP_DIR)) return;
    const now = Date.now();
    const files = readdirSync(INBOX_DROP_DIR);
    for (const f of files) {
      const p = join(INBOX_DROP_DIR, f);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs > INBOX_DROP_TTL_MS) unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}, 60 * 60 * 1000);

// SSE stream of new inbox messages (server-push). Each connection may filter
// by tag: /api/inbox/stream?tag=alphawave. Filtering rule mirrors poll/notify:
// untagged messages always delivered; tagged messages only when tags match.
interface SseClient { res: express.Response; tag?: string }
const inboxStreamClients = new Set<SseClient>();

function broadcastInbox(entry: InboxEntry): number {
  const payload = JSON.stringify(entry);
  let delivered = 0;
  for (const c of inboxStreamClients) {
    // Proactively drop subscribers whose socket is gone. Node's req.on("close")
    // isn't reliable on every disconnect path (e.g. VS Code window killed hard,
    // laptop lid shut), so check writability before every write.
    if (c.res.destroyed || c.res.writableEnded || !c.res.writable) {
      inboxStreamClients.delete(c);
      continue;
    }
    if (!matchesSession(entry, c.tag)) continue;
    try {
      c.res.write(`data: ${payload}\n\n`);
      delivered++;
    } catch {
      inboxStreamClients.delete(c);
    }
  }
  return delivered;
}

function ingestInboxEntry(entry: InboxEntry, source: string): { waiters: number; sse: number } {
  const waiters = takeWaitersFor(entry.tag);
  if (waiters.length > 0) {
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve([entry]);
    }
  } else {
    inboxQueue.push(entry);
    writeInboxDrop(entry);
  }
  const sse = broadcastInbox(entry);
  log("·", "inbox", `${source}: ${entry.text} (sse=${sse}, waiters=${waiters.length})`, entry.tag);
  return { waiters: waiters.length, sse };
}

// Test-only: inject a fake inbox entry exactly as the Telegram listener would.
// Gated behind NOTIFY_MCP_TEST_ENDPOINTS=1 so it's never exposed in a normal
// production run. Used by the test suite to drive wait_for_inbox wake-up and
// SSE broadcast paths without needing a real Telegram bot.
if (process.env.NOTIFY_MCP_TEST_ENDPOINTS === "1") {
  app.post("/__test__/inject-inbox", express.json(), (req, res) => {
    const text = String(req.body?.text ?? "");
    const tag = req.body?.tag ? String(req.body.tag).toLowerCase() : undefined;
    if (!text) { res.status(400).json({ error: "text required" }); return; }
    const entry: InboxEntry = { text, ts: new Date().toISOString(), tag };
    const out = ingestInboxEntry(entry, "test-inject");
    res.json({ injected: true, waiters: out.waiters, sse: out.sse });
  });
  app.get("/__test__/slack-clients", (_req, res) => {
    res.json({ tags: slackClientTags(), numbered: slackClientsNumbered() });
  });
  log("·", "test", "NOTIFY_MCP_TEST_ENDPOINTS=1 — /__test__/inject-inbox + /__test__/slack-clients enabled");
}

app.get("/api/inbox/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const tag = typeof req.query.tag === "string" ? req.query.tag.toLowerCase() : undefined;
  // Initial comment so the client knows the stream is alive.
  res.write(`: connected ${new Date().toISOString()}${tag ? ` tag=${tag}` : ""}\n\n`);
  const client: SseClient = { res, tag };
  inboxStreamClients.add(client);
  // Keep-alive ping every 20s so intermediate proxies / curl don't time out
  // and so the client sees the connection is still live.
  const keepAlive = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 20_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    inboxStreamClients.delete(client);
  });
});

// ── Non-MCP automation API ───────────────────────────────────────────────────
// These endpoints let an agent script use plain HTTP (no MCP transport) for
// notify + unsolicited inbox handling.

app.post("/api/agent/notify", async (req, res) => {
  if (!requireAgentAuth(req, res)) return;
  const message = String(req.body?.message ?? "").trim();
  const priority = (String(req.body?.priority ?? "normal") as "low" | "normal" | "high");
  if (!message) { res.status(400).json({ error: "message required" }); return; }
  if (!["low", "normal", "high"].includes(priority)) { res.status(400).json({ error: "invalid priority" }); return; }
  try {
    const out = await sendNotification(message, priority, "agent-http");
    res.json({ ok: true, result: out });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/agent/inbox/poll", (req, res) => {
  if (!requireAgentAuth(req, res)) return;
  const tag = typeof req.query.tag === "string" ? req.query.tag.toLowerCase() : undefined;
  const messages = drainInboxFor(tag);
  res.json({ ok: true, messages });
});

app.get("/api/agent/inbox/wait", async (req, res) => {
  if (!requireAgentAuth(req, res)) return;
  const tag = typeof req.query.tag === "string" ? req.query.tag.toLowerCase() : undefined;
  const timeoutSecondsRaw = parseInt(String(req.query.timeout_seconds ?? "50"), 10);
  const timeoutSeconds = Number.isFinite(timeoutSecondsRaw) ? Math.max(5, Math.min(55, timeoutSecondsRaw)) : 50;

  const queued = drainInboxFor(tag);
  if (queued.length > 0) {
    res.json({ ok: true, messages: queued, empty: false });
    return;
  }

  const token = randomUUID();
  const entries = await new Promise<InboxEntry[]>((resolve) => {
    const timer = setTimeout(() => {
      inboxWaiters.delete(token);
      resolve([]);
    }, timeoutSeconds * 1000);
    inboxWaiters.set(token, { resolve, timer, tag });
  });
  res.json({ ok: true, messages: entries, empty: entries.length === 0 });
});

app.post("/api/agent/inbox/inject", (req, res) => {
  if (!requireAgentAuth(req, res)) return;
  const text = String(req.body?.text ?? "").trim();
  if (!text) { res.status(400).json({ error: "text required" }); return; }
  const tag = req.body?.tag ? String(req.body.tag).toLowerCase() : undefined;
  const entry: InboxEntry = { text, ts: new Date().toISOString(), tag };
  const out = ingestInboxEntry(entry, "agent-inject");
  res.json({ ok: true, waiters: out.waiters, sse: out.sse });
});

app.post("/api/agent/slack/reply", (req, res) => {
  if (!requireAgentAuth(req, res)) return;
  const text = String(req.body?.text ?? "").trim();
  if (!text) { res.status(400).json({ error: "text required" }); return; }
  const tag = req.body?.tag ? String(req.body.tag).toLowerCase() : undefined;
  slackPost(tag ? `[@${tag}] ${text}` : text);
  log("→", "slack:reply", text, tag);
  res.json({ ok: true });
});

// Interactive-session busy/idle, reported by that session's hooks (busy on
// UserPromptSubmit/PreToolUse/PostToolUse, idle on Stop). Lets the bus tell the
// user "Claude is busy" + a rough ETA when a request lands on a busy prompt.
const sessionBusy: Record<string, { busy: boolean; since: number }> = {};
const busyDurations: number[] = [];

function setSessionState(tag: string, busy: boolean): void {
  const prev = sessionBusy[tag];
  if (busy) {
    if (!prev?.busy) sessionBusy[tag] = { busy: true, since: Date.now() };
  } else {
    if (prev?.busy) {
      busyDurations.push(Date.now() - prev.since);
      if (busyDurations.length > 20) busyDurations.shift();
    }
    sessionBusy[tag] = { busy: false, since: 0 };
  }
}

function busyEtaSecs(): number | null {
  if (!busyDurations.length) return null;
  return Math.round(busyDurations.reduce((a, b) => a + b, 0) / busyDurations.length / 1000);
}

function sessionBusyNote(tag: string): string {
  const s = sessionBusy[tag];
  if (!s?.busy) return "";
  const secs = Math.round((Date.now() - s.since) / 1000);
  const eta = busyEtaSecs();
  return `🔧 Claude @${tag} is busy right now (working ${secs}s) — your request is queued and runs the moment the prompt is free.${eta ? ` Turns here usually finish in ~${eta}s.` : ""}`;
}

app.post("/api/session/state", (req, res) => {
  const tag = req.body?.tag ? String(req.body.tag).toLowerCase() : undefined;
  if (!tag) { res.status(400).json({ error: "tag required" }); return; }
  setSessionState(tag, req.body?.busy === true || req.body?.busy === "true");
  res.json({ ok: true, busy: sessionBusy[tag]?.busy ?? false });
});

// Slack Events API (inbound). Requires configuring your Slack app with an
// Event Request URL: POST /api/slack/events.
app.post("/api/slack/events", (req, res) => {
  let body: any = req.body ?? {};
  if (body?.payload && typeof body.payload === "string") {
    try {
      body = JSON.parse(body.payload);
    } catch {
      // keep original body if payload isn't valid JSON
    }
  }
  if ((!body || Object.keys(body).length === 0) && (req as express.Request & { rawBody?: Buffer }).rawBody) {
    const raw = ((req as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("{}")).toString("utf8");
    try {
      body = JSON.parse(raw);
    } catch {
      body = req.body ?? {};
    }
  }

  // Slack URL verification can arrive before full event wiring, and some
  // intermediaries/proxies send this as form data. Respond immediately when
  // a challenge value is present so the URL can be saved.
  const challenge = body?.challenge ?? (typeof req.query.challenge === "string" ? req.query.challenge : undefined);
  if (challenge) {
    log("·", "slack", "url_verification challenge received");
    res.status(200).json({ challenge });
    return;
  }

  if (!verifySlackSignature(req)) {
    log("·", "slack", "rejected: bad signature");
    res.status(401).json({ error: "bad slack signature" });
    return;
  }

  const envelopeType = String(body?.type ?? "unknown");
  const event = body?.event ?? {};
  const eventType = String(event?.type ?? "none");
  const subtype = typeof event?.subtype === "string" ? event.subtype : "";
  const channel = String(event?.channel ?? body?.channel_id ?? "none");
  log("·", "slack", `event: envelope=${envelopeType}, type=${eventType}, subtype=${subtype || "none"}, channel=${channel}`);

  if (body.type !== "event_callback") {
    res.json({ ok: true, ignored: true, reason: `unsupported envelope type: ${envelopeType}` });
    return;
  }

  const ignoreReasons: string[] = [];
  if (event.type !== "message") ignoreReasons.push(`event.type=${eventType}`);
  if (subtype) ignoreReasons.push(`subtype=${subtype}`);
  if (event.bot_id) ignoreReasons.push("bot message");
  if (!event.text) ignoreReasons.push("missing text");

  if (event.type !== "message" || subtype || event.bot_id || !event.text) {
    const reason = ignoreReasons.join(", ") || "filtered";
    log("·", "slack", `ignored: ${reason}`);
    res.json({ ok: true, ignored: true, reason });
    return;
  }

  const parsed = parseTag(String(event.text));
  const candidate = [...pendingAsks.entries()].find(([, p]) => (parsed.tag ? p.tag === parsed.tag : true));
  if (candidate) {
    const [id, pending] = candidate;
    clearTimeout(pending.timer);
    pendingAsks.delete(id);
    log("←", "ask:reply", parsed.text, parsed.tag);
    pending.resolve(parsed.text);
    res.json({ ok: true, routed: "ask" });
    return;
  }

  const ts = event.ts ? new Date(Number(event.ts) * 1000).toISOString() : new Date().toISOString();
  const entry: InboxEntry = {
    text: parsed.text,
    tag: parsed.tag,
    ts,
  };
  const out = ingestInboxEntry(entry, "slack");
  res.json({ ok: true, routed: "inbox", waiters: out.waiters, sse: out.sse });
});

async function initTgOffset(token: string): Promise<number> {
  const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`);
  const json = await r.json() as any;
  const results: any[] = json.result ?? [];
  return results.length > 0 ? results[results.length - 1].update_id + 1 : 0;
}

// Backoff + dedupe state for the long-poll loop. A flaky network or revoked
// token used to spam the activity log with one line every 2s; instead we now
// back off exponentially and collapse repeated identical errors into a count.
let tgConsecutiveErrors = 0;
let tgLastErrorMsg: string | null = null;
let tgLastErrorCount = 0;
let tgLastErrorLoggedAt = 0;

function logTelegramError(msg: string) {
  const now = Date.now();
  if (msg === tgLastErrorMsg) {
    tgLastErrorCount++;
    // Re-emit a rollup line at most once every 30s while errors keep repeating.
    if (now - tgLastErrorLoggedAt > 30_000) {
      log("·", "telegram:error", `${msg} (×${tgLastErrorCount} since last log)`);
      tgLastErrorLoggedAt = now;
      tgLastErrorCount = 0;
    }
  } else {
    log("·", "telegram:error", msg);
    tgLastErrorMsg = msg;
    tgLastErrorCount = 0;
    tgLastErrorLoggedAt = now;
  }
}

async function startTelegramListener() {
  while (true) {
    try {
      const cfg = loadConfig();
      const { token, chatIds } = cfg.telegram ?? {};
      if (!token || !Array.isArray(chatIds) || chatIds.length === 0) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (tgPollOffset < 0) {
        tgPollOffset = await initTgOffset(token);
        log("·", "telegram", `listener ready, offset=${tgPollOffset}`);
      }
      const r = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${tgPollOffset}&timeout=10`,
        { signal: AbortSignal.timeout(15_000) }
      );
      // Reset error state on any successful fetch.
      if (tgConsecutiveErrors > 0) {
        log("·", "telegram", `recovered after ${tgConsecutiveErrors} failed attempt(s)`);
        tgConsecutiveErrors = 0;
        tgLastErrorMsg = null;
        tgLastErrorCount = 0;
      }
      const json = await r.json() as any;
      for (const update of json.result ?? []) {
        tgPollOffset = update.update_id + 1;
        const msg = update.message;
        const fromChatId = msg?.chat?.id?.toString();
        if (fromChatId && chatIds.includes(fromChatId) && msg.text) {
          log("←", "telegram", msg.text);
          lastUserMessageId = msg.message_id;
          lastUserChatId = fromChatId;
          lastTelegramInboundAt = Date.now();
          const { tag, text } = parseTag(msg.text);
          // Match an outstanding ask first. If the message is tagged, only
          // route to a pending ask from that same session — otherwise fall
          // through to the inbox so the targeted session can pick it up.
          const candidate = [...pendingAsks.entries()].find(([, p]) =>
            tag ? p.tag === tag : true
          );
          if (candidate) {
            const [id, pending] = candidate;
            clearTimeout(pending.timer);
            pendingAsks.delete(id);
            log("←", "ask:reply", text, tag);
            pending.resolve(text);
          } else {
            const entry: InboxEntry = {
              text, ts: new Date().toISOString(), messageId: msg.message_id, tag,
            };
            // Waiters (wait_for_inbox long-poll) get first crack — they were
            // already parked by an agent explicitly asking "wake me up when
            // something arrives." Hand the entry off as a tool *result*, which
            // every MCP client actually surfaces. Only queue if no one was
            // waiting, so the message isn't delivered twice.
            const waiters = takeWaitersFor(tag);
            if (waiters.length > 0) {
              for (const w of waiters) {
                clearTimeout(w.timer);
                w.resolve([entry]);
              }
              log("·", "inbox", `${text} → ${waiters.length} long-poll waiter(s)`, tag);
            } else {
              inboxQueue.push(entry);
            }
            writeInboxDrop(entry);
            const liveSseCount = broadcastInbox(entry);
            log("·", "inbox", `${text} (sse=${liveSseCount}, waiters=${waiters.length})`, tag);
            const sseCount = sseSubscribersForTag(tag);
            const anyoneListening = sseCount > 0 || waiters.length > 0;
            let ackText: string;
            if (!anyoneListening && tag) {
              ackText = `📭 No session @${tag} connected. Message queued — next @${tag} to connect will pick it up.`;
            } else if (!anyoneListening) {
              ackText = `📭 No agents connected. Message queued — next agent to connect will pick it up.`;
            } else {
              ackText = tag
                ? `📬 Routed to @${tag}. Waiting for reply.`
                : `📬 Broadcast to ${sseCount} listener${sseCount === 1 ? "" : "s"}. Waiting for reply.`;
            }
            fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: fromChatId,
                text: ackText,
                reply_to_message_id: msg.message_id,
              }),
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("terminated") && !msg.includes("aborted")) {
        logTelegramError(msg);
      }
      tgConsecutiveErrors++;
      // Exponential backoff: 2s → 5s → 10s → 20s → 40s → cap at 60s.
      const delay = Math.min(60_000, 2000 * Math.pow(2, Math.min(5, tgConsecutiveErrors - 1)));
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── Slack inbound poller (always-on; folds slack-poll.sh → #16) ────────────────
const SLACK_SECRETS_PATH = join(fileURLToPath(new URL("../../notify-secrets.json", import.meta.url)));

function decodeB64Fields(obj: any): any {
  if (Array.isArray(obj)) return obj.map(decodeB64Fields);
  if (obj && typeof obj === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.endsWith("_b64") && typeof v === "string") out[k.slice(0, -4)] = Buffer.from(v, "base64").toString("utf8");
      else out[k] = decodeB64Fields(v);
    }
    return out;
  }
  return obj;
}

function loadSecrets(): Record<string, any> {
  if (!existsSync(SLACK_SECRETS_PATH)) return {};
  try {
    return decodeB64Fields(JSON.parse(readFileSync(SLACK_SECRETS_PATH, "utf8")));
  } catch (err) {
    log("·", "secrets", `load failed: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function slackCreds(): { token?: string; channel?: string; webhook?: string } {
  const s = loadSecrets().slack ?? {};
  const cfgSlack = loadConfig().slack ?? {};
  const token = (process.env.SLACK_BOT_TOKEN ?? s.botToken ?? cfgSlack.botToken ?? "").trim() || undefined;
  const channel = (process.env.SLACK_CHANNEL_ID ?? s.channelId ?? "").trim() || undefined;
  const webhook = (s.webhookUrl ?? cfgSlack.webhookUrl ?? "").trim() || undefined;
  return { token, channel, webhook };
}

// Brainless config: on startup, copy any credentials already present in
// notify-secrets.json (decoded) into config.json's EMPTY fields, so a user who
// has the shared secrets file gets every channel pre-wired without touching the
// UI. Never overwrites a value the user already set. Idempotent.
function importCredsOnStart(): void {
  let secrets: Record<string, any>;
  try { secrets = loadSecrets(); } catch { return; }
  if (!secrets || Object.keys(secrets).length === 0) return;
  const cfg = loadConfig();
  let changed = false;
  const fill = (sec: string, key: string, val: any) => {
    if (val === undefined || val === null || val === "") return;
    cfg[sec] = cfg[sec] ?? {};
    if (cfg[sec][key] === undefined || cfg[sec][key] === "" ) { cfg[sec][key] = val; changed = true; }
  };
  const fillArrayFromScalar = (sec: string, arrKey: string, val: any) => {
    if (val === undefined || val === null || val === "") return;
    cfg[sec] = cfg[sec] ?? {};
    if (!Array.isArray(cfg[sec][arrKey]) || cfg[sec][arrKey].length === 0) { cfg[sec][arrKey] = [String(val)]; changed = true; }
  };
  if (secrets.telegram) {
    fill("telegram", "token", secrets.telegram.token);
    fillArrayFromScalar("telegram", "chatIds", secrets.telegram.chatId);
  }
  if (secrets.email) for (const k of ["host", "port", "secure", "user", "pass", "connectedEmail", "to"]) fill("email", k, secrets.email[k]);
  if (secrets.slack) {
    fill("slack", "botToken", secrets.slack.botToken);
    fill("slack", "webhookUrl", secrets.slack.webhookUrl);
    fillArrayFromScalar("slack", "channels", secrets.slack.channelId);
  }
  if (secrets.ntfy) { fill("ntfy", "token", secrets.ntfy.token); fill("ntfy", "topic", secrets.ntfy.topic); }
  if (secrets.sms) {
    for (const k of ["accessKeyId", "secretAccessKey", "region", "originationNumber"]) fill("sms", k, secrets.sms[k]);
    if (secrets.sms.enabled && cfg.sms?.accessKeyId && cfg.sms.enabled !== true) { cfg.sms.enabled = true; changed = true; }
  }
  if (changed) {
    saveConfig(cfg);
    log("·", "import", "imported credentials from notify-secrets.json into config.json (empty fields only)");
  }
}

async function slackPost(text: string): Promise<void> {
  const { webhook } = slackCreds();
  if (!webhook) return;
  try {
    await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  } catch { /* webhook post is best-effort */ }
}

// Tags a user can @-address from Slack: only real interactive panels — tags
// backed by a live MCP session or SSE stream. Waiter-only tags (the notify-watch
// `…-bot` auto-responder long-polling /api/agent/inbox/wait) are intentionally
// excluded: they receive broadcasts but are not something a human addresses.
function slackClientTags(): string[] {
  pruneDeadSessions();
  const tags = new Set<string>();
  for (const sess of listActiveSessions()) if (sess.tag) tags.add(sess.tag);
  for (const c of inboxStreamClients) {
    if (c.res.destroyed || c.res.writableEnded || !c.res.writable) continue;
    if (c.tag) tags.add(c.tag);
  }
  return [...tags].sort();
}

// How many live agents would actually receive a message with this tag (undefined
// = broadcast). Counts live SSE subscribers, parked long-poll waiters, and MCP
// sessions. Used to gate the Slack ack: a "ack" posted when nobody is connected
// is a lie — the message only sits queued for the next connector.
function liveListenerCount(tag: string | undefined): number {
  pruneDeadSessions();
  let waiters = 0;
  for (const [, w] of inboxWaiters) if (!tag || w.tag === tag) waiters++;
  return sseSubscribersForTag(tag) + waiters + sessionsMatchingTag(tag).length;
}

function slackClientsNumbered(): string {
  const tags = slackClientTags();
  if (!tags.length) return "(none connected)";
  return tags.map((t, i) => {
    const panels = sessionsMatchingTag(t).length;
    const suffix = panels > 1 ? ` (${panels} panels)` : "";
    return `${i + 1}. ${displayTag(t)}${suffix}`;
  }).join("\n");
}

function resolveSlackClient(handle: string): string | undefined {
  const tags = slackClientTags();
  if (/^[0-9]+$/.test(handle)) return tags[parseInt(handle, 10) - 1];
  return tags.find(t => t === handle || displayTag(t) === handle);
}

async function handleSlackCommand(lc: string): Promise<boolean> {
  if (lc === "list clients" || lc === "clients" || lc === "list") {
    await slackPost(`Connected clients — reply @<name> or #<id>:\n${slackClientsNumbered()}`);
    return true;
  }
  if (lc === "help" || lc === "commands" || lc === "?") {
    await slackPost("Commands: `clients`. Direct: `@<name> msg`, `#<id> msg`, or untagged → broadcast to all.");
    return true;
  }
  return false;
}

let slackCursor = "";
let slackConsecutiveErrors = 0;

async function pollSlackOnce(token: string, channel: string): Promise<void> {
  const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&oldest=${encodeURIComponent(slackCursor)}&limit=50`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  const json = await r.json() as any;
  if (!json.ok) throw new Error(`conversations.history: ${json.error ?? "unknown"}`);
  const all: any[] = json.messages ?? [];
  const human = all
    .filter(m => !m.subtype && !m.bot_id && !m.app_id && m.user && String(m.text ?? "").trim())
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  for (const m of human) {
    const text = String(m.text ?? "");
    const stripped = text.replace(/<@[A-Za-z0-9]+>/g, "");
    const lc = stripped.toLowerCase().trim();
    if (await handleSlackCommand(lc)) { log("←", "slack:cmd", lc); continue; }
    const clean = stripped.replace(/^\s+/, "");
    const routed = clean.match(/^[@#]([^\s]+)\s+([\s\S]*)$/);
    if (routed) {
      const handle = routed[1];
      const msg = routed[2];
      const tag = resolveSlackClient(handle);
      if (!tag) {
        await slackPost(`❌ Unknown client "${handle}". Connected:\n${slackClientsNumbered()}`);
        log("←", "slack", `unknown client: ${handle}`);
        continue;
      }
      ingestInboxEntry({ text: msg, ts: new Date().toISOString(), tag, origin: "slack" }, "slack");
      if (liveListenerCount(tag) > 0) await slackPost(sessionBusyNote(tag) || "ack");
    } else {
      ingestInboxEntry({ text, ts: new Date().toISOString(), origin: "slack" }, "slack");
      if (liveListenerCount(undefined) > 0) await slackPost("ack");
    }
  }
  const newest = all.reduce((acc, m) => (Number(m.ts) > Number(acc || 0) ? String(m.ts) : acc), slackCursor);
  if (newest) slackCursor = newest;
}

async function startSlackListener() {
  const interval = (Number(process.env.SLACK_POLL_INTERVAL) || 2) * 1000;
  while (true) {
    try {
      const { token, channel } = slackCreds();
      if (!token || !channel) { await new Promise(r => setTimeout(r, 5000)); continue; }
      if (!slackCursor) {
        slackCursor = String(Math.floor(Date.now() / 1000) - 300);
        log("·", "slack", `listener ready, channel=${channel}, backfill=300s (closes restart gap)`);
      }
      await pollSlackOnce(token, channel);
      if (slackConsecutiveErrors > 0) { log("·", "slack", `recovered after ${slackConsecutiveErrors} attempt(s)`); slackConsecutiveErrors = 0; }
      await new Promise(r => setTimeout(r, interval));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("terminated") && !msg.includes("aborted")) log("·", "slack:error", msg);
      slackConsecutiveErrors++;
      const delay = Math.min(60_000, 2000 * Math.pow(2, Math.min(5, slackConsecutiveErrors - 1)));
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

app.get("/reply/:token", (req, res) => {
  const pending = pendingAsks.get(req.params.token);
  res.send(`<!DOCTYPE html><html><head><title>Reply to Claude</title>
<style>body{font-family:sans-serif;background:#0a0a0b;color:#f0f0f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#111113;border:1px solid #222226;border-radius:9px;padding:24px;max-width:500px;width:90%}
h2{color:#7c6dfa;margin:0 0 16px}textarea{width:100%;background:#0d0d10;border:1px solid #222226;border-radius:7px;color:#f0f0f0;padding:8px;font-size:14px;resize:vertical;min-height:80px;box-sizing:border-box}
button{background:#7c6dfa;color:white;border:none;border-radius:7px;padding:8px 20px;font-size:14px;cursor:pointer;margin-top:10px}
.ok{color:#10b981;margin-top:12px}.err{color:#ef4444}</style></head>
<body><div class="box">${pending
    ? `<h2>Reply to Claude</h2><textarea id="r" placeholder="Type your response…"></textarea>
       <button onclick="send()">Send</button><div id="s"></div>
       <script>async function send(){const r=document.getElementById('r').value.trim();if(!r)return;
       const res=await fetch('/reply/${req.params.token}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({response:r})});
       const el=document.getElementById('s');el.textContent=res.ok?'✓ Sent!':'Error';el.className=res.ok?'ok':'err';}</script>`
    : `<h2>Expired</h2><p class="err">This link has already been used or timed out.</p>`
  }</div></body></html>`);
});

app.post("/reply/:token", (req, res) => {
  const pending = pendingAsks.get(req.params.token);
  if (!pending) { res.status(404).json({ error: "Expired" }); return; }
  clearTimeout(pending.timer);
  pendingAsks.delete(req.params.token);
  log("←", "web-reply", req.body.response as string);
  pending.resolve(req.body.response as string);
  res.json({ ok: true });
});

// ── MCP server ────────────────────────────────────────────────────────────────

function drainInboxFor(tag: string | undefined): InboxEntry[] {
  const taken: InboxEntry[] = [];
  for (let i = inboxQueue.length - 1; i >= 0; i--) {
    if (matchesSession(inboxQueue[i], tag)) {
      taken.unshift(inboxQueue[i]);
      inboxQueue.splice(i, 1);
    }
  }
  return taken;
}

// Appends an inbox block to any tool's text payload when messages are pending
// for the given session. Lets cheap read tools (get_idle_seconds, get_dnd_status)
// double as inbox drains, so a busy agent calling them as a keepalive still
// sees user messages even when it hasn't called notify/poll in a while.
function appendInbox(baseText: string, sessionTag: string | undefined, clientId: string | undefined): string {
  const messages = drainInboxFor(sessionTag);
  if (messages.length === 0) return baseText;
  log("·", "poll", `${messages.length} message(s) drained via heartbeat`, clientId);
  const inbox = messages.map(m => `[${m.ts}] ${m.text}`).join("\n");
  return `${baseText}\n\n⚠️ USER SENT YOU A MESSAGE — STOP AND RESPOND BEFORE CONTINUING:\n${inbox}`;
}

const MCP_INSTRUCTIONS = `
This server delivers notifications to the user through whatever channels the
user has configured on the server side. The client never needs to know which
channels are in use — just call 'notify' or 'ask' with a generic message.

BEHAVIORAL RULES for every client that connects:

1. ALWAYS call 'notify' in these three situations — idle or not, DND or not,
   the server decides routing, you decide whether to fire:

   (a) LONG PROCESSING FINISHED. Any single task that took more than ~60
       seconds of wall-clock time (long build, test run, backtest, migration,
       big refactor, multi-step plan) gets a 'notify' the moment it completes
       — success OR failure. Rule of thumb: if the user could have reasonably
       walked away to grab coffee while you ran, they need a ping on the way
       back. Don't try to guess whether they were watching. Just notify.

   (b) YOU HAVE A QUESTION OR NEED A DECISION. Any time you're about to ask
       the user something — "should I delete these?", "which branch?",
       "proceed with plan B?" — fire 'notify' (or 'ask' for blocking
       two-way). Silent questions in the terminal get missed; a notification
       does not.

   (c) SOMETHING IMPORTANT HAPPENED that the user needs to know about right
       now. Examples: a test suddenly failed after being green, a destructive
       operation is about to run, you found a security issue, a deploy
       succeeded, a production service looks degraded, you hit an
       unrecoverable error. When in doubt on importance, ERR ON THE SIDE OF
       NOTIFYING — the server's idle gating will automatically downgrade a
       mis-judged 'normal' to a silent desktop banner if the user is active,
       so the cost of over-notifying is near zero. The cost of missing a
       real event is that the user finds out 4 hours later.

   The SERVER handles all routing (DND, idle threshold, channel selection,
   priority escalation). You do NOT need to pre-flight with
   'get_idle_seconds' before these three triggers — fire 'notify' and let
   the server decide. get_idle_seconds is the HEARTBEAT primitive (rule 6),
   not a gate on legitimate milestones.

2. Use priority correctly:
   - 'low'    = email only — for low-stakes status (background completion).
   - 'normal' = desktop + Telegram + email — the default.
   - 'high'   = all channels including SMS — bypasses DND AND idle gating.
                Use ONLY for catastrophic findings or decisions that block
                progress. Misuse will train the user to ignore your notifs.

3. Echo the COMPLETE, UNTRUNCATED message body in your own chat / conversation
   output as well as sending it through 'notify'. The user may be reading the
   terminal directly; don't rely on them checking their phone / email. Do NOT
   shorten, summarise, or cut off the message with "…" in your chat output —
   show every word exactly as sent.

4. The message body should be channel-agnostic. Never name 'Telegram', 'SMS',
   'email', 'desktop', etc. in your messages or in your chat output — those are
   server delivery details the user has already configured and the client has
   no business surfacing. Do NOT echo "Sent via: <channel list>" or any
   variant of it. Just say 'notif' or 'notification' if you need to refer to
   the act of notifying.

5. When the user sends you an unsolicited message (visible as INBOX items in
   the 'notify' response, via 'poll', via 'wait_for_inbox', via
   'get_idle_seconds' piggy-back, or via the /api/inbox/stream SSE), reply to
   them THROUGH 'notify' so the reply
   actually reaches them — not just in your chat output. Multiple agents may
   be connected simultaneously — the server broadcasts every untagged inbox
   message to all of them, so the user can see who is listening. Your reply
   MUST identify which session you are (start with your own tag or client id,
   e.g. "[@alphawave]" or "[sess-abcd]") and give a brief status so the user
   can pick whom to respond to. If the user tagged their message (@<tag>),
   only the session with that tag should reply. If you are untagged and
   another session with the same project/workdir is already tagged, let the
   tagged one reply.

5a. BUSY-ACK RULE (hard requirement): The moment you notice a user inbox
    message — whether via notify response, heartbeat piggy-back, or poll —
    REPLY IMMEDIATELY via 'notify' with a terse status, EVEN IF YOU CAN'T
    ACT ON THE REQUEST YET. Do not finish the current tool/task first.
    Drop what you're doing long enough to fire one 'notify' call, THEN
    resume. Format: "[<your-session-id>] busy on <current-task>; will
    respond at <milestone>". The user needs to know (a) you heard them,
    (b) you're not the stuck one, (c) when to expect a real answer. An
    inbox message that gets a delayed reply is worse than no reply — it
    wastes the user's time waiting on silence.

6. The 'get_idle_seconds', 'get_idle_config', and 'get_dnd_status' tools are
   informational reads, but they ALSO drain pending inbox messages. Use them
   as a cheap heartbeat during long work: call 'get_idle_seconds' EVERY 15-
   30 SECONDS while a long task runs (loop iteration, backtest, scan, build,
   etc.). If the user sent you a message while you were busy, it comes back
   piggy-backed on the response — you don't need to separately call 'poll'.
   This is a lightweight local read (no network, no DND or channel routing),
   so the cost is near zero. Without this heartbeat pattern, a busy agent is
   deaf to the user until its next 'notify' call — which may be minutes or
   hours away during long work. Treat 'get_idle_seconds' as the "check for
   user input" primitive, not an idle-gate check.

   If your work is naturally idle (waiting for the user, between loop iters),
   prefer 'wait_for_inbox' instead — it blocks up to 50s and returns the
   moment the user types anything, as a tool result. That's the most reliable
   delivery path across every MCP client (notifications over SSE are silently
   dropped by Claude Code, Cursor, and others). Loop pattern:
     while (true) {
       const r = await wait_for_inbox({ timeout_seconds: 50 });
       if (r !== "inbox:empty") handle(r);
     }

7. If your tool call fails with "MCP server not connected" / "transport
   closed" / similar — the SERVER IS ALMOST CERTAINLY FINE. Other clients are
   connected to the same server right now. Only YOUR client's transport
   broke (commonly: stdio child process died, or HTTP client gave up after a
   transient slow response at startup). DO NOT tell the user "notify is down"
   without first probing the server directly.

   Probe before declaring the server dead:
     curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3737/mcp
   - 406 (Not Acceptable) = server is healthy, doing MCP protocol
     negotiation. Your client is the broken party. Use the bypass below.
   - Connection refused / timeout = server is genuinely down. Tell the user.

   HTTP-transport bypass when your MCP client is broken (works from any
   shell that has curl). Three calls, stateful — the session id from step 1
   must be passed in mcp-session-id on every subsequent call:

     # 1) initialize and capture session id from response headers
     SID=$(curl -s -i -X POST http://localhost:3737/mcp \
       -H "Content-Type: application/json" \
       -H "Accept: application/json, text/event-stream" \
       -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl-bridge","version":"1.0"}}}' \
       | grep -i "^mcp-session-id:" | awk '{print $2}' | tr -d '\r')

     # 2) ack initialized (no response body, fire-and-forget)
     curl -s -X POST http://localhost:3737/mcp \
       -H "Content-Type: application/json" \
       -H "Accept: application/json, text/event-stream" \
       -H "mcp-session-id: $SID" \
       -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

     # 3) call any tool — successful response includes "Sent via: <channel>"
     curl -s -X POST http://localhost:3737/mcp \
       -H "Content-Type: application/json" \
       -H "Accept: application/json, text/event-stream" \
       -H "mcp-session-id: $SID" \
       -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"notify","arguments":{"message":"YOUR MESSAGE","priority":"normal"}}}'

   Same pattern works for 'ask', 'poll', 'get_idle_seconds', etc. — change
   the "name" and "arguments" in step 3. Reuse the same $SID for all calls
   in one bypass session.

   Bottom line: rule #1 still applies. If you owe the user a notify and your
   MCP client is broken, you owe them the bypass — not an excuse.
`.trim();

function createMcpServer(clientId: string, sessionTag?: string) {
  const identity = `@${clientId}`;
  const identityLine = `\nYOUR SESSION IDENTITY: "${identity}" — use this as your prefix in all notify replies (e.g. "[${identity}] done with build").\n`;
  const server = new McpServer(
    { name: "notify-mcp", version: "1.0.0" },
    { instructions: identityLine + MCP_INSTRUCTIONS }
  );

  server.tool(
    "notify",
    "Send a notification to the user. Delivery channels and DND are server-configured. " +
      "Before calling, check get_idle_seconds against get_idle_config.thresholdSeconds; " +
      "skip the call if the user is active (unless priority='high'). " +
      "Use for: task milestones, questions needing input, catastrophic findings, long task completion.",
    {
      message: z.string().max(500).describe("Notification message, max 500 chars"),
      priority: z.enum(["low", "normal", "high"]).default("normal")
        .describe("low=email only; normal=desktop+telegram+email; high=all channels"),
    },
    async ({ message, priority }: { message: string; priority: "low" | "normal" | "high" }) => {
      const outbound = `[${clientId}] ${message}`;
      const summary = await sendNotification(outbound, priority, clientId);
      const messages = drainInboxFor(sessionTag);
      if (messages.length === 0) {
        return { content: [{ type: "text" as const, text: summary }] };
      }
      log("·", "poll", `${messages.length} message(s) drained via notify`, clientId);
      const inbox = messages.map(m => `[${m.ts}] ${m.text}`).join("\n");
      return { content: [{ type: "text" as const, text: `${summary}\n\n⚠️ USER SENT YOU A MESSAGE — STOP AND RESPOND BEFORE CONTINUING:\n${inbox}` }] };
    }
  );

  server.tool(
    "ask",
    "Send a question to the user and wait for their reply. Channels are server-configured. " +
      "Use when a decision is needed before continuing — e.g. 'Should I delete these files?'",
    {
      question: z.string().max(500).describe("The question to ask the user"),
      timeout_seconds: z.number().min(30).max(3600).default(300)
        .describe("How long to wait for a reply in seconds (default 5 min)"),
    },
    async ({ question, timeout_seconds = 300 }: { question: string; timeout_seconds?: number }) => {
      const token = randomUUID();
      const ip = getLocalIp();
      const replyUrl = `http://${ip}:${PORT}/reply/${token}`;
      const cfg = loadConfig();

      log("→", "ask:telegram", question, clientId);
      if (cfg.telegram?.enabled && cfg.telegram.token && cfg.telegram.chatIds?.length) {
        const askPrefix = `❓ [${clientId}]`;
        const replyHint = sessionTag
          ? `\n\nReply with: @${sessionTag} <your answer>`
          : `\n\nReply to this message with your answer.`;
        for (const chatId of cfg.telegram.chatIds as string[]) {
          await fetch(`https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: `${askPrefix} ${question}${replyHint}`,
            }),
          }).catch((err) => log("→", "ask:telegram", `ERROR: ${err}`, clientId));
        }
      }

      const email = cfg.email ?? {};
      if (email.enabled && email.to) {
        try {
          let transport;
          if (email.refreshToken && email.clientId && email.clientSecret) {
            transport = nodemailer.createTransport({
              service: "gmail", auth: { type: "OAuth2", user: email.connectedEmail ?? email.to,
                clientId: email.clientId, clientSecret: email.clientSecret,
                refreshToken: email.refreshToken, accessToken: email.accessToken },
            });
          } else if (email.host && email.user && email.pass) {
            transport = nodemailer.createTransport({
              host: email.host, port: email.port ?? 587, secure: email.secure ?? false,
              auth: { user: email.user, pass: email.pass },
            });
          }
          if (transport) {
            await transport.sendMail({
              from: email.connectedEmail ?? email.user ?? email.to,
              to: email.to,
              subject: `Claude asks: ${question.slice(0, 60)}`,
              html: `<p style="font-size:16px">${question}</p>
                     <p><a href="${replyUrl}" style="background:#7c6dfa;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">Reply to Claude</a></p>`,
            });
            log("→", "ask:email", `question sent to ${email.to}, reply URL: ${replyUrl}`, clientId);
          }
        } catch (err) {
          log("→", "ask:email", `ERROR: ${err instanceof Error ? err.message : String(err)}`, clientId);
        }
      }

      log("→", "ask", `waiting for reply (timeout: ${timeout_seconds}s)`, clientId);
      const reply = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingAsks.delete(token);
          reject(new Error(`No reply received within ${timeout_seconds}s`));
        }, timeout_seconds * 1000);
        pendingAsks.set(token, { resolve, timer, tag: sessionTag });
      });

      log("←", "ask:reply", reply, clientId);
      return { content: [{ type: "text" as const, text: reply }] };
    }
  );

  server.tool(
    "poll",
    "Check for unsolicited messages the user has sent. " +
      "Returns queued messages and clears the queue. Returns 'inbox:empty' if nothing pending. " +
      "Prefer subscribing to the /api/inbox/stream SSE endpoint for real-time delivery.",
    {},
    async () => {
      const messages = drainInboxFor(sessionTag);
      if (messages.length === 0) {
        return { content: [{ type: "text" as const, text: "inbox:empty" }] };
      }
      log("·", "poll", `${messages.length} message(s) drained`, clientId);
      return {
        content: [{
          type: "text" as const,
          text: `⚠️ USER SENT YOU A MESSAGE — STOP AND RESPOND BEFORE CONTINUING:\n` + messages.map(m => `[${m.ts}] ${m.text}`).join("\n"),
        }],
      };
    }
  );

  server.tool(
    "wait_for_inbox",
    "Block until the user sends an unsolicited message, or until the timeout " +
      "expires. Returns the message(s) as tool results (the reliable MCP delivery " +
      "path — notifications over SSE are dropped by many clients). Default timeout " +
      "is 50s to stay under the JS SDK's 60s request timeout; keep the agent-side " +
      "loop re-calling on empty so a quiet user doesn't leak an abandoned waiter. " +
      "If messages are already queued for this session, returns them immediately.",
    {
      timeout_seconds: z.number().min(5).max(55).default(50)
        .describe("How long to block before returning empty (5-55s)"),
    },
    async ({ timeout_seconds = 50 }: { timeout_seconds?: number }) => {
      // Fast-path: if there are already messages queued for this session tag,
      // drain and return them without parking a waiter.
      const queued = drainInboxFor(sessionTag);
      if (queued.length > 0) {
        const body = queued.map(m => `[${m.ts}] ${m.text}`).join("\n");
        return { content: [{ type: "text" as const, text: `⚠️ USER SENT YOU A MESSAGE — STOP AND RESPOND BEFORE CONTINUING:\n${body}` }] };
      }
      const token = randomUUID();
      const entries = await new Promise<InboxEntry[]>((resolve) => {
        const timer = setTimeout(() => {
          inboxWaiters.delete(token);
          resolve([]);
        }, timeout_seconds * 1000);
        inboxWaiters.set(token, { resolve, timer, tag: sessionTag });
      });
      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: "inbox:empty" }] };
      }
      log("·", "wait_for_inbox", `${entries.length} message(s) delivered`, clientId);
      const body = entries.map(m => `[${m.ts}] ${m.text}`).join("\n");
      return { content: [{ type: "text" as const, text: `⚠️ USER SENT YOU A MESSAGE — STOP AND RESPOND BEFORE CONTINUING:\n${body}` }] };
    }
  );

  server.tool(
    "get_idle_seconds",
    "Returns the number of seconds since the user's last keyboard/mouse input. " +
      "Call this periodically during long work as a cheap heartbeat — the server " +
      "will piggy-back any pending inbox messages in the response, so you stay " +
      "responsive to the user without having to call poll. Returns -1 if idle " +
      "detection is unsupported on this platform — in that case, proceed without " +
      "gating (fail-open).",
    {},
    async () => {
      const secs = getOsIdleSeconds();
      return { content: [{ type: "text" as const, text: appendInbox(String(secs), sessionTag, clientId) }] };
    }
  );

  server.tool(
    "get_idle_config",
    "Returns the server's idle gating policy: { enabled, thresholdSeconds, alwaysDesktopWhenActive }. " +
      "Informational only — the server gates internally on every notify call. " +
      "Also drains pending inbox messages — safe to use as a heartbeat.",
    {},
    async () => {
      const cfg = loadConfig();
      const idle = cfg.idle ?? { enabled: true, thresholdSeconds: 120, alwaysDesktopWhenActive: true };
      return { content: [{ type: "text" as const, text: appendInbox(JSON.stringify(idle), sessionTag, clientId) }] };
    }
  );

  server.tool(
    "get_dnd_status",
    "Returns the current quiet state: " +
      "{ active: boolean, reason: 'disabled' | 'manual' | 'schedule' | 'off' }. " +
      "reason='disabled' means the master kill switch is ON — ALL notifications are suppressed " +
      "regardless of priority (do not notify at all). Otherwise 'manual'/'schedule' DND suppresses " +
      "delivery for priority < high. Also drains pending inbox messages — safe to use as a heartbeat.",
    {},
    async () => {
      const cfg = loadConfig();
      const muted = cfg.muteAll === true;
      const active = muted || isDndActive(cfg);
      let reason = "off";
      if (muted) reason = "disabled";
      else if (active) reason = cfg.dnd?.enabled ? "manual" : "schedule";
      return {
        content: [{ type: "text" as const, text: appendInbox(JSON.stringify({ active, reason }), sessionTag, clientId) }],
      };
    }
  );

  server.tool(
    "update_instructions",
    "Persist a block of behavioral instructions for this client into its CLAUDE.md " +
      "(or equivalent config file) so they survive session restarts and context compaction. " +
      "Call this whenever the user asks you to remember a rule, change a behavior, or update " +
      "how you should act — the instructions will be reloaded on every future session. " +
      "Pass the full desired instructions block; it replaces the previous block atomically.",
    {
      instructions: z.string().max(4000).describe("The full instructions block to persist"),
      target: z.enum(["global", "project"]).default("global").describe(
        "global = ~/.claude/CLAUDE.md (all projects); project = .claude/CLAUDE.md in cwd"
      ),
    },
    async ({ instructions, target }) => {
      try {
        const MARKER_START = "<!-- omni-notify-mcp:instructions:start -->";
        const MARKER_END   = "<!-- omni-notify-mcp:instructions:end -->";
        const block = `${MARKER_START}\n## omni-notify-mcp behavioral rules\n\n${instructions.trim()}\n${MARKER_END}`;

        let claudeMdPath: string;
        if (target === "global") {
          const claudeDir = join(homedir(), ".claude");
          if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
          claudeMdPath = join(claudeDir, "CLAUDE.md");
        } else {
          const projectClaudeDir = join(process.cwd(), ".claude");
          if (!existsSync(projectClaudeDir)) mkdirSync(projectClaudeDir, { recursive: true });
          claudeMdPath = join(projectClaudeDir, "CLAUDE.md");
        }

        let existing = "";
        if (existsSync(claudeMdPath)) {
          existing = readFileSync(claudeMdPath, "utf8");
        }

        let updated: string;
        if (existing.includes(MARKER_START)) {
          // Replace existing block
          const startIdx = existing.indexOf(MARKER_START);
          const endIdx   = existing.indexOf(MARKER_END);
          if (endIdx !== -1) {
            updated = existing.slice(0, startIdx) + block + existing.slice(endIdx + MARKER_END.length);
          } else {
            updated = existing.slice(0, startIdx) + block;
          }
        } else {
          // Append
          updated = existing + (existing.endsWith("\n") || existing === "" ? "" : "\n") + "\n" + block + "\n";
        }

        writeFileSync(claudeMdPath, updated, "utf8");
        return {
          content: [{ type: "text" as const, text: `Instructions persisted to ${claudeMdPath}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to persist instructions: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

const httpTransports: Record<string, StreamableHTTPServerTransport> = {};

interface SessionMeta {
  clientId: string;      // display name: tag or workspace name or sess-xxxx
  tag?: string;          // user-supplied session tag from ?tag=
  clientName?: string;   // MCP clientInfo.name (e.g. "claude-code")
  clientVersion?: string;
  workspaceName?: string; // workspace folder name (e.g. "AlphaWave")
  host?: string;         // remote address of the client
  hostSessionId?: string; // CLAUDE_CODE_SESSION_ID — shared by a session + its subagents
  connectedAt: number;
  lastSeen: number;      // last time we saw any request from this session
}
const sessions: Record<string, SessionMeta> = {};

// Reap sessions that haven't made any request in a while. Keeps the sessions
// list and pills bar accurate even when clients vanish without closing their
// transport (VS Code window closed, laptop lid shut, network died). On next
// reconnect the client gets a 404 and reinitializes cleanly.
//
// The MCP instructions force agents to call get_idle_seconds every 15–30s as a
// keepalive, so any session that hasn't made *any* request in 90s is almost
// certainly dead. Keep this tight — the whole point is that stale sessions
// stop showing up in broadcast acks.
const SESSION_IDLE_TIMEOUT_MS = 90 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, meta] of Object.entries(sessions)) {
    if (now - meta.lastSeen > SESSION_IDLE_TIMEOUT_MS) {
      log("·", "session", `reaped idle session ${meta.clientId} (last seen ${Math.round((now - meta.lastSeen) / 1000)}s ago)`);
      try { httpTransports[sessionId]?.close(); } catch { /* ignore */ }
      delete httpTransports[sessionId];
      delete sessions[sessionId];
    }
  }
  // Prune SSE inbox subscribers whose underlying socket has died. Node
  // surfaces dead sockets as destroyed/writableEnded — if we don't sweep
  // these, broadcastInbox quietly writes to ghosts and the ack count lies
  // to the user ("Broadcast to 3 sessions" when there's really one).
  for (const c of inboxStreamClients) {
    if (c.res.destroyed || c.res.writableEnded || !c.res.writable) {
      inboxStreamClients.delete(c);
    }
  }
}, 15_000);

function listActiveSessions(): SessionMeta[] {
  return Object.values(sessions);
}

function sessionsMatchingTag(tag: string | undefined): SessionMeta[] {
  if (!tag) return listActiveSessions();
  return listActiveSessions().filter(s => s.tag === tag);
}

// Count live SSE subscribers on /api/inbox/stream that would receive a message
// with the given tag. Stdio-bridge clients subscribe via SSE but don't always
// appear in sessions[] (their /mcp initialize session can get reaped while the
// SSE stream stays alive). Without counting them, the Telegram ack lies with
// "no agents connected" even when a bridge is actively listening.
function sseSubscribersForTag(tag: string | undefined): number {
  let n = 0;
  for (const c of inboxStreamClients) {
    if (c.res.destroyed || c.res.writableEnded || !c.res.writable) continue;
    if (tag && c.tag !== tag) continue;
    n++;
  }
  return n;
}

// Synchronous best-effort liveness check before we count sessions in an ack.
// The transport's SDK doesn't expose a "ping" API, but it does hold a ref to
// the response stream of the last GET the client opened — if that stream is
// destroyed/ended, the client is gone. We also use the `lastSeen` shortcut:
// if a session hasn't made a request in more than (idle+grace) seconds and
// the MCP instructions require a 15-30s heartbeat, it's dead. Be lenient —
// false-positives here result in lying to the user; false-negatives just
// cause a harmless write that the next reap will clean up.
const LIVE_GRACE_MS = 60_000;
function pruneDeadSessions(): void {
  const now = Date.now();
  for (const [sessionId, meta] of Object.entries(sessions)) {
    const stale = now - meta.lastSeen > LIVE_GRACE_MS;
    const transport = httpTransports[sessionId] as any;
    // The SDK stashes the active response stream on the transport for server-
    // sent notifications. If it exists and is dead, prune. Guarded because
    // the internal field name isn't stable across SDK versions.
    const streams: any[] = [transport?._streams, transport?._responseStreams, transport?._sseResponse]
      .filter(Boolean)
      .flatMap(s => (s instanceof Map ? [...s.values()] : Array.isArray(s) ? s : [s]));
    const deadStream = streams.length > 0 && streams.every(r => r?.destroyed || r?.writableEnded || r?.writable === false);
    if (stale || deadStream) {
      log("·", "session", `pruned unresponsive session ${meta.clientId} (stale=${stale}, deadStream=${deadStream})`);
      try { httpTransports[sessionId]?.close(); } catch { /* ignore */ }
      delete httpTransports[sessionId];
      delete sessions[sessionId];
    }
  }
}

function sessionDisplay(s: SessionMeta): string {
  return s.tag ? `@${s.tag}` : s.clientId;
}

app.all("/mcp", async (req, res) => {
  if (!ENABLE_MCP) {
    res.status(404).json({
      error: "mcp_disabled",
      message: "MCP transport is disabled. Set ENABLE_MCP=1 to enable /mcp.",
    });
    return;
  }
  console.log("[debug-url]", req.method, req.url, "query:", JSON.stringify(req.query), "ua:", req.headers["user-agent"]);
  const existingSessionId = req.headers["mcp-session-id"] as string | undefined;

  if (existingSessionId && httpTransports[existingSessionId]) {
    const transport = httpTransports[existingSessionId];
    await transport.handleRequest(req, res, req.body);
    // Lazy-populate clientInfo after initialize lands on an existing session.
    const meta = sessions[existingSessionId];
    if (meta) meta.lastSeen = Date.now();
    const mcpServer = (httpTransports[existingSessionId] as any)?.__mcpServer;
    if (meta && !meta.clientName && mcpServer?.getClientVersion) {
      try {
        const info = mcpServer.getClientVersion();
        if (info) {
          meta.clientName = info.name;
          meta.clientVersion = info.version;
        }
      } catch { /* ignore */ }
    }
    return;
  }

  // Auto-reconnect path. If the client presents a session id we don't know
  // about AND the request body is a fresh `initialize`, adopt the stale id
  // instead of 404-ing. This covers the "server was restarted while Claude
  // Code was open" case: clients that cache the session id (claude-code#27142)
  // would otherwise stay ghost until the human manually reloaded the window.
  // A non-initialize request with an unknown id still gets 404 — the client
  // is expected to reinitialize in response.
  const bodyIsInitialize =
    req.method === "POST" &&
    req.body &&
    (Array.isArray(req.body)
      ? req.body.some((m: any) => m?.method === "initialize")
      : req.body.method === "initialize");

  if (existingSessionId && !bodyIsInitialize) {
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found — reinitialize" },
      id: null,
    });
    return;
  }

  const rawTag = typeof req.query.tag === "string" ? req.query.tag : undefined;
  const sessionTag = rawTag?.toLowerCase().replace(/[^a-z0-9_-]/g, "") || undefined;
  const rawHsid = typeof req.query.hsid === "string" ? req.query.hsid : undefined;
  const hostSessionId = rawHsid?.replace(/[^a-zA-Z0-9_-]/g, "") || undefined;
  // If the client brought a stale id on an initialize, reuse it so the client
  // never has to swap ids. Otherwise mint a fresh one.
  const newSessionId = existingSessionId ?? randomUUID();
  const host = (req.socket.remoteAddress || "").replace(/^::ffff:/, "") || undefined;
  const port = req.socket.remotePort;
  // Pull clientInfo and workspace from the initialize body immediately so the
  // pill shows a readable name from the start.
  const initBody = Array.isArray(req.body)
    ? req.body.find((m: any) => m?.method === "initialize")
    : req.body;
  const earlyClientName: string | undefined = initBody?.params?.clientInfo?.name;
  // Prefer the workspace folder name (e.g. "AlphaWave", "notify-mcp-src") over
  // the generic client name ("claude-code"). workspaceFolders[0].name is set by
  // Claude Code and Cursor; rootUri is the fallback.
  const workspaceFolders: any[] | undefined = initBody?.params?.workspaceFolders;
  const rootUri: string | undefined = initBody?.params?.rootUri ?? initBody?.params?.root_uri;
  const workspaceName: string | undefined =
    workspaceFolders?.[0]?.name ||
    (rootUri ? rootUri.replace(/\\/g, "/").split("/").filter(Boolean).pop() : undefined);
  // Build a distinguishable client id: tag wins if set; workspace name next;
  // then clientInfo.name; otherwise use host+port. If the base id is already
  // taken, append -2, -3, … so two windows on the same project still show up.
  const baseId = sessionTag
    ?? workspaceName
    ?? earlyClientName
    ?? (host && port ? `${host === "127.0.0.1" || host === "::1" ? "local" : host}:${port}` : `sess-${newSessionId.slice(0, 8)}`);
  // Exclude the session being re-adopted from the "taken" set — it's about to
  // be replaced, so its old clientId should be available for reuse.
  const adoptingId = existingSessionId && bodyIsInitialize ? existingSessionId : undefined;
  const takenIds = new Set(
    Object.entries(sessions)
      .filter(([sid]) => sid !== adoptingId)
      .map(([, s]) => s.clientId)
  );
  let clientId = baseId;
  for (let n = 2; takenIds.has(clientId); n++) clientId = `${baseId}-${n}`;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => newSessionId });
  transport.onclose = () => {
    if (transport.sessionId) {
      delete httpTransports[transport.sessionId];
      delete sessions[transport.sessionId];
    }
  };
  const mcpServer = createMcpServer(clientId, sessionTag);
  await mcpServer.connect(transport);
  // Stash the underlying MCP server on the transport so subsequent requests
  // can grab clientInfo once the initialize handshake completes.
  (transport as any).__mcpServer = (mcpServer as any).server ?? mcpServer;
  await transport.handleRequest(req, res, req.body);
  if (transport.sessionId) {
    httpTransports[transport.sessionId] = transport;
    const now = Date.now();
    sessions[transport.sessionId] = {
      clientId, tag: sessionTag, host, hostSessionId, connectedAt: now, lastSeen: now,
      clientName: earlyClientName,
      clientVersion: initBody?.params?.clientInfo?.version,
      workspaceName,
    };
    trackReconnect(clientId);
  }
});

// ── Reconnect tracker ─────────────────────────────────────────────────────────
// After server restart, collect clients that reconnect within RECONNECT_WINDOW_MS
// then send a single notify confirming they received updated instructions.

const RECONNECT_WINDOW_MS = 20_000;
const reconnectedClients: string[] = [];
let reconnectNotifScheduled = false;
const serverStartedAt = Date.now();

function trackReconnect(clientId: string): void {
  if (Date.now() - serverStartedAt > RECONNECT_WINDOW_MS) return;
  if (reconnectedClients.includes(clientId)) return;
  reconnectedClients.push(clientId);
  if (!reconnectNotifScheduled) {
    reconnectNotifScheduled = true;
    setTimeout(async () => {
      const list = reconnectedClients.join(", ");
      const count = reconnectedClients.length;
      const msg = `${count} client${count === 1 ? "" : "s"} reconnected and received updated instructions: ${list}`;
      try { await sendNotification(msg, "low", "omni-notify-mcp"); } catch { /* best effort */ }
    }, RECONNECT_WINDOW_MS);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  const ip = getLocalIp();
  console.log(`\n  Claude Notify config UI  → http://localhost:${PORT}`);
  if (ENABLE_MCP) {
    console.log(`  MCP endpoint (remote)    → http://${ip}:${PORT}/mcp\n`);
  } else {
    console.log("  MCP endpoint (remote)    → disabled (set ENABLE_MCP=1 to enable)\n");
  }
  // Live Slack/Telegram pollers hit real external channels — never under test.
  if (process.env.NOTIFY_MCP_TEST_ENDPOINTS !== "1") {
    importCredsOnStart();
    startTelegramListener();
    startSlackListener();
  }
  // Only auto-open the browser on a genuine first run (no config yet). A plain
  // restart must NOT pop the UI — set NOTIFY_MCP_NO_OPEN=1 to force-suppress.
  const suppressOpen = process.env.NOTIFY_MCP_NO_OPEN === "1" || process.env.BROWSER === "none" || existsSync(CONFIG_PATH);
  if (!suppressOpen) open(`http://localhost:${PORT}`).catch(() => {});
});

// TCP-level keepalive on every incoming socket. Without this, a client that
// vanishes (laptop lid, killed VS Code, WiFi drop) leaves a half-open TCP
// connection that Node never notices — the SDK's `onclose` therefore never
// fires and the session goes zombie. With SO_KEEPALIVE the OS probes every
// 15s and kills the socket within a couple minutes of silence, which fires
// our reaper and clears the session bookkeeping.
httpServer.on("connection", (socket) => {
  socket.setKeepAlive(true, 15_000);
});
// keepAliveTimeout gates how long Node holds an HTTP/1.1 keep-alive idle
// connection open before closing it. Default is 5s, which was fine for
// short-lived requests but kills long-poll waiters and MCP GET streams
// prematurely. Bump above the 55s long-poll ceiling so the socket stays
// alive across the whole wait. headersTimeout must exceed it.
httpServer.keepAliveTimeout = 75_000;
httpServer.headersTimeout = 80_000;

// App-level keepalive on every active MCP GET SSE stream. The SDK doesn't
// emit any bytes on an idle stream, so intermediate proxies and some clients
// time out the stream after ~60s of silence. We write an SSE *comment* line
// (`: keepalive\n\n`) directly to each live response — comments are ignored
// by SSE parsers but reset proxy idle timers and surface dead sockets as
// write errors that we can catch and reap. Pattern is the community-standard
// fix for typescript-sdk#270.
setInterval(() => {
  for (const [sid, transport] of Object.entries(httpTransports)) {
    const t = transport as any;
    // Internal field names vary across SDK versions. Collect every candidate
    // response stream reference; the ones we find are either Response-like
    // objects with .write or Maps/arrays of them. Write-failure is the signal
    // that tells us the socket is dead.
    const candidates: any[] = [];
    for (const key of ["_streamMapping", "_streams", "_responseStreams", "_sseResponse", "_responses"]) {
      const v = t[key];
      if (!v) continue;
      if (v instanceof Map) candidates.push(...v.values());
      else if (Array.isArray(v)) candidates.push(...v);
      else candidates.push(v);
    }
    let wrote = false;
    let allDead = candidates.length > 0;
    for (const r of candidates) {
      if (!r || r.destroyed || r.writableEnded || r.writable === false) continue;
      try {
        r.write(`: keepalive ${Date.now()}\n\n`);
        wrote = true;
        allDead = false;
      } catch {
        // write failed — socket is dead, move on
      }
    }
    if (candidates.length > 0 && allDead) {
      try { httpTransports[sid]?.close(); } catch { /* ignore */ }
      delete httpTransports[sid];
      delete sessions[sid];
    }
    // Touch lastSeen on a successful keepalive write so the reaper doesn't
    // kill a session that's quietly connected but idle. lastSeen normally
    // tracks inbound requests; extending it to "stream is verified writable"
    // is fine — if the write succeeds, the client really is still there.
    if (wrote && sessions[sid]) {
      sessions[sid].lastSeen = Date.now();
    }
  }
}, 20_000);
