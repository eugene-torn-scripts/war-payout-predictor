# War Payout Predictor

A Torn userscript that predicts the **cash value of a ranked-war cache** from a
faction's rank, win/loss, size and participation — with a built-in explainer for
how each variable moves the payout.

The formula isn't published by Torn. It was **reverse-engineered** by fitting
**9,699 real, recent ranked-war reports** (every war ending on/after
`2025-05-31`, pulled from the Torn API) with a multiplicative regression. Two
models, picked automatically:

- **Score model** — when you know your war score (mid/post-war). **R² = 0.915**,
  median error **16%**. Most accurate. Keys off score + how many members actually
  *fought* (≥10 hits) rather than enlisted roster.
- **Roster model** — pre-war planning, score unknown; driven by roster size and
  participation. **R² = 0.893**, median error 15%.

Both are **strictly monotonic** and floored at the minimum cache (1 Small Arms,
~$115m). Blown-out / very-low-participation factions land near that floor — the
tool flags them.

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
score known:   value = Base × Rank × Win × score^0.48 × fighters^0.20
score unknown: value = Base × Rank × Win × members^0.68 × (p+0.05)^0.49
```

where `fighters` = members who landed **≥10 scoring war hits** and `p` = `fighters` ÷ enlisted.
The score model deliberately uses *fighters*, not enlisted roster — the cache reflects who
actually fought, so a faction that fields 3 of 90 gets a near-minimum cache.

### What drives the payout

| Factor | Effect |
|---|---|
| **Rank** | Biggest lever — each tier ≈ 1.7× the one below (Unranked → Diamond III spans ×0.42 → ×3.0 of Gold I). |
| **War score** | The strongest effort signal. It **absorbs participation** — once you know the score, the fraction-of-members metric adds nothing. |
| **Win / Loss** | Winning ≈ **×2.24** (roster model). In the score model it's smaller (≈×1.75) — the *pure* win bonus, since score already reflects most of the win/loss gap. |
| **Faction size** | In the roster model, a power law `members^0.68` — **not** the often-quoted "+1% per member". The score model ignores enlisted roster entirely (only who *fought* matters). |
| **Participation / who fought** | The score model uses the count of members with ≥10 hits (`fighters^0.20`): at equal score, 100 fighters beats 10 by ≈+60%. More participation always helps — it raises both score and fighter count. |

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
| `fit_v4.py` | Final fit — score model keyed on fighters not roster (fixes blowout over-prediction); writes `data/model.json`. |

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
