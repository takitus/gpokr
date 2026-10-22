/* End-of-hand summaries, in a box of their own under the game log: one panel
 * per hand, newest at the bottom, so the log can scroll freely while the last
 * summary stays in view and earlier ones are a scroll away without the log
 * text in between.
 *
 * A panel is what the classic add-on put in the log: "winner wins $x with
 * <hand>", You / Board / winner card columns (the trophy moves to You and the
 * third column becomes the runner-up when I win), and a "more" toggle opening
 * every player's cards and chips by street, with the fold and the button
 * marked. A hand is not finished when the pot is pushed: showdown cards land a
 * beat apart and players can table their cards afterwards, so a panel is
 * redrawn in place until the next deal, keeping its toggle open if it was.
 *
 * ui2 has no slot under the log (log.hand is in the design, not the host), so
 * this is the one feature that places itself in ui2's DOM. It does so with a
 * data attribute on the log's column and never touches ui2's own classes or
 * nodes beyond that, and puts everything back on teardown. */

import { STREETS } from "../hand.js";
import { cardStr } from "../lib/cards.js";
import ODDS from "../lib/odds.js";

const KEEP = 40;
const CARD_IMG = "https://img.iogc.org/GPokr/cards/";
const RANK_LABEL = { T: "10" };
const SUIT_GLYPH = { c: "♣", d: "♦", h: "♥", s: "♠" };

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

/* ---------- cards ---------- */

function textCard(s) {
    return el("span", `gpt-card-img gpt-text-card gpt-suit-${s[1]}`, (RANK_LABEL[s[0]] || s[0]) + SUIT_GLYPH[s[1]]);
}
function cardImg(c) {
    const s = cardStr(c);
    if (!s) return slotEl();
    const img = el("img", "gpt-card-img");
    img.alt = s;
    img.dataset.gpeCard = s;
    img.addEventListener("error", () => img.replaceWith(textCard(s)), { once: true });
    img.src = CARD_IMG + s + ".png";
    return img;
}
const slotEl = () => el("span", "gpt-card-img gpt-slot-card");

/* ---------- one hand ---------- */

const money = (n) => "$" + Math.round(n).toLocaleString();

function strength(cards, board) {
    try { return ODDS.evaluateBest(cards.concat(board).map(cardStr).map(ODDS.cardToInt)); }
    catch (e) { return -1; }
}

/* The best shown hand among the others, so the third column shows someone
 * else's cards instead of repeating mine; with no showdown, whoever stayed
 * in longest. */
function runnerUp(players, winnerSeat, board) {
    const others = players.filter((p) => p.seat !== winnerSeat && p.total > 0);
    if (!others.length) return null;
    const shown = others.filter((p) => p.cards);
    if (shown.length > 1 && board.length >= 3) {
        return shown.slice().sort((a, b) => strength(b.cards, board) - strength(a.cards, board))[0];
    }
    if (shown.length) return shown[0];
    const depth = (p) => (p.foldStreet < 0 ? 9 : p.foldStreet);
    return others.slice().sort((a, b) => depth(b) - depth(a))[0];
}

function detailTable(players) {
    const wrap = el("div", "gpt-sum-detail");
    const head = el("div", "gpt-sum-drow gpt-sum-dhead");
    head.append(el("span"), el("span", null, "Cards"));
    for (const t of STREETS.concat(["Total"])) head.append(el("span", "gpt-sum-dnum", t));
    wrap.append(head);
    for (const p of players) {
        const row = el("div", "gpt-sum-drow" + (p.isMe ? " is-me" : ""));
        const name = el("span", "gpt-sum-dname");
        const txt = el("span", "gpt-sum-dname-text", p.name);
        txt.title = p.name;
        name.append(txt);
        if (p.isButton) { const b = el("span", "gpt-sum-btn", "D"); b.title = "dealer button"; name.append(b); }
        const cards = el("span", "gpt-sum-dcards");
        for (let i = 0; i < 2; i++) cards.append(p.cards ? cardImg(p.cards[i]) : slotEl());
        row.append(name, cards);
        for (let st = 0; st < 4; st++) {
            const parts = [];
            if (p.streets[st] > 0) parts.push(money(p.streets[st]));
            if (p.foldStreet === st) parts.push("🏳️");
            row.append(el("span", "gpt-sum-dnum", parts.join(" ") || "·"));
        }
        row.append(el("span", "gpt-sum-dnum gpt-sum-dtot", money(p.total)));
        wrap.append(row);
    }
    return wrap;
}

function buildPanel(hand, open, onToggle) {
    const players = Object.values(hand.seats).filter((p) => p.total > 0 || p.cards);
    const me = players.find((p) => p.isMe) || null;
    const board = hand.board;

    // Pots per seat: the main pot's winner heads the panel; anyone who took a
    // side pot or a split gets a line too.
    const won = new Map();
    for (const w of hand.winners) won.set(w.seat, (won.get(w.seat) || 0) + w.amount);
    const main = hand.winners.find((w) => !w.side) || hand.winners[0] || null;
    const winner = main ? hand.seats[main.seat] || { seat: main.seat, name: main.name } : null;
    const iWon = !!(winner && me && winner.seat === me.seat);

    if (!me && !board.length && !winner) return null;

    const panel = el("div", "gpt-sum" + (hand.ended ? "" : " is-live"));
    panel.dataset.gameId = hand.gameId;

    if (winner) {
        for (const [seat, amt] of [[winner.seat, won.get(winner.seat)], ...[...won].filter(([s]) => s !== winner.seat)]) {
            const w = hand.winners.find((x) => x.seat === seat);
            panel.append(el("div", "gpt-sum-win",
                `${w.name} wins ${money(amt)}${w.handName ? " with " + w.handName : ""}`));
        }
    } else {
        panel.append(el("div", "gpt-sum-win gpt-sum-live", hand.partial ? "In play (joined mid-hand)" : `In play · ${STREETS[hand.street]}`));
    }

    const row = el("div", "gpt-sum-cardrow");
    const col = (label, cards, n) => {
        const c = el("div", "gpt-sum-col");
        const h = el("div", "gpt-sum-colhead", label);
        h.title = label;
        const g = el("div", "gpt-sum-cards");
        const count = Math.max(n, cards ? cards.length : 0);
        for (let i = 0; i < count; i++) g.append(cards && cards[i] ? cardImg(cards[i]) : slotEl());
        c.append(h, g);
        row.append(c);
    };
    if (me) col(iWon ? "🏆 You" : "You", me.cards, 2);
    col("Board", board, 5);
    if (iWon) {
        const ru = runnerUp(players, me.seat, board);
        col(ru ? "🥈 " + ru.name : "🥈", ru && ru.cards, 2);
    } else {
        col(winner ? "🏆 " + winner.name : "🏆", winner && winner.cards, 2);
    }

    let detail = null;
    if (players.length) {
        detail = detailTable(players.slice().sort((a, b) => b.total - a.total));
        detail.hidden = !open;
        const more = el("div", "gpt-sum-col gpt-sum-morecol");
        const toggle = el("button", "gpt-sum-toggle", open ? "▾" : "▸");
        toggle.type = "button";
        toggle.title = "show per-player betting";
        toggle.addEventListener("click", (e) => {
            e.preventDefault();
            detail.hidden = !detail.hidden;
            toggle.textContent = detail.hidden ? "▸" : "▾";
            onToggle(!detail.hidden);
        });
        more.append(el("div", "gpt-sum-colhead", "more"), toggle);
        row.append(more);
    }
    panel.append(row);
    if (detail) panel.append(detail);
    if (hand.gameId) {
        const a = el("a", "gpt-sum-replay", "Replay");
        a.href = `/games/${hand.gameId}`;
        a.target = "_blank";
        a.rel = "noopener";
        row.append(a);
    }
    return panel;
}

/* ---------- the box under the log ---------- */

function findLogColumn() {
    for (const p of document.querySelectorAll("#GGame .iogc-MessagesPanel .iogc-MessagePanel")) {
        if (!p.closest(".iogc-ChatPanel")) return p.parentElement;
    }
    return null;
}

export function startHandSummary(ctx, tracker) {
    const hands = [];               // copies, oldest first
    const panels = new Map();       // gameId -> element
    const open = new Set();         // gameIds with the detail expanded
    const sigs = new Map();         // gameId -> what its panel shows

    const box = el("div", "gpt-root gpt-sumbox");
    const grip = el("div", "gpt-sumbox-grip");
    grip.title = "drag to share the space between the game log and the summaries";
    const list = el("div", "gpt-sumbox-list");
    const empty = el("div", "gpt-sumbox-empty", "Hand summaries show up here as hands finish.");
    box.append(grip, list, empty);

    // The divider between the log and the box: drag it to give one more room
    // and the other less. The height is kept in this browser.
    const MIN_BOX = 90, MIN_LOG = 80;
    const setHeight = (h) => {
        const room = column ? column.clientHeight - MIN_LOG - 8 : h;
        const v = Math.round(Math.max(MIN_BOX, Math.min(room, h)));
        box.style.height = v + "px";
        return v;
    };
    const savedH = ctx.storage.local.get("sumboxHeight");
    if (typeof savedH === "number") box.style.height = savedH + "px";
    grip.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try { grip.setPointerCapture(e.pointerId); } catch (err) { /* not an active pointer */ }
        const y0 = e.clientY, h0 = box.getBoundingClientRect().height;
        let last = h0;
        box.classList.add("is-resizing");
        const move = (ev) => { last = setHeight(h0 - (ev.clientY - y0)); };
        const up = () => {
            grip.removeEventListener("pointermove", move);
            grip.removeEventListener("pointerup", up);
            grip.removeEventListener("pointercancel", up);
            box.classList.remove("is-resizing");
            ctx.storage.local.set("sumboxHeight", last);
            stick();
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up);
        grip.addEventListener("pointercancel", up);
    });

    // An expanded summary is scrolled until its bottom meets the bottom of the
    // box, so the breakdown that just opened is in view rather than below it.
    const reveal = (panel) => requestAnimationFrame(() => {
        if (!panel || !panel.isConnected) return;
        const pr = panel.getBoundingClientRect(), lr = list.getBoundingClientRect();
        if (pr.bottom > lr.bottom) list.scrollTop += pr.bottom - lr.bottom;
    });

    // Stay pinned to the newest unless the player has scrolled back.
    let pinned = true;
    list.addEventListener("scroll", () => {
        pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    });
    const stick = () => { if (pinned) list.scrollTop = list.scrollHeight; };

    const render = (hand) => {
        const sig = JSON.stringify([hand.ended, hand.street, hand.board, hand.winners, Object.values(hand.seats).map((s) => [s.cards, s.streets, s.foldStreet])]);
        if (sigs.get(hand.gameId) === sig) return;
        sigs.set(hand.gameId, sig);
        const next = buildPanel(hand, open.has(hand.gameId), (isOpen) => {
            if (isOpen) { open.add(hand.gameId); reveal(panels.get(hand.gameId)); } else open.delete(hand.gameId);
        });
        const prev = panels.get(hand.gameId);
        if (!next) { if (prev) prev.remove(); panels.delete(hand.gameId); return; }
        if (prev && prev.isConnected) prev.replaceWith(next); else list.append(next);
        panels.set(hand.gameId, next);
        empty.hidden = panels.size > 0;
        stick();
    };

    // Scrollback survives a reload: the finished hands are kept per table.
    const tableId = () => { const d = ctx.state.get().tableData; return d && d.tableInfo ? d.tableInfo.id : null; };
    const storeKey = () => (tableId() != null ? `hands.${tableId()}` : null);
    let saveTimer = 0;
    const save = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            const k = storeKey();
            if (k) ctx.storage.local.set(k, hands.filter((h) => h.ended).slice(-KEEP));
        }, 500);
    };

    const take = (hand) => {
        if (!hand || !hand.gameId) return;
        const copy = JSON.parse(JSON.stringify(hand));
        const i = hands.findIndex((h) => h.gameId === copy.gameId);
        if (i >= 0) hands[i] = copy; else hands.push(copy);
        while (hands.length > KEEP) {
            const old = hands.shift();
            const p = panels.get(old.gameId);
            if (p) p.remove();
            panels.delete(old.gameId); sigs.delete(old.gameId); open.delete(old.gameId);
        }
        render(copy);
        if (copy.ended) save();
    };

    const k = storeKey();
    const saved = k ? ctx.storage.local.get(k) : null;
    if (Array.isArray(saved)) for (const h of saved) if (h && h.gameId) take(h);

    // Keep the box under the log; React may rebuild the column. The column is
    // held to the chat column's height beside it (see style.css).
    let column = null;
    const ro = new ResizeObserver(() => size());
    const size = () => {
        if (!column) return;
        const sib = [...column.parentElement.children].find((c) => c !== column);
        const hgt = sib ? sib.offsetHeight : column.parentElement.clientHeight;
        if (hgt) column.style.setProperty("--gpt-logh", hgt + "px");
    };
    const release = () => {
        if (!column) return;
        delete column.dataset.gptLogcol;
        column.style.removeProperty("--gpt-logh");
        ro.disconnect();
    };
    const place = () => {
        const col = findLogColumn();
        if (!col) return;
        if (col !== column) {
            release();
            column = col;
            col.dataset.gptLogcol = "";
            for (const c of col.parentElement.children) if (c !== col) ro.observe(c);
            size();
        }
        if (box.parentElement !== col || box !== col.lastElementChild) { col.append(box); stick(); }
    };

    const offHand = tracker.subscribe(take);
    take(tracker.get());
    const offState = ctx.state.subscribe(place);
    const timer = setInterval(place, 1000);
    place();

    return () => {
        offHand(); offState(); clearInterval(timer); clearTimeout(saveTimer);
        box.remove();
        release();
    };
}
