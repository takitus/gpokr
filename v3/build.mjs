// Builds the ui2 extension for tools.gpokr.com/<id>/<version>/ (npm run build).
//
// dist/index.js is the entry: ui2 fetches it, checks its sha256 and imports it
// from a blob: URL, so it must be ONE file. Nothing it imports can be relative.
// Everything else v3 loads goes through ctx.assets.url(path), which ui2
// resolves against the entry's folder, so it is staged here under the same
// paths it has in the repo (and that the Chrome shim serves from the repo root):
//   v3/style.css, 3d/*.js, vendor/three.iife.js, assets/**
// The deploy uploads all of dist/; only index.js is covered by the sha256.

import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The entry, with odds.js (a UMD file shared with the node tests) bundled in.
await build({
    entryPoints: [join(here, "src/index.js")],
    bundle: true,
    format: "esm",
    minify: true,
    target: "es2020",
    outfile: join(out, "index.js"),
    legalComments: "none",
});

// The classic scripts and the stylesheet, minified in place of their paths.
const scripts = [
    ...readdirSync(join(root, "3d")).filter((f) => f.endsWith(".js")).map((f) => join(root, "3d", f)),
    join(root, "vendor/three.iife.js"),
    join(here, "style.css"),
];
await build({
    entryPoints: scripts,
    minify: true,
    outdir: out,
    outbase: root,
    legalComments: "none",
});

// Images, audio, card backs, models: as they are, the whole folder, as the
// classic build ships it (pack.sh, deploy.yml), minus Finder litter.
cpSync(join(root, "assets"), join(out, "assets"), {
    recursive: true,
    filter: (src) => !src.endsWith(".DS_Store"),
});

console.log("built", out);
