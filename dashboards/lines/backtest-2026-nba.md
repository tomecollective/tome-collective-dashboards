# Backtest: the NBA model through November 20, 2026

Walk-forward replay of the tome-lines model over 230 NBA games, October 20 to November 20, 2026. Ratings were rebuilt before each slate from results before that date only, and every projection was measured against the line logged at pick time in The Record. The replay matched 97% of the published side leans and 98% of the published total leans, so it reflects what was printed.

Sample-size warning: at 230 games a true 50% process lands anywhere between about 43.5% and 56.5% by chance. Nothing below clears that bar on its own.

## The headline

| | Sides | Totals |
|---|---|---|
| Published record | 115-119 (49.1%) | 102-121 (45.7%) |
| Published, Strong tier | 43-51 (45.7%) | 14-19 (42.4%) |
| Market, as a forecaster (mean error, points) | 11.1 | 14.4 |
| Model before the retune (mean error, points) | 12.7 | 15.4 |
| Model after the retune (mean error, points) | 12.4 | 15.0 |

The line was a better forecast of the final than the model on both margin and total, before and after the retune. The model rates teams on final scores only; the line already has injuries and lineups in it.

## What was tested

36 combinations of recency half-life (12 days, 30 days, none), games to full trust (10, 20), per-game margin cap (none, 20, 15) and home court (2.0, 2.5), plus single sweeps of each and of the rest adjustment.

- Side record ranged from 44% to 51% across the grid and totals from 46% to 57%. All of it is inside the noise band.
- Mean error on margin ranged from 11.8 to 12.5 points, and on totals from 14.5 to 15.2. No combination matched the line.
- Changing settings flipped 81 of 230 side leans. The direction of the disagreement with the line is mostly noise.
- The size of the gap did not predict the result. Gaps of 10 points or more went 5-11 on sides.
- The model's miss against the line grew in November (13.4 points against the line's 11.3 from November 6), as more regular starters went out. The model cannot see injuries unless `adjust=` is passed, and the replay matched the published leans without any adjustment.

## What changed on November 21

Chosen for forecast error, not record:

| Setting | Before | After |
|---|---|---|
| `NBA_HALF_LIFE` | 12 (days) | 0 (no recency decay) |
| `NBA_PRIOR_GAMES` | 10 | 20 |
| `NBA_MARGIN_CAP` | none | 20 |
| `NBA_HCA` | 2.5 | 2.0 |

Home teams have outscored visitors by 1.2 points a game this season and the line has averaged home by 1.7, so 2.5 was high.

Tuned on October 20 to November 5 and checked on November 6 to 20, the slower, capped settings cut the margin error on the later half from 13.4 to 12.3 and the total error from 14.9 to 14.5 (the line: 11.3 and 13.8). Sides on the later half went 52-58 against 51-59 before, which is no real change. Expect a closer number, not a better record.

## What this does not fix

- Injuries. Pass `adjust=` on every slate; it is the only change with a mechanism behind it.
- The Strong tier. It covers about 40% of side leans and has been the weakest tier. A wide gap usually means the line knows something the model does not.

Do not tune these values again on a sample this size. Revisit once the season has 500 or more graded games, and judge the model by mean error against the line and by closing-line value before the record.

## Method notes

Finals and opening and closing lines from the worker's `/api/lines/market` cache, one call per day. Lines at pick time from `/api/lines/record?league=nba`. Three opening-night games did not join to a logged line and are out. Games where the line at pick was missing for a market are out for that market.
