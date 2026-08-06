#!/usr/bin/env bash
# Builds a clean, store-ready package under dist/: only the runtime files,
# none of the dev artifacts (tests, icon/design sources, scripts, README).
#
# The split that keeps it that way: everything under assets/ ships, and nothing
# outside it does. Design sources live in assets-src/ (Pixelmator files, raw 3D
# exports) and store screenshots in store/; neither is ever copied here.
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
# esbuild creates its own output dirs; these are for the --no-minify path below,
# which is a plain cp and won't make them itself.
mkdir -p "$STAGE/vendor" "$STAGE/3d"

# Everything that gets minified: our own code plus the vendored three.js build.
# (vendor/three.iife.js is itself generated — see vendor/README.md.) Split by
# directory so the source archive can rebuild the same layout; esbuild's
# --outbase=. below keeps 3d/ and vendor/ nested in the output.
BUILT_TOP="content.js odds.js popup.js overlay.css dark.css"
BUILT_3D="3d/chips3d.js 3d/table3d.js 3d/coin3d.js"
BUILT_VENDOR="vendor/three.iife.js"
BUILT="$BUILT_TOP $BUILT_3D $BUILT_VENDOR"
# Everything copied through byte-for-byte.
VERBATIM="manifest.json popup.html"
# Runtime assets the page loads by URL (manifest web_accessible_resources is the
# matching "assets/*" wildcard). The whole directory ships, so adding a 3D model
# or an image means dropping the file in assets/ — no edit here. Design sources
# and store screenshots live OUTSIDE it, in assets-src/ and store/, so they
# cannot ride along. Models are committed pre-optimized (tools/optimize-model.sh);
# nothing under assets/ is transformed by this script.
ASSETS="assets"
# Checked below because the directory copy can't catch a file that was renamed
# or deleted upstream. Only the ones something else hardcodes belong here:
# dark.css:62 builds a chrome-extension URL for table.png, and 3d/table3d.js
# does the same for gpokr-logo.svg. Models are found at runtime, not hardcoded, so
# they're deliberately absent — a per-model list is what we're getting rid of.
REQUIRED_ASSETS="assets/table.png assets/gpokr-logo.svg"

cp $VERBATIM "$STAGE/"
cp -R icons "$STAGE/icons"
cp -R "$ASSETS" "$STAGE/assets"
# The zip -x below only filters the archive, not the staging dir that
# chrome://extensions loads unpacked — and Finder leaves these in assets/.
find "$STAGE" -name '.DS_Store' -delete

if [ "$MINIFY" -eq 1 ]; then
    command -v npx >/dev/null 2>&1 || {
        echo "npx not found — install Node, or run: $0 --no-minify" >&2
        exit 1
    }
    # One invocation for all of them; --outbase keeps 3d/ and vendor/ nested.
    npx --yes "$ESBUILD" $BUILT --minify --outdir="$STAGE" --outbase=. >/dev/null
else
    for f in $BUILT; do cp "$f" "$STAGE/$f"; done
fi

# Guard: every file the manifest references must exist in the package, plus the
# assets something hardcodes a URL for. The manifest's own asset entry is a
# wildcard ("assets/*"), which this grep can't check — hence REQUIRED_ASSETS.
missing=0
for f in $(grep -o '"[^"]*\.\(js\|css\|png\|html\)"' manifest.json | tr -d '"') $REQUIRED_ASSETS; do
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
    mkdir -p "$SRC_STAGE/vendor" "$SRC_STAGE/3d" "$SRC_STAGE/tools"
    cp $VERBATIM $BUILT_TOP BUILD.md pack.sh pack_ff.sh "$SRC_STAGE/"
    cp $BUILT_3D "$SRC_STAGE/3d/"
    cp $BUILT_VENDOR vendor/README.md "$SRC_STAGE/vendor/"
    cp -R icons "$SRC_STAGE/icons"
    # Same directory copy as the package, so a reviewer running pack.sh from the
    # source archive reproduces byte-identical output. tools/ is included because
    # BUILD.md points at it to explain how the 3D models were optimized — it is
    # authoring-only and this script never calls it.
    cp -R "$ASSETS" "$SRC_STAGE/assets"
    cp tools/optimize-model.sh "$SRC_STAGE/tools/"
    find "$SRC_STAGE" -name '.DS_Store' -delete

    for f in BUILD.md pack.sh vendor/three.iife.js vendor/README.md tools/optimize-model.sh $BUILT_3D $REQUIRED_ASSETS; do
        [ -f "$SRC_STAGE/$f" ] || { echo "MISSING from source archive: $f" >&2; exit 1; }
    done

    (cd "$SRC_STAGE" && zip -qr "../$SRC_NAME.zip" . -x '*.DS_Store')
    echo "built dist/$SRC_NAME.zip  (AMO source submission)"
fi

unzip -l "dist/$NAME.zip"
