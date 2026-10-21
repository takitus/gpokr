/* The chips in 3D: every chip ui2 draws on the felt (bets and the pot) is
 * parked as a real disc in the 3D table's scene, lit by its lamp and casting
 * on its felt, and ui2's flat sprite is switched off underneath it.
 *
 * Read from pixi, reconciled every frame, as the classic add-on reconciled the
 * site's chip elements: park what is there, move what moved, drop what left.
 * A stack in ui2's scene is a container of columns; a column is a run of chip
 * sprites from the bottom up (26px, all from the chip art's 104px canvases).
 *
 * The denomination of each texture is learned rather than assumed: the table
 * state lists every bet's chips (callChips) and the pot's (centerChips) in the
 * same order ui2 stacks them, so matching a stack's textures against those
 * lists names each texture once. A texture nobody has named yet is left 2D.
 *
 * A bet that grows drops in chip by chip, with a clink per landing; chips
 * swept to the pot, or pushed to the winner, simply appear where they are. */

import { findPixiApp } from "../lib/pixi.js";
import { playClink } from "../lib/sounds.js";

const DROP_GAP = 0.075;     // s between landings
const DROP_SPAN = 0.55;     // s for a whole stack, however many chips

const isChip = (n) => {
    const t = n && n.texture;
    const res = t && t.source && t.source.resource;
    return !!t && t.frame && t.frame.width === 26 && t.frame.height === 26 &&
        res && res.width === 104 && res.height === 104;
};

/* Every stack on the table, as { sprites: [{sprite, col, row}], key }. */
function readStacks(app) {
    const root = app && app.stage && app.stage.children[0];
    if (!root) return [];
    const stacks = [];
    const visit = (n, depth) => {
        if (depth > 6 || !n.children) return;
        // A stack: children are columns, each column's children each hold one chip.
        const cols = n.children.filter((c) => c.children && c.children.length &&
            c.children.every((k) => k.children && k.children.length === 1 && isChip(k.children[0])));
        if (cols.length && cols.length === n.children.length) {
            const sprites = [];
            cols.forEach((c, col) => c.children.forEach((k, row) => sprites.push({ sprite: k.children[0], col, row })));
            stacks.push({ node: n, sprites });
            return;
        }
        for (const c of n.children) visit(c, depth + 1);
    };
    root.children.forEach((layer, i) => visit(layer, 0));
    return stacks;
}

export function startChips3d(ctx, look) {
    const T3D = () => window.GPE_TABLE3D;
    const denomOf = new Map();     // texture uid -> denomination
    const parked = new Map();      // sprite -> { handle, denom, row, at, epoch }
    const amounts = new Map();     // stack position key -> amount last frame
    let raf = 0;

    // Name textures from the state's chip lists: a run of sprites as long as a
    // list, with no clash against what is already known, teaches the rest.
    const learn = (stacks) => {
        const gi = ctx.state.get().gameInfo;
        if (!gi) return;
        const lists = [];
        for (const p of gi.playerInfo || []) if (p && p.callChips && p.callChips.length) lists.push(p.callChips);
        if (gi.centerChips && gi.centerChips.length) lists.push(gi.centerChips);
        for (const sp of gi.sidePots || []) if (Array.isArray(sp) && sp.length) lists.push(sp);
        // Stacks in one layer (the pot's several piles) are tried together too.
        const runs = stacks.map((s) => s.sprites.map((x) => x.sprite.texture.uid));
        const byLayer = new Map();
        stacks.forEach((s, i) => {
            const layer = s.node.parent;
            if (!byLayer.has(layer)) byLayer.set(layer, []);
            byLayer.get(layer).push(...runs[i]);
        });
        const candidates = runs.concat([...byLayer.values()]);
        for (const run of candidates) {
            for (const list of lists) {
                if (list.length !== run.length) continue;
                const fresh = new Map();
                let ok = true;
                for (let i = 0; i < run.length && ok; i++) {
                    const known = denomOf.get(run[i]) ?? fresh.get(run[i]);
                    if (known != null && known !== list[i]) ok = false;
                    else fresh.set(run[i], list[i]);
                }
                if (ok) { for (const [u, d] of fresh) denomOf.set(u, d); break; }
            }
        }
    };

    const unpark = (sprite) => {
        const rec = parked.get(sprite);
        if (!rec) return;
        parked.delete(sprite);
        try { rec.handle.remove(); } catch (e) { /* scene already gone */ }
        sprite.renderable = true;
    };
    const unparkAll = () => { for (const s of [...parked.keys()]) unpark(s); };

    const frame = () => {
        raf = requestAnimationFrame(frame);
        const api = T3D();
        const L = look.get();
        if (!api || !api.isOn() || !L.chips3d) { unparkAll(); return; }
        const DIAM = L.chipDiam, THICK = L.chipThick;
        const app = findPixiApp();
        const cv = document.querySelector("#GGame [data-table-shape] canvas");
        if (!app || !cv) return;
        const cr = cv.getBoundingClientRect();
        const epoch = api.epoch();
        const stacks = readStacks(app);
        learn(stacks);
        const perLayer = new Map();
        for (const st of stacks) perLayer.set(st.node.parent, (perLayer.get(st.node.parent) || 0) + 1);
        const seen = new Set();
        for (const st of stacks) {
            const plan = [];
            const base = new Map();
            let amount = 0, complete = true;
            for (const x of st.sprites) {
                const denom = denomOf.get(x.sprite.texture.uid);
                if (denom == null) { complete = false; break; }
                const b = x.sprite.getBounds();
                const r = { left: cr.left + b.x, top: cr.top + b.y, width: b.width, height: b.height };
                if (x.row === 0) base.set(x.col, r);
                plan.push({ ...x, denom, own: r });
                amount += denom;
            }
            if (!complete || !plan.length) continue;   // a chip we cannot name: leave the stack 2D
            for (const p of plan) p.at = base.get(p.col) || p.own;
            // New money falls in; moved money (the pot, a payout) just appears.
            const key = Math.round(plan[0].at.left / 4) + ":" + Math.round(plan[0].at.top / 4);
            const was = amounts.get(key);
            amounts.set(key, amount);
            // The pot: the one stack worth the whole pot, or any of the piles ui2
            // splits a big pot into (a bet is always a single stack).
            const isPot = (ctx.state.get().gameInfo || {}).pot === amount || (perLayer.get(st.node.parent) || 0) > 1;
            const drops = L.chipDrop && !document.hidden && !isPot && (was == null || amount > was) && was !== amount;
            const order = plan.slice().sort((a, b) => a.row - b.row || a.col - b.col);
            const gap = Math.min(DROP_GAP, DROP_SPAN / Math.max(1, order.length));
            order.forEach((p, i) => { p.delay = drops ? i * gap : null; });

            for (const p of plan) {
                seen.add(p.sprite);
                const rec = parked.get(p.sprite);
                if (rec && rec.denom === p.denom && rec.epoch === epoch) {
                    if (rec.row !== p.row || rec.diam !== DIAM || rec.thick !== THICK ||
                            Math.abs(rec.at.left - p.at.left) > 0.5 || Math.abs(rec.at.top - p.at.top) > 0.5) {
                        rec.row = p.row; rec.at = p.at; rec.diam = DIAM; rec.thick = THICK;
                        rec.handle.move(p.at, p.row, { diameter: DIAM, thickness: THICK });
                    }
                    continue;
                }
                if (rec) unpark(p.sprite);
                const handle = api.parkChip(p.at, p.denom, {
                    row: p.row, diameter: DIAM, thickness: THICK,
                    drop: p.delay == null ? null : { delay: p.delay, onLand: () => playClink(ctx) },
                });
                if (!handle) continue;
                p.sprite.renderable = false;
                parked.set(p.sprite, { handle, denom: p.denom, row: p.row, at: p.at, epoch, diam: DIAM, thick: THICK });
            }
        }
        for (const s of [...parked.keys()]) if (!seen.has(s) || s.destroyed || !s.parent) unpark(s);
    };
    raf = requestAnimationFrame(frame);

    return () => { cancelAnimationFrame(raf); unparkAll(); };
}
