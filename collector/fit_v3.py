#!/usr/bin/env python3
"""
v3 fit. Single participation input — `active` = members who landed >=1 war hit —
drives both models, and adds the hit-spread bonus to the score model.

  SCORE  : log(v) = b0 + rank + w*won + a*log(members) + c*log(score) + s*log(active)
  ROSTER : log(v) = b0 + rank + w*won + a*log(members) + s*log(active)

Also computes data-grounded confidence bands: the multiplicative factor f such
that ~68% of wars have actual within [pred/f, pred*f]. Writes model.json.
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
CUTOFF = 1748649600
prices = {int(k): v["avg"] for k, v in json.load(open(os.path.join(DATA, "cache_prices.json"))).items()}
TIER = ["Unranked", "Bronze", "Silver", "Gold", "Platinum", "Diamond"]
DIV = {"": 0, "I": 1, "II": 2, "III": 3}


def rix(rb):
    p = rb.split()
    return TIER.index(p[0]) * 4 + DIV.get(p[1] if len(p) > 1 else "", 0)


PART_EPS = 0.05
rows = []
for line in open(os.path.join(DATA, "reports.jsonl")):
    w = json.loads(line)
    if w.get("forfeit") or w["end"] < CUTOFF:
        continue
    for f in w["factions"]:
        v = sum(it["qty"] * prices.get(it["id"], 0) for it in f["caches"])
        ad = f.get("attacks_dist", [])
        n10 = sum(1 for a in ad if a >= 10)       # members with >=10 war hits
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
    # residuals + error quantiles
    absdev = []
    abserr = []
    w15 = w2 = 0
    rss = 0.0
    ybar = sum(Y) / n
    tss = sum((y - ybar) ** 2 for y in Y)
    for i in range(n):
        pred = sum(X[i][a] * bl[a] for a in range(k))
        rss += (Y[i] - pred) ** 2
        absdev.append(abs(Y[i] - pred))           # |log residual|
        ratio = math.exp(pred) / math.exp(Y[i])
        abserr.append(abs(ratio - 1))
        if 1 / 1.5 <= ratio <= 1.5:
            w15 += 1
        if 0.5 <= ratio <= 2.0:
            w2 += 1
    absdev.sort()
    abserr.sort()
    band68 = math.exp(absdev[int(0.68 * n)])       # factor covering ~68% of wars
    r2 = 1 - rss / tss
    diag = {"r2": round(r2, 4), "median_err_pct": round(100 * abserr[n // 2]),
            "band68": round(band68, 3), "within15": round(100 * w15 / n),
            "within2": round(100 * w2 / n), "n": n}
    rank_mult = {rk: (1.0 if rk == BASE else math.exp(beta["rank:" + rk])) for rk in ranks}
    return beta, rank_mult, diag


W = lambda r: r["won"]
LE = lambda r: math.log(r["enl"])
LS = lambda r: math.log(r["score"])
LN10 = lambda r: math.log(max(r["n10"], 1))        # spread: # members with >=10 hits
LP = lambda r: math.log(r["p"] + PART_EPS)         # roster participation term

# SCORE model gains the spread bonus log(#members with >=10 hits)
bs, rms, ds = fit([W, LE, LS, LN10], ["won", "log_enl", "log_score", "log_n10"])
# ROSTER model unchanged from v2: participation as (p+eps)^c
br, rmr, dr = fit([W, LE, LP], ["won", "log_enl", "log_part"])

print("SCORE  model:", ds)
print("ROSTER model:", dr)
print("SCORE : win x%.2f | members^%.2f | score^%.2f | n10^%.3f" % (
    math.exp(bs["won"]), bs["log_enl"], bs["log_score"], bs["log_n10"]))
print("ROSTER: win x%.2f | members^%.2f | (p+eps)^%.2f" % (
    math.exp(br["won"]), br["log_enl"], br["log_part"]))

model = {
    "cutoff": CUTOFF, "reference_rank": BASE, "part_eps": PART_EPS,
    "cache_prices": {str(k): v for k, v in prices.items()},
    "score_model": {"intercept": bs["intercept"], "won": bs["won"], "log_enl": bs["log_enl"],
                    "log_score": bs["log_score"], "log_n10": bs["log_n10"],
                    "rank_mult": rms, "diagnostics": ds},
    "roster_model": {"intercept": br["intercept"], "won": br["won"], "log_enl": br["log_enl"],
                     "log_part": br["log_part"], "rank_mult": rmr, "diagnostics": dr},
}
json.dump(model, open(os.path.join(DATA, "model.json"), "w"), indent=2)
print("\nwrote model.json (v3: score model gains spread bonus; single >=10-hit input)")
