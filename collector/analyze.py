#!/usr/bin/env python3
"""Exploratory analysis of collected war reports. Converts each faction's
cache to a cash value (current market avg) and prints the empirical
structure of the reward across rank, win/loss, member count and
participation — BEFORE fitting any model, to see the real shape."""
import json
import os
import statistics as st
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
prices = {int(k): v["avg"] for k, v in
          json.load(open(os.path.join(DATA, "cache_prices.json"))).items()}

TIER_ORDER = ["Unranked", "Bronze", "Silver", "Gold", "Platinum", "Diamond"]
DIV_ORDER = {"": 0, "III": 1, "II": 2, "I": 3}  # III is lowest div, I highest


def rank_key(rb):
    parts = rb.split()
    tier = parts[0]
    div = parts[1] if len(parts) > 1 else ""
    return tier, div


def rank_index(rb):
    tier, div = rank_key(rb)
    return TIER_ORDER.index(tier) * 4 + DIV_ORDER.get(div, 0)


def cache_value(caches):
    return sum(it["qty"] * prices.get(it["id"], 0) for it in caches)


rows = []
for line in open(os.path.join(DATA, "reports.jsonl")):
    w = json.loads(line)
    if w.get("forfeit"):
        continue
    for f in w["factions"]:
        rows.append({
            "rank": f["rank_before"], "won": f["won"],
            "members": f["enlisted"], "score": f["score"],
            "part10": f["hits_ge10"] / f["enlisted"] if f["enlisted"] else 0,
            "partpos": f["hits_pos"] / f["enlisted"] if f["enlisted"] else 0,
            "value": cache_value(f["caches"]),
            "ncache": sum(it["qty"] for it in f["caches"]),
        })


def med(xs):
    return st.median(xs) if xs else 0


def fmt(v):
    return "%6.2fb" % (v / 1e9) if v >= 1e9 else "%6.0fm" % (v / 1e6)


print("rows: %d (excl. forfeits)\n" % len(rows))

# --- win/loss median value by tier ---
print("=== median cache $ by tier × result, and win/loss ratio ===")
for tier in TIER_ORDER:
    wv = [r["value"] for r in rows if r["rank"].split()[0] == tier and r["won"]]
    lv = [r["value"] for r in rows if r["rank"].split()[0] == tier and not r["won"]]
    if not wv and not lv:
        continue
    ratio = (med(wv) / med(lv)) if med(lv) else float("nan")
    print("  %-9s n=%3d/%3d  win=%s  loss=%s  W/L=%.2f"
          % (tier, len(wv), len(lv), fmt(med(wv)), fmt(med(lv)), ratio))

# --- per rank+division, median WIN value, step ratio vs previous ---
print("\n=== median WIN cache $ by rank+division (ascending), step ratio ===")
buckets = defaultdict(list)
for r in rows:
    if r["won"]:
        buckets[r["rank"]].append(r["value"])
ordered = sorted(buckets.keys(), key=rank_index)
prev = None
for rb in ordered:
    mv = med(buckets[rb])
    step = ("x%.2f" % (mv / prev)) if prev else "  -"
    print("  %-14s n=%3d  win=%s  %s" % (rb, len(buckets[rb]), fmt(mv), step))
    prev = mv if mv else prev

# --- member-count effect within Gold wins (largest bucket) ---
print("\n=== member-count effect (Gold I wins, by enlisted band) ===")
g = [r for r in rows if r["rank"] == "Gold I" and r["won"]]
bands = [(10, 30), (30, 50), (50, 70), (70, 90), (90, 101)]
for lo, hi in bands:
    vs = [r["value"] for r in g if lo <= r["members"] < hi]
    print("  members %2d-%3d  n=%3d  win=%s" % (lo, hi - 1, len(vs), fmt(med(vs))))

# --- participation effect within Gold I losses (participation varies most on losses) ---
print("\n=== participation effect (Gold/Gold I LOSSES, by frac w/>=10 hits) ===")
gl = [r for r in rows if r["rank"].split()[0] == "Gold" and not r["won"]]
pbands = [(0.0, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.01)]
for lo, hi in pbands:
    vs = [r["value"] for r in gl if lo <= r["part10"] < hi]
    print("  part %.1f-%.1f  n=%3d  loss=%s" % (lo, hi, len(vs), fmt(med(vs))))
