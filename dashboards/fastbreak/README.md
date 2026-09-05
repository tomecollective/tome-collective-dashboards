# Tome Analytics: Fast Break

## Architecture
Two Cloudflare Workers share one KV namespace (`FASTBREAK_KV`):

- **`tome-fastbreak-refresh`** (`dashboards/fastbreak-refresh/`) — the only piece that
  talks to BALLDONTLIE. It builds the dashboard payload for any (league, date, mode) on
  demand, caches each day's raw inputs in KV, refreshes today's slate on a cron schedule,
  owns the objectives schedule + Rotowire projection uploads, and hosts the NBA Historic
  simulation (`worker/historic.js`).
- **`tome-fastbreak-dashboard`** (`dashboards/fastbreak/`, this directory) — a thin public
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
`wrangler.toml` declares two schedules — `*/15 * * * *` (WNBA) and `7-59/15 * * * *`
(NBA) — and `scheduled()` maps `event.cron` back to a league via `LEAGUE_CRONS`. A tick is
a no-op outside that league's `seasonActive` window, refreshes today's slate otherwise,
and spends the leftover budget on that league's Full Data build. All "today" logic is
Eastern Time via `Intl` (handles the EDT/EST switch in November).

## API (refresh Worker)
| Route | Notes |
|---|---|
| `GET /api/fastbreak?league=&date=&mode=` | Live view (serve-or-advance). |
| `GET /api/fastbreak/run?league=ALL` | Run windows for the frontend. |
| `GET /api/fastbreak/objectives` | Whole schedule, keyed `schedule[league][date]`. |
| `POST /api/fastbreak/objectives/day` | `{league, date, mode, objectives, badgeSetName}` |
| `POST /api/fastbreak/objectives/day/projections` | `{league, date, stat, projections}` |
| `POST /api/fastbreak/day/invalidate` | `{league, date}` |
| `GET /api/fastbreak/fulldata?league=` · `POST …/fulldata/build?league=` · `GET …/fulldata/status?league=` | Per-league Full Data. |
| `GET /api/fastbreak/historic?day=` · `GET …/historic/status` | Historic public + status. |
| `POST /api/fastbreak/historic/seed` · `POST …/historic/objectives/day` · `POST …/historic/advance` | Historic admin. |

POSTs require the `X-Admin-Token` header (`FASTBREAK_ADMIN_TOKEN` secret).

## KV keys
`fastbreak:objectives` (all leagues) · `fastbreak:latest` / `fastbreak:nba:latest` ·
`fastbreak:day:<date>[:build]` / `fastbreak:nba:day:<date>[:build]` ·
`fastbreak:fulldata[:build]` / `fastbreak:nba:fulldata[:build]` · `fastbreak:historic:*`.

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
2. Secrets on the refresh Worker: `BALLDONTLIE_API_KEY`, `FASTBREAK_ADMIN_TOKEN`
   (also `FASTBREAK_ADMIN_TOKEN` on the public Worker).
3. `cd dashboards/fastbreak-refresh && wrangler deploy` (this registers both crons), then
   `cd dashboards/fastbreak && wrangler deploy`.
4. Push `index.html` to GitHub Pages. Existing WNBA KV data keeps working unchanged
   (`fastbreak:objectives` is already keyed by league; old `fastbreak:latest` is reused).

## Known follow-ups
- Historic Ovr Rank is an equal-weight L10 average; porting `computeAutoWeights` is noted.
- Top Shot badge/set filtering for Pro waits on a Flow/Cadence moment-ownership integration.
- "Top 10 Players by Utilization" tile (Top Shot's own Fast Break page signal) is unbuilt.
- WNBA playoffs (Sept 27+) will need a new run window (`LEAGUES.WNBA.run`).
