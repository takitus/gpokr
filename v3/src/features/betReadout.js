/* A side panel of the money each player puts in, a row per player (it used
 * to sit on the seats, over what ui2 shows there). Two modes, switched at
 * the top of the panel (N is set in its editor):
 *   - "street": the hand in play, street by street, folds marked; it stays
 *     up after the pot is pushed until the next deal.
 *   - "hands": the classic readout, everything the player bet or raised over
 *     their last N hands at this table, calls and blinds excluded — how hard
 *     they push, at a glance.
 * The history behind "hands" is kept per table in this browser, 20 hands
 * deep per player, whichever mode is showing, so switching has data at once. */

import { slot } from "../slot.js";
import { STREETS } from "../hand.js";
import { openPanel, choiceRow, sliderRow, hint } from "../lib/panel.js";

const KEEP = 20;
const DEFAULTS = { mode: "street", window: 3 };

export function startBetReadout(ctx, tracker, prefs, editors) {
    const opts = () => ({ ...DEFAULTS, ...(prefs.get("betReadout") || {}) });
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

    /* ----- the panel ----- */
    // A side panel, not the seats: on the seats it covered what ui2 shows
    // there. One table, a row per player, in seat order.
    const h = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    };
    const cell = (text, cls) => h("td", cls, text);
    // Compact amounts for the narrow rail: $750, $1.8k, $25k, $1.2M.
    const short = (n) => {
        if (!n) return "–";
        if (n < 1000) return "$" + n;
        if (n < 1e6) return "$" + (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, "") + "k";
        return "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    };

    function streetTable() {
        const hand = tracker.get();
        const seats = hand ? Object.values(hand.seats).sort((a, b) => a.seat - b.seat) : [];
        if (!seats.length) return h("div", "gpt-empty", "Bets show up here once a hand is dealt.");
        const t = h("table", "gpt-bets-table");
        const head = h("tr");
        // The side rail is narrow: one letter per street, the name on hover.
        head.append(h("th", null, ""), ...STREETS.map((s) => { const th = h("th", null, s[0]); th.title = s; return th; }), h("th", null, "Tot"));
        t.append(head);
        for (const s of seats) {
            const tr = h("tr", [s.foldStreet >= 0 ? "folded" : "", s.isMe ? "me" : ""].join(" ").trim() || null);
            const name = cell(null, "gpt-bets-name");
            name.append(s.name);
            if (s.isButton) name.append(h("span", "gpt-btn-chip", "D"));
            tr.append(name);
            for (let st = 0; st < 4; st++) {
                if (st > hand.street || (s.foldStreet >= 0 && st > s.foldStreet)) { tr.append(cell("")); continue; }
                const c = cell(short(s.streets[st]), st === s.foldStreet ? "fold-here" : null);
                if (st === s.foldStreet) c.title = "folded";
                tr.append(c);
            }
            tr.append(cell(short(s.total), "gpt-bets-total"));
            t.append(tr);
        }
        return t;
    }

    function handsTable() {
        const gi = ctx.state.get().gameInfo;
        const n = Math.max(1, Math.min(KEEP, opts().window | 0));
        const rows = [];
        ((gi && gi.playerInfo) || []).forEach((p, seat) => {
            if (!p || !p.user) return;
            const hrows = hist[p.user.name] || [];
            const last = hrows.slice(-n);
            rows.push({ seat, name: p.user.name, total: last.reduce((a, r) => a + r.n, 0), hands: last.length, me: seat === ctx.state.get().mySeat });
        });
        if (!rows.length) return h("div", "gpt-empty", "No one is seated.");
        const t = h("table", "gpt-bets-table");
        const head = h("tr");
        head.append(h("th", null, ""), h("th", null, "Bet / raised"), h("th", null, "Hands"));
        t.append(head);
        for (const r of rows) {
            const tr = h("tr", r.me ? "me" : null);
            tr.append(cell(r.name, "gpt-bets-name"), cell(r.total ? short(r.total) : "$0", "gpt-bets-total"), cell(String(r.hands)));
            t.append(tr);
        }
        return t;
    }

    const views = new Set();
    function paintAll() {
        for (const el of views) {
            const o = opts();
            const set = (patch) => prefs.set("betReadout", { ...o, ...patch });
            const bar = h("div", "gpt-bets-modes");
            for (const [mode, label] of [["street", "This hand"], ["hands", `Last ${o.window} hands`]]) {
                const b = h("button", "gpt-chip-btn" + (o.mode === mode ? " is-on" : ""), label);
                b.type = "button";
                b.addEventListener("click", () => set({ mode }));
                bar.append(b);
            }
            el.replaceChildren(bar, o.mode === "hands" ? handsTable() : streetTable());
            if (o.mode === "hands") el.append(h("div", "gpt-panel-hint", "Everything each player bet or raised over their last hands at this table; calls and blinds not counted."));
        }
    }

    offs.push(tracker.subscribe(paintAll));
    offs.push(ctx.state.subscribe(() => { if (opts().mode === "hands") paintAll(); }));
    offs.push(prefs.onChange((k) => { if (k === "betReadout") paintAll(); }));

    offs.push(ctx.ui.register("rail.panel", slot(ctx, (el) => {
        el.classList.add("gpt-root", "gpt-bets");
        views.add(el);
        paintAll();
        return { destroy() { views.delete(el); } };
    }), { title: "Bets by street" }));

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
