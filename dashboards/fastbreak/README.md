# Tome Analytics: Fast Break

## Architecture
Two Cloudflare Workers share one KV namespace (`FASTBREAK_KV`):

- **`tome-fastbreak-refresh`** (`dashboards/fastbreak-refresh/`) — the only piece that
  talks to BALLDONTLIE. On a cron schedule (and via a manual `GET /` for testing) it
  builds the full dashboard payload — schedule tiles, per-objective Proj/YTD/L10, color
  tiers, and one weighted Ovr Rank per player — and writes it to `FASTBREAK_KV` under
  `fastbreak:latest`. It also owns the admin objectives schedule at
  `fastbreak:objectives`.
- **`tome-fastbreak-dashboard`** (`dashboards/fastbreak/`, this directory) — the public
  Worker `index.html` actually calls. It only reads/writes `FASTBREAK_KV`; it never
  calls BALLDONTLIE directly, so it stays fast regardless of refresh cadence.

## What's live
- **League / Mode toggle.** NBA and Historic are disabled (season not in progress /
  not built yet). WNBA + Classic/Pro are selectable; both currently read the same live
  data — see the `TODO(mode)` in the refresh Worker's source for where Classic vs. Pro
  will eventually diverge (e.g. Pro unlocking Top Shot badge/set filtering once the
  Cadence/Flow moment-ownership integration exists — intentionally not built yet).
- **Game schedule tiles.** ESPN-style row above the table (matchup + time), pulled from
  the same BALLDONTLIE `/games` data used for opponents and the L10/YTD game windows.
- **Objectives admin view.** Reachable via the "Objectives Admin" toggle on the main
  page. The schedule table itself is visible to anyone (it's a locked *view*, not a
  secret); the only way to change it is the form at the bottom, which requires the
  admin token (`X-Admin-Token` header, checked against the `FASTBREAK_ADMIN_TOKEN`
  secret). There's no code path that lets someone edit the schedule by hand-editing
  page content.
- **Proj = L10 average**, for every objective, including PITP. This matches what was
  being done manually. **This is intentionally the simplest honest version** — see the
  `TODO(projections)` comment in `dashboards/fastbreak-refresh/worker/index.js`. A real
  pace/matchup/usage-adjusted projection model is a separately-scoped future build, not
  something guessed at here.
- **YTD / L10 from BALLDONTLIE**, including PITP via `player_game_advanced_stats`
  (`stats.misc.points_paint`) when PITP is one of the day's objectives.
- **Weighted Ovr Rank.** When a day has two objectives, players get ranked separately
  within each objective (standard competition ranking on Proj, descending), then those
  ranks combine using that day's weights into a single combined score — one Ovr Rank
  per player, never separate per-objective leaderboards.
- **5-tier color coding** on every Proj/YTD/L10 cell, against that day's per-player
  target (`dailyTeamTarget / 5`): dark green ≥125%, light green ≥100%, yellow ≥90%,
  light yellow ≥75%, no fill below 75%.
- **Every column is sortable** by clicking its header (Player/Team/Opp, every
  objective's Proj/YTD/L10, and Ovr Rank).

## Explicitly not built yet
Top Shot badge/set filtering for the Pro tab. That depends on real Top Shot
moment-ownership data (the Cadence/Flow blockchain integration), which doesn't exist
yet. Building filter UI now would show either fake data or an empty state — waiting
until the real data integration lands.

## Rotowire
Dropped entirely. The long-term plan is in-house projections generated from
BALLDONTLIE data (see `TODO(projections)` above), not a third-party dependency.

## Local verification (no live Cloudflare account needed)
- `node dashboards/fastbreak-refresh/worker/_local_test.mjs` — mocks BALLDONTLIE and KV,
  exercises the pure ranking/color-tier/weight logic and a couple of full
  `buildDashboard()` runs (single-objective PITP day, two-objective weighted day,
  unconfigured-day fallback).
- `node dashboards/fastbreak/_frontend_test.mjs` — drives `index.html` in headless
  Chromium against mocked Worker responses: toggle disabling, game tiles, Proj===L10,
  color classes, header-click sorting (including a per-objective column), the admin
  view's reachability, and the admin save flow (wrong token rejected, correct token
  posts a real request rather than mutating the DOM).

Both are dev-only scripts, not part of the deployed Worker bundles.

## Deploy
1. Create the shared KV namespace once: `wrangler kv:namespace create FASTBREAK_KV`,
   then put the printed id into **both** `dashboards/fastbreak/wrangler.toml` and
   `dashboards/fastbreak-refresh/wrangler.toml`.
2. Set secrets on the refresh Worker: `wrangler secret put BALLDONTLIE_API_KEY` and
   `wrangler secret put FASTBREAK_ADMIN_TOKEN`. Set `FASTBREAK_ADMIN_TOKEN` on the
   public Worker too (same value) so it can validate admin writes.
3. `cd dashboards/fastbreak-refresh && wrangler deploy`
4. `cd dashboards/fastbreak && wrangler deploy`
5. Trigger the refresh Worker's `GET /` once manually to populate KV instead of waiting
   for the next cron tick, then load `index.html`.

## Known follow-ups
- Classic vs. Pro don't functionally differ yet (see `TODO(mode)`).
- Proj is a straight L10 passthrough (see `TODO(projections)`); a real projection model
  is future, separately-scoped work.
- Top Shot badge/set filtering for Pro is on hold pending the Cadence/Flow integration.
