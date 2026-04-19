#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "==> Building..."
npm run build:ui

echo "==> Restarting server..."
pkill -9 -f "dist/ui/server.js" 2>/dev/null || true
sleep 1
nohup node dist/ui/server.js >> /tmp/notify-mcp.log 2>&1 &
sleep 2
tail -3 /tmp/notify-mcp.log
echo "Done."
