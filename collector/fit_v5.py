#!/usr/bin/env python3
"""
v5 — WIKI-STRUCTURED fit. Imposes the documented mechanic:

    cache = BASE(rank) × 2^win × (1 + 0.01·(members−10)) × partMod   [×0…×3]

Win=2x and size=+1%/member are FIXED to the wiki values; BASE(rank) and the
participation modifier are fitted, then the modifier is anchored to a ×0–×3
scale (base absorbs the constant, predictions unchanged).

  SCORE model  (scores known): partMod from score-share = own/(own+opp).
                partMod_raw = exp(a·ln s + b·ln²s); anchored partD = 3·raw/Max.
  ROSTER model (pre-war): partMod from member-fraction p (≥10 hits): partD = 3·p^k.

Writes model.json with anchored per-rank base ($) and the participation params.
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
CUT = 1748649600
prices = {int(k): v["avg"] for k, v in json.load(open(os.path.join(DATA, "cache_prices.json"))).items()}
TIER = ["Unranked", "Bronze", "Silver", "Gold", "Platinum", "Diamond"]
DIV = {"": 0, "I": 1, "II": 2, "III": 3}
FLOOR = min(prices.values())


def rix(rb):
    p = rb.split()
    return TIER.index(p[0]) * 4 + DIV.get(p[1] if len(p) > 1 else "", 0)


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


def ols(rows, featfns, names, dummies, BASE):
    cols = ["intercept"] + ["rank:" + d for d in dummies] + names
    X = [[1.0] + [1.0 if r["rank"] == d else 0.0 for d in dummies] + [fn(r) for fn in featfns] for r in rows]
    Y = [r["t"] for r in rows]
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
    return dict(zip(cols, bl))


def load(need_share):
    rows = []
    for line in open(os.path.join(DATA, "reports.jsonl")):
        w = json.loads(line)
        if w.get("forfeit") or w["end"] < CUT or len(w["factions"]) != 2:
            continue
        facs = w["factions"]
        for i, f in enumerate(facs):
            opp = facs[1 - i]
            v = sum(it["qty"] * prices.get(it["id"], 0) for it in f["caches"])
            if v <= 0 or f["enlisted"] <= 0:
                continue
            n10 = sum(1 for a in f["attacks_dist"] if a >= 10)
            share = f["score"] / max(f["score"] + opp["score"], 1)
            p = n10 / f["enlisted"]
            won = 1.0 if f["id"] == w["winner"] else 0.0
            offset = math.log(2.0) * won + math.log(1 + 0.01 * (f["enlisted"] - 10))
            row = {"rank": f["rank_before"], "won": won, "enl": f["enlisted"],
                   "share": share, "p": p, "v": v, "y": math.log(v),
                   "t": math.log(v) - offset, "ls": math.log(max(share, 1e-4)),
                   "lp": math.log(p) if p > 0 else None}
            if need_share or p > 0:
                rows.append(row)
    return rows


ranks_all = sorted({r["rank"] for r in load(True)}, key=rix)
BASE = "Gold I"
dummies = [d for d in ranks_all if d != BASE]


def diag(rows, predfn):
    n = len(rows)
    rss = sum((r["y"] - predfn(r)) ** 2 for r in rows)
    ybar = sum(r["y"] for r in rows) / n
    tss = sum((r["y"] - ybar) ** 2 for r in rows)
    abserr = sorted(abs(math.exp(predfn(r) - r["y"]) - 1) for r in rows)
    absdev = sorted(abs(r["y"] - predfn(r)) for r in rows)
    return {"r2": round(1 - rss / tss, 4), "median_err_pct": round(100 * abserr[n // 2]),
            "band68": round(math.exp(absdev[int(0.68 * n)]), 3), "n": n}


# ---------- SCORE model (share) ----------
srows = load(True)
bs = ols(srows, [lambda r: r["ls"], lambda r: r["ls"] ** 2], ["a", "b"], dummies, BASE)
a, b = bs["a"], bs["b"]
# max of (a·ls + b·ls²) over ls<0  → ls* = -a/(2b)
ls_star = -a / (2 * b)
g_max = a * ls_star + b * ls_star ** 2
M = math.exp(g_max)            # peak of partMod_raw


def score_predlog(r):
    base = bs["intercept"] + (0 if r["rank"] == BASE else bs["rank:" + r["rank"]])
    return base + math.log(2.0) * r["won"] + math.log(1 + 0.01 * (r["enl"] - 10)) + a * r["ls"] + b * r["ls"] ** 2

ds = diag(srows, score_predlog)
# anchored display base per rank: baseD = exp(intercept+rank) * M / 3
score_base = {rk: math.exp(bs["intercept"] + (0 if rk == BASE else bs["rank:" + rk])) * M / 3 for rk in ranks_all}

# ---------- ROSTER model (member fraction) ----------
rrows = [r for r in load(False)]
br = ols(rrows, [lambda r: r["lp"]], ["k"], dummies, BASE)
k = br["k"]


def roster_predlog(r):
    base = br["intercept"] + (0 if r["rank"] == BASE else br["rank:" + r["rank"]])
    return base + math.log(2.0) * r["won"] + math.log(1 + 0.01 * (r["enl"] - 10)) + k * r["lp"]

dr = diag(rrows, roster_predlog)
roster_base = {rk: math.exp(br["intercept"] + (0 if rk == BASE else br["rank:" + rk])) / 3 for rk in ranks_all}

print("SCORE  (share):  R2=%.4f  median_err=%d%%  band68=%.3f" % (ds["r2"], ds["median_err_pct"], ds["band68"]))
print("ROSTER (member): R2=%.4f  median_err=%d%%  band68=%.3f" % (dr["r2"], dr["median_err_pct"], dr["band68"]))
print("share partMod (x0-3): " + ", ".join(
    "%d%%:x%.2f" % (int(s * 100), 3 * math.exp(a * math.log(s) + b * math.log(s) ** 2) / M) for s in [0.05, 0.25, 0.5, 0.75, 1.0]))
print("member partMod (x0-3): " + ", ".join("%d%%:x%.2f" % (int(p * 100), 3 * p ** k) for p in [0.1, 0.25, 0.5, 0.75, 1.0]))
print("k=%.3f  Gold I base score=$%.0fm roster=$%.0fm" % (k, score_base["Gold I"] / 1e6, roster_base["Gold I"] / 1e6))

model = {
    "cutoff": CUT, "reference_rank": BASE, "floor_value": FLOOR, "win_factor": 2.0, "size_per_member": 0.01,
    "cache_prices": {str(k2): v for k2, v in prices.items()},
    "score_model": {"share_a": a, "share_b": b, "part_max": M,
                    "base": {rk: round(score_base[rk]) for rk in ranks_all}, "diagnostics": ds},
    "roster_model": {"part_k": k, "base": {rk: round(roster_base[rk]) for rk in ranks_all}, "diagnostics": dr},
}
json.dump(model, open(os.path.join(DATA, "model.json"), "w"), indent=2)
print("\nwrote model.json (v5: wiki-structured, x0-3 participation)")
# sanity
def case_score(rank, won, enl, share):
    ls = math.log(share)
    return score_base[rank] * (2.0 ** won) * (1 + 0.01 * (enl - 10)) * (3 * math.exp(a * ls + b * ls ** 2) / M)
print("ADHD (Gold I,loss,92,share .054): $%.0fm (actual $115m)" % (case_score("Gold I", 0, 92, 726 / 13454) / 1e6))
print("L&L  (Gold,win,100,share .946)  : $%.2fb (actual $2.57b)" % (case_score("Gold", 1, 100, 12728 / 13454) / 1e9))
