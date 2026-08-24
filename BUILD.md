# Build instructions (GPokr Tools)

This add-on's packaged JavaScript and CSS are **minified**, so this archive
contains the original human-readable sources and the scripts that produce the
uploaded file. Everything below runs offline apart from fetching the one pinned
build tool from npm.

## What's minified, and with what

| Packaged file           | Source in this archive  | Notes                                    |
| ----------------------- | ----------------------- | ---------------------------------------- |
| `content.js`            | `content.js`            | our code                                 |
| `odds.js`               | `odds.js`               | our code                                 |
| `3d/chips3d.js`         | `3d/chips3d.js`         | our code                                 |
| `3d/table3d.js`         | `3d/table3d.js`         | our code                                 |
| `3d/coin3d.js`          | `3d/coin3d.js`          | our code                                 |
| `3d/props3d.js`         | `3d/props3d.js`         | our code                                 |
| `bridge/ws-monitor.js`  | `bridge/ws-monitor.js`  | our code                                 |
| `popup.js`              | `popup.js`              | our code                                 |
| `overlay.css`           | `overlay.css`           | our code                                 |
| `dark.css`              | `dark.css`              | our code                                 |
| `vendor/three.iife.js`  | `vendor/three.iife.js`  | three.js r0.185.1, MIT — see below        |

`manifest.json`, `popup.html`, `icons/*` and the whole `assets/` directory
(images plus the 3D models under `assets/models/`) are copied into the package
byte-for-byte and are not transformed at all.

The 3D models are committed to the repo **already optimized**, so no model is
transformed at build time either. `tools/optimize-model.sh` is the authoring
helper that produced them — it wraps `@gltf-transform/cli` and is run by hand
when a model is added or re-exported, never by `pack.sh`. Its output is what's
committed under `assets/models/`, and the un-optimized export is kept outside the
package in `assets-src/models/`. One model (`float.glb`, the life ring) also went
through `tools/drop-node.js` first, which removes a named object from an export —
the ring's rope loop, which we don't ship — before the optimizer merges meshes by
material and puts it out of reach. Both helpers are in this archive. Nothing under
`assets/` needs a build tool to reproduce: the files in this archive *are* the
files in the add-on.

The only build tool is **esbuild 0.28.1**, used solely as a minifier (no bundling,
no transpiling, no code generation). Every file is minified independently, so each
packaged file corresponds 1:1 to the source file of the same name.

## Requirements

- Node.js 18 or newer, with `npx` (only used to fetch the pinned esbuild)
- `bash`, `zip`, `unzip`, `sed`, `grep` (standard on macOS and Linux)

## Reproducing the build

From the root of this archive:

```sh
# Firefox / AMO package — this is the uploaded add-on:
./pack_ff.sh
#   -> dist/gpokr-tools-<version>-firefox.zip

# Chrome Web Store package, if you want it as well:
./pack.sh
#   -> dist/gpokr-tools-<version>.zip
```

`pack_ff.sh` runs `pack.sh` first, then copies the resulting staging directory and
adds the `browser_specific_settings.gecko` block (the AMO add-on id and minimum
Firefox version), which must not appear in the Chrome upload. It performs no other
transformation.

The exact minifier invocation `pack.sh` makes is:

```sh
npx --yes esbuild@0.28.1 \
  content.js odds.js popup.js overlay.css dark.css \
  3d/chips3d.js 3d/table3d.js 3d/coin3d.js 3d/props3d.js bridge/ws-monitor.js vendor/three.iife.js \
  --minify --outdir=<staging dir> --outbase=.
```

To inspect a build with readable sources instead, run `./pack.sh --no-minify`.

## About vendor/three.iife.js

This is [three.js](https://threejs.org) r0.185.1 (MIT, © 2010-2025 three.js
authors), used by `3d/chips3d.js` for the 3D chip animation. It is committed here as a
readable, non-minified bundle; the extension cannot load it from a CDN because
Manifest V3 forbids remote code.

It is itself generated from the upstream npm package rather than hand-written.
`vendor/README.md` in this archive gives the exact npm and esbuild commands that
produce it, so it can be regenerated from upstream and compared. The only
hand-added lines are the provenance comment at the top of the file and a single
`globalThis.THREE = THREE;` at the bottom.
