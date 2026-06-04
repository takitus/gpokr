// Offline unit tests for odds.js — run with: node odds.test.js
"use strict";
const O = require("./odds.js");

let failures = 0;
function check(label, cond, detail) {
    if (cond) console.log("ok   " + label);
    else { failures++; console.error("FAIL " + label + (detail ? " — " + detail : "")); }
}
const ev5 = (s) => O.evaluate5(s.split(" ").map(O.cardToInt));
const ev7 = (s) => O.evaluate7(s.split(" ").map(O.cardToInt));

// ---- evaluate5 category ordering ----
const hands = {
    straightFlush: ev5("9h 8h 7h 6h 5h"),
    quads: ev5("9c 9d 9h 9s 2c"),
    fullHouse: ev5("8c 8d 8h 3s 3c"),
    flush: ev5("Ah Jh 9h 6h 3h"),
    straight: ev5("9c 8d 7h 6s 5c"),
    trips: ev5("7c 7d 7h Ks 2c"),
    twoPair: ev5("Jc Jd 4h 4s Ac"),
    pair: ev5("Tc Td 8h 5s 2c"),
    high: ev5("Ac Jd 8h 5s 2c"),
};
const order = ["straightFlush", "quads", "fullHouse", "flush", "straight", "trips", "twoPair", "pair", "high"];
for (let i = 0; i + 1 < order.length; i++) {
    check(order[i] + " > " + order[i + 1], hands[order[i]] > hands[order[i + 1]]);
}

// ---- tiebreakers ----
check("higher pair wins", ev5("Kc Kd 8h 5s 2c") > ev5("Qc Qd Ah Ks 2c"));
check("kicker decides", ev5("Tc Td Ah 5s 2c") > ev5("Th Ts Kh 5d 2d"));
check("wheel is lowest straight", ev5("Ac 2d 3h 4s 5c") < ev5("2c 3d 4h 5s 6c"));
check("wheel beats trips", ev5("Ac 2d 3h 4s 5c") > hands.trips);
check("ace-high straight", ev5("Ac Kd Qh Js Tc") > ev5("Kc Qd Jh Ts 9c"));
check("identical hands tie", ev5("Ac Kd 8h 5s 2c") === ev5("Ad Kc 8s 5h 2d"));
check("A5432 is not an ace-high flushless straight to the ace", ev5("Ac 2d 3h 4s 5c") < ev5("Ac Kd Qh Js Tc"));

// ---- evaluate7 picks best 5 ----
check("ev7 finds flush over straight", ev7("Ah Kh 9h 6h 3h 8c 7d") === ev5("Ah Kh 9h 6h 3h"));
check("ev7 finds full house in 7", ev7("8c 8d 8h 3s 3c Ad Kc") === ev5("8c 8d 8h 3s 3c"));
check("ev7 board plays (counterfeit)", ev7("2c 3d Ah Kh Qh Jh Th") === ev7("9c 9d Ah Kh Qh Jh Th"));

// ---- Monte Carlo equity sanity (5000 iters, generous tolerance) ----
function mc(hole, board, n) { return O.monteCarloEquity(hole.split(" "), board ? board.split(" ") : [], n, 5000).equity; }
const aa1 = mc("As Ah", "", 1);
check("AA vs 1 ≈ 0.85", Math.abs(aa1 - 0.852) < 0.03, "got " + aa1.toFixed(3));
const t72 = mc("7c 2d", "", 1);
check("72o vs 1 ≈ 0.35", Math.abs(t72 - 0.346) < 0.03, "got " + t72.toFixed(3));
const aa8 = mc("As Ah", "", 8);
check("AA vs 8 ≈ 0.35", Math.abs(aa8 - 0.347) < 0.03, "got " + aa8.toFixed(3));
const setFlop = mc("8s 8h", "8d 5c 2h", 2); // top set on a dry flop
check("set on flop vs 2 > 0.85", setFlop > 0.85, "got " + setFlop.toFixed(3));
const nutsRiver = mc("Ah Kh", "Qh Jh Th 2c 2d", 3); // royal flush on river
check("royal on river = 1.0", nutsRiver === 1, "got " + nutsRiver.toFixed(3));
// Busted draw on river: board plays, so we can only chop (opp also missed) — never win outright.
const dead = O.monteCarloEquity(["4c", "5c"], ["Ah", "Kh", "Qd", "Jd", "9s"], 1, 5000);
check("busted draw on river never wins outright", dead.win < 0.005, "win " + dead.win.toFixed(3));
check("busted draw equity is tie-share only (< 0.25)", dead.equity < 0.25, "got " + dead.equity.toFixed(3));

// ---- draw analysis ----
function draws(hole, board) { return O.drawInfo(hole.split(" "), board.split(" ")); }
const nutFd = draws("Ah Kh", "Qh Jh 2c"); // flush draw + gutshot (Th counts as flush)
check("AKs combo draw: 9 flush outs", nutFd.flushOuts === 9, "got " + nutFd.flushOuts);
check("AKs combo draw: 3 straight outs", nutFd.straightOuts === 3, "got " + nutFd.straightOuts);
check("AKs combo draw: 12 outs total", nutFd.outs === 12, "got " + nutFd.outs);
check("flop hitProb for 12 outs ≈ 0.45", Math.abs(nutFd.hitProb - 0.4498) < 0.01, "got " + nutFd.hitProb.toFixed(4));
const monster = draws("8s 7s", "6s 5s 2d"); // classic 15-outer
check("open-ended flush combo: 15 outs", monster.outs === 15, "got " + monster.outs);
check("open-ended: 2 straight ranks", monster.straightRanks === 2, "got " + monster.straightRanks);
const gut = draws("9c 8d", "5h 6s Kd"); // needs exactly a 7
check("gutshot: 4 outs", gut.outs === 4 && gut.straightRanks === 1, "got " + gut.outs);
const turnGut = draws("9c 8d", "5h 6s Kd 2c");
check("turn hitProb = outs/46", Math.abs(turnGut.hitProb - 4 / 46) < 1e-9, "got " + turnGut.hitProb);
const boat = draws("Ac Kd", "Ah Kh 2s"); // two pair drawing to a boat
check("two pair: 4 boat outs", boat.otherOuts === 4 && boat.outs === 4, "got " + JSON.stringify(boat));
check("made straight: no draw line", draws("9c 8d", "7h 6s 5d") === null);
check("no draw at all: null", draws("Qc Qd", "8h 3s 2d") === null);
check("preflop: null", O.drawInfo(["Ah", "Kh"], []) === null);

// ---- preflop ranking / ranged equity ----
const pAA = O.holePercentile(O.cardToInt("As"), O.cardToInt("Ah"));
const p72 = O.holePercentile(O.cardToInt("7c"), O.cardToInt("2d"));
const pAKs = O.holePercentile(O.cardToInt("Ah"), O.cardToInt("Kh"));
check("AA is the top class", pAA === 0, "got " + pAA);
check("AA < AKs < 72o percentile", pAA < pAKs && pAKs < p72, pAA + " / " + pAKs + " / " + p72);
check("72o is bottom decile", p72 > 0.9, "got " + p72.toFixed(3));
function mcr(hole, n, ranges) { return O.monteCarloEquity(hole.split(" "), [], n, 5000, ranges).equity; }
const junkVsTight = mcr("7c 2d", 1, [0.1]);
check("72o vs top-10% range well below random (<0.32)", junkVsTight < 0.32, "got " + junkVsTight.toFixed(3));
const junkVsRandom = mcr("7c 2d", 1, [1]);
check("range of 1.0 falls back to random (≈0.346)", Math.abs(junkVsRandom - 0.346) < 0.03, "got " + junkVsRandom.toFixed(3));
const aaVsTight = mcr("As Ah", 1, [0.1]);
check("AA still crushes a tight range (>0.7)", aaVsTight > 0.7, "got " + aaVsTight.toFixed(3));
check("AA vs tight < AA vs random", aaVsTight < aa1 + 0.01, aaVsTight.toFixed(3) + " vs " + aa1.toFixed(3));

// ---- pot odds / decisions ----
check("potOdds 100 into 300 pot = 0.25", O.potOdds(300, 100) === 0.25);
check("potOdds free = 0", O.potOdds(500, 0) === 0);
check("decision: check when free", O.evDecision(0.2, 0).action === "check");
check("decision: call with big edge", O.evDecision(0.5, 0.25).action === "call");
check("decision: fold when priced out", O.evDecision(0.1, 0.3).action === "fold");
check("decision: marginal near the line", O.evDecision(0.26, 0.25).action === "marginal");

// ---- speed: one full recompute must be comfortably sub-poll-interval ----
const t0 = Date.now();
O.monteCarloEquity(["As", "Kd"], ["7h", "8h", "2c"], 4, 5000);
const ms = Date.now() - t0;
check("5000 iters vs 4 opps < 700ms", ms < 700, ms + "ms");
const t1 = Date.now();
O.monteCarloEquity(["As", "Kd"], ["7h", "8h", "2c"], 4, 5000, [0.18, 0.35, 0.35, 1]);
const ms2 = Date.now() - t1;
check("5000 ranged iters vs 4 opps < 900ms", ms2 < 900, ms2 + "ms");
console.log("(timing: " + ms + "ms random, " + ms2 + "ms ranged)");

process.exit(failures ? 1 : 0);
