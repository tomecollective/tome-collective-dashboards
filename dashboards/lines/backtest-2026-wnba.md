# Backtest: what tome-lines would have said, 2026 WNBA

Walk-forward replay of the model over every game Tome published a PICK block for: 122 games from July 28 to September 27 (the earlier June–July previews carried lines in prose without a stated pick, so they are out). For each game the ratings were rebuilt from results before that date only, projected against the DraftKings number printed in the preview, and graded on the final score. Parameters were the ones shipped in `wrangler.toml`: home court 2.5, half-life 10 games, side threshold 2.5, total threshold 4, playoff weight 1.5, playoff total adjustment −3. No closing lines exist for this window, so there is no CLV; this is hit rate only.

Sample-size warning up front: at 122 games a true 50% process lands anywhere between 41% and 59% by chance. Nothing below clears that bar on its own.

## The headline

| | Sides | Totals |
|---|---|---|
| Tome, as published | 61-61 (50.0%) | 67-55 (54.9%) |
| Model, pick on every game | 61-61 (50.0%) | 56-66 (45.9%) |
| Model, Strong only (≥5 side / ≥8 total) | 22-19 (53.7%) | 11-11 (50.0%) |
| Market, as a forecaster (mean error, points) | 9.2 | 12.4 |
| Model, as a forecaster (mean error, points) | 9.9 | 13.5 |

The last two rows are the honest one. DraftKings' number was a better forecast of the final than the model was, on both margin and total. A public-data power rating is not going to out-forecast a book that already has injuries, lineups, and sharp money in its number; the backtest says so plainly, and the tiers inherit that.

## What the tiers did

Side tiers, model pick graded:

| Disagreement with market | n | Record |
|---|---|---|
| Coin flip (< 1.25) | 27 | 15-12 |
| Lean (1.25–2.5) | 18 | 7-11 |
| Strong (2.5–5) | 36 | 17-19 |
| Strong (5+) | 41 | 22-19 |

Total tiers:

| Disagreement with market | n | Record |
|---|---|---|
| Coin flip (< 2) | 34 | 14-20 |
| Lean (2–4) | 26 | 9-17 |
| Strong (4–7) | 31 | 17-14 |
| Strong (7+) | 31 | 16-15 |

The tiers do not climb in order. Bigger disagreement was a hair better on sides and no better on totals, which is what you expect when the model's disagreement with the book is mostly the model's error rather than the book's. The shipped tiers (Strong at twice the threshold) are kept because they are the right shape to test, not because this sample validated them.

## The bug the backtest caught

The totals projection centers each team's scoring on a league-average constant. It was set to 82 points per team; this season's actual average was 87.2. Every projected total ran about 13 points hot, which would have made the model call OVER on 99 of 122 games and go 44-55 doing it. The worker now computes the league average from the season's own results, recency-weighted. The NBA constant (114) had the same exposure and the same fix. That alone justified running the replay.

## Things worth knowing that the model did not find

None of these is a system. Each is a pattern in one 122-game window that the tier logic should be aware of when we grade the WNBA playoffs and start the NBA.

Tome's totals record came from unders. Published unders went 42-28 (60%), overs 25-27. Taking the under on every game in this window would have gone 69-53; the average final landed a point below the market total. August was where it lived (all-under 49-30), September was near even (17-15).

Tome's side record split by favorite and dog. Leaning the favorite went 46-39 (54%), leaning the dog 15-22 (40%). The model had the identical shape: 34-27 on favorites, 27-34 on dogs. Favorites of 7.5 or more covered 32-22 (59%) in this window. In a league this top-heavy, the book may be shading big numbers toward the public dog; that is a hypothesis to log picks against, not a rule.

Half-life barely mattered. Sweeping 6 to 25 games and home court 2.0 to 3.0 moved the Strong-side record between 47% and 57%, all inside the noise band. Nothing in the parameter space rescues the model into an edge; do not tune it on this sample.

## What this means for the preview

Keep the pick on every game, as asked, with the tier printed next to it. Write the tier as what it is: distance from the book. "We make it Minnesota by 12; the line is −6.5. Strong lean Minnesota" tells the reader we are far from the market, and the record page will tell all of us, over a season, whether being far from the market has meant anything.

Treat unders and big favorites as the two market-side priors to watch, not to automate. When the model and one of those priors agree, say so in the copy; when the model is on a dog against a 7.5-point favorite, say that too. Once 150 or so picks are logged with tiers and closing lines, the `by_tier` block on `/api/lines/record` and the CLV averages become the evidence; until then the tiers are labels.

For the NFL and NBA, the same shape applies with less data early. Manual priors carry the NFL through Week 6 regardless of what the rating says, and NBA totals should be sanity-checked against the live league average in the projection response (`league_avg_pts`) for the first two weeks.

## Method notes

Games and finals from ESPN's public scoreboard, 332 regular-season and 2 playoff finals, preseason and the exhibition opponent excluded. Lines and picks parsed from the published preview pages (the `PICK / TEAM ±X / O/U Y / Over|Under` block, paired with the matchup heading above it). Two picks did not match a final (a postponed and a mis-dated game) and were dropped. Model code is a line-for-line port of `worker.js`; the port's totals were checked against the worker on the September 27 slate. Replay script: `backtest.py` in the session scratchpad; rows with every projection, edge, and result in `backtest_rows.json`.
