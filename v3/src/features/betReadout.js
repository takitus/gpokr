/* A line on each seat about the money that player puts in. Two modes, picked
 * in its editor:
 *   - "street": the hand in play, street by street ("P $50 · F $100 ✕"); it
 *     stays up after the pot is pushed until the next deal.
 *   - "hands": the classic readout, everything the player bet or raised over
 *     their last N hands at this table, calls and blinds excluded — how hard
 *     they push, at a glance.
 * The history behind "hands" is kept per table in this browser, 20 hands
 * deep per player, whichever mode is showing, so switching has data at once. */

import { slot } from "../slot.js";
import { money } from "../lib/fmt.js";
import { openPanel, choiceRow, sliderRow, hint } from "../lib/panel.js";

const SHORT = ["P", "F", "T", "R"];
const KEEP = 20;
const DEFAULTS = { mode: "street", window: 3 };

export function startBetReadout(ctx, tracker, prefs, editors) {
    const opts = () => ({ ...DEFAULTS, ...(prefs.get("betReadout") || {}) });
    const views = new Map(); // pill -> seat
    const offs = [];

    /* ----- history: bets and raises per hand, per player, per table ----- */
    const tableId = () => { const d = ctx.state.get().tableData; return d && d.tableInfo ? d.tableInfo.id : 0; };
    const histKey = () => "betHist." + tableId();
    let hist = ctx.storage.local.get(histKey()) || {};          // name -> [{g: gameId, n: amount}]
    let histTable = tableId();
    const ensureTable = () => {
        if (tableId() === histTable) return;
        histTable = tableId();
        hist = ctx.storage.local.get(histKey()) || {};
    };
    let saveTimer = 0;
    const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => ctx.storage.local.set(histKey(), hist), 800); };

    offs.push(ctx.events.on("StartHandEvent", ({ event }) => {
        ensureTable();
        // Everyone dealt in gets a row for this hand, so a hand they only
        // called through still counts as one of their last N.
        const gi = ctx.state.get().gameInfo;
        for (const p of (gi && gi.playerInfo) || []) {
            if (!p || !p.user) continue;
            const rows = hist[p.user.name] || (hist[p.user.name] = []);
            if (!rows.length || rows[rows.length - 1].g !== event.gameId) rows.push({ g: event.gameId, n: 0 });
            if (rows.length > KEEP) rows.splice(0, rows.length - KEEP);
        }
        save();
        paintAll();
    }));
    // A bet or raise, not a blind: the first two bets of a hand are the posts.
    offs.push(ctx.events.on("BetRaiseEvent", ({ event, before }) => {
        const gi = before.gameInfo;
        if (!gi || (gi.round <= 1 && (gi.betCount || 0) < 2)) return;
        const p = gi.playerInfo && gi.playerInfo[event.seat];
        const rows = p && p.user && hist[p.user.name];
        if (!rows || !rows.length) return;
        rows[rows.length - 1].n += event.amount || 0;
        save();
        paintAll();
    }));

    /* ----- what a seat shows ----- */
    const streetText = (seat) => {
        const hand = tracker.get();
        const s = hand && hand.seats[seat];
        if (!s || !s.total) return "";
        const parts = [];
        for (let st = 0; st <= hand.street; st++) {
            if (s.foldStreet >= 0 && st > s.foldStreet) break;
            parts.push(`${SHORT[st]} ${money(s.streets[st])}`);
        }
        return parts.join(" · ") + (s.foldStreet >= 0 ? " ✕" : "");
    };
    const handsText = (seat) => {
        const gi = ctx.state.get().gameInfo;
        const p = gi && gi.playerInfo && gi.playerInfo[seat];
        const rows = p && p.user && hist[p.user.name];
        if (!rows || !rows.length) return "";
        const n = Math.max(1, Math.min(KEEP, opts().window | 0));
        const total = rows.slice(-n).reduce((a, r) => a + r.n, 0);
        return `${money(total) === "–" ? "$0" : money(total)} / ${Math.min(n, rows.length)}h`;
    };
    const paint = (pill) => {
        const seat = views.get(pill);
        const t = opts().mode === "hands" ? handsText(seat) : streetText(seat);
        pill.textContent = t;
        pill.title = opts().mode === "hands" ? "bet and raised over their last hands here (calls and blinds not counted)" : "";
        pill.hidden = !t;
    };
    function paintAll() { for (const pill of views.keys()) paint(pill); }

    offs.push(tracker.subscribe(paintAll));
    offs.push(prefs.onChange((k) => { if (k === "betReadout") paintAll(); }));

    offs.push(ctx.ui.register("seat.badge", slot(ctx, (el, props) => {
        el.classList.add("gpt-root");
        const pill = document.createElement("span");
        pill.className = "gpt-bet-readout";
        el.appendChild(pill);
        views.set(pill, props.seat);
        paint(pill);
        return {
            update(p) { views.set(pill, p.seat); paint(pill); },
            destroy() { views.delete(pill); pill.remove(); },
        };
    })));

    const openEditor = () => openPanel(ctx, {
        id: "betReadout", title: "bets by street", width: 300,
        build(body, reg) {
            const set = (patch) => prefs.set("betReadout", { ...opts(), ...patch });
            body.append(
                choiceRow("show", [["street", "this hand"], ["hands", "last N hands"]],
                    { get: () => opts().mode, set: (v) => set({ mode: v }) }, reg),
                sliderRow("N hands", {
                    min: 1, max: KEEP, step: 1, fmt: (n) => String(n),
                    get: () => opts().window, set: () => {}, save: (n) => set({ window: n }),
                }, reg),
                hint("This hand: what each player put in on each street. Last N hands: everything they " +
                    "bet or raised over their last N hands at this table, calls and blinds not counted."),
            );
        },
    });
    if (editors) offs.push(editors.set("betReadout", [{ label: "edit", open: openEditor }]));

    return () => { offs.forEach((o) => o && o()); clearTimeout(saveTimer); views.clear(); };
}
