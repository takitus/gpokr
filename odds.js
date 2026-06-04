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

    // Best score for 5, 6, or 7 cards.
    function evaluateBest(cards) {
        if (cards.length === 5) return evaluate5(cards);
        if (cards.length === 7) return evaluate7(cards);
        let best = -1; // 6 cards: best of the 6 skip-one hands
        const hand = new Array(5);
        for (let skip = 0; skip < 6; skip++) {
            let k = 0;
            for (let i = 0; i < 6; i++) if (i !== skip) hand[k++] = cards[i];
            const s = evaluate5(hand);
            if (s > best) best = s;
        }
        return best;
    }

    // Category lives above the five 4-bit tiebreakers.
    const categoryOf = (score) => score >>> 20;

    // ---------- made-hand label ----------
    const RANK_NAMES = ["two", "three", "four", "five", "six", "seven",
        "eight", "nine", "ten", "jack", "queen", "king", "ace"];
    const pluralRank = (r) => RANK_NAMES[r] + (r === 4 ? "es" : "s"); // sixes

    // English description of the best made hand for hole + board cards.
    // Preflop (2 cards) classifies directly; 5-7 cards decode the evaluator
    // score (category + packed 4-bit tiebreaker ranks).
    function handLabel(holeCards, boardCards) {
        const cards = holeCards.concat(boardCards || []).map(cardToInt);
        if (cards.length < 5) {
            const ranks = cards.map(rankOf);
            if (cards.length === 2 && ranks[0] === ranks[1]) return "pair of " + pluralRank(ranks[0]);
            return RANK_NAMES[Math.max.apply(null, ranks)] + " high";
        }
        const score = evaluateBest(cards);
        const tie = [];
        for (let i = 0; i < 5; i++) tie.push((score >>> (16 - 4 * i)) & 15);
        switch (categoryOf(score)) {
            case 8: return tie[0] === 12 ? "royal flush"
                : "straight flush, " + RANK_NAMES[tie[0]] + " high";
            case 7: return "four of a kind, " + pluralRank(tie[0]);
            case 6: return "full house, " + pluralRank(tie[0]) + " over " + pluralRank(tie[1]);
            case 5: return "flush, " + RANK_NAMES[tie[0]] + " high";
            case 4: return "straight, " + RANK_NAMES[tie[0]] + " high";
            case 3: return "three of a kind, " + pluralRank(tie[0]);
            case 2: return "two pair, " + pluralRank(tie[0]) + " and " + pluralRank(tie[1]);
            case 1: return "pair of " + pluralRank(tie[0]);
            default: return RANK_NAMES[tie[0]] + " high";
        }
    }

    // ---------- draw analysis ----------
    // On the flop/turn, count unseen cards that upgrade my hand to a straight or
    // better ("outs"), split by what they make: flush (incl. straight flush),
    // straight, or boat/quads (from a paired hand). Null when there's no draw to
    // speak of: wrong street, already straight-or-better, or zero outs.
    // hitProb is exact: 1 or 2 cards to come over the 47/46 unseen cards.
    function drawInfo(holeCards, boardCards) {
        if (boardCards.length < 3 || boardCards.length > 4) return null;
        const mine = holeCards.map(cardToInt).concat(boardCards.map(cardToInt));
        if (categoryOf(evaluateBest(mine)) >= 4) return null;
        const used = new Set(mine);
        let flushOuts = 0, straightOuts = 0, otherOuts = 0;
        const straightRanks = new Set();
        for (let c = 0; c < 52; c++) {
            if (used.has(c)) continue;
            const cat = categoryOf(evaluateBest(mine.concat(c)));
            if (cat === 5 || cat === 8) flushOuts++;
            else if (cat === 4) { straightOuts++; straightRanks.add(rankOf(c)); }
            else if (cat >= 6) otherOuts++; // two pair/trips filling up
        }
        const outs = flushOuts + straightOuts + otherOuts;
        if (!outs) return null;
        const U = 52 - mine.length; // unseen from my point of view
        const hitProb = boardCards.length === 3
            ? 1 - ((U - outs) / U) * ((U - 1 - outs) / (U - 1))
            : outs / U;
        return { outs, flushOuts, straightOuts, straightRanks: straightRanks.size, otherOuts, hitProb };
    }

    // ---------- preflop hand ranking (Chen formula) ----------
    // Heuristic strength for hole cards; only used to model opponent ranges.
    function chenScore(hiRank, loRank, suited) { // rank indices 0..12 (2=0 .. A=12)
        const pts = (r) => (r === 12 ? 10 : r === 11 ? 8 : r === 10 ? 7 : r === 9 ? 6 : (r + 2) / 2);
        let score = pts(hiRank);
        if (hiRank === loRank) return Math.max(5, score * 2);
        if (suited) score += 2;
        const gap = hiRank - loRank - 1;
        if (gap === 1) score -= 1;
        else if (gap === 2) score -= 2;
        else if (gap === 3) score -= 4;
        else if (gap >= 4) score -= 5;
        if (gap <= 1 && hiRank < 10) score += 1; // connected low cards: straight bonus
        return Math.ceil(score);
    }

    // For each of the 169 canonical hands: fraction of the 1326 combos that are
    // STRICTLY stronger (by Chen score). 0 for the top class; tie groups share
    // their start, so "pctl < range" includes a boundary class wholesale.
    const PCTL = (() => {
        const classes = [];
        for (let hi = 0; hi < 13; hi++) {
            for (let lo = 0; lo <= hi; lo++) {
                if (hi === lo) classes.push({ key: hi * 100 + lo * 2, score: chenScore(hi, lo, false), combos: 6 });
                else {
                    classes.push({ key: hi * 100 + lo * 2 + 1, score: chenScore(hi, lo, true), combos: 4 });
                    classes.push({ key: hi * 100 + lo * 2, score: chenScore(hi, lo, false), combos: 12 });
                }
            }
        }
        classes.sort((a, b) => b.score - a.score);
        const map = new Map();
        let above = 0, i = 0;
        while (i < classes.length) {
            let j = i, group = 0;
            while (j < classes.length && classes[j].score === classes[i].score) { group += classes[j].combos; j++; }
            for (let k = i; k < j; k++) map.set(classes[k].key, above / 1326);
            above += group; i = j;
        }
        return map;
    })();

    function holePercentile(c1, c2) {
        const r1 = rankOf(c1), r2 = rankOf(c2);
        const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
        const suited = hi !== lo && suitOf(c1) === suitOf(c2);
        return PCTL.get(hi * 100 + lo * 2 + (suited ? 1 : 0));
    }

    // ---------- Monte Carlo equity ----------
    // hole: my 2 cards, board: 0-5 known community cards, nOpp: active opponents.
    // oppRanges (optional): per-opponent fraction of top preflop hands they'd
    // play (1 = any two cards); modeled by rejection-sampling on Chen percentile.
    // Returns {win, tie, equity} — equity counts split pots fractionally.
    function monteCarloEquity(holeCards, boardCards, nOpp, iters, oppRanges) {
        iters = iters || 5000;
        nOpp = Math.max(1, nOpp | 0);
        const hole = holeCards.map(cardToInt);
        const board = boardCards.map(cardToInt);

        const used = new Set([...hole, ...board]);
        const baseDeck = [];
        for (let c = 0; c < 52; c++) if (!used.has(c)) baseDeck.push(c);

        // Only engage the rejection-sampling path when some range constrains.
        const ranges = oppRanges && oppRanges.some((r) => r < 1)
            ? Array.from({ length: nOpp }, (_, i) => oppRanges[i] || 1)
            : null;

        const needBoard = 5 - board.length;
        const needTotal = needBoard + nOpp * 2;
        const deck = baseDeck.slice();
        const my7 = new Array(7);
        const opp7 = new Array(7);

        let win = 0, tie = 0, equity = 0;

        for (let it = 0; it < iters; it++) {
            // Partial Fisher–Yates: sample needTotal cards into deck[0..needTotal)
            // (with ranges: board cards only, opponents are sampled below).
            const shuffleN = ranges ? needBoard : needTotal;
            for (let i = 0; i < shuffleN; i++) {
                const j = i + ((Math.random() * (deck.length - i)) | 0);
                const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
            }
            if (ranges) {
                // Rejection-sample each opponent's hole cards into their two deck
                // slots; give up after 20 tries (dead cards can starve a range).
                for (let o = 0; o < nOpp; o++) {
                    const pos = needBoard + o * 2;
                    for (let t = 0; t < 20; t++) {
                        const i1 = pos + ((Math.random() * (deck.length - pos)) | 0);
                        let i2 = pos + ((Math.random() * (deck.length - pos - 1)) | 0);
                        if (i2 >= i1) i2++;
                        if (t < 19 && holePercentile(deck[i1], deck[i2]) >= ranges[o]) continue;
                        let tmp = deck[pos]; deck[pos] = deck[i1]; deck[i1] = tmp;
                        const j2 = i2 === pos ? i1 : i2; // first swap may have moved card #2
                        tmp = deck[pos + 1]; deck[pos + 1] = deck[j2]; deck[j2] = tmp;
                        break;
                    }
                }
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

    return {
        cardToInt, evaluate5, evaluate7, evaluateBest, monteCarloEquity, handLabel,
        drawInfo, chenScore, holePercentile, potOdds, evDecision, RANKS, SUITS,
    };
});
