#!/usr/bin/env python3
"""
Ranked-war report scraper for the war-payout predictor.

Walks ranked-war IDs downward from a ceiling, fetching each
/v2/faction/{warId}/rankedwarreport (Public key is enough — reads ANY
faction's war). Distills one row per war into reports.jsonl. Resumable:
every attempted id is recorded in scanned_ids.txt so re-runs skip it.
Rate-limited to stay well under Torn's 100 req/min/key.

No secrets are written to the data dir; war reports are public data.
"""
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
KEY = open(os.path.join(ROOT, "shared", "apiKey.txt")).read().strip()
DATA = os.path.join(HERE, "..", "data")
OUT = os.path.join(DATA, "reports.jsonl")
DONE = os.path.join(DATA, "scanned_ids.txt")

START = int(sys.argv[1]) if len(sys.argv) > 1 else 42960
FLOOR = int(sys.argv[2]) if len(sys.argv) > 2 else 34000
DELAY = 0.72  # ~83 req/min, safely under the 100/min cap

os.makedirs(DATA, exist_ok=True)

scanned = set()
if os.path.exists(DONE):
    with open(DONE) as f:
        for line in f:
            line = line.strip()
            if line:
                scanned.add(int(line))


def fetch(wid):
    url = "https://api.torn.com/v2/faction/%d/rankedwarreport?key=%s" % (wid, KEY)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def distill(r):
    factions = []
    for f in r["factions"]:
        attacks = sorted((m.get("attacks", 0) for m in f["members"]), reverse=True)
        rw = f.get("rewards", {})
        factions.append({
            "id": f["id"],
            "name": f["name"],
            "won": f["id"] == r["winner"],
            "score": f["score"],
            "attacks_total": f.get("attacks"),
            "rank_before": f["rank"]["before"],
            "rank_after": f["rank"]["after"],
            "enlisted": len(f["members"]),
            "hits_pos": sum(1 for a in attacks if a > 0),
            "hits_ge10": sum(1 for a in attacks if a >= 10),
            "attacks_dist": attacks,            # per-member hit counts, desc
            "respect": rw.get("respect"),
            "points": rw.get("points"),
            "caches": [{"id": it["id"], "name": it["name"], "qty": it["quantity"]}
                       for it in rw.get("items", [])],
        })
    return {
        "war": r["id"],
        "start": r["start"],
        "end": r["end"],
        "winner": r["winner"],
        "forfeit": r["forfeit"],
        "factions": factions,
    }


def main():
    out = open(OUT, "a")
    done_f = open(DONE, "a")
    ok = miss = 0
    backoff = 0
    wid = START
    while wid >= FLOOR:
        if wid in scanned:
            wid -= 1
            continue
        try:
            d = fetch(wid)
        except Exception as e:  # network/HTTP hiccup — retry same id after a pause
            backoff += 1
            print("net-err id=%d %s (backoff %d)" % (wid, e, backoff), flush=True)
            time.sleep(min(5 * backoff, 60))
            continue
        backoff = 0
        if "error" in d:
            code = d["error"].get("code")
            if code in (5, 8, 9, 17):  # rate-limit / IP-block / disabled — wait, retry
                print("api-throttle id=%d code=%s, waiting" % (wid, code), flush=True)
                time.sleep(15)
                continue
            # code 6 (Incorrect ID) or other permanent miss — record + move on
            done_f.write("%d\n" % wid); done_f.flush()
            scanned.add(wid); miss += 1
        else:
            rec = distill(d["rankedwarreport"])
            out.write(json.dumps(rec) + "\n"); out.flush()
            done_f.write("%d\n" % wid); done_f.flush()
            scanned.add(wid); ok += 1
        if (ok + miss) % 50 == 0:
            print("id=%d ok=%d miss=%d" % (wid, ok, miss), flush=True)
        wid -= 1
        time.sleep(DELAY)
    print("DONE start=%d floor=%d ok=%d miss=%d" % (START, FLOOR, ok, miss), flush=True)


if __name__ == "__main__":
    main()
