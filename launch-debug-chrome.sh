#!/usr/bin/env bash
# Launches a dedicated Chrome instance with remote debugging enabled so the
# chrome-devtools MCP server can attach to it (via --browserUrl http://127.0.0.1:9222).
#
# This uses a SEPARATE profile dir, so it runs alongside your normal Chrome with
# no conflict. Log into gpokr once in this window; the login persists here.
#
# Usage:  ./launch-debug-chrome.sh
# Then in Claude Code, the chrome-devtools tools will attach to this browser.

set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE_DIR="$HOME/.chrome-gpokr-debug"
PORT=9222

exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "https://gpokr.com"