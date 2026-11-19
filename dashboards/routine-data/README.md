# tome-routine-data (D1)

Database `tome-routine-data`, id `d38e62ae-d35e-4366-9fc1-bfbb4473bc92`, binding `ROUTINE_DB`.

## Why it exists

The scheduled Claude routines (preview, recap and Tome Sports drafts, the Spike Reports, the
Tome Cards Chase Index tiles, the morning health check) run in a sandbox whose network proxy
refuses `*.workers.dev`. Their shell `curl` gets `CONNECT tunnel failed, response 403`. Their
page fetcher can sometimes reach a Worker URL, but it paraphrases JSON instead of returning it,
can't send `X-Tome-Sub`, and on Nov 19 returned a server error for the NFL projection. The
Cloudflare connector, though, can query D1. So three Workers copy what the routines read into
this database on their existing crons, and the routines read it with `d1_database_query`.

| Writer | When | What |
| --- | --- | --- |
| tome-lines | every cron (`20 * * * *`, `10 6 * * *`, new `45 6 * * *`) | `/api/lines/projection` for today and tomorrow (US Central) per in-season league; `/api/lines/record/summary` as of yesterday and today (ledgers dropped) |
| tome-tcg | each tick of the 10:00 UTC hour, and right after publish | public (teaser) `/api/chase-index` payload |
| tome-proxy | end of the daily 10:00 UTC pipeline | the day's Near Mint price snapshot per game, card names/sets/rarities; first run backfills 21 days from KV |

Each Worker runs exactly as before without the binding. Schema: `migrations/0001_init.sql`
(already applied). Manual refresh, admin token required: `POST /api/lines/mirror` on tome-lines,
`POST /api/mirror` on tome-tcg.

## Reading it (what the routines run)

Projection for a slate, one row per game:

```sql
SELECT home, away, home_nick, away_nick, projected_spread_home, projected_total,
       market_spread_home, market_total, side, side_tier, total, total_tier, captured_at
FROM projection_games WHERE league = 'nba' AND for_date = '2026-11-19' ORDER BY game_id;
```

Full projection response (card block, trends, rest) and its freshness:

```sql
SELECT captured_at, status, last_error, last_error_at, body
FROM feed_snapshots WHERE feed = 'lines.projection' AND league = 'nba' AND for_date = '2026-11-19';
```

Record summary as of a date (same JSON as `/api/lines/record/summary?asof=`, minus each segment's `ledger`):

```sql
SELECT captured_at, body FROM feed_snapshots
WHERE feed = 'lines.record_summary' AND league = '' AND for_date = '2026-11-18';
```

Chase Index, newest:

```sql
SELECT for_date, captured_at, json_extract(body, '$.indexHistory') AS index_history
FROM feed_snapshots WHERE feed = 'tcg.chase_index' ORDER BY for_date DESC LIMIT 1;
```

Spike Report universe and 7-day move (game is `pokemon`, `disney-lorcana` or `one-piece-card-game`):

```sql
WITH e AS (SELECT MAX(date) AS d FROM tcg_prices WHERE game = 'pokemon'),
     s AS (SELECT MAX(date) AS d FROM tcg_prices WHERE game = 'pokemon' AND date <= date((SELECT d FROM e), '-7 days'))
SELECT c.name, c.set_name, c.rarity, c.number, c.tcgplayer_id,
       p0.price AS start_price, p1.price AS end_price,
       ROUND(100.0 * (p1.price - p0.price) / p0.price, 1) AS move_pct
FROM tcg_prices p1
JOIN tcg_prices p0 ON p0.game = p1.game AND p0.card_id = p1.card_id AND p0.date = (SELECT d FROM s)
JOIN tcg_cards c ON c.game = p1.game AND c.card_id = p1.card_id
WHERE p1.game = 'pokemon' AND p1.date = (SELECT d FROM e) AND p1.price >= 10
ORDER BY ABS(move_pct) DESC;
```

Daily series for one card (replaces `/history`):

```sql
SELECT date, price FROM tcg_prices WHERE game = 'pokemon' AND card_id = ?1 ORDER BY date;
```

Health: last run per Worker and freshness per feed:

```sql
SELECT worker, MAX(ran_at) AS last_run FROM mirror_runs GROUP BY worker;
SELECT feed, league, MAX(for_date) AS newest, MAX(captured_at) AS captured FROM feed_snapshots GROUP BY feed, league;
SELECT game, MAX(date) AS newest FROM tcg_prices GROUP BY game;
```
