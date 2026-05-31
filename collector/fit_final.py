#!/usr/bin/env python3
"""Fit the final cache-reward model (with win interactions), backtest its
accuracy, and write model.json for the predictor."""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
CUTOFF = 1748649600
prices = {int(k): v["avg"] for k, v in
          json.load(open(os.path.join(DATA, "cache_prices.json"))).items()}
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
        if v <= 0 or f["enlisted"] <= 0:
            continue
        rows.append({"rank": f["rank_before"], "won": 1.0 if f["won"] else 0.0,
                     "enl": f["enlisted"], "part10": f["hits_ge10"] / f["enlisted"],
                     "y": math.log(v)})

ranks = sorted({r["rank"] for r in rows}, key=rix)
BASE = "Gold I"
dummies = [r for r in ranks if r != BASE]
COLS = ["intercept"] + ["rank:" + d for d in dummies] + \
       ["won", "log_enl", "part", "part2", "won*part", "won*logenl"]


def feat(r):
    return ([1.0] + [1.0 if r["rank"] == d else 0.0 for d in dummies] +
            [r["won"], math.log(r["enl"]), r["part10"], r["part10"] ** 2,
             r["won"] * r["part10"], r["won"] * math.log(r["enl"])])


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
                f = A[r][c]
                A[r] = [a - f * b for a, b in zip(A[r], A[c])]
    return [row[k:] for row in A]


X = [feat(r) for r in rows]
Y = [r["y"] for r in rows]
n, k = len(X), len(COLS)
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
beta = [sum(inv[a][b] * Xty[b] for b in range(k)) for a in range(k)]
B = dict(zip(COLS, beta))

# backtest accuracy (in-sample): multiplicative error
errs = []
within15 = within2 = 0
for i in range(n):
    pred = math.exp(sum(X[i][a] * beta[a] for a in range(k)))
    act = math.exp(Y[i])
    ratio = pred / act
    errs.append(abs(ratio - 1))
    if 1 / 1.5 <= ratio <= 1.5:
        within15 += 1
    if 0.5 <= ratio <= 2.0:
        within2 += 1
errs.sort()
print("fit rows=%d  features=%d" % (n, k))
print("median abs %% error: %.0f%%" % (100 * errs[len(errs) // 2]))
print("within 1.5x: %.0f%%   within 2x: %.0f%%" % (100 * within15 / n, 100 * within2 / n))

model = {
    "cutoff": CUTOFF,
    "reference_rank": BASE,
    "cache_prices": {str(k2): v for k2, v in prices.items()},
    "intercept": B["intercept"],
    "win_log": B["won"], "win_mult": math.exp(B["won"]),
    "size_exp": B["log_enl"],
    "part_b1": B["part"], "part_b2": B["part2"],
    "won_x_part": B["won*part"], "won_x_logenl": B["won*logenl"],
    "rank_mult": {rk: (1.0 if rk == BASE else math.exp(B["rank:" + rk])) for rk in ranks},
}
json.dump(model, open(os.path.join(DATA, "model.json"), "w"), indent=2)
print("\nwrote model.json")
print("win multiplier: x%.2f | size exponent: %.2f | participation peak near part=%.2f" % (
    model["win_mult"], model["size_exp"], B["part"] / (2 * -B["part2"])))
