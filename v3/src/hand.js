/* One hand at a time, rebuilt from the typed events instead of the log text.
 *
 * The client keeps each player's score live as bets go in and records
 * chipsAtStart at StartHand, so chipsAtStart - score is what a player has put
 * in so far. Blinds, calls, raises and all-ins all land there the same way,
 * which is why nothing here needs to know the betting rules. A street's share
 * is the difference between the totals taken at the street boundaries (the
 * "before" snapshot of Flop/Turn/River) and at the first TakesPot.
 *
 * Subscribers get the hand after every change; a hand stays "ended" until the
 * next StartHand, so late ShowCards (players mucking or showing after the pot
 * is awarded) still land in the summary. */

import { cardStr } from "./lib/cards.js";
import ODDS from "./lib/odds.js";

export const STREETS = ["Pre", "Flop", "Turn", "River"];
const STREET_OF = { FlopEvent: 1, TurnEvent: 2, RiverEvent: 3 };

function committed(gameInfo) {
    const out = {};
    const ps = (gameInfo && gameInfo.playerInfo) || [];
    ps.forEach((p, seat) => {
        if (p && typeof p.chipsAtStart === "number" && typeof p.score === "number") out[seat] = p.chipsAtStart - p.score;
    });
    return out;
}

function newHand(state, ev) {
    const gi = state.gameInfo || {};
    const seats = {};
    (gi.playerInfo || []).forEach((p, seat) => {
        if (!p || !p.user) return;
        seats[seat] = {
            seat,
            name: p.user.name,
            userId: p.user.id,
            chipsAtStart: p.chipsAtStart,
            streets: [0, 0, 0, 0],
            total: 0,
            foldStreet: -1,
            cards: null,
            isButton: seat === ev.dealer,
            isMe: seat === state.mySeat,
        };
    });
    return {
        gameId: ev.gameId,
        dealer: ev.dealer,
        smallBlind: ev.smallblind,
        bigBlind: ev.bigblind,
        seats,
        board: [],
        street: 0,
        marks: [{}], // committed totals at the start of each street
        winners: [],
        ended: false,
        endedAt: 0,
    };
}

export function createHandTracker(ctx) {
    let hand = null;
    let prev = null; // the hand before, for cards revealed after the next deal
    const subs = new Set();
    const offs = [];
    const notify = (h = hand) => { for (const fn of subs) { try { fn(h); } catch (e) { ctx.log("hand subscriber", e); } } };

    // Per-street amounts from the street marks plus the live totals.
    const recompute = (live) => {
        if (!hand) return;
        for (const s of Object.values(hand.seats)) {
            const tot = live[s.seat];
            if (typeof tot !== "number") continue;
            for (let st = 0; st < 4; st++) {
                const from = (hand.marks[st] && hand.marks[st][s.seat]) || 0;
                const to = st + 1 < hand.marks.length ? hand.marks[st + 1][s.seat] || 0 : tot;
                s.streets[st] = st <= hand.street ? Math.max(0, to - from) : 0;
            }
            s.total = tot;
        }
    };

    const syncBoard = (gi) => {
        if (!hand || !gi) return;
        hand.board = (gi.tableCards || []).filter(Boolean).map((c) => ({ rank: c.rank, suit: c.suit }));
    };

    offs.push(ctx.events.on("StartHandEvent", ({ event }) => {
        prev = hand;
        hand = newHand(ctx.state.get(), event);
        recompute(committed(ctx.state.get().gameInfo));
        notify();
    }));

    for (const [type, st] of Object.entries(STREET_OF)) {
        offs.push(ctx.events.before(type, ({ before }) => {
            if (!hand || hand.ended) return;
            const live = committed(before.gameInfo);
            while (hand.marks.length <= st) hand.marks.push(live);
            hand.street = st;
        }));
        offs.push(ctx.events.on(type, () => {
            if (!hand) return;
            syncBoard(ctx.state.get().gameInfo);
            recompute(committed(ctx.state.get().gameInfo));
            notify();
        }));
    }

    for (const type of ["BetRaiseEvent", "CheckCallEvent"]) {
        offs.push(ctx.events.on(type, () => {
            if (!hand || hand.ended) return;
            recompute(committed(ctx.state.get().gameInfo));
            notify();
        }));
    }

    offs.push(ctx.events.on("FoldEvent", ({ event }) => {
        const s = hand && hand.seats[event.seat];
        if (s && s.foldStreet < 0) { s.foldStreet = hand.street; notify(); }
    }));

    // My own cards, and anyone's that are tabled.
    const takeCards = (seat, c1, c2) => {
        const s = hand && hand.seats[seat];
        if (!s || !c1 || !c2) return;
        s.cards = [{ rank: c1.rank, suit: c1.suit }, { rank: c2.rank, suit: c2.suit }];
        if (hand.ended) labelWinners(hand);
        notify();
    };
    offs.push(ctx.events.on("ShowCardsEvent", ({ event }) => takeCards(event.seat, event.card1, event.card2)));
    offs.push(ctx.events.on("PocketCardsEvent", ({ event }) => {
        const p = ctx.state.get().gameInfo && ctx.state.get().gameInfo.playerInfo[event.seat];
        if (p) takeCards(event.seat, p.card1, p.card2);
    }));

    // The first TakesPot freezes what everyone put in; later ones (side pots)
    // only add winners. An uncalled bet comes back to its owner, so nobody is
    // shown as having put in more than the next-deepest player could match.
    offs.push(ctx.events.before("TakesPotEvent", ({ before }) => {
        if (!hand || hand.ended) return;
        syncBoard(before.gameInfo);
        const live = committed(before.gameInfo);
        const totals = Object.values(live).sort((a, b) => b - a);
        const cap = totals.length > 1 ? totals[1] : totals[0] || 0;
        // The excess was bet on the last street, so capping the live total is
        // enough: recompute takes it off that street.
        for (const seat of Object.keys(live)) if (live[seat] > cap) live[seat] = cap;
        recompute(live);
        hand.ended = true;
        hand.endedAt = Date.now();
    }));
    offs.push(ctx.events.on("TakesPotEvent", ({ event }) => {
        if (!hand) return;
        const s = hand.seats[event.seat];
        hand.winners.push({ seat: event.seat, name: s ? s.name : "?", amount: event.amount, side: event.type !== 0 });
        labelWinners(hand);
        notify();
    }));

    function labelWinners(h) {
        for (const w of h.winners) {
            const s = h.seats[w.seat];
            w.handName = null;
            if (s && s.cards && h.board.length >= 3) {
                try { w.handName = ODDS.handLabel(s.cards.map(cardStr), h.board.map(cardStr)); } catch (e) { /* bad card */ }
            }
        }
    }

    /* Cards a player revealed some other way (a shared hand), for this hand or
     * the one before. Never overrides cards the table itself showed. */
    function reveal(gameId, name, cards) {
        const h = [hand, prev].find((x) => x && String(x.gameId) === String(gameId));
        const s = h && Object.values(h.seats).find((x) => x.name === name);
        if (!s || s.cards || !cards || cards.length !== 2) return false;
        s.cards = cards.map((c) => ({ rank: c.rank, suit: c.suit }));
        s.shared = true;
        if (h.ended) labelWinners(h);
        notify(h);
        return true;
    }

    // Joining mid-hand: start from the table's current state so the readout
    // is not blank until the next deal. Street splits before now are unknown.
    const gi = ctx.state.get().gameInfo;
    if (gi && gi.gameId && gi.state !== 0) {
        hand = newHand(ctx.state.get(), { gameId: gi.gameId, dealer: gi.start, smallblind: gi.smallBlind, bigblind: gi.bigBlind });
        hand.partial = true;
        syncBoard(gi);
        hand.street = Math.max(0, Math.min(3, hand.board.length ? hand.board.length - 2 : 0));
        while (hand.marks.length <= hand.street) hand.marks.push(committed(gi));
        recompute(committed(gi));
    }

    return {
        get: () => hand,
        previous: () => prev,
        reveal,
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
        dispose() { offs.forEach((o) => o && o()); subs.clear(); },
    };
}
