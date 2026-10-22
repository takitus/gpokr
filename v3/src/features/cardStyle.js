/* How the cards look: the four-colour deck (blue diamonds, green clubs) and
 * the card back, chosen in this feature's editor.
 *
 * ui2 draws each card face from its own canvas, so the four colours are
 * painted into those canvases, the classic filters' arithmetic done on the
 * pixels: diamonds move their red ink into the blue channel (every neutral
 * pixel comes back unchanged), clubs get green laid over their dark ink.
 * Hearts and spades are left alone, so red and black still mean what they
 * did. Which texture is which card is learned from the table state (see
 * lib/pixiCards.js); a card not yet named is left as it is.
 *
 * A back is ui2's one shared back canvas, redrawn with the chosen design.
 * Every canvas changed is copied first and put back when the feature stops
 * or the choice changes.
 *
 * Our own card images (hand summaries, shared hands) take the classic SVG
 * filters instead, keyed on their data-gpe-card attribute. */

import { slot } from "../slot.js";
import { findPixiApp } from "../lib/pixi.js";
import { readCards, identify } from "../lib/pixiCards.js";
import { openPanel, checkRow, choiceRow, hint } from "../lib/panel.js";

export const BACK_STYLES = [["", "team (site)"], ["rosette", "rosette"], ["lattice", "lattice"], ["fan", "fan"], ["deco", "deco"]];
const DEFAULTS = { fourColor: true, back: "" };

const SUIT_FILTER_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false">' +
    '<filter id="gpt-suit-diamond" color-interpolation-filters="sRGB">' +
    '<feColorMatrix type="matrix" values="0 1 0 0 0  0 1 0 0 0  1 -1 1 0 0  0 0 0 1 0"/></filter>' +
    '<filter id="gpt-suit-club" color-interpolation-filters="sRGB">' +
    '<feColorMatrix result="dark" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -0.2126 -0.7152 -0.0722 0 1"/>' +
    '<feComposite in="dark" in2="SourceGraphic" operator="in" result="inside"/>' +
    '<feComponentTransfer in="inside" result="mask"><feFuncA type="table" tableValues="0 0 0 0.4 1 1"/></feComponentTransfer>' +
    '<feFlood flood-color="#008000" result="ink"/>' +
    '<feComposite in="ink" in2="mask" operator="in" result="green"/>' +
    '<feComposite in="green" in2="SourceGraphic" operator="over"/></filter></svg>';

/* The filters' arithmetic, on a canvas in place. */
function recolor(cv, suit) {
    const g = cv.getContext("2d", { willReadFrequently: true });
    if (!g) return false;
    const img = g.getImageData(0, 0, cv.width, cv.height);
    const d = img.data;
    const table = [0, 0, 0, 0.4, 1, 1];
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i + 1], b = d[i + 2], a = d[i + 3] / 255;
        if (!a) continue;
        if (suit === "d") {
            d[i] = gg;
            d[i + 2] = Math.max(0, Math.min(255, r - gg + b));
        } else {
            const dark = (1 - (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255) * a;
            const x = dark * 5, k = Math.min(4, Math.floor(x));
            const m = table[k] + (table[k + 1] - table[k]) * (x - k);
            if (m <= 0) continue;
            d[i] = r * (1 - m);
            d[i + 1] = gg * (1 - m) + 128 * m;
            d[i + 2] = b * (1 - m);
        }
    }
    g.putImageData(img, 0, 0);
    return true;
}

/* Is the card's index (the rank and suit in its top-left corner) red, as on
 * hearts and diamonds, or black? Only the corner: a court card's picture has
 * red in it whatever the suit. */
function hasRedInk(cv) {
    const g = cv.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    const w = Math.round(cv.width * 0.24), h = Math.round(cv.height * 0.32);
    const d = g.getImageData(0, 0, w, h).data;
    let red = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue;
        if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red++;
        else if (d[i] < 70 && d[i + 1] < 70 && d[i + 2] < 70) dark++;
    }
    return red > dark;
}

function snapshot(cv) {
    const copy = document.createElement("canvas");
    copy.width = cv.width; copy.height = cv.height;
    copy.getContext("2d").drawImage(cv, 0, 0);
    return copy;
}

function loadImage(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

export function startCardStyle(ctx, prefs, editors) {
    const opts = () => ({ ...DEFAULTS, ...(prefs.get("cardStyle") || {}) });
    const changed = new Map();      // back canvas -> { backup, source, what }
    const swapped = new Map();      // face sprite -> { orig, ours, card }
    const made = new Map();         // card + ui2 texture uid -> our texture
    let raf = 0;

    const unswap = (sprite, rec) => {
        if (sprite.texture === rec.ours) sprite.texture = rec.orig;
        swapped.delete(sprite);
    };
    const unswapAll = () => { for (const [s, rec] of [...swapped]) unswap(s, rec); };

    // A pixi texture of ui2's own art for this card, recoloured. Built with
    // ui2's own texture classes (taken off the original), at its resolution.
    // The art has to agree with the state about the card's colour (a red
    // diamond, a black club); if it does not, something is misread and the
    // card is left alone rather than painted wrong.
    function fourColorTexture(orig, card) {
        const key = card + ":" + orig.uid;
        if (made.has(key)) return made.get(key);
        let tex = null;
        try {
            const src = orig.source, cv = src && src.resource;
            if (cv && hasRedInk(cv) === (card[1] === "d")) {
                const copy = snapshot(cv);
                copy.dataset.gptCard = card;   // which card this art was made for (debugging)
                if (recolor(copy, card[1])) {
                    const source = new src.constructor({ resource: copy, resolution: src.resolution });
                    tex = new orig.constructor({ source });
                }
            }
        } catch (e) { ctx.log("four-colour texture", e); tex = null; }
        made.set(key, tex);
        return tex;
    }

    const restore = (cv) => {
        const rec = changed.get(cv);
        if (!rec) return;
        const g = cv.getContext("2d");
        g.clearRect(0, 0, cv.width, cv.height);
        g.drawImage(rec.backup, 0, 0);
        changed.delete(cv);
        try { rec.source.update(); } catch (e) { /* texture gone */ }
    };
    const restoreAll = (what) => { for (const [cv, rec] of [...changed]) if (!what || rec.what === what) restore(cv); };

    // The back art, loaded once per style.
    const backArt = new Map();
    const artFor = (style) => {
        if (!backArt.has(style)) backArt.set(style, loadImage(ctx.assets.url(`assets/backs/${style}.png`)));
        return backArt.get(style);
    };
    let backStyle = "";

    // Our own <img> cards: the classic filters, by a class on the root.
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    holder.innerHTML = SUIT_FILTER_SVG;
    document.body.append(holder);
    const rootClass = () => document.documentElement.classList.toggle("gpt-fourcolor", !!opts().fourColor);
    rootClass();

    const seatCentres = () => {
        const shape = document.querySelector("#GGame [data-table-shape]");
        if (!shape) return null;
        const sb = shape.getBoundingClientRect();
        const out = {};
        for (const p of document.querySelectorAll("#GGame .iogc-PlayerPanel")) {
            const seatEl = p.closest(".iogc-PlayerPanel-portrait-container") || p;
            // The seat index rides on the badge slot our features mount in it.
            const slotEl = seatEl.querySelector("[data-gpt-seat]");
            if (!slotEl) continue;
            const r = seatEl.getBoundingClientRect();
            out[slotEl.dataset.gptSeat] = { x: r.left + r.width / 2 - sb.left, y: r.top + r.height / 2 - sb.top };
        }
        return out;
    };
    // An empty badge slot per seat, only so a seat's panel says which seat it
    // is; seat centres are then measured in pixi's coordinates (its canvas is
    // the table shape).
    const offBadge = ctx.ui.register("seat.badge", slot(ctx, (el, props) => {
        el.dataset.gptSeat = props.seat;
        return { update(p) { el.dataset.gptSeat = p.seat; } };
    }));

    const frame = () => {
        raf = requestAnimationFrame(frame);
        const app = findPixiApp();
        if (!app) return;
        const cards = readCards(app);
        const o = opts();
        // Four colours: every diamond and club the state names this frame
        // gets a recoloured copy of its own art swapped in. ui2's canvases are
        // never written; when ui2 hands the sprite a new texture (next hand,
        // a re-render) or the card changes, ours steps aside and the decision
        // is made again from scratch.
        const ids = o.fourColor ? identify(ctx, cards, seatCentres()) : new Map();
        const live = new Set();
        for (const { sprite } of cards.board.concat(cards.faces)) {
            live.add(sprite);
            let rec = swapped.get(sprite);
            if (rec && sprite.texture !== rec.ours) { swapped.delete(sprite); rec = null; }   // ui2 moved on
            const card = ids.get(sprite);
            const want = !!card && (card[1] === "d" || card[1] === "c");
            if (rec && (!want || rec.card !== card)) { unswap(sprite, rec); rec = null; }
            if (want && !rec) {
                const orig = sprite.texture;
                const ours = fourColorTexture(orig, card);
                if (ours) { sprite.texture = ours; swapped.set(sprite, { orig, ours, card }); }
            }
        }
        for (const [s, rec] of [...swapped]) if (!live.has(s) && (!s.parent || s.destroyed)) swapped.delete(s);
        // The back.
        if (o.back !== backStyle) { restoreAll("back"); backStyle = o.back; }
        if (backStyle) {
            for (const { sprite } of cards.backs) {
                const src = sprite.texture.source, cv = src && src.resource;
                if (!cv || changed.has(cv)) continue;
                changed.set(cv, { backup: snapshot(cv), source: src, what: "back" });
                artFor(backStyle).then((img) => {
                    if (!img || !changed.has(cv) || backStyle === "") return;
                    const g = cv.getContext("2d");
                    const r = cv.width * 0.12;
                    g.clearRect(0, 0, cv.width, cv.height);
                    g.save();
                    g.beginPath();
                    g.roundRect ? g.roundRect(0, 0, cv.width, cv.height, r) : g.rect(0, 0, cv.width, cv.height);
                    g.clip();
                    g.drawImage(img, 0, 0, cv.width, cv.height);
                    g.restore();
                    src.update();
                });
            }
        }
    };
    raf = requestAnimationFrame(frame);

    const offPrefs = prefs.onChange((k) => {
        if (k !== "cardStyle") return;
        rootClass();
        if (!opts().fourColor) unswapAll();
    });

    const openEditor = () => openPanel(ctx, {
        id: "cardStyle", title: "card style", width: 300,
        build(body, reg) {
            const set = (patch) => prefs.set("cardStyle", { ...opts(), ...patch });
            body.append(
                checkRow("four-colour deck", { get: () => opts().fourColor, set: (v) => set({ fourColor: v }),
                    hint: "blue diamonds and green clubs; hearts and spades stay as they are" }, reg),
                choiceRow("back", BACK_STYLES, { get: () => opts().back, set: (v) => set({ back: v }) }, reg),
                hint("Team (site) keeps the back of the team that owns the table. The four colours also " +
                    "apply to the cards in hand summaries and shared hands."),
            );
        },
    });
    const offEditor = editors ? editors.set("cardStyle", [{ label: "edit", open: openEditor }]) : () => {};

    return () => {
        cancelAnimationFrame(raf);
        offPrefs(); offEditor(); offBadge();
        restoreAll();
        unswapAll();
        holder.remove();
        document.documentElement.classList.remove("gpt-fourcolor");
    };
}

export function cardBackStyle(prefs) { return ({ ...DEFAULTS, ...(prefs.get("cardStyle") || {}) }).back; }
