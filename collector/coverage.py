#!/usr/bin/env python3
"""Summarize collected war reports: count, rank/division coverage,
win/loss balance, member-count and participation spread. Used to decide
when the dataset is rich enough to fit the payout formula."""
import json
import os
import re
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "reports.jsonl")

wars = 0
faction_rows = 0
ranks = Counter()          # rank tier+division at war time (rank_before)
tier = Counter()           # base tier only (Gold, Platinum, ...)
wins = losses = 0
forfeits = 0
members = []
part_ge10 = []             # fraction of enlisted with >=10 hits

RANK_RE = re.compile(r"^([A-Za-z]+)")

if os.path.exists(OUT):
    with open(OUT) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            w = json.loads(line)
            wars += 1
            if w.get("forfeit"):
                forfeits += 1
            for fa in w["factions"]:
                faction_rows += 1
                rb = fa["rank_before"]
                ranks[rb] += 1
                m = RANK_RE.match(rb or "")
                tier[m.group(1) if m else "?"] += 1
                if fa["won"]:
                    wins += 1
                else:
                    losses += 1
                members.append(fa["enlisted"])
                if fa["enlisted"]:
                    part_ge10.append(fa["hits_ge10"] / fa["enlisted"])

print("wars: %d   faction-rows: %d   forfeits: %d" % (wars, faction_rows, forfeits))
print("win/loss rows: %d / %d" % (wins, losses))
if members:
    members.sort()
    print("enlisted: min=%d  median=%d  max=%d" % (
        members[0], members[len(members)//2], members[-1]))
if part_ge10:
    part_ge10.sort()
    print("frac members w/>=10 hits: min=%.2f median=%.2f max=%.2f" % (
        part_ge10[0], part_ge10[len(part_ge10)//2], part_ge10[-1]))
print("\nby tier:")
for t, c in tier.most_common():
    print("  %-12s %d" % (t, c))
print("\nby rank+division:")
for r, c in sorted(ranks.items(), key=lambda kv: -kv[1]):
    print("  %-14s %d" % (r, c))
