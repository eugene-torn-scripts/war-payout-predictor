#!/usr/bin/env python3
"""
v6 — wiki structure + matchup fighters. Keeps the fixed wiki factors (win 2x,
+1%/member) and the per-rank base, and enriches participation with the fighter
counts on BOTH sides (members with >=10 hits):

  SCORE model: cache = BASE(rank) × 2^win × (1+1%·(m−10))
                       × partMod(score-share, ×0-3)
                       × (ownFighters/REF)^C × (oppFighters/REF)^D
  ROSTER model (pre-war, unchanged from v5): partMod from member fraction 3·p^K.

Anchors partMod to ×0-3 and fighters to a reference count so BASE stays sane.
Writes model.json.
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
FREF = 40.0   # fighter reference count → fighter factors ≈ 1 here


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


srows, rrows = [], []
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
        on10 = sum(1 for a in opp["attacks_dist"] if a >= 10)
        share = f["score"] / max(f["score"] + opp["score"], 1)
        won = 1.0 if f["id"] == w["winner"] else 0.0
        off = math.log(2.0) * won + math.log(1 + 0.01 * (f["enlisted"] - 10))
        base = {"rank": f["rank_before"], "won": won, "enl": f["enlisted"], "v": v, "y": math.log(v),
                "t": math.log(v) - off, "ls": math.log(max(share, 1e-4)),
                "ln": math.log(max(n10, 1)), "lon": math.log(max(on10, 1)),
                "p": n10 / f["enlisted"]}
        srows.append(base)
        if base["p"] > 0:
            rrows.append({**base, "lp": math.log(base["p"])})

ranks = sorted({r["rank"] for r in srows}, key=rix)
BASE = "Gold I"
dummies = [d for d in ranks if d != BASE]


def diag(rows, predfn):
    n = len(rows)
    rss = sum((r["y"] - predfn(r)) ** 2 for r in rows)
    ybar = sum(r["y"] for r in rows) / n
    tss = sum((r["y"] - ybar) ** 2 for r in rows)
    abserr = sorted(abs(math.exp(predfn(r) - r["y"]) - 1) for r in rows)
    absdev = sorted(abs(r["y"] - predfn(r)) for r in rows)
    w2 = sum(1 for r in rows if 0.5 <= math.exp(predfn(r) - r["y"]) <= 2) / n
    return {"r2": round(1 - rss / tss, 4), "median_err_pct": round(100 * abserr[n // 2]),
            "band68": round(math.exp(absdev[int(0.68 * n)]), 3), "within2": round(100 * w2), "n": n}


# SCORE model: + own & opp fighters
bs = ols(srows, [lambda r: r["ls"], lambda r: r["ls"] ** 2, lambda r: r["ln"], lambda r: r["lon"]],
         ["a", "b", "c", "d"], dummies, BASE)
A, B, C, D = bs["a"], bs["b"], bs["c"], bs["d"]
ls_star = -A / (2 * B)
M = math.exp(A * ls_star + B * ls_star ** 2)


def score_predlog(r):
    bse = bs["intercept"] + (0 if r["rank"] == BASE else bs["rank:" + r["rank"]])
    return (bse + math.log(2.0) * r["won"] + math.log(1 + 0.01 * (r["enl"] - 10))
            + A * r["ls"] + B * r["ls"] ** 2 + C * r["ln"] + D * r["lon"])

ds = diag(srows, score_predlog)
# anchored base: value = baseD · 2^won · sizeF · partD · (own/REF)^C · (opp/REF)^D
score_base = {rk: math.exp(bs["intercept"] + (0 if rk == BASE else bs["rank:" + rk]))
              * M / 3 * (FREF ** C) * (FREF ** D) for rk in ranks}

# ROSTER model (unchanged from v5)
br = ols(rrows, [lambda r: r["lp"]], ["k"], dummies, BASE)
K = br["k"]


def roster_predlog(r):
    bse = br["intercept"] + (0 if r["rank"] == BASE else br["rank:" + r["rank"]])
    return bse + math.log(2.0) * r["won"] + math.log(1 + 0.01 * (r["enl"] - 10)) + K * r["lp"]

dr = diag(rrows, roster_predlog)
roster_base = {rk: math.exp(br["intercept"] + (0 if rk == BASE else br["rank:" + rk])) / 3 for rk in ranks}

print("SCORE  (share+fighters): R2=%.4f median_err=%d%% within2=%d%% band68=%.3f"
      % (ds["r2"], ds["median_err_pct"], ds["within2"], ds["band68"]))
print("ROSTER (member frac):    R2=%.4f median_err=%d%%" % (dr["r2"], dr["median_err_pct"]))
print("coeffs: ownFighters^%.3f  oppFighters^%.3f  (ref=%d)" % (C, D, FREF))
print("share partMod x0-3: " + ", ".join("%d%%:x%.2f" % (int(s * 100), 3 * math.exp(A * math.log(s) + B * math.log(s) ** 2) / M) for s in [0.05, 0.25, 0.5, 0.75]))

model = {
    "cutoff": CUT, "reference_rank": BASE, "floor_value": FLOOR, "win_factor": 2.0,
    "size_per_member": 0.01, "fighter_ref": FREF,
    "cache_prices": {str(k2): v for k2, v in prices.items()},
    "score_model": {"share_a": A, "share_b": B, "part_max": M, "own_c": C, "opp_d": D,
                    "base": {rk: round(score_base[rk]) for rk in ranks}, "diagnostics": ds},
    "roster_model": {"part_k": K, "base": {rk: round(roster_base[rk]) for rk in ranks}, "diagnostics": dr},
}
json.dump(model, open(os.path.join(DATA, "model.json"), "w"), indent=2)
print("\nwrote model.json (v6)")


def cs(rank, won, enl, share, own, opp):
    ls = math.log(share)
    partD = 3 * (M if ls >= ls_star else math.exp(A * ls + B * ls ** 2)) / M
    return score_base[rank] * (2.0 ** won) * (1 + 0.01 * (enl - 10)) * partD * (own / FREF) ** C * (opp / FREF) ** D

print("ADHD (Gold I,loss,92,share .054, 3 vs 62 fighters): $%.0fm (actual $115m)"
      % (cs("Gold I", 0, 92, 726 / 13454, 3, 62) / 1e6))
print("L&L  (Gold,win,100,share .946, 62 vs 3 fighters)  : $%.2fb (actual $2.57b)"
      % (cs("Gold", 1, 100, 12728 / 13454, 62, 3) / 1e9))
