/* The cards in 3D, in the 3D table's scene:
 *   - the board: each card a real slab on the felt, lit and shadowed by the
 *     table's lamp. A card that appears while we watch is dealt: it flies in
 *     face down and turns over on its spot (the deal animation); one already
 *     there when the scene starts is simply laid down.
 *   - every other player's face-down pair, lying on the felt rather than
 *     standing up flat against it.
 * ui2's own sprite is switched off under each, and back on when we let go.
 *
 * Faces come straight from ui2's card canvases, so a 3D card is exactly the
 * card ui2 would have drawn (four colours included, when they are on). */

import { findPixiApp } from "../lib/pixi.js";
import { readCards } from "../lib/pixiCards.js";
import { cardStr } from "../lib/cards.js";

const STAGGER = 0.12;   // s between the cards of one deal (the flop)

export function startCards3d(ctx, look, backStyle) {
    const T3D = () => window.GPE_TABLE3D;
    const board = new Map();    // sprite -> { handle, uid, epoch }
    const backs = new Map();    // pair node -> { handle, sprites, epoch }
    let first = true;           // cards present at start are laid, not dealt
    let raf = 0;

    const pageRect = (cr, b) => ({ left: cr.left + b.x, top: cr.top + b.y, width: b.width, height: b.height });
    const dropBoard = (s) => { const r = board.get(s); if (!r) return; board.delete(s); try { r.handle.remove(); } catch (e) { /* scene gone */ } s.renderable = true; };
    const dropBack = (n) => { const r = backs.get(n); if (!r) return; backs.delete(n); try { r.handle.remove(); } catch (e) { /* scene gone */ } for (const s of r.sprites) s.renderable = true; };
    const dropAll = () => { for (const s of [...board.keys()]) dropBoard(s); for (const n of [...backs.keys()]) dropBack(n); };

    const frame = () => {
        raf = requestAnimationFrame(frame);
        const api = T3D();
        const L = look.get();
        if (!api || !api.isOn()) { dropAll(); return; }
        const app = findPixiApp();
        const cv = document.querySelector("#GGame [data-table-shape] canvas");
        if (!app || !cv) return;
        const cr = cv.getBoundingClientRect();
        const epoch = api.epoch();
        const cards = readCards(app);

        /* ----- the board ----- */
        const seenBoard = new Set();
        if (L.cards3d) {
            let fresh = 0;
            const gi = ctx.state.get().gameInfo || {};
            for (const { sprite, slot } of cards.board.sort((a, b) => a.slot - b.slot)) {
                seenBoard.add(sprite);
                const rect = pageRect(cr, sprite.getBounds());
                const rec = board.get(sprite);
                const face = sprite.texture.source && sprite.texture.source.resource;
                // Which card this slot holds, from the state: ui2 reuses a slot's
                // sprite (and its canvas) for the next hand, so the sprite says
                // nothing about which card it is now.
                const card = cardStr((gi.tableCards || [])[slot]) || "?" + sprite.texture.uid;
                if (rec && rec.card === card && rec.epoch === epoch && !rec.handle.isGone()) {
                    rec.handle.move(rect);
                    if (rec.handle.thickness() !== L.cardThick) rec.handle.setThickness(L.cardThick);
                    // Same card, new art (four colours switched on or off).
                    if (face && rec.face !== face && rec.handle.retexture) { rec.handle.retexture(face); rec.face = face; }
                    continue;
                }
                if (rec) dropBoard(sprite);
                if (!face) continue;
                const instant = first || !L.dealAnim || document.hidden;
                const handle = api.dealCard(rect, face, {
                    instant, delay: instant ? 0 : fresh++ * STAGGER,
                    backStyle: backStyle(), thickness: L.cardThick,
                });
                if (!handle) continue;
                sprite.renderable = false;
                board.set(sprite, { handle, card, face, epoch });
            }
        }
        for (const s of [...board.keys()]) if (!seenBoard.has(s) || !s.parent) dropBoard(s);

        /* ----- face-down pairs at the seats ----- */
        const seenPairs = new Set();
        if (L.seatCards3d) {
            const pairs = new Map();   // the node holding a seat's backs -> sprites
            for (const { sprite } of cards.backs) {
                const node = sprite.parent && sprite.parent.parent ? sprite.parent.parent : sprite.parent;
                if (!pairs.has(node)) pairs.set(node, []);
                pairs.get(node).push(sprite);
            }
            for (const [node, sprites] of pairs) {
                seenPairs.add(node);
                // The footprint of the pair as ui2 drew it.
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                for (const s of sprites) {
                    const b = s.getBounds();
                    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
                    x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
                }
                const rect = pageRect(cr, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
                const rec = backs.get(node);
                if (rec && rec.epoch === epoch && !rec.handle.isGone()) {
                    // The pair is dealt a card at a time: a card that joins
                    // after the pair was parked is hidden with it.
                    for (const s of sprites) {
                        if (!rec.sprites.includes(s)) rec.sprites.push(s);
                        s.renderable = false;
                    }
                    rec.handle.move(rect, L.cardThick);
                    continue;
                }
                if (rec) dropBack(node);
                const handle = api.parkCardBack(rect, { thickness: L.cardThick, backStyle: backStyle() });
                if (!handle) continue;
                for (const s of sprites) s.renderable = false;
                backs.set(node, { handle, sprites, epoch });
            }
        }
        for (const n of [...backs.keys()]) if (!seenPairs.has(n) || !n.parent) dropBack(n);
        first = false;
    };
    raf = requestAnimationFrame(frame);

    return () => { cancelAnimationFrame(raf); dropAll(); };
}
