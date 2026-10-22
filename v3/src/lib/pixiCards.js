/* ui2's cards in its pixi scene, and which card each one is right now.
 *
 * Faces are drawn from per-card canvases (240x336, shown 60x84 at 1.2);
 * backs from one shared canvas (120x160, shown 30x40). The board is a node of
 * five fixed slots in deal order, the ones not dealt yet empty; every other
 * face sits at a seat, a pair per player.
 *
 * Identity is read from the table state every frame and never remembered:
 * ui2 reuses sprites and canvases from hand to hand, so anything keyed on a
 * texture goes stale (that was the wrong-card bug). The board's slot k is
 * gameInfo.tableCards[k]; a seat's pair, in the order ui2 builds it, is that
 * player's card1 then card2. */

import { cardStr } from "./cards.js";

const res = (t) => t && t.source && t.source.resource;
export const isFace = (s) => {
    const t = s && s.texture, r = res(t);
    return !!(t && t.frame && t.frame.width === 60 && t.frame.height === 84 && r && r.width === 240 && r.height === 336);
};
export const isBack = (s) => {
    const t = s && s.texture, r = res(t);
    return !!(t && t.frame && t.frame.width === 30 && t.frame.height === 40 && r && r.width === 120 && r.height === 160);
};

/* Drawn at all: pixi v8 has no worldVisible, so ask every ancestor. */
const shown = (n) => { for (let p = n; p; p = p.parent) if (p.visible === false) return false; return true; };

function walk(n, fn, depth = 0) {
    if (!n || depth > 9) return;
    fn(n);
    for (const c of n.children || []) walk(c, fn, depth + 1);
}

/* { board: [{sprite, slot}], faces: [{sprite}], backs: [{sprite}] } — the
 * ones drawn now. A face may be one of ours (four colours) swapped in; the
 * shape test only looks at size, so it still counts. */
export function readCards(app) {
    const out = { board: [], faces: [], backs: [] };
    const root = app && app.stage;
    if (!root) return out;
    const onBoard = new Set();
    // The board: 3 to 5 slots, at most one face each, at least three dealt.
    // (A seat's pair is two children, so it never qualifies.)
    walk(root, (n) => {
        const kids = n.children || [];
        if (kids.length < 3 || kids.length > 5) return;
        const per = kids.map((k) => { const f = []; walk(k, (x) => { if (isFace(x)) f.push(x); }); return f; });
        if (per.some((f) => f.length > 1) || per.filter((f) => f.length).length < 3) return;
        per.forEach((f, slot) => { if (f[0]) { onBoard.add(f[0]); if (shown(f[0])) out.board.push({ sprite: f[0], slot }); } });
    });
    walk(root, (n) => {
        if (!shown(n)) return;
        if (isFace(n) && !onBoard.has(n)) out.faces.push({ sprite: n });
        else if (isBack(n)) out.backs.push({ sprite: n });
    });
    return out;
}

/* Tree order of a node, for sorting siblings-of-siblings the way ui2 built them. */
const treeKey = (n) => { const p = []; for (let x = n; x && x.parent; x = x.parent) p.unshift(x.parent.children.indexOf(x)); return p; };
const byTree = (a, b) => {
    const ka = treeKey(a), kb = treeKey(b);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return ka.length - kb.length;
};

/* sprite -> "As" for every face whose card the state names now.
 * seatCentres: { seat: {x, y} } in pixi world coordinates. */
export function identify(ctx, cards, seatCentres) {
    const out = new Map();
    const gi = ctx.state.get().gameInfo;
    if (!gi) return out;
    for (const { sprite, slot } of cards.board) {
        const c = cardStr((gi.tableCards || [])[slot]);
        if (c) out.set(sprite, c);
    }
    if (!seatCentres || !cards.faces.length) return out;
    const bySeat = new Map();
    for (const { sprite } of cards.faces) {
        const b = sprite.getBounds();
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        let best = -1, bd = Infinity;
        for (const [seat, c] of Object.entries(seatCentres)) {
            const d = (c.x - cx) ** 2 + (c.y - cy) ** 2;
            if (d < bd) { bd = d; best = +seat; }
        }
        if (best < 0) continue;
        if (!bySeat.has(best)) bySeat.set(best, []);
        bySeat.get(best).push(sprite);
    }
    for (const [seat, list] of bySeat) {
        const p = (gi.playerInfo || [])[seat];
        if (!p || list.length !== 2) continue;
        const c1 = cardStr(p.card1), c2 = cardStr(p.card2);
        if (!c1 || !c2) continue;
        list.sort(byTree);
        out.set(list[0], c1);
        out.set(list[1], c2);
    }
    return out;
}
