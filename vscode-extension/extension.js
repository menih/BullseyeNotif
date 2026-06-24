// BullseyeNotify (Omni Notify MCP) — VS Code extension
//
// Embeds the omni-notify-mcp config UI directly inside VS Code: an activity-bar
// panel hosts the existing web UI (served by the local HTTP server on :3737) in
// a webview iframe, so the whole configuration is consumable without leaving the
// editor. The extension ensures the server is running (spawning it if needed),
// then frames it. The full server, channels, and UI live in the npm package /
// repo — this just makes them a one-click side panel.

const vscode = require("vscode");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

let uiProcess = null;
let statusBarItem = null;
let provider = null;

function activate(context) {
  // ── Embedded config webview (activity-bar panel) ─────────────────────────
  provider = new ConfigViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("omniNotify.configView", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ── Status bar item ──────────────────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "omniNotify.configView.focus";
  statusBarItem.tooltip = "Open BullseyeNotify config panel";
  context.subscriptions.push(statusBarItem);
  refreshStatus();
  const refresher = setInterval(refreshStatus, 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(refresher) });

  // ── Commands ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("omniNotifyMcp.refresh", () => provider && provider.refresh()),
    vscode.commands.registerCommand("omniNotifyMcp.openInBrowser", openInBrowser),
    vscode.commands.registerCommand("omniNotifyMcp.startServer", () => ensureServer().then(() => provider && provider.refresh())),
    vscode.commands.registerCommand("omniNotifyMcp.openHelp", openHelp),
    vscode.commands.registerCommand("omniNotifyMcp.configureClaude", () => configureClaudeMcp({ showResult: true }))
  );

  // Leverage both MCP + extension: the extension knows this window's real
  // workspace (the MCP bridge can't), so register sessionId → workspaceName so
  // the server can show two windows on different workspaces as distinct,
  // readably-named clients.
  ensureServer().then(registerWindow).catch(() => {});
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => registerWindow()));

  // First-run: wire Claude MCP automatically (idempotent, silent).
  const KEY = "omniNotifyMcp.welcomed";
  if (!context.globalState.get(KEY)) {
    context.globalState.update(KEY, true);
    configureClaudeMcp({ showResult: false });
  }
}

// Tell the server this window's workspace, keyed by CLAUDE_CODE_SESSION_ID (the
// same id the MCP bridge reports as hsid), so the server can join them.
function registerWindow() {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID || "";
  if (!sessionId) return; // no shared key with the bridge → nothing to correlate
  const ws = vscode.workspace;
  const folder = ws.workspaceFolders && ws.workspaceFolders[0];
  const payload = JSON.stringify({
    sessionId,
    workspaceName: ws.name || (folder && folder.name) || "",
    workspacePath: (folder && folder.uri && folder.uri.fsPath) || "",
  });
  const req = http.request(
    { host: "127.0.0.1", port: uiPort(), path: "/api/window/register", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
    (res) => res.resume()
  );
  req.on("error", () => {});
  req.write(payload);
  req.end();
}

function deactivate() {
  // Leave the server running on deactivate — it's the shared notify bus used by
  // the MCP bridge and other windows. We only ever start it, never kill it.
}

// ── Embedded webview provider ─────────────────────────────────────────────

class ConfigViewProvider {
  constructor(context) { this.context = context; this.view = undefined; }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((m) => {
      if (m && m.cmd === "start") ensureServer().then(() => this.refresh());
      else if (m && m.cmd === "openBrowser") openInBrowser();
    });
    this.render();
    // Ensure the server is up, then re-render to swap loading → embedded UI.
    ensureServer().then(() => this.refresh());
    view.onDidChangeVisibility(() => { if (view.visible) this.refresh(); });
  }

  refresh() { this.render(); }

  async render() {
    if (!this.view) return;
    const port = uiPort();
    const up = await pingUi();
    this.view.webview.html = up ? iframeHtml(port) : loadingHtml(port);
  }
}

function iframeHtml(port) {
  const url = `http://localhost:${port}/`;
  const csp = `default-src 'none'; frame-src http://localhost:${port} http://127.0.0.1:${port}; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{height:100%;margin:0;padding:0;background:#0d0f12;overflow:hidden}
iframe{position:absolute;inset:0;width:100%;height:100%;border:0}</style></head>
<body><iframe src="${url}" allow="clipboard-read; clipboard-write"></iframe></body></html>`;
}

function loadingHtml(port) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:18px;font-size:13px;line-height:1.5}
  h3{margin:0 0 8px;font-size:14px}
  p{opacity:.8;margin:0 0 12px}
  button{padding:6px 14px;border:none;border-radius:5px;cursor:pointer;font-size:13px;
    color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
  button:hover{background:var(--vscode-button-hoverBackground)}
  code{background:rgba(128,128,128,.2);padding:1px 5px;border-radius:3px}
</style></head>
<body>
  <h3>BullseyeNotify</h3>
  <p>The config server isn't running on <code>localhost:${port}</code> yet.</p>
  <button onclick="acquireVsCodeApi().postMessage({cmd:'start'})">Start config server</button>
  <p style="margin-top:14px"><a href="#" onclick="acquireVsCodeApi().postMessage({cmd:'openBrowser'});return false">Open in external browser instead</a></p>
</body></html>`;
}

// ── Server lifecycle ───────────────────────────────────────────────────────

function uiPort() {
  return vscode.workspace.getConfiguration("omniNotifyMcp").get("uiPort") || 3737;
}

function pingUi() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: uiPort(), path: "/v1/health", timeout: 900 },
      (res) => { resolve(res.statusCode === 200); res.resume(); }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Resolve the built UI server entry: prefer the repo this extension ships from
// (dev / source install), else fall back to the published npm package via npx.
function serverEntry() {
  const candidates = [
    path.join(__dirname, "..", "dist", "ui", "server.js"),
    path.join(__dirname, "..", "..", "dist", "ui", "server.js"),
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return { cmd: process.execPath, args: [c] }; }
  return null;
}

async function ensureServer() {
  if (await pingUi()) return true;
  if (!vscode.workspace.getConfiguration("omniNotifyMcp").get("autoStartUi", true)) return false;
  startServerProc();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await pingUi()) { refreshStatus(); return true; }
  }
  refreshStatus();
  return false;
}

function startServerProc() {
  if (uiProcess && !uiProcess.killed) return;
  // ENABLE_MCP=1 so /mcp works; NOTIFY_MCP_NO_OPEN=1 so the server doesn't pop
  // an external browser (we embed it here).
  const env = {
    ...process.env,
    PORT: String(uiPort()),
    ENABLE_MCP: "1",
    NOTIFY_MCP_NO_OPEN: "1",
    BROWSER: "none",
  };
  const entry = serverEntry();
  const isWin = process.platform === "win32";
  if (entry) {
    uiProcess = spawn(entry.cmd, entry.args, { env, stdio: "ignore", detached: true, windowsHide: true });
  } else {
    uiProcess = spawn("npx", ["-y", "-p", "omni-notify-mcp", "omni-notify-ui"], { env, shell: isWin, stdio: "ignore", detached: true, windowsHide: true });
  }
  uiProcess.on("error", (err) => {
    vscode.window.showErrorMessage(`Failed to start BullseyeNotify: ${err.message}`);
    uiProcess = null;
  });
  uiProcess.on("exit", () => { uiProcess = null; refreshStatus(); });
  try { uiProcess.unref(); } catch { /* detached cleanup best-effort */ }
}

async function refreshStatus() {
  if (!statusBarItem) return;
  const up = await pingUi();
  statusBarItem.text = up ? "$(bell) Notify" : "$(bell-slash) Notify";
  statusBarItem.backgroundColor = up ? undefined : new vscode.ThemeColor("statusBarItem.warningBackground");
  statusBarItem.show();
}

async function openInBrowser() {
  await ensureServer();
  vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${uiPort()}`));
}

async function openHelp() {
  const port = uiPort();
  if (await pingUi()) vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}/help.html`));
  else vscode.env.openExternal(vscode.Uri.parse("https://github.com/menih/omni-notify-mcp#readme"));
}

// ── Claude MCP auto-config ─────────────────────────────────────────────────

function configureClaudeMcp({ showResult }) {
  const claudePath = path.join(os.homedir(), ".claude.json");
  const desiredNotify = { type: "stdio", command: "npx", args: ["-y", "omni-notify-mcp"] };
  try {
    let root = {};
    if (fs.existsSync(claudePath)) {
      const raw = fs.readFileSync(claudePath, "utf8");
      root = raw.trim() ? JSON.parse(raw) : {};
    }
    if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("~/.claude.json root is not an object");
    if (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers)) root.mcpServers = {};

    const existing = root.mcpServers.notify;
    const alreadyDesired = !!existing
      && existing.type === desiredNotify.type
      && existing.command === desiredNotify.command
      && Array.isArray(existing.args)
      && existing.args.length === desiredNotify.args.length
      && existing.args.every((v, i) => v === desiredNotify.args[i]);

    if (alreadyDesired) {
      if (showResult) vscode.window.showInformationMessage("Claude MCP already configured for Omni Notify.");
      return;
    }
    if (existing && !alreadyDesired) {
      if (showResult) {
        vscode.window.showWarningMessage("Claude already has a custom notify MCP entry. Left unchanged.", "Open ~/.claude.json")
          .then((choice) => {
            if (choice === "Open ~/.claude.json") vscode.workspace.openTextDocument(vscode.Uri.file(claudePath)).then(vscode.window.showTextDocument);
          });
      }
      return;
    }
    root.mcpServers.notify = desiredNotify;
    fs.writeFileSync(claudePath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    if (showResult) vscode.window.showInformationMessage("Configured Claude MCP for Omni Notify in ~/.claude.json.");
  } catch (err) {
    if (showResult) vscode.window.showErrorMessage(`Failed to configure Claude MCP: ${err.message}`);
  }
}

module.exports = { activate, deactivate };
