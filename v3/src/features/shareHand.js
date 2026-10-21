/* Share last hand: post my hole cards to the table chat once a hand is over,
 * in a form other players with the tools can verify and draw over my seat.
 *
 * The chat line is the classic add-on's, byte for byte, so classic and ui2
 * players read each other's shares while both clients are live:
 *     shows cards: A♠, 7♣ [k4a2] — Two pair, aces and sevens
 * The bracketed token binds the cards to the sender's name and the hand's
 * game id, so a copied line (another sender) or a replayed one (another hand)
 * fails and is dropped. It is a speed-bump, not cryptography: the salt ships
 * in the code. Lines in the older [gh:..] format still verify, with no hand
 * to attach them to.
 *
 * In the chat toolbar, sharing is offered two ways that take turns in one
 * slot: a "share hand" box that shares at the end of the hand in play (once),
 * and a "share last hand" button from the end of a hand until the next flop.
 * The "always share" switch shares every hand. A verified share from someone
 * else shows over their seat for a few seconds and goes into that hand's
 * summary. */

import { slot } from "../slot.js";
import { cardStr } from "../lib/cards.js";
import ODDS from "../lib/odds.js";

const HAND_MS = 6000;
const PENDING_MS = 12000;
const CARD_IMG = "https://img.iogc.org/GPokr/cards/";
const SUIT_GLYPH = { c: "♣", d: "♦", h: "♥", s: "♠" };
const SYM_SUIT = { "♣": "c", "♦": "d", "♥": "h", "♠": "s" };
const RANKS = "23456789TJQKA";

/* ---------- the token (unchanged from the classic add-on) ---------- */

export function handChecksum(body) {
    let h = 7919;
    const salt = "gpHand!";
    const combined = salt + body + salt;
    for (let i = 0; i < combined.length; i++) h = ((h << 5) + h + combined.charCodeAt(i)) >>> 0;
    return (h % 46656).toString(36).padStart(3, "0");
}

export function handToken(name, gameId, body) {
    const norm = (name || "").trim().toLowerCase();
    return handChecksum(norm + "|" + (gameId || "") + "|" + body) +
        handChecksum(body + "|" + (gameId || "") + "|" + norm).slice(0, 1);
}

const cardBody = (cards) => cards.map((c) => c.toLowerCase()).join("");
const pretty = (c) => c[0].toUpperCase() + SUIT_GLYPH[c[1].toLowerCase()];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/* cards are "As"-style strings. */
export function encodeHand(name, cards, gameId, label) {
    let msg = "shows cards: " + cards.map(pretty).join(", ") + " [" + handToken(name, gameId, cardBody(cards)) + "]";
    if (label) msg += " — " + label;
    return msg;
}

function parseCardTok(tok) {
    const m = tok.trim().match(/^([2-9tjqka])\s*([cdhs♣♦♥♠])$/i);
    if (!m) return null;
    return m[1].toUpperCase() + (SYM_SUIT[m[2]] || m[2]).toLowerCase();
}

function sanitizeLabel(s) {
    if (!s) return null;
    s = s.replace(/[[\]\r\n]/g, "").trim();
    return s ? s.slice(0, 48) : null;
}

export const SHARE_LINE = /^shows cards:\s*.+\[[0-9a-z]+\](?:\s*[—-]\s*.+)?\s*$/i;

/* {cards, gameId|null, label} or null. ids are the hands the sender could be
 * sharing: this one and the one before. */
export function decodeHand(text, sender, ids) {
    let m = text.match(/^shows cards:\s*(.+?)\s*\[([0-9a-z]+)\](?:\s*[—-]\s*(.+?))?\s*$/i);
    if (m) {
        const cards = m[1].split(",").map(parseCardTok);
        if (cards.length && cards.every(Boolean)) {
            const body = cardBody(cards);
            for (const id of ids) {
                if (id != null && handToken(sender, id, body) === m[2].toLowerCase()) {
                    return { cards, gameId: id, label: sanitizeLabel(m[3]) };
                }
            }
        }
        return null;
    }
    m = text.match(/\[gh:([2-9tjqka][cdhs](?:[2-9tjqka][cdhs])?)\.([0-9a-z]{3})\]/i);
    if (!m) return null;
    const body = m[1].toLowerCase();
    if (handChecksum(body) !== m[2].toLowerCase()) return null;
    const cards = [];
    for (let i = 0; i < body.length; i += 2) cards.push(body[i].toUpperCase() + body[i + 1]);
    return { cards, gameId: null, label: null };
}

const toCard = (s) => ({ rank: RANKS.indexOf(s[0].toUpperCase()), suit: "cdhs".indexOf(s[1].toLowerCase()) });

/* ---------- the feature ---------- */

export function startShareHand(ctx, tracker) {
    const offs = [];
    const myName = () => (ctx.state.get().user || {}).name;
    let shareNext = false;        // the one-shot box
    let sharedGameId = null;      // last hand I shared
    const views = new Set();

    // My finished hand, ready to share: cards, the hand's id and its name
    // against the board that was dealt.
    const mine = (h) => {
        const me = h && Object.values(h.seats).find((s) => s.isMe);
        if (!me || !me.cards || !h.gameId) return null;
        const cards = me.cards.map(cardStr);
        let label = null;
        try { label = cap(ODDS.handLabel(cards, h.board.map(cardStr))); } catch (e) { /* no label */ }
        return { cards, gameId: h.gameId, label };
    };
    // The hand "share last hand" would post: the one that just ended, until the
    // next hand reaches the flop.
    const lastHand = () => {
        const h = tracker.get();
        if (h && h.ended) return mine(h);
        if (h && h.street === 0) return mine(tracker.previous());
        return null;
    };

    const share = (m) => {
        if (!m || String(m.gameId) === String(sharedGameId)) return;
        ctx.actions.chat(encodeHand(myName(), m.cards, m.gameId, m.label));
        sharedGameId = m.gameId;
        paint();
    };

    // Auto-share at the end of the hand ("always share", or the one-shot box).
    offs.push(tracker.subscribe((h) => {
        if (!h || !h.ended || h !== tracker.get()) { paint(); return; }
        if (ctx.settings.get("alwaysShare") || shareNext) {
            const m = mine(h);
            if (m) { share(m); shareNext = false; }
        }
        paint();
    }));

    /* ----- toolbar control ----- */
    function paint() {
        for (const v of views) {
            const last = lastHand();
            const done = last && String(last.gameId) === String(sharedGameId);
            v.btn.hidden = !last;
            v.toggle.hidden = !!last;
            v.btn.disabled = !!done;
            v.btn.textContent = done ? "hand shared ✓" : "share last hand";
            v.box.disabled = !!ctx.settings.get("alwaysShare");
            v.box.checked = ctx.settings.get("alwaysShare") ? true : shareNext;
        }
    }
    offs.push(ctx.settings.onChange("alwaysShare", paint));

    offs.push(ctx.ui.register("chat.toolbar", slot(ctx, (el) => {
        el.classList.add("gpt-root", "gpt-share");
        const toggle = document.createElement("label");
        toggle.className = "gpt-share-toggle";
        toggle.title = "share your cards in chat when this hand ends";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.addEventListener("change", () => { shareNext = box.checked; });
        toggle.append(box, "share hand");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "gpt-chat-btn gpt-share-last";
        btn.addEventListener("click", () => share(lastHand()));
        el.append(toggle, btn);
        const v = { btn, toggle, box };
        views.add(v);
        paint();
        return { destroy: () => views.delete(v) };
    })));

    /* ----- receiving ----- */
    const shown = new Set();       // sender|gameId already drawn
    const pending = [];            // shares that arrived before we knew their hand
    const ids = () => [tracker.get(), tracker.previous()].filter(Boolean).map((h) => h.gameId);

    const accept = (sender, dec) => {
        const key = sender + "|" + (dec.gameId == null ? cardBody(dec.cards) : dec.gameId);
        if (sender === myName() || shown.has(key)) return;
        shown.add(key);
        if (shown.size > 60) shown.delete(shown.values().next().value);
        let label = dec.label;
        if (!label) {
            const h = [tracker.get(), tracker.previous()].find((x) => x && String(x.gameId) === String(dec.gameId));
            try { label = cap(ODDS.handLabel(dec.cards, h ? h.board.map(cardStr) : [])); } catch (e) { /* none */ }
        }
        showOver(sender, dec.cards, label);
        if (dec.gameId != null) tracker.reveal(dec.gameId, sender, dec.cards.map(toCard));
    };

    const retry = () => {
        const now = Date.now();
        for (let i = pending.length - 1; i >= 0; i--) {
            const p = pending[i];
            if (now - p.t > PENDING_MS) { pending.splice(i, 1); continue; }
            const dec = decodeHand(p.text, p.sender, ids());
            if (dec) { pending.splice(i, 1); accept(p.sender, dec); }
        }
    };
    offs.push(tracker.subscribe(retry));

    offs.push(ctx.events.on("ChatEvent", ({ event }) => {
        if (event.history || typeof event.message !== "string" || !event.name) return;
        const text = event.message.trim();
        const dec = decodeHand(text, event.name, ids());
        if (dec) accept(event.name, dec);
        else if (event.name !== myName() && SHARE_LINE.test(text)) {
            // Usually our view of the hand lags the sharer by a moment.
            pending.push({ sender: event.name, text, t: Date.now() });
            if (pending.length > 40) pending.shift();
        }
    }));

    /* ----- drawing over the seat ----- */
    const overlays = new Set();
    let geom = null;
    offs.push(ctx.ui.register("table.overlay", slot(ctx, (el, props) => {
        geom = { el, props };
        return { update(p) { geom.props = p; }, destroy() { geom = null; } };
    })));

    function showOver(name, cards, label) {
        if (!geom) return;
        const gi = ctx.state.get().gameInfo;
        const seat = gi && gi.playerInfo ? gi.playerInfo.findIndex((p) => p && p.user && p.user.name === name) : -1;
        const r = seat >= 0 && geom.props.seatRects ? geom.props.seatRects[seat] : null;
        if (!r) return;
        const wrap = document.createElement("div");
        wrap.className = "gpt-hand-wrap";
        wrap.style.left = r.left + r.width / 2 + "px";
        wrap.style.top = r.top + r.height / 2 + "px";
        for (const c of cards) {
            const img = document.createElement("img");
            img.className = "gpt-card-img";
            img.alt = c;
            img.dataset.gpeCard = c;   // the four-colour deck keys on this
            img.src = CARD_IMG + c + ".png";
            wrap.append(img);
        }
        if (label) {
            const cap = document.createElement("div");
            cap.className = "gpt-hand-label";
            cap.textContent = label;
            wrap.append(cap);
        }
        geom.el.append(wrap);
        overlays.add(wrap);
        requestAnimationFrame(() => wrap.classList.add("is-shown"));
        setTimeout(() => { wrap.classList.remove("is-shown"); setTimeout(() => { wrap.remove(); overlays.delete(wrap); }, 250); }, HAND_MS);
    }

    paint();
    return () => {
        offs.forEach((o) => o && o());
        for (const o of overlays) o.remove();
        views.clear();
    };
}
