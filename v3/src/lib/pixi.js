/* ui2's table canvas is one pixi application: the felt, the board, every
 * seat's cards and chips. Its background is transparent, so whatever is
 * behind the canvas shows wherever pixi draws nothing. That is what lets the
 * 3D table sit under it: hide pixi's felt sprite, and ours shows through with
 * ui2's cards and chips still drawn on top.
 *
 * The application is not exported anywhere; it is found through the React
 * tree that owns the canvas. Best effort: if ui2 changes shape, nothing is
 * found and the caller leaves the 2D felt alone. */

function fiberOf(el) {
    const k = el && Object.keys(el).find((n) => n.startsWith("__reactFiber"));
    return k ? el[k] : null;
}

export function findPixiApp() {
    const cv = document.querySelector("#GGame [data-table-shape] canvas");
    let f = fiberOf(cv && cv.parentElement);
    const seen = new Set();
    let app = null;
    const look = (o, depth) => {
        if (app || !o || typeof o !== "object" || seen.has(o) || depth > 3) return;
        seen.add(o);
        if (o.stage && o.renderer && o.ticker) { app = o; return; }
        for (const k of Object.keys(o).slice(0, 40)) {
            try { look(o[k], depth + 1); } catch (e) { /* getters can throw */ }
            if (app) return;
        }
    };
    for (let i = 0; f && i < 12 && !app; i++, f = f.return) {
        look(f.memoizedProps, 0);
        for (let h = f.memoizedState, j = 0; h && j < 30 && !app; h = h.next, j++) look(h.memoizedState, 0);
        if (f.stateNode && !(f.stateNode instanceof Node)) look(f.stateNode, 0);
    }
    return app && app.renderer && app.renderer.view && app.renderer.view.canvas === cv ? app : (app || null);
}

/* The felt: the first layer of the scene, a container holding one sprite,
 * as wide as the table. */
export function findFelt(app) {
    const root = app && app.stage && app.stage.children[0];
    const layer = root && root.children && root.children[0];
    const sprite = layer && layer.children && layer.children.length === 1 ? layer.children[0] : null;
    if (!sprite || !sprite.texture) return null;
    const b = sprite.getBounds ? sprite.getBounds() : null;
    const w = app.renderer.width / (app.renderer.resolution || 1);
    return b && b.width > w * 0.6 ? sprite : null;
}
