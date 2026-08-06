#!/usr/bin/env bash
# Shrinks a glTF/GLB model for shipping. Run this BY HAND when you add or
# re-export a model — it is deliberately not called by pack.sh or the deploy
# workflow.
#
#   ./tools/optimize-model.sh assets-src/models/beer.raw.glb assets/models/beer.glb
#
# The workflow is: export from your 3D tool to assets-src/models/<name>.raw.glb,
# run this to assets/models/<name>.glb, and commit BOTH. The optimized file is
# the source of truth for the package — pack.sh copies assets/ byte-for-byte, so
# there is no build-time transform for AMO reviewers to reproduce, and the raw
# export stays around so the optimization can be redone with better settings.
#
# What it does: drops unused nodes/materials, merges duplicate meshes and
# vertices, and quantizes positions/normals/UVs from float32 down to integers.
# Quantization writes KHR_mesh_quantization, which three.js's GLTFLoader reads
# natively — no decoder ships with the extension.
#
# `--compress quantize` overrides the CLI's default of meshopt on purpose. Meshopt
# and Draco both need a decoder in the package (~25KB of JS for meshopt, ~200KB of
# wasm+JS for Draco) to save a few KB per model at our current sizes, and the
# store package is already deflate-compressed on download. Quantization is the
# one that costs zero bytes at runtime. Revisit if the total model payload ever
# passes ~1MB. Measured on the first model (beer): 34.3KB raw export -> 17.2KB
# quantized (5.8KB deflated); without quantization it was 22.9KB.
#
# The CLI also simplifies geometry by default (meshoptimizer, 0.1% error
# tolerance, baked into the output — no decoder). It was a no-op on beer, which
# was already minimal. If a dense model ever comes out visibly damaged, re-run
# with --no-simplify appended and compare.

set -euo pipefail
cd "$(dirname "$0")/.."

# Pinned to a major so a re-run years from now doesn't silently change settings.
GLTF_TRANSFORM="@gltf-transform/cli@4"

if [ "$#" -lt 2 ]; then
    echo "usage: $0 <input.glb> <output.glb> [extra gltf-transform flags...]" >&2
    echo "   eg: $0 assets-src/models/beer.raw.glb assets/models/beer.glb" >&2
    exit 2
fi

IN="$1"
OUT="$2"

[ -s "$IN" ] || { echo "no such model: $IN" >&2; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "npx not found — install Node 18+" >&2; exit 1; }

case "$IN" in
    assets-src/*) ;;
    *) echo "warning: input isn't under assets-src/ — keep raw exports there" >&2 ;;
esac

mkdir -p "$(dirname "$OUT")"

# Extra flags are passed through, so a one-off can override any of this:
#   ./tools/optimize-model.sh in.glb out.glb --no-simplify
# --texture-compress webp is a no-op on models without textures, and the right
# default for ones that have them.
npx --yes "$GLTF_TRANSFORM" optimize "$IN" "$OUT" \
    --compress quantize \
    --texture-compress webp \
    "${@:3}"

before=$(wc -c < "$IN" | tr -d ' ')
after=$(wc -c < "$OUT" | tr -d ' ')
echo "$IN ($before bytes) -> $OUT ($after bytes, $(( 100 - after * 100 / before ))% smaller)"
echo "commit both files; pack.sh picks up $OUT automatically."
