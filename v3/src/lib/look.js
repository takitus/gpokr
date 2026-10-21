/* How the 3D table, its chips and its lights look: the values the classic
 * editors tuned, with the classic defaults, kept in prefs (so they follow the
 * account when the host offers account storage) and pushed to whichever
 * renderers are loaded. One object, saved whole under prefs "look".
 *
 * apply() is safe to call any time: a renderer that is not loaded yet is
 * skipped, and gets the values when it starts (table3d calls apply after
 * enable). */

export const LOOK_DEFAULTS = {
    feltColor: "#2f6360", feltZoom: 0.5, feltDepth: 0,
    leatherColor: "#1d1a16", leatherZoom: 10, leatherDepth: 0.1,
    logoOpacity: 0.2,
    bgColor: "",          // "" = ui2's own table-area colour
    backdrop: "",         // "" = no floor; grain, glow, carpet, clover, deco, wood
    seats: "",            // "" = none; stool, chair
    elev: 64,             // camera, degrees above the felt
    cards3d: true,        // board cards as slabs on the felt
    dealAnim: true,       // ...flying in and turning over as they are dealt
    seatCards3d: true,    // other players' face-down cards lying on the felt
    cardThick: 5,         // a card's thickness, CSS px (2 barely reads as 3D at ui2's size)
    chips3d: true,        // bets and pot as discs
    chipDrop: true,       // bets fall in, with a clink
    chipDiam: 26, chipThick: 4, chipRound: 0.5,
    key: { x: -6, y: 15, z: 11 },
    fill: { x: 8, y: 9, z: -6 },
    levels: { key: 1, fill: 1, ambient: 1, lamp: 1 },
};
export const BACKDROPS = ["grain", "glow", "carpet", "clover", "deco", "wood"];
export const SEAT_STYLES = ["stool", "chair"];
// The table area behind ui2's felt; "auto" background is this.
export const UI2_SURROUND = "#16303a";

const clone = (o) => JSON.parse(JSON.stringify(o));

export function createLook(prefs) {
    const look = () => {
        const saved = prefs.get("look") || {};
        const out = clone(LOOK_DEFAULTS);
        for (const k of Object.keys(out)) {
            if (saved[k] === undefined) continue;
            out[k] = typeof out[k] === "object" ? { ...out[k], ...saved[k] } : saved[k];
        }
        return out;
    };
    let cur = look();
    const subs = new Set();
    prefs.onChange((k) => { if (k === "look") { cur = look(); apply(); subs.forEach((f) => f(cur)); } });
    prefs.ready.then(() => { cur = look(); apply(); subs.forEach((f) => f(cur)); });

    // Live (no save), for a slider mid-drag.
    const live = (patch) => {
        for (const [k, v] of Object.entries(patch)) cur[k] = typeof v === "object" && v ? { ...cur[k], ...v } : v;
        apply();
        subs.forEach((f) => f(cur));
    };
    const save = (patch) => {
        live(patch);
        const saved = { ...(prefs.get("look") || {}) };
        for (const [k, v] of Object.entries(patch)) saved[k] = typeof v === "object" && v ? { ...(saved[k] || {}), ...v } : v;
        prefs.set("look", saved);
    };
    const reset = (keys) => {
        const patch = {};
        for (const k of keys) patch[k] = clone(LOOK_DEFAULTS[k]);
        save(patch);
    };

    function apply() {
        const L = cur;
        const t3d = window.GPE_TABLE3D, coin = window.GPE_COIN, chips = window.GPE_CHIPS;
        const tryCall = (f) => { try { f(); } catch (e) { /* a renderer without that knob */ } };
        if (t3d) {
            tryCall(() => t3d.setFeltColor(L.feltColor));
            tryCall(() => t3d.setLeatherColor(L.leatherColor));
            tryCall(() => t3d.setTexZoom(L.feltZoom, L.leatherZoom));
            tryCall(() => t3d.setTexDepth(L.feltDepth, L.leatherDepth));
            tryCall(() => t3d.setLogoOpacity(L.logoOpacity));
            tryCall(() => t3d.setSurroundColor(L.bgColor || UI2_SURROUND));
            tryCall(() => t3d.setBackdrop(L.backdrop));
            tryCall(() => t3d.setSeats(L.seats));
            tryCall(() => t3d.setChipRound(L.chipRound));
            if (t3d.elevation && t3d.elevation() !== L.elev) tryCall(() => t3d.setElevation(L.elev));
        }
        // The key light's position goes to every renderer, since all of them
        // throw shadows from it; the fill's position is the table's alone.
        for (const api of [coin, chips, t3d]) {
            if (!api) continue;
            if (api.setKeyLight) tryCall(() => api.setKeyLight(L.key.x, L.key.y, L.key.z));
            if (api.setLightLevels) tryCall(() => api.setLightLevels(L.levels));
        }
        if (t3d && t3d.setFillLight) tryCall(() => t3d.setFillLight(L.fill.x, L.fill.y, L.fill.z));
        if (coin && coin.setChipSize) tryCall(() => coin.setChipSize(L.chipDiam, L.chipThick));
        if (chips && chips.setChipSize) tryCall(() => chips.setChipSize(0.55 * (L.chipDiam / 26), 0.17 * (L.chipThick / 4)));
    }

    return {
        get: () => cur,
        live, save, reset, apply,
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    };
}
