#!/usr/bin/env bash
# Builds the Firefox package by reusing pack.sh's runtime staging and adding
# `browser_specific_settings.gecko` — the add-on id AMO requires, which must NOT
# be in the Chrome upload. All chrome.* APIs used here work under Firefox's
# chrome-compat shim, so the JS/CSS/HTML are shared verbatim.
#
#   ./pack_ff.sh   ->  dist/gpokr-tools-<version>-firefox.zip  (AMO / about:debugging)
#
# Runs ./pack.sh first (so the Chrome zip is built too) to keep one source of
# truth for the packaged file list; then copies that staging, injects the gecko
# settings, and rezips.

set -euo pipefail
cd "$(dirname "$0")"

GECKO_ID="gpokr-tools@orases.com"   # AMO add-on id (also chrome.runtime.id in FF)
GECKO_MIN="109.0"                    # first Firefox with MV3 + array web_accessible_resources

./pack.sh >/dev/null   # build the shared runtime staging (quietly)

VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' manifest.json)
SRC="dist/gpokr-tools-$VERSION"
NAME="gpokr-tools-$VERSION-firefox"
STAGE="dist/$NAME"

rm -rf "$STAGE" "dist/$NAME.zip"
cp -R "$SRC" "$STAGE"

STAGE="$STAGE" GECKO_ID="$GECKO_ID" GECKO_MIN="$GECKO_MIN" node -e '
    const fs = require("fs");
    const p = process.env.STAGE + "/manifest.json";
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    m.browser_specific_settings = { gecko: {
        id: process.env.GECKO_ID,
        strict_min_version: process.env.GECKO_MIN,
        // AMO requires this; the extension stores everything locally and
        // transmits no user data, so nothing is collected.
        data_collection_permissions: { required: ["none"] },
    } };
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'

# manifest.json must be at the zip root for AMO (see pack.sh).
(cd "$STAGE" && zip -qr "../$NAME.zip" . -x '*.DS_Store')
echo "built dist/$NAME.zip  (firefox)"
unzip -l "dist/$NAME.zip"
