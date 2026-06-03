/*
 * Pure poker math for GPokr Tools — no DOM, no browser APIs.
 * Loaded before content.js as a content script (exposes window.GPE_ODDS);
 * also runnable under node for unit tests (module.exports).
 *
 * Cards are 2-char strings: rank + suit, e.g. "As", "Th", "9d".
 * Ranks: 2-9, T, J, Q, K, A.  Suits: c, d, h, s.
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.GPE_ODDS = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const RANKS = "23456789TJQKA";
    const SUITS = "cdhs";

    // "As" -> 51-ish int: rank index 0..12 (2=0 .. A=12), suit 0..3
    function cardToInt(card) {
        const r = RANKS.indexOf(card[0].toUpperCase());
        const s = SUITS.indexOf(card[1].toLowerCase());
        if (r < 0 || s < 0) throw new Error("bad card: " + card);
        return r * 4 + s;
    }
    const rankOf = (c) => c >> 2;
    const suitOf = (c) => c & 3;

    // ---------- 5-card evaluator ----------
    // Returns a comparable int: category (0..8) in the high bits, then
    // five 4-bit tiebreaker ranks, most significant first.
    // Categories: 8 straight flush, 7 quads, 6 full house, 5 flush,
    //             4 straight, 3 trips, 2 two pair, 1 pair, 0 high card.
    function evaluate5(cards) {
        const ranks = cards.map(rankOf).sort((a, b) => b - a);
        const suits = cards.map(suitOf);
        const isFlush = suits.every((s) => s === suits[0]);

        // Straight: 5 distinct descending ranks, or the wheel (A5432).
        let straightHigh = -1;
        const distinct = [...new Set(ranks)];
        if (distinct.length === 5) {
            if (distinct[0] - distinct[4] === 4) straightHigh = distinct[0];
            else if (distinct[0] === 12 && distinct[1] === 3) straightHigh = 3; // A5432: high card is the 5
        }

        // Group ranks by count, order groups by (count, rank) descending.
        const counts = {};
        for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
        const groups = Object.keys(counts)
            .map(Number)
            .sort((a, b) => (counts[b] - counts[a]) || (b - a));
        const shape = groups.map((r) => counts[r]).join("");

        let cat, tie;
        if (straightHigh >= 0 && isFlush) { cat = 8; tie = [straightHigh, 0, 0, 0, 0]; }
        else if (shape === "41") { cat = 7; tie = [groups[0], groups[1], 0, 0, 0]; }
        else if (shape === "32") { cat = 6; tie = [groups[0], groups[1], 0, 0, 0]; }
        else if (isFlush) { cat = 5; tie = ranks; }
        else if (straightHigh >= 0) { cat = 4; tie = [straightHigh, 0, 0, 0, 0]; }
        else if (shape === "311") { cat = 3; tie = [groups[0], groups[1], groups[2], 0, 0]; }
        else if (shape === "221") { cat = 2; tie = [groups[0], groups[1], groups[2], 0, 0]; }
        else if (shape === "2111") { cat = 1; tie = [groups[0], groups[1], groups[2], groups[3], 0]; }
        else { cat = 0; tie = ranks; }

        let score = cat;
        for (const t of tie) score = (score << 4) | t;
        return score;
    }

    // Best 5-of-7 via all C(7,5)=21 combos.
    const COMBOS_7C5 = (() => {
        const out = [];
        for (let a = 0; a < 3; a++)
            for (let b = a + 1; b < 4; b++)
                for (let c = b + 1; c < 5; c++)
                    for (let d = c + 1; d < 6; d++)
                        for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
        return out;
    })();

    function evaluate7(cards7) {
        let best = -1;
        const hand = new Array(5);
        for (const combo of COMBOS_7C5) {
            for (let i = 0; i < 5; i++) hand[i] = cards7[combo[i]];
            const s = evaluate5(hand);
            if (s > best) best = s;
        }
        return best;
    }

    // ---------- Monte Carlo equity ----------
    // hole: my 2 cards, board: 0-5 known community cards, nOpp: active opponents.
    // Returns {win, tie, equity} — equity counts split pots fractionally.
    function monteCarloEquity(holeCards, boardCards, nOpp, iters) {
        iters = iters || 5000;
        nOpp = Math.max(1, nOpp | 0);
        const hole = holeCards.map(cardToInt);
        const board = boardCards.map(cardToInt);

        const used = new Set([...hole, ...board]);
        const baseDeck = [];
        for (let c = 0; c < 52; c++) if (!used.has(c)) baseDeck.push(c);

        const needBoard = 5 - board.length;
        const needTotal = needBoard + nOpp * 2;
        const deck = baseDeck.slice();
        const my7 = new Array(7);
        const opp7 = new Array(7);

        let win = 0, tie = 0, equity = 0;

        for (let it = 0; it < iters; it++) {
            // Partial Fisher–Yates: sample needTotal cards into deck[0..needTotal)
            for (let i = 0; i < needTotal; i++) {
                const j = i + ((Math.random() * (deck.length - i)) | 0);
                const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
            }
            // Fill the board
            for (let i = 0; i < board.length; i++) my7[i] = board[i];
            for (let i = 0; i < needBoard; i++) my7[board.length + i] = deck[i];
            for (let i = 0; i < 5; i++) opp7[i] = my7[i];
            my7[5] = hole[0]; my7[6] = hole[1];

            const myScore = evaluate7(my7);
            let beaten = false, tied = 0;
            for (let o = 0; o < nOpp; o++) {
                opp7[5] = deck[needBoard + o * 2];
                opp7[6] = deck[needBoard + o * 2 + 1];
                const s = evaluate7(opp7);
                if (s > myScore) { beaten = true; break; }
                if (s === myScore) tied++;
            }
            if (!beaten) {
                if (tied === 0) { win++; equity += 1; }
                else { tie++; equity += 1 / (tied + 1); }
            }
        }
        return { win: win / iters, tie: tie / iters, equity: equity / iters };
    }

    // ---------- decision helpers ----------
    // Fraction of the final pot you must contribute: toCall / (pot + toCall).
    function potOdds(pot, toCall) {
        if (!toCall || toCall <= 0) return 0;
        return toCall / (pot + toCall);
    }

    // Compare equity vs price. Returns {action, edge} where edge = equity - potOdds.
    function evDecision(equity, odds) {
        const edge = equity - odds;
        let action;
        if (odds === 0) action = "check";
        else if (edge > 0.05) action = "call";       // clearly +EV
        else if (edge >= -0.02) action = "marginal"; // within noise
        else action = "fold";
        return { action, edge };
    }

    return { cardToInt, evaluate5, evaluate7, monteCarloEquity, potOdds, evDecision, RANKS, SUITS };
});
