# vendor/three.iife.js

[three.js](https://threejs.org) **r0.185.1**, MIT licensed, © 2010–2025 three.js
authors. Used by `3d/chips3d.js`, `3d/table3d.js`, and `3d/coin3d.js` for the 3D chip,
table, and coin rendering. Manifest V3 forbids loading remote code, so the
library is committed here as a readable (non-minified) IIFE bundle that exposes
`window.THREE` in the content-script world.

## How it was generated

From an empty scratch directory, using the pinned upstream package:

```sh
# 1. install the exact library version + the bundler
npm i three@0.185.1 esbuild@0.28.1

# 2. entry point that re-exports the whole library
printf 'export * from "three";\n' > entry.js

# 3. bundle to a global-name IIFE, no minification, no legal comments
npx esbuild entry.js --bundle --format=iife \
  --global-name=THREE --outfile=three.iife.js --legal-comments=none
```

This produces `three.iife.js` byte-for-byte, except for two hand-added edits that
are the only differences from the raw esbuild output:

1. the provenance comment block at the **top** of the file, and
2. a single line at the **bottom** — `globalThis.THREE = THREE;` — that hands the
   bundle's return value to the content-script global.

To verify, regenerate with the commands above and diff against the committed
file; only those two additions should differ.

## Why it is not minified

AMO requires a human-readable source submission for any minified third-party
code. Keeping this bundle unminified in the repo means it is already reviewable
as-is and needs no separate un-minified copy in the source archive.
