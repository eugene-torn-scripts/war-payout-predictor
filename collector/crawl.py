#!/usr/bin/env python3
"""
Ranked-war crawler for the war-payout predictor.

Snowballs through the ranked-war network: starting from a seed set of
factions, it pages each faction's /rankedwars history (every war id there
is a real, finished war), enqueues each opponent faction for further
crawling, and fetches the full /rankedwarreport for every discovered war.

This is ~100% useful-request efficient vs. brute-forcing the sparse war-id
space. Resumable: factions_done.txt records crawled factions, scanned_ids.txt
records fetched wars (incl. permanent misses), reports.jsonl holds the data.
Rate-limited under Torn's 100 req/min/key. Stops at TARGET reports or when
the frontier is exhausted.

Usage: crawl.py [TARGET_WARS]
"""
import json
import os
import sys
import time
import urllib.request
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
KEY = open(os.path.join(ROOT, "shared", "apiKey.txt")).read().strip()
DATA = os.path.join(HERE, "..", "data")
OUT = os.path.join(DATA, "reports.jsonl")
DONE_WARS = os.path.join(DATA, "scanned_ids.txt")
DONE_FACS = os.path.join(DATA, "factions_done.txt")
FRONTIER = os.path.join(DATA, "faction_frontier.txt")

TARGET = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
# Only collect wars ending on/after this cutoff — Torn changes war mechanics
# over time, so mixing eras would bias the fit. 1748649600 = 2025-05-31 UTC.
CUTOFF = int(sys.argv[2]) if len(sys.argv) > 2 else 1748649600
DELAY = 0.72  # ~83 req/min
PAGE = 100

SEED = [53195, 48206, 44541, 40334, 48443, 42435, 48684, 49624, 49069]

os.makedirs(DATA, exist_ok=True)


def load_ints(path):
    s = set()
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line:
                    s.add(int(line))
    return s


scanned_wars = load_ints(DONE_WARS)      # war ids already fetched (data or miss)
done_facs = load_ints(DONE_FACS)         # factions already paged
have_wars = set()                        # war ids present in reports.jsonl
if os.path.exists(OUT):
    with open(OUT) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    have_wars.add(json.loads(line)["war"])
                except Exception:
                    pass

# rebuild faction frontier: persisted frontier ∪ seed, minus crawled
fac_q = deque()
queued_facs = set()
for fid in (list(load_ints(FRONTIER)) + SEED):
    if fid not in done_facs and fid not in queued_facs:
        fac_q.append(fid); queued_facs.add(fid)

war_q = deque()
queued_wars = set()


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def persist_frontier():
    # remaining factions still to crawl
    with open(FRONTIER, "w") as f:
        f.write("\n".join(str(x) for x in fac_q) + "\n")


def crawl_faction(fid):
    """Page through a faction's ranked-war history; enqueue wars + opponents."""
    offset = 0
    while True:
        url = ("https://api.torn.com/v2/faction/%d/rankedwars?limit=%d&offset=%d&key=%s"
               % (fid, PAGE, offset, KEY))
        try:
            d = fetch(url)
        except Exception as e:
            print("net-err fac=%d %s" % (fid, e), flush=True)
            time.sleep(5)
            return
        time.sleep(DELAY)
        if "error" in d:
            code = d["error"].get("code")
            if code in (5, 8, 9, 17):
                print("throttle fac=%d code=%s" % (fid, code), flush=True)
                time.sleep(15)
                continue
            return  # no access / bad id — give up on this faction
        wars = d.get("rankedwars", [])
        hit_old = False
        for w in wars:
            wid = w["id"]
            # recency filter: skip wars that ended before the cutoff
            if w.get("end", 0) < CUTOFF:
                hit_old = True
            elif wid not in scanned_wars and wid not in queued_wars:
                war_q.append(wid); queued_wars.add(wid)
            for fa in w.get("factions", []):
                oid = fa["id"]
                if oid not in done_facs and oid not in queued_facs:
                    fac_q.append(oid); queued_facs.add(oid)
        # lists are newest-first: once a page contains a pre-cutoff war, stop
        if hit_old or len(wars) < PAGE:
            break
        offset += PAGE


def distill(r):
    factions = []
    for f in r["factions"]:
        attacks = sorted((m.get("attacks", 0) for m in f["members"]), reverse=True)
        rw = f.get("rewards", {})
        factions.append({
            "id": f["id"], "name": f["name"], "won": f["id"] == r["winner"],
            "score": f["score"], "attacks_total": f.get("attacks"),
            "rank_before": f["rank"]["before"], "rank_after": f["rank"]["after"],
            "enlisted": len(f["members"]),
            "hits_pos": sum(1 for a in attacks if a > 0),
            "hits_ge10": sum(1 for a in attacks if a >= 10),
            "attacks_dist": attacks,
            "respect": rw.get("respect"), "points": rw.get("points"),
            "caches": [{"id": it["id"], "name": it["name"], "qty": it["quantity"]}
                       for it in rw.get("items", [])],
        })
    return {"war": r["id"], "start": r["start"], "end": r["end"],
            "winner": r["winner"], "forfeit": r["forfeit"], "factions": factions}


def fetch_report(wid):
    url = "https://api.torn.com/v2/faction/%d/rankedwarreport?key=%s" % (wid, KEY)
    try:
        d = fetch(url)
    except Exception as e:
        print("net-err war=%d %s" % (wid, e), flush=True)
        time.sleep(5)
        return False
    time.sleep(DELAY)
    if "error" in d:
        code = d["error"].get("code")
        if code in (5, 8, 9, 17):
            print("throttle war=%d code=%s" % (wid, code), flush=True)
            time.sleep(15)
            return False
        out_done.write("%d\n" % wid); out_done.flush()
        scanned_wars.add(wid)
        return None  # permanent miss
    rec = distill(d["rankedwarreport"])
    out.write(json.dumps(rec) + "\n"); out.flush()
    out_done.write("%d\n" % wid); out_done.flush()
    scanned_wars.add(wid); have_wars.add(wid)
    return True


out = open(OUT, "a")
out_done = open(DONE_WARS, "a")
out_facs = open(DONE_FACS, "a")

got = len(have_wars)
print("resume: have=%d wars, %d factions crawled, %d in frontier"
      % (got, len(done_facs), len(fac_q)), flush=True)

since_persist = 0
while got < TARGET and (war_q or fac_q):
    # prioritise fetching reports we've already discovered
    if war_q:
        wid = war_q.popleft()
        if wid in scanned_wars:
            continue
        res = fetch_report(wid)
        if res:
            got += 1
            if got % 25 == 0:
                print("reports=%d  war_q=%d  fac_q=%d" % (got, len(war_q), len(fac_q)),
                      flush=True)
    elif fac_q:
        fid = fac_q.popleft()
        queued_facs.discard(fid)
        if fid in done_facs:
            continue
        crawl_faction(fid)
        done_facs.add(fid)
        out_facs.write("%d\n" % fid); out_facs.flush()
        since_persist += 1
        if since_persist >= 10:
            persist_frontier(); since_persist = 0

persist_frontier()
print("DONE reports=%d  frontier_left=%d  facs_crawled=%d"
      % (got, len(fac_q), len(done_facs)), flush=True)
