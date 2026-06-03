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
console.log("(timing: " + ms + "ms)");

process.exit(failures ? 1 : 0);
