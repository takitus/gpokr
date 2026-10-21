/* ui2's cards in its pixi scene, and which card each texture is.
 *
 * Faces are drawn from one canvas per card (240x336, shown 60x84 at 1.2);
 * backs from one shared canvas (120x160, shown 30x40). The board is a node of
 * five slots, one card each, in deal order; every other face sits at a seat.
 *
 * A texture says nothing about which card it is, so that is learned from the
 * table state: the board's slots against gameInfo.tableCards, a seat's faces
 * (left to right) against that player's card1/card2. Learned once per
 * texture; ui2 keeps one texture per card, so the map fills up over a few
 * hands and stays right. */

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
    if (!n || depth > 8) return;
    fn(n);
    for (const c of n.children || []) walk(c, fn, depth + 1);
}

/* { board: [{sprite, slot}], faces: [{sprite}], backs: [{sprite}] } — visible
 * ones only, as drawn now. */
export function readCards(app) {
    const out = { board: [], faces: [], backs: [] };
    const root = app && app.stage;
    if (!root) return out;
    const onBoard = new Set();
    // The board: a node of 3 to 5 children, one face in each, in deal order.
    // (A seat's shown pair is two such children, so it never qualifies.)
    walk(root, (n) => {
        const kids = n.children || [];
        if (kids.length < 3 || kids.length > 5) return;
        const per = kids.map((k) => { const f = []; walk(k, (x) => { if (isFace(x)) f.push(x); }); return f; });
        if (per.some((f) => f.length !== 1)) return;
        per.forEach((f, slot) => { onBoard.add(f[0]); if (shown(f[0])) out.board.push({ sprite: f[0], slot }); });
    });
    walk(root, (n) => {
        if (!shown(n)) return;
        if (isFace(n) && !onBoard.has(n)) out.faces.push({ sprite: n });
        else if (isBack(n)) out.backs.push({ sprite: n });
    });
    return out;
}

export function createCardLearner(ctx) {
    const cardOf = new Map();   // texture uid -> "As"

    /* seatCentres: { seat: {x, y} } in pixi world coordinates. */
    function learn(cards, seatCentres) {
        const gi = ctx.state.get().gameInfo;
        if (!gi) return;
        for (const { sprite, slot } of cards.board) {
            const c = cardStr((gi.tableCards || [])[slot]);
            if (c) cardOf.set(sprite.texture.uid, c);
        }
        if (!seatCentres) return;
        // Seat faces: nearest seat, then left to right against card1, card2.
        const bySeat = new Map();
        for (const f of cards.faces) {
            const b = f.sprite.getBounds();
            const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
            let best = -1, bd = Infinity;
            for (const [seat, c] of Object.entries(seatCentres)) {
                const d = (c.x - cx) ** 2 + (c.y - cy) ** 2;
                if (d < bd) { bd = d; best = +seat; }
            }
            if (best < 0) continue;
            if (!bySeat.has(best)) bySeat.set(best, []);
            bySeat.get(best).push({ sprite: f.sprite, x: b.x });
        }
        for (const [seat, list] of bySeat) {
            const p = (gi.playerInfo || [])[seat];
            if (!p || list.length !== 2) continue;
            const c1 = cardStr(p.card1), c2 = cardStr(p.card2);
            if (!c1 || !c2) continue;
            list.sort((a, b) => a.x - b.x);
            cardOf.set(list[0].sprite.texture.uid, c1);
            cardOf.set(list[1].sprite.texture.uid, c2);
        }
    }
    return { learn, cardOf: (sprite) => cardOf.get(sprite.texture.uid) || null };
}
