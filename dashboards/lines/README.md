# tome-lines

A small Worker that puts a projection under every Tome lean, grades how confident that lean deserves to be, logs picks with the line at pick time, and grades them against final scores and the closing line. WNBA, NBA, NFL. Informational tooling; it never places or recommends anything.

## The Record (added Oct 10, 2026)

`GET /api/lines/record/summary[?asof=YYYY-MM-DD][&league=][&slate=YYYY-MM-DD]` returns every published cut in one call: per league, per segment (`<league>-<season>-regular|playoffs`, the reset boundary) the season-to-date side and total records with denominator, rate and an `early` flag under 20 leans; the slate (7 days through `asof`, or the one day given by `slate=`); chapters (NFL week, NBA month); tier rows gated at 20 segment leans and 8 per tier; the free/Intel split; closing-line value; voids; and the full ledger, one row per market. `POST /api/lines/void` (admin, `{league, game_id, reason}`) marks a card "no result". `tome_record.py` renders the recap block, the Monday rows and the page JSON from that one feed. Vocabulary is fixed: cleared / missed / push / no result; a push counts in neither side of a rate.

## Deploy (once)

```
mkdir tome-lines && cd tome-lines          # put worker.js and wrangler.toml here
npx wrangler kv namespace create LINES_KV  # paste the id into wrangler.toml
npx wrangler secret put BALLDONTLIE_API_KEY
npx wrangler secret put TOME_ADMIN_TOKEN
npx wrangler deploy
curl https://tome-lines.tomecollective.workers.dev/health
```

Connect it to the repo under Workers Builds like the others so a push deploys.

## How the projection works

Ratings come from final scores only, so the same code runs for all three leagues. Each team's rating is its average margin with home court removed and the opponent's rating added back, iterated to convergence (a recency-weighted SRS). Recent games count more: half-life of 10 games for WNBA, 12 for NBA, 4 for NFL. Playoff games count 1.5×. Teams with few games are shrunk toward league average (8 games WNBA, 10 NBA, 6 NFL before full trust), which matters for the NFL until mid-October.

Projected margin = rating gap + home court (2.5 WNBA/NBA, 1.5 NFL) + rest (back-to-back −1.5, one day −0.5, four-plus days +0.5; ignored for NFL) + any manual adjustment you pass. Projected total = each team's recency-weighted points for against the other's points allowed, centered on the live league average (computed from the season's results, not a constant; the constant version ran 13 points hot in the WNBA backtest), minus a playoff adjustment (WNBA −3, NBA −4; both guesses until we've logged a round).

Injuries are not automated in v1. Pass them: `&adjust=IND:-3,WAS:+1` means Indiana is 3 points worse than its rating tonight, Washington 1 better. Use on/off net rating if you have it; otherwise the player's share of scoring as a rough cut. Every adjustment you pass is echoed in the response so the preview can print it.

## Leans and confidence

Every game gets a pick on both markets. The size of the disagreement with the market sets the tier: **Strong** when |projection − market| is at least twice the threshold, **Lean** when it clears the threshold, **Coin flip** below it. Thresholds: 2.5 points on a side and 4 on a total for basketball, 1.5 and 3 for the NFL, so a WNBA side is Strong at 5+ points of disagreement and a total at 8+. Print the tier with the pick: "we make it Indiana −8, the line is −6.5. Lean Indiana, coin flip."

Read `backtest-2026-wnba.md` before leaning on the tiers. Over 122 WNBA games the model did not beat the market and the tiers did not separate cleanly; the tier is honest framing of how far we are from the book, not a proven edge yet. Log every pick with its tier and let `/api/lines/record` tell us whether Strong deserves the name after a real sample.

## The Card

`tome_card.py` turns one `/api/lines/projection` response into the block that sits under every game preview: the line (with movement since open), our number and the gap, each team's last ten against the number, rest and availability, where the public sits, and the lean with its tier. `python3 tome_card.py projection.json > cards.html` gives Beehiiv editor HTML; add `--preview` to eyeball it in a browser. Edit two things by hand per game: the "driven by" tag (the number, the news, or the market) and the one-line why. `card-example-2026-09-27.html` is a real slate.

### Free three, Intel for the rest

On nights with more than three games, the three most prominent games (national window, matchup) are free and the rest are Tome Intel. Prominence, never confidence: some nights the Strong leans are in the open, some nights they are not, and the teaser says so. `python3 tome_card.py projection.json --free 3` takes the first three in slate order; `--free-games BOS@NYK,LAL@DEN,MIL@PHI` names them. The output is: free cards (visible to everyone), one teaser section shown only to readers without a paid tier (which cards they are missing, the prominence rule, an upgrade button), then the Intel cards as sections visible to paid tiers only. Each Intel card is its own gated section, so nothing nests and the editor round-trips it cleanly. Write the why line for the free three; Intel cards carry the tier note unless there is real news.

`log_picks.py projection.json --free 3` logs the whole slate to the worker with tiers and `access: free|intel`, so The Record shows the Intel mark and the free-vs-Intel split. Use `--override AWAY@HOME:side=HOME,total=UNDER` where your lean differs from the model; it is stored as an override and graded like any other.

The Tome Sports daily template carries the same split under Today's leans: three free lines, a teaser for readers without Intel, and a gated "rest of the slate" list.

## The Record page

`the-record.html` is a static page for the dashboards repo. Set `API` at the top to the worker URL; it reads `/api/lines/record` per league and shows the record, the Strong-tier record, closing-line value, the by-tier table, and the full ledger with misses in the same font size. Link it from the Dashboards page and from the card's footer line.

## Market data

`/api/lines/market` pulls sportsbookreview's public odds page for a date: opening and current lines from eight books (DraftKings first, then FanDuel, BetMGM…), public pick percentages, and finals. Days are cached in KV (finished days forever). The projection call uses it automatically when you don't pass `lines`, and `/api/lines/trends` builds last-ten ATS and O/U from it. Run the backfill once per league so trends have history: `POST /api/lines/market/backfill?league=wnba&from=2026-08-01&to=2026-08-20` (20 days per call; the response gives `next_from`). A nightly cron caches yesterday and today so closing lines fill in on their own.

## Daily flow

**Preview (morning).** Call `/api/lines/projection?league=wnba&date=YYYY-MM-DD&lines=[...]&adjust=...` with the DraftKings numbers for each game (`{"game_id":..,"spread_home":-6.5,"total":177.5}`; spreads always quoted for the home team). Print, per game: the projection, the market, the edge, and the lean or no lean. When you override the model (you know something it doesn't), say so in the article and log the pick with `override: true`.

**Log each pick** with `POST /api/lines/pick` (header `X-Admin-Token`): league, game_id, side `HOME`/`AWAY`, `spread_home_at_pick`, `total_side` `OVER`/`UNDER`, `total_at_pick`, projected values, `side_tier`, `total_tier`, override flag. Log coin flips too; they are the control group.

**Before tip**, nothing. The nightly market cache supplies the closing line; `/api/lines/record` fills it in when grading. `POST /api/lines/close` still works if you want to log a specific number by hand.

**Recap.** `GET /api/lines/record?league=wnba&from=2026-09-27` returns the record, average closing-line value in points, model-vs-override split, the record by tier (`by_tier`), and every graded pick. Report record, CLV, and the Strong-tier record separately. Say "cleared" or "the record," never "won."

## What to expect

A pick on every game, most of them Coin flip or Lean; roughly a third of WNBA games came out Strong on sides in the backtest, far fewer on totals. A season of picks that average positive closing-line value is evidence of a process even through cold stretches; a record alone at this sample size isn't (122 games carries a ±9-point margin on a hit rate). Resist tightening or loosening thresholds on a bad week; change them on a bad month, and change one at a time.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | configured? |
| GET | `/api/lines/ratings?league=&asof=` | none | current ratings table |
| GET | `/api/lines/projection?league=&date=&lines=&adjust=` | none | projections and leans for a slate |
| POST | `/api/lines/pick` | admin | log a lean with the line at pick time |
| POST | `/api/lines/close` | admin | log the closing line |
| GET | `/api/lines/record?league=&from=` | none | graded record, CLV, model vs override |

`game_id` is BALLDONTLIE's id, returned by the projection call.

## Tunables

All in `wrangler.toml [vars]`: home court, half-lives, edge thresholds, playoff weight and total adjustments. Change, redeploy.
