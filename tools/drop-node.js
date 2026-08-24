#!/usr/bin/env node
/*
 * Removes named objects from a glTF/GLB export, BEFORE tools/optimize-model.sh.
 *
 *   node tools/drop-node.js <in.glb> <out.glb> <node name> [more names...]
 *
 * Why this exists: an export sometimes carries geometry we don't want to ship,
 * and by the time the optimizer has run it is too late to pick it out — that
 * pipeline merges meshes BY MATERIAL, so two objects sharing one material become
 * one mesh with no seam to cut along. Dropping the node from the scene first
 * leaves the optimizer's own prune step to collect the orphaned mesh, accessors
 * and buffer views, so nothing about the output needs special handling.
 *
 * float.glb is the case it was written for. The export models a life ring plus a
 * rope loop (`Rectangle_sweep`) at a wider radius than the ring itself, which at
 * table size renders as a thin square outline around it AND, being the widest
 * thing in the model, takes 12% off the ring body's apparent size — normalize()
 * scales by the whole bounding box. So the shipped model is the ring alone:
 *
 *   node tools/drop-node.js assets-src/models/float.raw.glb /tmp/float.trim.glb Rectangle_sweep
 *   ./tools/optimize-model.sh /tmp/float.trim.glb assets/models/float.glb
 *
 * The raw export in assets-src/ keeps the rope, so the decision is reversible:
 * re-run the optimizer straight off it to get the roped version back.
 *
 * Names are matched exactly against node names. Dropping a node that something
 * else parents to is refused rather than silently orphaning its children.
 */
"use strict";

const fs = require("fs");

const [, , inPath, outPath, ...names] = process.argv;
if (!inPath || !outPath || !names.length) {
    console.error("usage: drop-node.js <in.glb> <out.glb> <node name> [more names...]");
    process.exit(2);
}

// GLB is a 12-byte header then length-prefixed chunks. The BIN chunk's type is
// "BIN\0" — padded with a NUL, not a space, which is easy to get wrong.
const buf = fs.readFileSync(inPath);
if (buf.toString("utf8", 0, 4) !== "glTF") {
    console.error(inPath + " is not a GLB (no glTF magic) — this only handles binary glTF");
    process.exit(1);
}
let off = 12, json = null, bin = null;
while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.toString("utf8", off + 4, off + 8);
    if (type === "JSON") json = JSON.parse(buf.toString("utf8", off + 8, off + 8 + len));
    else if (type.slice(0, 3) === "BIN") bin = buf.slice(off + 8, off + 8 + len);
    off += 8 + len;
}
if (!json) { console.error("no JSON chunk in " + inPath); process.exit(1); }

const nodes = json.nodes || [];
const doomed = new Set();
for (const name of names) {
    const i = nodes.findIndex((n) => n.name === name);
    if (i < 0) { console.error('no node named "' + name + '" in ' + inPath); process.exit(1); }
    const parent = nodes.findIndex((n) => (n.children || []).indexOf(i) >= 0);
    if (parent >= 0) {
        console.error('"' + name + '" is a child of "' + (nodes[parent].name || parent) +
            '" — dropping it would orphan the branch; unparent it in the exporter instead');
        process.exit(1);
    }
    doomed.add(i);
}

// Only the scene lists change. Everything else — the node array, the meshes, the
// accessors — is left exactly as it was, for the optimizer's prune to reap: an
// unreferenced node is dead weight in the file, not a broken index.
let removed = 0;
for (const scene of json.scenes || []) {
    const before = (scene.nodes || []).length;
    scene.nodes = (scene.nodes || []).filter((i) => !doomed.has(i));
    removed += before - scene.nodes.length;
}
if (!removed) { console.error("nothing removed — are those nodes in a scene?"); process.exit(1); }

// Both chunks are padded to 4 bytes: JSON with spaces, BIN with zeros. The
// header's total length has to count the padding, so it is written last.
let text = JSON.stringify(json);
while (text.length % 4) text += " ";
const parts = [];
const header = Buffer.alloc(12);
header.write("glTF", 0);
header.writeUInt32LE(2, 4);
parts.push(header);
const jsonChunk = Buffer.alloc(8);
jsonChunk.writeUInt32LE(text.length, 0);
jsonChunk.write("JSON", 4);
parts.push(jsonChunk, Buffer.from(text, "utf8"));
if (bin) {
    const pad = (4 - (bin.length % 4)) % 4;
    const binChunk = Buffer.alloc(8);
    binChunk.writeUInt32LE(bin.length + pad, 0);
    // 0x004E4942 is "BIN\0": the chunk type is NUL-padded, not space-padded,
    // and three.js's GLTFLoader compares it against that constant exactly.
    // Written as the number rather than as a string with a NUL in it, which
    // is correct but makes this file read as binary to every text tool.
    binChunk.writeUInt32LE(0x004E4942, 4);
    parts.push(binChunk, bin, Buffer.alloc(pad));
}
const out = Buffer.concat(parts);
out.writeUInt32LE(out.length, 8);
fs.writeFileSync(outPath, out);

console.log("dropped " + removed + " node(s) [" + names.join(", ") + "] -> " + outPath +
    " (" + out.length + " bytes); now run tools/optimize-model.sh on it");
