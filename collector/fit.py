#!/usr/bin/env python3
"""
Fit the ranked-war cache-reward formula by multiplicative (log-linear) OLS.

reward(value) is modelled as a product of factors, so log(value) is linear:
    log(v) = b0 + sum(rank dummies) + b_won*won + a*log(size) + part-terms
Pure-python OLS (normal equations + Gauss-Jordan inverse) gives coefficients,
standard errors and t-stats. Several specs are compared by adjusted R^2 to see
whether the size effect is driven by enlisted count vs. number who actually hit,
and to check the "+1%/member" claim.

Only recent (post-cutoff) wars with positive cache value are used.
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
CUTOFF = 1748649600
prices = {int(k): v["avg"] for k, v in
          json.load(open(os.path.join(DATA, "cache_prices.json"))).items()}

TIER_ORDER = ["Unranked", "Bronze", "Silver", "Gold", "Platinum", "Diamond"]
DIV_ORDER = {"": 0, "I": 1, "II": 2, "III": 3}  # I lowest div, III highest, then promote


def rank_index(rb):
    parts = rb.split()
    tier = parts[0]
    div = parts[1] if len(parts) > 1 else ""
    return TIER_ORDER.index(tier) * 4 + DIV_ORDER.get(div, 0)


# ---------- load ----------
rows = []
for line in open(os.path.join(DATA, "reports.jsonl")):
    w = json.loads(line)
    if w.get("forfeit") or w["end"] < CUTOFF:
        continue
    for f in w["factions"]:
        v = sum(it["qty"] * prices.get(it["id"], 0) for it in f["caches"])
        if v <= 0 or f["enlisted"] <= 0:
            continue
        rows.append({
            "rank": f["rank_before"], "won": 1.0 if f["won"] else 0.0,
            "enl": f["enlisted"], "pos": max(f["hits_pos"], 1),
            "part10": f["hits_ge10"] / f["enlisted"],
            "y": math.log(v),
        })

ranks = sorted({r["rank"] for r in rows}, key=rank_index)
BASE = "Gold I"  # dropped dummy (reference rank)
dummies = [r for r in ranks if r != BASE]
print("fit rows: %d   ranks: %d   reference rank: %s\n" % (len(rows), len(ranks), BASE))


# ---------- linear algebra ----------
def solve_ols(X, y):
    n, k = len(X), len(X[0])
    XtX = [[0.0] * k for _ in range(k)]
    Xty = [0.0] * k
    for i in range(n):
        xi = X[i]
        yi = y[i]
        for a in range(k):
            xa = xi[a]
            if xa:
                Xty[a] += xa * yi
                row = XtX[a]
                for b in range(a, k):
                    row[b] += xa * xi[b]
    for a in range(k):
        for b in range(a):
            XtX[a][b] = XtX[b][a]
    inv = invert(XtX)
    beta = [sum(inv[a][b] * Xty[b] for b in range(k)) for a in range(k)]
    # residuals
    rss = 0.0
    ybar = sum(y) / n
    tss = sum((yi - ybar) ** 2 for yi in y)
    for i in range(n):
        pred = sum(X[i][a] * beta[a] for a in range(k))
        rss += (y[i] - pred) ** 2
    sigma2 = rss / (n - k)
    se = [math.sqrt(sigma2 * inv[a][a]) if inv[a][a] > 0 else float("nan") for a in range(k)]
    r2 = 1 - rss / tss
    adj = 1 - (1 - r2) * (n - 1) / (n - k)
    return beta, se, r2, adj, math.sqrt(sigma2)


def invert(M):
    k = len(M)
    A = [row[:] + [1.0 if i == j else 0.0 for j in range(k)] for i, row in enumerate(M)]
    for col in range(k):
        piv = max(range(col, k), key=lambda r: abs(A[r][col]))
        A[col], A[piv] = A[piv], A[col]
        d = A[col][col]
        A[col] = [x / d for x in A[col]]
        for r in range(k):
            if r != col and A[r][col]:
                f = A[r][col]
                A[r] = [a - f * b for a, b in zip(A[r], A[col])]
    return [row[k:] for row in A]


def design(spec):
    """Return (col_names, X) for a given feature spec."""
    cols = ["intercept"] + ["rank:" + d for d in dummies]
    feats = []
    if "won" in spec:
        cols.append("won")
    if "log_enl" in spec:
        cols.append("log_enl")
    if "log_pos" in spec:
        cols.append("log_pos")
    if "memlin" in spec:
        cols.append("(enl-10)")  # tests +x%/member
    if "part" in spec:
        cols.append("part10")
    if "part2" in spec:
        cols.append("part10^2")
    X = []
    for r in rows:
        row = [1.0] + [1.0 if r["rank"] == d else 0.0 for d in dummies]
        if "won" in spec:
            row.append(r["won"])
        if "log_enl" in spec:
            row.append(math.log(r["enl"]))
        if "log_pos" in spec:
            row.append(math.log(r["pos"]))
        if "memlin" in spec:
            row.append(r["enl"] - 10)
        if "part" in spec:
            row.append(r["part10"])
        if "part2" in spec:
            row.append(r["part10"] ** 2)
        X.append(row)
    return cols, X


def run(spec, label):
    cols, X = design(spec)
    y = [r["y"] for r in rows]
    beta, se, r2, adj, rmse = solve_ols(X, y)
    print("--- %s ---  R2=%.4f  adjR2=%.4f  RMSE(log)=%.3f" % (label, r2, adj, rmse))
    for c, b, s in zip(cols, beta, se):
        if c.startswith("rank:"):
            continue
        t = b / s if s else float("nan")
        extra = ""
        if c == "won":
            extra = "  -> win x%.2f" % math.exp(b)
        if c in ("log_enl", "log_pos"):
            extra = "  -> size exponent a=%.2f (double members => x%.2f)" % (b, 2 ** b)
        print("   %-12s b=%+.4f  se=%.4f  t=%+.1f%s" % (c, b, s, t, extra))
    return beta, cols, r2


print("== spec comparison (which size term fits best) ==")
run(["won", "log_enl", "part", "part2"], "enlisted-size")
run(["won", "log_pos", "part", "part2"], "participants-size")
run(["won", "memlin", "part", "part2"], "linear-member (+x%/mbr)")
print()
beta, cols, r2 = run(["won", "log_enl", "part", "part2"], "FINAL (enlisted)")

# per-rank base multiplier (relative to reference), from the FINAL spec
print("\n== per-rank base multiplier (relative to %s), FINAL spec ==" % BASE)
idx = {c: i for i, c in enumerate(cols)}
for rk in ranks:
    if rk == BASE:
        mult = 1.0
    else:
        mult = math.exp(beta[idx["rank:" + rk]])
    print("   %-14s x%.3f" % (rk, mult))
