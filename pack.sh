#!/usr/bin/env bash
# Builds a clean, store-ready package under dist/: only the runtime files,
# none of the dev artifacts (tests, icon/design sources, scripts, README).
#
#   ./pack.sh   ->  dist/gpokr-tools-<version>/      (staging dir)
#                   dist/gpokr-tools-<version>.zip   (upload this to the Web Store)
#
# For a local .crx instead: chrome://extensions -> Pack extension -> point it
# at the staging dir. Keep the generated .pem out of git.

set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' manifest.json)
NAME="gpokr-tools-$VERSION"
STAGE="dist/$NAME"

rm -rf "$STAGE" "dist/$NAME.zip"
mkdir -p "$STAGE/assets"

cp manifest.json content.js odds.js overlay.css dark.css popup.html popup.js "$STAGE/"
cp -R icons "$STAGE/icons"
cp assets/table.png "$STAGE/assets/"   # dark.css backdrop (web_accessible_resources)

# Guard: every file the manifest references must exist in the package.
missing=0
for f in $(grep -o '"[^"]*\.\(js\|css\|png\|html\)"' manifest.json | tr -d '"'); do
    [ -f "$STAGE/$f" ] || { echo "MISSING from package: $f" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || { echo "aborting — update the cp list in pack.sh" >&2; exit 1; }

(cd dist && zip -qr "$NAME.zip" "$NAME")
echo "built dist/$NAME.zip"
unzip -l "dist/$NAME.zip"
