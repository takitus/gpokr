/* The player's own lists (chat buttons, bet buttons, the 3D look, ...):
 * things they edit rather than switch, so they are not manifest settings.
 * Lists saved by the classic add-on are copied in by the Chrome shim, as local
 * values, the first time v3 runs.
 *
 * In this browser only. The account store under this id holds the Takitus
 * Tools document (lib/toolsDoc.js), which ui2's bundled 3.0.0 (the app) also
 * writes, rebuilding it without any key it does not know, so nothing else can
 * safely live there. */

const KEYS = ["chatButtons", "betButtons", "look", "betReadout", "playerNicks", "playerNotes"];

export function createPrefs(ctx) {
    const local = ctx.storage.local;
    const doc = {};
    for (const k of KEYS) {
        const v = local.get(k);
        if (v !== undefined) doc[k] = v;
    }
    const subs = new Set();
    return {
        // Kept for callers that wait on it; the values are read at once now.
        ready: Promise.resolve(doc),
        get: (k) => doc[k],
        async set(k, v) {
            doc[k] = v;
            local.set(k, v);
            for (const fn of subs) { try { fn(k, v); } catch (e) { ctx.log(e); } }
        },
        onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    };
}
