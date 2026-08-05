#!/usr/bin/env bash
# Builds a clean, store-ready package under dist/: only the runtime files,
# none of the dev artifacts (tests, icon/design sources, scripts, README).
#
#   ./pack.sh   ->  dist/gpokr-tools-<version>/             (staging dir)
#                   dist/gpokr-tools-<version>.zip           (upload this to the Web Store)
#                   dist/gpokr-tools-<version>-source.zip    (upload this to AMO, see below)
#
# The packaged JS/CSS is MINIFIED (esbuild, pinned version below). That halves the
# download — three.js alone is 1.2MB unminified — but it also means AMO requires
# the human-readable sources plus reproducible build instructions alongside the
# add-on, so this script emits the source archive too. Keep them in step: upload
# the pair from the same run. BUILD.md is the instructions AMO reviewers follow.
#
#   ./pack.sh --no-minify   ->  readable JS/CSS in the package
#
# Use --no-minify to debug a store build (stack traces line up with the sources);
# don't ship it, and note it skips the source archive since nothing is minified.
#
# For a Firefox build, use ./pack_ff.sh (reuses this staging + adds the gecko id).
#
# For a local .crx instead: chrome://extensions -> Pack extension -> point it
# at the staging dir. Keep the generated .pem out of git.

set -euo pipefail
cd "$(dirname "$0")"

# Pinned so a reviewer running BUILD.md gets byte-identical output. If you bump
# this, bump the version in BUILD.md too.
ESBUILD="esbuild@0.28.1"

MINIFY=1
case "${1:-}" in
    --no-minify) MINIFY=0 ;;
    "") ;;
    *) echo "usage: $0 [--no-minify]" >&2; exit 2 ;;
esac

VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' manifest.json)
NAME="gpokr-tools-$VERSION"
STAGE="dist/$NAME"
SRC_NAME="$NAME-source"
SRC_STAGE="dist/$SRC_NAME"

rm -rf "$STAGE" "dist/$NAME.zip" "$SRC_STAGE" "dist/$SRC_NAME.zip"
mkdir -p "$STAGE/assets" "$STAGE/vendor"

# Everything that gets minified: our own code plus the vendored three.js build.
# (vendor/three.iife.js is itself generated — see vendor/README.md.) Split by
# directory so the source archive can rebuild the same layout.
BUILT_TOP="content.js odds.js chips3d.js popup.js overlay.css dark.css"
BUILT_VENDOR="vendor/three.iife.js"
BUILT="$BUILT_TOP $BUILT_VENDOR"
# Everything copied through byte-for-byte.
VERBATIM="manifest.json popup.html"

cp $VERBATIM "$STAGE/"
cp -R icons "$STAGE/icons"
cp assets/table.png "$STAGE/assets/"   # dark.css backdrop (web_accessible_resources)

if [ "$MINIFY" -eq 1 ]; then
    command -v npx >/dev/null 2>&1 || {
        echo "npx not found — install Node, or run: $0 --no-minify" >&2
        exit 1
    }
    # One invocation for all of them; --outbase keeps vendor/ nested.
    npx --yes "$ESBUILD" $BUILT --minify --outdir="$STAGE" --outbase=. >/dev/null
else
    for f in $BUILT; do cp "$f" "$STAGE/$f"; done
fi

# Guard: every file the manifest references must exist in the package.
missing=0
for f in $(grep -o '"[^"]*\.\(js\|css\|png\|html\)"' manifest.json | tr -d '"'); do
    [ -f "$STAGE/$f" ] || { echo "MISSING from package: $f" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || { echo "aborting — update the file lists in pack.sh" >&2; exit 1; }

# Zip the files themselves (manifest.json at the root) — both Web Store and AMO
# reject a zip whose contents are nested inside a wrapper folder.
(cd "$STAGE" && zip -qr "../$NAME.zip" . -x '*.DS_Store')
echo "built dist/$NAME.zip$([ "$MINIFY" -eq 1 ] && echo '  (minified)' || echo '  (NOT minified — debug build)')"

# ---- AMO source archive -----------------------------------------------------
# Required whenever the uploaded add-on contains minified code: the readable
# sources, the scripts that build them, and instructions to reproduce the upload.
if [ "$MINIFY" -eq 1 ]; then
    mkdir -p "$SRC_STAGE/assets" "$SRC_STAGE/vendor"
    cp $VERBATIM $BUILT_TOP BUILD.md pack.sh pack_ff.sh "$SRC_STAGE/"
    cp $BUILT_VENDOR vendor/README.md "$SRC_STAGE/vendor/"
    cp -R icons "$SRC_STAGE/icons"
    cp assets/table.png "$SRC_STAGE/assets/"

    for f in BUILD.md pack.sh vendor/three.iife.js vendor/README.md; do
        [ -f "$SRC_STAGE/$f" ] || { echo "MISSING from source archive: $f" >&2; exit 1; }
    done

    (cd "$SRC_STAGE" && zip -qr "../$SRC_NAME.zip" . -x '*.DS_Store')
    echo "built dist/$SRC_NAME.zip  (AMO source submission)"
fi

unzip -l "dist/$NAME.zip"
