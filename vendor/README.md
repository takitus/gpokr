# vendor/three.iife.js

[three.js](https://threejs.org) **r0.185.1**, MIT licensed, © 2010–2025 three.js
authors. Used by `chips3d.js` (chip portal), `table3d.js` (3D felt) and
`coin3d.js` (chip toss).

It is vendored rather than loaded from a CDN because Manifest V3 forbids remote
code, and it is committed **unminified** so it stays reviewable as-is.

## Regenerating it

The bundle is generated from the upstream npm package, not hand-written. With an
`entry.js` containing exactly:

```js
export * from "three";
```

run:

```sh
npm i three esbuild
npx esbuild entry.js --bundle --format=iife \
  --global-name=THREE --outfile=three.iife.js --legal-comments=none
```

Pin `three@0.185.1` to reproduce this exact file.

## Hand-added lines

Only two edits are made to esbuild's output, both outside the bundled code:

1. The provenance comment block at the top of the file (the same information as
   this README).
2. A single line at the bottom:

   ```js
   globalThis.THREE = THREE;
   ```

   `--global-name=THREE` declares `var THREE` inside the content script's
   isolated world; this makes the handoff to `window.THREE` explicit, which is
   how `chips3d.js`, `table3d.js`, `coin3d.js` and `content.js` reach it.

Everything else is esbuild output from unmodified upstream three.js.
