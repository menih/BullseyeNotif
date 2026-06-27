#!/bin/bash
set -e

# One-shot release: bumps version, builds, publishes to npm + VS Code marketplace.
#
# Usage: ./release.sh [patch|minor|major]   (default: patch)
#
# Tokens are read from ~/.notify-mcp-secrets (a key=value file). Format:
#     NPM_TOKEN=npm_xxxxxxxx
#     VSCE_PAT=xxxxxxxx
# See .secrets.example for the full template.
#
# Override behavior:
#   SKIP_NPM=1   ./release.sh   → only publish extension
#   SKIP_VSCE=1  ./release.sh   → only publish npm
#   NO_BUMP=1    ./release.sh   → skip version bump (publish current version as-is)

NPM_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$NPM_DIR/vscode-extension"
SECRETS_FILE="$HOME/.notify-mcp-secrets"
REPO_SECRETS_FILE="$NPM_DIR/notify-secrets.json"
PACKAGE_NAME="omni-notify-mcp"
MARKETPLACE_ITEM="Karish911.bullseye-notify"

decode_repo_secret() {
  local field="$1"
  if [ ! -f "$REPO_SECRETS_FILE" ]; then
    return 0
  fi
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const f = process.argv[2];
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      const v = j?.release?.[f];
      if (typeof v !== "string" || !v.trim()) { process.exit(0); }
      process.stdout.write(Buffer.from(v, "base64").toString("utf8"));
    } catch {
      process.exit(0);
    }
  ' "$REPO_SECRETS_FILE" "$field"
}

npm_preflight_or_die() {
  if [ -n "${SKIP_NPM:-}" ]; then
    return 0
  fi

  if [ -z "${NPM_TOKEN:-}" ]; then
    echo "ERROR: NPM_TOKEN is missing."
    echo "  Fix: run 'bash ./setup-secrets.sh' and provide a publish-capable npm token."
    exit 1
  fi

  local who
  if ! who="$(NPM_TOKEN="$NPM_TOKEN" npm whoami --registry=https://registry.npmjs.org/ 2>/dev/null)"; then
    echo "ERROR: npm auth failed for NPM_TOKEN (unauthorized/revoked)."
    echo "  Fix: run 'bash ./setup-secrets.sh' and replace the npm token."
    exit 1
  fi

  # Ownership gate: token user must appear in package maintainers list.
  if ! npm view "$PACKAGE_NAME" maintainers --json 2>/dev/null | node -e '
    const fs = require("fs");
    const who = (process.argv[1] || "").toLowerCase();
    const raw = fs.readFileSync(0, "utf8").trim();
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      process.exit(1);
    }
    if (!Array.isArray(arr)) arr = [arr];
    const ok = arr.some((entry) => {
      const s = String(entry || "").toLowerCase();
      return s.startsWith(`${who} <`) || s === who;
    });
    process.exit(ok ? 0 : 1);
  ' "$who"; then
    echo "ERROR: npm user '$who' is not listed as maintainer for $PACKAGE_NAME."
    echo "  Fix one of:"
    echo "    1) Use a token for an existing maintainer account, or"
    echo "    2) Add '$who' as collaborator/maintainer on npm package '$PACKAGE_NAME'."
    exit 1
  fi

  echo "==> npm preflight OK (user=$who, package=$PACKAGE_NAME)"
}

# ── Load secrets ─────────────────────────────────────────────────────────────
# Tokens persist in ~/.notify-mcp-secrets so you set them once and never type
# them again. If the file doesn't exist, we run the interactive setup helper
# automatically (hidden input, no echo, no shell history).
if [ ! -f "$SECRETS_FILE" ]; then
  echo "==> First run — no $SECRETS_FILE yet."
  echo "    Launching setup (one-time, hidden input)..."
  echo ""
  bash "$NPM_DIR/setup-secrets.sh"
  echo ""
fi

if [ -f "$SECRETS_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$SECRETS_FILE"; set +a
fi

# Repo fallback: if release creds are committed in notify-secrets.json under
# release.{npmToken_b64,vscePat_b64}, use them when local secrets are absent.
if [ -z "${NPM_TOKEN:-}" ]; then
  NPM_TOKEN="$(decode_repo_secret npmToken_b64 || true)"
fi
if [ -z "${VSCE_PAT:-}" ]; then
  VSCE_PAT="$(decode_repo_secret vscePat_b64 || true)"
fi

if [ -z "$NPM_TOKEN" ] && [ -z "$SKIP_NPM" ]; then
  echo "ERROR: NPM_TOKEN still not set after loading $SECRETS_FILE."
  echo "  Edit the file directly, or re-run: bash setup-secrets.sh"
  exit 1
fi

npm_preflight_or_die

# VSCE_PAT is optional — vsce login Karish911 caches the credential, so
# `vsce publish` works without --pat once you've logged in.

cd "$NPM_DIR"

# ── Version bump ─────────────────────────────────────────────────────────────
if [ -n "$NO_BUMP" ]; then
  NEW_VERSION=$(node -p "require('./package.json').version")
  echo "==> NO_BUMP set — using current version $NEW_VERSION"
else
  BUMP=${1:-patch}
  echo "==> Bumping version ($BUMP)..."
  NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version | tr -d 'v')
  echo "    Version: $NEW_VERSION"
fi

# ── Build ────────────────────────────────────────────────────────────────────
echo "==> Building MCP server + UI..."
npm run build

# ── npm publish ──────────────────────────────────────────────────────────────
if [ -z "$SKIP_NPM" ]; then
  echo "==> Publishing to npm..."
  npm publish --access public
  echo "    OK npm: omni-notify-mcp@$NEW_VERSION"
else
  echo "==> SKIP_NPM set — skipping npm publish"
fi

# ── VS Code extension publish ────────────────────────────────────────────────
if [ -z "$SKIP_VSCE" ] && [ -d "$EXT_DIR" ]; then
  echo "==> Syncing extension version to $NEW_VERSION..."
  # Copy the LICENSE into the extension dir so the .vsix includes it (vsce
  # warns when missing). Done before vsce reads package.json.
  cp -f "$NPM_DIR/LICENSE" "$EXT_DIR/LICENSE" 2>/dev/null || true

  cd "$EXT_DIR"
  # Bump extension package.json version to match. Use a tempfile to avoid
  # the bash/Git-Bash quoting confusion that broke the previous heredoc.
  NEW_VER="$NEW_VERSION" node <<'EOF'
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = process.env.NEW_VER;
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
EOF

  ORIG_EXT_NAME="$(node -p "require('./package.json').name")"
  ORIG_DISPLAY_NAME="$(node -p "require('./package.json').displayName")"
  EXT_PUBLISHER="$(node -p "require('./package.json').publisher")"

  set_ext_identity() {
    local next_name="$1"
    local next_display="${2:-}"
    NEXT_NAME="$next_name" NEXT_DISPLAY="$next_display" node <<'EOF'
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.name = process.env.NEXT_NAME;
if (process.env.NEXT_DISPLAY) p.displayName = process.env.NEXT_DISPLAY;
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
EOF
  }

  # Optional explicit override key. If unset, release will auto-fallback on
  # Marketplace name collisions to <name>-<publisher>.
  if [ -n "${VSCE_NAME_OVERRIDE:-}" ] && [ "$VSCE_NAME_OVERRIDE" != "$ORIG_EXT_NAME" ]; then
    echo "==> Applying VSCE_NAME_OVERRIDE: $VSCE_NAME_OVERRIDE"
    set_ext_identity "$VSCE_NAME_OVERRIDE"
  fi

  rm -f *.vsix

  echo "==> Publishing extension to VS Code marketplace..."
  # `--no-update-package-json` keeps vsce from auto-bumping again on top of
  # our explicit version. `--skip-license` not used — we ship a real LICENSE.
  VSCE_LOG="$NPM_DIR/.run/vsce-publish.log"
  mkdir -p "$NPM_DIR/.run"
  if [ -n "$VSCE_PAT" ]; then
    if ! vsce publish --pat "$VSCE_PAT" --no-update-package-json "$NEW_VERSION" >"$VSCE_LOG" 2>&1; then
      cat "$VSCE_LOG"
      if grep -qi "already exists in the Marketplace" "$VSCE_LOG"; then
        CUR_EXT_NAME="$(node -p "require('./package.json').name")"
        FALLBACK_EXT_NAME="${VSCE_NAME_OVERRIDE:-${ORIG_EXT_NAME}-$(printf '%s' "$EXT_PUBLISHER" | tr '[:upper:]' '[:lower:]')}"
        FALLBACK_EXT_NAME="$(printf '%s' "$FALLBACK_EXT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//')"
        if [ "$FALLBACK_EXT_NAME" = "$CUR_EXT_NAME" ]; then
          FALLBACK_EXT_NAME="${CUR_EXT_NAME}-alt"
        fi
        FALLBACK_DISPLAY_NAME="${ORIG_DISPLAY_NAME} (${EXT_PUBLISHER})"
        echo "==> Marketplace name collision — overriding extension name to: $FALLBACK_EXT_NAME"
        set_ext_identity "$FALLBACK_EXT_NAME" "$FALLBACK_DISPLAY_NAME"
        rm -f *.vsix
        vsce publish --pat "$VSCE_PAT" --no-update-package-json "$NEW_VERSION"
      elif grep -qi "display name is taken" "$VSCE_LOG"; then
        CUR_EXT_NAME="$(node -p "require('./package.json').name")"
        UNIQUE_DISPLAY_NAME="${ORIG_DISPLAY_NAME} (${EXT_PUBLISHER} ${NEW_VERSION})"
        echo "==> Marketplace display-name collision — overriding displayName to: $UNIQUE_DISPLAY_NAME"
        set_ext_identity "$CUR_EXT_NAME" "$UNIQUE_DISPLAY_NAME"
        rm -f *.vsix
        vsce publish --pat "$VSCE_PAT" --no-update-package-json "$NEW_VERSION"
      else
        exit 1
      fi
    fi
  else
    if ! vsce publish --no-update-package-json "$NEW_VERSION" >"$VSCE_LOG" 2>&1; then
      cat "$VSCE_LOG"
      if grep -qi "already exists in the Marketplace" "$VSCE_LOG"; then
        CUR_EXT_NAME="$(node -p "require('./package.json').name")"
        FALLBACK_EXT_NAME="${VSCE_NAME_OVERRIDE:-${ORIG_EXT_NAME}-$(printf '%s' "$EXT_PUBLISHER" | tr '[:upper:]' '[:lower:]')}"
        FALLBACK_EXT_NAME="$(printf '%s' "$FALLBACK_EXT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//')"
        if [ "$FALLBACK_EXT_NAME" = "$CUR_EXT_NAME" ]; then
          FALLBACK_EXT_NAME="${CUR_EXT_NAME}-alt"
        fi
        FALLBACK_DISPLAY_NAME="${ORIG_DISPLAY_NAME} (${EXT_PUBLISHER})"
        echo "==> Marketplace name collision — overriding extension name to: $FALLBACK_EXT_NAME"
        set_ext_identity "$FALLBACK_EXT_NAME" "$FALLBACK_DISPLAY_NAME"
        rm -f *.vsix
        vsce publish --no-update-package-json "$NEW_VERSION"
      elif grep -qi "display name is taken" "$VSCE_LOG"; then
        CUR_EXT_NAME="$(node -p "require('./package.json').name")"
        UNIQUE_DISPLAY_NAME="${ORIG_DISPLAY_NAME} (${EXT_PUBLISHER} ${NEW_VERSION})"
        echo "==> Marketplace display-name collision — overriding displayName to: $UNIQUE_DISPLAY_NAME"
        set_ext_identity "$CUR_EXT_NAME" "$UNIQUE_DISPLAY_NAME"
        rm -f *.vsix
        vsce publish --no-update-package-json "$NEW_VERSION"
      else
        exit 1
      fi
    fi
  fi
  FINAL_EXT_NAME="$(node -p "require('./package.json').name")"
  MARKETPLACE_ITEM="${EXT_PUBLISHER}.${FINAL_EXT_NAME}"
  echo "    OK marketplace: ${EXT_PUBLISHER}.${FINAL_EXT_NAME}@$NEW_VERSION"
  cd "$NPM_DIR"
elif [ -n "$SKIP_VSCE" ]; then
  echo "==> SKIP_VSCE set — skipping marketplace publish"
fi

echo ""
echo "================================================================================"
echo "  Done! Released v$NEW_VERSION"
echo "================================================================================"
echo ""
echo "  Live links:"
echo "    npm:         https://www.npmjs.com/package/omni-notify-mcp"
echo "    marketplace: https://marketplace.visualstudio.com/items?itemName=${MARKETPLACE_ITEM}"
echo "    github:      https://github.com/menih/notify-mcp"
echo ""
echo "  (Marketplace takes ~2-5 min to reindex — refresh in a bit.)"
echo ""
echo "--------------------------------------------------------------------------------"
echo "  Share-with-friends blurb (copy below):"
echo "--------------------------------------------------------------------------------"
cat <<EOF

🔔 Just shipped omni-notify-mcp v$NEW_VERSION — an MCP server that lets AI agents
(Claude, Cursor, VS Code Copilot) reach you on desktop, Telegram, SMS, or email.

Two-way ask/reply, Do Not Disturb, idle gating with sound bypass, multi-session
routing, real-time inbox over SSE, copy-paste setup for every MCP client.

Install:   npx omni-notify-mcp
VS Code:   search "Omni Notify" in extensions

📦 https://www.npmjs.com/package/omni-notify-mcp
🛒 https://marketplace.visualstudio.com/items?itemName=${MARKETPLACE_ITEM}

EOF
echo "--------------------------------------------------------------------------------"

# Try to copy the blurb to the clipboard automatically (cross-platform).
BLURB=$(cat <<EOF
🔔 Just shipped omni-notify-mcp v$NEW_VERSION — an MCP server that lets AI agents (Claude, Cursor, VS Code Copilot) reach you on desktop, Telegram, SMS, or email.

Two-way ask/reply, Do Not Disturb, idle gating with sound bypass, multi-session routing, real-time inbox over SSE, copy-paste setup for every MCP client.

Install:   npx omni-notify-mcp
VS Code:   search "Omni Notify" in extensions

📦 https://www.npmjs.com/package/omni-notify-mcp
🛒 https://marketplace.visualstudio.com/items?itemName=${MARKETPLACE_ITEM}
EOF
)

if command -v clip >/dev/null 2>&1; then
  printf '%s' "$BLURB" | clip 2>/dev/null && echo "  ✓ Blurb copied to clipboard."
elif command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$BLURB" | pbcopy 2>/dev/null && echo "  ✓ Blurb copied to clipboard."
elif command -v xclip >/dev/null 2>&1; then
  printf '%s' "$BLURB" | xclip -selection clipboard 2>/dev/null && echo "  ✓ Blurb copied to clipboard."
fi
echo ""
