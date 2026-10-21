/* The classic add-on's renderers, loaded as they always were: plain scripts
 * that leave globals behind (THREE, GPE_CHIPS, GPE_COIN, GPE_PROPS). They are
 * self-contained — coin3d draws on its own full-window canvas from screen
 * rects, props3d finds its models beside its own script — so they run here
 * unchanged. Nothing is fetched until something is thrown.
 *
 * They were written against the classic table art: a 790x451 frame with the
 * felt centred at (395, 190) and 290x102 half-axes. classicFrame() builds that
 * frame around ui2's table, whose felt has the same proportions, so every
 * art-space measurement in them lands on ui2's felt. */

const loads = new Map();

function loadScript(url) {
    if (!loads.has(url)) {
        loads.set(url, new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = url;
            s.async = false;
            s.onload = () => resolve(true);
            s.onerror = () => { loads.delete(url); reject(new Error(url)); };
            document.head.appendChild(s);
        }));
    }
    return loads.get(url);
}

export function ensureCoin(ctx) {
    if (window.GPE_COIN && window.GPE_CHIPS) return Promise.resolve(true);
    const url = (p) => ctx.assets.url(p);
    return (window.THREE ? Promise.resolve() : loadScript(url("vendor/three.iife.js")))
        .then(() => (window.GPE_CHIPS ? null : loadScript(url("3d/chips3d.js"))))
        .then(() => (window.GPE_COIN ? null : loadScript(url("3d/coin3d.js"))))
        .then(() => !!window.GPE_COIN)
        .catch((e) => { ctx.log("3D renderer unavailable:", e.message); return false; });
}

/* props3d is a catalog (names, glyphs, sounds, cooldowns) as well as a
 * renderer; the catalog is wanted early, for the menus and to vet incoming
 * items, and touches nothing heavy at load. */
export function ensureCatalog(ctx) {
    if (window.GPE_PROPS) return Promise.resolve(true);
    return loadScript(ctx.assets.url("3d/props3d.js"))
        .then(() => !!window.GPE_PROPS)
        .catch((e) => { ctx.log("prop catalog unavailable:", e.message); return false; });
}

export function ensureProps(ctx) {
    return ensureCoin(ctx).then((ok) => ok && ensureCatalog(ctx));
}

/* The classic table frame around ui2's table shape (its outer rail). */
const FELT_HALF_W = 0.458;   // ui2 felt half-width, as a share of the shape's width
const FELT_CY = 0.49;        // felt centre, as a share of the shape's height
export function classicFrame(shapeRect) {
    if (!shapeRect || shapeRect.width < 40) return null;
    const sc = (FELT_HALF_W * shapeRect.width) / 290;
    const cx = shapeRect.left + shapeRect.width / 2;
    const cy = shapeRect.top + shapeRect.height * FELT_CY;
    const left = cx - 395 * sc, top = cy - 190 * sc, width = 790 * sc, height = 451 * sc;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
}
