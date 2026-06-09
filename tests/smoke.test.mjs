// End-to-end smoke tests for notify-mcp.
//
// These tests spawn a real UI server on a random port, drive it via HTTP,
// and exercise the stdio bridge as a subprocess. No mocks — everything is
// wire-level, so a regression in the transport or bridge surfaces here.
//
// The server is launched with NOTIFY_MCP_TEST_ENDPOINTS=1 so we can inject
// fake inbox messages without depending on a real Telegram bot.
//
// Run: npm test  (or: node --test tests/smoke.test.mjs)

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const UI_SERVER = join(ROOT, "dist", "ui", "server.js");
const STDIO_BRIDGE = join(ROOT, "dist", "index.js");
// Isolated config dir so rename/config-writing tests never touch the real
// ~/.notify-mcp (sim/live separation).
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "notify-mcp-test-"));

// Allocate a random free port each run so tests can run in parallel with a
// user's normal `:3737` server — and so two test runs don't collide.
async function pickPort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHttp(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
        signal: AbortSignal.timeout(1000),
      });
      if (r.status > 0) return true;
    } catch { /* keep retrying */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function startServer(port) {
  const child = spawn(process.execPath, [UI_SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      NOTIFY_MCP_TEST_ENDPOINTS: "1",
      // The /mcp transport is gated behind ENABLE_MCP=1; the tests exercise it.
      ENABLE_MCP: "1",
      // Isolated config dir — never read/write the real ~/.notify-mcp.
      NOTIFY_MCP_CONFIG_DIR: TEST_CONFIG_DIR,
      // Suppress noise from the auto-open browser call in tests.
      BROWSER: "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain output so the OS pipe doesn't fill up and block the child.
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

// Minimal MCP-over-HTTP client. Returns parsed JSON-RPC response (or undefined
// for notifications).
function createHttpClient(port) {
  let sid;
  let nextId = 1;
  return {
    async rpc(method, params, { notify = false } = {}) {
      const isNotif = notify || method.startsWith("notifications/");
      const body = { jsonrpc: "2.0", method, params: params ?? {} };
      if (!isNotif) body.id = nextId++;
      const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      };
      if (sid) headers["mcp-session-id"] = sid;
      const r = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(65_000),
      });
      const newSid = r.headers.get("mcp-session-id");
      if (newSid && !sid) sid = newSid;
      if (isNotif) return undefined;
      const ctype = r.headers.get("content-type") ?? "";
      const raw = await r.text();
      if (ctype.includes("application/json")) return { status: r.status, body: JSON.parse(raw) };
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("data:")) {
          const json = line.slice(5).trim();
          if (json) return { status: r.status, body: JSON.parse(json) };
        }
      }
      return { status: r.status, body: raw };
    },
    get sessionId() { return sid; },
    reset() { sid = undefined; },
  };
}

// Shared server instance across all tests in this file — startup is slow
// enough (~1-2s) that restarting per test would be wasteful, and the tests
// don't share state via the server (each uses its own tag).
let server;
let port;

test.before(async () => {
  port = await pickPort();
  server = startServer(port);
  const up = await waitForHttp(port);
  assert.ok(up, `server did not come up on :${port} within 10s`);
});

test.after(async () => {
  if (server && !server.killed) {
    server.kill("SIGKILL");
    await once(server, "exit").catch(() => {});
  }
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

// Open a tagged MCP session so the client shows up in /api/clients by that tag.
// Pass hsid to simulate the CLAUDE_CODE_SESSION_ID a real bridge reports (shared
// by an interactive session and its subagents).
async function initTaggedSession(tag, hsid) {
  const q = hsid
    ? `?tag=${encodeURIComponent(tag)}&hsid=${encodeURIComponent(hsid)}`
    : `?tag=${encodeURIComponent(tag)}`;
  const r = await fetch(`http://localhost:${port}/mcp${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });
  assert.equal(r.status, 200, `tagged initialize failed: ${r.status}`);
}

test("/api/clients lists a tagged session with name + kinds", async () => {
  const tag = "clientlisttest";
  await initTaggedSession(tag);
  const { clients } = await (await fetch(`http://localhost:${port}/api/clients`)).json();
  const c = clients.find(x => x.tag === tag);
  assert.ok(c, `tagged client ${tag} not listed`);
  assert.equal(c.name, tag, "name should default to the tag when no alias");
  assert.ok(c.kinds.includes("mcp"), `expected mcp kind, got ${JSON.stringify(c.kinds)}`);
});

test("/api/clients lists one entry per panel for same-tag sessions", async () => {
  const tag = "multipaneltest";
  await initTaggedSession(tag);
  await initTaggedSession(tag);
  const { clients } = await (await fetch(`http://localhost:${port}/api/clients`)).json();
  const panels = clients.filter(x => x.tag === tag);
  assert.equal(panels.length, 2, `expected 2 panels, got ${panels.length}`);
  assert.notEqual(panels[0].id, panels[1].id, "panel ids should differ");
  assert.deepEqual(panels.map(p => p.panel).sort(), [1, 2], "panels should be numbered 1 and 2");
  assert.ok(panels.every(p => p.panelCount === 2), `panelCount should be 2, got ${JSON.stringify(panels.map(p => p.panelCount))}`);
});

test("list clients excludes a -bot waiter, keeps real panels", async () => {
  const tag = "botfiltertest";
  await initTaggedSession(tag);
  const botTag = "botfiltertest-bot";
  const waiterP = fetch(`http://localhost:${port}/api/agent/inbox/wait?timeout_seconds=5&tag=${botTag}`).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  const { tags } = await (await fetch(`http://localhost:${port}/__test__/slack-clients`)).json();
  assert.ok(tags.includes(tag), `real panel ${tag} should be addressable, got ${JSON.stringify(tags)}`);
  assert.ok(!tags.includes(botTag), `-bot waiter should NOT be addressable, got ${JSON.stringify(tags)}`);
  await waiterP;
});

test("rename sets then clears a persisted client alias", async () => {
  const tag = "renametest";
  await initTaggedSession(tag);
  const rename = (name) => fetch(`http://localhost:${port}/api/clients/${tag}/rename`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  });
  const nameOf = async () => (await (await fetch(`http://localhost:${port}/api/clients`)).json()).clients.find(x => x.tag === tag)?.name;

  await rename("aliased-name");
  assert.equal(await nameOf(), "aliased-name", "alias not applied");
  await rename("");
  assert.equal(await nameOf(), tag, "alias not cleared");
});

test("reconnect drops a client's live connections", async () => {
  const tag = "reconntest";
  await initTaggedSession(tag);
  const res = await (await fetch(`http://localhost:${port}/api/clients/${tag}/reconnect`, { method: "POST" })).json();
  assert.equal(res.ok, true);
  assert.ok(res.closed >= 1, `expected >=1 connection closed, got ${res.closed}`);
});

test("initialize returns protocol + tool capabilities", async () => {
  const c = createHttpClient(port);
  const r = await c.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.protocolVersion, "2024-11-05");
  assert.ok(r.body.result.capabilities.tools, "tools capability missing");
  assert.ok(c.sessionId, "mcp-session-id header missing");
});

test("tools/list includes wait_for_inbox + the full core set", async () => {
  const c = createHttpClient(port);
  await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  await c.rpc("notifications/initialized");
  const r = await c.rpc("tools/list");
  const names = r.body.result.tools.map(t => t.name).sort();
  const expected = ["ask", "get_dnd_status", "get_idle_config", "get_idle_seconds", "notify", "poll", "update_instructions", "wait_for_inbox"];
  assert.deepEqual(names, expected);
});

test("wait_for_inbox returns inbox:empty after its timeout when no message arrives", async () => {
  const c = createHttpClient(port);
  await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  await c.rpc("notifications/initialized");
  const started = Date.now();
  const r = await c.rpc("tools/call", { name: "wait_for_inbox", arguments: { timeout_seconds: 5 } });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4500, `returned too early: ${elapsed}ms`);
  assert.ok(elapsed < 10_000, `returned too late: ${elapsed}ms`);
  assert.equal(r.body.result.content[0].text, "inbox:empty");
});

test("wait_for_inbox wakes up immediately when a matching message is injected", async () => {
  const c = createHttpClient(port);
  await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  await c.rpc("notifications/initialized");

  // Park a long waiter and, after a beat, inject a message. The waiter should
  // resolve in well under a second — not wait out the full 30s timeout.
  const started = Date.now();
  const waitPromise = c.rpc("tools/call", { name: "wait_for_inbox", arguments: { timeout_seconds: 30 } });
  await new Promise(r => setTimeout(r, 500));

  const inject = await fetch(`http://localhost:${port}/__test__/inject-inbox`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello from test" }),
  });
  const injectBody = await inject.json();
  assert.equal(injectBody.injected, true);
  assert.equal(injectBody.waiters, 1, "expected exactly one matching waiter");

  const r = await waitPromise;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `wake-up too slow: ${elapsed}ms`);
  const text = r.body.result.content[0].text;
  assert.match(text, /USER SENT YOU A MESSAGE/);
  assert.match(text, /hello from test/);
});

test("stale session id on non-initialize request returns 404", async () => {
  const r = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": "00000000-0000-0000-0000-000000000000",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(r.status, 404);
});

test("stale session id on initialize is adopted (auto-reconnect after restart)", async () => {
  // Simulates the claude-code#27142 flow: the server forgot the session, but
  // the client still has the old id cached. An initialize with that id must
  // succeed and the server must echo the same id back instead of 404-ing.
  const staleId = "deadbeef-dead-beef-dead-beefdeadbeef";
  const r = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": staleId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "reconnect-test", version: "1" } },
    }),
  });
  assert.equal(r.status, 200, `expected 200 on reinitialize, got ${r.status}`);
  assert.equal(r.headers.get("mcp-session-id"), staleId, "server should echo the stale id back");

  // Follow-up call on that same id should now work — session is live again.
  const followup = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": staleId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  // notifications return 202 Accepted in the SDK; anything < 300 proves the session is alive.
  assert.ok(followup.status < 300, `followup after adoption failed: ${followup.status}`);
});

test("stdio bridge initializes, advertises claude/channel, lists tools", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, [STDIO_BRIDGE], {
    env: { ...process.env, NOTIFY_MCP_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Drain stderr quietly.
  child.stderr.on("data", () => {});
  let buf = "";
  const lines = [];
  const readerDone = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) lines.push(line);
        if (lines.length >= 2) resolve();
      }
    });
  });

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  // Bridge needs a beat to open its HTTP session to the server before it can
  // respond to stdio calls — tool calls proxy through HTTP. Stall briefly.
  await new Promise(r => setTimeout(r, 800));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  await Promise.race([
    readerDone,
    new Promise((_, reject) => setTimeout(() => reject(new Error("bridge did not respond in 15s")), 15_000)),
  ]);

  child.kill("SIGKILL");
  await once(child, "exit").catch(() => {});

  const initResp = lines.map(l => JSON.parse(l)).find(m => m.id === 1);
  assert.ok(initResp, "no initialize response");
  assert.equal(initResp.result.protocolVersion, "2024-11-05");
  assert.ok(
    initResp.result.capabilities?.experimental?.["claude/channel"],
    "claude/channel capability not declared by stdio bridge"
  );

  const toolsResp = lines.map(l => JSON.parse(l)).find(m => m.id === 2);
  assert.ok(toolsResp, "no tools/list response");
  const names = toolsResp.result.tools.map(t => t.name).sort();
  // reply is the stdio-only channels return tool; others match the HTTP set.
  assert.deepEqual(names, ["ask", "get_dnd_status", "get_idle_config", "get_idle_seconds", "notify", "poll", "reply", "update_instructions", "wait_for_inbox"]);
});

// #36 — two panels of the same VSC window (same tag) must each get a distinct
// per-panel identity in their initialize instructions, matching the /api/clients id.
async function initInstructions(tag) {
  const r = await fetch(`http://localhost:${port}/mcp?tag=${encodeURIComponent(tag)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });
  const ctype = r.headers.get("content-type") ?? "";
  const raw = await r.text();
  if (ctype.includes("application/json")) return JSON.parse(raw).result.instructions;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim()).result.instructions;
  }
  throw new Error("no initialize body");
}

test("same-tag panels get distinct per-panel identity in instructions", async () => {
  const tag = "identitytest";
  const i1 = await initInstructions(tag);
  const i2 = await initInstructions(tag);
  assert.match(i1, /YOUR SESSION IDENTITY: "@identitytest"/);
  assert.match(i2, /YOUR SESSION IDENTITY: "@identitytest-2"/);
  assert.notEqual(i1, i2, "per-panel identity lines should differ");
});

// #38 — a multi-chunk notify that reaches no channel must report suppression,
// not a false "Delivered as N chunks". All channels are disabled by default.
test("bridge reports suppression when a multi-chunk notify reaches no channel", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, [STDIO_BRIDGE], {
    env: { ...process.env, NOTIFY_MCP_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  let buf = "";
  const lines = [];
  const want = (id) => lines.map(l => JSON.parse(l)).find(m => m.id === id);
  const gotNotify = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) lines.push(line);
      }
      if (want(2)) resolve();
    });
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  await new Promise(r => setTimeout(r, 800));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const longMsg = "word ".repeat(300).trim(); // ~1500 chars → several chunks
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "notify", arguments: { message: longMsg, priority: "normal" } } });

  await Promise.race([
    gotNotify,
    new Promise((_, reject) => setTimeout(() => reject(new Error("no notify response in 15s")), 15_000)),
  ]);
  child.kill("SIGKILL");
  await once(child, "exit").catch(() => {});

  const resp = want(2);
  assert.ok(resp, "no notify response");
  const text = resp.result.content[0].text;
  assert.match(text, /Suppressed — 0 of \d+ chunks reached any channel/, `expected honest suppression, got: ${text}`);
  assert.doesNotMatch(text, /Delivered as \d+ chunks/, `must not falsely claim delivery: ${text}`);
});

// #40 — a normal-priority notify that is idle-gated to desktop-only must STILL
// reach Slack (vsc_notif channel-log exemption). Force UI active so the gate
// fires, point the Slack webhook at a local capture server, assert it's hit.
test("normal-priority notify reaches Slack even while idle-gated", async () => {
  await fetch(`http://localhost:${port}/api/ui/visibility`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visible: true }),
  });
  const { createServer } = await import("node:http");
  let slackHits = 0;
  let lastBody = "";
  const capture = createServer((req, res) => {
    let b = "";
    req.on("data", d => { b += d; });
    req.on("end", () => { slackHits++; lastBody = b; res.writeHead(200); res.end("ok"); });
  });
  await new Promise(r => capture.listen(0, r));
  const slackUrl = `http://localhost:${capture.address().port}/hook`;
  try {
    await fetch(`http://localhost:${port}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ desktop: { enabled: false }, slack: { enabled: true, webhookUrl: slackUrl }, idle: { enabled: true, thresholdSeconds: 120, alwaysDesktopWhenActive: true } }),
    });
    const c = createHttpClient(port);
    await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    await c.rpc("notifications/initialized");
    const r = await c.rpc("tools/call", { name: "notify", arguments: { message: "idle-exempt slack check", priority: "normal" } });
    const text = r.body.result.content[0].text;
    assert.match(text, /Sent via:[^|]*slack/, `slack should deliver under idle gating, got: ${text}`);
    assert.equal(slackHits, 1, `slack webhook should be hit exactly once, got ${slackHits}`);
    assert.match(lastBody, /idle-exempt slack check/, "slack payload should carry the message");
  } finally {
    await fetch(`http://localhost:${port}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slack: { enabled: false, webhookUrl: "" }, desktop: { enabled: false } }),
    }).catch(() => {});
    capture.close();
  }
});

// #42 — per-panel invalidate drops only the targeted session; siblings survive.
test("per-panel invalidate drops only the targeted session, siblings survive", async () => {
  const tag = "panelinvtest";
  await initTaggedSession(tag);
  await initTaggedSession(tag);
  const panelsOf = async () => (await (await fetch(`http://localhost:${port}/api/clients`)).json()).clients.filter(x => x.tag === tag);
  let panels = await panelsOf();
  assert.equal(panels.length, 2, `setup: expected 2 panels, got ${panels.length}`);
  const victim = panels[0].sessionId;
  const survivor = panels[1].sessionId;
  const r = await (await fetch(`http://localhost:${port}/api/clients/${tag}/panel/${victim}/reconnect`, { method: "POST" })).json();
  assert.equal(r.ok, true);
  assert.equal(r.closed, 1, `expected exactly 1 session dropped, got ${r.closed}`);
  panels = await panelsOf();
  const ids = panels.map(p => p.sessionId);
  assert.ok(!ids.includes(victim), `victim ${victim} should be gone, got ${JSON.stringify(ids)}`);
  assert.ok(ids.includes(survivor), `survivor ${survivor} should remain, got ${JSON.stringify(ids)}`);
});

// #44 — the -bot auto-responder waiter must NOT appear in the UI Clients tab.
test("/api/clients hides a -bot waiter, keeps real panels", async () => {
  const tag = "uibotfilter";
  await initTaggedSession(tag);
  const botTag = "uibotfilter-bot";
  const waiterP = fetch(`http://localhost:${port}/api/agent/inbox/wait?timeout_seconds=5&tag=${botTag}`).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  const { clients } = await (await fetch(`http://localhost:${port}/api/clients`)).json();
  const tags = clients.map(c => c.tag);
  assert.ok(tags.includes(tag), `real client ${tag} should show, got ${JSON.stringify(tags)}`);
  assert.ok(!tags.includes(botTag), `-bot waiter should be hidden from UI, got ${JSON.stringify(tags)}`);
  await waiterP;
});

// #43 — with NOTIFY_MCP_TAG unset, the bridge self-tags from CLAUDE_PROJECT_DIR
// (the per-workspace dir Claude Code passes), so each window registers distinctly.
test("bridge self-tags from CLAUDE_PROJECT_DIR when NOTIFY_MCP_TAG is unset", { timeout: 20_000 }, async () => {
  const fixtureParent = mkdtempSync(join(tmpdir(), "awderive-"));
  const fixture = join(fixtureParent, "awderivetest");
  mkdirSync(fixture, { recursive: true });
  const child = spawn(process.execPath, [STDIO_BRIDGE], {
    env: { ...process.env, NOTIFY_MCP_PORT: String(port), NOTIFY_MCP_TAG: "", CLAUDE_PROJECT_DIR: fixture },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  child.stdout.on("data", () => {});
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  await new Promise(r => setTimeout(r, 800));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_dnd_status", arguments: {} } });
  let found = false;
  for (let i = 0; i < 24 && !found; i++) {
    await new Promise(r => setTimeout(r, 250));
    const { clients } = await (await fetch(`http://localhost:${port}/api/clients`)).json();
    found = clients.some(c => typeof c.tag === "string" && c.tag.endsWith("-awderivetest"));
  }
  child.kill("SIGKILL");
  await once(child, "exit").catch(() => {});
  rmSync(fixtureParent, { recursive: true, force: true });
  assert.ok(found, "bridge should self-tag from CLAUDE_PROJECT_DIR basename when NOTIFY_MCP_TAG is empty");
});

// #45 — when the bridge's stdio peer (claude.exe) closes stdin (window/panel
// closed), the bridge must DELETE its /mcp session and exit, so the phantom
// panel disappears from the clients tab immediately instead of lingering via
// the 30s keepalive forever.
test("bridge exits and drops its session when stdin closes", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, [STDIO_BRIDGE], {
    env: { ...process.env, NOTIFY_MCP_PORT: String(port), NOTIFY_MCP_TAG: "peerlosstest" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  child.stdout.on("data", () => {});
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  await new Promise(r => setTimeout(r, 800));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_dnd_status", arguments: {} } });

  const tagPresent = async () => {
    const { clients } = await (await fetch(`http://localhost:${port}/api/clients`)).json();
    return clients.some(c => typeof c.tag === "string" && c.tag.endsWith("-peerlosstest"));
  };
  let registered = false;
  for (let i = 0; i < 24 && !registered; i++) {
    await new Promise(r => setTimeout(r, 250));
    registered = await tagPresent();
  }
  assert.ok(registered, "bridge should register before we close its stdin");

  // Close stdin = parent process gone. Bridge should DELETE its session + exit.
  child.stdin.end();
  await once(child, "exit");

  let gone = false;
  for (let i = 0; i < 16 && !gone; i++) {
    await new Promise(r => setTimeout(r, 250));
    gone = !(await tagPresent());
  }
  assert.ok(gone, "session should disappear from /api/clients right after the bridge's stdin closes");
});

// #46 — a subagent (Task tool) shares its parent's CLAUDE_CODE_SESSION_ID, so
// same-(tag, hsid) sessions fold into ONE interactive panel; a distinct hsid is
// a genuinely separate interactive panel and still counts on its own.
test("/api/clients folds same-session-id subagents into one interactive panel", async () => {
  const tag = "subagentfoldtest";
  const hsid = "aaaaaaaa-1111-2222-3333-444444444444";
  await initTaggedSession(tag, hsid);  // interactive parent
  await initTaggedSession(tag, hsid);  // subagent — same host session id
  let panels = (await (await fetch(`http://localhost:${port}/api/clients`)).json())
    .clients.filter(x => x.tag === tag);
  assert.equal(panels.length, 1, `subagent should fold into the parent: expected 1 panel, got ${panels.length}`);
  assert.equal(panels[0].panelCount, 1, `panelCount should be 1, got ${panels[0].panelCount}`);

  // A second REAL interactive panel (distinct host session id) still counts.
  await initTaggedSession(tag, "bbbbbbbb-5555-6666-7777-888888888888");
  panels = (await (await fetch(`http://localhost:${port}/api/clients`)).json())
    .clients.filter(x => x.tag === tag);
  assert.equal(panels.length, 2, `distinct hsid is its own panel: expected 2, got ${panels.length}`);
});
