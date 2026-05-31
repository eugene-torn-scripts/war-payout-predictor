# War Payout Predictor

A Torn userscript that predicts the **cash value of a ranked-war cache** from a
faction's rank, win/loss, size and participation — with a built-in explainer for
how each variable moves the payout.

It uses the **official Torn-wiki formula structure**, with the constants fitted
to **9,699 real, recent ranked-war reports** (every war ending on/after
`2025-05-31`, pulled from the Torn API):

```
cache = Base(rank) × 2^win × (1 + 1%·(members−10)) × Participation(×0–3)
```

- **Win ×2 / loss ×1** and **+1% per member** beyond 10 are the wiki's fixed factors.
- **Participation ×0–×3** comes from your **score-share vs the opponent** (the
  wiki's own description) — a dominated faction collapses toward ×0 (floor cache),
  a dominant one approaches ×3.
- **Base(rank)** is fitted and is the dominant lever.

Two modes, picked automatically:
- **Score model** — both war scores known (mid/post-war). **R² = 0.909**, median
  error **17%**. Participation from score-share.
- **Roster model** — pre-war, scores unknown. **R² = 0.831**. Participation
  estimated from the ≥10-hit member fraction (`3·p^0.36`).

Predictions are floored at the minimum cache (1 Small Arms, ~$115m).

## Install

Desktop (Tampermonkey / Violentmonkey) or **Torn PDA**:

1. Install a userscript manager.
2. Add [`war-payout-predictor.user.js`](war-payout-predictor.user.js) (raw → Install).

No API key required — everything is entered manually. The panel opens from the
shared eugene-scripts button in Torn's footer, and is fully responsive (it goes
full-screen on mobile / PDA).

## The formula (wiki structure)

Reward is **multiplicative** — the documented Torn-wiki factors, with fitted constants:

```
cache = Base(rank) × 2^win × (1 + 1%·(members−10)) × Participation(×0–3)
```

### What drives the payout

| Factor | Effect |
|---|---|
| **Base (rank)** | Biggest lever — fitted per rank/division, roughly doubling every couple of ranks (Gold I base ≈ $0.22b; Diamond ≈ $0.6–0.8b). |
| **Win / Loss** | **×2 / ×1** — the wiki value, fixed. |
| **Faction size** | **+1% per member** beyond the 10-member minimum — the wiki value, fixed (a small lever). |
| **Participation** | **×0–×3**, from your **score-share vs the opponent** (the wiki mechanic). 5% share → ×0.3 (dominated → floor), ~50%+ → ×2.9–3.0. Pre-war it's estimated from the ≥10-hit member fraction as `3·p^0.36`. |

### What's *not* modelled

Two real bonuses can't be read from war reports, so they sit in the unexplained
residual: the **underdog bonus** (out-statted by the enemy) and the
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
| `fit_final.py` | Earlier single-model fit + backtest (superseded by `fit_v2.py`). |
| `fit_v2.py` | Two-model fit (score & roster); superseded by `fit_v3.py`. |
| `fit_v3.py` | Adds hit-spread term + confidence bands (superseded by `fit_v4.py`). |
| `fit_v4.py` | Score model keyed on fighters not roster (superseded by `fit_v5.py`). |
| `fit_v5.py` | Final fit — imposes the wiki structure (win 2×, +1%/member, ×0–3 score-share participation, per-rank base); writes `data/model.json`. |

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
