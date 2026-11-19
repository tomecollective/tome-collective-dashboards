# Tome Analytics: Fast Break

## Architecture
Two Cloudflare Workers share one KV namespace (`FASTBREAK_KV`):

- **`tome-fastbreak-refresh`** (`dashboards/fastbreak-refresh/`) — the only piece that
  talks to BALLDONTLIE. It builds the dashboard payload for any (league, date, mode) on
  demand, caches each day's raw inputs in KV, refreshes today's slate on a cron schedule,
  owns the objectives schedule + Rotowire projection uploads, and hosts the NBA Historic
  simulation (`worker/historic.js`).
- **`tome-fastbreak`** (`dashboards/fastbreak/`, this directory) — a thin public
  read/admin-write proxy over the same KV. `index.html` (GitHub Pages) calls the refresh
  Worker directly; this Worker is a cheap fallback that serves the last cron-cached slate.

## Modes (single-select toggle)
`WNBA Classic · WNBA Pro · NBA Classic · NBA Pro · NBA Historic · Full Data`

- **WNBA and NBA** run through the same live pipeline. Everything league-specific lives in
  the `LEAGUES` table at the top of `fastbreak-refresh/worker/index.js`: API base
  (`/wnba/v1` vs `/v1`), score fields (`home_score` vs `home_team_score`), status
  normalization (WNBA `pre/in/post` vs NBA `"Final"/"1st Qtr"/status_state`), season
  numbering (WNBA = calendar year; NBA 2026 = 2026-27), L10 lookback (NBA reaches back
  240 days so opening week shows last season's L10), run window, and KV keys.
- **Runs.** WNBA Run 11 = Sept 17–24, 2026 (post-World-Cup regular-season finish). NBA Run 1
  = Oct 20–26, 2026 (opening week). Each league's window is independent, so the WNBA
  playoffs and NBA season start can overlap. Change a window in `LEAGUES[].run`; the
  frontend reads it from `/api/fastbreak/run?league=ALL` (with a matching fallback in
  `index.html`'s `RUNS`).
- **Classic vs Pro** differ only in their objective sets (and Pro's badge/set label).
  Rotowire projections are uploaded once per league/date and shared by both.
- **Pulled projections (D1).** Besides the admin paste form, projections can land in the
  `PROJECTIONS_DB` D1 database (`dashboards/fastbreak-refresh/migrations/0001_projections.sql`),
  written by the RotoWire pull with no admin password. Only the night's objective stats are
  pulled. The refresh Worker overlays those rows on the KV uploads for the same league/date/stat
  (pulled value wins per player; manual-only players stay) and picks them up on its next
  15-minute tick. Without the binding the Worker behaves exactly as before.
- **League switch (FB-3).** `/api/fastbreak/run` reports `enabled` per league (KV
  `fastbreak:league:enabled`; NBA defaults OFF, WNBA ON). A disabled league's Classic/Pro
  buttons are greyed out on the page. Objectives Admin → "League Status" flips it and
  "Check NBA key" probes `/players/active` + advanced stats with the current BALLDONTLIE key.
  Turn NBA on only after the key is upgraded (GOAT for PITP), ideally 24h before Oct 20 so the
  cron has opening night cached.
- **NBA Historic** is a simulated season with its own `fastbreak:historic:*` keys. The
  public toggle is greyed out until `HISTORIC_ENABLED` in `index.html` is flipped; it is
  fully manageable from Objectives Admin in the meantime (seed upload, per-day objectives,
  advance day).
- **Full Data** has a WNBA/NBA sub-toggle; each league's leaguewide build is separate.

## Resumable day builds (why the NBA tab doesn't drop players)
A full NBA slate is 300–450 active players ≈ 80+ BALLDONTLIE calls, past the Cloudflare
Free plan's 50-subrequests-per-invocation ceiling. Each (league, date) build is persisted
in KV as it goes (`<dayPrefix><date>:build`) and resumed by the next request or cron tick
until every player is loaded; the finished snapshot (`<dayPrefix><date>`) then serves both
Classic and Pro with zero API calls for 30 minutes (6 hours for past dates). While a
rebuild is in flight the last complete snapshot keeps being served (`refreshing: true`);
a first-ever build returns partial players with `building: true` + `progress`, and the
frontend polls every 2.5s until done. "Rebuild a Day's Data" in the admin forces a
re-pull (`POST /api/fastbreak/day/invalidate`).

Early in a season YTD is a subset of L10, so one stats query covers both. Later, YTD is
paged up to `YTD_STAT_PAGES_PER_CHUNK` (3 pages = 30 games/player); beyond that YTD is
best-effort from the earliest games and the payload note says so. L10 is always complete.

## Cron
`wrangler.toml` declares two schedules — `*/30 * * * *` (WNBA) and `7-59/15 * * * *`
(NBA) — and `scheduled()` maps `event.cron` back to a league via `LEAGUE_CRONS`. A tick is
a no-op outside that league's `seasonActive` window, refreshes today's slate otherwise,
and spends the leftover budget on that league's Full Data build. All "today" logic is
Eastern Time via `Intl` (handles the EDT/EST switch in November).

## API (refresh Worker)
| Route | Notes |
|---|---|
| `GET /api/fastbreak?league=&date=&mode=` | Live view (serve-or-advance). |
| `GET /api/fastbreak/run?league=ALL` | Run windows + `enabled` per league (ungated). |
| `GET /api/fastbreak/health` | Cron heartbeat + snapshot ages for the healthcheck (ungated). |
| `POST /api/fastbreak/admin/verify` | Admin password check for the page's unlock gate. |
| `GET /api/fastbreak/league/status` · `POST …/league/enable` · `POST …/league/keycheck` | League switch + key probe (admin). |
| `GET /api/fastbreak/objectives` | Whole schedule, keyed `schedule[league][date]`. |
| `POST /api/fastbreak/objectives/day` | `{league, date, mode, objectives, badgeSetName}` |
| `POST /api/fastbreak/objectives/day/projections` | `{league, date, stat, projections}` |
| `POST /api/fastbreak/day/invalidate` | `{league, date}` |
| `GET /api/fastbreak/fulldata?league=` · `POST …/fulldata/build?league=` · `GET …/fulldata/status?league=` | Per-league Full Data. |
| `GET /api/fastbreak/historic?day=` · `GET …/historic/status` | Historic public + status. |
| `POST /api/fastbreak/historic/seed` · `POST …/historic/objectives/day` · `POST …/historic/advance` | Historic admin. |
| `POST /api/fastbreak/historic/auto/run` | `{contestId, dryRun}` load one Historic day's box scores now (admin; `dryRun` defaults to true). |
| `GET /api/fastbreak/export/today[.md\|.json]` · `GET …/export/<table>.csv\|.json` | Read-only table exports (see below). Export gate. |

POSTs require the `X-Admin-Token` header (`FASTBREAK_ADMIN_TOKEN` secret). The admin
password is never in `index.html`: the admin panel POSTs what was typed to
`/api/fastbreak/admin/verify` and keeps it in memory for the page's lifetime only.

## Subscriber gate
Every data read (`/api/fastbreak`, `/objectives` GET, `/fulldata`, `/historic`) requires
`X-Tome-Key` (or `?key=`) matching one of the comma-separated values in the
`TOME_SUBSCRIBER_KEYS` secret (set on both Workers; unset = 503, fails closed). The key rides
on the embed URL inside the subscriber post (`index.html?key=...`); the page moves it to
`sessionStorage`, strips it from the address bar and sends it as a header. Rotate by setting
`old,new` for an overlap window, updating the post, then dropping `old`.

Public (subscriber) reads are **serve-only**: they never spend BALLDONTLIE calls. The cron
refreshes today's slate and pre-builds the next stale run date each tick
(`warmUpcomingRunDate`), so a date is normally cached before anyone opens it; an uncached date
returns `queued: true` and the page polls every 60s. An admin-unlocked page (X-Admin-Token)
still builds on demand.

`[[ratelimits]]` in each `wrangler.toml` adds a per-IP 60 req/min limit (Workers Rate
Limiting binding, `PUBLIC_RATE_LIMITER`); the Workers skip the check if the binding is absent.

## Historic box scores (automatic)
`worker/historic-auto.js` adds each Historic day's box scores to the optimizer dataset
(`fastbreak:historic:optimizer`) on its own, so the nightly results upload is no longer needed.

- **When:** cron `3-58/5 0-9 * * *` (its own invocation). Each tick reads Top Shot's public
  Fast Break page (`nbatopshot.com/fastbreak?league=simulation`, plain fetch, no sign-in), which
  embeds every contest of the run with its games, start times and statuses. A day loads at the
  first tick 15 minutes or more after its last game starts, once every game is Final. Between
  days a tick is one KV read.
- **How:** Cloudflare Browser Run (`[browser] binding = "BROWSER"`, Quick Actions `content`)
  opens the same public page for that contest, clicks each game's Box score button and reads
  the tables. One run per day, about 30 seconds of browser time (Workers Free includes 10
  minutes a day). No Top Shot API call, no account, no admin token.
- **What changes:** every matched player gets one `s` row (in `statCodes` order) and one `g`
  game, rescored with the same 2026-27 weights and 1.5 turnover estimate as
  `dashboards/lines/build_historic_day.py`. Prices, AVG and slates are untouched: the next
  day's roster still comes from the roster-builder paste. Box-score players not in the
  dataset are listed as unmatched and skipped.
- **Never twice:** the dataset records `boxScoreContests`; `fastbreak:historic:auto` keeps the
  run log. Days that had already ended when the automation first ran are marked skipped and
  never backfilled. Four failed tries on a day and it stops and logs the error.
- **Watch it:** `GET /api/fastbreak/health` now includes `historicAuto` (last run, next day due,
  last error, unmatched names).
- **Risk:** it reads the page, not a published feed, so a Top Shot redesign can break it. It
  fails closed (nothing saved) and the manual upload still works.

## KV keys
`fastbreak:objectives` (all leagues) · `fastbreak:latest` / `fastbreak:nba:latest` ·
`fastbreak:day:<date>[:build]` / `fastbreak:nba:day:<date>[:build]` ·
`fastbreak:fulldata[:build]` / `fastbreak:nba:fulldata[:build]` · `fastbreak:historic:*`
(including `fastbreak:historic:optimizer` and the box-score log `fastbreak:historic:auto`).

## BALLDONTLIE tiers
Box scores, active rosters and injuries need ALL-STAR. PITP comes from the advanced-stats
endpoints; on the NBA side (`/nba/v2/stats/advanced`) that is GOAT tier — if the key lacks
it the build fails soft and PITP shows `--` with a note, rather than breaking the slate.

## Local verification (no Cloudflare account needed)
- `node dashboards/fastbreak-refresh/worker/_local_test.mjs` — mocks BALLDONTLIE (both
  league shapes) and KV; covers the pure helpers, a 384-player NBA slate finishing across
  multiple calls with nobody dropped, a WNBA PITP day, Pro served from cache, PITP-change
  invalidation, the HTTP surface, and cron dispatch.
- `node dashboards/fastbreak/_frontend_test.mjs` — headless Chromium against mocked Worker
  routes; covers the six-way toggle, per-league run days, building→done polling, Full Data
  league sub-toggle, and the five-mode admin (`CHROMIUM_PATH=` to point at a local
  Chromium; needs `npm i playwright`).

## Deploy
1. Create the shared KV namespace once (`wrangler kv:namespace create FASTBREAK_KV`) and put
   its id in **both** `wrangler.toml` files.
2. Secrets on the refresh Worker: `BALLDONTLIE_API_KEY`, `FASTBREAK_ADMIN_TOKEN`,
   `TOME_SUBSCRIBER_KEYS` (also `FASTBREAK_ADMIN_TOKEN` + `TOME_SUBSCRIBER_KEYS` on the public
   Worker).
3. `cd dashboards/fastbreak-refresh && wrangler deploy` (this registers both crons), then
   `cd dashboards/fastbreak && wrangler deploy`.
4. Push `index.html` to GitHub Pages. Existing WNBA KV data keeps working unchanged
   (`fastbreak:objectives` is already keyed by league; old `fastbreak:latest` is reused).

## Known follow-ups
- Historic Ovr Rank is an equal-weight L10 average; porting `computeAutoWeights` is noted.
- Top Shot badge/set filtering for Pro waits on a Flow/Cadence moment-ownership integration.
- "Top 10 Players by Utilization" tile (Top Shot's own Fast Break page signal) is unbuilt.
- WNBA playoffs (Sept 27+) will need a new run window (`LEAGUES.WNBA.run`).

## Table exports (automatic, read-only)
`worker/exports.js` builds the same tables as the page's **Download CSV** buttons, on the
Worker, from its own data, so they no longer have to be downloaded and passed around by hand.
They refresh on their own: Classic/Pro read the day snapshot the NBA cron keeps fresh (every
15 minutes in season, upcoming run dates pre-built); Historic reads the optimizer dataset that
the box-score automation and the morning price script update. No BALLDONTLIE calls.

| URL (refresh Worker) | What |
|---|---|
| `/api/fastbreak/export/today` (`.md`, default, or `.json`) | Every table for one date in one response: Classic, Pro, and (NBA) the Historic top projected lineup + alternates and today's slate. Built for the article-drafting chat. |
| `/api/fastbreak/export/classic.csv` · `pro.csv` | The day table, page columns, Ovr Rank order, OUT last; Pro hides players with no Moment in tonight's sets when the set list is verified. |
| `/api/fastbreak/export/historic-slate.csv` · `historic-players.csv` | Historic tables at **no collector discount** (Your RP = Base RP). |
| `/api/fastbreak/export/historic-lineup.csv` | The no-discount optimal lineup (by blend) and up to two alternates, as on the page. |
| `/api/fastbreak/export/historic-results.csv` | Yesterday's Historic results: every player's Fast Break score and line from the slate before the selected one, the lineup the data had on top going in, and `lineup=Name1,Name2,...` totalled. |

Classic/Pro carry each objective's team target (`dailyTeamTarget`, and the per-player share) and
`targetSet`: false means no target was entered for that date and mode yet, so the number is the
dashboard default, and the Markdown says so.

**Yesterday's results.** When the box-score automation loads a day it also writes
`fastbreak:historic:results:<YYYY-MM-DD>` (the day's ET date): every box-score player's line and
Fast Break score, and the no-discount top lineup from the data as it stood before the games. The
exports read it for the slate before the one shown. A day loaded by hand has no record, so the
export falls back to each slate player's most recent game and labels it. Scores use the 1.5
turnover estimate (Top Shot's box score has no turnovers), so they can differ a little from
Top Shot's own.

Every table also comes as `.json`. Query: `league` (default `NBA`), `date=YYYY-MM-DD` (default
today ET); Historic tables also take `slate=<index>` and pick the page's default day otherwise.

**Access.** Anything that opens the subscriber data opens the exports (`?key=` subscriber key,
`X-Tome-Sub`, admin token). Optionally set an export-only key that opens these routes and
nothing else, for a bookmarked URL you can rotate on its own:
`wrangler secret put TOME_EXPORT_KEYS` (comma-separated), then use `?key=<that key>`.

The Historic math is a copy of the page's (`hxPrepare`, `hxBest`, `hxOptimize`);
`worker/_exports_test.mjs` pulls those functions out of `index.html` and checks the Worker gets
the same numbers, so change them together.
