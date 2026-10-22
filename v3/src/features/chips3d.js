/* The chips in 3D: every chip ui2 draws on the felt (bets and the pot) is
 * parked as a real disc in the 3D table's scene, lit by its lamp and casting
 * on its felt, and ui2's flat sprite is switched off underneath it.
 *
 * Read from pixi, reconciled every frame, as the classic add-on reconciled the
 * site's chip elements: park what is there, move what moved, drop what left.
 * ui2 draws each bet (and the pot) as a group: a shadow under the chips, a
 * "$N" label, and one or more stacks; a stack is a container of columns, a
 * column a run of chip sprites from the bottom up (26px, from the chip art's
 * 104px canvases).
 *
 * The label is the authority on the amount: it is the server's number as ui2
 * prints it, so the plate shows exactly that. Chip denominations (for the
 * art) are learned per texture from the state's chip lists (callChips,
 * centerChips), and a learned value is only believed when the group's chips
 * then add up to the label. A group that does not add up stays 2D, ui2's own
 * label and all, and what was learned from it is forgotten, so a bad guess
 * never sticks.
 *
 * A bet that grows drops in chip by chip, with a clink per landing; chips
 * swept to the pot, or pushed to the winner, simply appear where they are.
 * Beside each group ui2's shadow and label are switched off (its canvas is
 * above ours, so they would lie dark on our discs) and the classic value
 * plate, the stack's silhouette and amount, takes their place. */

import { findPixiApp } from "../lib/pixi.js";
import { playClink } from "../lib/sounds.js";
import { readCards } from "../lib/pixiCards.js";

const DROP_GAP = 0.075;     // s between landings
const DROP_SPAN = 0.55;     // s for a whole stack, however many chips

const isChip = (n) => {
    const t = n && n.texture;
    const res = t && t.source && t.source.resource;
    return !!t && t.frame && t.frame.width === 26 && t.frame.height === 26 &&
        res && res.width === 104 && res.height === 104;
};

/* Every bet group on the table: { node, stacks: [{node, sprites:[{sprite,col,row}]}], label } */
function readGroups(app) {
    const root = app && app.stage && app.stage.children[0];
    if (!root) return [];
    const stacks = [];
    const visit = (n, depth) => {
        if (depth > 6 || !n.children) return;
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
    root.children.forEach((layer) => visit(layer, 0));
    const groups = new Map();
    for (const st of stacks) {
        const g = st.node.parent;
        if (!g) continue;
        if (!groups.has(g)) groups.set(g, { node: g, stacks: [], label: null });
        groups.get(g).stacks.push(st);
    }
    // The label: a sibling of the stacks holding a text node.
    for (const grp of groups.values()) {
        const stackNodes = new Set(grp.stacks.map((s) => s.node));
        for (const k of grp.node.children) {
            if (stackNodes.has(k)) continue;
            const t = (k.children || []).find((x) => typeof x.text === "string");
            if (t) { grp.label = t; break; }
        }
    }
    return [...groups.values()];
}

const parseMoney = (s) => { const n = parseInt(String(s).replace(/[^\d]/g, ""), 10); return isFinite(n) ? n : null; };

export function startChips3d(ctx, look) {
    const T3D = () => window.GPE_TABLE3D;
    const denomOf = new Map();     // texture uid -> denomination
    const parked = new Map();      // sprite -> { handle, denom, row, at, epoch, diam, thick }
    const amounts = new Map();     // group position key -> amount last frame
    const plates = new Map();      // group node -> { handle, epoch }
    const hiddenExtras = new Map(); // ui2's shadow / label node -> its group
    let raf = 0;

    const pageRect = (cr, b) => ({ left: cr.left + b.x, top: cr.top + b.y, width: b.width, height: b.height });
    const unpark = (sprite) => {
        const rec = parked.get(sprite);
        if (!rec) return;
        parked.delete(sprite);
        try { rec.handle.remove(); } catch (e) { /* scene already gone */ }
        sprite.renderable = true;
    };
    const dropPlate = (g) => { const p = plates.get(g); if (!p) return; plates.delete(g); try { p.handle.remove(); } catch (e) { /* scene gone */ } };
    const showExtras = (g) => { for (const [k, owner] of [...hiddenExtras]) if (!g || owner === g) { k.renderable = true; hiddenExtras.delete(k); } };
    const unparkAll = () => {
        for (const s of [...parked.keys()]) unpark(s);
        for (const g of [...plates.keys()]) dropPlate(g);
        showExtras(null);
    };

    // The state's chip lists that could be this group's: every bet, the pot.
    const chipLists = () => {
        const gi = ctx.state.get().gameInfo || {};
        const lists = [];
        for (const p of gi.playerInfo || []) if (p && p.callChips && p.callChips.length) lists.push(p.callChips);
        if (gi.centerChips && gi.centerChips.length) lists.push(gi.centerChips);
        for (const sp of gi.sidePots || []) if (Array.isArray(sp) && sp.length) lists.push(sp);
        return lists;
    };

    /* Name the group's textures from a state list of the same length that
     * adds up to the label, consistent with what is already known. */
    function learn(grp, label) {
        const run = [];
        for (const st of grp.stacks) for (const x of st.sprites) run.push(x.sprite.texture.uid);
        for (const list of chipLists()) {
            if (list.length !== run.length || list.reduce((a, b) => a + b, 0) !== label) continue;
            const fresh = new Map();
            let ok = true;
            for (let i = 0; i < run.length && ok; i++) {
                const known = denomOf.get(run[i]) ?? fresh.get(run[i]);
                if (known != null && known !== list[i]) ok = false;
                else fresh.set(run[i], list[i]);
            }
            if (ok) { for (const [u, d] of fresh) denomOf.set(u, d); return true; }
        }
        return false;
    }

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
        const gi = ctx.state.get().gameInfo || {};
        const groups = readGroups(app);

        // Which groups we can draw: every chip named, and the names add up.
        const good = [];
        for (const grp of groups) {
            const label = grp.label ? parseMoney(grp.label.text) : null;
            const sum = () => {
                let s = 0;
                for (const st of grp.stacks) for (const x of st.sprites) {
                    const d = denomOf.get(x.sprite.texture.uid);
                    if (d == null) return null;
                    s += d;
                }
                return s;
            };
            let total = sum();
            if (label != null && total !== label) {
                // Unnamed chips, or a guess that does not add up: forget this
                // group's textures and learn them again from the state.
                if (total != null) for (const st of grp.stacks) for (const x of st.sprites) denomOf.delete(x.sprite.texture.uid);
                if (learn(grp, label)) total = sum();
            }
            if (total == null || (label != null && total !== label)) continue;
            good.push({ ...grp, amount: label != null ? label : total });
        }

        // Plan every chip of every drawable group.
        const seen = new Set();
        const feet = new Map();
        for (const grp of good) {
            const plan = [];
            for (const st of grp.stacks) {
                const base = new Map();
                const rows = [];
                for (const x of st.sprites) {
                    const r = pageRect(cr, x.sprite.getBounds());
                    if (x.row === 0) base.set(x.col, r);
                    rows.push({ ...x, denom: denomOf.get(x.sprite.texture.uid), own: r });
                }
                for (const p of rows) p.at = base.get(p.col) || p.own;
                plan.push(...rows);
            }
            if (!plan.length) continue;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const p of plan) {
                x0 = Math.min(x0, p.at.left); y0 = Math.min(y0, p.at.top);
                x1 = Math.max(x1, p.at.left + p.at.width); y1 = Math.max(y1, p.at.top + p.at.height);
            }
            feet.set(grp.node, { left: x0, top: y0, width: x1 - x0, height: y1 - y0 });

            // New money falls in; moved money (the pot, a payout) just appears.
            const key = Math.round(x0 / 4) + ":" + Math.round(y0 / 4);
            const was = amounts.get(key);
            amounts.set(key, grp.amount);
            const isPot = gi.pot === grp.amount || grp.stacks.length > 1;
            const drops = L.chipDrop && !document.hidden && !isPot && (was == null || grp.amount > was);
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

        // ui2's shadow and label off, our plate on, for the groups we draw.
        const pad = (r, k) => ({ left: r.left - k, top: r.top - k, width: r.width + 2 * k, height: r.height + 2 * k });
        const cardRects = readCards(app).board.map(({ sprite }) => pad(pageRect(cr, sprite.getBounds()), 5));
        for (const grp of good) {
            const foot = feet.get(grp.node);
            if (!foot) continue;
            const stackNodes = new Set(grp.stacks.map((s) => s.node));
            for (const k of grp.node.children) {
                if (stackNodes.has(k) || hiddenExtras.has(k)) continue;
                hiddenExtras.set(k, grp.node);
                k.renderable = false;
            }
            if (!api.parkStackPlate) continue;
            const avoid = cardRects.concat([...feet].filter(([o]) => o !== grp.node).map(([, f]) => pad(f, 5)));
            const pl = plates.get(grp.node);
            if (pl && pl.epoch === epoch && !pl.handle.isGone()) { pl.handle.move(foot, grp.amount, DIAM, avoid); continue; }
            if (pl) dropPlate(grp.node);
            const handle = api.parkStackPlate(foot, grp.amount, { diameter: DIAM, avoid });
            if (handle) plates.set(grp.node, { handle, epoch });
        }
        for (const g of [...plates.keys()]) if (!feet.has(g)) dropPlate(g);
        for (const [k, g] of [...hiddenExtras]) if (!feet.has(g) || k.parent !== g) { k.renderable = true; hiddenExtras.delete(k); }
    };
    raf = requestAnimationFrame(frame);

    return () => { cancelAnimationFrame(raf); unparkAll(); };
}
