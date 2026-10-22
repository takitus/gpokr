/* Player stats, as ui2's bundled Takitus Tools 3.0.0 kept them (this build
 * replaces it on the web): VPIP / PFR / showdown wins on a badge on each seat,
 * counted from the hands you watched, and a "Tools" rail panel of the players
 * seen this session. Counted, stored and shown exactly as 3.0.0 does, into
 * the same document (lib/toolsDoc.js), so the app and the web keep one record.
 *
 * Per hand, per player (from the "before" state of each action):
 *   preflop (round <= 1): any voluntary call, bet or raise sets vpip; a raise
 *     (a bet into a bet) also sets pfr.
 *   after the flop: bets, raises and calls are counted.
 *   a call that costs nothing (a check, an all-in for 0) counts for nothing.
 *   showing cards at showdown sets showdown; winning a pot then sets sdWin.
 * The hand is recorded when the main pot is taken; a side pot taken after
 * that can still add a showdown win. */

import { slot } from "../slot.js";

const PREFLOP = 1;
const MAIN_POT = 0;
const DASH = "–";

const num = (o, k) => (typeof o[k] === "number" ? o[k] : null);
const gameOf = (state) => (state.gameInfo && typeof state.gameInfo === "object" ? state.gameInfo : null);
function playerAt(state, seat) {
    if (seat == null) return null;
    const gi = gameOf(state);
    const p = gi && gi.playerInfo ? gi.playerInfo[seat] : null;
    return p && p.user && typeof p.user.id === "number" ? p : null;
}

class Hand {
    constructor(gameId) { this.gameId = gameId; this.tallies = new Map(); }
    tally(userId, name) {
        let t = this.tallies.get(userId);
        if (!t) {
            t = { name, vpip: 0, pfr: 0, bets: 0, raises: 0, calls: 0, showdown: 0, sdWin: 0 };
            this.tallies.set(userId, t);
        }
        return t;
    }
}

function startTally(ctx, store) {
    const actions = new WeakMap();   // "before" state -> the acting player's numbers
    let hand = null, last = null;
    const current = (gameId) => {
        if (hand && hand.gameId != null && gameId != null && hand.gameId !== gameId) hand = null;
        return hand;
    };
    const note = ({ event, before }) => {
        const gi = gameOf(before), p = playerAt(before, num(event, "seat"));
        if (!gi || !p || !p.user) return;
        actions.set(before, {
            userId: p.user.id, name: p.user.name, callAmount: p.callAmount || 0, highBet: gi.highBet || 0,
            score: p.score || 0, round: gi.round || 0, gameId: gi.gameId != null ? gi.gameId : null,
        });
    };
    const acting = ({ before }) => {
        const a = actions.get(before), h = a ? current(a.gameId) : null;
        return a && h ? { a, t: h.tally(a.userId, a.name) } : null;
    };
    const offs = [
        ctx.events.before("CheckCallEvent", note),
        ctx.events.before("BetRaiseEvent", note),
        ctx.events.before("FoldEvent", note),
        ctx.events.on("StartHandEvent", ({ event }) => { hand = new Hand(num(event, "gameId")); last = null; }),
        ctx.events.on("FoldEvent", (e) => { acting(e); }),
        ctx.events.on("CheckCallEvent", (e) => {
            const r = acting(e);
            if (!r) return;
            if (Math.min(r.a.highBet - r.a.callAmount, r.a.score) <= 0) return;
            if (r.a.round <= PREFLOP) r.t.vpip = 1; else r.t.calls++;
        }),
        ctx.events.on("BetRaiseEvent", (e) => {
            const r = acting(e);
            if (!r) return;
            const raise = r.a.highBet !== 0;
            if (r.a.round <= PREFLOP) { r.t.vpip = 1; if (raise) r.t.pfr = 1; }
            else if (raise) r.t.raises++;
            else r.t.bets++;
        }),
        ctx.events.on("ShowCardsEvent", ({ event, before }) => {
            const h = current(gameOf(before) ? gameOf(before).gameId : null);
            const p = playerAt(before, num(event, "seat"));
            if (!h || !p || !p.user || !num(event, "rank")) return;
            h.tally(p.user.id, p.user.name).showdown = 1;
        }),
        ctx.events.on("TakesPotEvent", ({ event, before }) => {
            const h = current(gameOf(before) ? gameOf(before).gameId : null);
            const p = playerAt(before, num(event, "seat"));
            const u = p && p.user;
            if (h) {
                if (u) { const t = h.tally(u.id, u.name); if (t.showdown) t.sdWin = 1; }
                if (num(event, "type") === MAIN_POT) { store.recordHand(h.tallies); last = h; hand = null; }
            } else if (last && u) {
                const t = last.tallies.get(u.id);
                if (t && t.showdown && !t.sdWin) { t.sdWin = 1; store.addShowdownWin(u.id); }
            }
        }),
    ];
    return () => offs.forEach((o) => o && o());
}

/* "23/12/45%": VPIP / PFR (/ showdown wins), as whole percents. */
export function badgeText(stat, format) {
    const withSd = format !== "vpip-pfr";
    if (!stat || !stat.hands) return withSd ? `${DASH}/${DASH}/${DASH}` : `${DASH}/${DASH}`;
    const pct = (n) => Math.round((n / stat.hands) * 100);
    const base = `${pct(stat.vpip)}/${pct(stat.pfr)}`;
    if (!withSd) return base;
    return `${base}/${stat.showdowns ? Math.round((stat.sdWins / stat.showdowns) * 100) + "%" : DASH}`;
}
/* The badge's tooltip, the numbers in words. */
export function statTitle(name, stat, nickname, note) {
    const lines = [], who = name + " — ";
    if (stat && stat.hands) {
        const pct = (n) => Math.round((n / stat.hands) * 100) + "%";
        lines.push(`${who}${stat.hands} hand${stat.hands === 1 ? "" : "s"} observed`);
        lines.push(`plays ${pct(stat.vpip)} of hands (VPIP)`);
        lines.push(`raises ${pct(stat.pfr)} preflop (PFR)`);
        const aggr = stat.bets + stat.raises;
        if (aggr || stat.calls) lines.push(`postflop: ${aggr} bets/raises vs ${stat.calls} calls`);
        if (stat.showdowns) lines.push(`won ${stat.sdWins} of ${stat.showdowns} showdowns`);
    } else lines.push(`${who}no hands observed yet`);
    if (nickname) lines.push("🏷 " + nickname);
    if (note) lines.push("📝 " + note);
    return lines.join("\n");
}

export function startPlayerStats(ctx, store) {
    const setting = (k) => {
        const v = ctx.settings.get(k);
        if (v !== undefined) return v;
        const s = (ctx.manifest.settings || []).find((x) => x.key === k);
        return s ? s.default : undefined;
    };
    const dark = () => ctx.theme && ctx.theme.mode() === "dark";
    const offs = [startTally(ctx, store)];

    /* ----- the badge on each seat ----- */
    const badges = new Set();
    const paintBadge = (v) => {
        const u = v.props && v.props.user;
        const show = u && setting("showStats") !== false && (!v.props.isMe || setting("showMine"));
        v.el.hidden = !show;
        v.badge.hidden = !show;
        if (!show) return;
        const d = store.get();
        const stat = d.stats[u.id];
        v.badge.className = "takitusTools-badge gpt-stat-badge" + (dark() ? " is-dark" : "");
        v.badge.textContent = badgeText(stat, setting("badgeFormat"));
        v.badge.title = statTitle(u.name, stat, d.nicknames[u.id], d.notes[u.id]);
        if (!native) pin(v);
    };
    // Under the Chrome shim the slot is in the card's column, which clips
    // everything to its left, where a side-by-side seat's avatar is. So the
    // badge moves into the avatar's own box, along its top edge (inside it,
    // where the table area's clipping top edge cannot cut it off either).
    // ui2's own host places the slot itself.
    const native = !!ctx.react;
    function pin(v) {
        const seat = v.el.closest(".iogc-PlayerPanel-portrait-container");
        const box = seat && seat.querySelector(".iogc-PlayerPanelAvatar-portrait");
        if (!box || v.badge.parentElement === box) return;
        if (getComputedStyle(box).position === "static") box.style.position = "relative";
        box.append(v.badge);
    }
    const paintBadges = () => badges.forEach(paintBadge);
    // ui2 may redraw a seat's avatar box; follow it.
    const pinTimer = native ? 0 : setInterval(() => badges.forEach((v) => { if (!v.el.hidden) pin(v); }), 1000);
    offs.push(() => clearInterval(pinTimer));
    offs.push(ctx.ui.register("seat.badge", slot(ctx, (el, props) => {
        el.classList.add("gpt-stat-slot");
        const badge = document.createElement("div");
        el.append(badge);
        const v = { el, badge, props };
        badges.add(v);
        paintBadge(v);
        return { update(p) { v.props = p; paintBadge(v); }, destroy() { badges.delete(v); v.badge.remove(); } };
    })));

    /* ----- the Tools panel: players seen this session ----- */
    const panels = new Set();
    const paintPanel = (el) => {
        const d = store.get();
        const rows = store.sessionPlayers().flatMap((id) => (d.stats[id] ? [{ id, stat: d.stats[id] }] : []));
        el.textContent = "";
        const head = document.createElement("div");
        head.className = "gpt-panel-sub";
        head.textContent = "Players this session";
        el.append(head);
        if (!rows.length) {
            el.append(Object.assign(document.createElement("div"), { className: "takitusTools-panel-empty", textContent: "No hands observed yet" }));
            return;
        }
        for (const { id, stat } of rows) {
            const nick = d.nicknames[id];
            const row = document.createElement("div");
            row.className = "takitusTools-panel-row";
            row.title = statTitle(stat.name, stat, nick, d.notes[id]);
            const name = Object.assign(document.createElement("span"), { className: "takitusTools-panel-name", textContent: stat.name });
            if (nick) name.append(Object.assign(document.createElement("span"), { className: "takitusTools-panel-nickname", textContent: " " + nick }));
            row.append(
                name,
                Object.assign(document.createElement("span"), { className: "takitusTools-panel-stats", textContent: badgeText(stat, setting("badgeFormat")) }),
                Object.assign(document.createElement("span"), { className: "takitusTools-panel-hands", textContent: stat.hands + (stat.hands === 1 ? " hand" : " hands") }),
            );
            el.append(row);
        }
    };
    offs.push(ctx.ui.register("rail.panel", slot(ctx, (el) => {
        el.classList.add("gpt-root", "takitusTools-panel");
        panels.add(el);
        paintPanel(el);
        return { destroy() { panels.delete(el); } };
    }), { title: "Tools" }));

    const repaint = () => { paintBadges(); panels.forEach(paintPanel); };
    offs.push(store.subscribe(repaint));
    for (const k of ["showStats", "showMine", "badgeFormat"]) offs.push(ctx.settings.onChange(k, repaint));
    if (ctx.theme && ctx.theme.onChange) offs.push(ctx.theme.onChange(paintBadges));

    return () => { offs.forEach((o) => o && o()); badges.clear(); panels.clear(); };
}
