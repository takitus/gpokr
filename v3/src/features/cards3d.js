/* The cards in 3D, in the 3D table's scene:
 *   - the board: each card a real slab on the felt, lit and shadowed by the
 *     table's lamp. ui2 deals the board face down, a back in each slot, and
 *     turns the cards over a beat later; the 3D card follows it: it flies in
 *     face down when the back appears and turns over where it lies when the
 *     face does. A card already there when the scene starts is simply laid
 *     down.
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
    const board = new Map();    // slot -> { handle, card, face, epoch, sprites }
    const backs = new Map();    // pair node -> { handle, sprites, epoch }
    let first = true;           // cards present at start are laid, not dealt
    let raf = 0;

    const pageRect = (cr, b) => ({ left: cr.left + b.x, top: cr.top + b.y, width: b.width, height: b.height });
    const dropBoard = (k) => { const r = board.get(k); if (!r) return; board.delete(k); try { r.handle.remove(); } catch (e) { /* scene gone */ } for (const s of r.sprites) s.renderable = true; };
    const loose = new Set();    // board sprites hidden with no card of ours on them yet
    const slotRect = new Map(); // slot -> the last rect read with the card square on
    // A board slot's rect, at the face's size whether a back or a face is in it.
    // While ui2 turns a card it squeezes it edgewise, and that rect is no
    // footprint: then it is the last square one, or none yet.
    const boardRect = (cr, slot, sprite) => {
        const b = sprite.getBounds();
        if (b.width >= 0.9 * b.height * (60 / 84)) {
            const r = pageRect(cr, { x: b.x, y: b.y, width: b.width, height: b.width * (84 / 60) });
            slotRect.set(slot, r);
            return r;
        }
        return slotRect.get(slot) || null;
    };
    const dropBack = (n) => { const r = backs.get(n); if (!r) return; backs.delete(n); try { r.handle.remove(); } catch (e) { /* scene gone */ } for (const s of r.sprites) s.renderable = true; };
    const dropAll = () => { for (const s of loose) s.renderable = true; loose.clear(); for (const s of [...board.keys()]) dropBoard(s); for (const n of [...backs.keys()]) dropBack(n); };

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
        // Keyed by slot, not sprite: ui2 swaps a slot's sprite object mid-hand
        // (around the street events), and a new sprite is not a new card.
        const seenBoard = new Set();
        // Sprites hidden last frame with no 3D card over them yet (caught mid-
        // turn): shown again unless this frame covers them again.
        for (const s of loose) s.renderable = true;
        loose.clear();
        if (L.cards3d) {
            let fresh = 0;
            const gi = ctx.state.get().gameInfo || {};
            const slots = cards.board.map((c) => ({ ...c, up: true }))
                .concat(cards.boardBacks.map((c) => ({ ...c, up: false })))
                .sort((a, b) => a.slot - b.slot);
            for (const { sprite, slot, up } of slots) {
                seenBoard.add(slot);
                let rec = board.get(slot);
                if (rec && (rec.epoch !== epoch || rec.handle.isGone())) { dropBoard(slot); rec = null; }
                // Whatever ui2 has in the slot now is ours to cover, square or not.
                sprite.renderable = false;
                if (rec) rec.sprites.add(sprite); else loose.add(sprite);
                if (rec && rec.handle.thickness() !== L.cardThick) rec.handle.setThickness(L.cardThick);
                const rect = boardRect(cr, slot, sprite);
                const instant = first || !L.dealAnim || document.hidden;
                if (!up) {
                    // A back. Already ours face down: follow it. Face up: the
                    // slot was dealt again (a new hand), so start over.
                    if (rec && !rec.handle.isRevealed()) { if (rect) rec.handle.move(rect); continue; }
                    if (rec) dropBoard(slot);
                    if (!rect) continue;
                    const handle = api.dealCard(rect, null, {
                        faceDown: true, instant, delay: instant ? 0 : fresh++ * STAGGER,
                        backStyle: backStyle(), thickness: L.cardThick,
                    });
                    if (handle) board.set(slot, { handle, card: null, face: null, epoch, gameId: gi.gameId, sprites: new Set([sprite]) });
                    continue;
                }
                const face = sprite.texture.source && sprite.texture.source.resource;
                // Which card this slot holds, from the state: ui2 reuses a slot's
                // sprite (and its canvas) for the next hand, so the sprite says
                // nothing about which card it is now.
                const card = cardStr((gi.tableCards || [])[slot]) || "?" + sprite.texture.uid;
                if (rec && !rec.handle.isRevealed()) {
                    // The face-down card we dealt turns over where it lies.
                    if (face) { rec.handle.reveal(face, { instant: !L.dealAnim || document.hidden }); rec.card = card; rec.face = face; }
                    if (rect) rec.handle.move(rect);
                    continue;
                }
                // Face up already: it stays the hand's card for the rest of the
                // hand. The state's view of it is no test — around the street
                // events and the pot it reads differently for a frame, and
                // dealing again on that sent the card back to the top.
                if (rec && (rec.gameId === gi.gameId || rec.card === card)) {
                    if (rect) rec.handle.move(rect);
                    // Same card, new art (four colours switched on or off).
                    if (face && rec.face !== face && rec.handle.retexture) { rec.handle.retexture(face); rec.face = face; }
                    continue;
                }
                if (rec) dropBoard(slot);
                if (!face || !rect) continue;
                const handle = api.dealCard(rect, face, {
                    instant, delay: instant ? 0 : fresh++ * STAGGER,
                    backStyle: backStyle(), thickness: L.cardThick,
                });
                if (handle) board.set(slot, { handle, card, face, epoch, gameId: gi.gameId, sprites: new Set([sprite]) });
            }
        }
        for (const k of [...board.keys()]) if (!seenBoard.has(k)) dropBoard(k);
        // ui2's own card in flight from the dealer: ours is dealt when it lands.
        if (L.cards3d) for (const { sprite } of cards.flying) { sprite.renderable = false; loose.add(sprite); }

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
