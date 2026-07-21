#!/usr/bin/env python3
"""
Test whether GPokr's deal depends on the past (prior betting / chip stack).

Input: gpokr-research.csv exported from the extension's "study" tab. Each row is
ONE hand you were dealt into, with the quality of the cards you were given and
your actions / chip state at the deal. Lags are reconstructed here, so you can
re-test any window without re-collecting.

Response variables (higher = better cards; under a FAIR deal both are independent
of anything in the past):
  holeStrength : preflop starting-hand strength, 0..1
  boardFit     : your made hand's percentile vs ALL holdings on the board that
                 came, 0..1 -> "given what was dealt afterwards, how good were the
                 cards I was given?"  This is the key metric. Under fairness it is
                 uniform[0,1] no matter what you did before.

Predictors (deal-time state / recent history):
  priorAggr_k  : your bet+raise total over the previous k hands at the same table
  stack        : your chips at the deal
  stackRank    : your chip rank at the table (1 = most)

Primary pre-registered test: Spearman rho between priorAggr_5 and boardFit, with a
permutation p-value. Everything else is exploratory (Benjamini-Hochberg corrected).

Cross-player test (JSON export only): within each showdown, do players who bet
more in PRIOR hands also tend to have the better cards for that board? Pooled
concordance across within-hand pairs; fair deal -> 50%. Shown hands are
selection-biased (winners show, losers muck) -> treat as weaker evidence.

Usage:  python3 rng_test.py gpokr-research.json    # full, incl. cross-player
        python3 rng_test.py gpokr-research.csv     # per-hand tests only
Deps:   pip install pandas numpy scipy matplotlib
"""
import sys
import json
import numpy as np
import pandas as pd
from scipy import stats

PRIMARY_LAG = 5
LAGS = [1, 3, 5, 10]
MIN_N = 200  # below this, treat results as underpowered


def load(path):
    """Returns (per-hand DataFrame, raw records list or None)."""
    records = None
    if path.lower().endswith(".json"):
        with open(path) as f:
            records = json.load(f)
        flat = []
        for r in records:
            bs = r.get("byStreet") or [0, 0, 0, 0]
            flat.append(dict(
                t=r.get("t"), table=r.get("table"), gameId=r.get("gameId"),
                hole=" ".join(r.get("hole") or []), holeStrength=r.get("holeStrength"),
                boardLen=r.get("boardLen"), board=" ".join(r.get("board") or []),
                boardFit=r.get("boardFit"), madeCat=r.get("madeCat"),
                myBet=r.get("myBet"), myRaise=r.get("myRaise"), myActs=r.get("myActs"),
                bet_pf=bs[0], bet_flop=bs[1], bet_turn=bs[2], bet_river=bs[3],
                stack=r.get("stack"), stackRank=r.get("stackRank"),
                vpip=r.get("vpip"), pfr=r.get("pfr"),
                sawShowdown=r.get("sawShowdown"), won=r.get("won"),
            ))
        df = pd.DataFrame(flat)
    else:
        df = pd.read_csv(path)
    # stable order: by table then time, so lags are within a table session
    df = df.sort_values(["table", "t"]).reset_index(drop=True)
    return df, records


def cross_player(records):
    """Pooled within-showdown concordance of (prior aggression, boardFit)."""
    conc = disc = hands = 0
    for r in (records or []):
        sd = r.get("showdown")
        if not isinstance(sd, list):
            continue
        parts = [p for p in sd if p.get("boardFit") is not None and p.get("priorAggr") is not None]
        if len(parts) < 2:
            continue
        hands += 1
        for i in range(len(parts)):
            for j in range(i + 1, len(parts)):
                a, b = parts[i], parts[j]
                if a["priorAggr"] == b["priorAggr"] or a["boardFit"] == b["boardFit"]:
                    continue
                if (a["priorAggr"] > b["priorAggr"]) == (a["boardFit"] > b["boardFit"]):
                    conc += 1
                else:
                    disc += 1
    pairs = conc + disc
    if not pairs:
        return None
    # two-sided binomial exact test vs 0.5
    p = stats.binomtest(conc, pairs, 0.5).pvalue
    return dict(hands=hands, pairs=pairs, frac=conc / pairs, p=p)


def add_prior_features(df):
    """Prior bet+raise totals over the previous k hands, per table (no leakage:
    strictly hands BEFORE the current one)."""
    df["aggr"] = df["myBet"].fillna(0) + df["myRaise"].fillna(0)
    for k in LAGS:
        vals = np.full(len(df), np.nan)
        for _, idx in df.groupby("table").groups.items():
            idx = list(idx)
            a = df.loc[idx, "aggr"].to_numpy()
            for i in range(len(idx)):
                if i >= 1:
                    vals[idx[i]] = a[max(0, i - k):i].sum()
        df[f"priorAggr_{k}"] = vals
    df["priorHands"] = df.groupby("table").cumcount()
    return df


def spearman_perm(x, y, iters=10000, seed=0):
    m = np.isfinite(x) & np.isfinite(y)
    x, y = x[m], y[m]
    n = len(x)
    if n < 10:
        return dict(n=n, rho=np.nan, p=np.nan)
    rho = stats.spearmanr(x, y).correlation
    rng = np.random.default_rng(seed)
    ry = stats.rankdata(y)
    rx = stats.rankdata(x)
    obs = abs(np.corrcoef(rx, ry)[0, 1])
    ge = 0
    for _ in range(iters):
        p = rng.permutation(ry)
        if abs(np.corrcoef(rx, p)[0, 1]) >= obs - 1e-12:
            ge += 1
    return dict(n=n, rho=rho, p=(ge + 1) / (iters + 1))


def spearman_simple(x, y):
    m = np.isfinite(x) & np.isfinite(y)
    if m.sum() < 10:
        return dict(n=int(m.sum()), rho=np.nan, p=np.nan)
    r = stats.spearmanr(x[m], y[m])
    return dict(n=int(m.sum()), rho=r.correlation, p=r.pvalue)


def bh(pvals):
    """Benjamini-Hochberg adjusted p-values."""
    p = np.asarray(pvals, float)
    ok = np.isfinite(p)
    out = np.full_like(p, np.nan)
    idx = np.where(ok)[0]
    ps = p[idx]
    order = np.argsort(ps)
    m = len(ps)
    adj = np.empty(m)
    prev = 1.0
    for rank in range(m - 1, -1, -1):
        val = ps[order[rank]] * m / (rank + 1)
        prev = min(prev, val)
        adj[order[rank]] = prev
    out[idx] = adj
    return out


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    df, records = load(sys.argv[1])
    df = add_prior_features(df)
    n = len(df)
    print(f"\n=== GPokr deal-fairness report ===")
    print(f"hands: {n}   with a board: {df['boardFit'].notna().sum()}   "
          f"tables: {df['table'].nunique()}")
    if n < MIN_N:
        print(f"\n!! Only {n} hands — underpowered. Aim for several hundred+ before trusting anything.\n")

    responses = ["holeStrength", "boardFit"]
    predictors = [f"priorAggr_{k}" for k in LAGS] + ["stack", "stackRank"]

    # ---- PRIMARY (pre-registered): does prior betting predict good cards? -----
    # Two forms. prior -> holeStrength is the MOST DIRECT test of the hypothesis
    # (raw quality of the cards you're dealt, fully observed, no selection bias).
    prim_hole = spearman_perm(df[f"priorAggr_{PRIMARY_LAG}"].to_numpy(float),
                              df["holeStrength"].to_numpy(float))
    prim = spearman_perm(df[f"priorAggr_{PRIMARY_LAG}"].to_numpy(float),
                         df["boardFit"].to_numpy(float))
    print("\n-- PRIMARY: does prior betting predict being dealt good cards? (permutation) --")
    print(f"   priorAggr_{PRIMARY_LAG} -> dealt cards (holeStrength):  "
          f"n={prim_hole['n']}  rho={prim_hole['rho']:+.4f}  p={prim_hole['p']:.4f}"
          + ("   <-- flag" if np.isfinite(prim_hole['p']) and prim_hole['p'] < 0.01 else ""))
    print(f"   priorAggr_{PRIMARY_LAG} -> board fit (boardFit):        "
          f"n={prim['n']}  rho={prim['rho']:+.4f}  p={prim['p']:.4f}"
          + ("   <-- flag" if np.isfinite(prim['p']) and prim['p'] < 0.01 else ""))

    # ---- EXPLORATORY grid (BH-corrected) -------------------------------------
    print("\n-- EXPLORATORY: Spearman rho (BH-corrected p) --")
    cells, labels = [], []
    for resp in responses:
        for pred in predictors:
            r = spearman_simple(df[pred].to_numpy(float), df[resp].to_numpy(float))
            cells.append(r); labels.append(f"{pred:>14} -> {resp}")
    adj = bh([c["p"] for c in cells])
    for lab, c, pa in zip(labels, cells, adj):
        star = " *" if np.isfinite(pa) and pa < 0.05 else ""
        print(f"   {lab:<34} n={c['n']:<5} rho={c['rho']:+.3f}  p={c['p']:.3f}  bh={pa:.3f}{star}")

    # ---- Is boardFit actually uniform[0,1]? (KS) -----------------------------
    bf = df["boardFit"].dropna().to_numpy()
    if len(bf) >= 30:
        ks = stats.kstest(bf, "uniform")
        print(f"\n-- boardFit uniformity (KS vs U[0,1]) --\n   n={len(bf)}  D={ks.statistic:.3f}  p={ks.pvalue:.3f}"
              + ("   <-- non-uniform!" if ks.pvalue < 0.01 else "   (uniform = fair)"))

    # ---- Dealt-rank uniformity (chi-square) ----------------------------------
    ranks = []
    for h in df["hole"].dropna():
        for c in str(h).split():
            ranks.append(c[0].upper().replace("10", "T"))
    if ranks:
        order = list("23456789TJQKA")
        counts = np.array([ranks.count(r) for r in order])
        chi = stats.chisquare(counts)
        print(f"\n-- dealt-rank uniformity (chi-square, 12 df) --\n   cards={counts.sum()}  "
              f"chi2={chi.statistic:.1f}  p={chi.pvalue:.3f}"
              + ("   <-- non-uniform!" if chi.pvalue < 0.01 else "   (uniform = fair)"))

    # ---- Serial independence (does the deal have memory?) --------------------
    for resp in responses:
        s = df[resp].dropna().to_numpy()
        if len(s) >= 30:
            ac1 = np.corrcoef(s[:-1], s[1:])[0, 1]
            print(f"\n-- {resp} lag-1 autocorrelation --\n   n={len(s)}  r={ac1:+.3f}"
                  " (0 = memoryless = fair)")

    # ---- Bucketed contrast: high vs low prior aggression ---------------------
    sub = df.dropna(subset=[f"priorAggr_{PRIMARY_LAG}", "boardFit"])
    if len(sub) >= 40:
        q = sub[f"priorAggr_{PRIMARY_LAG}"]
        hi = sub[q >= q.quantile(0.75)]["boardFit"]
        lo = sub[q <= q.quantile(0.25)]["boardFit"]
        u = stats.mannwhitneyu(hi, lo, alternative="two-sided")
        print(f"\n-- boardFit: top-quartile vs bottom-quartile prior aggression --")
        print(f"   hi mean={hi.mean():.3f} (n={len(hi)})   lo mean={lo.mean():.3f} (n={len(lo)})"
              f"   Mann-Whitney p={u.pvalue:.3f}")

    # ---- CROSS-PLAYER: did bigger prior-bettors get better cards? ------------
    if records is not None:
        cp = cross_player(records)
        print("\n-- CROSS-PLAYER: within showdowns, bigger prior-bettor = better cards? --")
        if cp is None:
            print("   (no multi-way showdowns with board data yet)")
        else:
            print(f"   {cp['pairs']} player-pairs over {cp['hands']} showdowns   "
                  f"concordant={cp['frac']*100:.1f}%   binom p={cp['p']:.3f}"
                  + ("   <-- flag" if cp['p'] < 0.01 else "   (50% = fair)"))
            print("   NOTE: shown hands are selection-biased (winners show, losers muck).")

    # ---- optional plots ------------------------------------------------------
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(1, 3, figsize=(13, 4))
        s = df.dropna(subset=[f"priorAggr_{PRIMARY_LAG}", "boardFit"])
        ax[0].scatter(s[f"priorAggr_{PRIMARY_LAG}"], s["boardFit"], s=6, alpha=.35)
        ax[0].set(xlabel=f"prior {PRIMARY_LAG}-hand aggression", ylabel="boardFit",
                  title=f"rho={prim['rho']:+.3f}, p={prim['p']:.3f}")
        ax[1].hist(bf, bins=20, range=(0, 1))
        ax[1].set(title="boardFit (flat = fair)", xlabel="boardFit")
        ax[2].scatter(df["stack"], df["boardFit"], s=6, alpha=.35)
        ax[2].set(xlabel="chip stack", ylabel="boardFit", title="stack vs cards")
        fig.tight_layout(); fig.savefig("rng_test.png", dpi=110)
        print("\nsaved plots -> rng_test.png")
    except Exception as e:
        print(f"\n(plots skipped: {e})")

    print("\nInterpretation: rho/autocorr ~0, uniform boardFit, non-significant primary"
          " => consistent with a FAIR deal. A single small p among many tests is noise"
          " (that's what BH correction and the pre-registered primary are for).\n")


if __name__ == "__main__":
    main()
