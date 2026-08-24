// Offline unit tests for the alternate card backs — run with:
//   node cardbacks.test.js
//
// The card back style list is written down in five places that have no way to
// check each other at runtime: CARD_BACK_STYLES in content.js, the same list in
// popup.js, the <option> values in popup.html, the BACKS table in
// tools/make_cardbacks.py, and the actual files in assets/backs/. Miss one and
// the failure is quiet and ugly — a style that saves fine and then points every
// seat at a 404, leaving the face-down cards blank. So the point of this suite
// is agreement, not behaviour.
//
// It also guards the footprint. gpokr draws a player's two face-down cards as a
// single 23x26 image, and a replacement that is any other size does not fail —
// it just sits wrong, which is far easier to ship by accident than to notice.
"use strict";
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(label, cond, detail) {
    if (cond) console.log("ok   " + label);
    else { failures++; console.error("FAIL " + label + (detail ? " — " + detail : "")); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");

const content = read("content.js");
const popupJs = read("popup.js");
const popupHtml = read("popup.html");
const generator = read("tools/make_cardbacks.py");

// ---- the five lists agree ----
function jsList(src, name, where) {
    const m = new RegExp("const " + name + " = \\[([^\\]]*)\\]").exec(src);
    if (!m) throw new Error("no " + name + " in " + where);
    return (m[1].match(/"[^"]+"/g) || []).map((s) => s.slice(1, -1));
}
const styles = jsList(content, "CARD_BACK_STYLES", "content.js");
check("content.js declares some styles", styles.length >= 4, String(styles.length));
check("popup.js list matches content.js",
    jsList(popupJs, "CARD_BACK_STYLES", "popup.js").join() === styles.join(),
    jsList(popupJs, "CARD_BACK_STYLES", "popup.js").join());

// popup.js reaches for this by id at load time, so a missing or renamed select
// is not a degraded picker — it throws and takes the whole popup with it.
check('popup.html has the id popup.js looks up', popupHtml.includes('id="cardBack"'));
check("popup.js reads and writes that select",
    popupJs.includes('$("cardBack").value = cardBackValue();') &&
    popupJs.includes('settings.cardBack = $("cardBack").value;'));
// Both places the popup mirrors storage into its controls must set it, or the
// picker goes stale when the in-page one changes it.
check("popup.js mirrors it in both sync paths",
    (popupJs.match(/\$\("cardBack"\)\.value = cardBackValue\(\);/g) || []).length === 2,
    String((popupJs.match(/\$\("cardBack"\)\.value = cardBackValue\(\);/g) || []).length));

// The empty value is carried too — "" is gpokr's own back, a real choice.
//
// Scoped to the cardBack select. The popup has more than one now (card FACES got
// their own), and a bare sweep for <option> silently mixed them together — which
// this caught the moment faces were added, so it stays scoped rather than
// counting on there only ever being one picker.
const backSelect = /<select id="cardBack">([\s\S]*?)<\/select>/.exec(popupHtml);
check("popup.html has a cardBack <select> to read options from", !!backSelect);
const options = [...(backSelect ? backSelect[1] : "").matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
check('popup.html offers "" (the site\'s own back) first', options[0] === "",
    JSON.stringify(options[0]));
check("popup.html options match the style list",
    options.slice(1).join() === styles.join(), options.join());

const pyBacks = [...generator.matchAll(/^\s{4}"([a-z]+)":\s*dict\(/gm)].map((m) => m[1]);
check("the generator draws exactly the declared styles",
    pyBacks.slice().sort().join() === styles.slice().sort().join(), pyBacks.join());

// ---- every style has a shipped file, of the right shape ----
// Minimal PNG header read: IHDR is always the first chunk, at a fixed offset.
function pngHeader(file) {
    const b = fs.readFileSync(file);
    if (b.length < 26 || b.toString("latin1", 1, 4) !== "PNG") return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), depth: b[24], color: b[25] };
}
// The site's own back is 23x26. Ours are drawn at 4x on purpose (sharper on
// HiDPI; the <img> display size is pinned so intrinsic size can't affect
// layout), so what must hold is the aspect ratio and an exact integer multiple —
// not equality. A non-multiple would land the two-card geometry off the pixel
// grid and soften the whole thing.
const SITE_W = 23, SITE_H = 26;
const SCALE = 4;
for (const style of styles) {
    const file = path.join(__dirname, "assets", "backs", style + ".png");
    if (!fs.existsSync(file)) { check("assets/backs/" + style + ".png exists", false); continue; }
    const h = pngHeader(file);
    check("assets/backs/" + style + ".png is a PNG", !!h);
    if (!h) continue;
    check(style + " is an exact " + SCALE + "x of the site's footprint",
        h.w === SITE_W * SCALE && h.h === SITE_H * SCALE,
        h.w + "x" + h.h + " (want " + SITE_W * SCALE + "x" + SITE_H * SCALE + ")");
    // 8-bit RGBA: the corners and the halo are partly transparent, so an opaque
    // format would paint a box over the felt.
    check(style + " is 8-bit RGBA", h.depth === 8 && h.color === 6,
        "depth=" + h.depth + " color=" + h.color);
}

// Nothing unexpected in the shipped directory — a stray file here gets packaged.
const dir = path.join(__dirname, "assets", "backs");
if (fs.existsSync(dir)) {
    const stray = fs.readdirSync(dir).filter((f) => !styles.includes(f.replace(/\.png$/, "")));
    // The generator's --preview sheet is a dev artifact and must not ship.
    check("no stray files in assets/backs", stray.length === 0, stray.join(", "));
}

// ---- the identification and swap plumbing ----
check("content.js keys the site's back by hash",
    /const SITE_BACK_HASH = "[0-9a-f]{8}";/.test(content),
    (/const SITE_BACK_HASH = "[^"]*";/.exec(content) || [])[0]);
// The path template and the generator's output directory have to agree.
check("content.js builds the assets/backs/<style>.png path",
    content.includes('"assets/backs/" + style + ".png"'));
check("the generator writes to assets/backs", /OUT_DIR = "assets\/backs"/.test(generator));
check("the generator's SCALE matches what the assets were checked against",
    new RegExp("SCALE = " + SCALE + "\\b").test(generator));
// A 4x asset on an <img> whose size is NOT pinned would render four times too
// big, so the swap must set width/height itself rather than trust GWT's.
check("the swap pins the display size before swapping the src",
    content.includes('img.setAttribute("width", String(img._gpeBackW));') &&
    content.includes('img.setAttribute("height", String(img._gpeBackH));'));
check("the pinned size is measured from the site's own back",
    content.includes("img._gpeBackW = img.naturalWidth || SITE_BACK_W;"));
// An unknown stored value must fall back to the site's back rather than 404.
check("a stored style is validated against the list",
    /CARD_BACK_STYLES\.indexOf\(s && s\.cardBack\) >= 0/.test(content));
// Restoring the site's back depends on having stashed it before overwriting.
check("the site's own back is stashed before being replaced",
    content.includes("img._gpeSiteBack = src;"));
check("re-entry on our own write is detected",
    /OUR_BACK_RE\s*=/.test(content) && content.includes("OUR_BACK_RE.test(src)"));

console.log(failures ? "\n" + failures + " failure(s)" : "\nall passed");
process.exit(failures ? 1 : 0);
