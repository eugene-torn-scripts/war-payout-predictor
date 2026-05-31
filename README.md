# War Payout Predictor

A Torn userscript that predicts the **cash value of a ranked-war cache** from a
faction's rank, win/loss, size and participation — with a built-in explainer for
how each variable moves the payout.

The formula isn't published by Torn. It was **reverse-engineered** by fitting
**9,699 real, recent ranked-war reports** (every war ending on/after
`2025-05-31`, pulled from the Torn API) with a multiplicative regression. It
explains **R² = 0.894** of the variation, and the median prediction lands within
**13%** of the actual payout.

## Install

Desktop (Tampermonkey / Violentmonkey) or **Torn PDA**:

1. Install a userscript manager.
2. Add [`war-payout-predictor.user.js`](war-payout-predictor.user.js) (raw → Install).

No API key required — everything is entered manually. The panel opens from the
shared eugene-scripts button in Torn's footer, and is fully responsive (it goes
full-screen on mobile / PDA).

## The formula

Reward is **multiplicative** — each factor scales the total:

```
value($) = BaseUnit
           × Rank          (relative to Gold I = 1.000; ~1.7× per tier)
           × 2.29 ^ won    (win = ×2.29, loss = ×1)
           × members^0.65  (faction size — a power law, NOT "+1%/member")
           × exp(3.37·p − 2.55·p²)   (participation modifier, peaks ~p=66%)
```

where `p` = fraction of enlisted members who landed **≥10 scoring war hits**.

### What drives the payout

| Factor | Effect |
|---|---|
| **Rank** | Biggest lever — each tier ≈ 1.7× the one below (Unranked → Diamond III spans ×0.42 → ×3.13 of Gold I). |
| **Win / Loss** | Winning multiplies the cache by ~**2.29×**. |
| **Faction size** | Power law `members^0.65` — doubling your roster ≈ ×1.56. (The common "+1% per member" claim is **wrong**.) |
| **Participation** | Fraction with ≥10 hits; modifier climbs to **~×3** and plateaus near 66%. |

### What's *not* modelled

Two real bonuses can't be read from war reports, so they sit in the ~11%
unexplained residual: the **underdog bonus** (out-statted by the enemy) and the
**loss-streak bonus** (winning after consecutive losses). Most wars land within
±35% of the prediction; unusual ones can be up to ~2× off.

## Reproducing the formula

The `collector/` directory holds the full pipeline (Python, stdlib only):

| Script | Purpose |
|---|---|
| `crawl.py` | Snowball-crawl recent ranked-war reports via the Torn API into `data/reports.jsonl` (resumable, rate-limited, recency-filtered). |
| `coverage.py` | Summarise rank / size / participation coverage of the dataset. |
| `analyze.py` | Exploratory: median cache value by rank, win/loss, size, participation. |
| `fit.py` | Multiplicative OLS; compares size specifications; prints the per-rank table. |
| `fit_final.py` | Final fit + backtest; writes `data/model.json`. |

The raw dataset (`data/reports.jsonl`, ~6 MB) is git-ignored but fully
regenerable: point `crawl.py` at a Torn API key (Public scope is enough — it
reads any faction's war report) and re-run. The fitted `data/model.json` and the
cache prices used are committed.

## Caches & valuation

Caches are valued at Torn item-market averages (Small Arms → Heavy Arms). The
absolute `$` figure tracks the live market, but the multipliers don't. Values
are **faction gross** — not an individual member's cut, which each faction
splits by its own rules.

## License

GPL-3.0-or-later. Like the script? Send a Xanax to
[eugene_s [4192025]](https://www.torn.com/profiles.php?XID=4192025).
