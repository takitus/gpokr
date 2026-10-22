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

/* { board: [{sprite, slot}], boardBacks: [{sprite, slot}], faces: [{sprite}],
 * backs: [{sprite}], flying: [{sprite}] } — the ones drawn now. A face may be one of ours (four
 * colours) swapped in; the shape test only looks at size, so it still counts.
 *
 * ui2 deals the board face down: a back goes into each slot (drawn at face
 * size) and turns into the face a beat later, one card at a time. Those backs
 * are the board's, in boardBacks, and never a seat's. Before that each card
 * flies out from the dealer, growing as it goes, in a node of its own: those
 * are in flying, also never a seat's. */
const isCard = (x) => isFace(x) || isBack(x);
const boards = new WeakSet();
const BOARD_MIN_H = 60;         // px: a board card is ~100 tall, a seat's back ~35
const flights = new WeakSet();  // nodes ui2 flies cards out of the dealer in
const holder = (n) => (n.parent && n.parent.parent ? n.parent.parent : n.parent);   // nodes once seen holding three cards or more

export function readCards(app) {
    const out = { board: [], boardBacks: [], faces: [], backs: [], flying: [] };
    const root = app && app.stage;
    if (!root) return out;
    const onBoard = new Set();
    // The board: 3 to 5 slots, at most one card each. Three faces make it
    // certain (a seat's pair is two), and the node is remembered: ui2 keeps it
    // from hand to hand. Before that — the first deal after a load — it is five
    // bare containers holding cards drawn at board size: the backs ui2 flies
    // out to the seats travel in a node of their own, and are seat-sized
    // (about 35px; the board's are 96).
    walk(root, (n) => {
        const kids = n.children || [];
        if (kids.length < 3 || kids.length > 5) return;
        const per = kids.map((k) => { const f = []; walk(k, (x) => { if (isCard(x)) f.push(x); }); return f; });
        if (per.some((f) => f.length > 1)) return;
        const dealt = per.filter((f) => f.length).length;
        if (!dealt) return;
        if (per.filter((f) => f.length && isFace(f[0])).length >= 3) boards.add(n);
        else if (!boards.has(n) && !(kids.length === 5 && kids.every((k) => !k.texture) &&
            per.every((f) => !f.length || f[0].getBounds().height >= BOARD_MIN_H))) return;
        per.forEach((f, slot) => {
            const c = f[0];
            if (!c) return;
            onBoard.add(c);
            if (!shown(c)) return;
            (isFace(c) ? out.board : out.boardBacks).push({ sprite: c, slot });
        });
    });
    walk(root, (n) => {
        if (!shown(n) || onBoard.has(n)) return;
        if (isFace(n)) { out.faces.push({ sprite: n }); return; }
        if (!isBack(n)) return;
        // A back grown to board size off the board is on its way there; its
        // node is the flight node from then on (it starts out seat-sized).
        const h = holder(n);
        if (n.getBounds().height >= BOARD_MIN_H) flights.add(h);
        (flights.has(h) ? out.flying : out.backs).push({ sprite: n });
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
