#!/usr/bin/env python3
"""
v4 fit. Score model ties the cache to who actually FOUGHT (members with >=10
hits, n10) rather than enlisted roster — fixes over-prediction of blown-out,
low-participation factions (the loser of a lopsided war hits the cache floor).

  SCORE  : log(v) = b0 + rank + w*won + c*log(score) + s*log(n10)
  ROSTER : log(v) = b0 + rank + w*won + a*log(members) + d*log(p+eps)   [unchanged]

Writes model.json. Also reports calibration by win/loss and on the
low-participation tail.
"""
import json
import math
import os
import statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
CUTOFF = 1748649600
PART_EPS = 0.05
prices = {int(k): v["avg"] for k, v in json.load(open(os.path.join(DATA, "cache_prices.json"))).items()}
TIER = ["Unranked", "Bronze", "Silver", "Gold", "Platinum", "Diamond"]
DIV = {"": 0, "I": 1, "II": 2, "III": 3}


def rix(rb):
    p = rb.split()
    return TIER.index(p[0]) * 4 + DIV.get(p[1] if len(p) > 1 else "", 0)


rows = []
for line in open(os.path.join(DATA, "reports.jsonl")):
    w = json.loads(line)
    if w.get("forfeit") or w["end"] < CUTOFF:
        continue
    for f in w["factions"]:
        v = sum(it["qty"] * prices.get(it["id"], 0) for it in f["caches"])
        n10 = sum(1 for a in f["attacks_dist"] if a >= 10)
        if v <= 0 or f["enlisted"] <= 0 or f["score"] <= 0:
            continue
        rows.append({"rank": f["rank_before"], "won": 1.0 if f["won"] else 0.0,
                     "enl": f["enlisted"], "score": f["score"], "n10": n10,
                     "p": min(1.0, n10 / f["enlisted"]), "y": math.log(v)})

ranks = sorted({r["rank"] for r in rows}, key=rix)
BASE = "Gold I"
dummies = [r for r in ranks if r != BASE]


def invert(M):
    k = len(M)
    A = [row[:] + [1.0 if i == j else 0.0 for j in range(k)] for i, row in enumerate(M)]
    for c in range(k):
        piv = max(range(c, k), key=lambda r: abs(A[r][c]))
        A[c], A[piv] = A[piv], A[c]
        d = A[c][c]
        A[c] = [x / d for x in A[c]]
        for r in range(k):
            if r != c and A[r][c]:
                fa = A[r][c]
                A[r] = [a - fa * b for a, b in zip(A[r], A[c])]
    return [row[k:] for row in A]


def fit(featfns, names):
    cols = ["intercept"] + ["rank:" + d for d in dummies] + names
    X = [[1.0] + [1.0 if r["rank"] == d else 0.0 for d in dummies] + [fn(r) for fn in featfns] for r in rows]
    Y = [r["y"] for r in rows]
    n, k = len(X), len(cols)
    XtX = [[0.0] * k for _ in range(k)]
    Xty = [0.0] * k
    for i in range(n):
        xi, yi = X[i], Y[i]
        for a in range(k):
            if xi[a]:
                Xty[a] += xi[a] * yi
                for b in range(a, k):
                    XtX[a][b] += xi[a] * xi[b]
    for a in range(k):
        for b in range(a):
            XtX[a][b] = XtX[b][a]
    inv = invert(XtX)
    bl = [sum(inv[a][b] * Xty[b] for b in range(k)) for a in range(k)]
    beta = dict(zip(cols, bl))

    def predrow(r):
        s = beta["intercept"] + sum(beta["rank:" + d] * (1 if r["rank"] == d else 0) for d in dummies)
        for nm, fn in zip(names, featfns):
            s += beta[nm] * fn(r)
        return s
    rss = sum((r["y"] - predrow(r)) ** 2 for r in rows)
    ybar = sum(Y) / n
    tss = sum((y - ybar) ** 2 for y in Y)
    absdev = sorted(abs(r["y"] - predrow(r)) for r in rows)
    abserr = sorted(abs(math.exp(predrow(r) - r["y"]) - 1) for r in rows)
    w2 = sum(1 for r in rows if 0.5 <= math.exp(predrow(r) - r["y"]) <= 2) / n
    diag = {"r2": round(1 - rss / tss, 4), "median_err_pct": round(100 * abserr[n // 2]),
            "band68": round(math.exp(absdev[int(0.68 * n)]), 3), "within2": round(100 * w2), "n": n}
    rank_mult = {rk: (1.0 if rk == BASE else math.exp(beta["rank:" + rk])) for rk in ranks}
    lp = st.median([math.exp(predrow(r) - r["y"]) for r in rows if r["p"] < 0.1])
    return beta, rank_mult, diag, lp


W = lambda r: r["won"]
LE = lambda r: math.log(r["enl"])
LS = lambda r: math.log(r["score"])
LN = lambda r: math.log(max(r["n10"], 1))
LP = lambda r: math.log(r["p"] + PART_EPS)

bs, rms, ds, lps = fit([W, LS, LN], ["won", "log_score", "log_n10"])
br, rmr, dr, lpr = fit([W, LE, LP], ["won", "log_enl", "log_part"])

print("SCORE  model:", ds, "| low-part(<10pct) median pred/actual = %.2fx" % lps)
print("ROSTER model:", dr, "| low-part(<10pct) median pred/actual = %.2fx" % lpr)
print("SCORE : win x%.2f | score^%.3f | n10(fighters)^%.3f" % (
    math.exp(bs["won"]), bs["log_score"], bs["log_n10"]))

model = {
    "cutoff": CUTOFF, "reference_rank": BASE, "part_eps": PART_EPS,
    "cache_prices": {str(k): v for k, v in prices.items()},
    "floor_value": min(prices.values()),   # 1 Small Arms Cache — the practical minimum
    "score_model": {"intercept": bs["intercept"], "won": bs["won"], "log_score": bs["log_score"],
                    "log_n10": bs["log_n10"], "rank_mult": rms, "diagnostics": ds},
    "roster_model": {"intercept": br["intercept"], "won": br["won"], "log_enl": br["log_enl"],
                     "log_part": br["log_part"], "rank_mult": rmr, "diagnostics": dr},
}
json.dump(model, open(os.path.join(DATA, "model.json"), "w"), indent=2)
print("\nwrote model.json (v4: score model size = members who fought; floor_value added)")
